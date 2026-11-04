import "dotenv/config";
import mongoose from "mongoose";
import { Bot } from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api/types";
import { AuthLevel } from "../types";

// Manual end-to-end run of the preset reject flow (card -> reject_ -> prompt with four
// preset buttons -> rr_<id>_1 -> edited prompt + DM to the author) against the TEST bot
// and the TEST groups. Not part of `pnpm test`.
//
//   DOTENV_CONFIG_PATH=<.env with the test token> MONGO_URI=<throwaway db> \
//     pnpm exec ts-node src/tests/syntheticModeration.ts
//
// config.json must be the test-group config (the controller reads it at import time).
// The real token is used, but the fetch wrapper lets only the methods below reach
// Telegram; answerCallbackQuery is faked (callback ids are not real); anything else
// is recorded as a violation, never sent, and fails the run.
const TEST_BOT_PREFIX = "9299714864:";
const MOD_GROUP = -1002474192098;
const MOD_TOPIC = 15;
const APPROVED_GROUP = -1002445943058;
const APPROVED_TOPIC = 73;
const OWNER = 278683632;
const ALLOWED = new Set(["getMe", "sendRichMessage", "sendMessage", "editMessageText", "editMessageReplyMarkup"]);
const PHOTO = "AgACAgQAAyEGAASRyiESAAIBaWrrdLCnO5_7O2IBhJgi88eq-bjkAAJUD2sbuaNZU5XHhK251RGCAQADAgADeQADPQQ";

interface Sent { method: string; chat: number | undefined; topic: number | undefined; messageId: number | undefined; ok: boolean }

async function main(): Promise<number> {
    const token = process.env.BOT_TOKEN ?? "";
    if (!token.startsWith(TEST_BOT_PREFIX)) {
        console.error(`[FAIL] BOT_TOKEN must belong to the test bot (prefix ${TEST_BOT_PREFIX}); refusing to run.`);
        return 1;
    }
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error("[FAIL] set MONGO_URI to a throwaway database.");
        return 1;
    }
    await mongoose.connect(uri);
    if (!/test/i.test(mongoose.connection.name)) {
        console.error(`[FAIL] refusing to run on database "${mongoose.connection.name}" (name must contain "test").`);
        return 1;
    }

    // config.json is read at import time, so load the controller after the checks above.
    const { BotController } = await import("../controllers/botController");
    const { localeService } = await import("../services/localeService");
    const { default: postRepository } = await import("../repositories/postRepository");
    const { default: userRepository } = await import("../repositories/userRepository");
    const { PostService } = await import("../services/postService");

    const sent: Sent[] = [];
    const violations: string[] = [];
    const wrappedFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.split("/").pop()!.split("?")[0];
        if (method === "answerCallbackQuery") {
            return new Response(JSON.stringify({ ok: true, result: true }), { headers: { "content-type": "application/json" } });
        }
        if (!ALLOWED.has(method)) {
            violations.push(method);
            throw new Error(`blocked Telegram call: ${method}`);
        }
        // Requests without files are urlencoded (URLSearchParams); anything else is not read and fails closed.
        const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
        const isSend = method === "sendRichMessage" || method === "sendMessage";
        const chat = body.has("chat_id") ? Number(body.get("chat_id")) : undefined;
        const topic = body.has("message_thread_id") ? Number(body.get("message_thread_id")) : undefined;
        if (isSend && (chat === undefined || chat === APPROVED_GROUP)) {
            violations.push(`${method} to ${chat === undefined ? "an unreadable chat" : "the approved group"}`);
            throw new Error("blocked: the approved group must stay untouched");
        }
        const res = await fetch(input, init);
        if (isSend) {
            const json = await res.clone().json().catch(() => ({})) as { ok?: boolean; result?: { message_id?: number } };
            sent.push({
                method,
                chat,
                topic,
                messageId: json.result?.message_id,
                ok: json.ok === true,
            });
        }
        return res;
    };

    const bot = new Bot(token, { fetch: wrappedFetch });
    const me = await bot.api.getMe();
    const controller = new BotController(bot.api);
    const cfg = controller.config;
    cfg.moderationGroupId = MOD_GROUP;
    cfg.moderationTopicId = MOD_TOPIC;
    cfg.approvedGroupId = APPROVED_GROUP;
    cfg.approvedTopicId = APPROVED_TOPIC;
    cfg.rulesUrl = "";
    controller.registerRoutes(bot, me.username!);

    // The owner is both the moderator and the post's author.
    await userRepository.upsertUserWithInsert(String(OWNER), { firstName: "Owner", authLevel: AuthLevel.MOD }, { userId: String(OWNER) });
    const post = await postRepository.createPost({
        userId: String(OWNER),
        title: "מכשיר קשר",
        description: "באופנג UV-5R\nחדש באריזה",
        price: "270",
        location: "בית דגן",
        media: [{ fileId: PHOTO, type: "photo" }],
        createdAt: new Date(),
    });
    const postId = String(post._id);

    const cardId = await new PostService(bot.api, cfg).sendToModeration(postId, {
        title: post.title, description: post.description, price: post.price, location: post.location,
        media: post.media, userId: OWNER, firstName: "Owner",
    });
    if (!cardId) {
        console.error("[FAIL] the moderation card was not sent.");
        return 1;
    }

    let updateId = 1;
    const callback = (data: string, messageId: number) => bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
            id: `synthetic-${updateId}`,
            from: { id: OWNER, is_bot: false, first_name: "Owner" },
            chat_instance: "synthetic",
            data,
            message: {
                message_id: messageId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: MOD_GROUP, type: "supergroup", is_forum: true },
                message_thread_id: MOD_TOPIC,
                is_topic_message: true,
            },
        },
    } as Update);

    await callback(`reject_${postId}`, cardId);
    const prompt = sent.filter(s => s.method === "sendMessage" && s.chat === MOD_GROUP && s.topic === MOD_TOPIC && s.ok).pop();
    if (!prompt?.messageId) {
        console.error("[FAIL] no reject prompt in the moderation topic.");
        return 1;
    }
    await callback(`rr_${postId}_1`, prompt.messageId);

    const after = await postRepository.findById(postId);
    const expected = localeService.t(cfg.lang, "rejectPreset1");
    const dm = sent.find(s => s.method === "sendMessage" && s.chat === OWNER);

    for (const s of sent) console.log(`sent ${s.method} chat ${s.chat} topic ${s.topic ?? "-"} message ${s.messageId ?? "-"} ${s.ok ? "ok" : "FAILED"}`);
    const checks: Array<[string, boolean]> = [
        [`post is rejected (${after?.status})`, after?.status === "rejected"],
        [`rejectionReason is the preset 1 text (${JSON.stringify(after?.rejectionReason)})`, after?.rejectionReason === expected],
        ["DM to the author succeeded", dm?.ok === true],
        ["nothing went to the approved group", !violations.length],
    ];
    for (const [name, ok] of checks) console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name}`);
    if (violations.length) console.log(`blocked: ${violations.join(", ")}`);
    return checks.every(([, ok]) => ok) ? 0 : 1;
}

main().then(code => process.exit(code), err => {
    // a Telegram error can carry the request URL, which contains the token
    const token = process.env.BOT_TOKEN;
    const text = String(err);
    console.error("[FAIL]", token ? text.replaceAll(token, "<token>") : text);
    process.exit(1);
});
