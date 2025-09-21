import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { keyManager } from "./keyManager";
import { logger } from "../utils/logger";

export const sauceNaoService = {
  async search(prisma: PrismaClient, imageUrl: string): Promise<string> {
    try {
      const sauceKey = await keyManager.getAvailableKey(prisma, "SAUCENAO");
      if (!sauceKey) return "Лимит ключей SauceNAO исчерпан.";
      const scraperKey = await keyManager.getAvailableKey(prisma, "SCRAPER");
      if (!scraperKey) return "Лимит ключей ScraperAPI исчерпан.";

      const sauceNAOUrl = `https://saucenao.com/search.php?db=999&output_type=2&numres=1&url=${encodeURIComponent(imageUrl)}&api_key=${sauceKey.apiKey}`;
      logger.info(`Полный URL SauceNAO: ${sauceNAOUrl}`);
      const response = await axios.get(
        `http://api.scraperapi.com?api_key=${scraperKey.apiKey}&url=${encodeURIComponent(sauceNAOUrl)}`,
      );

      const data = response.data;
      if (typeof data === "string" && data.includes("<!DOCTYPE html")) {
        logger.error(
          "HTML-ответ от SauceNAO, возможно, неверный ключ или лимит исчерпан:",
          data.slice(0, 200),
        );
        await prisma.$transaction(async (tx) => {
          await keyManager.updateRemaining(tx, sauceKey.id, "SAUCENAO", 0);
          await keyManager.updateRemaining(tx, scraperKey.id, "SCRAPER");
        });
        return "Ошибка: SauceNAO вернул ошибку. Возможно, лимит ключей исчерпан.";
      }

      const longRemaining =
        data.header?.long_remaining ?? sauceKey.longRemaining;
      await prisma.$transaction(async (tx) => {
        await keyManager.updateRemaining(
          tx,
          sauceKey.id,
          "SAUCENAO",
          longRemaining,
        );
        await keyManager.updateRemaining(tx, scraperKey.id, "SCRAPER");
      });

      if (data.header?.status !== 0) {
        const message = data.header?.message || "Неизвестная ошибка";
        logger.error(
          `Ошибка API SauceNAO: ${message}, остаток: ${longRemaining}`,
        );
        return `Ошибка API SauceNAO: ${message}. Остаток: ${longRemaining}/100.`;
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

      return `Нет результатов. Остаток лимита SauceNAO: ${longRemaining}/100.`;
    } catch (error: any) {
      logger.error("Ошибка в sauceNaoService:", error.message, error.stack);
      return `Ошибка поиска: ${error.message || "неизвестная ошибка"}`;
    }
  },
};
