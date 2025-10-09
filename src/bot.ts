import { Bot, Context, session, SessionFlavor } from "grammy";
import { limit } from "@grammyjs/ratelimiter";
import { PrismaClient } from "@prisma/client";
import { photoHandler } from "./handlers/photoHandler";
import { adminHandler } from "./handlers/adminHandler";
import { rateLimitMiddleware } from "./middlewares/rateLimitMiddleware";
import { logger } from "./utils/logger";
import cron from "node-cron";
import { Config } from "./config";
import { run } from "@grammyjs/runner";

// Определяем интерфейс SessionData
interface SessionData {
  todayUses: number;
  isProcessingPhoto: boolean;
  lastResetDate?: string; // Для отслеживания даты последнего сброса
}

// Определяем SessionContext как Context с SessionFlavor<SessionData>
export type SessionContext = Context & SessionFlavor<SessionData>;

export class TG {
  private core: Bot<SessionContext>;
  private prisma: PrismaClient;

  constructor(token: string) {
    this.core = new Bot<SessionContext>(token);
    this.prisma = new PrismaClient();
  }

  public async init(): Promise<void> {
    await this.prisma.$connect();
    logger.info("Prisma подключен к PostgreSQL");
  }

  public async setup(): Promise<void> {
    this.core.use(
      limit({
        timeFrame: 10000,
        limit: 10,
        onLimitExceeded: async (ctx) => {
          logger.warn(
            `[RateLimiter] Пользователь ${ctx.from?.id} превысил лимит запросов`,
          );
          await ctx.reply("⏳ Слишком много запросов! Подождите немного.");
        },
        keyGenerator: (ctx) => ctx.from?.id.toString() || "unknown",
      }),
    );

    // Инициализируем сессию
    this.core.use(
      session({
        initial: (): SessionData => ({
          todayUses: Config.maxUserRequestsPerDay,
          isProcessingPhoto: false,
          lastResetDate: new Date().toISOString().split("T")[0], // Текущая дата
        }),
      }),
    );
    this.core.use(rateLimitMiddleware(this.prisma));

    this.core.command("start", async (ctx) => {
      const userId = String(ctx.from?.id);
      if (!userId) return;
      await this.prisma.user.upsert({
        where: { telegramId: userId },
        update: { username: ctx.from?.username || "" },
        create: { telegramId: userId, username: ctx.from?.username || "" },
      });
      await ctx.reply(
        `Привет! Отправь фото для поиска аниме. Лимит: ${Config.maxUserRequestsPerDay}/сутки.`,
      );
    });

    this.core.command("stats", adminHandler("stats", this.prisma));
    this.core.command("profile", async (ctx) => {
      ctx.reply(`Остаток запросов: ${ctx.session.todayUses}`);
    });
    this.core.command("admin", adminHandler("admin", this.prisma));
    this.core.on("message:photo", photoHandler(this.prisma));

    this.core.on("message", async (ctx) => {
      if (!ctx.message?.photo) {
        await ctx.reply(`Макс. запросов/день: ${Config.maxUserRequestsPerDay}`);
      }
    });

    // Сбрасываем лимиты в полночь MSK (21:00 UTC)
    cron.schedule("0 0 21 * * *", () => {
      logger.info("Запланированный сброс лимитов пользователей в полночь MSK");
    });
  }

  public async start(): Promise<void> {
    await this.init();
    await this.setup();
    logger.info("Starting bot");
    run(this.core);
  }

  public async stop(): Promise<void> {
    logger.info("Stopping bot");
    await this.prisma.$disconnect();
    await this.core.stop();
  }
}
