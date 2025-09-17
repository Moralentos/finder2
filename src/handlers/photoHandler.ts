import { PrismaClient } from "@prisma/client";
import { sauceNaoService } from "../services/sauceNaoService";
import { userService } from "../services/userService";
import { logger } from "../utils/logger";
import axios from "axios";
import sharp from "sharp";
import FormData from "form-data";
import { SessionContext } from "../bot";

interface SessionData {
  todayUses: number;
}

export const photoHandler =
  (prisma: PrismaClient) => async (ctx: SessionContext) => {
    const userId = ctx.from?.id;
    if (!userId) return ctx.reply("Ошибка: ID пользователя не найден.");

    const user = await userService.getOrCreateUser(
      prisma,
      userId,
      ctx.from?.username || "",
    );
    try {
      if (!ctx.message?.photo || ctx.message.photo.length === 0) {
        await ctx.reply("Ошибка: фото не найдено.");
        return;
      }

      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const fileId = photo.file_id;
      await ctx.reply("Загружаю изображение...");
      const imageBuffer = await downloadFile(ctx, fileId);
      if (!imageBuffer) return ctx.reply("Ошибка при скачивании файла.");
      const imageUrl = await uploadToTmpFiles(imageBuffer);
      if (!imageUrl) return ctx.reply("Ошибка при загрузке изображения.");
      await ctx.reply("Ищу изображение на SauceNAO...");
      const sauceResult = await sauceNaoService.search(imageUrl);

      if (user.status === "ORDINARY") {
        await userService.recordUsage(prisma, userId, "SAUCENAO", ctx.session);
        await userService.recordUsage(prisma, userId, "SCRAPER", ctx.session);
      }

      return ctx.reply(sauceResult, {
        parse_mode: "HTML",
        // @ts-ignore
        disable_web_page_preview: true,
      });
    } catch (error) {
      logger.error("Ошибка в photoHandler:", error);
      return ctx.reply("Ошибка поиска. Попробуй снова.");
    }
  };

async function downloadFile(
  ctx: SessionContext,
  fileId: string,
): Promise<Buffer | null> {
  const file = await ctx.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TOKEN}/${file.file_path}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

async function uploadToTmpFiles(imageBuffer: Buffer): Promise<string | null> {
  const convertedBuffer = await sharp(imageBuffer).jpeg().toBuffer();
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
  if (!fileIdMatch) return null;
  const directUrl = `https://tmpfiles.org/dl/${fileIdMatch[1]}/image.jpg`;
  const checkResponse = await axios.head(directUrl, { timeout: 5000 });
  if (
    checkResponse.status !== 200 ||
    !checkResponse.headers["content-type"]?.startsWith("image/")
  )
    return null;
  return directUrl;
}
