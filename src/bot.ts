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
import memberRepository from "./repositories/memberRepository";
import { reconcileBotListings } from "./services/marketService";
import { isCaptureOn } from "./services/captureService";
import { tick } from "./services/shadowService";
import { startSweeper } from "./services/sweeper";

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

const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "pre_checkout_query"];

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
    // never stops the bot. The sweeper (capture windows, hourly reconcile) starts
    // in init and stops in close BEFORE disconnectDB, so no job runs on a closed
    // connection.
    let sweeper: { stop(): void } | undefined;
    const reconcile = async () => {
        try {
            const { created, sold } = await reconcileBotListings(new Date());
            if (created || sold) console.log(`[reconcile] ${created} listing(s) created, ${sold} marked sold`);
        } catch (err) {
            console.error("[ERROR - reconcile]", (err as Error).message);
        }
    };
    const lifecycle: Middleware<Context> = Object.assign(
        (_ctx: Context, next: () => Promise<void>) => next(),
        {
            init: async () => {
                await controller.syncSoldPosts();
                await controller.deleteExpiredDrafts();
                await reconcile();
                sweeper = startSweeper([
                    // read live: /config can switch captureMode without a restart
                    { name: "captures", everyMs: 10_000, run: async () => { if (isCaptureOn(controller.config)) await tick(controller.config, new Date(), async (event, now) => { await controller.captureNotes.onClassified(event, now); await controller.buyerNotes.onClassified(event, now); }); } },
                    { name: "alerts", everyMs: 60_000, run: () => controller.alerts.tick(new Date()) },
                    { name: "reconcile", everyMs: 3_600_000, run: reconcile },
                    { name: "catchup-purge", everyMs: 3_600_000, run: async () => { const n = await memberRepository.dropExpiredCatchups(new Date()); if (n) console.log(`[INFO] catchup-purge: dropped ${n} expired offers`); } },
                    { name: "catchup-held", everyMs: 10_000, run: async () => { await controller.catchupService.releaseHeld(new Date()); } },
                    ...controller.lifecycleJobs(),
                ]);
            },
            close: async () => {
                sweeper?.stop();
                await disconnectDB();
            },
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
    // Always name the update types: without the list Telegram reuses the last one any
    // poller set for this token, which once silently dropped every button press on
    // the test bot. Add a type here when a handler for it is added.
    await run(bot, { exitOnError: true, onError: createPollErrorLogger(), allowedUpdates: ALLOWED_UPDATES });
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
