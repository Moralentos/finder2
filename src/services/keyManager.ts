import { Prisma, PrismaClient } from "@prisma/client";
import AsyncLock from "async-lock";
import { logger } from "../utils/logger";
import { differenceInMonths } from "date-fns";

const lock = new AsyncLock();

interface ApiKeyWithLimits {
  id: string;
  type: "SAUCENAO" | "SCRAPER";
  apiKey: string;
  totalUses: number;
  dailyUses: number;
  initialLimit: number;
  dailyLimit: number;
  isNew: boolean;
  createdAt: Date;
  isActive: boolean;
  effectiveLimit: number;
  totalRemaining: number;
}

export const keyManager = {
  async getAvailableKey(
    prisma: PrismaClient,
    type: "SAUCENAO" | "SCRAPER",
  ): Promise<ApiKeyWithLimits | null> {
    return lock.acquire(`key:${type}`, async () => {
      const keys = await prisma.apiKey.findMany({
        where: { type, isActive: true },
        orderBy: { createdAt: "asc" },
      });

      for (const key of keys) {
        const effectiveLimit =
          type === "SAUCENAO"
            ? key.initialLimit
            : key.isNew && differenceInMonths(new Date(), key.createdAt) < 1
              ? 5000
              : 1000;

        const dailyRemaining = key.dailyLimit - key.dailyUses;
        const totalRemaining = effectiveLimit - key.totalUses;

        if (dailyRemaining > 0 && totalRemaining > 0) {
          logger.info(
            `Выбран ключ ${type}:${key.id}, остаток: ${totalRemaining}/${effectiveLimit}`,
          );
          return { ...key, effectiveLimit, totalRemaining };
        }

        if (
          type === "SCRAPER" &&
          differenceInMonths(new Date(), key.createdAt) >= 1
        ) {
          await prisma.apiKey.update({
            where: { id: key.id },
            data: { totalUses: 0, isNew: false },
          });
          logger.info(
            `Ключ Scraper ${key.id} сброшен, новый лимит: 1000/месяц`,
          );
          if (dailyRemaining > 0) {
            return { ...key, effectiveLimit: 1000, totalRemaining: 1000 };
          }
        }
      }
      logger.warn(`Нет доступных ключей для ${type}`);
      return null;
    });
  },

  async recordUsage(
    tx: Prisma.TransactionClient,
    keyId: string,
    type: "SAUCENAO" | "SCRAPER",
  ): Promise<void> {
    return lock.acquire(`usage:${keyId}`, async () => {
      const key = await tx.apiKey.findUnique({ where: { id: keyId } });
      if (!key) throw new Error("Ключ не найден");

      await tx.apiKey.update({
        where: { id: keyId },
        data: { dailyUses: { increment: 1 }, totalUses: { increment: 1 } },
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (key.dailyUses >= key.dailyLimit) {
        await tx.apiKey.update({
          where: { id: keyId },
          data: { dailyUses: 0 },
        });
      }
    });
  },
};
