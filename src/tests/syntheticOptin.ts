import "dotenv/config";
import mongoose from "mongoose";
import { Bot } from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api/types";
import { isTestBotToken, isTestDbUri, TEST_BOT_ID_PREFIX } from "./testBot";

// Manual end-to-end run of the opt-in capture note against the TEST bot and TEST groups:
// sale post -> window -> private note -> Add (mk_) -> take-down card -> Remove (ls_) -> cleanup.
// Not part of `pnpm test`. It sends ONE real private note to the owner and ONE card to the
// moderation topic, and removes both at the end.
//
//   DOTENV_CONFIG_PATH=<.env with the test token> MONGO_URI=<throwaway db> \
//     pnpm exec ts-node src/tests/syntheticOptin.ts
//
// config.json must be the test-group config (the controller reads it at import time).
// The real token is used, but the fetch wrapper lets only the calls below reach Telegram;
// answerCallbackQuery is faked (callback ids are not real); anything else, or a public
// message in the approved group, is recorded as a violation, never sent, and fails the run.
const APPROVED = -1002445943058;
const APPROVED_TOPIC = 73;
const MOD = -1002474192098;
const MOD_TOPIC = 15;
const OWNER = 278683632;
const TEXT = "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז";
// the first TEST_MEDIA photo of testCases.ts (file ids are reusable within the same bot)
const PHOTO = "AgACAgQAAxkBAAINXGm-_OK_AAH4GQnBW-0HVvslh49hbgACsg1rGy28-FEImRX00Ng_2AEAAwIAA3kAAzoE";

interface Call { method: string; chat?: number; topic?: number; ok: boolean; description?: string; result?: unknown }

async function main(): Promise<number> {
    const token = process.env.BOT_TOKEN ?? "";
    if (!isTestBotToken(token)) {
        console.error(`[FAIL] BOT_TOKEN must belong to the test bot (prefix ${TEST_BOT_ID_PREFIX}); refusing to run.`);
        return 1;
    }
    const uri = process.env.MONGO_URI;
    if (!isTestDbUri(uri)) {
        console.error('[FAIL] MONGO_URI must name a throwaway database (the db path must contain "test"); refusing to connect.');
        return 1;
    }
    await mongoose.connect(uri!);

    // config.json is read at import time, so load the controller after the checks above.
    const { BotController } = await import("../controllers/botController");
    const { tick } = await import("../services/shadowService");
    const { default: Capture } = await import("../models/Capture");
    const { default: Listing } = await import("../models/Listing");
    const { default: Member } = await import("../models/Member");
    const { default: ShadowLog } = await import("../models/ShadowLog");
    const { default: User } = await import("../models/User");

    const calls: Call[] = [];
    const violations: string[] = [];
    const logged: string[] = []; // console.warn / console.error lines, to catch [WARN - ephemeralNotes.edit]
    for (const level of ["warn", "error"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); original(...args); };
    }

    const wrappedFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.split("/").pop()!.split("?")[0];
        if (method === "answerCallbackQuery") {
            return new Response(JSON.stringify({ ok: true, result: true }), { headers: { "content-type": "application/json" } });
        }
        // Requests without files are urlencoded (URLSearchParams); anything else is not read and fails closed.
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
        const chat = body.has("chat_id") ? Number(body.get("chat_id")) : undefined;
        const topic = body.has("message_thread_id") ? Number(body.get("message_thread_id")) : undefined;
        const ephemeral = body.has("ephemeral_message_parameters");
        const allowed =
            method === "getMe" || method === "getChat" ||
            (method === "sendMessage" && ((chat === APPROVED && ephemeral) || chat === MOD)) ||
            ((method === "editEphemeralMessageText" || method === "deleteEphemeralMessage") && chat === APPROVED) ||
            (method === "deleteMessage" && chat === MOD);
        if (!allowed) {
            violations.push(`${method} to ${chat === undefined ? "an unreadable chat" : chat}${chat === APPROVED && !ephemeral ? " (public)" : ""}`);
            throw new Error(`blocked Telegram call: ${method}`);
        }
        const res = await fetch(input, init);
        const json = await res.clone().json().catch(() => ({})) as { ok?: boolean; description?: string; result?: unknown };
        const call: Call = { method, chat, topic, ok: json.ok === true, description: json.description, result: json.result };
        calls.push(call);
        if (!call.ok) console.log(`[TG-ERR] ${method} chat ${chat}: ${json.description}`);
        return res;
    };

    const bot = new Bot(token, { fetch: wrappedFetch });
    const me = await bot.api.getMe();
    const controller = new BotController(bot.api);
    const cfg = controller.config;
    if (cfg.approvedGroupId !== APPROVED || Number(cfg.approvedTopicId) !== APPROVED_TOPIC ||
        cfg.moderationGroupId !== MOD || Number(cfg.moderationTopicId) !== MOD_TOPIC) {
        console.error("[FAIL] config.json is not the test-group config (approved/moderation group and topic); refusing to run.");
        return 1;
    }
    cfg.captureMode = "optin";
    cfg.buyerMatches = "off";
    controller.registerRoutes(bot, me.username!);

    const sender = String(OWNER);
    const wipe = async (): Promise<void> => {
        await Capture.deleteMany({ senderId: sender });
        await Listing.deleteMany({ sellerId: sender });
        await Member.deleteMany({ userId: sender });
        await ShadowLog.deleteMany({ senderId: sender });
        await User.deleteMany({ userId: sender });
    };
    await wipe(); // throwaway db: leftovers must not skew this run

    let failed = 0;
    const step = (n: number, name: string, ok: boolean, detail = ""): boolean => {
        if (!ok) failed++;
        console.log(`${ok ? "[OK]  " : "[FAIL]"} step ${n}: ${name}${detail ? ` (${detail})` : ""}`);
        return ok;
    };

    let updateId = 1;
    const messageId = 1_000_000 + (Date.now() % 1_000_000);
    let noteId: number | undefined;
    let modCardId: number | undefined;

    try {
        // 1. a sale post from the owner in the sale topic
        await bot.handleUpdate({
            update_id: updateId++,
            message: {
                message_id: messageId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: APPROVED, type: "supergroup", is_forum: true },
                from: { id: OWNER, is_bot: false, first_name: "Owner" },
                message_thread_id: APPROVED_TOPIC,
                is_topic_message: true,
                photo: [{ file_id: PHOTO, file_unique_id: `u${messageId}`, width: 10, height: 10 }],
                caption: TEXT,
            },
        } as Update);
        const recorded = await Capture.findOne({ senderId: sender, messageIds: messageId });
        if (!step(1, "sale post recorded as a capture", recorded !== null, `state ${recorded?.state}`)) return 1;
        const captureId = String(recorded!._id);

        // 2. the window closes, the sweeper classifies, the note goes out
        await tick(cfg, new Date(Date.now() + 120_000), (event, now) => controller.captureNotes.onClassified(event, now));
        const asked = await Capture.findById(captureId);
        noteId = asked?.note?.ephemeralMessageId;
        const send = calls.find(c => c.method === "sendMessage" && c.chat === APPROVED);
        console.log(`      note send: ok ${send?.ok}, topic ${send?.topic ?? "-"}, result keys ${Object.keys((send?.result as object | undefined) ?? {}).join(",")}`);
        if (!step(2, "capture is asked and the note id is stored", asked?.state === "asked" && typeof noteId === "number", `state ${asked?.state}, note ${noteId}, kind ${asked?.note?.kind}`)) return 1;

        // 3. Add, with no `message` on the callback (as the real press may carry none)
        const editsBefore = calls.filter(c => c.method === "editEphemeralMessageText").length;
        const warnsBefore = logged.length;
        await bot.handleUpdate({
            update_id: updateId++,
            callback_query: { id: "synthetic-add", from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "synthetic", data: `mk_${captureId}_a` },
        } as Update);
        const listing = await Listing.findOne({ sellerId: sender });
        const edit = calls.filter(c => c.method === "editEphemeralMessageText").slice(editsBefore)[0];
        const warn = logged.slice(warnsBefore).find(l => l.includes("[WARN - ephemeralNotes.edit]"));
        const card = calls.find(c => c.method === "sendMessage" && c.chat === MOD);
        modCardId = (card?.result as { message_id?: number } | undefined)?.message_id;
        step(3, "Add: listing created, note edited, take-down card in the moderation topic",
            listing !== null && edit?.ok === true && !warn && card?.ok === true && card.topic === MOD_TOPIC,
            `listing ${listing?.status}, edit ok ${edit?.ok}${warn ? `, ${warn}` : ""}, card ${card?.ok ? `topic ${card.topic} id ${modCardId}` : "missing"}`);
        if (!listing) return 1;

        // 4. Remove from the note surface
        const edits3 = calls.filter(c => c.method === "editEphemeralMessageText").length;
        const warns3 = logged.length;
        await bot.handleUpdate({
            update_id: updateId++,
            callback_query: { id: "synthetic-remove", from: { id: OWNER, is_bot: false, first_name: "Owner" }, chat_instance: "synthetic", data: `ls_${listing._id}_r_n` },
        } as Update);
        const removed = await Listing.findById(listing._id);
        const edit4 = calls.filter(c => c.method === "editEphemeralMessageText").slice(edits3)[0];
        const warn4 = logged.slice(warns3).find(l => l.includes("[WARN - ephemeralNotes.edit]"));
        step(4, "Remove: listing removed, note edited", removed?.status === "removed" && edit4?.ok === true && !warn4,
            `listing ${removed?.status}, edit ok ${edit4?.ok}${warn4 ? `, ${warn4}` : ""}`);
    } finally {
        // 5. clean up, also after a failure
        let cleaned = true;
        const detail: string[] = [];
        if (typeof noteId === "number") {
            try {
                const ok = await bot.api.deleteEphemeralMessage({ chat_id: APPROVED, receiver_user_id: OWNER, ephemeral_message_id: noteId });
                detail.push(`note deleted ${ok}`);
                cleaned &&= ok;
            } catch (err) {
                detail.push(`note delete failed: ${(err as Error).message}`);
                cleaned = false;
            }
        }
        if (typeof modCardId === "number") {
            try {
                const ok = await bot.api.deleteMessage({ chat_id: MOD, message_id: modCardId });
                detail.push(`card deleted ${ok}`);
                cleaned &&= ok;
            } catch (err) {
                detail.push(`card delete failed: ${(err as Error).message}`);
                cleaned = false;
            }
        }
        await wipe();
        const left = (await Capture.countDocuments({ senderId: sender })) + (await Listing.countDocuments({ sellerId: sender }));
        step(5, "cleanup: note, card and Mongo rows removed", cleaned && left === 0, detail.join(", "));
    }

    for (const c of calls) console.log(`sent ${c.method} chat ${c.chat ?? "-"} topic ${c.topic ?? "-"} ${c.ok ? "ok" : "FAILED"}`);
    if (violations.length) console.log(`[FAIL] blocked: ${violations.join(", ")}`);
    return failed || violations.length ? 1 : 0;
}

main().then(code => process.exit(code), err => {
    // a Telegram error can carry the request URL, which contains the token
    const token = process.env.BOT_TOKEN;
    const text = String(err);
    console.error("[FAIL]", token ? text.replaceAll(token, "<token>") : text);
    process.exit(1);
});
