import { PrismaClient } from "@prisma/client";

interface User {
  id: string;
  telegramId: number;
  username: string | null;
  status: "ORDINARY" | "PREMIUM" | "ADMIN";
  createdAt: Date;
}

export const userService = {
  async getOrCreateUser(
    prisma: PrismaClient,
    telegramId: string,
    username?: string,
  ): Promise<User> {
    return prisma.user.upsert({
      where: { telegramId },
      update: { username },
      create: { telegramId, username },
    });
  },

  async recordUsage(prisma: PrismaClient, userId: string): Promise<void> {
    const user = await userService.getOrCreateUser(prisma, userId);
    await prisma.usage.create({
      data: { userId: user.id },
    });
  },
};
