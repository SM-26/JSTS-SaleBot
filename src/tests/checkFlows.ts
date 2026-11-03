import assert from "assert";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Draft from "../models/Draft";
import { createHarness, BOT_USERNAME, RecordedCall } from "./harness";
import type { BotConfig } from "../types";

// Persistent flows (issue #84, phase 5): the /newpost wizard, the reject-reason
// prompt and the custom donation amount all live in Mongo, so each flow is
// driven across a "restart" (a brand-new harness + BotController, same DB).
// Needs Mongo; set MONGO_URI to run it.
const MONGO_URI = process.env.MONGO_URI;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Fire-and-forget API calls inside handlers land a tick after the chain returns.
const settle = () => sleep(40);

type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
const text = (c: RecordedCall) => String(c.params.text);
const keyboard = (c: RecordedCall) => (c.params.reply_markup as Keyboard).inline_keyboard.flat();
const messageId = (c: RecordedCall) => (c.result as { message_id: number }).message_id;

async function run() {
    if (!MONGO_URI) {
        console.log("[SKIP] checkFlows: set MONGO_URI to run this test.");
        return;
    }

    console.log("[INFO] Checking persistent flows...");
    await mongoose.connect(MONGO_URI);
    await Draft.init();

    // config.json is read at import time, so load the controller only after the SKIP check.
    const { BotController } = await import("../controllers/botController");
    const { localeService } = await import("../services/localeService");
    const { default: draftRepository } = await import("../repositories/draftRepository");

    const MOD_GROUP = -1001000000001;
    const APPROVED_GROUP = -1001000000002;
    const base = 7_200_000_000 + (Date.now() % 100_000_000) * 10;
    let counter = 0;
    const newId = () => base + counter++;

    const boot = () => {
        const h = createHarness();
        const ctrl = new BotController(h.bot.api);
        ctrl.registerRoutes(h.bot, BOT_USERNAME);
        return { h, ctrl };
    };

    const { ctrl: first } = boot();
    const cfg: BotConfig = first.config;
    const original = { ...cfg };
    Object.assign(cfg, { moderationGroupId: MOD_GROUP, approvedGroupId: APPROVED_GROUP, minimumPhotos: 2, timeOut: 60, validatePrice: true });

    const T = (key: string) => localeService.t(cfg.lang, key);
    const userIds: number[] = [];
    const user = () => { const id = newId(); userIds.push(id); return id; };
    const draftOf = (id: number) => draftRepository.findByUserId(String(id));

    type H = ReturnType<typeof boot>["h"];
    // /newpost + title + description + price + location: ends on the media prompt.
    const toMedia = async (h: H, u: number) => {
        await h.sendText("/newpost", { userId: u });
        await h.sendText("Bike", { userId: u });
        await h.sendText("Blue mountain bike", { userId: u });
        await h.sendText("1,500", { userId: u });
        await h.sendText("Tel Aviv", { userId: u });
        await settle();
    };
    const toConfirm = async (h: H, u: number, photos = 2) => {
        await toMedia(h, u);
        const d = (await draftOf(u))!;
        for (let i = 0; i < photos; i++) await h.sendPhoto(`file${i}`, { userId: u });
        h.calls.length = 0;
        await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
        await settle();
        return h.calls.find((c) => c.method === "sendRichMessage")!;
    };

    const postIds: string[] = [];
    const seedPost = async (authorId: number, title: string) => {
        const post = await Post.create({ userId: String(authorId), title, description: "d", price: "10", location: "l", media: [], status: "pending" });
        postIds.push(String(post._id));
        return String(post._id);
    };
    const rejectButton = (h: H, mod: number, postId: string) =>
        h.pressButton(`reject_${postId}`, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: 300 });

    try {
        // (a) the full wizard
        {
            const { h } = boot();
            const u = user();
            h.calls.length = 0;
            await h.sendText("/newpost", { userId: u });
            await settle();
            assert.ok(text(h.calls.find((c) => c.method === "sendMessage")!).startsWith(T("welcome")), "title prompt");
            assert.strictEqual((await draftOf(u))!.step, "title");

            h.calls.length = 0;
            await h.sendText("Bike", { userId: u });
            await settle();
            assert.ok(text(h.calls.find((c) => c.method === "sendMessage")!).startsWith(T("enterDescription")));
            await h.sendText("Blue mountain bike", { userId: u });
            h.calls.length = 0;
            await h.sendText("abc", { userId: u });
            await settle();
            assert.strictEqual(text(h.calls.find((c) => c.method === "sendMessage")!), T("invalidPrice"));
            assert.strictEqual((await draftOf(u))!.step, "price", "an invalid price stays on the price step");
            await h.sendText("1,500", { userId: u });
            await h.sendText("Tel Aviv", { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            assert.strictEqual(d.step, "media");
            assert.deepStrictEqual([d.title, d.description, d.price, d.location], ["Bike", "Blue mountain bike", "1,500", "Tel Aviv"]);

            for (const id of ["p1", "p2", "p3"]) await h.sendPhoto(id, { userId: u });
            assert.strictEqual((await draftOf(u))!.media.length, 3);

            h.calls.length = 0;
            await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
            await settle();
            const preview = h.calls.find((c) => c.method === "sendRichMessage")!;
            assert.deepStrictEqual(keyboard(preview).map((b) => b.callback_data.split("_")[0]), ["confirm", "cancel"]);
            const confirmData = keyboard(preview)[0].callback_data;
            assert.ok(/^confirm_\d+_\d+$/.test(confirmData), confirmData);
            assert.strictEqual((await draftOf(u))!.step, "confirm");

            h.calls.length = 0;
            await h.pressButton(confirmData, { userId: u, messageId: messageId(preview) });
            await settle();
            const post = await Post.findOne({ userId: String(u) });
            assert.ok(post, "the post must be saved");
            postIds.push(String(post._id));
            assert.strictEqual(post.status, "pending");
            assert.strictEqual(post.media.length, 3);
            const toModeration = h.calls.find((c) => c.method === "sendRichMessage");
            assert.strictEqual(Number(toModeration?.params.chat_id), MOD_GROUP, "sent to the moderation group");
            assert.ok(h.calls.some((c) => c.method === "sendMessage" && text(c) === T("postCreated")));
            assert.strictEqual(await draftOf(u), null, "the draft is deleted after confirm");
            console.log("  [OK] (a) full wizard ends in a pending post sent to moderation.");
        }

        // (b) restart survival after the price step
        {
            const u = user();
            const one = boot().h;
            await one.sendText("/newpost", { userId: u });
            await one.sendText("Skates", { userId: u });
            await one.sendText("Inline skates", { userId: u });
            await one.sendText("200", { userId: u });
            await settle();

            const two = boot().h; // "restart": new harness and controller, same DB
            two.calls.length = 0;
            await two.sendText("Haifa", { userId: u });
            await settle();
            assert.ok(text(two.calls.find((c) => c.method === "sendMessage")!).startsWith(T("enterMedia")), "continues at the media prompt");
            await two.sendPhoto("a", { userId: u });
            await two.sendPhoto("b", { userId: u });
            const d = (await draftOf(u))!;
            two.calls.length = 0;
            await two.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
            await settle();
            const preview = two.calls.find((c) => c.method === "sendRichMessage")!;
            two.calls.length = 0;
            await two.pressButton(keyboard(preview)[0].callback_data, { userId: u, messageId: messageId(preview) });
            await settle();
            const post = await Post.findOne({ userId: String(u) });
            assert.ok(post && post.status === "pending" && post.title === "Skates", "the wizard finished after the restart");
            postIds.push(String(post._id));
            assert.ok(two.calls.some((c) => c.method === "sendRichMessage" && Number(c.params.chat_id) === MOD_GROUP));
            console.log("  [OK] (b) a wizard survives a restart.");
        }

        // (c) an album burst
        {
            const { h } = boot();
            const u = user();
            await toMedia(h, u);
            await Promise.all(["m1", "m2", "m3", "m4", "m5"].map((id) => h.sendPhoto(id, { userId: u })));
            const d = (await draftOf(u))!;
            assert.deepStrictEqual(d.media.map((m) => m.fileId).sort(), ["m1", "m2", "m3", "m4", "m5"]);

            // fewer photos than minimumPhotos: v1 ends the wizard with notEnoughMedia
            const v = user();
            await toMedia(h, v);
            await h.sendPhoto("only", { userId: v });
            h.calls.length = 0;
            await h.pressButton(`done_media_${v}`, { userId: v, messageId: (await draftOf(v))!.promptMessageId });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "sendMessage" && text(c) === T("notEnoughMedia")));
            assert.strictEqual(await draftOf(v), null);
            console.log("  [OK] (c) an album burst keeps all 5 photos; too few photos ends the wizard.");
        }

        // (d) expiry against the live timeOut
        {
            const { h } = boot();
            const u = user();
            await toMedia(h, u);
            const hourAgo = (m: number) => new Date(Date.now() - m * 60_000);
            await Draft.updateOne({ userId: String(u) }, { updatedAt: hourAgo(120) });
            h.calls.length = 0;
            await h.sendText("late answer", { userId: u });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "sendMessage" && text(c) === T("draftExpired")));
            assert.strictEqual(await draftOf(u), null, "an expired draft is deleted on a text");

            // a press on an expired draft
            const v = user();
            await toMedia(h, v);
            const d = (await draftOf(v))!;
            await Draft.updateOne({ userId: String(v) }, { updatedAt: hourAgo(120) });
            h.calls.length = 0;
            await h.pressButton(`done_media_${v}`, { userId: v, messageId: d.promptMessageId });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "sendMessage" && text(c) === T("draftExpired")));
            assert.strictEqual(await draftOf(v), null, "an expired draft is deleted on a press");

            // the live config.timeOut decides: 0 never expires, and the sweep follows it
            const w = user();
            await toMedia(h, w);
            await Draft.updateOne({ userId: String(w) }, { updatedAt: hourAgo(60 * 24 * 10) });
            assert.ok(!(await draftRepository.findActiveUserIds(60)).includes(String(w)), "old draft is not active at timeOut 60");
            assert.ok((await draftRepository.findActiveUserIds(0)).includes(String(w)), "timeOut 0: always active");
            assert.strictEqual(await draftRepository.deleteExpired(0), 0, "timeOut 0: the sweep deletes nothing");
            cfg.timeOut = 0;
            await h.sendPhoto("x", { userId: w });
            assert.strictEqual((await draftOf(w))!.media.length, 1, "timeOut 0 never expires");
            cfg.timeOut = 60;
            await Draft.updateOne({ userId: String(w) }, { updatedAt: hourAgo(120) });
            assert.ok((await draftRepository.deleteExpired(60)) >= 1, "the startup sweep removes it");
            assert.strictEqual(await draftOf(w), null);
            console.log("  [OK] (d) expiry follows the live timeOut; 0 never expires; the sweep works.");
        }

        // (e) /newpost with a live draft, and both buttons
        {
            const { h } = boot();
            const u = user();
            await h.sendText("/newpost", { userId: u });
            await h.sendText("Car", { userId: u });
            h.calls.length = 0;
            await h.sendText("/newpost", { userId: u });
            await settle();
            const question = h.calls.find((c) => c.method === "sendMessage")!;
            assert.strictEqual(text(question), T("draftInProgress"));
            assert.deepStrictEqual(keyboard(question).map((b) => b.callback_data), [`draft_continue_${u}`, `draft_restart_${u}`]);
            assert.strictEqual((await draftOf(u))!.promptMessageId, messageId(question));

            h.calls.length = 0;
            await h.pressButton(`draft_continue_${u}`, { userId: u, messageId: 999_999 });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("staleButton")), "a draft button on another message is stale");

            h.calls.length = 0;
            await h.pressButton(`draft_continue_${u}`, { userId: u, messageId: messageId(question) });
            await settle();
            const resent = h.calls.find((c) => c.method === "sendMessage")!;
            assert.ok(text(resent).startsWith(T("enterDescription")), "continue re-sends the current step's prompt");
            const d = (await draftOf(u))!;
            assert.strictEqual(d.step, "description");
            assert.strictEqual(d.promptMessageId, messageId(resent));

            await h.sendText("/newpost", { userId: u });
            await settle();
            const question2 = h.calls.filter((c) => c.method === "sendMessage" && text(c) === T("draftInProgress")).pop()!;
            h.calls.length = 0;
            await h.pressButton(`draft_restart_${u}`, { userId: u, messageId: messageId(question2) });
            await settle();
            assert.ok(text(h.calls.find((c) => c.method === "sendMessage")!).startsWith(T("welcome")), "start over asks for the title again");
            const fresh = (await draftOf(u))!;
            assert.strictEqual(fresh.step, "title");
            assert.strictEqual(fresh.title, undefined);
            console.log("  [OK] (e) /newpost with a live draft offers Continue / Start over, both work.");
        }

        // (f) Confirm on an old preview is stale
        {
            const { h } = boot();
            const u = user();
            const preview1 = await toConfirm(h, u);
            // /newpost -> Continue re-sends the preview: the first one is now old
            await h.sendText("/newpost", { userId: u });
            await settle();
            const question = h.calls.filter((c) => c.method === "sendMessage" && text(c) === T("draftInProgress")).pop()!;
            h.calls.length = 0;
            await h.pressButton(`draft_continue_${u}`, { userId: u, messageId: messageId(question) });
            await settle();
            const preview2 = h.calls.find((c) => c.method === "sendRichMessage")!;
            assert.notStrictEqual(messageId(preview1), messageId(preview2));

            h.calls.length = 0;
            await h.pressButton(keyboard(preview1)[0].callback_data, { userId: u, messageId: messageId(preview1) });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("staleButton")), "old preview: stale toast");
            assert.ok(h.calls.some((c) => c.method === "editMessageReplyMarkup"), "old preview loses its keyboard");
            assert.strictEqual(await Post.countDocuments({ userId: String(u) }), 0, "nothing was posted");
            assert.strictEqual((await draftOf(u))!.step, "confirm", "the draft is untouched");

            // Cancel on the live preview deletes the draft
            h.calls.length = 0;
            await h.pressButton(keyboard(preview2)[1].callback_data, { userId: u, messageId: messageId(preview2) });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "sendMessage" && text(c) === T("postCancelled")));
            assert.strictEqual(await draftOf(u), null);
            console.log("  [OK] (f) an old preview's buttons are stale; Cancel deletes the draft.");
        }

        // (g) /cancel in a private chat
        {
            const { h } = boot();
            const u = user();
            h.calls.length = 0;
            await h.sendText("/cancel", { userId: u });
            await settle();
            assert.strictEqual(text(h.calls.find((c) => c.method === "sendMessage")!), T("cancelNothing"));
            await h.sendText("/newpost", { userId: u });
            h.calls.length = 0;
            await h.sendText("/cancel", { userId: u });
            await settle();
            assert.strictEqual(text(h.calls.find((c) => c.method === "sendMessage")!), T("cancelDone"));
            assert.strictEqual(await draftOf(u), null);
            console.log("  [OK] (g) /cancel with and without a draft.");
        }

        // seed an author and moderators for the reject flows
        const author = user();
        await User.create({ userId: String(author), firstName: "Author", authLevel: 0 });
        const mod = user();
        await User.create({ userId: String(mod), firstName: "Mod", authLevel: 2 });
        const otherMod = user();
        await User.create({ userId: String(otherMod), firstName: "Mod2", authLevel: 2 });

        // (h) reject with a reason, across a restart
        {
            const one = boot().h;
            const postId = await seedPost(author, "Reject me");
            one.calls.length = 0;
            await rejectButton(one, mod, postId);
            await settle();
            const sent = one.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP);
            assert.strictEqual(sent.length, 2, "the prompt and the Skip message");
            assert.strictEqual(text(sent[0]), T("rejectReasonPrompt"));
            assert.deepStrictEqual(sent[0].params.reply_markup, { force_reply: true, selective: true });
            assert.ok(/^skip_reason_\d+_\d+$/.test(keyboard(sent[1])[0].callback_data));
            assert.strictEqual((await Post.findById(postId))!.status, "rejected", "claimed on Reject");
            assert.ok(!one.calls.some((c) => Number(c.params.chat_id) === author && c.method === "sendMessage"), "the author is told only after a reason");

            const two = boot().h; // restart between the prompt and the reply
            await two.sendText("Photos are too dark", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", replyToMessageId: messageId(sent[0]) });
            await settle();
            assert.strictEqual((await Post.findById(postId))!.rejectionReason, "Photos are too dark");
            const told = two.calls.find((c) => c.method === "sendMessage" && Number(c.params.chat_id) === author);
            assert.strictEqual(text(told!), T("postRejectedWithReason") + "Photos are too dark");
            assert.ok(two.calls.some((c) => c.method === "editMessageReplyMarkup" && Number(c.params.message_id) === messageId(sent[1])), "Skip keyboard removed");

            // the Skip button is dead now
            two.calls.length = 0;
            await two.pressButton(keyboard(sent[1])[0].callback_data, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: messageId(sent[1]) });
            await settle();
            assert.ok(two.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("staleButton")));
            assert.ok(!two.calls.some((c) => Number(c.params.chat_id) === author));
            console.log("  [OK] (h) reject with a reason works across a restart.");
        }

        // (i) reject with Skip; another moderator's Skip press
        {
            const { h } = boot();
            const postId = await seedPost(author, "Skip me");
            h.calls.length = 0;
            await rejectButton(h, mod, postId);
            await settle();
            const [prompt, skip] = h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP);
            const skipData = keyboard(skip)[0].callback_data;

            h.calls.length = 0;
            await h.pressButton(skipData, { userId: otherMod, chatId: MOD_GROUP, chatType: "supergroup", messageId: messageId(skip) });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("notYourButton")));
            assert.ok(!h.calls.some((c) => c.method === "sendMessage" || c.method === "editMessageReplyMarkup"), "a foreign press does nothing else");

            h.calls.length = 0;
            await h.pressButton(skipData, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: messageId(skip) });
            await settle();
            const told = h.calls.find((c) => c.method === "sendMessage" && Number(c.params.chat_id) === author);
            assert.strictEqual(text(told!), T("postRejected"));
            assert.ok(h.calls.some((c) => c.method === "editMessageReplyMarkup" && Number(c.params.message_id) === messageId(skip)));
            assert.strictEqual((await Post.findById(postId))!.rejectionReason ?? null, null);

            // once: a second press is stale, and the prompt's reply marker is gone
            h.calls.length = 0;
            await h.pressButton(skipData, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: messageId(skip) });
            await h.sendText("late reason", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", replyToMessageId: messageId(prompt) });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("staleButton")));
            assert.ok(!h.calls.some((c) => c.method === "sendMessage"), "nothing more is sent");
            console.log("  [OK] (i) Skip rejects without a reason; another moderator gets notYourButton.");
        }

        // (j) a moderator's non-reply message while a prompt is pending; group /cancel
        {
            const { h } = boot();
            const postId = await seedPost(author, "Hint me");
            await rejectButton(h, mod, postId);
            await settle();

            h.calls.length = 0;
            await h.sendText("hello?", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup" });
            await settle();
            const hint = h.calls.find((c) => c.method === "sendMessage")!;
            assert.strictEqual(text(hint), T("replyToPromptHint"));
            assert.strictEqual(Number(hint.params.chat_id), MOD_GROUP);

            h.calls.length = 0;
            await h.sendText("hello?", { userId: otherMod, chatId: MOD_GROUP, chatType: "supergroup" });
            await settle();
            assert.strictEqual(h.calls.length, 0, "other members get no hint");

            await h.sendText("/cancel", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup" });
            await settle();
            assert.strictEqual(text(h.calls.find((c) => c.method === "sendMessage")!), T("cancelDone"));
            h.calls.length = 0;
            await h.sendText("hello again", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup" });
            await h.sendText("/cancel", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup" });
            await settle();
            const replies = h.calls.filter((c) => c.method === "sendMessage").map(text);
            assert.deepStrictEqual(replies, [T("cancelNothing")], "no hint after /cancel; a second /cancel has nothing to cancel");
            console.log("  [OK] (j) hint for a non-reply; /cancel forgets the pending prompt in a group.");
        }

        // (k) donation "other", restart, then an amount; pre_checkout has no session key
        {
            const u = user();
            const one = boot().h;
            await one.sendText("hi", { userId: u }); // creates the user record
            one.calls.length = 0;
            await one.pressButton("donate_other", { userId: u });
            await settle();
            assert.ok(one.calls.some((c) => c.method === "sendMessage" && text(c) === T("donateEnterAmount")));

            const two = boot().h; // restart
            two.calls.length = 0;
            await two.sendText("75", { userId: u });
            await settle();
            const invoice = two.calls.find((c) => c.method === "sendInvoice");
            assert.ok(invoice, "the amount after a restart sends an invoice");
            assert.strictEqual((invoice.params.prices as { amount: number }[])[0].amount, 75);

            two.calls.length = 0;
            await two.send({ pre_checkout_query: { id: "pcq1", from: { id: u, is_bot: false, first_name: "T" }, currency: "XTR", total_amount: 75, invoice_payload: "x" } });
            await settle();
            assert.ok(two.calls.some((c) => c.method === "answerPreCheckoutQuery"), "an update with no session key still works");
            console.log("  [OK] (k) the donation amount flag survives a restart.");
        }

        console.log("[OK] persistent flows.");
    } finally {
        Object.assign(cfg, original);
        const ids = userIds.map(String);
        await User.deleteMany({ userId: { $in: ids } });
        await Post.deleteMany({ $or: [{ userId: { $in: ids } }, { _id: { $in: postIds } }] });
        await Draft.deleteMany({ userId: { $in: ids } });
        await mongoose.connection.db!.collection<{ _id: string }>("bot_sessions").deleteMany({ _id: { $regex: `:(${ids.join("|")})$` } });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkFlows failed:", err);
    process.exit(1);
});
