import { Bot, Context, session } from "grammy";
import { limit } from "@grammyjs/ratelimiter";
import { PrismaClient } from "@prisma/client";
import { photoHandler } from "./handlers/photoHandler";
import { adminHandler } from "./handlers/adminHandler";
import { rateLimitMiddleware } from "./middlewares/rateLimitMiddleware";
import { logger } from "./utils/logger";
import cron from "node-cron";
import { Config } from "./config";
import { run } from "@grammyjs/runner";

interface SessionData {
  todayUses: number;
}

export type SessionContext = Context & { session: SessionData };

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

    this.core.use(session({ initial: () => ({ todayUses: 7 }) }));
    this.core.use(rateLimitMiddleware(this.prisma));

    this.core.command("start", async (ctx) => {
      const userId = String(ctx.from?.id);
      if (!userId) return;
      await this.prisma.user.upsert({
        where: { telegramId: userId },
        update: {},
        create: { telegramId: userId, username: ctx.from?.username || "" },
      });
      await ctx.reply(
        `Привет! Отправь фото для поиска аниме. Лимит: ${Config.maxUserRequestsPerDay}/сутки.`,
      );
    });

    this.core.command("stats", adminHandler("stats", this.prisma));
    this.core.command("profile", (ctx) => {
      ctx.reply(`Остаток ${ctx.session.todayUses}`);
    });
    this.core.command("admin", adminHandler("admin", this.prisma));
    this.core.on("message:photo", photoHandler(this.prisma));

    this.core.on("message", async (ctx) => {
      if (!ctx.message?.photo) {
        await ctx.reply(`Макс. запросов/день: ${Config.maxUserRequestsPerDay}`);
      }
    });

    cron.schedule("0 0 * * *", async () => {
      await this.prisma.apiKey.updateMany({
        where: { isActive: false },
        data: { isActive: true },
      });
      logger.info("Сброс isActive для неактивных ключей выполнен.");
    });
  }

  public async start(): Promise<void> {
    await this.init();
    await this.setup();
    logger.info("Starting bot");
    // await this.core.start();
    run(this.core);
  }

  public async stop(): Promise<void> {
    logger.info("Stopping bot");
    await this.prisma.$disconnect();
    await this.core.stop();
  }
}
