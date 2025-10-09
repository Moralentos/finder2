import { Prisma, PrismaClient } from "@prisma/client";
import AsyncLock from "async-lock";
import { logger } from "../utils/logger";
import { differenceInMonths } from "date-fns";

const lock = new AsyncLock();

export interface ApiKeyWithRemaining {
  id: string;
  type: "SAUCENAO" | "SCRAPER";
  apiKey: string;
  longRemaining: number;
  isActive: boolean;
  isNew: boolean;
  createdAt: Date;
}

export const keyManager = {
  async getAvailableKey(
    prisma: PrismaClient,
    type: "SAUCENAO" | "SCRAPER",
  ): Promise<ApiKeyWithRemaining | null> {
    return lock.acquire(`key:${type}`, async () => {
      try {
        const keys = await prisma.apiKey.findMany({
          where: { type, isActive: true },
        });

        logger.info(`Найдено ключей для ${type}: ${keys.length}`);
        if (keys.length === 0) {
          logger.warn(`Нет доступных ключей для ${type}`);
          return null;
        }

        // Случайный выбор ключа
        const randomIndex = Math.floor(Math.random() * keys.length);
        const key = keys[randomIndex];

        if (type === "SAUCENAO") {
          logger.info(
            `Выбран ключ SAUCENAO:${key.id}, longRemaining: ${key.longRemaining}`,
          );
          return { ...key }; // Возвращаем ключ, если isActive=true, игнорируем longRemaining
        } else {
          // Для SCRAPER оставляем как было
          const effectiveLimit =
            key.isNew && differenceInMonths(new Date(), key.createdAt) < 1
              ? 5000
              : 1000;
          if (effectiveLimit > 0) {
            logger.info(
              `Выбран ключ SCRAPER:${key.id}, остаток: ${effectiveLimit}`,
            );
            return { ...key };
          }
        }

        if (
          type === "SCRAPER" &&
          differenceInMonths(new Date(), key.createdAt) >= 1
        ) {
          await prisma.apiKey.update({
            where: { id: key.id },
            data: { longRemaining: 1000, isNew: false },
          });
          logger.info(
            `Ключ Scraper ${key.id} сброшен, новый лимит: 1000/месяц`,
          );
          return { ...key, longRemaining: 1000 };
        }

        logger.warn(`Нет доступных ключей для ${type}`);
        return null;
      } catch (error: any) {
        logger.error(
          `Ошибка при получении ключей для ${type}: ${error.message}`,
          error.stack,
        );
        return null;
      }
    });
  },

  async updateRemaining(
    tx: Prisma.TransactionClient,
    keyId: string,
    type: "SAUCENAO" | "SCRAPER",
    longRemaining?: number, // Для SAUCENAO: из ответа API, для SCRAPER: декремент
  ): Promise<void> {
    return lock.acquire(`usage:${keyId}`, async () => {
      try {
        const key = await tx.apiKey.findUnique({ where: { id: keyId } });
        if (!key) {
          logger.error(`Ключ ${type}:${keyId} не найден в базе`);
          throw new Error("Ключ не найден");
        }

        const newRemaining =
          type === "SAUCENAO"
            ? (longRemaining ?? key.longRemaining)
            : key.longRemaining - 1;

        await tx.apiKey.update({
          where: { id: keyId },
          data: {
            longRemaining: Math.max(0, newRemaining),
            isActive: newRemaining > 0,
          },
        });

        logger.info(
          `Ключ ${type}:${keyId} обновлён, longRemaining: ${newRemaining}, isActive: ${newRemaining > 0}`,
        );
      } catch (error: any) {
        logger.error(
          `Ошибка при обновлении ключа ${type}:${keyId}: ${error.message}`,
          error.stack,
        );
        throw error;
      }
    });
  },
};
