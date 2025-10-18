// src/services/keyManager.ts
import { Prisma, PrismaClient } from "@prisma/client";
import AsyncLock from "async-lock";
import { logger } from "../utils/logger";

const lock = new AsyncLock();

export interface ApiKeyWithRemaining {
  id: string;
  type: "SAUCENAO" | "SCRAPER";
  apiKey: string;
  longRemaining: number;
  isActive: boolean;
  isNew: boolean;
  createdAt: Date;
  firstUsedAt?: Date | null; // Добавляем новое поле
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
        logger.info(`Доступные ключи ${type}: ${keys.length}`);

        if (keys.length === 0) {
          logger.warn(`Нет доступных ключей ${type}`);
          return null;
        }

        // Выбираем случайный ключ
        const randomIndex = Math.floor(Math.random() * keys.length);
        const key = keys[randomIndex];

        // Если ключ еще не использовался (firstUsedAt null), устанавливаем время первого использования
        if (!key.firstUsedAt) {
          await prisma.apiKey.update({
            where: { id: key.id },
            data: {
              firstUsedAt: new Date(),
            },
          });
          logger.info(
            `Ключ ${type}:${key.id} использован впервые, установлено firstUsedAt`,
          );
        }

        // SCRAPER: longRemaining игнорируется, возвращаем 0
        if (type === "SCRAPER") {
          logger.info(`Выбран SCRAPER ключ: ${key.id}`);
          return { ...key, longRemaining: 0 };
        } else {
          // SAUCENAO
          const effectiveLimit = key.longRemaining ?? 0;
          if (effectiveLimit > 0) {
            logger.info(
              `Выбран ${type} ключ: ${key.id}, остаток: ${effectiveLimit}`,
            );
            return { ...key };
          }
          return null;
        }
      } catch (error: any) {
        logger.error(
          `Ошибка при получении ключа ${type}: ${error.message}`,
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
    longRemaining?: number,
  ): Promise<void> {
    if (type === "SCRAPER") {
      // SCRAPER: обновление не требуется
      return;
    } else {
      return lock.acquire(`usage:${keyId}`, async () => {
        try {
          const key = await tx.apiKey.findUnique({ where: { id: keyId } });
          if (!key) {
            logger.error(`Ключ ${type}:${keyId} не найден`);
            throw new Error("Ключ не найден");
          }

          const newRemaining = longRemaining ?? key.longRemaining ?? 0;
          await tx.apiKey.update({
            where: { id: keyId },
            data: {
              longRemaining: Math.max(0, newRemaining),
              isActive: newRemaining > 0,
            },
          });
          logger.info(
            `Обновлен ключ ${type}:${keyId}, longRemaining: ${newRemaining}, isActive: ${newRemaining > 0}`,
          );
        } catch (error: any) {
          logger.error(
            `Ошибка при обновлении ключа ${type}:${keyId}: ${error.message}`,
            error.stack,
          );
          throw error;
        }
      });
    }
  },
};
