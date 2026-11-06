import assert from "assert";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Draft from "../models/Draft";
import Listing from "../models/Listing";
import Capture from "../models/Capture";
import Member from "../models/Member";
import { seedCapture } from "./fixtures";
import { takeDownDeleteChecks } from "./takeDownDeleteChecks";
import { quickListingChecks } from "./quickListingChecks";
import { createHarness, BOT_USERNAME, RecordedCall, HarnessOptions } from "./harness";
import type { BotConfig } from "../types";
import type { CatchupItem } from "../services/catchupScan";

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
    await Capture.init();
    await Listing.init();

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
            assert.strictEqual((await Listing.findOne({ source: "bot", postId: soldId }))?.status, "sold", "sold_ ends the listing, created on demand");

            const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
            await Listing.create({ source: "bot", origin: "dm", postId: bumpId, sellerId: String(u), title: "Card2", status: "live", createdAt: old, refreshedAt: old, nudgedAt: old });
            h.calls.length = 0;
            await h.pressButton(`bump_${bumpId}`, { userId: u, messageId: 502 });
            await settle();
            assert.strictEqual(edits().length, 0, "Bump leaves the card alone");
            assert.ok(h.calls.some((c) => c.method === "answerCallbackQuery"), "Bump still answers with a popup");
            const bumped = (await Listing.collection.findOne({ postId: bumpId }))!;
            assert.ok(Date.now() - bumped.refreshedAt.getTime() < 5000 && !("nudgedAt" in bumped), "bump restarts the listing clock and clears nudgedAt");

            // a bump refused by dailyBumpLimit leaves the listing clock alone
            const limitedId = await seedApproved("Limited", "approved");
            await Post.updateOne({ _id: limitedId }, { $set: { dailyBumpCount: 999, lastBumpAt: new Date() } });
            await Listing.create({ source: "bot", origin: "dm", postId: limitedId, sellerId: String(u), title: "Limited", status: "live", createdAt: old, refreshedAt: old });
            await h.pressButton(`bump_${limitedId}`, { userId: u, messageId: 503 });
            await settle();
            assert.strictEqual((await Listing.findById((await Listing.findOne({ postId: limitedId }))!._id))!.refreshedAt.getTime(), old.getTime(), "a refused bump leaves refreshedAt unchanged");

            // bumping a post whose listing expired relists it
            const expiredId = await seedApproved("Expired", "approved");
            await Listing.create({ source: "bot", origin: "dm", postId: expiredId, sellerId: String(u), title: "Expired", status: "expired", createdAt: old, refreshedAt: old });
            await h.pressButton(`bump_${expiredId}`, { userId: u, messageId: 504 });
            await settle();
            assert.strictEqual((await Listing.findOne({ postId: expiredId }))!.status, "live", "bumping an expired listing makes it live");

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

        // (m2) a meetup post publishes with the meeting-point button and a flagged listing; a plain one has no buttons
        {
            const { h } = boot();
            const seller = user();
            await User.create({ userId: String(seller), firstName: "Seller", authLevel: 0 });
            const meetupId = await seedPost(seller, "Meet me");
            await Post.updateOne({ _id: meetupId }, { $set: { meetup: true } });
            const plainId = await seedPost(seller, "Plain");
            for (const [id, msgId] of [[meetupId, 320], [plainId, 321]] as const) {
                h.calls.length = 0;
                await h.pressButton(`approve_${id}`, { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: msgId });
                await settle();
                const sent = h.calls.find((c) => c.method === "sendRichMessage" && Number(c.params.chat_id) === APPROVED_GROUP)!;
                const listing = (await Listing.findOne({ source: "bot", postId: id }))!;
                assert.ok(!sent.params.reply_markup, "no button under a group post");
                if (id === meetupId) {
                    assert.ok(JSON.stringify(sent.params.rich_message).includes("?start=faq_1"), "the meeting point's words link to faq_1");
                    assert.strictEqual(listing.meetup, true);
                } else {
                    assert.ok(!("meetup" in listing.toObject()), "meetup is never written as false");
                }
            }
            console.log("  [OK] (m2) the meeting-point link and flag follow the post.");
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
        // A draft saved at "confirm" (as before the blocked-word preview gate existed), then its Confirm button.
        const confirmSavedDraft = async (h: H, u: number, fields: { title?: string; description?: string; descriptionEntities?: { type: string; offset: number; length: number; url?: string }[]; price?: string; location?: string } = {}) => {
            const { title = "Bike", description = "Blue mountain bike", descriptionEntities, price = "1,500", location = "Tel Aviv" } = fields;
            const now = new Date();
            const promptMessageId = 9000 + (u % 1000);
            await Draft.create({
                userId: String(u), chatId: u, locale: cfg.lang, step: "confirm", title, description, ...(descriptionEntities ? { descriptionEntities } : {}), price, location,
                media: [{ fileId: "f0", type: "photo" }, { fileId: "f1", type: "photo" }], promptMessageId, startedAt: now, updatedAt: now,
            });
            h.calls.length = 0;
            await h.pressButton(`confirm_${u}_1`, { userId: u, messageId: promptMessageId });
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
        // The wizard stops these at the preview now (Task 7), so the draft is saved straight at "confirm".
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
                    const post = await confirmSavedDraft(h, u, { [field]: `x ${bad}` });
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

        // (tx1)..(tx7): a moderator also deletes the member's original post
        await takeDownDeleteChecks({ boot: (o) => ({ h: boot(o).h }), mod, user, settle, T, answers, toAuthor, tdPress, publishTrusted, richTo, APPROVED_GROUP, MOD_GROUP });

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

        // Task 7: blocked words at the preview. Labels (t)..(t7) stand for the brief's (r)..(r7): (r)..(r8) are taken above.
        const BAD = "מחזיק לנשק";
        const noticeFor = (field: string, word: string) => localeService.t(cfg.lang, "blockedWordNotice", { field: T(field), word });
        // Wizard answers + two photos + Done; leaves h.calls holding what Done caused.
        const toDone = async (h: H, u: number, fields: { title?: string; description?: string; price?: string; location?: string } = {}) => {
            const { title = "Bike", description = "Blue mountain bike", price = "1,500", location = "Tel Aviv" } = fields;
            await h.sendText("/newpost", { userId: u });
            for (const answer of [title, description, price, location]) await h.sendText(answer, { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            for (let i = 0; i < 2; i++) await h.sendPhoto(`file${i}`, { userId: u });
            h.calls.length = 0;
            await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
            await settle();
        };
        const dmTo = (h: H, u: number) => h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === u).map(text);

        // (t) a blocked title stops at the preview
        {
            const { h } = boot();
            const u = user();
            await toDone(h, u, { title: BAD });
            assert.strictEqual(richTo(h, u).length, 0, "no preview");
            const msgs = dmTo(h, u);
            assert.strictEqual(msgs.length, 2, JSON.stringify(msgs));
            assert.strictEqual(msgs[0], noticeFor("fieldTitle", "לנשק"));
            assert.ok(msgs[1].startsWith(T("welcome")), "then the title prompt");
            const d = (await draftOf(u))!;
            assert.strictEqual(d.step, "title");
            assert.strictEqual(d.fixing, true);
            assert.strictEqual(await Post.countDocuments({ userId: String(u) }), 0);
            console.log("  [OK] (t) a blocked title stops at the preview and asks for the title again.");

            // (t2) still blocked
            h.calls.length = 0;
            await h.sendText("נשק למכירה", { userId: u });
            await settle();
            const again = dmTo(h, u);
            assert.strictEqual(again[0], noticeFor("fieldTitle", "נשק"));
            assert.ok(again[1].startsWith(T("welcome")));
            const d2 = (await draftOf(u))!;
            assert.strictEqual(d2.step, "title");
            assert.strictEqual(d2.fixing, true);
            assert.strictEqual(richTo(h, u).length, 0);
            console.log("  [OK] (t2) still-blocked text asks again.");

            // (t7) restart while fixing: Continue re-sends the title prompt, still fixing
            const { h: h2 } = boot();
            await h2.sendText("/newpost", { userId: u });
            await settle();
            assert.ok(dmTo(h2, u).includes(T("draftInProgress")), "Continue / Start over was offered");
            const offered = (await draftOf(u))!;
            h2.calls.length = 0;
            await h2.pressButton(`draft_continue_${u}`, { userId: u, messageId: offered.promptMessageId });
            await settle();
            assert.ok(dmTo(h2, u).some((m) => m.startsWith(T("welcome"))), "the title prompt is re-sent");
            const d7 = (await draftOf(u))!;
            assert.strictEqual(d7.step, "title");
            assert.strictEqual(d7.fixing, true);
            console.log("  [OK] (t7) a restart while fixing keeps the draft on the title, fixing.");

            // (t3) clean text goes straight back to the preview
            h2.calls.length = 0;
            await h2.sendText("מחזיק", { userId: u });
            await settle();
            const preview = richTo(h2, u);
            assert.strictEqual(preview.length, 1, "the preview comes back");
            assert.deepStrictEqual(keyboard(preview[0]).map((b) => b.callback_data.split("_")[0]), ["confirm", "cancel"]);
            const d3 = (await draftOf(u))!;
            assert.strictEqual(d3.step, "confirm");
            assert.strictEqual(d3.fixing, undefined);
            assert.strictEqual(d3.promptMessageId, messageId(preview[0]));
            assert.deepStrictEqual([d3.title, d3.description, d3.price, d3.location], ["מחזיק", "Blue mountain bike", "1,500", "Tel Aviv"]);
            h2.calls.length = 0;
            await h2.pressButton(keyboard(preview[0])[0].callback_data, { userId: u, messageId: messageId(preview[0]) });
            await settle();
            const post = (await Post.findOne({ userId: String(u) }))!;
            postIds.push(String(post._id));
            assert.strictEqual(post.status, "pending");
            assert.strictEqual(post.title, "מחזיק");
            assert.ok(isModCard(richTo(h2, MOD_GROUP)[0], String(post._id)));
            console.log("  [OK] (t3) fixed text returns to the preview; Confirm then creates the post.");
        }

        // (t4) each field stops at the preview and asks for its own step
        {
            const wasValidate = cfg.validatePrice;
            cfg.validatePrice = false; // so the price field can carry a blocked word
            try {
                const cases = [
                    { field: "description", label: "fieldDescription", prompt: "enterDescription" },
                    { field: "price", label: "fieldPrice", prompt: "enterPrice" },
                    { field: "location", label: "fieldLocation", prompt: "enterLocation" },
                ] as const;
                for (const { field, label, prompt } of cases) {
                    const { h } = boot();
                    const u = user();
                    await toDone(h, u, { [field]: "כולל נשק" });
                    assert.strictEqual(richTo(h, u).length, 0, field);
                    const msgs = dmTo(h, u);
                    assert.strictEqual(msgs[0], noticeFor(label, "נשק"), field);
                    assert.ok(msgs[1].startsWith(T(prompt)), field);
                    const d = (await draftOf(u))!;
                    assert.strictEqual(d.step, field);
                    assert.strictEqual(d.fixing, true);
                    // clean text replaces it and the preview returns
                    h.calls.length = 0;
                    await h.sendText("100", { userId: u });
                    await settle();
                    assert.strictEqual(richTo(h, u).length, 1, field);
                    assert.strictEqual((await draftOf(u))!.step, "confirm");
                }
            } finally {
                cfg.validatePrice = wasValidate;
            }
            console.log("  [OK] (t4) a blocked description, price and location each re-ask their own step.");
        }

        // (t5) a trusted seller is stopped at the preview too
        {
            const { h } = boot();
            const u = user();
            await seedPostFor(u, "approved");
            await toDone(h, u, { description: "כולל נשק" });
            assert.strictEqual(richTo(h, u).length, 0);
            assert.strictEqual(richTo(h, APPROVED_GROUP).length, 0);
            assert.strictEqual(richTo(h, MOD_GROUP).length, 0);
            assert.strictEqual((await draftOf(u))!.step, "description");
            assert.strictEqual(await Post.countDocuments({ userId: String(u), title: "Bike" }), 0);
            console.log("  [OK] (t5) a trusted seller with a blocked word is stopped at the preview.");
        }

        // (t6) a draft saved before the release: the submitPost guard still sends it to moderation
        {
            const { h } = boot();
            const u = user();
            await seedPostFor(u, "approved");
            const post = await confirmSavedDraft(h, u, { title: BAD });
            assert.strictEqual(post.status, "pending");
            assert.strictEqual(richTo(h, APPROVED_GROUP).length, 0);
            const cards = richTo(h, MOD_GROUP);
            assert.strictEqual(cards.length, 1);
            assert.ok(isModCard(cards[0], String(post._id)));
            assert.ok(toAuthor(h, u).includes(T("postCreated")));
            console.log("  [OK] (t6) a pre-release draft with a blocked title still goes to moderation.");
        }

        // Final fix wave. Labels (u)..(u3) are fresh.
        // (u) Sold ends the listing: a moderator's later td_ finds nothing to take down
        {
            const { h } = boot();
            const { u, post, listing, cardId, listingId } = await publishTrusted(h);
            assert.strictEqual(listing.status, "live");
            await h.pressButton(`sold_${post._id}`, { userId: u, messageId: 901 });
            await settle();
            assert.strictEqual((await Post.findById(post._id))!.status, "sold");
            const sold = (await Listing.findById(listingId))!;
            assert.strictEqual(sold.status, "sold");
            assert.strictEqual(sold.endedBy, "seller");
            h.calls.length = 0;
            await tdPress(h, mod, listingId, cardId);
            await settle();
            assert.deepStrictEqual(answers(h), [T("takeDownAlready")]);
            assert.strictEqual(deletes(h).length, 0);
            assert.deepStrictEqual(toAuthor(h, u), []);
            assert.strictEqual((await Listing.findById(listingId))!.status, "sold");
            h.calls.length = 0;
            const next = await confirmWizard(h, u, { title: "Bike2" });
            assert.strictEqual(next.status, "approved", "the seller is still trusted");
            console.log("  [OK] (u) Sold ends the listing: a later td_ says already, no delete, no DM, seller still trusted.");
        }

        // (u2) another moderator's preset leaves no nudge for the prompter, and the stale marker is gone
        {
            const { h } = boot();
            const postId = await seedPost(author, "Cross mod");
            const prompt = await promptOf(h, postId);
            await rrPress(h, otherMod, `rr_${postId}_1`, messageId(prompt));
            await settle();
            h.calls.length = 0;
            await h.sendText("anything else", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup" });
            await settle();
            assert.ok(!h.calls.some((c) => c.method === "sendMessage" && text(c) === T("replyToPromptHint")), "no nudge");
            h.calls.length = 0;
            await h.sendText("late reason", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", replyToMessageId: messageId(prompt) });
            await settle();
            assert.strictEqual(toAuthorDMs(h).length, 0, "no second DM");
            assert.ok(!h.calls.some((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP), "the marker is forgotten");
            console.log("  [OK] (u2) after another moderator's preset the prompter gets no nudge and the marker is gone.");
        }

        // (u3) the prompter's own preset clears its marker too
        {
            const { h } = boot();
            const postId = await seedPost(author, "Own preset");
            const prompt = await promptOf(h, postId);
            await rrPress(h, mod, `rr_${postId}_2`, messageId(prompt));
            await settle();
            h.calls.length = 0;
            await h.sendText("plain", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup" });
            await h.sendText("late reason", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", replyToMessageId: messageId(prompt) });
            await settle();
            assert.strictEqual(toAuthorDMs(h).length, 0);
            assert.ok(!h.calls.some((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP), "no nudge, no handled message");
            console.log("  [OK] (u3) the prompter's own preset clears its marker.");
        }

        // (u4) a blocked word hidden in a text_link URL stops at the preview
        const hidden = [{ type: "text_link", offset: 0, length: 3, url: "https://cutt.ly/x" }];
        {
            const { h } = boot();
            const u = user();
            await h.sendText("/newpost", { userId: u });
            await h.sendText("Bike", { userId: u });
            await h.sendText("ראו כאן", { userId: u, entities: hidden });
            await h.sendText("1,500", { userId: u });
            await h.sendText("Tel Aviv", { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            for (let i = 0; i < 2; i++) await h.sendPhoto(`file${i}`, { userId: u });
            h.calls.length = 0;
            await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
            await settle();
            assert.strictEqual(richTo(h, u).length, 0, "no preview");
            assert.strictEqual(dmTo(h, u)[0], noticeFor("fieldDescription", "https://cutt.ly/*"));
            assert.strictEqual((await draftOf(u))!.step, "description");
            console.log("  [OK] (u4) a blocked word in a text_link URL stops at the preview as a description problem.");
        }

        // (u5) the same on a saved draft: a trusted seller goes to moderation
        {
            const { h } = boot();
            const u = user();
            await seedPostFor(u, "approved");
            const post = await confirmSavedDraft(h, u, { description: "ראו כאן", descriptionEntities: hidden });
            assert.strictEqual(post.status, "pending");
            assert.strictEqual(richTo(h, APPROVED_GROUP).length, 0);
            assert.ok(isModCard(richTo(h, MOD_GROUP)[0], String(post._id)));
            console.log("  [OK] (u5) a hidden blocked URL sends a trusted seller's post to moderation.");
        }

        // Slice 2, Task 4: group listings. Labels (v1)..(v13); (a)..(u5) are taken above.
        await Capture.deleteMany({ chatId: APPROVED_GROUP });
        cfg.approvedTopicId = 1;
        cfg.captureMode = "optin";
        {
            const SALE_TEXT = "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז";
            const FIELDS = { title: "גלוק 17 למכירה", price: "1,300₪" };
            const GROUP = { chatId: APPROVED_GROUP, chatType: "supergroup" as const };
            const NOTE_ID = 5100;
            let msgSeq = 1_000_000 + (Date.now() % 1_000_000);
            const nextMsg = () => msgSeq++;
            const tp = (key: string, params?: Record<string, string>) => localeService.t(cfg.lang, key, params);
            const seedAsked = (seller: number, text = SALE_TEXT, messageIds = [nextMsg()]) => seedCapture({
                senderId: String(seller), chatId: APPROVED_GROUP, messageIds, text, state: "asked",
                note: { ephemeralMessageId: NOTE_ID, sentAt: new Date(), kind: "ask" },
            });
            type Ctrl = ReturnType<typeof boot>["ctrl"];
            // A seller with one live group listing (refreshed an hour ago unless `now` says otherwise).
            const addListing = async (ctrl: Ctrl, seller: number, now = new Date(Date.now() - 3_600_000)) => {
                const capture = await seedAsked(seller);
                const result = await ctrl.groupListings.addToMarket(String(capture._id), FIELDS, now);
                assert.strictEqual(result.kind, "added");
                if (result.kind !== "added") throw new Error("unreachable");
                return { capture, listing: result.listing, id: String(result.listing._id) };
            };
            const press = (h: H, data: string, userId: number, extra: { noMessage?: boolean } = {}) =>
                h.pressButton(data, { userId, ...GROUP, ...extra });
            const callsTo = (h: H, method: string) => h.calls.filter((c) => c.method === method);
            const noteEdits = (h: H) => callsTo(h, "editEphemeralMessageText");
            const noteKeyboard = (c: RecordedCall) => (c.params.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard;
            const rawEdit = (h: H, messageId: number, userId: number, content: Record<string, unknown>) => h.send({
                edited_message: {
                    message_id: messageId, date: Math.floor(Date.now() / 1000), edit_date: Math.floor(Date.now() / 1000),
                    chat: { id: APPROVED_GROUP, type: "supergroup" }, from: { id: userId, is_bot: false, first_name: "Tester" }, ...content,
                },
            });

            // (v1) addToMarket creates a group listing
            {
                const { ctrl } = boot();
                const seller = user();
                const capture = await seedAsked(seller);
                const result = await ctrl.groupListings.addToMarket(String(capture._id), FIELDS);
                assert.strictEqual(result.kind, "added");
                if (result.kind !== "added") throw new Error("unreachable");
                const l = (await Listing.findById(result.listing._id))!;
                assert.deepStrictEqual([l.source, l.origin, l.status, l.sellerId], ["group", "capture", "live", String(seller)]);
                assert.deepStrictEqual([...l.messageIds], [...capture.messageIds]);
                assert.strictEqual(l.text, SALE_TEXT);
                assert.strictEqual(l.note?.ephemeralMessageId, NOTE_ID);
                const c = (await Capture.findById(capture._id))!;
                assert.deepStrictEqual([c.state, c.listingId], ["added", String(l._id)]);
                console.log("  [OK] (v1) addToMarket creates a group listing.");
            }

            // (v2) the first listing sends one take-down card, the second none
            {
                const { h, ctrl } = boot();
                const seller = user();
                const first = await addListing(ctrl, seller);
                const toMod = () => callsTo(h, "sendMessage").filter((c) => Number(c.params.chat_id) === MOD_GROUP);
                assert.strictEqual(toMod().length, 1);
                const buttons = keyboard(toMod()[0]);
                assert.deepStrictEqual(buttons.map((b) => [b.text, b.callback_data]), [[T("takeDownButton"), `td_${first.id}`], [T("takeDownDeleteButton"), `tx_${first.id}_d`]]);
                await addListing(ctrl, seller);
                assert.strictEqual(toMod().length, 1, "no card for the second listing");
                console.log("  [OK] (v2) a seller's first listing sends one take-down card.");
            }

            // (v3) a double Add is one listing; a failed create gives the capture back
            {
                const { ctrl } = boot();
                const seller = user();
                const capture = await seedAsked(seller);
                const id = String(capture._id);
                const results = await Promise.all([ctrl.groupListings.addToMarket(id, FIELDS), ctrl.groupListings.addToMarket(id, FIELDS)]);
                assert.deepStrictEqual(results.map((r) => r.kind).sort(), ["added", "already"]);
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(seller) }), 1);

                const second = user();
                const other = await seedAsked(second);
                const original = listingRepository.createFromCapture;
                listingRepository.createFromCapture = async () => { throw new Error("boom"); };
                try {
                    await assert.rejects(ctrl.groupListings.addToMarket(String(other._id), FIELDS), /boom/);
                } finally {
                    listingRepository.createFromCapture = original;
                }
                assert.strictEqual((await Capture.findById(other._id))!.state, "asked");
                assert.strictEqual((await ctrl.groupListings.addToMarket(String(other._id), FIELDS)).kind, "added", "the button still works");
                console.log("  [OK] (v3) a double Add is one listing and a failed create gives the capture back.");
            }

            // (v4) a foreign press is refused
            {
                const { h, ctrl } = boot();
                const seller = user();
                const intruder = user();
                const { id } = await addListing(ctrl, seller);
                h.calls.length = 0;
                await press(h, `ls_${id}_s_n`, intruder);
                await settle();
                assert.deepStrictEqual(answers(h), [T("notYourButton")]);
                assert.strictEqual((await Listing.findById(id))!.status, "live");
                assert.strictEqual(noteEdits(h).length, 0);
                console.log("  [OK] (v4) another member's press is refused.");
            }

            // (v5) + (v6) Sold from the note, then a second press on the ended listing
            {
                const { h, ctrl } = boot();
                const seller = user();
                const { id } = await addListing(ctrl, seller);
                h.calls.length = 0;
                await press(h, `ls_${id}_s_n`, seller);
                await settle();
                const l = (await Listing.findById(id))!;
                assert.deepStrictEqual([l.status, l.endedBy], ["sold", "seller"]);
                assert.deepStrictEqual(answers(h), [T("listingSoldToast")]);
                assert.strictEqual(noteEdits(h).length, 1);
                const edit = noteEdits(h)[0];
                assert.deepStrictEqual(
                    [Number(edit.params.ephemeral_message_id), Number(edit.params.receiver_user_id), Number(edit.params.chat_id)],
                    [NOTE_ID, seller, APPROVED_GROUP]);
                assert.strictEqual(String(edit.params.text), tp("listingSoldNote", { title: FIELDS.title }));
                assert.deepStrictEqual(noteKeyboard(edit), []);
                assert.strictEqual(callsTo(h, "editMessageText").length, 0, "the note is edited from Mongo, not from query.message");
                console.log("  [OK] (v5) Sold from the note ends the listing and edits the note.");

                h.calls.length = 0;
                await press(h, `ls_${id}_f_n`, seller);
                await settle();
                assert.deepStrictEqual(answers(h), [T("listingEnded")]);
                assert.strictEqual((await Listing.findById(id))!.status, "sold");
                assert.strictEqual(noteEdits(h).length, 1);
                assert.strictEqual(String(noteEdits(h)[0].params.text), tp("listingSoldNote", { title: FIELDS.title }));
                console.log("  [OK] (v6) a press on an ended listing says so and re-edits the note.");
            }

            // (v7) Refresh
            {
                const { h, ctrl } = boot();
                const seller = user();
                const { id, listing } = await addListing(ctrl, seller);
                h.calls.length = 0;
                await press(h, `ls_${id}_f_n`, seller);
                await settle();
                const l = (await Listing.findById(id))!;
                assert.strictEqual(l.status, "live");
                assert.ok(l.refreshedAt.getTime() > listing.refreshedAt.getTime(), "refreshedAt moved");
                assert.deepStrictEqual(answers(h), [T("listingRefreshedToast")]);
                const edit = noteEdits(h)[0];
                assert.strictEqual(String(edit.params.text), tp("listingRefreshedCard", { title: FIELDS.title, price: FIELDS.price }));
                const rows = noteKeyboard(edit) as { callback_data?: string; url?: string }[][];
                assert.deepStrictEqual(rows.map((r) => r.length), [2, 2]);
                assert.deepStrictEqual(rows.flat().slice(0, 3).map((b) => b.callback_data), [`ls_${id}_s_n`, `ls_${id}_f_n`, `ls_${id}_r_n`]);
                assert.ok(rows[1][1].url?.includes(`?start=l_${id}`));
                console.log("  [OK] (v7) Refresh renews the clock and re-edits the note.");
            }

            // (v8) Remove never touches the group message
            {
                const { h, ctrl } = boot();
                const seller = user();
                const { id } = await addListing(ctrl, seller);
                h.calls.length = 0;
                await press(h, `ls_${id}_r_n`, seller);
                await settle();
                const l = (await Listing.findById(id))!;
                assert.deepStrictEqual([l.status, l.endedBy, l.title, l.text], ["removed", "seller", undefined, undefined]);
                assert.deepStrictEqual(answers(h), [T("listingRemovedToast")]);
                assert.deepStrictEqual(
                    h.calls.filter((c) => Number(c.params.chat_id) === APPROVED_GROUP).map((c) => c.method), ["editEphemeralMessageText"]);
                for (const m of ["deleteMessage", "editMessageText", "sendMessage", "sendRichMessage"]) assert.strictEqual(callsTo(h, m).length, 0, m);
                assert.strictEqual(String(noteEdits(h)[0].params.text), T("listingRemovedNote"));
                console.log("  [OK] (v8) Remove ends the listing and never touches the member's message.");
            }

            // (v9) ls_ is refused on a bot listing
            {
                const { h } = boot();
                const seller = user();
                const now = new Date();
                const bot = await Listing.create({
                    source: "bot", origin: "dm", postId: new mongoose.Types.ObjectId().toHexString(), messageIds: [], sellerId: String(seller),
                    title: "Radio", media: [], status: "live", hold: false, isBundle: false, createdAt: now, refreshedAt: now,
                });
                for (const action of ["r", "s", "f"]) {
                    h.calls.length = 0;
                    await press(h, `ls_${bot._id}_${action}_c`, seller);
                    await settle();
                    assert.deepStrictEqual(answers(h), [T("staleButton")], action);
                    assert.strictEqual((await Listing.findById(bot._id))!.status, "live", action);
                    assert.strictEqual(callsTo(h, "editMessageText").length + noteEdits(h).length, 0, action);
                }
                console.log("  [OK] (v9) every ls_ button is refused on a bot listing.");
            }

            // (v10) a press without query.message
            {
                const { h, ctrl } = boot();
                const seller = user();
                const onNote = await addListing(ctrl, seller);
                h.calls.length = 0;
                await press(h, `ls_${onNote.id}_s_n`, seller, { noMessage: true });
                await settle();
                assert.strictEqual((await Listing.findById(onNote.id))!.status, "sold");
                assert.strictEqual(noteEdits(h).length, 1, "the note is edited from Mongo");

                const onCard = await addListing(ctrl, seller);
                h.calls.length = 0;
                await press(h, `ls_${onCard.id}_s_c`, seller, { noMessage: true });
                await settle();
                assert.strictEqual((await Listing.findById(onCard.id))!.status, "sold");
                assert.deepStrictEqual(answers(h), [T("listingSoldToast")]);
                assert.strictEqual(callsTo(h, "editMessageText").length, 0);
                console.log("  [OK] (v10) a press without query.message still ends the listing.");
            }

            // (v11) an edit updates the price; edits that name no listing or carry no text change nothing
            const EDITED = "גלוק 17 למכירה\nבמצב מעולה\n1,100₪";
            {
                const { h, ctrl } = boot();
                const seller = user();
                const capture = await seedAsked(seller, SALE_TEXT, [nextMsg(), nextMsg()]);
                const added = await ctrl.groupListings.addToMarket(String(capture._id), FIELDS);
                assert.strictEqual(added.kind, "added");
                if (added.kind !== "added") throw new Error("unreachable");
                const id = String(added.listing._id);
                const before = (await Listing.findById(id))!;

                await h.sendEdit(nextMsg(), EDITED, { userId: seller, ...GROUP });
                await rawEdit(h, capture.messageIds[0], seller, { photo: [{ file_id: "p", file_unique_id: "p", width: 1, height: 1 }] });
                const untouched = (await Listing.findById(id))!;
                assert.deepStrictEqual([untouched.price, untouched.textHash], [before.price, before.textHash]);

                await h.sendEdit(capture.messageIds[1], EDITED, { userId: seller, ...GROUP });
                const after = (await Listing.findById(id))!;
                assert.deepStrictEqual([after.price, after.priceValue, after.status], ["1,100₪", 1100, "live"]);
                assert.notStrictEqual(after.textHash, before.textHash);
                console.log("  [OK] (v11) an edit updates the price; unrelated and text-less edits change nothing.");

                // (v13) the same in every captureMode
                cfg.captureMode = "off";
                try {
                    await h.sendEdit(capture.messageIds[0], SALE_TEXT, { userId: seller, ...GROUP });
                    assert.strictEqual((await Listing.findById(id))!.priceValue, 1300);
                } finally {
                    cfg.captureMode = "optin";
                }
                console.log("  [OK] (v13) the edit sync works with captureMode off.");
            }

            // (v12) an edit adding a blocked word removes the listing without a take-down
            {
                const { h, ctrl } = boot();
                const seller = user();
                const hiddenLink = [{ type: "text_link", offset: 0, length: 3, url: "https://cutt.ly/x" }];
                for (const edit of [{ text: "גלוק 17 למכירה נשק 1,100₪" }, { text: "ראו כאן", entities: hiddenLink }]) {
                    const capture = await seedAsked(seller);
                    const added = await ctrl.groupListings.addToMarket(String(capture._id), FIELDS);
                    assert.strictEqual(added.kind, "added");
                    if (added.kind !== "added") throw new Error("unreachable");
                    h.calls.length = 0;
                    await rawEdit(h, capture.messageIds[0], seller, edit);
                    const l = (await Listing.findById(added.listing._id))!;
                    assert.deepStrictEqual([l.status, l.endedBy, l.title], ["removed", "system", undefined], edit.text);
                    assert.strictEqual(noteEdits(h).length, 1, "the note shows the ending");
                }
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(seller), status: "taken_down" }), 0);
                console.log("  [OK] (v12) an edit adding a blocked word removes the listing, never as a take-down.");
            }
        }

        // Slice 2, Task 5: the note send path. Labels (w1)..(w15).
        await Capture.deleteMany({ chatId: APPROVED_GROUP });
        cfg.approvedTopicId = 1;
        cfg.captureMode = "optin";
        await (async () => { // its own function: the huge run() above is at the compiler's flow-analysis depth limit
            const { tick } = await import("../services/shadowService");
            const { default: memberRepository } = await import("../repositories/memberRepository");
            const { textHash, classify } = await import("../services/classifier");
            const { default: ShadowLog } = await import("../models/ShadowLog");
            const SALE1 = "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז";
            const SALE2 = "וסט טקטי למכירה 250₪ צפון";
            const SALE3 = "כוונת אדומה למכירה 300₪";
            const SALE4 = "אוזניות תקשורת למכירה 400₪ דרום";
            const BARE = "1300 מרכז";
            const FIELDS = { title: "גלוק 17 למכירה", price: "1,300₪" };
            const GROUP = { chatId: APPROVED_GROUP, chatType: "supergroup" as const };
            const OLD_NOTE = 5100;
            let msgSeq = 2_000_000 + (Date.now() % 1_000_000);
            const nextMsg = () => msgSeq++;
            const tp = (key: string, params?: Record<string, string>) => localeService.t(cfg.lang, key, params);
            type Ctrl = ReturnType<typeof boot>["ctrl"];

            const post = async (h: H, userId: number, caption: string, o: { photo?: boolean; thread?: number } = {}) => {
                const opts = { ...GROUP, userId, ...(o.thread ? { messageThreadId: o.thread, isTopicMessage: true } : {}) };
                if (o.photo === false) await h.sendText(caption, opts);
                else await h.sendPhoto("f1", { ...opts, caption });
                await settle();
            };
            const closeAndNote = async (ctrl: Ctrl, plusMs = 31_000) => {
                await tick(cfg, new Date(Date.now() + plusMs), (e, n) => ctrl.captureNotes.onClassified(e, n));
                await settle();
            };
            const callsTo = (h: H, method: string) => h.calls.filter((c) => c.method === method);
            const ephemerals = (h: H) => h.calls.filter((c) => c.method === "sendMessage" && c.params.ephemeral_message_parameters);
            const rows = (c: RecordedCall) => (c.params.reply_markup as { inline_keyboard: { callback_data?: string; url?: string }[][] }).inline_keyboard;
            const ephemeralId = (c: RecordedCall) => (c.result as { ephemeral_message_id?: number }).ephemeral_message_id;
            const lastCapture = (u: number) => Capture.findOne({ senderId: String(u) }).sort({ _id: -1 }).exec();
            const deletedNotes = (h: H) => h.calls.filter((c) => c.method === "deleteEphemeralMessage");
            const addListing = async (ctrl: Ctrl, seller: number) => {
                const capture = await seedCapture({
                    senderId: String(seller), chatId: APPROVED_GROUP, messageIds: [nextMsg()], text: SALE1, state: "asked",
                    note: { ephemeralMessageId: OLD_NOTE, sentAt: new Date(Date.now() - 3 * 24 * 3_600_000), kind: "ask" },
                });
                const result = await ctrl.groupListings.addToMarket(String(capture._id), FIELDS, new Date(Date.now() - 3_600_000));
                if (result.kind !== "added") throw new Error("addToMarket failed");
                return String(result.listing._id);
            };

            // (w1) a strict post gets one private note
            {
                const { h, ctrl } = boot();
                const u = user();
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                const sent = ephemerals(h);
                assert.strictEqual(sent.length, 1);
                const cap = (await lastCapture(u))!;
                const p = sent[0].params;
                assert.deepStrictEqual(
                    [(p.ephemeral_message_parameters as { receiver_user_id: number }).receiver_user_id, Number(p.chat_id), "message_thread_id" in p],
                    [u, APPROVED_GROUP, false]);
                assert.deepStrictEqual(rows(sent[0]).flat().map((b) => b.callback_data).filter(Boolean), [`mk_${cap._id}_a`, `mk_${cap._id}_n`, `mk_${cap._id}_x`]);
                assert.strictEqual(cap.state, "asked");
                assert.ok(ephemeralId(sent[0]) !== undefined && ephemeralId(sent[0])! >= 5000);
                assert.strictEqual(cap.note?.ephemeralMessageId, ephemeralId(sent[0]));
                assert.strictEqual(cap.note?.kind, "ask");
                console.log("  [OK] (w1) a strict post gets one private note, without a thread id.");
            }

            // (w2) shadow mode records, sends nothing
            {
                const { h, ctrl } = boot();
                const u = user();
                cfg.captureMode = "shadow";
                try {
                    await post(h, u, SALE1);
                    await closeAndNote(ctrl);
                } finally {
                    cfg.captureMode = "optin";
                }
                assert.strictEqual(callsTo(h, "sendMessage").length, 0);
                assert.strictEqual((await lastCapture(u))!.state, "classified");
                assert.strictEqual(await ShadowLog.countDocuments({ senderId: String(u) }), 1);
                await ShadowLog.deleteMany({ senderId: String(u) });
                console.log("  [OK] (w2) shadow mode sends nothing.");
            }

            // (w3) a note in a real topic is threaded
            {
                const { h, ctrl } = boot();
                const u = user();
                cfg.approvedTopicId = 73;
                try {
                    await post(h, u, SALE1, { thread: 73 });
                    await closeAndNote(ctrl);
                } finally {
                    cfg.approvedTopicId = 1;
                }
                const sent = ephemerals(h);
                assert.strictEqual(sent.length, 1);
                assert.strictEqual(Number(sent[0].params.message_thread_id), 73);
                console.log("  [OK] (w3) the note is threaded in topic 73.");
            }

            // (w4) an incomplete post gets the deep link
            {
                const { h, ctrl } = boot();
                const u = user();
                await post(h, u, BARE);
                await closeAndNote(ctrl);
                const sent = ephemerals(h);
                assert.strictEqual(sent.length, 1);
                const cap = (await lastCapture(u))!;
                const first = rows(sent[0])[0][0];
                assert.strictEqual(first.url, `https://t.me/${BOT_USERNAME}?start=c_${cap._id}`);
                assert.strictEqual(first.callback_data, undefined);
                console.log("  [OK] (w4) an incomplete post gets the deep link.");
            }

            // (w5) a want-to-buy post gets no note
            {
                const { h, ctrl } = boot();
                const u = user();
                await post(h, u, "מחפש גלוק 17 עד 800₪");
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 0);
                console.log("  [OK] (w5) a wanted post gets no note.");
            }

            // (w6) askMode never is silent
            {
                const { h, ctrl } = boot();
                const u = user();
                await memberRepository.setAskMode(String(u), "never", new Date());
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 0);
                assert.strictEqual((await lastCapture(u))!.state, "ignored");
                console.log("  [OK] (w6) askMode never is silent.");
            }

            // (w7) three notes a day
            {
                const { h, ctrl } = boot();
                const u = user();
                for (const text of [SALE1, SALE2, SALE3, SALE4]) {
                    await post(h, u, text);
                    await closeAndNote(ctrl);
                }
                assert.strictEqual(ephemerals(h).length, 3);
                assert.strictEqual((await lastCapture(u))!.state, "classified");
                console.log("  [OK] (w7) at most 3 notes a day.");
            }

            // (w8) a text already asked about is not asked again (R1); another text is
            {
                const { h, ctrl } = boot();
                const u = user();
                await memberRepository.rememberAsked(String(u), textHash(SALE1), new Date());
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 0);
                assert.strictEqual((await lastCapture(u))!.state, "ignored");
                await post(h, u, SALE2);
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 1);
                assert.strictEqual((await lastCapture(u))!.state, "asked");
                console.log("  [OK] (w8) a text already asked about gets no second note.");
            }

            // (w8b) R1 end to end: an unanswered note, then the same text again, gets nothing
            {
                const { h, ctrl } = boot();
                const u = user();
                await post(h, u, SALE3);
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 1);
                assert.strictEqual(await memberRepository.wasAskedRecently(String(u), textHash(SALE3), new Date()), true);
                await post(h, u, SALE3);
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 1, "no second note");
                assert.strictEqual((await lastCapture(u))!.state, "ignored");
                console.log("  [OK] (w8b) an unanswered note is not repeated for the same text.");
            }

            // (w9) a repost refreshes the listing and swaps the note, no question
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                const before = (await Listing.findById(id))!;
                h.calls.length = 0;
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                const cap = (await lastCapture(u))!;
                const l = (await Listing.findById(id))!;
                assert.ok(l.refreshedAt.getTime() > before.refreshedAt.getTime());
                assert.deepStrictEqual([...l.messageIds], [...cap.messageIds]);
                const sent = ephemerals(h);
                assert.strictEqual(sent.length, 1);
                assert.deepStrictEqual(rows(sent[0]).flat().slice(0, 3).map((b) => b.callback_data), [`ls_${id}_s_n`, `ls_${id}_f_n`, `ls_${id}_r_n`]);
                assert.strictEqual(String(sent[0].params.text), tp("listingRefreshedCard", { title: FIELDS.title, price: FIELDS.price }));
                assert.deepStrictEqual(deletedNotes(h).map((c) => Number(c.params.ephemeral_message_id)), [OLD_NOTE]);
                assert.strictEqual(l.note?.ephemeralMessageId, ephemeralId(sent[0]));
                assert.deepStrictEqual([cap.state, cap.listingId, cap.note?.kind], ["ignored", id, "refresh"]);
                console.log("  [OK] (w9) a repost refreshes the listing and swaps the note.");
            }

            // (w10) two reposts leave one card
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                h.calls.length = 0;
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                const sent = ephemerals(h);
                assert.strictEqual(sent.length, 2);
                assert.deepStrictEqual(deletedNotes(h).map((c) => Number(c.params.ephemeral_message_id)), [OLD_NOTE, ephemeralId(sent[0])]);
                assert.strictEqual((await Listing.findById(id))!.note?.ephemeralMessageId, ephemeralId(sent[1]));
                console.log("  [OK] (w10) two reposts leave one card.");
            }

            // (w11) a repost of a bot listing is silent
            {
                const { h, ctrl } = boot();
                const u = user();
                const now = new Date();
                await Listing.create({
                    source: "bot", origin: "dm", postId: new mongoose.Types.ObjectId().toHexString(), messageIds: [], sellerId: String(u),
                    title: "Glock", text: SALE1, textHash: textHash(SALE1), media: [], status: "live", hold: false, isBundle: false, createdAt: now, refreshedAt: now,
                });
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 0);
                assert.strictEqual((await lastCapture(u))!.state, "ignored");
                console.log("  [OK] (w11) a repost of a bot listing is silent.");
            }

            // (w12) the refresh note respects askMode never
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                const before = (await Listing.findById(id))!;
                await memberRepository.setAskMode(String(u), "never", new Date());
                h.calls.length = 0;
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 0);
                assert.ok((await Listing.findById(id))!.refreshedAt.getTime() > before.refreshedAt.getTime(), "still refreshed");
                console.log("  [OK] (w12) a refresh is silent for askMode never.");
            }

            // (w13) a failed send leaves the capture classified, and nothing retries
            {
                const { h, ctrl } = boot({ responses: { sendMessage: (p: Record<string, unknown>) => p.ephemeral_message_parameters ? { ok: false, error_code: 403, description: "Forbidden" } : undefined } });
                const u = user();
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                const cap = (await lastCapture(u))!;
                assert.deepStrictEqual([cap.state, cap.note], ["classified", undefined]);
                assert.strictEqual(ephemerals(h).length, 1);
                await closeAndNote(ctrl, 62_000);
                assert.strictEqual(ephemerals(h).length, 1, "no retry");
                assert.strictEqual(await memberRepository.wasAskedRecently(String(u), textHash(SALE1), new Date()), false, "nothing was sent, nothing remembered");
                console.log("  [OK] (w13) a failed send leaves the capture classified.");
            }

            // (w14) a response without the ephemeral id counts as a failure
            {
                const { h, ctrl } = boot({ responses: { sendMessage: (p: Record<string, unknown>) => p.ephemeral_message_parameters ? { message_id: 1, chat: { id: APPROVED_GROUP, type: "supergroup" }, date: 1 } : undefined } });
                const u = user();
                await post(h, u, SALE1);
                await closeAndNote(ctrl);
                const cap = (await lastCapture(u))!;
                assert.deepStrictEqual([cap.state, cap.note], ["classified", undefined]);
                assert.strictEqual(ephemerals(h).length, 1);
                const stray = callsTo(h, "deleteMessage"); // M3: a note that came out public is deleted at once
                assert.deepStrictEqual(stray.map((c) => [Number(c.params.chat_id), Number(c.params.message_id)]), [[APPROVED_GROUP, 1]]);
                console.log("  [OK] (w14) a missing ephemeral id is a failed send, and the public message is deleted.");
            }

            // (w15) a hidden blocked URL gets no note; another chat is never noted
            {
                const { h, ctrl } = boot();
                const u = user();
                await h.message({
                    photo: [{ file_id: "f1", file_unique_id: "f1", width: 10, height: 10 }],
                    caption: "ראו כאן למכירה 300₪",
                    caption_entities: [{ type: "text_link", offset: 0, length: 3, url: "https://cutt.ly/x" }],
                }, { ...GROUP, userId: u });
                await settle();
                await closeAndNote(ctrl);
                assert.strictEqual(ephemerals(h).length, 0);
                assert.strictEqual((await lastCapture(u))!.state, "ignored");

                const other = user();
                const elsewhere = await seedCapture({ senderId: String(other), text: SALE1 });
                await ctrl.captureNotes.onClassified({ capture: elsewhere, result: classify(SALE1, false), shadowId: "" }, new Date());
                assert.strictEqual(ephemerals(h).length, 0);
                assert.strictEqual((await Capture.findById(elsewhere._id))!.state, "classified");
                console.log("  [OK] (w15) a hidden blocked URL and another chat get no note.");
            }
            await ShadowLog.deleteMany({ senderId: { $in: userIds.map(String) } });
        })();

        // Slice 2, Task 6: the note buttons. Labels (x1)..(x11).
        await Capture.deleteMany({ chatId: APPROVED_GROUP });
        cfg.approvedTopicId = 1;
        cfg.captureMode = "optin";
        await (async () => { // its own function: run() is at the compiler's flow-analysis depth limit
            const { tick } = await import("../services/shadowService");
            const { textHash } = await import("../services/classifier");
            const SALE = "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז";
            const SALE2 = "וסט טקטי למכירה 250₪ צפון";
            const NOTE_ID = 5200;
            const GROUP = { chatId: APPROVED_GROUP, chatType: "supergroup" as const };
            let msgSeq = 3_000_000 + (Date.now() % 1_000_000);
            const T6 = (key: string) => localeService.t(cfg.lang, key);
            const seedAsked = (seller: number, text = SALE) => seedCapture({
                senderId: String(seller), chatId: APPROVED_GROUP, messageIds: [msgSeq++], text, state: "asked",
                note: { ephemeralMessageId: NOTE_ID, sentAt: new Date(), kind: "ask" },
            });
            const press = (h: H, data: string, userId: number, extra: { noMessage?: boolean } = {}) => h.pressButton(data, { userId, ...GROUP, ...extra });
            const callsTo = (h: H, method: string) => h.calls.filter((c) => c.method === method);
            const toasts = (h: H) => callsTo(h, "answerCallbackQuery").map((c) => c.params.text);
            const edits = (h: H) => callsTo(h, "editEphemeralMessageText");
            const rows = (c: RecordedCall) => (c.params.reply_markup as { inline_keyboard: { callback_data?: string; url?: string }[][] }).inline_keyboard;

            // (x1) Add creates a listing and turns the note into the management card
            {
                const { h } = boot();
                const a = user();
                const cap = await seedAsked(a);
                await press(h, `mk_${cap._id}_a`, a);
                await settle();
                const listings = await Listing.find({ sellerId: String(a) });
                assert.deepStrictEqual([listings.length, listings[0].source], [1, "group"]);
                const id = String(listings[0]._id);
                assert.strictEqual((await Capture.findById(cap._id))!.state, "added");
                const e = edits(h);
                assert.strictEqual(e.length, 1);
                assert.deepStrictEqual(
                    [Number(e[0].params.chat_id), Number(e[0].params.receiver_user_id), Number(e[0].params.ephemeral_message_id)],
                    [APPROVED_GROUP, a, NOTE_ID]);
                assert.ok(String(e[0].params.text).includes("גלוק 17 למכירה"));
                const r = rows(e[0]);
                assert.deepStrictEqual(r.flat().slice(0, 3).map((b) => b.callback_data), [`ls_${id}_s_n`, `ls_${id}_f_n`, `ls_${id}_r_n`]);
                assert.strictEqual(r[1][1].url, `https://t.me/${BOT_USERNAME}?start=l_${id}`);
                assert.deepStrictEqual(toasts(h), [T6("captureAddedToast")]);
                assert.strictEqual(listings[0].note?.ephemeralMessageId, NOTE_ID);

                // (x2) nothing public
                const toGroup = h.calls.filter((c) => ["sendMessage", "sendRichMessage"].includes(c.method) && Number(c.params.chat_id) === APPROVED_GROUP);
                assert.strictEqual(toGroup.filter((c) => !c.params.ephemeral_message_parameters).length, 0);
                console.log("  [OK] (x1) Add creates a listing and edits the note.");
                console.log("  [OK] (x2) Add posts nothing public.");

                // (x11) after Add, Not now and Don't ask again are stale
                h.calls.length = 0;
                await press(h, `mk_${cap._id}_n`, a);
                await press(h, `mk_${cap._id}_x`, a);
                await settle();
                assert.deepStrictEqual(toasts(h), [T6("staleButton"), T6("staleButton")]);
                assert.strictEqual(edits(h).length + callsTo(h, "deleteEphemeralMessage").length, 0);
                assert.notStrictEqual((await Member.findOne({ userId: String(a) }))?.askMode, "never");
                assert.strictEqual((await Capture.findById(cap._id))!.state, "added");
                console.log("  [OK] (x11) Not now and Don't ask again after Add are stale.");
            }

            // (x3) a double Add is one listing
            {
                const { h } = boot();
                const a = user();
                const cap = await seedAsked(a);
                await press(h, `mk_${cap._id}_a`, a);
                await press(h, `mk_${cap._id}_a`, a);
                await settle();
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(a) }), 1);
                assert.deepStrictEqual(toasts(h), [T6("captureAddedToast"), T6("captureAlreadyAdded")]);
                console.log("  [OK] (x3) a double Add is one listing.");
            }

            // (x4) Not now
            {
                const { h } = boot();
                const a = user();
                const cap = await seedAsked(a);
                const { default: members } = await import("../repositories/memberRepository");
                await members.rememberAsked(String(a), textHash(SALE), new Date()); // what the send path did
                await press(h, `mk_${cap._id}_n`, a);
                await settle();
                assert.strictEqual((await Capture.findById(cap._id))!.state, "declined");
                const del = callsTo(h, "deleteEphemeralMessage");
                assert.deepStrictEqual(
                    [del.length, Number(del[0].params.chat_id), Number(del[0].params.receiver_user_id), Number(del[0].params.ephemeral_message_id)],
                    [1, APPROVED_GROUP, a, NOTE_ID]);
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(a) }), 0);
                const m = (await Member.findOne({ userId: String(a) }))!;
                assert.deepStrictEqual((m.declined ?? []).map((d) => d.hash), [textHash(SALE)]); // once, even though the send path also remembers it
                assert.notStrictEqual(m.askMode, "never");
                console.log("  [OK] (x4) Not now declines, deletes the note, remembers the text once.");
            }

            // (x5) Don't ask again
            {
                const { h, ctrl } = boot();
                const a = user();
                const cap = await seedAsked(a);
                await press(h, `mk_${cap._id}_x`, a);
                await settle();
                assert.strictEqual((await Member.findOne({ userId: String(a) }))!.askMode, "never");
                assert.strictEqual((await Capture.findById(cap._id))!.state, "declined");
                const e = edits(h);
                assert.strictEqual(e.length, 1);
                assert.strictEqual(String(e[0].params.text), T6("captureNeverNote"));
                assert.deepStrictEqual(rows(e[0]).flat().map((b) => b.url), [`https://t.me/${BOT_USERNAME}`]);
                h.calls.length = 0;
                await h.sendPhoto("f1", { ...GROUP, userId: a, caption: SALE2 });
                await settle();
                await tick(cfg, new Date(Date.now() + 31_000), (ev, n) => ctrl.captureNotes.onClassified(ev, n));
                await settle();
                assert.strictEqual(h.calls.filter((c) => c.method === "sendMessage" && c.params.ephemeral_message_parameters).length, 0);
                console.log("  [OK] (x5) Don't ask again edits the note and silences the next post.");
            }

            // (x6) a foreign user's press is refused
            {
                const { h } = boot();
                const a = user();
                const b = user();
                const cap = await seedAsked(a);
                await press(h, `mk_${cap._id}_a`, b);
                await settle();
                assert.deepStrictEqual(toasts(h), [T6("notYourButton")]);
                assert.strictEqual((await Capture.findById(cap._id))!.state, "asked");
                assert.strictEqual(await Listing.countDocuments({ sellerId: { $in: [String(a), String(b)] } }), 0);
                assert.strictEqual(edits(h).length, 0);
                console.log("  [OK] (x6) a foreign user's press is refused.");
            }

            // (x7) a press after the capture row expired
            {
                const { h } = boot();
                const a = user();
                const cap = await seedAsked(a);
                await Capture.deleteOne({ _id: cap._id });
                await press(h, `mk_${cap._id}_a`, a);
                await settle();
                assert.deepStrictEqual(toasts(h), [T6("staleButton")]);
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(a) }), 0);
                console.log("  [OK] (x7) a press after the capture TTL is stale.");
            }

            // (x8) a press without query.message still works
            {
                const { h } = boot();
                const a = user();
                const cap = await seedAsked(a);
                await press(h, `mk_${cap._id}_a`, a, { noMessage: true });
                await settle();
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(a) }), 1);
                assert.strictEqual(Number(edits(h)[0].params.ephemeral_message_id), NOTE_ID);
                console.log("  [OK] (x8) Add works without query.message.");
            }

            // (x9) the note edit failing changes nothing
            {
                const { h } = boot({ responses: { editEphemeralMessageText: { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } } });
                const a = user();
                const cap = await seedAsked(a);
                await press(h, `mk_${cap._id}_a`, a);
                await settle();
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(a) }), 1);
                assert.deepStrictEqual(toasts(h), [T6("captureAddedToast")]);
                console.log("  [OK] (x9) Add survives a failing note edit.");
            }

            // (x10) a forged Add on an incomplete capture
            {
                const { h } = boot();
                const a = user();
                const cap = await seedAsked(a, "1300 מרכז");
                assert.ok(!cap.parsed?.title);
                await press(h, `mk_${cap._id}_a`, a);
                await settle();
                assert.deepStrictEqual(toasts(h), [T6("staleButton")]);
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(a) }), 0);
                assert.strictEqual((await Capture.findById(cap._id))!.state, "asked");
                console.log("  [OK] (x10) a forged Add on an incomplete capture is stale.");
            }
        })();

        // Slice 2, Task 7: deep links c_ and l_. Labels (y1)..(y10).
        await Capture.deleteMany({ chatId: APPROVED_GROUP });
        cfg.approvedTopicId = 1;
        cfg.captureMode = "optin";
        await (async () => { // its own function: run() is at the compiler's flow-analysis depth limit
            const { tick } = await import("../services/shadowService");
            const SALE = "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז";
            const BARE = "1300 מרכז";
            const FIELDS = { title: "גלוק 17 למכירה", price: "1,300₪" };
            const NOTE_ID = 5300;
            const GROUP = { chatId: APPROVED_GROUP, chatType: "supergroup" as const };
            let msgSeq = 4_000_000 + (Date.now() % 1_000_000);
            type Ctrl = ReturnType<typeof boot>["ctrl"];
            const seed = (seller: number, body: string, state: "asked" | "added" | "declined" = "asked") => seedCapture({
                senderId: String(seller), chatId: APPROVED_GROUP, messageIds: [msgSeq++], text: body, state,
                media: [{ type: "photo", fileId: "cap1" }],
                note: { ephemeralMessageId: NOTE_ID, sentAt: new Date(), kind: "ask" },
            });
            const addListing = async (ctrl: Ctrl, seller: number) => {
                const capture = await seed(seller, SALE);
                const result = await ctrl.groupListings.addToMarket(String(capture._id), FIELDS, new Date(Date.now() - 3_600_000));
                if (result.kind !== "added") throw new Error("addToMarket failed");
                return String(result.listing._id);
            };
            const callsTo = (h: H, method: string) => h.calls.filter((c) => c.method === method);
            const dms = (h: H, u: number) => callsTo(h, "sendMessage").filter((c) => Number(c.params.chat_id) === u);
            const buttons = (c: RecordedCall) => (c.params.reply_markup as { inline_keyboard: { callback_data?: string; url?: string }[][] }).inline_keyboard.flat();
            const link = (h: H, u: number, payload: string) => h.sendText(`/start ${payload}`, { userId: u });
            const lsRow = (id: string, surface: string) => [`ls_${id}_s_${surface}`, `ls_${id}_f_${surface}`, `ls_${id}_r_${surface}`];
            const UNKNOWN = "0123456789abcdef01234567";

            // (y1) an incomplete note -> deep link -> prefilled wizard -> group listing
            {
                const { h, ctrl } = boot();
                const u = user();
                await h.sendPhoto("f1", { ...GROUP, userId: u, caption: BARE });
                await settle();
                await tick(cfg, new Date(Date.now() + 31_000), (e, n) => ctrl.captureNotes.onClassified(e, n));
                await settle();
                const cap = (await Capture.findOne({ senderId: String(u) }))!;
                const note = callsTo(h, "sendMessage").find((c) => c.params.ephemeral_message_parameters)!;
                assert.strictEqual(buttons(note)[0].url, `https://t.me/${BOT_USERNAME}?start=c_${cap._id}`);
                const noteId = cap.note!.ephemeralMessageId;
                const parsedPrice = cap.parsed!.price!;
                h.calls.length = 0;

                await link(h, u, `c_${cap._id}`);
                await settle();
                const d = (await draftOf(u))!;
                assert.deepStrictEqual([d.captureId, d.step, d.price, d.location, d.media.length, d.title], [String(cap._id), "title", parsedPrice, "מרכז", 1, undefined]);
                const prompts = dms(h, u);
                assert.deepStrictEqual(prompts.map(text), [T("welcome")], "the title prompt, no step indicator");
                assert.strictEqual(d.promptMessageId, messageId(prompts[0]));

                h.calls.length = 0;
                await h.sendText("אופניים", { userId: u });
                await settle();
                const d2 = (await draftOf(u))!;
                assert.deepStrictEqual([d2.step, d2.title, d2.description], ["confirm", "אופניים", undefined]);
                const preview = richTo(h, u);
                assert.strictEqual(preview.length, 1);

                h.calls.length = 0;
                await h.pressButton(keyboard(preview[0])[0].callback_data, { userId: u, messageId: messageId(preview[0]) });
                await settle();
                const listings = await Listing.find({ sellerId: String(u) });
                assert.deepStrictEqual([listings.length, listings[0].source, listings[0].title], [1, "group", "אופניים"]);
                const id = String(listings[0]._id);
                assert.strictEqual((await Capture.findById(cap._id))!.state, "added");
                assert.strictEqual(await Post.countDocuments({ userId: String(u) }), 0);
                assert.strictEqual(await draftOf(u), null);
                const toMod = h.calls.filter((c) => ["sendMessage", "sendRichMessage"].includes(c.method) && Number(c.params.chat_id) === MOD_GROUP);
                assert.strictEqual(toMod.length, 1, "only the first-seller card");
                assert.deepStrictEqual(buttons(toMod[0]).map((b) => b.callback_data), [`td_${id}`, `tx_${id}_d`]);
                const mine = dms(h, u);
                assert.ok(mine.some((c) => text(c) === T("capturePublished")), "capturePublished");
                const card = mine.find((c) => c.params.reply_markup)!;
                assert.deepStrictEqual(buttons(card).map((b) => b.callback_data), lsRow(id, "c"));
                const edit = callsTo(h, "editEphemeralMessageText");
                assert.strictEqual(edit.length, 1);
                assert.strictEqual(Number(edit[0].params.ephemeral_message_id), noteId);
                assert.deepStrictEqual(buttons(edit[0]).map((b) => b.callback_data).slice(0, 3), lsRow(id, "n"));
                console.log("  [OK] (y1) incomplete note -> c_ link -> prefilled wizard -> group listing.");
            }

            // (y2) a complete capture goes straight to the preview
            {
                const { h } = boot();
                const u = user();
                const cap = await seed(u, SALE);
                await link(h, u, `c_${cap._id}`);
                await settle();
                const d = (await draftOf(u))!;
                assert.deepStrictEqual([d.captureId, d.step, d.title, d.price], [String(cap._id), "confirm", cap.parsed!.title, cap.parsed!.price]);
                const preview = richTo(h, u);
                assert.strictEqual(preview.length, 1);
                assert.strictEqual(d.promptMessageId, messageId(preview[0]));
                console.log("  [OK] (y2) a complete capture goes straight to the preview.");

                // a title without a price asks for the price only
                const u2 = user();
                const noPrice = await seed(u2, "אופניים הרים למכירה במצב מעולה");
                assert.ok(noPrice.parsed?.title && !noPrice.parsed.price, JSON.stringify(noPrice.parsed));
                h.calls.length = 0;
                await link(h, u2, `c_${noPrice._id}`);
                await settle();
                assert.deepStrictEqual(dms(h, u2).map(text), [T("enterPrice")]);
                assert.strictEqual((await draftOf(u2))!.step, "price");
                h.calls.length = 0;
                await h.sendText("500", { userId: u2 });
                await settle();
                assert.deepStrictEqual([(await draftOf(u2))!.step, richTo(h, u2).length], ["confirm", 1]);
                console.log("  [OK] (y2) a captured title without a price asks for the price, then previews.");
            }

            // (y3) expired, unknown, foreign, already added
            {
                const { h } = boot();
                const u = user();
                const other = user();
                const gone = await seed(u, SALE);
                await Capture.deleteOne({ _id: gone._id });
                const foreign = await seed(other, SALE);
                const added = await seed(u, SALE, "added");
                const declined = await seed(u, SALE, "declined");
                for (const [id, expected] of [
                    [String(gone._id), T("captureExpired")], [UNKNOWN, T("captureExpired")], [String(foreign._id), T("captureExpired")],
                    [String(declined._id), T("captureExpired")], [String(added._id), T("captureAlreadyAdded")],
                ] as const) {
                    h.calls.length = 0;
                    await link(h, u, `c_${id}`);
                    await settle();
                    assert.deepStrictEqual(dms(h, u).map(text), [expected], id);
                    assert.strictEqual(await draftOf(u), null);
                }
                assert.strictEqual((await Capture.findById(foreign._id))!.state, "asked");
                console.log("  [OK] (y3) expired, unknown, foreign and added captures answer without a draft.");
            }

            // (y4) a live draft is never overwritten; an expired one is replaced
            {
                const { h } = boot();
                const u = user();
                const cap = await seed(u, BARE);
                await h.sendText("/newpost", { userId: u });
                await settle();
                const before = (await draftOf(u))!;
                h.calls.length = 0;
                await link(h, u, `c_${cap._id}`);
                await settle();
                assert.deepStrictEqual(dms(h, u).map(text), [T("captureDraftBusy")]);
                const after = (await draftOf(u))!;
                assert.deepStrictEqual([after.captureId, after.step, after.promptMessageId, after.updatedAt.getTime()], [undefined, "title", before.promptMessageId, before.updatedAt.getTime()]);

                await Draft.updateOne({ userId: String(u) }, { $set: { updatedAt: new Date(Date.now() - 2 * 3_600_000) } });
                h.calls.length = 0;
                await link(h, u, `c_${cap._id}`);
                await settle();
                const replaced = (await draftOf(u))!;
                assert.deepStrictEqual([replaced.captureId, replaced.step], [String(cap._id), "title"]);
                console.log("  [OK] (y4) a live draft is kept, an expired one replaced.");
            }

            // (y5) the blocked-word gate still runs for a capture draft
            {
                const { h } = boot();
                const u = user();
                const cap = await seed(u, BARE);
                await link(h, u, `c_${cap._id}`);
                await settle();
                h.calls.length = 0;
                await h.sendText(BAD, { userId: u });
                await settle();
                assert.strictEqual(richTo(h, u).length, 0, "no preview");
                assert.deepStrictEqual(dms(h, u).map(text), [noticeFor("fieldTitle", "לנשק"), T("welcome")]);
                const d = (await draftOf(u))!;
                assert.deepStrictEqual([d.step, d.fixing, d.captureId], ["title", true, String(cap._id)]);
                h.calls.length = 0;
                await h.sendText("מחזיק", { userId: u });
                await settle();
                assert.strictEqual(richTo(h, u).length, 1, "the clean title reaches the preview");
                const d2 = (await draftOf(u))!;
                assert.deepStrictEqual([d2.step, d2.fixing], ["confirm", undefined]);
                console.log("  [OK] (y5) a capture draft honours the blocked word.");

                // (y6) a cancelled capture draft leaves no captureId behind: /newpost is the full wizard
                await h.sendText("/cancel", { userId: u });
                await settle();
                assert.strictEqual(await draftOf(u), null);
                h.calls.length = 0;
                await h.sendText("/newpost", { userId: u });
                await h.sendText("Bike", { userId: u });
                await settle();
                const fresh = (await draftOf(u))!;
                assert.deepStrictEqual([fresh.captureId, fresh.step, fresh.price, fresh.location], [undefined, "description", undefined, undefined]);
                assert.ok(dms(h, u).map(text).some((m) => m.startsWith(T("enterDescription"))), "description is asked");
                console.log("  [OK] (y6) a normal wizard after a cancelled capture draft is unchanged.");
            }

            // (y7) l_ opens for a user with no users row yet
            {
                const { h, ctrl } = boot();
                const u = user();
                assert.strictEqual(await User.findOne({ userId: String(u) }), null);
                const id = await addListing(ctrl, u);
                await link(h, u, `l_${id}`);
                await settle();
                assert.ok(await User.findOne({ userId: String(u) }), "ensureUser ran");
                const sent = dms(h, u);
                assert.strictEqual(sent.length, 1);
                assert.deepStrictEqual(buttons(sent[0]).map((b) => b.callback_data), lsRow(id, "c"));
                assert.strictEqual(text(sent[0]), localeService.t(cfg.lang, "listingCard", { title: FIELDS.title, price: FIELDS.price }));
                console.log("  [OK] (y7) l_ opens the management card for a fresh user.");

                // (y8) another user and an unknown id are refused
                const other = user();
                for (const [who, target] of [[other, id], [u, UNKNOWN]] as const) {
                    h.calls.length = 0;
                    await link(h, who, `l_${target}`);
                    await settle();
                    const refused = dms(h, who);
                    assert.deepStrictEqual(refused.map(text), [T("postNotFound")]);
                    assert.strictEqual(refused[0].params.reply_markup, undefined);
                }
                console.log("  [OK] (y8) l_ refuses a foreign user and an unknown id.");

                // (y10) the DM card buttons
                const msgId = 77;
                h.calls.length = 0;
                await h.pressButton(`ls_${id}_f_c`, { userId: u, messageId: msgId });
                await settle();
                const refresh = callsTo(h, "editMessageText");
                assert.deepStrictEqual([refresh.length, Number(refresh[0].params.chat_id), Number(refresh[0].params.message_id)], [1, u, msgId]);
                assert.deepStrictEqual(buttons(refresh[0]).map((b) => b.callback_data), lsRow(id, "c"));
                assert.strictEqual(callsTo(h, "editEphemeralMessageText").length, 1, "the group note follows");
                h.calls.length = 0;
                await h.pressButton(`ls_${id}_s_c`, { userId: u, messageId: msgId });
                await settle();
                assert.strictEqual((await Listing.findById(id))!.status, "sold");
                const sold = callsTo(h, "editMessageText");
                assert.deepStrictEqual([sold.length, (sold[0].params.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard.length], [1, 0]);

                const id2 = await addListing(ctrl, u);
                h.calls.length = 0;
                await h.pressButton(`ls_${id2}_r_c`, { userId: u, messageId: msgId });
                await settle();
                assert.strictEqual((await Listing.findById(id2))!.status, "removed");
                const removed = callsTo(h, "editMessageText");
                assert.deepStrictEqual([removed.length, text(removed[0])], [1, T("listingRemovedNote")]);
                assert.strictEqual((removed[0].params.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard.length, 0);
                // an ended listing opened again shows the ended card, no buttons
                h.calls.length = 0;
                await link(h, u, `l_${id2}`);
                await settle();
                const ended = dms(h, u);
                assert.deepStrictEqual(ended.map(text), [T("listingRemovedNote")]);
                assert.ok(!ended[0].params.reply_markup || buttons(ended[0]).length === 0);
                console.log("  [OK] (y10) the DM card buttons edit the card and the note.");
            }

            // (y9) l_ on a bot listing: the post card, never ls_ or Remove
            {
                const { h } = boot();
                const u = user();
                const post = await Post.create({ userId: String(u), title: "Bot post", description: "d", price: "10", location: "l", media: [], status: "approved" });
                postIds.push(String(post._id));
                const listing = await listingRepository.createForPost(post.toObject() as never, "dm", false, new Date());
                await link(h, u, `l_${listing._id}`);
                await settle();
                const card = richTo(h, u);
                assert.strictEqual(card.length, 1);
                assert.deepStrictEqual(keyboard(card[0]).map((b) => b.callback_data), [`sold_${post._id}`, `bump_${post._id}`]);
                assert.strictEqual(dms(h, u).length, 0);

                await Post.updateOne({ _id: post._id }, { $set: { status: "pending" } });
                h.calls.length = 0;
                await link(h, u, `l_${listing._id}`);
                await settle();
                assert.strictEqual(richTo(h, u).length, 0);
                assert.ok(dms(h, u).every((c) => !c.params.reply_markup || buttons(c).every((b) => !b.callback_data?.startsWith("ls_"))));
                console.log("  [OK] (y9) l_ on a bot listing shows the post card without ls_ or Remove.");
            }
        })();

        // Slice 2, final fix wave. Labels (f1)..(f9).
        await Capture.deleteMany({ chatId: APPROVED_GROUP });
        cfg.approvedTopicId = 1;
        cfg.captureMode = "optin";
        await (async () => { // its own function: run() is at the compiler's flow-analysis depth limit
            const { tick } = await import("../services/shadowService");
            const { textHash } = await import("../services/classifier");
            const { default: memberRepository } = await import("../repositories/memberRepository");
            const { default: captureRepository } = await import("../repositories/captureRepository");
            const { default: ShadowLog } = await import("../models/ShadowLog");
            const GA = "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז";
            const GA_CHEAPER = "גלוק 17 למכירה\nבמצב מעולה\n1,100₪ מרכז";
            const G19 = "גלוק 19 למכירה\nבמצב מעולה\n1,300₪ מרכז";
            const FIELDS = { title: "גלוק 17 למכירה", price: "1,300₪" };
            const NOTE_ID = 5400;
            const GROUP = { chatId: APPROVED_GROUP, chatType: "supergroup" as const };
            let msgSeq = 9_000_000 + (Date.now() % 1_000_000);
            type Ctrl = ReturnType<typeof boot>["ctrl"];
            const callsTo = (h: H, method: string) => h.calls.filter((c) => c.method === method);
            const toasts = (h: H) => callsTo(h, "answerCallbackQuery").map((c) => c.params.text);
            const ephemerals = (h: H) => callsTo(h, "sendMessage").filter((c) => c.params.ephemeral_message_parameters);
            const seed = (seller: number, body: string, state: "asked" | "classified" = "asked") => seedCapture({
                senderId: String(seller), chatId: APPROVED_GROUP, messageIds: [msgSeq++], text: body, state,
                media: [{ type: "photo", fileId: "f1" }],
                ...(state === "asked" ? { note: { ephemeralMessageId: NOTE_ID, sentAt: new Date(), kind: "ask" as const } } : {}),
            });
            const post = async (h: H, userId: number, caption: string) => {
                await h.sendPhoto("f1", { ...GROUP, userId, caption });
                await settle();
            };
            const closeAndNote = async (ctrl: Ctrl) => {
                await tick(cfg, new Date(Date.now() + 31_000), (e, n) => ctrl.captureNotes.onClassified(e, n));
                await settle();
            };
            const addListing = async (ctrl: Ctrl, seller: number, body = GA) => {
                const capture = await seed(seller, body);
                const result = await ctrl.groupListings.addToMarket(String(capture._id), FIELDS, new Date(Date.now() - 3_600_000));
                if (result.kind !== "added") throw new Error("addToMarket failed");
                return String(result.listing._id);
            };
            const newest = (u: number) => Capture.findOne({ senderId: String(u) }).sort({ _id: -1 }).exec();

            // (f1) I1: Don't ask again sticks even when the memory write fails
            {
                const { h } = boot();
                const u = user();
                const cap = await seed(u, GA);
                const original = memberRepository.rememberAsked;
                memberRepository.rememberAsked = () => Promise.reject(new Error("boom"));
                try {
                    await h.pressButton(`mk_${cap._id}_x`, { userId: u, ...GROUP });
                    await settle();
                } finally {
                    memberRepository.rememberAsked = original;
                }
                assert.strictEqual((await Member.findOne({ userId: String(u) }))?.askMode, "never");
                console.log("  [OK] (f1) Don't ask again sticks when the memory write fails.");
            }

            // (f2) I2: a sent note stays asked when the bookkeeping after it fails
            {
                const { h, ctrl } = boot();
                const u = user();
                const original = captureRepository.setNote;
                captureRepository.setNote = () => Promise.reject(new Error("boom"));
                try {
                    await post(h, u, GA);
                    await closeAndNote(ctrl);
                } finally {
                    captureRepository.setNote = original;
                }
                assert.strictEqual(ephemerals(h).length, 1);
                assert.strictEqual((await newest(u))!.state, "asked");
                assert.strictEqual(await memberRepository.wasAskedRecently(String(u), textHash(GA), new Date()), true, "the text is still remembered");
                console.log("  [OK] (f2) a sent note stays asked when setNote fails.");
            }

            // (f3) I3: a failure after the Add claim rolls the capture back; pressing again works
            {
                const { h } = boot();
                const u = user();
                const cap = await seed(u, GA);
                const original = listingRepository.countBySeller;
                listingRepository.countBySeller = () => Promise.reject(new Error("boom"));
                try {
                    await h.pressButton(`mk_${cap._id}_a`, { userId: u, ...GROUP });
                    await settle();
                } finally {
                    listingRepository.countBySeller = original;
                }
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(u) }), 0);
                assert.strictEqual((await Capture.findById(cap._id))!.state, "asked");
                h.calls.length = 0;
                await h.pressButton(`mk_${cap._id}_a`, { userId: u, ...GROUP });
                await settle();
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(u) }), 1);
                assert.deepStrictEqual(toasts(h), [localeService.t(cfg.lang, "captureAddedToast")]);
                // setListing failing after the listing exists leaves no orphan and no stuck capture
                const cap2 = await seed(u, G19);
                const originalSet = captureRepository.setListing;
                captureRepository.setListing = () => Promise.reject(new Error("boom"));
                try {
                    await h.pressButton(`mk_${cap2._id}_a`, { userId: u, ...GROUP });
                    await settle();
                } finally {
                    captureRepository.setListing = originalSet;
                }
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(u) }), 1);
                assert.strictEqual((await Capture.findById(cap2._id))!.state, "asked");
                console.log("  [OK] (f3) a failed Add rolls the capture back and can be pressed again.");
            }

            // (f4) I4: a cheaper repost of the same item refreshes it with the new price and text
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                const before = (await Listing.findById(id))!;
                h.calls.length = 0;
                await post(h, u, GA_CHEAPER);
                await closeAndNote(ctrl);
                const cap = (await newest(u))!;
                const l = (await Listing.findById(id))!;
                assert.deepStrictEqual([cap.state, cap.listingId], ["ignored", id]);
                assert.deepStrictEqual([l.price, l.priceValue, l.text, l.textHash], ["1,100₪", 1100, GA_CHEAPER, textHash(GA_CHEAPER)]);
                assert.deepStrictEqual([...l.messageIds], [...cap.messageIds]);
                assert.ok(l.refreshedAt.getTime() > before.refreshedAt.getTime());
                console.log("  [OK] (f4) a repost of the same item refreshes it with the new price.");
            }

            // (f5) I4: a different item (Glock 19) is asked about and leaves the old listing alone
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                const before = (await Listing.findById(id))!;
                h.calls.length = 0;
                await post(h, u, G19);
                await closeAndNote(ctrl);
                assert.strictEqual((await newest(u))!.state, "asked");
                assert.strictEqual(ephemerals(h).length, 1);
                const l = (await Listing.findById(id))!;
                assert.deepStrictEqual([l.price, l.text, l.refreshedAt.getTime(), [...l.messageIds]], [before.price, before.text, before.refreshedAt.getTime(), [...before.messageIds]]);
                assert.strictEqual(await memberRepository.wasAskedRecently(String(u), textHash(G19), new Date()), true);
                console.log("  [OK] (f5) a different item gets its own note and the old listing is untouched.");
            }

            // (f6) M1: a want-to-buy capture can never be added
            {
                const { h, ctrl } = boot();
                const u = user();
                const wtb = await seed(u, "מחפש גלוק 17 עד 800₪", "classified");
                assert.strictEqual(wtb.tier, "wtb");
                assert.deepStrictEqual(await ctrl.groupListings.addToMarket(String(wtb._id), FIELDS), { kind: "gone" });
                await h.pressButton(`mk_${wtb._id}_a`, { userId: u, ...GROUP });
                await settle();
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(u) }), 0);
                assert.strictEqual((await Capture.findById(wtb._id))!.state, "classified");
                console.log("  [OK] (f6) a wtb capture cannot be added.");
            }

            // (f7) M2: an edit of the member's message also updates the private note
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                const listing = (await Listing.findById(id))!;
                h.calls.length = 0;
                await h.sendEdit(listing.messageIds[0], GA_CHEAPER, { userId: u, ...GROUP });
                await settle();
                const e = callsTo(h, "editEphemeralMessageText");
                assert.strictEqual(e.length, 1);
                assert.ok(String(e[0].params.text).includes("1,100₪"));
                console.log("  [OK] (f7) an edit syncs the private note.");
            }

            // (f8) M7: a forged _c/_l press from a group never edits that message
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                h.calls.length = 0;
                await h.pressButton(`ls_${id}_f_c`, { userId: u, ...GROUP, messageId: 4242 });
                await h.pressButton(`ls_${id}_f_l`, { userId: u, ...GROUP, messageId: 4243 });
                await settle();
                assert.strictEqual(callsTo(h, "editMessageText").length, 0);
                assert.deepStrictEqual(toasts(h), [localeService.t(cfg.lang, "listingRefreshedToast"), localeService.t(cfg.lang, "listingRefreshedToast")]);
                console.log("  [OK] (f8) a group press on a _c/_l button edits nothing.");
            }

            // (f9) M4: a capture draft without a price is refused, not listed
            {
                const { h } = boot();
                const u = user();
                const cap = await seed(u, "אופניים הרים למכירה במצב מעולה");
                await h.sendText(`/start c_${cap._id}`, { userId: u });
                await settle();
                assert.strictEqual((await draftOf(u))!.captureId, String(cap._id));
                await draftRepository.update(String(u), { step: "confirm", promptMessageId: 8800 });
                h.calls.length = 0;
                await h.pressButton(`confirm_${u}_1`, { userId: u, messageId: 8800 });
                await settle();
                assert.strictEqual(await Listing.countDocuments({ sellerId: String(u) }), 0);
                assert.strictEqual((await Capture.findById(cap._id))!.state, "asked");
                assert.ok(callsTo(h, "sendMessage").some((c) => Number(c.params.chat_id) === u && String(c.params.text) === T("generalError")));
                console.log("  [OK] (f9) a capture draft without a price is refused.");
            }

            // (f10) a moderator take-down closes the seller's private note (found in the live test)
            {
                const { h, ctrl } = boot();
                const u = user();
                const id = await addListing(ctrl, u);
                h.calls.length = 0;
                await tdPress(h, mod, id, 9100);
                await settle();
                assert.strictEqual((await Listing.findById(id))!.status, "taken_down");
                const e = callsTo(h, "editEphemeralMessageText");
                assert.strictEqual(e.length, 1);
                assert.strictEqual(Number(e[0].params.ephemeral_message_id), NOTE_ID);
                assert.strictEqual(String(e[0].params.text), T("listingEnded"));
                assert.ok(!String(e[0].params.reply_markup ?? "").includes("callback_data"));
                console.log("  [OK] (f10) a take-down closes the private note.");
            }
            await ShadowLog.deleteMany({ senderId: { $in: userIds.map(String) } });
        })();

        // Slice 2, Task 8: /myposts with group listings and the settings row. Labels (z1)..(z6).
        cfg.approvedTopicId = 1;
        await (async () => { // its own function: run() is at the compiler's flow-analysis depth limit
            const callsTo = (h: H, method: string) => h.calls.filter((c) => c.method === method);
            const buttons = (c: RecordedCall) => (c.params.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard
                .map((row) => row.map((b) => b.callback_data));
            const sent = (h: H, u: number) => h.calls.filter((c) => ["sendMessage", "sendRichMessage"].includes(c.method) && Number(c.params.chat_id) === u);
            let seq = 7_000_000 + (Date.now() % 1_000_000);
            const group = (seller: number, title: string, ageHours: number, status: "live" | "sold" = "live") => {
                const at = new Date(Date.now() - ageHours * 3_600_000);
                return Listing.create({
                    source: "group", origin: "capture", chatId: APPROVED_GROUP, messageIds: [seq++], sellerId: String(seller),
                    title, price: "100₪", media: [], status, hold: false, isBundle: false, createdAt: at, refreshedAt: at,
                });
            };
            const approvedPost = async (u: number) => {
                const id = await seedPost(u, "Bike");
                await Post.updateOne({ _id: id }, { $set: { status: "approved" } });
                return id;
            };

            // (z1) captureMode shadow: the pre-slice output, nothing more
            {
                cfg.captureMode = "shadow";
                const { h } = boot();
                const u = user();
                const postId = await approvedPost(u);
                h.calls.length = 0;
                await h.sendText("/myposts", { userId: u });
                await settle();
                const out = sent(h, u);
                assert.deepStrictEqual(out.map((c) => c.method), ["sendMessage", "sendRichMessage"]);
                assert.ok(text(out[0]).includes(T("myPostsTitle")));
                assert.deepStrictEqual(keyboard(out[1]).map((b) => b.callback_data), [`sold_${postId}`, `bump_${postId}`]);
                console.log("  [OK] (z1) /myposts with captureMode shadow is unchanged.");
            }

            // (z2) optin: summary, bot post, then the group section
            cfg.captureMode = "optin";
            {
                const { h } = boot();
                const u = user();
                const postId = await approvedPost(u);
                const A = await group(u, "Alpha", 1);
                const B = await group(u, "Beta", 2);
                await group(u, "Gamma", 3, "sold");
                h.calls.length = 0;
                await h.sendText("/myposts", { userId: u });
                await settle();
                const out = sent(h, u);
                assert.deepStrictEqual(out.map((c) => c.method), ["sendMessage", "sendRichMessage", "sendMessage"]);
                assert.ok(text(out[0]).includes(T("myPostsTitle")));
                assert.deepStrictEqual(keyboard(out[1]).map((b) => b.callback_data), [`sold_${postId}`, `bump_${postId}`]);
                const section = out[2];
                assert.strictEqual(section.params.parse_mode, "HTML");
                assert.deepStrictEqual(section.params.link_preview_options, { is_disabled: true });
                const lines = text(section).split("\n");
                assert.strictEqual(lines[0], T("myPostsGroupTitle"));
                assert.ok(/^1\. <a href="[^"]+">Alpha<\/a> · 100₪$/.test(lines[1]), lines[1]);
                assert.ok(/^2\. <a href="[^"]+">Beta<\/a> · 100₪$/.test(lines[2]), lines[2]);
                assert.ok(text(section).includes(localeService.t(cfg.lang, "myPostsGroupEnded", { n: 1 })));
                assert.ok(text(section).endsWith(T("myPostsAskOn")));
                const [a, b] = [String(A._id), String(B._id)];
                assert.deepStrictEqual(buttons(section), [[`ls_${a}_s_l`, `ls_${a}_f_l`, `ls_${a}_r_l`], [`ls_${b}_s_l`, `ls_${b}_f_l`, `ls_${b}_r_l`], ["mk_set_never"]]);
                console.log("  [OK] (z2) /myposts lists bot posts, then the group section.");
            }

            // (z3) a section row button acts and re-renders the pressed message
            {
                const { h } = boot();
                const u = user();
                const A = await group(u, "Alpha", 1);
                await group(u, "Beta", 2);
                h.calls.length = 0;
                await h.pressButton(`ls_${A._id}_s_l`, { userId: u, messageId: 77 });
                await settle();
                assert.strictEqual((await Listing.findById(A._id))!.status, "sold");
                const edit = callsTo(h, "editMessageText");
                assert.strictEqual(edit.length, 1);
                assert.strictEqual(Number(edit[0].params.message_id), 77);
                assert.strictEqual(edit[0].params.parse_mode, "HTML");
                assert.ok(!text(edit[0]).includes("Alpha") && text(edit[0]).includes("Beta"));
                assert.ok(text(edit[0]).includes(localeService.t(cfg.lang, "myPostsGroupEnded", { n: 1 })));
                assert.ok(!buttons(edit[0]).flat().some((d) => d?.startsWith(`ls_${A._id}`)));
                console.log("  [OK] (z3) a section button acts and the message is re-rendered.");
            }

            // (z4) the settings toggle
            {
                const { h } = boot();
                const u = user();
                await group(u, "Alpha", 1);
                h.calls.length = 0;
                await h.pressButton("mk_set_never", { userId: u, messageId: 78 });
                await settle();
                assert.strictEqual((await Member.findOne({ userId: String(u) }))!.askMode, "never");
                let edit = callsTo(h, "editMessageText");
                assert.strictEqual(edit.length, 1);
                assert.ok(text(edit[0]).endsWith(T("myPostsAskOff")));
                assert.deepStrictEqual(buttons(edit[0]).at(-1), ["mk_set_ask"]);
                h.calls.length = 0;
                await h.pressButton("mk_set_ask", { userId: u, messageId: 78 });
                await settle();
                assert.strictEqual((await Member.findOne({ userId: String(u) }))!.askMode, "ask");
                edit = callsTo(h, "editMessageText");
                assert.deepStrictEqual(buttons(edit[0]).at(-1), ["mk_set_never"]);
                h.calls.length = 0;
                await h.pressButton("mk_set_bogus", { userId: u, messageId: 78 });
                await settle();
                assert.deepStrictEqual(callsTo(h, "answerCallbackQuery").map((c) => String(c.params.text)), [T("staleButton")]);
                assert.strictEqual(callsTo(h, "editMessageText").length, 0);
                console.log("  [OK] (z4) the toggle flips askMode and re-renders; a bad arg is stale.");
            }

            // (z5) no posts: the empty text, with the settings row only when optin is on
            {
                const { h } = boot();
                const u = user();
                h.calls.length = 0;
                await h.sendText("/myposts", { userId: u });
                await settle();
                let out = sent(h, u);
                assert.strictEqual(out.length, 1);
                assert.strictEqual(text(out[0]), T("myPostsEmpty"));
                assert.deepStrictEqual(buttons(out[0]), [["mk_set_never"]]);
                cfg.captureMode = "shadow";
                h.calls.length = 0;
                await h.sendText("/myposts", { userId: u });
                await settle();
                out = sent(h, u);
                assert.strictEqual(text(out[0]), T("myPostsEmpty"));
                assert.ok(!out[0].params.reply_markup);
                cfg.captureMode = "optin";
                console.log("  [OK] (z5) no posts: empty text, plus the settings row when optin is on.");
            }

            // (z6) titles are HTML-escaped
            {
                const { h } = boot();
                const u = user();
                await group(u, "a<b>&c", 1);
                h.calls.length = 0;
                await h.sendText("/myposts", { userId: u });
                await settle();
                assert.ok(text(sent(h, u)[0]).includes(">a&lt;b&gt;&amp;c</a>"));
                console.log("  [OK] (z6) listing titles are HTML-escaped.");
            }
        })();

        // (k1)..(k26): quickListing buttons, the meetup toggle and the one-message quick draft
        await quickListingChecks({ boot: (o) => ({ h: boot(o).h }), cfg, user, settle, T, postIds, APPROVED_GROUP, MOD_GROUP });

        // Slice 6: catch-up scan. Labels (cu1)..(cu9).
        cfg.approvedTopicId = 1;
        cfg.captureMode = "optin";
        cfg.moderationGroupId = MOD_GROUP;
        const realFetch = globalThis.fetch;
        const realToken = process.env.BOT_TOKEN;
        process.env.BOT_TOKEN ??= "123:TEST"; // the harness never reads it; the import builds the file URL from it
        await (async () => { // its own function, like the sections above
            const { default: memberRepository } = await import("../repositories/memberRepository");
            const { findBlockedWord, BLOCKED_WORDS_PATH } = await import("../services/blockedWords");
            const fs = await import("fs");
            const GROUP = { chatId: APPROVED_GROUP, chatType: "supergroup" as const };
            const tp = (key: string, params?: Record<string, string | number>) => localeService.t(cfg.lang, key, params);
            const admin = user();
            await User.create({ userId: String(admin), firstName: "Admin", authLevel: 2 });
            const item = (messageId: number, title: string, text: string, days = 2): CatchupItem =>
                ({ messageId, date: new Date(Date.now() - days * 86_400_000).toISOString(), title, price: "100", text, tier: "strict" });
            const fileOf = (sellers: { userId: number; items: CatchupItem[] }[]) =>
                JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), sellers: sellers.map((s) => ({ userId: String(s.userId), name: "S", items: s.items })) });
            const memberOf = (u: number) => Member.findOne({ userId: String(u) }).exec();
            const memberIdOf = async (u: number) => String((await memberOf(u))!._id);
            const sends = (h: H) => h.calls.filter((c) => c.method === "sendMessage");
            const ephemerals = (h: H) => h.calls.filter((c) => c.method === "sendMessage" && c.params.ephemeral_message_parameters);
            const answers = (h: H) => h.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.params.text));
            const stubFetch = (body: string) => {
                globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
                    String(input instanceof Request ? input.url : input).includes("api.telegram.org/file/") ? new Response(body) : realFetch(input, init)) as typeof fetch;
            };
            const importDoc = async (h: H, from: number, extra: Record<string, unknown> = {}) => {
                await h.message({ document: { file_id: "f1", file_unique_id: "u1", file_size: 200, ...extra }, caption: "/catchup import" }, { userId: from });
                await settle();
            };
            const getFileOk = { getFile: { file_id: "f1", file_path: "documents/f1.json" } };
            // a seller with an armed offer; the note is delivered by a message in the sale topic
            const deliveredSeller = async (h: H, items: CatchupItem[]) => {
                const u = user();
                await memberRepository.importCatchup(String(u), items, new Date());
                await memberRepository.armCatchup(new Date());
                await h.sendText("anyone here", { ...GROUP, userId: u });
                await settle();
                return u;
            };

            try {
                // (cu1) /catchup is admin-only and private-only
                {
                    const { h } = boot();
                    const plain = user();
                    const target = user();
                    await memberRepository.importCatchup(String(target), [item(1, "Glock", "Glock 17 100")], new Date());
                    await h.sendText("/catchup send", { userId: plain });
                    await settle();
assert.strictEqual(text(sends(h)[0]), T("notAdmin"));
                    assert.strictEqual((await memberOf(target))!.catchup?.armedAt, undefined, "a plain user arms nothing");
                    h.calls.length = 0;
                    await h.sendText("/catchup send", { userId: admin, chatId: MOD_GROUP, chatType: "supergroup" });
                    await settle();
                    assert.strictEqual(h.calls.length, 0, "/catchup in a group is ignored");
                    assert.strictEqual((await memberOf(target))!.catchup?.armedAt, undefined);
                    console.log("  [OK] (cu1) a plain user gets notAdmin and arms nothing; a group is ignored.");
                }

                // (cu2) /catchup import: stored, not sent, the message deleted; bad, oversized and non-admin files refused
                {
                    const seller = user();
                    const { h } = boot({ responses: getFileOk });
                    stubFetch(fileOf([{ userId: seller, items: [item(1, "Glock", "Glock 17 100")] }]));
                    await importDoc(h, admin, { message_id: 9001 });
                    const m = await memberOf(seller);
                    assert.ok(m?.pendingCatchup?.length === 1 && m.catchup?.importedAt && !m.catchup.armedAt && !m.catchup.sentAt, "stored, not armed, not sent");
                    assert.strictEqual(h.calls.filter((c) => c.method === "getFile").length, 1);
                    assert.ok(h.calls.some((c) => c.method === "sendMessage" && text(c) === tp("catchupImported", { sellers: 1, items: 1, skipped: 0 })));
                    assert.ok(h.calls.some((c) => c.method === "deleteMessage"), "the document message is deleted");
                    // a sale-topic message before /catchup send: nothing reaches the seller
                    h.calls.length = 0;
                    await h.sendText("hello all", { ...GROUP, userId: seller });
                    await settle();
                    assert.ok(!h.calls.some((c) => c.method === "sendMessage" || Number(c.params.chat_id) === seller), "nothing to the seller before send");

                    const bad = boot({ responses: getFileOk });
                    const ghost = user();
                    stubFetch("this is not json");
                    await importDoc(bad.h, admin);
                    assert.ok(bad.h.calls.some((c) => c.method === "sendMessage" && text(c) === T("catchupBadFile")));
                    stubFetch(JSON.stringify({ version: 1, generatedAt: "x", sellers: [{ userId: String(ghost), name: "S", items: [{ messageId: "nope" }] }] }));
                    bad.h.calls.length = 0;
                    await importDoc(bad.h, admin);
                    assert.ok(bad.h.calls.some((c) => c.method === "sendMessage" && text(c) === T("catchupBadFile")));
                    assert.strictEqual(await memberOf(ghost), null, "a malformed file stores nothing");

                    const big = boot({ responses: getFileOk });
                    await importDoc(big.h, admin, { file_size: 6_000_000 });
                    assert.ok(big.h.calls.some((c) => c.method === "sendMessage" && text(c) === T("catchupBadFile")));
                    assert.ok(!big.h.calls.some((c) => c.method === "getFile"), "an oversized file is refused before getFile");
                    assert.ok(bad.h.calls.some((c) => c.method === "deleteMessage"), "a bad file's message is deleted too");
                    assert.ok(big.h.calls.some((c) => c.method === "deleteMessage"), "an oversized file's message is deleted too");

                    const plainBoot = boot({ responses: getFileOk });
                    await importDoc(plainBoot.h, user());
                    assert.ok(plainBoot.h.calls.some((c) => c.method === "sendMessage" && text(c) === T("notAdmin")));
                    assert.ok(!plainBoot.h.calls.some((c) => c.method === "getFile"), "a plain user's file is never fetched");
                    console.log("  [OK] (cu2) import stores without sending; bad, oversized and non-admin files are refused.");
                }

                // (cu3) send, then the next sale-topic message gets one note, once; a reply or forward does not count
                {
                    const { h } = boot();
                    const a = user();
                    const b = user();
                    await memberRepository.importCatchup(String(a), [item(1, "Glock", "Glock 17 100")], new Date());
                    await memberRepository.importCatchup(String(b), [item(2, "Vest", "Vest tactical 250")], new Date());
                    await h.sendText("/catchup send", { userId: admin });
                    await settle();
                    assert.ok(h.calls.some((c) => c.method === "sendMessage" && text(c).startsWith("Armed")), "armed reply");
                    h.calls.length = 0;
                    await h.sendText("just chatting", { ...GROUP, userId: a });
                    await settle();
                    assert.strictEqual(ephemerals(h).length, 1, "a chatter message delivers");
                    const mid = await memberIdOf(a);
                    assert.ok(JSON.stringify(ephemerals(h)[0].params.reply_markup).includes(`start=k_${mid}`));
                    await h.sendText("and more", { ...GROUP, userId: a });
                    await settle();
                    assert.strictEqual(ephemerals(h).length, 1, "never twice");
                    await h.sendText("a reply", { ...GROUP, userId: b, replyToMessageId: 5 });
                    await h.sendText("a forward", { ...GROUP, userId: b, forwardOrigin: { type: "user", date: 1, sender_user: { id: 5, is_bot: false, first_name: "X" } } });
                    await settle();
                    assert.strictEqual(ephemerals(h).length, 1, "a reply and a forward do not deliver");
                    await h.sendText("now a plain one", { ...GROUP, userId: b });
                    await settle();
                    assert.strictEqual(ephemerals(h).length, 2);
                    console.log("  [OK] (cu3) one note on the next sale-topic message, never twice, replies and forwards ignored.");
                }

                // (cu4) /start k_<id>: the owner after delivery gets the list; others and early visitors the greeting
                {
                    const { h } = boot();
                    const early = user();
                    await memberRepository.importCatchup(String(early), [item(1, "Glock", "Glock 17 100")], new Date());
                    const earlyId = await memberIdOf(early);
                    await h.sendText(`/start k_${earlyId}`, { userId: early });
                    await settle();
                    assert.strictEqual(text(sends(h)[0]), T("greeting"), "before delivery: greeting");
                    const owner = await deliveredSeller(h, [item(11, "Glock", "Glock 17 100"), item(12, "Vest", "Vest tactical 250")]);
                    const ownerId = await memberIdOf(owner);
                    h.calls.length = 0;
                    await h.sendText(`/start k_${ownerId}`, { userId: owner });
                    await settle();
                    assert.deepStrictEqual(keyboard(sends(h)[0]).map((b) => b.callback_data), [`ck_${ownerId}_11`, `ck_${ownerId}_12`]);
                    h.calls.length = 0;
                    await h.sendText(`/start k_${ownerId}`, { userId: user() });
                    await settle();
                    assert.strictEqual(text(sends(h)[0]), T("greeting"), "another user: greeting");
                    console.log("  [OK] (cu4) the owner gets the list; another user or an early visit gets the greeting.");
                }

                // (cu5) ck_ add: a catchup listing, the DM edited, a td_ card only for the first listing
                {
                    const { h } = boot();
                    const u = await deliveredSeller(h, [item(21, "Glock", "Glock 17 100", 3), item(22, "Vest", "Vest tactical 250"), item(23, "Scope", "Red scope 300")]);
                    const id = await memberIdOf(u);
                    h.calls.length = 0;
                    await h.pressButton(`ck_${id}_21`, { userId: u, messageId: 55 });
                    await settle();
                    const l1 = await Listing.findOne({ sellerId: String(u), origin: "catchup", messageIds: 21 });
                    assert.ok(l1 && l1.source === "group", "listing exists");
                    assert.ok(Math.abs(l1!.refreshedAt.getTime() - (Date.now() - 3 * 86_400_000)) < 60_000, "refreshedAt is the item date");
                    assert.deepStrictEqual(answers(h), [T("captureAddedToast")]);
                    const edit = h.calls.find((c) => c.method === "editMessageText")!;
                    assert.deepStrictEqual(keyboard(edit).map((b) => b.callback_data), [`ck_${id}_22`, `ck_${id}_23`], "the DM lists what is left");
                    const cards = () => h.calls.filter((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP);
                    assert.strictEqual(cards().length, 1, "a td_ card for the first listing");
                    assert.ok(keyboard(cards()[0])[0].callback_data.startsWith("td_"));
                    await h.pressButton(`ck_${id}_22`, { userId: u, messageId: 55 });
                    await settle();
                    assert.strictEqual(cards().length, 1, "none for the second");
                    // a double press and another user
                    h.calls.length = 0;
                    await Promise.all([h.pressButton(`ck_${id}_23`, { userId: u, messageId: 55 }), h.pressButton(`ck_${id}_23`, { userId: u, messageId: 55 })]);
                    await settle();
                    assert.strictEqual(await Listing.countDocuments({ sellerId: String(u), messageIds: 23 }), 1, "a double press makes one listing");
                    h.calls.length = 0;
                    await h.pressButton(`ck_${id}_23`, { userId: user(), messageId: 55 });
                    await settle();
                    assert.deepStrictEqual(answers(h), [T("notYourButton")]);
                    console.log("  [OK] (cu5) add makes a catchup listing, edits the DM, one td_ card; double press and strangers are safe.");
                }

                // (cu6) a blocked word added after the scan, and a duplicate of a live listing
                {
                    const { h } = boot();
                    const word = (JSON.parse(fs.readFileSync(BLOCKED_WORDS_PATH, "utf8")) as string[]).find((w) => !w.includes("*") && findBlockedWord(w));
                    assert.ok(word, "the blocklist has a plain entry");
                    const u = await deliveredSeller(h, [item(31, "Glock", "Glock 19 100 " + word), item(32, "Glock", "Glock 17 100"), item(33, "Glock", "Glock 17 100")]);
                    const id = await memberIdOf(u);
                    h.calls.length = 0;
                    await h.pressButton(`ck_${id}_31`, { userId: u, messageId: 55 });
                    await settle();
                    assert.deepStrictEqual(answers(h), [T("staleButton")]);
                    assert.strictEqual(await Listing.countDocuments({ sellerId: String(u), messageIds: 31 }), 0, "a blocked item is never listed");
                    assert.ok(!(await memberOf(u))!.pendingCatchup?.some((i) => i.messageId === 31), "and stays gone");
                    await h.pressButton(`ck_${id}_32`, { userId: u, messageId: 55 });
                    await settle();
                    h.calls.length = 0;
                    await h.pressButton(`ck_${id}_33`, { userId: u, messageId: 55 });
                    await settle();
                    assert.deepStrictEqual(answers(h), [T("captureAlreadyAdded")]);
                    assert.strictEqual(await Listing.countDocuments({ sellerId: String(u), origin: "catchup" }), 1, "a duplicate of a live listing is not listed");
                    console.log("  [OK] (cu6) a blocked item and a duplicate of a live listing create nothing.");
                }

                // (cu7) No thanks: items gone, the note deleted, /start k_ says nothing is left
                {
                    const { h } = boot();
                    const u = await deliveredSeller(h, [item(41, "Glock", "Glock 17 100")]);
                    const id = await memberIdOf(u);
                    const noteId = (await memberOf(u))!.catchup!.note!.ephemeralMessageId;
                    h.calls.length = 0;
                    await h.pressButton(`ck_${id}_x`, { userId: u, noMessage: true });
                    await settle();
                    assert.strictEqual((await memberOf(u))!.pendingCatchup, undefined, "items gone");
                    const del = h.calls.filter((c) => c.method === "deleteEphemeralMessage");
                    assert.deepStrictEqual(del.map((c) => [Number(c.params.chat_id), Number(c.params.receiver_user_id), Number(c.params.ephemeral_message_id)]), [[APPROVED_GROUP, u, noteId]]);
                    assert.deepStrictEqual(answers(h), ["undefined"], "a plain answer, no text");
                    h.calls.length = 0;
                    await h.sendText(`/start k_${id}`, { userId: u });
                    await settle();
                    assert.strictEqual(text(sends(h)[0]), T("catchupNothingLeft"));
                    console.log("  [OK] (cu7) No thanks drops the items, deletes the note; the link then says nothing is left.");
                }

                // (cu8) two different items opening with the same line are both added
                {
                    const { h } = boot();
                    const u = await deliveredSeller(h, [item(51, "למכירה", "למכירה\nGlock 17 100"), item(52, "למכירה", "למכירה\nVest tactical 250")]);
                    const id = await memberIdOf(u);
                    h.calls.length = 0;
                    await h.pressButton(`ck_${id}_51`, { userId: u, messageId: 55 });
                    await h.pressButton(`ck_${id}_52`, { userId: u, messageId: 55 });
                    await settle();
                    assert.deepStrictEqual(answers(h), [T("captureAddedToast"), T("captureAddedToast")]);
                    assert.strictEqual(await Listing.countDocuments({ sellerId: String(u), origin: "catchup" }), 2, "same first line, different text: two listings");
                    console.log("  [OK] (cu8) items sharing a first line but not their text are both listed.");
                }

                // (cu9) a forged ck_ button against an offer that was never delivered changes nothing
                {
                    const { h } = boot();
                    const u = user();
                    await memberRepository.importCatchup(String(u), [item(61, "Glock", "Glock 17 100")], new Date());
                    const id = await memberIdOf(u);
                    h.calls.length = 0;
                    await h.pressButton(`ck_${id}_61`, { userId: u, messageId: 55 });
                    await settle();
                    assert.deepStrictEqual(answers(h), [T("staleButton")]);
                    assert.strictEqual((await memberOf(u))!.pendingCatchup?.length, 1, "the item is still offered");
                    assert.strictEqual(await Listing.countDocuments({ sellerId: String(u) }), 0, "no listing");
                    console.log("  [OK] (cu9) a forged add against an undelivered offer is refused.");
                }
            } finally {
                globalThis.fetch = realFetch;
                if (realToken === undefined) delete process.env.BOT_TOKEN;
            }
        })();

        console.log("[OK] persistent flows.");
    } finally {
        Object.assign(cfg, original);
        const ids = userIds.map(String);
        await User.deleteMany({ userId: { $in: ids } });
        await Post.deleteMany({ $or: [{ userId: { $in: ids } }, { _id: { $in: postIds } }] });
        await Draft.deleteMany({ userId: { $in: ids } });
        await Listing.deleteMany({ sellerId: { $in: ids } });
        await Capture.deleteMany({ senderId: { $in: ids } });
        await Member.deleteMany({ userId: { $in: ids } });
        await mongoose.connection.db!.collection<{ _id: string }>("bot_sessions").deleteMany({ _id: { $regex: `:(${ids.join("|")})$` } });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkFlows failed:", err);
    process.exit(1);
});
