import assert from "assert";
import type { Context } from "tgv2";
import { command, parseCommand } from "../controllers/commands";
import { ensureUserMiddleware, errorBoundary, requireAuthLevel, sessionKey, staleButtonCatchAll } from "../controllers/middleware";
import { createHarness, BOT_USERNAME } from "./harness";
import { AuthLevel } from "../types";

/**
 * Offline checks for the v2 platform modules (command matcher, middleware).
 * Run: pnpm exec ts-node src/tests/checkPlatform.ts
 */

const BOT = BOT_USERNAME;

async function main() {
    console.log("[INFO] Checking parseCommand...");
    assert.deepStrictEqual(parseCommand("/newpost", BOT), { name: "newpost", args: "" });
    for (const t of ["/newPost", "/NEWPOST", "/newpost@JSTS_testing_bot", "/newpost@jsts_TESTING_bot"]) {
        assert.strictEqual(parseCommand(t, BOT)?.name, "newpost", t);
    }
    assert.strictEqual(parseCommand("/newpost@otherbot", BOT), null);
    assert.strictEqual(parseCommand("x /newpost", BOT), null);
    assert.strictEqual(parseCommand("see https://example.com/test now", BOT), null);
    assert.strictEqual(parseCommand("https://example.com/test", BOT), null);
    assert.strictEqual(parseCommand("/newposts", BOT)?.name, "newposts", "name is exact, not a prefix");
    assert.deepStrictEqual(parseCommand("/config key value", BOT), { name: "config", args: "key value" });
    assert.deepStrictEqual(parseCommand("/config@JSTS_testing_bot  a\nb  ", BOT), { name: "config", args: "a\nb" });
    assert.deepStrictEqual(parseCommand("/broadcast hello", BOT), { name: "broadcast", args: "hello" });
    assert.deepStrictEqual(parseCommand("/broadcastUsers hello", BOT), { name: "broadcastusers", args: "hello" });
    assert.strictEqual(parseCommand("", BOT), null);
    assert.strictEqual(parseCommand("/", BOT), null);
    console.log("  [SUCCESS] parseCommand is anchored, case-insensitive and bot-name aware.");

    console.log("[INFO] Checking command() middleware...");
    {
        const h = createHarness();
        const fired: string[] = [];
        h.bot.use(command("newpost", () => BOT, ctx => { fired.push(`newpost:${JSON.stringify(ctx.state.command)}`); }));
        h.bot.use(command("broadcast", () => BOT, () => { fired.push("broadcast"); }));
        h.bot.use(command(["test", "t"], () => BOT, () => { fired.push("test"); }));
        await h.sendText("/NewPost");
        assert.deepStrictEqual(fired, ['newpost:{"name":"newpost","args":""}']);
        fired.length = 0;
        await h.sendText("/newpost@otherbot");
        await h.sendText("look at https://example.com/test");
        await h.sendText("/broadcastUsers hi");
        assert.deepStrictEqual(fired, [], "must not fire for other bots, URLs or longer names");
        await h.sendText("/broadcast hi");
        await h.sendText("/T");
        assert.deepStrictEqual(fired, ["broadcast", "test"]);
    }
    console.log("  [SUCCESS] command() fires only on exact names for our bot.");

    console.log("[INFO] Checking ensureUser middleware...");
    {
        const h = createHarness();
        const seen: number[] = [];
        h.bot.use(ensureUserMiddleware(async from => { seen.push(from.id); }));
        await h.sendText("hi");
        await h.pressButton("anything", { userId: 43 });
        assert.deepStrictEqual(seen, [42, 43]);
        await h.sendText("hello group", { chatId: -100, userId: 44, chatType: "supergroup" });
        assert.deepStrictEqual(seen, [42, 43], "group messages must not call ensureUser");

        // a throwing ensureUser must not block the chain
        const h2 = createHarness();
        let reached = false;
        h2.bot.use(ensureUserMiddleware(async () => { throw new Error("db down"); }));
        h2.bot.use(() => { reached = true; });
        const origError = console.error;
        console.error = () => undefined;
        await h2.sendText("hi");
        console.error = origError;
        assert.ok(reached, "next() must still run after ensureUser throws");
    }
    console.log("  [SUCCESS] ensureUser runs for private messages and buttons only, and never blocks.");

    console.log("[INFO] Checking requireAuthLevel...");
    {
        const h = createHarness();
        const log: string[] = [];
        const guard = requireAuthLevel(
            AuthLevel.ADMIN,
            async id => (id === "42" ? AuthLevel.ADMIN : AuthLevel.USER),
            async () => { log.push("denied"); }
        );
        h.bot.use(guard(() => { log.push("ok"); }));
        await h.sendText("x", { userId: 42 });
        await h.sendText("x", { userId: 43 });
        assert.deepStrictEqual(log, ["ok", "denied"]);
    }
    console.log("  [SUCCESS] requireAuthLevel gates handlers by level.");

    console.log("[INFO] Checking errorBoundary...");
    {
        const h = createHarness();
        const origError = console.error;
        const logged: unknown[][] = [];
        console.error = (...a: unknown[]) => { logged.push(a); };
        h.bot.catch(errorBoundary);
        h.bot.on("callback_query", () => { throw new Error("boom"); });
        h.bot.on("message", ctx => ctx.reply("pong"));
        await h.pressButton("x");
        console.error = origError;
        assert.ok(String(logged[0]?.[0]).startsWith("[ERROR - update "), "logs with update id prefix");
        assert.ok(h.calls.some(c => c.method === "answerCallbackQuery"), "spinner must be stopped");
        await h.sendText("ping");
        assert.ok(h.calls.some(c => c.method === "sendMessage" && c.params.text === "pong"), "next update still processes");

        // answerCallbackQuery failing inside the boundary is swallowed
        const h2 = createHarness({ responses: { answerCallbackQuery: () => { throw new Error("nope"); } } });
        console.error = () => undefined;
        h2.bot.catch(errorBoundary);
        h2.bot.on("callback_query", () => { throw new Error("boom"); });
        await h2.pressButton("x");
        console.error = origError;
    }
    console.log("  [SUCCESS] errorBoundary logs, stops the spinner and never rethrows.");

    console.log("[INFO] Checking staleButtonCatchAll...");
    {
        const h = createHarness();
        const handled: string[] = [];
        h.bot.on("callback_query", (ctx, next) => {
            if (ctx.callbackQuery?.data?.startsWith("approve_")) { handled.push("approve"); return; }
            return next();
        });
        h.bot.use(staleButtonCatchAll(async () => "This button has expired."));
        await h.pressButton("confirm_42_123", { chatId: 5, messageId: 9 });
        const answer = h.calls.find(c => c.method === "answerCallbackQuery");
        assert.strictEqual(answer?.params.text, "This button has expired.");
        const edit = h.calls.find(c => c.method === "editMessageReplyMarkup");
        assert.ok(edit, "keyboard removed");
        assert.strictEqual(Number(edit.params.chat_id), 5);
        assert.strictEqual(Number(edit.params.message_id), 9);
        assert.deepStrictEqual(edit.params.reply_markup, { inline_keyboard: [] });

        for (const data of ["cancel_1_2", "done_media_1", "skip_reason_1_2"]) {
            h.calls.length = 0;
            await h.pressButton(data);
            assert.ok(h.calls.some(c => c.method === "editMessageReplyMarkup"), data);
        }

        h.calls.length = 0;
        await h.pressButton("approve_abc123");
        assert.deepStrictEqual(handled, ["approve"]);
        assert.strictEqual(h.calls.length, 0, "other callbacks are not touched");

        // unhandled non-wizard callback: next() only, no API calls
        await h.pressButton("whatever");
        assert.strictEqual(h.calls.length, 0);

        // "message is not modified" is swallowed
        const h2 = createHarness({
            responses: { editMessageReplyMarkup: { ok: false, error_code: 400, description: "Bad Request: message is not modified" } }
        });
        h2.bot.use(staleButtonCatchAll(async () => "This button has expired."));
        await h2.pressButton("confirm_1_1");
    }
    console.log("  [SUCCESS] staleButtonCatchAll expires wizard buttons and ignores the rest.");

    console.log("[INFO] Checking sessionKey...");
    {
        const h = createHarness();
        const keys: (string | undefined)[] = [];
        h.bot.use((ctx: Context, next) => { keys.push(sessionKey(ctx)); return next(); });
        await h.sendText("hi");
        await h.sendText("hi", { chatId: -100, userId: 7, chatType: "supergroup" });
        await h.pressButton("x", { chatId: 5, userId: 9 });
        await h.send({
            pre_checkout_query: {
                id: "pq", from: { id: 42, is_bot: false, first_name: "T" },
                currency: "XTR", total_amount: 1, invoice_payload: "donate"
            }
        });
        assert.deepStrictEqual(keys, ["42:42", "-100:7", "5:9", undefined]);
    }
    console.log("  [SUCCESS] sessionKey is chat:user, undefined without a chat.");

    console.log("[SUCCESS] All platform checks passed.");
}

main().catch(err => {
    console.error("[ERROR - checkPlatform]", err);
    process.exit(1);
});
