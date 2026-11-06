import assert from "assert";
import User from "../models/User";
import Listing from "../models/Listing";
import { createHarness, RecordedCall, HarnessOptions } from "./harness";

// Moderator "take down and delete the original post" (tx_<listingId>_<d|y|n>), run from
// checkFlows: a separate module because checkFlows' single run() is at the type checker's
// recursion limit. The context is the helpers run() already has.
type H = ReturnType<typeof createHarness>;
type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
const text = (c: RecordedCall) => String(c.params.text);
const keyboard = (c: RecordedCall) => (c.params.reply_markup as Keyboard).inline_keyboard.flat();

export interface TakeDownDeleteContext {
    boot: (options?: HarnessOptions) => { h: H };
    mod: number;
    user: () => number;
    settle: () => Promise<unknown>;
    T: (key: string) => string;
    answers: (h: H) => string[];
    toAuthor: (h: H, u: number) => string[];
    tdPress: (h: H, who: number, listingId: string, cardId: number) => Promise<unknown>;
    publishTrusted: (h: H) => Promise<{ listing: { _id: unknown }; cardId: number }>;
    richTo: (h: H, chat: number) => RecordedCall[];
    APPROVED_GROUP: number;
    MOD_GROUP: number;
}

export async function takeDownDeleteChecks(ctx: TakeDownDeleteContext): Promise<void> {
    const { boot, mod, user, settle, T, answers, toAuthor, tdPress, publishTrusted, richTo, APPROVED_GROUP, MOD_GROUP } = ctx;
    const seedGroup = async (messageIds: number[]) => {
        const seller = user();
        await User.create({ userId: String(seller), firstName: "Member", authLevel: 0 });
        const now = new Date();
        const listing = await Listing.create({
            source: "group", origin: "capture", chatId: APPROVED_GROUP, messageIds, sellerId: String(seller),
            title: "Radio", media: [], status: "live", hold: false, isBundle: false, createdAt: now, refreshedAt: now,
        });
        return { seller, id: String(listing._id) };
    };
    const txPress = (h: H, who: number, id: string, a: "d" | "y" | "n", cardId = 330) =>
        h.pressButton(`tx_${id}_${a}`, { userId: who, chatId: MOD_GROUP, chatType: "supergroup", messageId: cardId });
    const deleteCalls = (h: H) => h.calls.filter((c) => c.method === "deleteMessages");
    const markupEdits = (h: H) => h.calls.filter((c) => c.method === "editMessageReplyMarkup");
    const rows = (c: RecordedCall) => (c.params.reply_markup as Keyboard).inline_keyboard.map((r) => r.map((b) => b.callback_data));

    // (tx1) the confirm step changes nothing, cancel puts the buttons back
    {
        const { h } = boot();
        const { id } = await seedGroup([601, 602, 603]);
        h.calls.length = 0;
        await txPress(h, mod, id, "d");
        await settle();
        assert.deepStrictEqual(rows(markupEdits(h)[0]), [[`tx_${id}_y`], [`tx_${id}_n`]]);
        assert.strictEqual(h.calls.find((c) => c.method === "answerCallbackQuery")!.params.text, T("takeDownDeleteWarn"));
        assert.strictEqual(deleteCalls(h).length, 0);
        assert.strictEqual((await Listing.findById(id))!.status, "live");
        await txPress(h, mod, id, "n");
        await settle();
        assert.deepStrictEqual(rows(markupEdits(h)[1]), [[`td_${id}`], [`tx_${id}_d`]]);
        assert.strictEqual(deleteCalls(h).length, 0);
        assert.strictEqual((await Listing.findById(id))!.status, "live");
        console.log("  [OK] (tx1) ask shows a confirm step, cancel restores both buttons, nothing is deleted.");
    }

    // (tx2) confirm: listing ends, every id deleted in one call, seller told, double press acts once, who/what logged
    {
        const { h } = boot();
        const { seller, id } = await seedGroup([601, 602, 603]);
        const logged: string[] = [];
        const realInfo = console.info;
        console.info = (...a: unknown[]) => { logged.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
        h.calls.length = 0;
        try {
            await Promise.all([txPress(h, mod, id, "y"), txPress(h, mod, id, "y")]);
            await settle();
        } finally {
            console.info = realInfo;
        }
        const l = (await Listing.findById(id))!;
        assert.deepStrictEqual([l.status, l.endedBy], ["taken_down", "moderator"]);
        assert.strictEqual(deleteCalls(h).length, 1);
        assert.strictEqual(Number(deleteCalls(h)[0].params.chat_id), APPROVED_GROUP);
        assert.deepStrictEqual(deleteCalls(h)[0].params.message_ids, [601, 602, 603]);
        assert.deepStrictEqual(answers(h).sort(), [T("takeDownAlready"), T("takeDownDone")].sort());
        assert.strictEqual(toAuthor(h, seller).length, 1);
        const edit = h.calls.find((c) => c.method === "editMessageText" && Number(c.params.message_id) === 330)!;
        assert.strictEqual(text(edit), T("statusTakenDownDeleted"));
        assert.ok(logged.some((x) => x.includes(String(mod)) && x.includes(id) && x.includes("601,602,603")), "logs who, listing and message ids");
        console.log("  [OK] (tx2) confirm deletes every message once, ends the listing, tells the seller, logs the moderator.");
    }

    // (tx3) the plain td_ still never deletes
    {
        const { h } = boot();
        const { id } = await seedGroup([611]);
        h.calls.length = 0;
        await tdPress(h, mod, id, 331);
        await settle();
        assert.strictEqual(deleteCalls(h).length, 0);
        console.log("  [OK] (tx3) Remove from market alone deletes nothing.");
    }

    // (tx4) partial failure: the listing still ends and the moderator is told how many are left
    {
        let n = 0;
        const { h } = boot({ responses: { deleteMessages: () => (n++ === 0 ? { ok: false, error_code: 400, description: "Bad Request: message can't be deleted" } : undefined) } });
        const ids = Array.from({ length: 101 }, (_, i) => 700 + i);
        const { seller, id } = await seedGroup(ids);
        h.calls.length = 0;
        await txPress(h, mod, id, "y", 332);
        await settle();
        assert.strictEqual(deleteCalls(h).length, 2);
        assert.strictEqual((deleteCalls(h)[1].params.message_ids as number[]).length, 1);
        assert.strictEqual((await Listing.findById(id))!.status, "taken_down");
        assert.strictEqual(toAuthor(h, seller).length, 1);
        const edit = h.calls.find((c) => c.method === "editMessageText" && Number(c.params.message_id) === 332)!;
        assert.strictEqual(text(edit), `${T("statusTakenDownDeleted")}\n${T("takeDownDeleteLeft").replace("{count}", "100")}`);
        console.log("  [OK] (tx4) a failed delete batch is counted, the listing still ends.");
    }

    // (tx5) a non-moderator is refused on every step
    {
        const { h } = boot();
        const { seller, id } = await seedGroup([621]);
        for (const a of ["d", "y", "n"] as const) {
            h.calls.length = 0;
            await txPress(h, seller, id, a);
            await settle();
            assert.deepStrictEqual(answers(h), [T("notAdmin")], a);
            assert.strictEqual(deleteCalls(h).length, 0);
            assert.strictEqual(markupEdits(h).length, 0);
        }
        assert.strictEqual((await Listing.findById(id))!.status, "live");
        console.log("  [OK] (tx5) a non-moderator cannot ask, confirm or cancel.");
    }

    // (tx6) a bot listing has no delete step: a stale or forged tx_ press is refused
    {
        const { h } = boot();
        const { listing, cardId } = await publishTrusted(h);
        const id = String(listing._id);
        const card = richTo(h, MOD_GROUP)[0];
        assert.deepStrictEqual(keyboard(card).map((b) => b.callback_data), [`td_${id}`], "bot card: one button");
        for (const a of ["d", "y"] as const) {
            h.calls.length = 0;
            await txPress(h, mod, id, a, cardId);
            await settle();
            assert.deepStrictEqual(answers(h), [T("takeDownAlready")], a);
            assert.strictEqual(deleteCalls(h).length, 0);
        }
        assert.strictEqual((await Listing.findById(id))!.status, "live");
        console.log("  [OK] (tx6) a bot listing has one button and cannot be deleted through tx_.");
    }

    // (tx7) the confirm survives a restart (a fresh controller) and a malformed id is ignored
    {
        const { h } = boot();
        const { id } = await seedGroup([631]);
        await txPress(h, mod, id, "d");
        await settle();
        const second = boot();
        await txPress(second.h, mod, id, "y");
        await settle();
        assert.strictEqual(deleteCalls(second.h).length, 1);
        second.h.calls.length = 0;
        await second.h.pressButton("tx_nothex_y", { userId: mod, chatId: MOD_GROUP, chatType: "supergroup", messageId: 333 });
        await settle();
        assert.strictEqual(deleteCalls(second.h).length, 0);
        console.log("  [OK] (tx7) confirm works on a fresh controller; a malformed id does nothing.");
    }
}
