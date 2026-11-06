import "dotenv/config";
import mongoose from "mongoose";
import { Bot } from "node-telegram-bot-api";
import { isTestBotToken, isTestDbUri, TEST_BOT_ID_PREFIX } from "./testBot";

// Manual run of the lifecycle DMs against the TEST bot: one stale-check DM and one nudge DM to the owner.
// Not part of `pnpm test`.
//
//   DOTENV_CONFIG_PATH=<.env with the test token> MONGO_URI=<throwaway db> \
//     pnpm exec ts-node src/tests/syntheticLifecycle.ts
//
// config.json is read at import time. The fetch wrapper lets only getMe and sendMessage to OWNER
// through; anything else is recorded as a violation, never sent, and fails the run.
const OWNER = 278683632;
const DAY_MS = 24 * 3600 * 1000;

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

    // config.json is read at import time, so load these after the checks above.
    const { BotController } = await import("../controllers/botController");
    const { StaleCheckService } = await import("../services/staleCheckService");
    const { default: listingRepository } = await import("../repositories/listingRepository");
    const { default: postRepository } = await import("../repositories/postRepository");

    const violations: string[] = [];
    const sent: string[] = [];
    const wrappedFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.split("/").pop()!.split("?")[0];
        // The library sends a file-less request as URLSearchParams (core/encode.js); a string or Blob is
        // read the same way. Anything else (a multipart stream) is unreadable and fails closed.
        const raw = init?.body;
        const body = raw instanceof URLSearchParams ? raw
            : typeof raw === "string" ? new URLSearchParams(raw)
            : raw instanceof Blob ? new URLSearchParams(await raw.text())
            : new URLSearchParams();
        const chat = body.has("chat_id") ? Number(body.get("chat_id")) : undefined;
        if (!(method === "getMe" || (method === "sendMessage" && chat === OWNER))) {
            violations.push(`${method} to ${chat === undefined ? "an unreadable chat" : chat}`);
            throw new Error(`blocked Telegram call: ${method}`);
        }
        if (method === "sendMessage") sent.push(method);
        return fetch(input, init);
    };

    const bot = new Bot(token, { fetch: wrappedFetch });
    const controller = new BotController(bot.api);
    const cfg = controller.config;
    await mongoose.connect(uri!);
    cfg.nudges = true;

    const sellerId = String(OWNER);
    let failed = 0;
    const check = (name: string, ok: boolean, detail = ""): void => {
        if (!ok) failed++;
        console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` (${detail})` : ""}`);
    };
    const postIds: string[] = [];
    const listingIds: string[] = [];

    try {
        const now = new Date();
        const media = [{ fileId: "x", type: "photo" as const }];
        const seed = async (title: string, origin: "dm" | "legacy", hold: boolean, age: number) => {
            const created = new Date(now.getTime() - age * DAY_MS);
            const post = await postRepository.createPost({
                userId: sellerId, title, description: "synthetic", price: "100", location: "test", media,
                status: "approved", approvedMessageId: null, createdAt: created,
            });
            postIds.push(String(post._id));
            const listing = await listingRepository.createForPost(post, origin, hold, now);
            listingIds.push(String(listing._id));
            return listing;
        };
        await seed("[synthetic] stale 1", "legacy", true, 40);
        await seed("[synthetic] stale 2", "legacy", true, 41);
        const live = await seed("[synthetic] live", "dm", false, 0);
        await listingRepository.setClockForTest(String(live._id), new Date(now.getTime() - 7 * DAY_MS));

        const report = await new StaleCheckService(bot.api, cfg).run([sellerId], new Date());
        check("stale-check sent one DM with two listings", report.sellersSent === 1 && report.listingsSent === 2, JSON.stringify(report));

        // the aged listing only: the global tick could DM other sellers
        const nudge = await controller.lifecycle.nudgeOne(live, new Date());
        check("nudge sent for the aged listing", nudge === "sent", nudge);

        const refreshed = await controller.lifecycle.refreshListing(String(live._id), sellerId, new Date());
        const afterRefresh = await listingRepository.findById(String(live._id));
        check("refresh: live, no staleSentAt", refreshed.outcome === "ok" && afterRefresh?.status === "live" && !afterRefresh.staleSentAt);

        const sold = await controller.lifecycle.sellListing(String(live._id), sellerId, new Date());
        const afterSold = await listingRepository.findById(String(live._id));
        const soldPost = await postRepository.findById(postIds[2]);
        check("sold: listing and post sold", sold.outcome === "ok" && afterSold?.status === "sold" && soldPost?.status === "sold");
    } finally {
        for (const l of listingIds) await listingRepository.deleteById(l).catch(() => undefined);
        for (const p of postIds) await postRepository.deleteById(p);
        console.log(`sent ${sent.length} DM(s) to the owner`);
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
