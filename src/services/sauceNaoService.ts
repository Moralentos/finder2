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
          return "error:🚫 Лимит ключей SauceNAO исчерпан. Попробуй позже.";
        }

        scraperKey = await keyManager.getAvailableKey(prisma, "SCRAPER");
        if (!scraperKey) {
          logger.warn("Нет доступных ключей ScraperAPI");
          return "error:🚫 Лимит ключей ScraperAPI исчерпан. Попробуй позже.";
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

          const title = dataResult.title || dataResult.source || null;

          // Если нет названия, возвращаем стилизованное сообщение об ошибке
          if (!title) {
            logger.info(`Нет результатов от SauceNAO (попытка ${attempts})`);
            return `🚫 <b>Не получилось найти</b>\n<i>Попробуй другое изображение!</i>\n\n⏲️ <b>Остаток лимита:</b> ${longRemaining}/100 запросов в день`;
          }

          // Формируем массив строк для существующих полей
          const output: string[] = [`🎨 <b>Результат поиска:</b>`];
          if (header.similarity) {
            output.push(`🔍 <b>Сходство:</b> <i>${header.similarity}%</i>`);
          }
          output.push(`📖 <b>Название:</b> <i>${title}</i>`);
          if (dataResult.ext_urls?.length > 0) {
            const escapedUrls = dataResult.ext_urls
              .map((url: string) => url.replace(/&/g, "&amp;"))
              .join(", ");
            output.push(`🔗 <b>Ссылки:</b> ${escapedUrls}`);
          }
          const author = dataResult.author || dataResult.member_name;
          if (author) {
            output.push(`✍️ <b>Автор:</b> <i>${author}</i>`);
          }
          if (dataResult.part) {
            output.push(`📺 <b>Сезон/Эпизод:</b> <i>${dataResult.part}</i>`);
          }
          if (dataResult.year) {
            output.push(`📅 <b>Год:</b> <i>${dataResult.year}</i>`);
          }
          if (dataResult.est_time) {
            output.push(`⏰ <b>Тайминг:</b> <i>${dataResult.est_time}</i>`);
          }
          output.push(
            `\n─\n⏲️ <b>Остаток лимита:</b> ${longRemaining}/100 запросов в день`,
          );

          logger.info(`Успешный поиск на SauceNAO (попытка ${attempts})`);
          return output.join("\n");
        }

        logger.info(`Нет результатов от SauceNAO (попытка ${attempts})`);
        return `🚫 <b>Не получилось найти</b>\n<i>Попробуй другое изображение!</i>\n\n⏲️ <b>Остаток лимита:</b> ${longRemaining}/100 запросов в день`;
      } catch (error: any) {
        logger.error(
          `Ошибка в sauceNaoService (попытка ${attempts}): ${error.message}`,
          error.stack,
        );

        if (error.response?.status && sauceKey && scraperKey) {
          const status = error.response.status;
          await prisma.$transaction(async (tx) => {
            if (status === 429) {
              // Rate limit
              await tx.apiKey.update({
                where: { id: scraperKey!.id },
                data: { isActive: false },
              });
              logger.warn(
                `Scraper ключ ${scraperKey!.id} отключён на 60 сек (429)`,
              );
              setTimeout(async () => {
                try {
                  await prisma.apiKey.update({
                    where: { id: scraperKey!.id },
                    data: { isActive: true },
                  });
                  logger.info(`Scraper ключ ${scraperKey!.id} восстановлен`);
                } catch (err: any) {
                  logger.error(
                    `Ошибка восстановления Scraper ключа ${scraperKey!.id}: ${err.message}`,
                  );
                }
              }, 60000); // 60 сек
            } else if (status === 403) {
              // Quota exceeded
              await tx.apiKey.update({
                where: { id: scraperKey!.id },
                data: { isActive: false },
              });
              logger.warn(
                `Scraper ключ ${scraperKey!.id} отключён (403 quota)`,
              );
              // Восстановление по cron
            } else {
              // Другие ошибки: Retry или игнор
              logger.error(`Ошибка Scraper: ${status}`);
            }
          });
        }

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
    return "error:🚫 Ошибка поиска: все доступные ключи исчерпаны или недействительны. Попробуй позже.";
  },
};
