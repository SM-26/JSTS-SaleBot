import "dotenv/config";
import mongoose from "mongoose";
import { Bot } from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api/types";
import type { Tier } from "../services/classifier";

// Manual end-to-end run of capture -> window -> classify -> shadow_log against
// the TEST bot and TEST group, with nothing sent anywhere. Not part of `pnpm test`.
//
//   DOTENV_CONFIG_PATH=<.env with the test token> MONGO_URI=<throwaway db> \
//     pnpm exec ts-node src/tests/syntheticCapture.ts
//
// config.json must be the test-group config (approvedGroupId -1002445943058,
// topic 73): the controller reads it at import time. The real token is used so
// `getMe` works, but the fetch wrapper lets only getMe/getChat reach Telegram;
// any other method is recorded as a violation, never sent, and fails the run.
const TEST_BOT_PREFIX = "9299714864:";
const GROUP = -1002445943058;
const TOPIC = 73;
const SENDER = 278683632;
const ALLOWED = new Set(["getMe", "getChat"]);

// [text, photos, expected tier]; text is the caption when there are photos
const FIXTURES: Array<[string, number, Tier]> = [
    ["גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז", 1, "strict"],
    ['M4 למכירה 900 ש"ח', 1, "strict"],
    ["מוכר וסט ב-250 כמו חדש", 1, "strict"],
    ["למכירה\nM4 900₪\nגלוק 600₪", 1, "strict"],
    ["M4 למכירה מחיר 900₪", 1, "strict"],
    ["למכירה וסט ב-250 כמו חדש", 2, "strict"], // album: two photos, one caption
    ["מחפש M4 עד 800₪", 1, "wtb"],
    ["WTB glock 19", 0, "wtb"],
    ["שלום, מחפש M4", 0, "wtb"],
    ["🔥 מחפש גלוק", 0, "wtb"],
    ["מישהו מוכר ווסט?", 0, "wtb"],
    ["1300 מרכז", 1, "ask"],
    ["למכירה כוונת 300₪", 0, "ask"],
    ["גלוק 17 למכירה 900", 1, "ask"],
    ["כוונת 300₪", 0, "none"],
    ["תמונה\nמחפש משהו", 1, "none"],
    ["", 1, "none"], // photo only
    ["מישהו יודע מתי המשחק?", 0, "none"],
    ["מוכר נשק 500₪", 1, "none"], // blocked word
    ["למכירה 0501234567", 1, "none"], // a phone number is no price
];

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
    const { tick } = await import("../services/shadowService");
    const { default: shadowLogRepository } = await import("../repositories/shadowLogRepository");
    const { default: Capture } = await import("../models/Capture");

    const violations: string[] = [];
    const guardedFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.split("/").pop()!.split("?")[0];
        if (!ALLOWED.has(method)) {
            violations.push(method);
            throw new Error(`blocked Telegram call: ${method}`);
        }
        return fetch(input, init);
    };
    const bot = new Bot(token, { fetch: guardedFetch });
    const me = await bot.api.getMe();
    const controller = new BotController(bot.api);
    if (controller.config.approvedGroupId !== GROUP || Number(controller.config.approvedTopicId) !== TOPIC) {
        console.error("[FAIL] config.json is not the test-group config (approvedGroupId/approvedTopicId); refusing to run.");
        return 1;
    }
    controller.config.captureMode = "shadow";
    controller.config.buyerMatches = "shadow";
    controller.registerRoutes(bot, me.username!);

    await Capture.deleteMany({}); // throwaway db: leftovers must not be claimed by this run
    let updateId = 1;
    let messageId = 1_000_000 + (Date.now() % 1_000_000);
    const send = (text: string, photo: boolean, mediaGroupId?: string) => {
        const id = messageId++;
        const update = {
            update_id: updateId++,
            message: {
                message_id: id,
                date: Math.floor(Date.now() / 1000),
                chat: { id: GROUP, type: "supergroup", is_forum: true },
                from: { id: SENDER, is_bot: false, first_name: "Synthetic" },
                message_thread_id: TOPIC,
                is_topic_message: true,
                ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
                ...(photo
                    ? { photo: [{ file_id: `synthetic-${id}`, file_unique_id: `u${id}`, width: 10, height: 10 }], ...(text ? { caption: text } : {}) }
                    : { text }),
            },
        } as Update;
        return bot.handleUpdate(update).then(() => id);
    };

    let bad = 0;
    for (const [n, [text, photos, expected]] of FIXTURES.entries()) {
        const group = photos > 1 ? `synthetic-${n}` : undefined;
        const first = await send(text, photos > 0, group);
        for (let i = 1; i < photos; i++) await send("", true, group);
        // one sender, so close this window before the next fixture: the clock runs 2 minutes ahead
        await tick(controller.config, new Date(Date.now() + 120_000));
        const [row] = await shadowLogRepository.lastRows(1);
        const got = row?.messageIds.includes(first) ? row.tier : "(no row)";
        const ok = got === expected;
        if (!ok) bad++;
        console.log(`${ok ? "[OK]  " : "[FAIL]"} ${String(n + 1).padStart(2)}  got ${got.padEnd(8)} expected ${expected.padEnd(6)} ${JSON.stringify(text.slice(0, 30))}`);
    }

    console.log(`${FIXTURES.length - bad}/${FIXTURES.length} tiers match; ${violations.length} blocked Telegram call(s)${violations.length ? `: ${violations.join(", ")}` : ""}`);
    return bad || violations.length ? 1 : 0;
}

main().then(code => process.exit(code), err => {
    // a Telegram error can carry the request URL, which contains the token
    const token = process.env.BOT_TOKEN;
    const text = String(err);
    console.error("[FAIL]", token ? text.replaceAll(token, "<token>") : text);
    process.exit(1);
});
