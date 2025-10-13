import { Context } from "grammy";
import { PrismaClient } from "@prisma/client";
import { sauceNaoService } from "../services/sauceNaoService";
import { userService } from "../services/userService";
import { logger } from "../utils/logger";
import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { Config } from "../config";
import { SessionContext } from "../bot";
import AsyncLock from "async-lock";

const lock = new AsyncLock();

export const photoHandler =
  (prisma: PrismaClient) => async (ctx: SessionContext) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) {
      logger.error("ID пользователя не найден");
      return ctx.reply("Ошибка: ID пользователя не найден.");
    }

    return lock.acquire(`photo:${userId}`, async () => {
      ctx.session.isProcessingPhoto = true;

      const timeout = setTimeout(() => {
        ctx.session.isProcessingPhoto = false;
        logger.warn(
          `Таймаут обработки для пользователя ${userId}, флаг сброшен`,
        );
      }, 30000);

      try {
        const user = await userService.getOrCreateUser(
          prisma,
          userId,
          ctx.from?.username || "",
        );
        if (user.status === "ORDINARY") {
          ctx.session.todayUses =
            ctx.session.todayUses ?? Config.maxUserRequestsPerDay;
          if (ctx.session.todayUses <= 0) {
            ctx.session.isProcessingPhoto = false;
            clearTimeout(timeout);
            return ctx.reply(
              `Лимит: ${Config.maxUserRequestsPerDay} запросов в сутки исчерпан. Попробуй завтра!`,
              { reply_to_message_id: ctx.message?.message_id },
            );
          }
        }

        if (!ctx.message?.photo || ctx.message.photo.length === 0) {
          logger.error("Фото не найдено в сообщении");
          ctx.session.isProcessingPhoto = false;
          clearTimeout(timeout);
          return ctx.reply("Ошибка: отправьте фото.", {
            reply_to_message_id: ctx.message?.message_id,
          });
        }

        if (!ctx.chat) {
          logger.error("Чат не найден");
          ctx.session.isProcessingPhoto = false;
          clearTimeout(timeout);
          return ctx.reply("Ошибка: чат не найден.");
        }

        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const fileId = photo.file_id;
        const loadingMessage = await ctx.reply("Загружаю изображение...", {
          reply_to_message_id: ctx.message.message_id,
        });

        const imageBuffer = await downloadFile(ctx, fileId);
        if (!imageBuffer) {
          logger.error("Не удалось скачать файл");
          ctx.session.isProcessingPhoto = false;
          clearTimeout(timeout);
          await ctx.api.editMessageText(
            ctx.chat.id,
            loadingMessage.message_id,
            "Ошибка при скачивании файла.",
          );
          return;
        }

        await ctx.api.editMessageText(
          ctx.chat.id,
          loadingMessage.message_id,
          "Ищу изображение...",
        );

        const imageUrl = await uploadToTmpFiles(imageBuffer);
        if (!imageUrl) {
          logger.error("Не удалось загрузить изображение на tmpfiles.org");
          ctx.session.isProcessingPhoto = false;
          clearTimeout(timeout);
          await ctx.api.editMessageText(
            ctx.chat.id,
            loadingMessage.message_id,
            "Ошибка при загрузке изображения.",
          );
          return;
        }

        const sauceResult = await sauceNaoService.search(prisma, imageUrl);

        if (sauceResult.startsWith("error:")) {
          ctx.session.isProcessingPhoto = false;
          clearTimeout(timeout);
          await ctx.api.editMessageText(
            ctx.chat.id,
            loadingMessage.message_id,
            sauceResult.replace("error:", ""),
          );
          return;
        }

        if (user.status === "ORDINARY") {
          ctx.session.todayUses -= 1;
          await userService.recordUsage(prisma, userId);
        }

        if (user.status === "PREMIUM") {
          await userService.recordUsage(prisma, userId);
        }

        ctx.session.isProcessingPhoto = false;
        clearTimeout(timeout);

        await ctx.api.editMessageText(
          ctx.chat.id,
          loadingMessage.message_id,
          `${sauceResult}`,
          {
            parse_mode: "HTML",
            // @ts-ignore
            disable_web_page_preview: true,
          },
        );
      } catch (error: any) {
        logger.error("Ошибка в photoHandler:", error.message, error.stack);
        ctx.session.isProcessingPhoto = false;
        clearTimeout(timeout);
        if (ctx.message?.message_id) {
          await ctx.reply("Ошибка поиска. Попробуй снова.", {
            reply_to_message_id: ctx.message.message_id,
          });
        } else {
          await ctx.reply("Ошибка поиска. Попробуй снова.");
        }
      }
    });
  };

async function downloadFile(
  ctx: Context,
  fileId: string,
): Promise<Buffer | null> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) {
      logger.error("file_path не найден для file_id:", fileId);
      return null;
    }
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TOKEN}/${file.file_path}`;
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    logger.info(`Файл скачан, размер: ${response.data.length} байт`);
    return Buffer.from(response.data);
  } catch (error: any) {
    logger.error("Ошибка скачивания файла:", error.message);
    return null;
  }
}

async function uploadToTmpFiles(imageBuffer: Buffer): Promise<string | null> {
  try {
    const convertedBuffer = await sharp(imageBuffer).jpeg().toBuffer();
    logger.info(
      `Файл конвертирован в JPEG, размер: ${convertedBuffer.length} байт`,
    );
    const form = new FormData();
    form.append("file", convertedBuffer, "image.jpg");
    const response = await axios.post(
      "https://tmpfiles.org/api/v1/upload",
      form,
      {
        headers: form.getHeaders(),
      },
    );
    const pageUrl = response.data.data.url;
    const fileIdMatch = pageUrl.match(/tmpfiles\.org\/(\d+)\/image\.jpg$/);
    if (!fileIdMatch) {
      logger.error("Не удалось извлечь ID файла из URL:", pageUrl);
      return null;
    }
    const directUrl = `https://tmpfiles.org/dl/${fileIdMatch[1]}/image.jpg`;
    const checkResponse = await axios.head(directUrl, { timeout: 5000 });
    if (
      checkResponse.status !== 200 ||
      !checkResponse.headers["content-type"]?.startsWith("image/")
    ) {
      logger.error("URL не ведёт на изображение:", directUrl);
      return null;
    }
    logger.info("Прямая ссылка на изображение:", directUrl);
    return directUrl;
  } catch (error: any) {
    logger.error("Ошибка загрузки на tmpfiles.org:", error.message);
    return null;
  }
}
