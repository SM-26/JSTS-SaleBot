import "dotenv/config";
import { inspect } from "util";
import mongoose from "mongoose";
import { Bot } from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api/types";
import { isTestBotToken, isTestDbUri, TEST_BOT_ID_PREFIX } from "./testBot";

// Manual end-to-end run of the buyer side against the TEST bot and TEST groups:
// "wanted" post -> window -> private note -> seeded matching listing -> saved-search alert -> cleanup.
// Not part of `pnpm test`. It sends ONE real private note (approved group, ephemeral) and ONE
// DM alert to the owner, and removes both at the end. Nothing public is posted.
//
//   DOTENV_CONFIG_PATH=<.env with the test token> MONGO_URI=<throwaway db> \
//     pnpm exec ts-node src/tests/syntheticBuyer.ts
//
// config.json must be the test-group config (the controller reads it at import time);
// buyerMatches "on" and captureMode are set in memory only.
// The real token is used, but the fetch wrapper lets only the calls below reach Telegram;
// anything else, or a public message in the approved group, is recorded as a violation,
// never sent, and fails the run.
const APPROVED = -1002445943058;
const APPROVED_TOPIC = 73;
const MOD = -1002474192098;
const MOD_TOPIC = 15;
const OWNER = 278683632;
const SELLER = "synthetic-seller";
const WANTED = "מחפש גלוק 17 עד 800";

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

    // config.json is read at import time, so load the controller after the checks above.
    const { BotController } = await import("../controllers/botController");
    const { tick } = await import("../services/shadowService");
    const { default: savedSearchRepository } = await import("../repositories/savedSearchRepository");
    const { parseQuery } = await import("../services/matchService");
    const { default: AlertLog } = await import("../models/AlertLog");
    const { default: Capture } = await import("../models/Capture");
    const { default: Listing } = await import("../models/Listing");
    const { default: Member } = await import("../models/Member");
    const { default: SavedSearch } = await import("../models/SavedSearch");
    const { default: ShadowLog } = await import("../models/ShadowLog");
    const { default: User } = await import("../models/User");

    const calls: Call[] = [];
    const violations: string[] = [];
    // a Telegram error can carry the request URL, which contains the token
    const scrub = (text: string): string => token ? text.replaceAll(token, "<token>") : text;
    for (const level of ["warn", "error"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => original(...args.map(a => scrub(typeof a === "string" ? a : inspect(a))));
    }

    const wrappedFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.split("/").pop()!.split("?")[0];
        // Requests without files are urlencoded (URLSearchParams); anything else is not read and fails closed.
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
        const chat = body.has("chat_id") ? Number(body.get("chat_id")) : undefined;
        const topic = body.has("message_thread_id") ? Number(body.get("message_thread_id")) : undefined;
        const ephemeral = body.has("ephemeral_message_parameters");
        const allowed =
            method === "getMe" || method === "getChat" ||
            (method === "sendMessage" && ((chat === APPROVED && ephemeral) || chat === OWNER)) ||
            ((method === "editEphemeralMessageText" || method === "deleteEphemeralMessage") && chat === APPROVED) ||
            (method === "deleteMessage" && chat === OWNER);
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
    const controller = new BotController(bot.api);
    const cfg = controller.config;
    // before any network call or database connection
    if (cfg.approvedGroupId !== APPROVED || Number(cfg.approvedTopicId) !== APPROVED_TOPIC ||
        cfg.moderationGroupId !== MOD || Number(cfg.moderationTopicId) !== MOD_TOPIC) {
        console.error("[FAIL] config.json is not the test-group config (approved/moderation group and topic); refusing to run.");
        return 1;
    }
    await mongoose.connect(uri!);
    const me = await bot.api.getMe();
    cfg.captureMode = "shadow";
    cfg.buyerMatches = "on";
    controller.registerRoutes(bot, me.username!);

    const sender = String(OWNER);
    const wipe = async (): Promise<void> => {
        await Capture.deleteMany({ senderId: sender });
        await Listing.deleteMany({ sellerId: SELLER });
        await Member.deleteMany({ userId: sender });
        await ShadowLog.deleteMany({ senderId: sender });
        await SavedSearch.deleteMany({ userId: sender });
        await AlertLog.deleteMany({ userId: sender });
        await User.deleteMany({ userId: sender });
    };
    await wipe(); // throwaway db: leftovers must not skew this run

    let failed = 0;
    const step = (n: number, name: string, ok: boolean, detail = ""): boolean => {
        if (!ok) failed++;
        console.log(`${ok ? "[OK]  " : "[FAIL]"} step ${n}: ${name}${detail ? ` (${detail})` : ""}`);
        return ok;
    };

    const messageId = 1_000_000 + (Date.now() % 1_000_000);
    let noteId: number | undefined;
    let alertId: number | undefined;

    try {
        // 1. a "wanted" post from the owner in the sale topic
        await bot.handleUpdate({
            update_id: 1,
            message: {
                message_id: messageId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: APPROVED, type: "supergroup", is_forum: true },
                from: { id: OWNER, is_bot: false, first_name: "Owner" },
                message_thread_id: APPROVED_TOPIC,
                is_topic_message: true,
                text: WANTED,
            },
        } as Update);
        const recorded = await Capture.findOne({ senderId: sender, messageIds: messageId });
        if (!step(1, "wanted post recorded as a capture", recorded !== null, `state ${recorded?.state}`)) return 1;

        // 2. the window closes, the sweeper classifies, the buyer note goes out
        await tick(cfg, new Date(Date.now() + 120_000), (event, now) => controller.buyerNotes.onClassified(event, now));
        const row = await ShadowLog.findOne({ senderId: sender, tier: "wtb" });
        const send = calls.find(c => c.method === "sendMessage" && c.chat === APPROVED);
        noteId = (send?.result as { ephemeral_message_id?: number } | undefined)?.ephemeral_message_id;
        console.log(`      note send: ok ${send?.ok}, topic ${send?.topic ?? "-"}`);
        if (!step(2, "classified as wtb, one private note sent", row !== null && send?.ok === true && typeof noteId === "number" && !!row.buyerNoteAt, `tier ${row?.tier}, note ${noteId}`)) return 1;

        // 3. a saved search for the owner and a matching bot listing (nothing public), then the alert tick
        const now = new Date();
        await savedSearchRepository.upsert(sender, parseQuery(WANTED), new Date(now.getTime() - 60_000));
        await Listing.create({
            source: "bot", origin: "dm", messageIds: [], sellerId: SELLER, title: "גלוק 17", text: "גלוק 17 למכירה", price: "700", priceValue: 700,
            media: [], status: "live", hold: false, isBundle: false, createdAt: now, refreshedAt: now,
        });
        await controller.alerts.tick(new Date());
        const dm = calls.find(c => c.method === "sendMessage" && c.chat === OWNER);
        alertId = (dm?.result as { message_id?: number } | undefined)?.message_id;
        step(3, "alert DM sent to the owner", dm?.ok === true && typeof alertId === "number", `ok ${dm?.ok}, id ${alertId}`);
    } finally {
        // 4. clean up, also after a failure
        let cleaned = true;
        const detail: string[] = [];
        // ids from what Telegram answered, so a throw before they were stored still cleans up
        noteId ??= (calls.find(c => c.method === "sendMessage" && c.chat === APPROVED)?.result as { ephemeral_message_id?: number } | undefined)?.ephemeral_message_id;
        alertId ??= (calls.find(c => c.method === "sendMessage" && c.chat === OWNER)?.result as { message_id?: number } | undefined)?.message_id;
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
        if (typeof alertId === "number") {
            try {
                const ok = await bot.api.deleteMessage({ chat_id: OWNER, message_id: alertId });
                detail.push(`alert deleted ${ok}`);
                cleaned &&= ok;
            } catch (err) {
                detail.push(`alert delete failed: ${(err as Error).message}`);
                cleaned = false;
            }
        }
        await wipe();
        const left = (await Capture.countDocuments({ senderId: sender })) + (await Listing.countDocuments({ sellerId: SELLER })) + (await SavedSearch.countDocuments({ userId: sender }));
        step(4, "cleanup: note, alert and Mongo rows removed", cleaned && left === 0, detail.join(", "));
        // on every exit path, early returns included
        for (const c of calls) console.log(`sent ${c.method} chat ${c.chat ?? "-"} topic ${c.topic ?? "-"} ${c.ok ? "ok" : "FAILED"}`);
        if (violations.length) console.log(`[FAIL] blocked: ${violations.join(", ")}`);
    }

    return failed || violations.length ? 1 : 0;
}

main().then(code => process.exit(code), err => {
    // a Telegram error can carry the request URL, which contains the token
    const token = process.env.BOT_TOKEN;
    const text = String(err);
    console.error("[FAIL]", token ? text.replaceAll(token, "<token>") : text);
    process.exit(1);
});
