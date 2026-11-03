import "dotenv/config";
import { Bot } from "node-telegram-bot-api";
import { run } from "node-telegram-bot-api/node";
import * as fs from "fs";
import * as path from "path";
import { connectDB, disconnectDB } from "./config/db";
import { BotController } from "./controllers/botController";
import { errorBoundary } from "./controllers/middleware";
import { createPollErrorLogger } from "./config/pollingErrors";

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error("BOT_TOKEN is missing. Set it in your .env file.");
    process.exit(1);
}

// ponytail: a long-running bot should log and keep polling, not die. Several
// api.editMessage* calls are fire-and-forget; Telegram 400s (e.g. "message is
// not modified") would otherwise take the whole process down.
process.on("unhandledRejection", (err) => {
    console.error("[unhandledRejection]", err);
});

async function main() {
    await connectDB();

    const bot = new Bot(token!);
    const me = await bot.api.getMe();

    const controller = new BotController(bot.api);
    controller.registerRoutes(bot, me.username!);
    bot.catch(errorBoundary);
    await controller.syncSoldPosts();
    await controller.deleteExpiredDrafts();

    const pkgPath = path.join(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

    console.log(`Bot v${pkg.version} (@${me.username}) is running...`);

    // run() installs the SIGINT/SIGTERM handlers (`docker stop` sends SIGTERM,
    // and Node running as a container's PID 1 ignores it without a handler).
    await run(bot, { exitOnError: true, onError: createPollErrorLogger() });

    await disconnectDB();
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
