import "dotenv/config";
import { Bot } from "node-telegram-bot-api";
import type { Context, Middleware } from "node-telegram-bot-api";
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

    // Startup sweeps and the Mongo disconnect ride the bot lifecycle: run() calls
    // bot.init() before the first poll and bot.close() on the way out (also after a
    // fatal poll error). A passthrough middleware carrying init/close is how v2 picks
    // that up. Registered BEFORE the session middleware (inside registerRoutes) so
    // close(), which runs in reverse order, disconnects Mongo after the session
    // store has closed. The sweeps catch and log their own errors, so a failed init
    // never stops the bot.
    const lifecycle: Middleware<Context> = Object.assign(
        (_ctx: Context, next: () => Promise<void>) => next(),
        {
            init: async () => {
                await controller.syncSoldPosts();
                await controller.deleteExpiredDrafts();
            },
            close: () => disconnectDB(),
        }
    );
    bot.use(lifecycle);

    controller.registerRoutes(bot, me.username!);
    bot.catch(errorBoundary);

    const pkgPath = path.join(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

    console.log(`Bot v${pkg.version} (@${me.username}) is running...`);

    // run() installs the SIGINT/SIGTERM handlers (`docker stop` sends SIGTERM,
    // and Node running as a container's PID 1 ignores it without a handler).
    await run(bot, { exitOnError: true, onError: createPollErrorLogger() });
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
