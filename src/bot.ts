import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { connectDB } from "./config/db";
import { BotController } from "./controllers/botController";

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error("BOT_TOKEN is missing. Set it in your .env file.");
    process.exit(1);
}

async function main() {
    await connectDB();

    const bot = new TelegramBot(token!, { polling: true });

    const controller = new BotController(bot);
    controller.registerRoutes();
    await controller.syncSoldPosts();

    console.log("Bot is running...");

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log("Shutting down bot...");
        bot.stopPolling();
        process.exit(0);
    });
}

main();
