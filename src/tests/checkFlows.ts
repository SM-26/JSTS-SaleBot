import assert from "assert";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Draft from "../models/Draft";
import Listing from "../models/Listing";
import { createHarness, BOT_USERNAME, RecordedCall, HarnessOptions } from "./harness";
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
    const { default: listingRepository } = await import("../repositories/listingRepository");

    const MOD_GROUP = -1001000000001;
    const APPROVED_GROUP = -1001000000002;
    const base = 7_200_000_000 + (Date.now() % 100_000_000) * 10;
    let counter = 0;
    const newId = () => base + counter++;

    const boot = (options: HarnessOptions = {}) => {
        const h = createHarness(options);
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
            const raw = await Post.collection.findOne({ _id: post._id });
            assert.ok(raw && !("descriptionEntities" in raw), "an unformatted description leaves descriptionEntities absent (not [])");
            console.log("  [OK] (a) full wizard ends in a pending post sent to moderation.");
        }

        // (a2) formatting in the description (issue #98): a spoiler lands in the post doc and the moderation message
        {
            const { h } = boot();
            const u = user();
            await h.sendText("/newpost", { userId: u });
            await h.sendText("Bike", { userId: u });
            // "Hi " (3) + fire emoji (2 UTF-16 units) + " " -> "secret" starts at offset 6.
            const spoiler = { type: "spoiler", offset: 6, length: 6 };
            await h.sendText("Hi \u{1F525} secret", { userId: u, entities: [spoiler, { type: "unknown_future_type", offset: 0, length: 2, extra: "x" }] });
            await settle();
            const d1 = (await draftOf(u))!;
            assert.deepStrictEqual(d1.descriptionEntities?.map((e) => ({ type: e.type, offset: e.offset, length: e.length })), [
                spoiler,
                { type: "unknown_future_type", offset: 0, length: 2 },
            ], "the draft keeps the entities");

            // Re-answering without entities clears them.
            await draftRepository.update(String(u), { descriptionEntities: undefined });
            assert.strictEqual((await Draft.collection.findOne({ userId: String(u) }))?.descriptionEntities, undefined, "update(undefined) unsets the field");
            await draftRepository.update(String(u), { descriptionEntities: [spoiler] });

            await h.sendText("1,500", { userId: u });
            await h.sendText("Tel Aviv", { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            for (const id of ["p1", "p2"]) await h.sendPhoto(id, { userId: u });
            h.calls.length = 0;
            await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
            await settle();
            const preview = h.calls.find((c) => c.method === "sendRichMessage")!;
            const blockquote = (c: RecordedCall) => (c.params.rich_message as { blocks: { type: string; blocks?: { text: unknown }[] }[] }).blocks.find((b) => b.type === "blockquote")!;
            const expected = ["Hi \u{1F525} ", { type: "spoiler", text: "secret" }];
            assert.deepStrictEqual(blockquote(preview).blocks![0].text, expected, "the preview renders the spoiler");

            h.calls.length = 0;
            await h.pressButton(keyboard(preview)[0].callback_data, { userId: u, messageId: messageId(preview) });
            await settle();
            const post = await Post.findOne({ userId: String(u) }).lean();
            assert.ok(post, "the post must be saved");
            postIds.push(String(post._id));
            assert.deepStrictEqual(post.descriptionEntities, [spoiler], "the post stores the entities as plain objects");
            const toModeration = h.calls.find((c) => c.method === "sendRichMessage")!;
            assert.strictEqual(Number(toModeration.params.chat_id), MOD_GROUP);
            assert.deepStrictEqual(blockquote(toModeration).blocks![0].text, expected, "moderation gets the spoiler");
            console.log("  [OK] (a2) a formatted description is stored and rendered.");
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
        await User.create({ userId: String(author), firstName: "Author", authLevel: 0, preferredLocale: "en" });
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
            assert.strictEqual(sent.length, 1, "one prompt message carrying the preset buttons");
            assert.strictEqual(text(sent[0]), T("rejectReasonPrompt"));
            assert.deepStrictEqual(keyboard(sent[0]).map((b) => b.callback_data), [1, 2, 3, 4].map((n) => `rr_${postId}_${n}`));
            assert.ok(!keyboard(sent[0]).some((b) => b.callback_data.startsWith("skip_reason_")), "no Skip button any more");
            assert.strictEqual((await Post.findById(postId))!.status, "rejected", "claimed on Reject");
            assert.ok(!one.calls.some((c) => Number(c.params.chat_id) === author && c.method === "sendMessage"), "the author is told only after a reason");

            const two = boot().h; // restart between the prompt and the reply
            await two.sendText("Photos are too dark", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", replyToMessageId: messageId(sent[0]) });
            await settle();
            assert.strictEqual((await Post.findById(postId))!.rejectionReason, "Photos are too dark");
            const told = two.calls.find((c) => c.method === "sendMessage" && Number(c.params.chat_id) === author);
            assert.strictEqual(text(told!), localeService.t("en", "postRejectedWithReason") + "Photos are too dark");
            assert.ok(two.calls.some((c) => c.method === "editMessageReplyMarkup" && Number(c.params.message_id) === messageId(sent[0])), "Skip keyboard removed");

            // the preset buttons are dead now: the notice was already claimed
            two.calls.length = 0;
            await two.pressButton(keyboard(sent[0])[0].callback_data, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: messageId(sent[0]) });
            await settle();
            assert.ok(two.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("adminPostHandled")));
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
            const [prompt] = h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP);
            const skip = prompt; // one message: the prompt, whose id keys the legacy Skip marker
            const skipData = `skip_reason_${mod}_${Date.now()}`; // a Skip button from before the presets

            h.calls.length = 0;
            await h.pressButton(skipData, { userId: otherMod, chatId: MOD_GROUP, chatType: "supergroup", messageId: messageId(skip) });
            await settle();
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("notYourButton")));
            assert.ok(!h.calls.some((c) => c.method === "sendMessage" || c.method === "editMessageReplyMarkup"), "a foreign press does nothing else");

            h.calls.length = 0;
            await h.pressButton(skipData, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: messageId(skip) });
            await settle();
            const told = h.calls.find((c) => c.method === "sendMessage" && Number(c.params.chat_id) === author);
            assert.strictEqual(text(told!), localeService.t("en", "postRejected"));
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

        // (l) /myposts cards keep their message (issue #99); only the summary's clear_* buttons refresh the summary
        {
            const { h } = boot();
            const u = user();
            await h.sendText("hi", { userId: u }); // creates the user record
            const seedApproved = async (title: string, status: "approved" | "sold", media: { type: "photo"; fileId: string }[] = []) => {
                const post = await Post.create({ userId: String(u), title, description: "d", price: "10", location: "l", media, status });
                postIds.push(String(post._id));
                return String(post._id);
            };
            const soldId = await seedApproved("Card", "approved", [{ type: "photo", fileId: "f1" }]);
            const bumpId = await seedApproved("Card2", "approved");
            await seedApproved("Old", "sold");
            const edits = () => h.calls.filter((c) => c.method === "editMessageText");

            h.calls.length = 0;
            await h.pressButton(`sold_${soldId}`, { userId: u, messageId: 501 });
            await settle();
            assert.strictEqual(edits().length, 1, "Mark sold edits exactly one message");
            assert.strictEqual(Number(edits()[0].params.message_id), 501, "the pressed card itself is edited");
            const body = JSON.stringify(edits()[0].params.rich_message);
            assert.ok(body.includes(T("soldTag")) && body.includes("strikethrough") && body.includes("f1"), "sold footer, struck title and photo kept");
            assert.ok(!edits()[0].params.text, "a rich edit, not the summary text");
            const markup = edits()[0].params.reply_markup as Keyboard | undefined;
            assert.ok(!markup || markup.inline_keyboard.flat().length === 0, "no buttons on the sold card");

            h.calls.length = 0;
            await h.pressButton(`bump_${bumpId}`, { userId: u, messageId: 502 });
            await settle();
            assert.strictEqual(edits().length, 0, "Bump leaves the card alone");
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery"), "Bump still answers with a popup");

            h.calls.length = 0;
            await h.pressButton("clear_sold", { userId: u, messageId: 500 });
            await settle();
            assert.strictEqual(edits().length, 1, "clear_sold still refreshes the summary");
            assert.strictEqual(Number(edits()[0].params.message_id), 500);
            assert.ok(text(edits()[0]).startsWith(T("myPostsTitle")), "the summary text");
            console.log("  [OK] (l) a sold card is re-rendered in place, bump leaves it, clear_sold refreshes the summary.");
        }

        // (m) a moderator approval publishes the post and creates the bot listing
        {
            const { h } = boot();
            const seller = user();
            await User.create({ userId: String(seller), firstName: "Seller", authLevel: 0 });
            const postId = await seedPost(seller, "Approve me");
            const before = Date.now(); // the post's createdAt is earlier than the approval
            await sleep(5);
            h.calls.length = 0;
            await h.pressButton(`approve_${postId}`, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: 310 });
            await settle();
            const after = Date.now();

            const post = (await Post.findById(postId))!;
            assert.strictEqual(post.status, "approved");
            assert.ok(post.approvedMessageId, "approvedMessageId is set");
            const listing = (await Listing.findOne({ source: "bot", postId }))!;
            assert.ok(listing, "a listing exists for the post");
            assert.deepStrictEqual([listing.origin, listing.hold, listing.status, listing.sellerId], ["dm", false, "live", String(seller)]);
            assert.ok(listing.refreshedAt.getTime() > before && listing.refreshedAt.getTime() <= after, "the 30-day clock starts at approval, not at post.createdAt");

            const publishes = h.calls.filter((c) => c.method === "sendRichMessage");
            assert.strictEqual(publishes.length, 1);
            assert.strictEqual(Number(publishes[0].params.chat_id), APPROVED_GROUP);
            const toSeller = h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === seller);
            assert.strictEqual(toSeller.length, 1, "the seller gets one DM");
            assert.strictEqual(text(toSeller[0]), T("postApproved"));
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery" && c.params.text === T("adminApproved")));
            const card = h.calls.find((c) => c.method === "editMessageText" && Number(c.params.message_id) === 310)!;
            assert.strictEqual(text(card), T("statusApproved"));
            assert.deepStrictEqual(keyboard(card), [{ text: T("takeDownButton"), callback_data: `td_${listing._id}` }]);
            console.log("  [OK] (m) approving creates the live bot listing and the card carries Take down.");
        }

        // (n) a listing failure does not stop the author's DM; the card gets no Take down
        {
            const { h } = boot();
            const seller = user();
            await User.create({ userId: String(seller), firstName: "Seller", authLevel: 0 });
            const postId = await seedPost(seller, "Listing fails");
            const realCreate = listingRepository.createForPost;
            listingRepository.createForPost = () => Promise.reject(new Error("boom"));
            try {
                h.calls.length = 0;
                await h.pressButton(`approve_${postId}`, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: 311 });
                await settle();
            } finally {
                listingRepository.createForPost = realCreate;
            }
            assert.strictEqual((await Post.findById(postId))!.status, "approved");
            assert.strictEqual(await Listing.countDocuments({ postId }), 0);
            const toSeller = h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === seller);
            assert.strictEqual(toSeller.length, 1, "the seller is still told");
            assert.strictEqual(text(toSeller[0]), T("postApproved"));
            const card = h.calls.find((c) => c.method === "editMessageText" && Number(c.params.message_id) === 311)!;
            assert.strictEqual(text(card), T("statusApproved"));
            assert.ok(!card.params.reply_markup, "no Take down without a listing");
            console.log("  [OK] (n) a failed listing still tells the author and leaves the card without Take down.");
        }

        // Task 4: submitPost. (p) new seller / (q) trusted / (q2) publish failure / (q3) pending+rejected / (q4) blocked word.
        // Labels differ from the brief's (n)/(o): (n) already exists above.
        const confirmWizard = async (h: H, u: number, fields: { title?: string; description?: string; price?: string; location?: string } = {}) => {
            const { title = "Bike", description = "Blue mountain bike", price = "1,500", location = "Tel Aviv" } = fields;
            await h.sendText("/newpost", { userId: u });
            await h.sendText(title, { userId: u });
            await h.sendText(description, { userId: u });
            await h.sendText(price, { userId: u });
            await h.sendText(location, { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            for (let i = 0; i < 2; i++) await h.sendPhoto(`file${i}`, { userId: u });
            h.calls.length = 0;
            await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
            await settle();
            const preview = h.calls.find((c) => c.method === "sendRichMessage")!;
            h.calls.length = 0;
            await h.pressButton(keyboard(preview)[0].callback_data, { userId: u, messageId: messageId(preview) });
            await settle();
            const post = (await Post.findOne({ userId: String(u), title }))!;
            postIds.push(String(post._id));
            return post;
        };
        const richTo = (h: H, chat: number) => h.calls.filter((c) => c.method === "sendRichMessage" && Number(c.params.chat_id) === chat);
        const seedPostFor = async (u: number, status: "approved" | "rejected" | "pending") => {
            const p = await Post.create({ userId: String(u), title: "Old", description: "d", price: "10", location: "l", media: [], status });
            postIds.push(String(p._id));
        };
        const isModCard = (c: RecordedCall, id: string) =>
            JSON.stringify(keyboard(c).map((b) => b.callback_data)) === JSON.stringify([`approve_${id}`, `reject_${id}`]);
        const toAuthor = (h: H, u: number) => h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === u).map(text);

        // (p)
        {
            const { h } = boot();
            const u = user();
            const post = await confirmWizard(h, u);
            const cards = richTo(h, MOD_GROUP);
            assert.strictEqual(cards.length, 1);
            assert.ok(isModCard(cards[0], String(post._id)));
            assert.strictEqual(richTo(h, APPROVED_GROUP).length, 0);
            assert.strictEqual(post.status, "pending");
            assert.strictEqual(await Listing.countDocuments({ postId: String(post._id) }), 0);
            assert.ok(toAuthor(h, u).includes(T("postCreated")));
            console.log("  [OK] (p) a new seller's post goes to the moderation card.");
        }

        // (q)
        {
            const { h } = boot();
            const u = user();
            await seedPostFor(u, "approved");
            const post = await confirmWizard(h, u);
            assert.strictEqual(post.status, "approved");
            assert.ok(post.approvedMessageId);
            assert.strictEqual(richTo(h, APPROVED_GROUP).length, 1);
            const listing = (await Listing.findOne({ postId: String(post._id) }))!;
            assert.ok(listing && listing.origin === "dm" && listing.status === "live");
            assert.ok(toAuthor(h, u).includes(T("postApproved")));
            assert.ok(!toAuthor(h, u).includes(T("postCreated")));
            const cards = richTo(h, MOD_GROUP);
            assert.strictEqual(cards.length, 1);
            assert.ok(JSON.stringify(cards[0].params.rich_message).includes(T("trustedPublishedLabel")));
            const kb = keyboard(cards[0]);
            assert.strictEqual(kb.length, 1);
            assert.ok(/^td_[0-9a-f]{24}$/.test(kb[0].callback_data));
            assert.strictEqual(kb[0].callback_data, `td_${listing._id}`);
            assert.strictEqual(kb[0].text, T("takeDownButton"));
            assert.strictEqual(post.moderationMessageId, messageId(cards[0]));
            console.log("  [OK] (q) a trusted seller publishes at once; the review card carries Take down.");
        }

        // (q2)
        {
            let n = 5000;
            const { h } = boot({ responses: {
                sendRichMessage: (p: Record<string, unknown>) => Number(p.chat_id) === APPROVED_GROUP
                    ? { ok: false, error_code: 500, description: "boom" }
                    : { message_id: n++, chat: { id: Number(p.chat_id), type: "private" }, date: 1 },
            } });
            const u = user();
            await seedPostFor(u, "approved");
            const post = await confirmWizard(h, u);
            assert.strictEqual(post.status, "pending");
            assert.ok(!post.approvedMessageId);
            const cards = richTo(h, MOD_GROUP);
            assert.strictEqual(cards.length, 1);
            assert.ok(isModCard(cards[0], String(post._id)));
            assert.ok(toAuthor(h, u).includes(T("postCreated")));
            assert.ok(!toAuthor(h, u).includes(T("postApproved")));
            assert.strictEqual(await Listing.countDocuments({ postId: String(post._id) }), 0);
            console.log("  [OK] (q2) a failed publish falls back to the moderation card.");
        }

        // (q3)
        {
            const { h } = boot();
            const u = user();
            await seedPostFor(u, "rejected");
            await seedPostFor(u, "pending");
            const post = await confirmWizard(h, u);
            assert.strictEqual(post.status, "pending");
            assert.ok(isModCard(richTo(h, MOD_GROUP)[0], String(post._id)));
            console.log("  [OK] (q3) pending and rejected posts don't make a seller trusted.");
        }

        // (q4) Decision 7: a blocked word in any saved field keeps even a trusted seller in moderation.
        {
            const { findBlockedWord } = await import("../services/blockedWords");
            const bad = "https://t.me/vipemployment_bot";
            assert.ok(findBlockedWord(bad), "the probe must be on the blocklist");
            const wasValidate = cfg.validatePrice;
            cfg.validatePrice = false; // so the price field can carry the probe
            try {
                for (const field of ["title", "description", "price", "location"] as const) {
                    const { h } = boot();
                    const u = user();
                    await seedPostFor(u, "approved");
                    const post = await confirmWizard(h, u, { [field]: `x ${bad}` });
                    assert.strictEqual(post.status, "pending", field);
                    assert.strictEqual(richTo(h, APPROVED_GROUP).length, 0, field);
                    assert.ok(isModCard(richTo(h, MOD_GROUP)[0], String(post._id)), field);
                }
            } finally {
                cfg.validatePrice = wasValidate;
            }
            console.log("  [OK] (q4) a blocked word in any field keeps a trusted seller in moderation.");
        }

        // (q5) setApprovedMessageId rejects after the group message exists: the post stays approved, never a second card.
        {
            const { default: postRepository } = await import("../repositories/postRepository");
            const real = postRepository.setApprovedMessageId;
            let failed = 0;
            postRepository.setApprovedMessageId = ((...args: Parameters<typeof real>) => {
                if (failed++ === 0) return Promise.reject(new Error("db blip"));
                return real.apply(postRepository, args);
            }) as typeof real;
            try {
                const { h } = boot();
                const u = user();
                await seedPostFor(u, "approved");
                const post = await confirmWizard(h, u);
                assert.strictEqual(post.status, "approved");
                assert.strictEqual(richTo(h, APPROVED_GROUP).length, 1, "exactly one public message");
                assert.ok(!richTo(h, MOD_GROUP).some((c) => keyboard(c).some((b) => /^(approve|reject)_/.test(b.callback_data))), "no approve/reject card");
                assert.ok(toAuthor(h, u).includes(T("postApproved")));
                assert.ok(!toAuthor(h, u).includes(T("postCreated")));
            } finally {
                postRepository.setApprovedMessageId = real;
            }
            console.log("  [OK] (q5) a failure after the group message keeps the post approved.");
        }

        // Task 5: moderator take-down (td_). Labels (r)..(r8) stand for the brief's (p)..(p8): (p)..(q5) are taken above.
        const tdPress = (h: H, who: number, listingId: string, cardId: number) =>
            h.pressButton(`td_${listingId}`, { userId: who, chatId: MOD_GROUP, chatType: "supergroup", messageId: cardId });
        const answers = (h: H) => h.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.params.text));
        const deletes = (h: H) => h.calls.filter((c) => c.method === "deleteMessage");
        const publishTrusted = async (h: H, title = "Bike") => {
            const u = user();
            await seedPostFor(u, "approved");
            const post = await confirmWizard(h, u, { title });
            const listing = (await Listing.findOne({ postId: String(post._id) }))!;
            const cardId = messageId(richTo(h, MOD_GROUP)[0]);
            return { u, post, listing, cardId, listingId: String(listing._id) };
        };

        // (r) + (r2) + (r5) + (r4): one published post, taken down, pressed again, bumped and sold, resubmitted
        {
            const { h } = boot();
            const { u, post, cardId, listingId } = await publishTrusted(h);
            const oldMessageId = post.approvedMessageId!;
            assert.ok(oldMessageId);
            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            const after = (await Listing.findById(listingId))!;
            assert.strictEqual(after.status, "taken_down");
            assert.strictEqual(after.endedBy, "moderator");
            const del = deletes(h);
            assert.strictEqual(del.length, 1);
            assert.strictEqual(Number(del[0].params.chat_id), APPROVED_GROUP);
            assert.strictEqual(Number(del[0].params.message_id), oldMessageId);
            const reloaded = (await Post.findById(post._id))!;
            assert.strictEqual(reloaded.status, "approved");
            assert.strictEqual(reloaded.approvedMessageId ?? null, null);
            assert.deepStrictEqual(toAuthor(h, u), [T("takeDownNotice").replace("{title}", "Bike")]);
            assert.deepStrictEqual(answers(h), [T("takeDownDone")]);
            const edit = h.calls.find((c) => c.method === "editMessageText" && Number(c.params.message_id) === cardId)!;
            assert.strictEqual(text(edit), T("statusTakenDown"));
            assert.ok(!(edit.params.reply_markup as Keyboard | undefined)?.inline_keyboard.length, "the button is gone");
            console.log("  [OK] (r) a moderator takes a post down: group message deleted, seller told, card closed.");

            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            assert.deepStrictEqual(answers(h), [T("takeDownAlready")]);
            assert.strictEqual(deletes(h).length, 0);
            assert.deepStrictEqual(toAuthor(h, u), []);
            console.log("  [OK] (r2) a second press says already, with no second delete or DM.");

            for (const data of [`bump_${post._id}`, `sold_${post._id}`]) {
                h.calls.length = 0;
                await h.pressButton(data, { userId: u, messageId: 900 });
                await settle();
                assert.deepStrictEqual(answers(h), [T("postTakenDown")], data);
                assert.strictEqual(richTo(h, APPROVED_GROUP).length, 0, data);
                const p = (await Post.findById(post._id))!;
                assert.strictEqual(p.status, "approved", data);
                assert.strictEqual(p.approvedMessageId ?? null, null, data);
            }
            console.log("  [OK] (r5) the seller's Bump and Sold are refused on a taken-down post.");

            h.calls.length = 0;
            const next = await confirmWizard(h, u, { title: "Bike2" });
            assert.strictEqual(next.status, "pending");
            assert.strictEqual(richTo(h, APPROVED_GROUP).length, 0);
            assert.ok(isModCard(richTo(h, MOD_GROUP)[0], String(next._id)));
            console.log("  [OK] (r4) a taken-down seller is no longer trusted.");
        }

        // (r3) a plain user and the seller cannot take down
        {
            const { h } = boot();
            const { u, listingId, cardId } = await publishTrusted(h);
            const stranger = user();
            for (const who of [stranger, u]) {
                h.calls.length = 0;
                await tdPress(h, who, listingId, cardId);
                await settle();
                assert.deepStrictEqual(answers(h), [T("notAdmin")]);
                assert.strictEqual((await Listing.findById(listingId))!.status, "live");
                assert.strictEqual(deletes(h).length, 0);
                assert.deepStrictEqual(toAuthor(h, u), []);
            }
            console.log("  [OK] (r3) td_ from a non-moderator is refused and changes nothing.");
        }

        // (r6) the group message is already gone
        {
            const { h } = boot({ responses: { deleteMessage: { ok: false, error_code: 400, description: "Bad Request: message to delete not found" } } });
            const { u, listingId, cardId } = await publishTrusted(h);
            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            assert.strictEqual((await Listing.findById(listingId))!.status, "taken_down");
            assert.deepStrictEqual(answers(h), [T("takeDownDone")]);
            assert.strictEqual(toAuthor(h, u).length, 1);
            console.log("  [OK] (r6) a group message already gone still counts as taken down.");
        }

        // (r7) the seller blocked the bot
        {
            let block = false;
            let n = 6000;
            const { h } = boot({ responses: {
                sendMessage: (p: Record<string, unknown>) => block && Number(p.chat_id) !== MOD_GROUP
                    ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }
                    : { message_id: n++, chat: { id: Number(p.chat_id), type: "private" }, date: 1 },
            } });
            const { listingId, cardId } = await publishTrusted(h);
            block = true;
            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            assert.strictEqual((await Listing.findById(listingId))!.status, "taken_down");
            assert.strictEqual(deletes(h).length, 1);
            assert.deepStrictEqual(answers(h), [T("takeDownDone")]);
            console.log("  [OK] (r7) a seller who blocked the bot does not stop the take-down.");
        }

        // (r8) a sold listing cannot be taken down
        {
            const { h } = boot();
            const { listingId, cardId } = await publishTrusted(h);
            await listingRepository.markSold(listingId, new Date());
            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            assert.deepStrictEqual(answers(h), [T("takeDownAlready")]);
            assert.strictEqual((await Listing.findById(listingId))!.status, "sold");
            assert.strictEqual(deletes(h).length, 0);
            console.log("  [OK] (r8) td_ on a sold listing says already and changes nothing.");
        }

        // (r9) the toast fails: the delete, the post update, the DM and the card edit still happen
        {
            let failAnswers = false;
            const { h } = boot({ responses: {
                answerCallbackQuery: () => failAnswers ? { ok: false, error_code: 400, description: "Bad Request: query is too old" } : true,
            } });
            const { u, post, cardId, listingId } = await publishTrusted(h);
            failAnswers = true;
            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            assert.strictEqual((await Listing.findById(listingId))!.status, "taken_down");
            const del = deletes(h);
            assert.strictEqual(del.length, 1);
            assert.strictEqual(Number(del[0].params.message_id), post.approvedMessageId);
            assert.strictEqual(((await Post.findById(post._id))!).approvedMessageId ?? null, null);
            assert.strictEqual(toAuthor(h, u).length, 1);
            assert.ok(h.calls.some((c) => c.method === "editMessageText" && Number(c.params.message_id) === cardId && text(c) === T("statusTakenDown")));
            console.log("  [OK] (r9) a failing toast does not skip the delete, the DM or the card edit.");
        }

        // (r10) the post lookup throws: the listing is not stranded silently, the DM and card edit still happen
        {
            const { default: postRepository } = await import("../repositories/postRepository");
            const { h } = boot();
            const { u, cardId, listingId, post } = await publishTrusted(h);
            const real = postRepository.findById;
            postRepository.findById = (() => Promise.reject(new Error("db blip"))) as unknown as typeof real;
            const logged: string[] = [];
            const realErr = console.error;
            console.error = (...args: unknown[]) => { logged.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); };
            try {
                h.calls.length = 0;
                await tdPress(h, mod, listingId, cardId);
                await settle();
            } finally {
                postRepository.findById = real;
                console.error = realErr;
            }
            assert.strictEqual((await Listing.findById(listingId))!.status, "taken_down");
            assert.deepStrictEqual(answers(h), [T("takeDownDone")]);
            assert.strictEqual(deletes(h).length, 0);
            assert.strictEqual(toAuthor(h, u).length, 1);
            assert.ok(h.calls.some((c) => c.method === "editMessageText" && Number(c.params.message_id) === cardId));
            assert.ok(logged.some((l) => l.includes("load post failed") && l.includes(listingId) && l.includes(String(post._id))), "the log carries the ids");
            console.log("  [OK] (r10) a failing post lookup is logged with the ids and the other effects still run.");
        }

        // (r11) a group listing: the member's message is never touched
        {
            const { h } = boot();
            const seller = user();
            await User.create({ userId: String(seller), firstName: "Member", authLevel: 0 });
            const now = new Date();
            const listing = await Listing.create({
                source: "group", origin: "capture", chatId: APPROVED_GROUP, messageIds: [555], sellerId: String(seller),
                title: "Radio", media: [], status: "live", hold: false, isBundle: false, createdAt: now, refreshedAt: now,
            });
            h.calls.length = 0;
            await tdPress(h, mod, String(listing._id), 321);
            await settle();
            assert.strictEqual((await Listing.findById(listing._id))!.status, "taken_down");
            assert.deepStrictEqual(answers(h), [T("takeDownDone")]);
            assert.strictEqual(deletes(h).length, 0);
            assert.ok(!h.calls.some((c) => Number(c.params.chat_id) === APPROVED_GROUP), "nothing sent to the member's chat");
            assert.strictEqual(toAuthor(h, seller).length, 1);
            console.log("  [OK] (r11) a group listing is taken down without touching the member's message.");
        }

        // (r12) a malformed id answers "already" without throwing
        {
            const { h } = boot();
            for (const data of ["td_nothex", "td_"]) {
                h.calls.length = 0;
                await h.pressButton(data, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: 322 });
                await settle();
                assert.deepStrictEqual(answers(h), [T("takeDownAlready")], data);
            }
            console.log("  [OK] (r12) a malformed td_ id answers already.");
        }

        // (r13) an expired listing can be taken down
        {
            const { h } = boot();
            const { post, cardId, listingId } = await publishTrusted(h);
            await Listing.updateOne({ _id: listingId }, { $set: { status: "expired" } });
            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            const after = (await Listing.findById(listingId))!;
            assert.strictEqual(after.status, "taken_down");
            assert.strictEqual(after.endedBy, "moderator");
            assert.strictEqual(deletes(h).length, 1);
            assert.strictEqual(((await Post.findById(post._id))!).approvedMessageId ?? null, null);
            console.log("  [OK] (r13) an expired listing can be taken down.");
        }

        // Task 6: reject presets. Labels (s)..(s7) stand for the brief's (q)..(q7): (q)..(q5) are taken above.
        const TEN = (key: string) => localeService.t("en", key);
        const rrPress = (h: H, who: number, data: string, messageId = 400) =>
            h.pressButton(data, { userId: who, chatId: MOD_GROUP, chatType: "supergroup", messageId });
        const toAuthorDMs = (h: H) => h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === author);
        const promptOf = async (h: H, postId: string, who = mod) => {
            h.calls.length = 0;
            await rejectButton(h, who, postId);
            await settle();
            const [p] = h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP);
            h.calls.length = 0;
            return p;
        };

        // (s) a preset reason, with the author's buttons
        {
            const { h } = boot();
            const postId = await seedPost(author, "Preset me");
            const prompt = await promptOf(h, postId);
            await rrPress(h, mod, `rr_${postId}_2`, messageId(prompt));
            await settle();
            const post = (await Post.findById(postId))!;
            assert.strictEqual(post.status, "rejected");
            assert.strictEqual(post.rejectionReason, T("rejectPreset2"));
            assert.ok(post.rejectionNotifiedAt);
            const dms = toAuthorDMs(h);
            assert.strictEqual(dms.length, 1);
            assert.strictEqual(text(dms[0]), TEN("postRejectedWithReason") + TEN("rejectPreset2"));
            type UrlKeyboard = { inline_keyboard: { text: string; url?: string }[][] };
            const rows = (c: RecordedCall) => (c.params.reply_markup as UrlKeyboard).inline_keyboard;
            assert.deepStrictEqual(rows(dms[0]), [[{ text: TEN("rejectFixButton"), url: `https://t.me/${BOT_USERNAME}?start=sell` }]]);
            const edit = h.calls.find((c) => c.method === "editMessageText" && Number(c.params.message_id) === messageId(prompt))!;
            assert.ok(text(edit).includes(T("statusRejected")) && text(edit).includes(T("rejectPreset2")), text(edit));
            assert.deepStrictEqual(answers(h), [T("adminRejected")]);
            assert.strictEqual(localeService.t("he", "rejectPreset2"), "תיאור ו\\או תמונות לא ברורות");

            // the rules button appears only with a rulesUrl
            const rules = "https://t.me/airsoft_yad2/54833/115880";
            cfg.rulesUrl = rules;
            try {
                const p2 = await seedPost(author, "Preset rules");
                const prompt2 = await promptOf(h, p2);
                await rrPress(h, mod, `rr_${p2}_1`, messageId(prompt2));
                await settle();
                assert.deepStrictEqual(rows(toAuthorDMs(h)[0]), [
                    [{ text: TEN("rejectFixButton"), url: `https://t.me/${BOT_USERNAME}?start=sell` }],
                    [{ text: TEN("rejectRulesButton"), url: rules }],
                ]);
            } finally {
                cfg.rulesUrl = original.rulesUrl;
            }
            console.log("  [OK] (s) a preset rejects with the reason, one author DM with Fix and (if set) Rules buttons.");
        }

        // (s2) a typed reply after another moderator's preset won
        {
            const { h } = boot();
            const postId = await seedPost(author, "Race typed");
            const prompt = await promptOf(h, postId);
            await rrPress(h, otherMod, `rr_${postId}_1`, messageId(prompt));
            await settle();
            h.calls.length = 0;
            await h.sendText("too late", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", replyToMessageId: messageId(prompt) });
            await settle();
            assert.strictEqual(toAuthorDMs(h).length, 0, "the author is not told twice");
            assert.ok(h.calls.some((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP && text(c) === T("adminPostHandled")));
            assert.strictEqual((await Post.findById(postId))!.rejectionReason, T("rejectPreset1"));
            console.log("  [OK] (s2) a typed reply after someone else's preset is told the post is handled.");
        }

        // (s3) two moderators, two presets
        {
            const { h } = boot();
            const postId = await seedPost(author, "Race presets");
            const prompt = await promptOf(h, postId);
            await Promise.all([
                rrPress(h, mod, `rr_${postId}_1`, messageId(prompt)),
                rrPress(h, otherMod, `rr_${postId}_3`, messageId(prompt)),
            ]);
            await settle();
            const dms = toAuthorDMs(h);
            assert.strictEqual(dms.length, 1);
            const stored = (await Post.findById(postId))!.rejectionReason!;
            assert.ok([T("rejectPreset1"), T("rejectPreset3")].includes(stored));
            const n = stored === T("rejectPreset1") ? 1 : 3;
            assert.strictEqual(text(dms[0]), TEN("postRejectedWithReason") + TEN(`rejectPreset${n}`));
            assert.deepStrictEqual(answers(h).sort(), [T("adminPostHandled"), T("adminRejected")].sort());
            console.log("  [OK] (s3) two presets at once: one DM, one winner.");
        }

        // (s4) a non-moderator cannot press a preset
        {
            const { h } = boot();
            const postId = await seedPost(author, "Not a mod");
            const prompt = await promptOf(h, postId);
            const plain = user();
            await User.create({ userId: String(plain), firstName: "Plain", authLevel: 0 });
            await rrPress(h, plain, `rr_${postId}_1`, messageId(prompt));
            await settle();
            assert.deepStrictEqual(answers(h), [T("notAdmin")]);
            assert.strictEqual(toAuthorDMs(h).length, 0);
            assert.ok(!(await Post.findById(postId))!.rejectionNotifiedAt);
            await rrPress(h, mod, `rr_${postId}_1`, messageId(prompt));
            await settle();
            assert.strictEqual(toAuthorDMs(h).length, 1, "the moderator still wins afterwards");
            console.log("  [OK] (s4) rr_ from a non-moderator is refused.");
        }

        // (s5) a bad preset number
        {
            const { h } = boot();
            const postId = await seedPost(author, "Bad n");
            const prompt = await promptOf(h, postId);
            for (const n of [9, 0]) await rrPress(h, mod, `rr_${postId}_${n}`, messageId(prompt));
            await settle();
            assert.deepStrictEqual(answers(h), [T("staleButton"), T("staleButton")]);
            assert.strictEqual(toAuthorDMs(h).length, 0);
            assert.ok(!(await Post.findById(postId))!.rejectionNotifiedAt);
            console.log("  [OK] (s5) rr_ with a bad number is stale.");
        }

        // (s6) the seller blocked the bot
        {
            const { h } = boot({ responses: {
                sendMessage: (p: Record<string, unknown>) => Number(p.chat_id) === author
                    ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }
                    : { message_id: 9000 + Math.floor(Math.random() * 1000), chat: { id: Number(p.chat_id), type: "private" }, date: 1 },
            } });
            const postId = await seedPost(author, "Blocked");
            const prompt = await promptOf(h, postId);
            await rrPress(h, mod, `rr_${postId}_1`, messageId(prompt));
            await settle();
            assert.ok((await Post.findById(postId))!.rejectionNotifiedAt);
            const edit = h.calls.find((c) => c.method === "editMessageText" && Number(c.params.message_id) === messageId(prompt))!;
            assert.ok(text(edit).includes(T("authorNotNotified")), text(edit));
            assert.deepStrictEqual(answers(h), [T("adminRejected")]);
            console.log("  [OK] (s6) a blocked seller is flagged on the prompt; the rejection stands.");
        }

        // (s7) /start sell opens the wizard
        {
            const { h } = boot();
            const u = user();
            h.calls.length = 0;
            await h.sendText("/start sell", { userId: u });
            await settle();
            assert.ok(text(h.calls.find((c) => c.method === "sendMessage")!).startsWith(T("welcome")));
            assert.strictEqual((await draftOf(u))!.step, "title");
            const v = user();
            h.calls.length = 0;
            await h.sendText("/start", { userId: v });
            await settle();
            assert.strictEqual(text(h.calls.find((c) => c.method === "sendMessage")!), T("greeting"));
            assert.strictEqual(await draftOf(v), null);
            console.log("  [OK] (s7) /start sell opens the wizard; plain /start greets.");
        }

        console.log("[OK] persistent flows.");
    } finally {
        Object.assign(cfg, original);
        const ids = userIds.map(String);
        await User.deleteMany({ userId: { $in: ids } });
        await Post.deleteMany({ $or: [{ userId: { $in: ids } }, { _id: { $in: postIds } }] });
        await Draft.deleteMany({ userId: { $in: ids } });
        await Listing.deleteMany({ sellerId: { $in: ids } });
        await mongoose.connection.db!.collection<{ _id: string }>("bot_sessions").deleteMany({ _id: { $regex: `:(${ids.join("|")})$` } });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkFlows failed:", err);
    process.exit(1);
});
