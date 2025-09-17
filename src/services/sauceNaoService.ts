import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { keyManager } from "./keyManager";
import { logger } from "../utils/logger";

export const sauceNaoService = {
  async search(imageUrl: string): Promise<string> {
    const prisma = new PrismaClient();
    try {
      const sauceKey = await keyManager.getAvailableKey(prisma, "SAUCENAO");
      if (!sauceKey) return "Лимит ключей SauceNAO исчерпан.";
      const scraperKey = await keyManager.getAvailableKey(prisma, "SCRAPER");
      if (!scraperKey) return "Лимит ключей ScraperAPI исчерпан.";

      const sauceNAOUrl = `https://saucenao.com/search.php?db=999&output_type=2&numres=1&url=${encodeURIComponent(imageUrl)}&api_key=${sauceKey.apiKey}`;
      const response = await axios.get(
        `http://api.scraperapi.com?api_key=${scraperKey.apiKey}&url=${encodeURIComponent(sauceNAOUrl)}`,
      );

      const data = response.data;
      if (typeof data === "string" && data.includes("<!DOCTYPE html")) {
        logger.error("HTML от SauceNAO:", data);
        return "Ошибка: SauceNAO не смог обработать URL.";
      }

      const remaining = data.header?.long_remaining || "N/A";

      if (data.header?.status === 0 && data.results?.length > 0) {
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
          `<b>📈 Остаток лимита SauceNAO:</b> ${remaining}/100 запросов в день`
        );
      } else if (data.header?.status !== 0) {
        const message = data.header?.message || "Неизвестная ошибка";
        if (message.includes("Too many requests")) {
          return `Ошибка: Превышен лимит ключей. Остаток: ${remaining}/100.`;
        }
        return `Ошибка API SauceNAO: ${message}. Остаток: ${remaining}/100.`;
      }
      return `Нет результатов. Остаток лимита SauceNAO: ${remaining}/100.`;
    } catch (error: any) {
      logger.error("Ошибка в sauceNaoService:", error.message);
      return `Ошибка поиска: ${error.message || "неизвестная ошибка"}`;
    } finally {
      await prisma.$disconnect();
    }
  },
};
