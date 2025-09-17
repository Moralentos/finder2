import { Bot, Context, SessionFlavor } from "grammy";
import { MenuFlavor } from "@grammyjs/menu";
import { Config } from "./config";

interface ISession {}
export type SessionContext = Context & SessionFlavor<ISession> & MenuFlavor;

export class TG {
  private core: Bot<SessionContext>;

  constructor(token: string) {
    this.core = new Bot(token);
  }

  public async init(): Promise<void> {}

  public async setup(): Promise<void> {
    this.core.command("start", async (ctx: Context) => {
      await ctx.reply("Test command");
      Config.setUserRequests(Config.userRequests + 1);
    });
    this.core.command("stop", async (ctx: Context) => {
      await this.stop();
    });
    this.core.on("message", async (ctx: Context) => {
      await ctx.reply(`${Config.userRequests} запросов`);
    });
  }

  public async start(): Promise<void> {
    await this.init();
    await this.setup();
    console.log("Starting bot");
    await this.core.start();
  }

  public async stop(): Promise<void> {
    console.log("Stopping bot");
    await this.core.stop();
    // process.exit(0);
  }
}
