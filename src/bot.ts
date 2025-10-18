// src/bot.ts
import { Bot, Context, Keyboard, session, SessionFlavor } from "grammy";
import { limit } from "@grammyjs/ratelimiter";
import { PrismaClient } from "@prisma/client";
import { photoHandler } from "./handlers/photoHandler";
import { adminHandler } from "./handlers/adminHandler";
import { rateLimitMiddleware } from "./middlewares/rateLimitMiddleware";
import { logger } from "./utils/logger";
import cron from "node-cron";
import { Config } from "./config";
import { run } from "@grammyjs/runner";

// SessionData interface
interface SessionData {
  todayUses: number;
  isProcessingPhoto: boolean;
  lastResetDate?: string;
}

export type SessionContext = Context & SessionFlavor<SessionData>;

export class TG {
  private readonly core: Bot<SessionContext>;
  private readonly prisma: PrismaClient;

  constructor(token: string) {
    this.core = new Bot<SessionContext>(token);
    this.prisma = new PrismaClient();
  }

  public async init(): Promise<void> {
    await this.prisma.$connect();
    logger.info("Подключено к Prisma PostgreSQL");
  }

  public async setup(): Promise<void> {
    this.core.use(
      limit({
        timeFrame: 10000,
        limit: 10,
        onLimitExceeded: async (ctx) => {
          logger.warn(
            `[RateLimiter] Пользователь ${ctx.from?.id} превысил лимит`,
          );
          await ctx.reply("Слишком много запросов! Подождите немного.");
        },
        keyGenerator: (ctx) => ctx.from?.id.toString() || "unknown",
      }),
    );

    this.core.use(
      session({
        initial: (): SessionData => ({
          todayUses: Config.maxUserRequestsPerDay,
          isProcessingPhoto: false,
          lastResetDate: new Date().toISOString().split("T")[0],
        }),
      }),
    );

    this.core.use(rateLimitMiddleware(this.prisma));

    const keyboard = new Keyboard()
      .text("📊 Статистика")
      .resized()
      .persistent();

    this.core.command("start", async (ctx) => {
      const userId = String(ctx.from?.id);
      if (!userId) return;

      await this.prisma.user.upsert({
        where: { telegramId: userId },
        update: { username: ctx.from?.username || "" },
        create: { telegramId: userId, username: ctx.from?.username || "" },
      });

      await ctx.reply(
        `Добро пожаловать! Отправьте фото для поиска. Лимит: ${Config.maxUserRequestsPerDay}/день.`,
        { reply_markup: keyboard },
      );
    });

    this.core.hears("📊 Статистика", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;

      const user = await this.prisma.user.findUnique({
        where: { telegramId: String(userId) },
      });

      if (!user) {
        return ctx.reply("Пользователь не найден.");
      }

      const todayUses =
        Config.maxUserRequestsPerDay -
        (ctx.session.todayUses ?? Config.maxUserRequestsPerDay);
      const remaining = ctx.session.todayUses ?? Config.maxUserRequestsPerDay;

      const message = `
      <b>Статистика:</b>
      - ID: ${user.telegramId}
      - Использовано сегодня: ${todayUses}
      - Осталось: ${remaining > 0 ? remaining : 0}
      - Дата регистрации: ${user.createdAt.toLocaleDateString()}
      `;
      await ctx.reply(message, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    });

    this.core.command("stats", adminHandler("stats", this.prisma));
    this.core.command("admin", adminHandler("admin", this.prisma));
    this.core.on("message:photo", photoHandler(this.prisma));

    // Cron-задание для проверки и активации ключей
    cron.schedule("0 0 * * *", async () => {
      // Каждые 24 часа в 00:00 UTC
      logger.info("Запуск проверки ключей для активации");
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 часа назад

      const keysToReactivate = await this.prisma.apiKey.findMany({
        where: {
          longRemaining: 0,
          isActive: false,
          firstUsedAt: {
            lte: oneDayAgo,
            not: null, // Убедимся, что firstUsedAt установлено
          },
        },
      });

      for (const key of keysToReactivate) {
        await this.prisma.apiKey.update({
          where: { id: key.id },
          data: {
            isActive: true,
            firstUsedAt: null, // Сбрасываем метку
            longRemaining:
              key.type === "SAUCENAO" ? 100 : key.isNew ? 5000 : 1000,
          },
        });
        logger.info(
          `Ключ ${key.type}:${key.id} активирован, firstUsedAt сброшено`,
        );
      }

      logger.info(
        `Проверка ключей завершена, активировано: ${keysToReactivate.length}`,
      );
    });

    // SCRAPER: сброс isActive ежемесячно
    cron.schedule("0 0 1 * *", async () => {
      // 1-го числа каждого месяца в 00:00 UTC
      logger.info("Сброс ключей SCRAPER");
      await this.prisma.apiKey.updateMany({
        where: { type: "SCRAPER" },
        data: { isActive: true },
      });
      logger.info("Ключи SCRAPER сброшены");
    });
  }

  public async start(): Promise<void> {
    await this.init();
    await this.setup();
    logger.info("Запуск бота");
    run(this.core);
  }

  public async stop(): Promise<void> {
    logger.info("Остановка бота");
    await this.prisma.$disconnect();
    await this.core.stop();
  }
}
