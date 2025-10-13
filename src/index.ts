import * as dotenv from "dotenv";
import { TG } from "./bot";

const path: string = "/run/media/andrew/Новый том/GithubProjects/finder2/.env";
dotenv.config({
  path,
});

const token: string | undefined = process.env.TOKEN;
if (!token) {
  console.error("Ошибка: Токен бота не найден");
  process.exit(1);
}

(async (): Promise<void> => {
  const bot = new TG(token!); // Уверены, что token не undefined
  await bot.start();
})();
