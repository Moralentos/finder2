import { MiddlewareFn } from "grammy";
import { PrismaClient } from "@prisma/client";
import { userService } from "../services/userService";
import { Config } from "../config";
import { SessionContext } from "../bot";

interface SessionData {
  todayUses: number;
  isProcessingPhoto: boolean; // Флаг для отслеживания обработки фото
}

export const rateLimitMiddleware =
  (prisma: PrismaClient): MiddlewareFn<SessionContext> =>
  async (ctx, next) => {
    const userId = String(ctx.from?.id);
    if (!userId || !ctx.message?.photo) return next();

    const user = await userService.getOrCreateUser(
      prisma,
      userId,
      ctx.from?.username || "",
    );
    if (user.status !== "ORDINARY") return next();

    const session = ctx.session;
    session.todayUses = session.todayUses ?? Config.maxUserRequestsPerDay; // Начинаем с 7

    // Проверяем, обрабатывается ли уже фото
    if (session.isProcessingPhoto) {
      await ctx.reply(
        "⏳ Пожалуйста, дождитесь завершения обработки предыдущего фото.",
      );
      return;
    }

    if (session.todayUses <= 0) {
      return ctx.reply(
        `Лимит: ${Config.maxUserRequestsPerDay} запросов в сутки исчерпан. Попробуй завтра!`,
      );
    }

    await next();
  };
