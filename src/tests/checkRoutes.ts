import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Draft from "../models/Draft";
import Capture from "../models/Capture";
import Member from "../models/Member";
import Listing from "../models/Listing";
import ShadowLog from "../models/ShadowLog";
import { createHarness, BOT_USERNAME } from "./harness";
import { seedCapture } from "./fixtures";
import { AuthLevel, BotConfig } from "../types";
import type { Message } from "node-telegram-bot-api/types";

// Smoke test for BotController.registerRoutes on the offline harness: every
// user command is routed, look-alikes are not, the /newPost wizard answers
// from the persisted draft, and a stale button gets the toast. (checkFlows
// covers the flows in depth.) Needs Mongo because the middleware and handlers
// read/write user, draft and session records.
const MONGO_URI = process.env.MONGO_URI;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The t.me link in a /label message, compared exactly (not as a substring).
const linkIn = (text: unknown): string | undefined => String(text).match(/https:\/\/t\.me\/\S+/)?.[0];

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
    // this check deletes shadow_log rows (below): throwaway database only, same guard as checkMarket
    assert.ok(/test/i.test(mongoose.connection.name), `refusing to run on database "${mongoose.connection.name}" (name must contain "test")`);

    // config.json is read at import time, so load the controller only after the SKIP check.
    const { BotController } = await import("../controllers/botController");
    const { localeService } = await import("../services/localeService");
    const { default: userRepository } = await import("../repositories/userRepository");
    const config: BotConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../../config.json"), "utf-8"));

    const userId = 7_000_000_000 + (Date.now() % 1_000_000_000);
    const adminId = userId + 1;
    const configPath = path.join(__dirname, "../../config.json");
    const originalConfigFile = fs.readFileSync(configPath);
    const h = createHarness({ responses: { getChat: { id: 0, type: "supergroup", username: "pubgroup" } } });
    const controller = new BotController(h.bot.api);
    controller.registerRoutes(h.bot, BOT_USERNAME);
    const senderBase = userId + 100; // capture senders, cleaned up in finally
    const optinSenders = [String(senderBase + 50), String(senderBase + 51)]; // /stats opt-in seeds, cleaned in their own finally

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
            "/auth", "/test", "/donate", "/cancel", "/stats", "/label",
            "/start@" + BOT_USERNAME, "/START",
        ];
        if (config.enableFaq !== false) commands.push("/faq");

        for (const text of commands) {
            await expectCalls(text, () => h.sendText(text, { userId }));
        }

        // A payload that is not ours answers the plain greeting.
        const greetingOf = async (text: string) => {
            await expectCalls(text, () => h.sendText(text, { userId }));
            return String(h.calls.find((c) => c.method === "sendMessage")?.params.text);
        };
        const plainGreeting = await greetingOf("/start");
        assert.strictEqual(await greetingOf("/start garbage"), plainGreeting, "/start garbage answers the greeting");
        assert.strictEqual(await greetingOf("/start c_xyz"), plainGreeting, "/start c_xyz answers the greeting");

        await expectSilence("/start@someotherbot",() => h.sendText("/start@someotherbot", { userId }));
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

        // /stats (MOD and up) and /label (ADMIN only), both DM.
        const modId = adminId + 1;
        await User.create({ userId: String(adminId), firstName: "Admin", authLevel: AuthLevel.ADMIN });
        await User.create({ userId: String(modId), firstName: "Mod", authLevel: AuthLevel.MOD });
        const notAdminText = localeService.t(config.lang, "notAdmin");
        const lastText = () => String(h.calls.find((c) => c.method === "sendMessage")?.params.text);
        await expectCalls("/stats as USER", () => h.sendText("/stats", { userId }));
        assert.strictEqual(lastText(), notAdminText, "/stats denies a plain user");
        await expectCalls("/label as MOD", () => h.sendText("/label", { userId: modId }));
        assert.strictEqual(lastText(), notAdminText, "/label denies a moderator");
        await expectCalls("/stats as MOD", () => h.sendText("/stats", { userId: modId }));
        assert.strictEqual(h.calls.filter((c) => c.method === "sendMessage").length, 1, "/stats sends one message");
        assert.ok(/^.*7.*\|.*30.*$/m.test(lastText()), "/stats shows the 7 and 30 day header");
        const shadow = await ShadowLog.create({ chatId: config.approvedGroupId, messageIds: [4242], senderId: "s", at: new Date(), tier: "strict", rules: [], wouldList: true, parsedPriceValue: 100 });
        try {
            // only our row is sampled (/label picks from all chats, so this cannot be scoped; the test-database guard above makes it safe)
            await ShadowLog.deleteMany({ _id: { $ne: shadow._id }, label: { $exists: false }, wouldList: true });
            await expectCalls("/label as ADMIN", () => h.sendText("/label", { userId: adminId }));
            const labelCall = h.calls.find((c) => c.method === "sendMessage")!;
            assert.strictEqual(linkIn(labelCall.params.text), "https://t.me/pubgroup/4242", "/label links the approved group by its @username");
            assert.ok(String(labelCall.params.text).endsWith("\nstrict · 100"), "/label shows the tier and the price number, no text");
            assert.ok(!String(labelCall.params.text).includes("Bike"), "/label shows no title");
            const keyboard = (labelCall.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
            assert.deepStrictEqual(keyboard.map((b) => b.callback_data), [`lb_${shadow._id}_s`, `lb_${shadow._id}_n`, `lb_${shadow._id}_k`]);
            h.calls.length = 0;
            await h.pressButton(`lb_${shadow._id}_s`, { userId: modId, messageId: 61 });
            assert.strictEqual((await ShadowLog.findById(shadow._id))?.label, undefined, "a moderator cannot label");
            await h.pressButton(`lb_${shadow._id}_s`, { userId: adminId, messageId: 61 });
            assert.ok(await waitFor(() => h.calls.some((c) => c.method === "editMessageText")), "the label message is edited to the next row");
            const labeled = await ShadowLog.findById(shadow._id);
            assert.deepStrictEqual([labeled?.label, labeled?.labeledBy], ["sale", String(adminId)]);

            // Skip never re-shows the same row; the @username link is only for the approved group.
            const mkRow = (chatId: number, messageId: number) => ShadowLog.create({ chatId, messageIds: [messageId], senderId: "skip-test", at: new Date(), tier: "strict", rules: [], wouldList: true });
            const rowA = await mkRow(config.approvedGroupId, 5151);
            const rowB = await mkRow(config.approvedGroupId - 1, 5252);
            const skip = async (row: typeof rowA) => {
                h.calls.length = 0;
                await h.pressButton(`lb_${row._id}_k`, { userId: adminId, messageId: 62 });
                assert.ok(await waitFor(() => h.calls.some((c) => c.method === "editMessageText")), "Skip edits the label message");
                return h.calls.find((c) => c.method === "editMessageText")!.params;
            };
            const afterA = await skip(rowA);
            assert.strictEqual(linkIn(afterA.text), `https://t.me/c/${String(Math.abs(config.approvedGroupId - 1)).replace(/^100/, "")}/5252`,"Skip shows the other row, linked by id (its chat has no known @username)");
            assert.ok(JSON.stringify(afterA.reply_markup).includes(`lb_${rowB._id}_s`), "Skip does not re-show the skipped row");
            const afterB = await skip(rowB);
            assert.strictEqual(linkIn(afterB.text), "https://t.me/pubgroup/5151","the approved group's row links by @username");
            assert.ok(JSON.stringify(afterB.reply_markup).includes(`lb_${rowA._id}_s`));
            await ShadowLog.deleteOne({ _id: rowB._id });
            const last = await skip(rowA);
            assert.strictEqual(last.text, localeService.t(config.lang, "labelEmpty"), "Skip with no other row shows labelEmpty");
            h.calls.length = 0;
            await h.sendText("/stats", { userId: modId });
            assert.ok(await waitFor(() => h.calls.some((c) => c.method === "sendMessage")));
            assert.ok(/\d+\.\d%/.test(lastText()), "/stats shows precision with one decimal");

            // Opt-in rate: last 7 days, first-ask notes only. The line shows when captureMode is optin or a note exists.
            const { default: captureRepository } = await import("../repositories/captureRepository");
            const optinLine = (n: number, a: number) => localeService.t(config.lang, "statsOptin", { notes: n, added: a, rate: n ? `${Math.round(100 * a / n)}%` : "—" });
            const optinKey = localeService.t(config.lang, "statsOptin").split("{")[0];
            const statsText = async () => {
                h.calls.length = 0;
                await h.sendText("/stats", { userId: modId });
                assert.ok(await waitFor(() => h.calls.some((c) => c.method === "sendMessage")));
                return lastText();
            };
            const savedMode = controller.config.captureMode;
            try {
                const base = await captureRepository.noteStats(new Date(Date.now() - 7 * 24 * 3600 * 1000));
                if (base.notes === 0) { // a shared database may hold notes; the checks below need none
                    controller.config.captureMode = "shadow";
                    assert.ok(!(await statsText()).includes(optinKey), "shadow with no notes: no opt-in line");
                    controller.config.captureMode = "optin";
                    assert.ok((await statsText()).includes(optinLine(0, 0)), "optin with no notes: line with a dash rate");
                }
                controller.config.captureMode = "shadow";
                const ask = { ephemeralMessageId: 1, sentAt: new Date(), kind: "ask" as const };
                await seedCapture({ senderId: optinSenders[0], text: "bike 100", state: "added", note: ask });
                await seedCapture({ senderId: optinSenders[1], text: "bike 100", state: "asked", note: ask });
                assert.ok((await statsText()).includes(optinLine(base.notes + 2, base.added + 1)), "/stats shows the 7-day opt-in rate");
                // M6: a noteStats failure drops the opt-in line, not the whole /stats answer
                controller.config.captureMode = "optin";
                const realNoteStats = captureRepository.noteStats;
                captureRepository.noteStats = () => Promise.reject(new Error("boom"));
                try {
                    const degraded = await statsText();
                    assert.ok(/\d+\.\d%/.test(degraded) && !degraded.includes(optinKey), "/stats survives a noteStats failure");
                } finally {
                    captureRepository.noteStats = realNoteStats;
                }
            } finally {
                controller.config.captureMode = savedMode;
                await Capture.deleteMany({ senderId: { $in: optinSenders } });
            }

            // /test shadow_last5: a row without message ids shows a dash, not "undefined"
            await ShadowLog.create({ chatId: config.approvedGroupId, messageIds: [], senderId: "last5-test", at: new Date(Date.now() + 60_000), tier: "none", rules: [], wouldList: false });
            h.calls.length = 0;
            await h.pressButton("test_shadow_last5", { userId: adminId, messageId: 63 });
            assert.ok(await waitFor(() => h.calls.some((c) => c.method === "sendMessage")), "shadow_last5 answers");
            const last5 = String(h.calls.find((c) => c.method === "sendMessage")!.params.text);
            assert.ok(last5.split("\n")[0].endsWith(" · —") && !last5.includes("undefined"), `shadow_last5 shows — for empty messageIds, got ${last5}`);
        } finally {
            await ShadowLog.deleteMany({ senderId: { $in: ["skip-test", "last5-test"] } });
            await ShadowLog.deleteOne({ _id: shadow._id });
            await User.deleteOne({ userId: String(modId) });
        }

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
            ["other topic", 2, () => h.sendText("bike", { ...group, userId: senderBase + 2, messageThreadId: 48138, isTopicMessage: true })],
            ["bot sender", 3, () => h.sendText("bike", { ...group, userId: senderBase + 3, isBot: true })],
            ["reply", 4, () => h.sendText("bike", { ...group, userId: senderBase + 4, replyToMessageId: 999_999_999 })],
            ["command", 5, () => h.sendText("/sell bike", { ...group, userId: senderBase + 5 })],
            ["other chat", 6, () => h.sendText("bike", { userId: senderBase + 6, chatId: groupId - 1, chatType: "supergroup" })],
            ["forward", 7, () => h.sendText("bike", { ...group, userId: senderBase + 7, forwardOrigin: { type: "hidden_user", date: 1, sender_user_name: "x" } })],
            ["channel sender", 8, () => h.sendText("bike", { ...group, userId: senderBase + 8, senderChat: { id: -100, type: "channel", title: "c" } })],
        ];
        for (const [label, offset, send] of ignored) {
            await expectSilence(`${label} ignored`, send);
            // no chat filter: a capture recorded under any chat would fail this
            assert.strictEqual(await Capture.countDocuments({ senderId: String(senderBase + offset) }), 0, `${label} must not be captured`);
        }

        // A named topic: its messages carry the thread id, and Telegram's root reply is not a real reply.
        live.approvedTopicId = 11;
        await expectSilence("topic root reply", () => h.sendText("bike", { ...group, userId: senderBase + 9, messageThreadId: 11, isTopicMessage: true, replyToMessageId: 11 }));
        assert.strictEqual((await rows(senderBase + 9)).length, 1, "a named topic accepts its thread id (root reply ignored)");
        await expectSilence("topic without thread id", () => h.sendText("bike", { ...group, userId: senderBase + 10 }));
        assert.strictEqual((await rows(senderBase + 10)).length, 0, "a named topic needs its thread id");

        // Regression: a real reply to an approved post inside a named topic still reaches the author and is not captured.
        const approvedMessageId = 900_000_000 + (Date.now() % 100_000_000);
        await Post.create({ userId: String(userId), title: "Reply target", description: "d", price: "10", location: "l", media: [], status: "approved", approvedMessageId });
        h.calls.length = 0;
        await h.sendText("is it available?", { ...group, userId: senderBase + 13, messageThreadId: 11, isTopicMessage: true, replyToMessageId: approvedMessageId });
        assert.ok(await waitFor(() => h.calls.some((c) => c.method === "sendMessage" && Number(c.params.chat_id) === userId)), "the post's author is notified of the reply");
        assert.strictEqual(await Capture.countDocuments({ senderId: String(senderBase + 13) }), 0, "a reply to a post is not captured");
        await sleep(QUIET_MS);
        live.approvedTopicId = 1;

        // Critical regression (prod): in the General topic (approvedTopicId 1) a reply to a bot post carries
        // message_thread_id = the replied-to post and no is_topic_message. It is a buyer reply: the seller is
        // notified (capture on or off) and nothing is captured.
        for (const [offset, mode] of [[17, "shadow"], [18, undefined]] as const) {
            const replyTargetId = approvedMessageId + 1 + offset;
            await Post.create({ userId: String(userId), title: "General reply target", description: "d", price: "10", location: "l", media: [], status: "approved", approvedMessageId: replyTargetId });
            if (mode) live.captureMode = mode; else delete live.captureMode;
            h.calls.length = 0;
            await h.sendText("is it available?", { ...group, userId: senderBase + offset, messageThreadId: replyTargetId, replyToMessageId: replyTargetId });
            assert.ok(await waitFor(() => h.calls.some((c) => c.method === "sendMessage" && Number(c.params.chat_id) === userId)),
                `topic 1 reply-thread reply notifies the author (captureMode ${mode ?? "off"})`);
            assert.strictEqual(await Capture.countDocuments({ senderId: String(senderBase + offset) }), 0, "a reply-thread reply is not captured");
            await sleep(QUIET_MS);
        }
        live.captureMode = "shadow";

        // A video keeps its file id; an album item keeps its media group id.
        await h.message({ video: { file_id: "vid1", file_unique_id: "v", width: 10, height: 10, duration: 1 } }, { ...group, userId: senderBase + 14 });
        const video = (await rows(senderBase + 14))[0];
        assert.deepStrictEqual(video.media.map((m) => `${m.type}:${m.fileId}`), ["video:vid1"]);
        await h.sendPhoto("album1", { ...group, userId: senderBase + 15, mediaGroupId: "mg-1" });
        assert.deepStrictEqual([...(await rows(senderBase + 15))[0].mediaGroupIds], ["mg-1"]);

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
        // An edit outside the sale topic changes nothing.
        const outsider = senderBase + 16;
        await h.sendText("bike 100", { ...group, userId: outsider, messageId: 777_002 });
        await expectSilence("edit outside the sale topic", () => h.sendEdit(777_002, "changed", { ...group, userId: outsider, messageThreadId: 48138, isTopicMessage: true }));
        assert.strictEqual((await rows(outsider))[0].text, "bike 100", "an edit outside the sale topic is ignored");
        delete live.captureMode;
        live.approvedTopicId = savedTopic;

        // /config can set a key an older config.json predates (captureMode), and lists it as unset.
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

        // lc_ callbacks: still for sale / sold / remove, from a DM, a note, and a forged press
        {
            const { default: listingRepository } = await import("../repositories/listingRepository");
            const SELLER = 100001;
            const OTHER = 100099;
            const tt = (key: string) => localeService.t(config.lang, key);
            const lcGroup = (extra: Record<string, unknown> = {}) => Listing.create({
                source: "group", origin: "capture", sellerId: String(SELLER), chatId: config.approvedGroupId, messageIds: [1],
                title: "t", price: "100", text: "x", media: [{ fileId: "f", type: "photo" }], status: "live",
                createdAt: new Date(2026, 0, 1), refreshedAt: new Date(2026, 0, 1), ...extra,
            });
            const lcBot = async (listingStatus: "live" | "expired") => {
                const post = await Post.create({ userId: String(SELLER), title: "bp", description: "d", price: "10", location: "l", media: [], status: "approved", approvedMessageId: 4242 });
                const listing = await listingRepository.createForPost(post, "dm", false, new Date(2026, 0, 1));
                if (listingStatus === "expired") await Listing.updateOne({ _id: listing._id }, { $set: { status: "expired", endedBy: "system", endedAt: new Date() } });
                return { post, listing };
            };
            const press = async (data: string, opts: Parameters<typeof h.pressButton>[1]) => {
                h.calls.length = 0;
                await h.pressButton(data, opts);
                assert.ok(await waitFor(() => h.calls.some((c) => c.method === "answerCallbackQuery")), `${data} is answered`);
                await sleep(QUIET_MS);
                assert.strictEqual(h.calls.filter((c) => c.method === "answerCallbackQuery").length, 1, "exactly one answer");
                return {
                    toast: String(h.calls.find((c) => c.method === "answerCallbackQuery")!.params.text),
                    of: (m: string) => h.calls.filter((c) => c.method === m),
                    edits: h.calls.filter((c) => ["editMessageText", "editMessageReplyMarkup", "editEphemeralMessageText"].includes(c.method)),
                };
            };
            const kbOf = (c: { params: Record<string, unknown> }) => (c.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? [];
            const dm = { userId: SELLER, chatId: SELLER };

            const g1 = await lcGroup();
            const r1 = await press(`lc_r_${g1._id}`, dm);
            assert.strictEqual(r1.toast, tt("listingRefreshedToast"));
            assert.ok((await listingRepository.findById(String(g1._id)))!.refreshedAt.getTime() > new Date(2026, 0, 2).getTime(), "refreshedAt moved");

            const rf = await press(`lc_r_${g1._id}`, { userId: OTHER, chatId: OTHER });
            assert.strictEqual(rf.toast, tt("notYourButton"));
            assert.strictEqual(rf.edits.length, 0, "a foreign press edits nothing");

            const e1 = await lcBot("expired");
            await press(`lc_r_${e1.listing._id}`, dm);
            assert.strictEqual((await listingRepository.findById(String(e1.listing._id)))!.status, "live", "an expired listing is live again");
            const e2 = await lcBot("expired");
            const s2 = await press(`lc_s_${e2.listing._id}`, dm);
            assert.strictEqual(s2.toast, tt("listingSoldToast"));
            assert.strictEqual((await listingRepository.findById(String(e2.listing._id)))!.status, "sold");
            assert.strictEqual((await Post.findById(e2.post._id))!.status, "sold", "the bot post is sold too");

            const gone = await lcGroup({ status: "removed", endedBy: "seller", endedAt: new Date() });
            const kb = (id: unknown) => ({ inline_keyboard: [[{ text: "a", callback_data: `lc_r_${id}` }, { text: "b", callback_data: `lc_s_${id}` }]] });
            const ended = await press(`lc_r_${gone._id}`, { ...dm, replyMarkup: kb(gone._id) });
            assert.strictEqual(ended.toast, tt("listingEnded"));
            assert.ok(ended.edits.length === 1 && kbOf(ended.edits[0]).length === 0, "an ended listing's row is dropped");

            const b3 = await lcBot("expired");
            await Listing.updateOne({ _id: b3.listing._id }, { $set: { status: "live" } });
            const nr = await press(`lc_x_${b3.listing._id}`, dm);
            assert.strictEqual(nr.toast, tt("lcNoRemove"));
            assert.strictEqual((await listingRepository.findById(String(b3.listing._id)))!.status, "live", "a bot listing is never removed");

            const g2 = await lcGroup();
            const rm = await press(`lc_x_${g2._id}`, dm);
            assert.strictEqual(rm.toast, tt("listingRemovedToast"));
            assert.strictEqual((await listingRepository.findById(String(g2._id)))!.status, "removed");

            const ga = await lcGroup();
            const gb = await lcGroup();
            const two = await press(`lc_r_${ga._id}`, { ...dm, replyMarkup: { inline_keyboard: [kb(ga._id).inline_keyboard[0], kb(gb._id).inline_keyboard[0]] } });
            assert.strictEqual(two.edits.length, 1);
            assert.deepStrictEqual(kbOf(two.edits[0]).flat().map((b) => b.callback_data), [`lc_r_${gb._id}`, `lc_s_${gb._id}`], "the other post's row stays");

            // from a note: never editMessageText/ReplyMarkup (message_id is 0)
            const nb = await lcBot("expired");
            const fromNote = await press(`lc_s_${nb.listing._id}`, { userId: SELLER, chatId: config.approvedGroupId, chatType: "supergroup", ephemeralMessageId: 5551 });
            // (the bot post's own group message is re-rendered as sold, which is not the pressed note)
            assert.strictEqual([...fromNote.of("editMessageText"), ...fromNote.of("editMessageReplyMarkup")].filter((c) => Number(c.params.message_id) === 0).length, 0, "no message edit for a note press");
            assert.strictEqual(fromNote.of("editEphemeralMessageText").length, 1);
            assert.deepStrictEqual(kbOf(fromNote.of("editEphemeralMessageText")[0]), [], "the note's keyboard is emptied");

            const gn = await lcGroup({ note: { ephemeralMessageId: 5552, sentAt: new Date() } });
            const own = await press(`lc_r_${gn._id}`, { userId: SELLER, chatId: config.approvedGroupId, chatType: "supergroup", ephemeralMessageId: 5552 });
            assert.strictEqual(own.of("editEphemeralMessageText").length, 1, "the listing's own note is edited once, by syncNote");
            assert.strictEqual(own.of("editMessageText").length + own.of("editMessageReplyMarkup").length, 0);

            const foreignNote = await press(`lc_r_${gn._id}`, { userId: OTHER, chatId: config.approvedGroupId, chatType: "supergroup", ephemeralMessageId: 5553 });
            assert.strictEqual(foreignNote.toast, tt("notYourButton"));
            assert.strictEqual(foreignNote.edits.length, 0, "a foreign press from a note edits nothing");

            const bad = await press("lc_", dm);
            assert.strictEqual(bad.toast, tt("staleButton"));

            // /myposts relist section: expired BOT listings only, one Relist row each
            const sectionMsgs = async (chatId: number) => {
                h.calls.length = 0;
                await h.sendText("/myposts", { userId: chatId, chatId });
                await sleep(QUIET_MS * 2);
                return h.calls.filter((c) => c.method === "sendMessage" && String(c.params.text).startsWith(tt("endedSectionTitle")));
            };
            await Listing.deleteMany({ sellerId: String(SELLER) });
            await Post.deleteMany({ userId: String(SELLER) });
            assert.strictEqual((await sectionMsgs(SELLER)).length, 0, "no expired listing: no relist message");
            await lcGroup({ status: "expired", endedBy: "system", endedAt: new Date() });
            assert.strictEqual((await sectionMsgs(SELLER)).length, 0, "an expired group listing gets no extra message");
            const rl = await lcBot("expired");
            const rlSold = await lcBot("expired");
            await Listing.updateOne({ _id: rlSold.listing._id }, { $set: { status: "sold" } });
            const sec = await sectionMsgs(SELLER);
            assert.strictEqual(sec.length, 1, "one relist message (also with no posts rows)");
            assert.deepStrictEqual(kbOf(sec[0]).flat().map((b) => b.callback_data), [`lc_r_${rl.listing._id}`], "only the expired bot listing has Relist");
            assert.strictEqual(sec[0].params.parse_mode, undefined, "titles are in buttons: no parse mode");
            const rp = await press(`lc_r_${rl.listing._id}`, { ...dm, replyMarkup: { inline_keyboard: kbOf(sec[0]) } });
            const after = await listingRepository.findById(String(rl.listing._id));
            assert.strictEqual(after!.status, "live", "relist makes it live");
            assert.ok(after!.refreshedAt.getTime() > new Date(2026, 0, 2).getTime(), "relist updates refreshedAt");
            assert.ok(rp.edits.length === 1 && kbOf(rp.edits[0]).length === 0, "the only row goes: no keyboard left");
            // /start l_<id> on an expired bot listing offers Relist; a sold one does not
            const ex = await lcBot("expired");
            h.calls.length = 0;
            await h.sendText(`/start l_${ex.listing._id}`, { userId: SELLER, chatId: SELLER });
            await sleep(QUIET_MS * 2);
            const card = h.calls.filter((c) => c.method === "sendMessage").at(-1)!;
            assert.deepStrictEqual(kbOf(card).flat().map((b) => b.callback_data), [`lc_r_${ex.listing._id}`], "expired bot card has Relist");
            h.calls.length = 0;
            await h.sendText(`/start l_${rlSold.listing._id}`, { userId: SELLER, chatId: SELLER });
            await sleep(QUIET_MS * 2);
            assert.deepStrictEqual(kbOf(h.calls.filter((c) => c.method === "sendMessage").at(-1)!), [], "a sold listing never gets Relist");

            await Listing.deleteMany({ sellerId: String(SELLER) });
            await Post.deleteMany({ userId: String(SELLER) });
        }


        // slice 3: /stalecheck (ADMIN, DM) -> dry run -> confirm
        {
            const created = new Date("2026-03-05T22:30:00Z");
            const seedLegacy = async (seller: string, title: string) => {
                const post = await Post.create({ userId: seller, title, description: "d", price: "100", location: "l", media: [], status: "approved", createdAt: created });
                return Listing.create({
                    source: "bot", origin: "legacy", hold: true, postId: String(post._id), sellerId: seller, title, price: "100",
                    messageIds: [], media: [], status: "live", createdAt: created, refreshedAt: created,
                });
            };
            const clean = async () => { await Listing.deleteMany({}); await Post.deleteMany({ userId: /^1\d{5}$/ }); };
            const sent = () => h.calls.filter((c) => c.method === "sendMessage");
            const kb = (c: { params: Record<string, unknown> }) => ((c.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
            const t = (key: string) => localeService.t(config.lang, key);
            const sessions = mongoose.connection.db!.collection<{ _id: string }>("bot_sessions");
            const adminSession = async () => JSON.stringify(await sessions.findOne({ _id: { $regex: `:${adminId}$` } } as never) ?? {});
            await clean();

            await expectCalls("/stalecheck as USER", () => h.sendText("/stalecheck", { userId }));
            assert.strictEqual(lastText(), notAdminText, "/stalecheck denies a plain user");
            await expectCalls("/stalecheck as MOD", () => h.sendText("/stalecheck", { userId: modId }));
            assert.strictEqual(lastText(), notAdminText, "/stalecheck denies a moderator");
            await expectCalls("/stalecheck, nothing eligible", () => h.sendText("/stalecheck", { userId: adminId }));
            assert.strictEqual(sent().length, 1);
            assert.strictEqual(lastText(), t("staleNothing"));
            assert.ok(!(await adminSession()).includes("pendingStalecheck"), "no session data when nothing is eligible");
            await expectCalls("/stalecheck 100001 x", () => h.sendText("/stalecheck 100001 x", { userId: adminId }));
            assert.strictEqual(sent().length, 1);
            assert.ok(lastText().startsWith(t("staleBadIds").split("{")[0]), "bad ids answer");
            await expectSilence("/stalecheck in a group", () => h.sendText("/stalecheck", { userId: adminId, chatId: -100123, chatType: "supergroup" }));

            const l1 = await seedLegacy("100001", "Glock 17 alpha");
            await seedLegacy("100001", "Hi-capa beta");
            await seedLegacy("100002", "Scope gamma");
            await expectCalls("/stalecheck dry run", () => h.sendText("/stalecheck", { userId: adminId }));
            await sleep(QUIET_MS);
            const msgs = sent();
            assert.strictEqual(msgs.length, 2, "dry run is two messages");
            assert.deepStrictEqual(kb(msgs[1]), ["sc_go", "sc_no"], "confirm keyboard on the second");
            assert.ok(!kb(msgs[0]).length, "no keyboard on the report");
            assert.ok(msgs.every((m) => !["100001", "100002"].includes(String(m.params.chat_id))), "no DM to any seller yet");
            assert.strictEqual((await Listing.countDocuments({ hold: true })), 3, "no listing changed");
            assert.ok((await adminSession()).includes("pendingStalecheck"), "pending stored in the session");

            // a non-admin pressing sc_go is refused
            h.calls.length = 0;
            await h.pressButton("sc_go", { userId, chatId: adminId, messageId: 91 });
            await sleep(QUIET_MS);
            assert.ok(!sent().length && (await Listing.countDocuments({ hold: true })) === 3, "USER press refused");

            // confirm
            h.calls.length = 0;
            await h.pressButton("sc_go", { userId: adminId, messageId: 91 });
            assert.ok(await waitFor(() => sent().filter((c) => ["100001", "100002"].includes(String(c.params.chat_id))).length === 2), "seller DMs sent");
            await sleep(QUIET_MS);
            assert.strictEqual((await Listing.countDocuments({ hold: false, nudgedAt: { $exists: true } })), 3, "all three claimed");
            assert.ok(sent().some((c) => String(c.params.chat_id) === String(adminId)), "admin told the result");
            assert.ok(!(await adminSession()).includes("pendingStalecheck"), "pending gone");
            const l1Raw = await Listing.findById(l1._id);
            assert.ok(l1Raw && l1Raw.hold === false);
            h.calls.length = 0;
            await h.pressButton("sc_go", { userId: adminId, messageId: 91 });
            await sleep(QUIET_MS);
            const toast = h.calls.find((c) => c.method === "answerCallbackQuery");
            assert.strictEqual(toast?.params.text, t("staleButton"), "second press -> staleButton");
            assert.ok(!sent().some((c) => ["100001", "100002"].includes(String(c.params.chat_id))), "second press sends nothing");

            // cancel
            await clean();
            await seedLegacy("100001", "Glock 17 alpha");
            await expectCalls("/stalecheck again", () => h.sendText("/stalecheck 100001", { userId: adminId }));
            h.calls.length = 0;
            await h.pressButton("sc_no", { userId: adminId, messageId: 92 });
            await sleep(QUIET_MS);
            assert.ok(!sent().length, "sc_no sends nothing");
            assert.ok(h.calls.some((c) => c.method === "editMessageReplyMarkup"), "sc_no drops the keyboard");
            assert.ok(!(await adminSession()).includes("pendingStalecheck"), "sc_no clears pending");
            assert.strictEqual(await Listing.countDocuments({ hold: true }), 1, "nothing claimed");
            await clean();
        }

        console.log("[OK] commands, look-alikes, stale button and the persisted wizard are routed correctly.");
    } finally {
        fs.writeFileSync(configPath, originalConfigFile); // updateConfig writes config.json
        await User.deleteOne({ userId: String(adminId) });
        await User.deleteOne({ userId: String(userId) });
        await Post.deleteMany({ userId: String(userId) });
        await Draft.deleteMany({ userId: String(userId) });
        const captureSenders = Array.from({ length: 19 }, (_, i) => String(senderBase + i));
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
