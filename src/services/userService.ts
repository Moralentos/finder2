import { PrismaClient } from "@prisma/client";
import { keyManager } from "./keyManager";

export const userService = {
  async getOrCreateUser(
    prisma: PrismaClient,
    telegramId: number,
    username?: string,
  ): Promise<any> {
    return prisma.user.upsert({
      where: { telegramId },
      update: { username },
      create: { telegramId, username },
    });
  },

  async getTodayUses(prisma: PrismaClient, userId: number): Promise<number> {
    const id: string = String(userId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return prisma.usage.count({
      where: { id, date: { gte: today } },
    });
  },

  async recordUsage(
    prisma: PrismaClient,
    userId: number,
    apiType: "SAUCENAO" | "SCRAPER",
    session: any,
  ): Promise<void> {
    const user = await userService.getOrCreateUser(prisma, userId);
    const key = await keyManager.getAvailableKey(prisma, apiType);
    if (!key) throw new Error("Нет доступных ключей");

    await prisma.$transaction(async (tx) => {
      await tx.usage.create({
        data: { userId: user.id, keyId: key.id, apiType },
      });
      await keyManager.recordUsage(tx, key.id, apiType);
      session.todayUses = (session.todayUses || 0) + 1;
    });
  },
};
