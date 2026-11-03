import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Draft from "../models/Draft";
import { createHarness, BOT_USERNAME } from "./harness";
import type { BotConfig } from "../types";

// Smoke test for BotController.registerRoutes on the offline harness: every
// user command is routed, look-alikes are not, the /newPost wizard answers
// from the persisted draft, and a stale button gets the toast. (checkFlows
// covers the flows in depth.) Needs Mongo because the middleware and handlers
// read/write user, draft and session records.
const MONGO_URI = process.env.MONGO_URI;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (!condition() && Date.now() < end) await sleep(20);
    return condition();
}

// Handlers are awaited, but their fire-and-forget API calls land a tick later.
const QUIET_MS = 300;

async function run() {
    if (!MONGO_URI) {
        console.log("[SKIP] checkRoutes: set MONGO_URI to run this test.");
        return;
    }

    console.log("[INFO] Checking BotController routes...");
    await mongoose.connect(MONGO_URI);

    // config.json is read at import time, so load the controller only after the SKIP check.
    const { BotController } = await import("../controllers/botController");
    const { localeService } = await import("../services/localeService");
    const { default: userRepository } = await import("../repositories/userRepository");
    const config: BotConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../../config.json"), "utf-8"));

    const userId = 7_000_000_000 + (Date.now() % 1_000_000_000);
    const h = createHarness();
    new BotController(h.bot.api).registerRoutes(h.bot, BOT_USERNAME);

    const expectCalls = async (label: string, send: () => Promise<void>) => {
        h.calls.length = 0;
        await send();
        assert.ok(await waitFor(() => h.calls.length > 0), `${label} should produce an API call`);
        await sleep(QUIET_MS); // let multi-message handlers finish before the next case
    };
    const expectSilence = async (label: string, send: () => Promise<void>) => {
        h.calls.length = 0;
        await send();
        await sleep(QUIET_MS);
        assert.strictEqual(h.calls.length, 0, `${label} must produce no API calls, got ${JSON.stringify(h.calls)}`);
    };

    try {
        // Admin commands answer a plain user with "not an admin", which is still a reply.
        const commands = [
            "/start", "/myposts", "/help", "/lang", "/config", "/activeUsers", "/pending",
            "/clearpending", "/broadcast hello", "/broadcastUsers hello", "/promote 1", "/demote 1",
            "/auth", "/test", "/donate", "/cancel",
            "/start@" + BOT_USERNAME, "/START",
        ];
        if (config.enableFaq !== false) commands.push("/faq");

        for (const text of commands) {
            await expectCalls(text, () => h.sendText(text, { userId }));
        }

        await expectSilence("/start@someotherbot", () => h.sendText("/start@someotherbot", { userId }));
        await expectSilence("a URL", () => h.sendText("see http://x.com/test", { userId }));

        // A group message in the approved group that replies to nothing is not ours to answer.
        await expectSilence("plain approved-group message", () =>
            h.sendText("hello", { userId, chatId: config.approvedGroupId, chatType: "supergroup" }));
        await expectSilence("approved-group reply to an unknown post", () => h.send({
            message: {
                message_id: 500,
                date: Math.floor(Date.now() / 1000),
                chat: { id: config.approvedGroupId, type: "supergroup" },
                from: { id: userId, is_bot: false, first_name: "Tester" },
                text: "is this still available?",
                reply_to_message: {
                    message_id: 999_999_999,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: config.approvedGroupId, type: "supergroup" }
                }
            }
        }));

        // A confirm button with no flow behind it gets the stale toast.
        h.calls.length = 0;
        await h.pressButton("confirm_42_1", { userId });
        const user = await userRepository.findByUserId(String(userId));
        const toast = h.calls.find((c) => c.method === "answerCallbackQuery");
        assert.ok(toast, "a stale button must be answered");
        assert.strictEqual(toast.params.text, localeService.t(localeService.resolveUserLocale(user), "staleButton"));
        assert.ok(h.calls.some((c) => c.method === "editMessageReplyMarkup"), "a stale button must lose its keyboard");

        // /newPost (mixed case) sends the first prompt and stores the draft; answering it sends the second.
        h.calls.length = 0;
        await h.sendText("/NewPost", { userId });
        assert.ok(await waitFor(() => h.calls.some((c) => c.method === "sendMessage")), "/NewPost must send the first prompt");
        await sleep(QUIET_MS);
        assert.strictEqual(h.calls.filter((c) => c.method === "sendMessage").length, 1, "only the first prompt so far");
        assert.strictEqual((await Draft.findOne({ userId: String(userId) }))?.step, "title", "the draft is in Mongo");

        await h.sendText("A bicycle", { userId });
        assert.ok(
            await waitFor(() => h.calls.filter((c) => c.method === "sendMessage").length === 2),
            "answering the first prompt must send the second prompt"
        );
        assert.strictEqual((await Draft.findOne({ userId: String(userId) }))?.title, "A bicycle");

        console.log("[OK] commands, look-alikes, stale button and the persisted wizard are routed correctly.");
    } finally {
        await User.deleteOne({ userId: String(userId) });
        await Post.deleteMany({ userId: String(userId) });
        await Draft.deleteMany({ userId: String(userId) });
        await mongoose.connection.db!.collection<{ _id: string }>("bot_sessions").deleteMany({ _id: { $regex: `:${userId}$` } });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkRoutes failed:", err);
    process.exit(1);
});
