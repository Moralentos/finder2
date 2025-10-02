import { Context, SessionFlavor } from "grammy";
import { PrismaClient } from "@prisma/client";
import { sauceNaoService } from "../services/sauceNaoService";
import { userService } from "../services/userService";
import { logger } from "../utils/logger";
import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { Config } from "../config";

interface SessionData {
  todayUses: number; // Остаток запросов (начинается с 7)
}

export const photoHandler =
  (prisma: PrismaClient) =>
  async (ctx: Context & SessionFlavor<SessionData>) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) {
      logger.error("ID пользователя не найден");
      return ctx.reply("Ошибка: ID пользователя не найден.");
    }

    const user = await userService.getOrCreateUser(
      prisma,
      userId,
      ctx.from?.username || "",
    );
    if (user.status === "ORDINARY") {
      ctx.session.todayUses =
        ctx.session.todayUses ?? Config.maxUserRequestsPerDay;
      if (ctx.session.todayUses <= 0) {
        return ctx.reply(
          `Лимит: ${Config.maxUserRequestsPerDay} запросов в сутки исчерпан. Попробуй завтра!`,
        );
      }
    }

    try {
      if (!ctx.message?.photo || ctx.message.photo.length === 0) {
        logger.error("Фото не найдено в сообщении");
        return ctx.reply("Ошибка: отправьте фото.");
      }

      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileId = photo.file_id;
      await ctx.reply("Загружаю изображение...");
      const imageBuffer = await downloadFile(ctx, fileId);
      if (!imageBuffer) {
        logger.error("Не удалось скачать файл");
        return ctx.reply("Ошибка при скачивании файла.");
      }

      const imageUrl = await uploadToTmpFiles(imageBuffer);
      if (!imageUrl) {
        logger.error("Не удалось загрузить изображение на tmpfiles.org");
        return ctx.reply("Ошибка при загрузке изображения.");
      }

      await ctx.reply("Ищу изображение на SauceNAO...");
      const sauceResult = await sauceNaoService.search(prisma, imageUrl);

      // Проверяем, успешный ли результат (не содержит "error:")
      if (sauceResult.startsWith("error:")) {
        return ctx.reply(sauceResult.replace("error:", ""));
      }

      // Успешный результат: уменьшаем лимит и записываем использование
      if (user.status === "ORDINARY") {
        ctx.session.todayUses -= 1;
        await userService.recordUsage(prisma, userId, "SAUCENAO");
        await userService.recordUsage(prisma, userId, "SCRAPER");
      }

      return ctx.reply(
        `${sauceResult}\n<b>Остаток запросов:</b> ${ctx.session.todayUses}`,
        {
          parse_mode: "HTML",
          // @ts-ignore
          disable_web_page_preview: true,
        },
      );
    } catch (error: any) {
      logger.error("Ошибка в photoHandler:", error.message, error.stack);
      return ctx.reply("Ошибка поиска. Попробуй снова.");
    }
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
