import { MiddlewareFn } from "grammy";
import { PrismaClient } from "@prisma/client";
import { userService } from "../services/userService";
import { Config } from "../config";
import { SessionContext } from "../bot";
import { logger } from "../utils/logger";

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

    // Проверяем, нужно ли сбросить лимит
    const currentDate = new Date().toISOString().split("T")[0];
    if (!session.lastResetDate || session.lastResetDate !== currentDate) {
      session.todayUses = Config.maxUserRequestsPerDay;
      session.lastResetDate = currentDate;
      logger.info(
        `Лимит запросов для пользователя ${userId} сброшен до ${Config.maxUserRequestsPerDay}`,
      );
    }

    // Проверяем, обрабатывается ли уже фото
    if (session.isProcessingPhoto) {
      logger.warn(
        `Пользователь ${userId} пытался отправить фото во время обработки`,
      );
      await ctx.reply(
        "⏳ Пожалуйста, дождитесь завершения обработки предыдущего фото.",
      );
      return; // Прерываем выполнение
    }

    if (session.todayUses <= 0) {
      await ctx.reply(
        `Лимит: ${Config.maxUserRequestsPerDay} запросов в сутки исчерпан. Попробуй завтра!`,
      );
      return; // Прерываем выполнение
    }

    await next();
  };
