import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { ApiKeyWithRemaining, keyManager } from "./keyManager";
import { logger } from "../utils/logger";

export const sauceNaoService = {
  async search(prisma: PrismaClient, imageUrl: string): Promise<string> {
    const maxRetries = 3;
    let attempts = 0;

    while (attempts < maxRetries) {
      attempts++;
      let sauceKey: ApiKeyWithRemaining | null = null;
      let scraperKey: ApiKeyWithRemaining | null = null;
      try {
        logger.info(`Попытка ${attempts} для поиска изображения: ${imageUrl}`);
        sauceKey = await keyManager.getAvailableKey(prisma, "SAUCENAO");
        if (!sauceKey) {
          logger.warn("Нет доступных ключей SauceNAO");
          return "error:Лимит ключей SauceNAO исчерпан.";
        }

        scraperKey = await keyManager.getAvailableKey(prisma, "SCRAPER");
        if (!scraperKey) {
          logger.warn("Нет доступных ключей ScraperAPI");
          return "error:Лимит ключей ScraperAPI исчерпан.";
        }

        const sauceNAOUrl = `https://saucenao.com/search.php?db=999&output_type=2&numres=1&url=${encodeURIComponent(imageUrl)}&api_key=${sauceKey.apiKey}`;
        logger.info(`Полный URL SauceNAO: ${sauceNAOUrl}`);
        const response = await axios.get(
          `http://api.scraperapi.com?api_key=${scraperKey.apiKey}&url=${encodeURIComponent(sauceNAOUrl)}`,
          { timeout: 10000 },
        );

        const data = response.data;
        if (typeof data === "string" && data.includes("<!DOCTYPE html")) {
          logger.error(
            `HTML-ответ от SauceNAO (попытка ${attempts}), возможно, неверный ключ: ${data.slice(0, 200)}`,
          );
          await prisma.$transaction(async (tx) => {
            await prisma.apiKey.update({
              where: { id: sauceKey!.id },
              data: { isActive: false, longRemaining: 0 },
            });
          });
          continue;
        }

        const longRemaining =
          data.header?.long_remaining ?? sauceKey.longRemaining;
        await prisma.$transaction(async (tx) => {
          await keyManager.updateRemaining(
            tx,
            sauceKey!.id,
            "SAUCENAO",
            longRemaining,
          );
          await keyManager.updateRemaining(tx, scraperKey!.id, "SCRAPER");
        });

        if (data.header?.status !== 0) {
          const message = data.header?.message || "Неизвестная ошибка";
          logger.error(
            `Ошибка API SauceNAO (попытка ${attempts}): ${message}, остаток: ${longRemaining}`,
          );
          await prisma.$transaction(async (tx) => {
            await prisma.apiKey.update({
              where: { id: sauceKey!.id },
              data: { isActive: false, longRemaining: 0 },
            });
          });
          continue;
        }

        if (data.results?.length > 0) {
          const result = data.results[0];
          const header = result.header || {};
          const dataResult = result.data || {};

          const similarity = header.similarity || "N/A";
          const title = dataResult.title || dataResult.source || "Неизвестно";
          const urls = dataResult.ext_urls?.join(", ") || "Нет ссылок";
          const author =
            dataResult.author || dataResult.member_name || "Неизвестен";
          const part = dataResult.part || "N/A";
          const year = dataResult.year || "N/A";
          const estTime = dataResult.est_time || "N/A";
          const imdbId = dataResult.imdb_id || "N/A";
          const indexName = header.index_name || "N/A";
          const thumbnail = header.thumbnail || "N/A";

          logger.info(`Успешный поиск на SauceNAO (попытка ${attempts})`);
          return (
            "<b>🔍 Результат поиска на SauceNAO:</b>\n" +
            `<b>📊 Сходство:</b> ${similarity}%\n` +
            `<b>📜 Название:</b> ${title}\n` +
            `<b>🌐 Ссылки:</b> ${urls}\n` +
            `<b>✍️ Автор:</b> ${author}\n` +
            `<b>🎬 Сезон/Эпизод:</b> ${part}\n` +
            `<b>📅 Год:</b> ${year}\n` +
            `<b>⏰ Тайминг:</b> ${estTime}\n` +
            `<b>🎥 IMDB ID:</b> ${imdbId}\n` +
            `<b>📂 Источник:</b> ${indexName}\n` +
            `<b>🖼️ Миниатюра:</b> ${thumbnail}\n` +
            `<b>📈 Остаток лимита SauceNAO:</b> ${longRemaining}/100 запросов в день`
          );
        }

        logger.info(`Нет результатов от SauceNAO (попытка ${attempts})`);
        return `error:Нет результатов. Остаток лимита SauceNAO: ${longRemaining}/100.`;
      } catch (error: any) {
        logger.error(
          `Ошибка в sauceNaoService (попытка ${attempts}): ${error.message}`,
          error.stack,
        );
        if (sauceKey) {
          logger.warn(
            `Деактивация ключа SAUCENAO:${sauceKey.id} из-за ошибки: ${error.message}`,
          );
          await prisma.$transaction(async (tx) => {
            await prisma.apiKey.update({
              where: { id: sauceKey!.id },
              data: { isActive: false, longRemaining: 0 },
            });
          });
        }

      }
    }

    logger.error(
      `Все ${maxRetries} попыток поиска провалились для ${imageUrl}`,
    );
    return "error:Ошибка поиска: все доступные ключи исчерпаны или недействительны. Попробуй позже.";
  },
};