import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import mongoose from "mongoose";
import * as fs from "fs";
import * as path from "path";
import { connectDB } from "./config/db";
import { BotController } from "./controllers/botController";

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error("BOT_TOKEN is missing. Set it in your .env file.");
    process.exit(1);
}

// ponytail: a long-running bot should log and keep polling, not die. Several
// bot.editMessage* calls are fire-and-forget; Telegram 400s (e.g. "message is
// not modified") would otherwise take the whole process down.
process.on("unhandledRejection", (err) => {
    console.error("[unhandledRejection]", err);
});

async function main() {
    await connectDB();

    const bot = new TelegramBot(token!, { polling: true });

    const controller = new BotController(bot);
    controller.registerRoutes();
    await controller.syncSoldPosts();

    const pkgPath = path.join(__dirname, "../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

    console.log(`Bot v${pkg.version} is running...`);

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log("Shutting down bot...");
        bot.stopPolling()
            .then(() => mongoose.disconnect())
            .catch((err) => console.error("Shutdown error:", err))
            .finally(() => process.exit(0));
    });
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
