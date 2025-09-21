import { Bot, Context, session, SessionFlavor } from "grammy";
import { limit } from "@grammyjs/ratelimiter";
import { PrismaClient } from "@prisma/client";
import { photoHandler } from "./handlers/photoHandler";
import { adminHandler } from "./handlers/adminHandler";
import { rateLimitMiddleware } from "./middlewares/rateLimitMiddleware";
import { logger } from "./utils/logger";
import cron from "node-cron";
import { Config } from "./config";

export interface SessionData {
  todayUses: number;
}

export type SessionContext = Context & SessionFlavor<SessionData>;

export class TG {
  private core: Bot<SessionContext>;
  private readonly prisma: PrismaClient;

  constructor(token: string) {
    this.core = new Bot<SessionContext>(token);
    this.prisma = new PrismaClient();
  }

  public async init(): Promise<void> {
    // Инициализация БД
    await this.prisma.$connect();
    logger.info("Prisma подключен к PostgreSQL");
  }

  public async setup(): Promise<void> {
    // Grammy limit: 10 запросов/10 секунд на пользователя
    this.core.use(
      limit({
        timeFrame: 10000, // 10 секунд
        limit: 10, // 10 запросов
        onLimitExceeded: async (ctx) => {
          logger.warn(
            `[RateLimiter] Пользователь ${ctx.from?.id} превысил лимит запросов`,
          );
          await ctx.reply("⏳ Слишком много запросов! Подождите немного.");
        },
        keyGenerator: (ctx) => ctx.from?.id.toString() || "unknown",
      }),
    );

    // Сессии для хранения todayUses
    this.core.use(session({ initial: () => ({ todayUses: 0 }) }));

    // Проверка лимита 7/сутки
    this.core.use(rateLimitMiddleware(this.prisma));

    // Обработчики
    this.core.command("start", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      await this.prisma.user.upsert({
        where: { telegramId: userId },
        update: {},
        create: { telegramId: userId, username: ctx.from?.username || "" },
      });
      await ctx.reply("Привет! Отправь фото для поиска аниме. Лимит: 7/сутки.");
    });

    this.core.command("stats", adminHandler("stats", this.prisma));
    this.core.command("admin", adminHandler("admin", this.prisma));
    this.core.on("message:photo", photoHandler(this.prisma));

    // Отладка Config (опционально)
    this.core.on("message", async (ctx) => {
      await ctx.reply(`Макс. запросов/день: ${Config.maxUserRequestsPerDay}`);
    });

    // Cron: ежедневный сброс dailyUses
    cron.schedule("0 0 * * *", async () => {
      await this.prisma.apiKey.updateMany({ data: { dailyUses: 0 } });
      logger.info("Ежедневный сброс dailyUses выполнен.");
    });
  }

  public async start(): Promise<void> {
    await this.init();
    await this.setup();
    logger.info("Starting bot");
    await this.core.start();
  }

  public async stop(): Promise<void> {
    logger.info("Stopping bot");
    await this.prisma.$disconnect();
    await this.core.stop();
    // process.exit(0);
  }
}
