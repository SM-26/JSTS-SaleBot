import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Draft from "../models/Draft";
import Capture from "../models/Capture";
import Member from "../models/Member";
import { createHarness, BOT_USERNAME } from "./harness";
import { AuthLevel, BotConfig } from "../types";
import type { Message } from "node-telegram-bot-api/types";

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
    const adminId = userId + 1;
    const configPath = path.join(__dirname, "../../config.json");
    const originalConfigFile = fs.readFileSync(configPath);
    const h = createHarness();
    const controller = new BotController(h.bot.api);
    controller.registerRoutes(h.bot, BOT_USERNAME);
    const senderBase = userId + 100; // capture senders, cleaned up in finally

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

        // A language pick saves it and removes the menu's buttons (#97).
        h.calls.length = 0;
        await h.pressButton("lang_en", { userId, messageId: 55 });
        assert.ok(await waitFor(() => h.calls.some((c) => c.method === "editMessageReplyMarkup" && Number(c.params.message_id) === 55)), "the /lang menu must lose its buttons");
        assert.strictEqual((await userRepository.findByUserId(String(userId)))?.preferredLocale, "en");

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

        // Capture: sale-topic messages land in per-sender windows, silently.
        const live = controller.config;
        const savedTopic = live.approvedTopicId;
        const groupId = live.approvedGroupId;
        const rows = (sender: number) => Capture.find({ senderId: String(sender), chatId: groupId }).exec();
        const group = { chatId: groupId, chatType: "supergroup" as const };
        live.approvedTopicId = 1;

        delete live.captureMode;
        await expectSilence("capture off", () => h.sendText("sell: bike 100", { ...group, userId: senderBase }));
        assert.strictEqual((await rows(senderBase)).length, 0, "captureMode unset records nothing");

        live.captureMode = "shadow";
        await expectSilence("topic 1 accepts missing thread id", () => h.sendText("sell: bike 100", { ...group, userId: senderBase + 1 }));
        const accepted = await rows(senderBase + 1);
        assert.strictEqual(accepted.length, 1, "topic 1 accepts a message without a thread id");
        assert.strictEqual(accepted[0].text, "sell: bike 100");
        assert.strictEqual(accepted[0].senderName, "Tester");
        assert.ok(await Member.exists({ userId: String(senderBase + 1) }), "the sender is touched as a member");

        const ignored: [string, number, () => Promise<void>][] = [
            ["other topic", 2, () => h.sendText("bike", { ...group, userId: senderBase + 2, messageThreadId: 48138 })],
            ["bot sender", 3, () => h.sendText("bike", { ...group, userId: senderBase + 3, isBot: true })],
            ["reply", 4, () => h.sendText("bike", { ...group, userId: senderBase + 4, replyToMessageId: 999_999_999 })],
            ["command", 5, () => h.sendText("/sell bike", { ...group, userId: senderBase + 5 })],
            ["other chat", 6, () => h.sendText("bike", { userId: senderBase + 6, chatId: groupId - 1, chatType: "supergroup" })],
            ["forward", 7, () => h.sendText("bike", { ...group, userId: senderBase + 7, forwardOrigin: { type: "hidden_user", date: 1, sender_user_name: "x" } })],
            ["channel sender", 8, () => h.sendText("bike", { ...group, userId: senderBase + 8, senderChat: { id: -100, type: "channel", title: "c" } })],
        ];
        for (const [label, offset, send] of ignored) {
            await expectSilence(`${label} ignored`, send);
            assert.strictEqual((await rows(senderBase + offset)).length, 0, `${label} must not be captured`);
        }

        // A named topic: its messages carry the thread id, and Telegram's root reply is not a real reply.
        live.approvedTopicId = 11;
        await expectSilence("topic root reply", () => h.sendText("bike", { ...group, userId: senderBase + 9, messageThreadId: 11, replyToMessageId: 11 }));
        assert.strictEqual((await rows(senderBase + 9)).length, 1, "a named topic accepts its thread id (root reply ignored)");
        await expectSilence("topic without thread id", () => h.sendText("bike", { ...group, userId: senderBase + 10 }));
        assert.strictEqual((await rows(senderBase + 10)).length, 0, "a named topic needs its thread id");
        live.approvedTopicId = 1;

        // A captioned photo keeps the caption and the largest size.
        await h.message({ photo: [
            { file_id: "small", file_unique_id: "s", width: 10, height: 10 },
            { file_id: "big", file_unique_id: "b", width: 100, height: 100 },
        ] }, { ...group, userId: senderBase + 11, caption: "bike 100" });
        const photo = (await rows(senderBase + 11))[0];
        assert.deepStrictEqual([photo.text, photo.media.map((m) => `${m.type}:${m.fileId}`)], ["bike 100", ["photo:big"]]);

        // An edit rewrites the open capture's text; an unknown message id changes nothing.
        const editor = senderBase + 12;
        await h.sendText("bike 100", { ...group, userId: editor, messageId: 777_001 });
        await expectSilence("edit", () => h.sendEdit(777_001, "bike 150", { ...group, userId: editor }));
        assert.strictEqual((await rows(editor))[0].text, "bike 150", "an edit updates the open capture");
        await expectSilence("edit of an unknown message", () => h.sendEdit(777_999, "other", { ...group, userId: editor }));
        const afterUnknown = await rows(editor);
        assert.deepStrictEqual([afterUnknown.length, afterUnknown[0].text], [1, "bike 150"]);
        delete live.captureMode;
        live.approvedTopicId = savedTopic;

        // /config can set a key an older config.json predates (captureMode), and lists it as unset.
        await User.create({ userId: String(adminId), firstName: "Admin", authLevel: AuthLevel.ADMIN });
        const { AdminService } = await import("../services/adminService");
        const oldConfig: BotConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        delete oldConfig.captureMode;
        const admin = new AdminService(h.bot.api, oldConfig);
        const configMsg = { message_id: 1, date: 0, chat: { id: adminId, type: "private" }, from: { id: adminId, is_bot: false, first_name: "Admin" } } as Message;
        const adminLocale = localeService.resolveUserLocale(await userRepository.findByUserId(String(adminId)));
        h.calls.length = 0;
        await admin.handleConfig(configMsg, "");
        assert.ok(String(h.calls.at(-1)?.params.text).includes("<b>captureMode</b>: <code>(unset)</code>"), "/config lists the missing key as unset");
        h.calls.length = 0;
        await admin.handleConfig(configMsg, "captureMode shadow");
        assert.ok(String(h.calls.at(-1)?.params.text).includes(localeService.t(adminLocale, "configUpdated")), "/config accepts a key missing from config.json");
        assert.strictEqual(oldConfig.captureMode, "shadow");

        console.log("[OK] commands, look-alikes, stale button and the persisted wizard are routed correctly.");
    } finally {
        fs.writeFileSync(configPath, originalConfigFile); // updateConfig writes config.json
        await User.deleteOne({ userId: String(adminId) });
        await User.deleteOne({ userId: String(userId) });
        await Post.deleteMany({ userId: String(userId) });
        await Draft.deleteMany({ userId: String(userId) });
        const captureSenders = Array.from({ length: 13 }, (_, i) => String(senderBase + i));
        await Capture.deleteMany({ senderId: { $in: captureSenders } });
        await Member.deleteMany({ userId: { $in: captureSenders } });
        await mongoose.connection.db!.collection<{ _id: string }>("bot_sessions").deleteMany({ _id: { $regex: `:${userId}$` } });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkRoutes failed:", err);
    process.exit(1);
});
