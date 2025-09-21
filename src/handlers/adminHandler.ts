import { Context } from "grammy";
import { PrismaClient } from "@prisma/client";
import { logger } from "../utils/logger";
import { differenceInMonths } from "date-fns";
import { Config } from "../config";

interface ApiKey {
  id: string;
  type: "SAUCENAO" | "SCRAPER";
  apiKey: string;
  longRemaining: number;
  isActive: boolean;
  isNew: boolean;
  createdAt: Date;
}

export const adminHandler =
  (command: string, prisma: PrismaClient) => async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId || userId !== Config.adminId) {
      logger.warn(`Неавторизованный доступ к /${command}: userId ${userId}`);
      return ctx.reply("Доступ запрещён.");
    }

    if (command === "stats") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayUses = await prisma.usage.count({
        where: { timestamp: { gte: today } },
      });
      const newUsers = await prisma.user.count({
        where: { createdAt: { gte: today } },
      });

      const saucenaoKeys = (await prisma.apiKey.findMany({
        where: { type: "SAUCENAO" },
      })) as ApiKey[];
      const saucenaoRemaining = saucenaoKeys.reduce(
        (sum, key) => sum + (key.isActive ? key.longRemaining : 0),
        0,
      );

      const scraperKeys = (await prisma.apiKey.findMany({
        where: { type: "SCRAPER" },
      })) as ApiKey[];
      const scraperRemaining = scraperKeys.reduce(
        (sum, key) =>
          sum +
          (key.isActive
            ? key.isNew && differenceInMonths(new Date(), key.createdAt) < 1
              ? 5000
              : 1000
            : 0),
        0,
      );

      const stats =
        `📊 Статистика бота:\n` +
        `Сегодня использований: ${todayUses}\n` +
        `Новых пользователей сегодня: ${newUsers}\n` +
        `Остаток SauceNAO: ${saucenaoRemaining}/100\n` +
        `Остаток ScraperAPI: ${scraperRemaining}/6000`;

      return ctx.reply(stats);
    }

    if (command === "admin") {
      if (!ctx.match || typeof ctx.match !== "string") {
        logger.warn("ctx.match is undefined or not a string");
        return ctx.reply(
          "Ошибка: неверный формат команды. Пример: /admin add_key SAUCENAO key true",
        );
      }

      const args = ctx.match.trim().split(/\s+/);
      if (args[0] === "add_key") {
        if (args.length < 4) {
          return ctx.reply(
            "Ошибка: недостаточно аргументов. Пример: /admin add_key SAUCENAO key true",
          );
        }
        const [type, key, isNew] = args.slice(1);
        if (!["SAUCENAO", "SCRAPER"].includes(type)) {
          return ctx.reply(
            "Ошибка: тип ключа должен быть SAUCENAO или SCRAPER",
          );
        }
        await prisma.apiKey.create({
          data: {
            type: type as "SAUCENAO" | "SCRAPER",
            apiKey: key,
            longRemaining:
              type === "SAUCENAO" ? 100 : isNew === "true" ? 5000 : 1000,
            isNew: isNew === "true",
          },
        });
        return ctx.reply(`Ключ ${type} добавлен.`);
      }
      if (args[0] === "set_status") {
        if (args.length < 3) {
          return ctx.reply(
            "Ошибка: недостаточно аргументов. Пример: /admin set_status 123456789 PREMIUM",
          );
        }
        const [telegramId, status] = args.slice(1);
        const telegramIdNum = parseInt(telegramId);
        if (isNaN(telegramIdNum)) {
          return ctx.reply("Ошибка: telegramId должен быть числом");
        }
        if (!["ORDINARY", "PREMIUM", "ADMIN"].includes(status)) {
          return ctx.reply(
            "Ошибка: статус должен быть ORDINARY, PREMIUM или ADMIN",
          );
        }
        await prisma.user.update({
          where: { telegramId: String(telegramIdNum) },
          data: { status: status as "ORDINARY" | "PREMIUM" | "ADMIN" },
        });
        return ctx.reply(
          `Статус пользователя ${telegramId} изменён на ${status}.`,
        );
      }
      return ctx.reply(
        "Неизвестная команда. Используйте: add_key или set_status",
      );
    }
  };
