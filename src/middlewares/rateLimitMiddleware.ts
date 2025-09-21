import { MiddlewareFn } from "grammy";
import { PrismaClient } from "@prisma/client";
import { userService } from "../services/userService";
import { Config } from "../config";
import { SessionContext, SessionData } from "../bot";

export const rateLimitMiddleware =
  (prisma: PrismaClient): MiddlewareFn<SessionContext> =>
  async (ctx, next) => {
    console.log("rateLimitMiddleware");
    const userId = ctx.from?.id;
    if (!userId || !ctx.message?.photo) return next();

    const user = await userService.getOrCreateUser(
      prisma,
      userId,
      ctx.from?.username || "",
    );
    if (user.status !== "ORDINARY") return next(); // Премиум/админ без лимитов

    const session: SessionData = ctx.session;
    if (!session.todayUses) {
      session.todayUses = await userService.getTodayUses(prisma, userId);
    }
    if (session.todayUses >= Config.maxUserRequestsPerDay) {
      return ctx.reply(
        `Лимит: ${Config.maxUserRequestsPerDay} запросов в сутки. Попробуй завтра!`,
      );
    }

    await next();
  };
