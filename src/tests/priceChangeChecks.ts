import assert from "assert";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Listing from "../models/Listing";
import { createHarness, RecordedCall, HarnessOptions } from "./harness";
import type { BotConfig } from "../types";

// Change price (#128), run from checkFlows: a separate module because checkFlows' single run()
// is at the type checker's recursion limit. The context is the helpers run() already has.
type H = ReturnType<typeof createHarness>;

export interface PriceChangeContext {
    boot: (options?: HarnessOptions) => { h: H };
    cfg: BotConfig;
    user: () => number;
    settle: () => Promise<unknown>;
    T: (key: string) => string;
    postIds: string[];
    APPROVED_GROUP: number;
}

type Markup = { inline_keyboard: Record<string, unknown>[][] };
const text = (c: RecordedCall) => String(c.params.text);
const messageId = (c: RecordedCall) => (c.result as { message_id: number }).message_id;

export async function priceChangeChecks(ctx: PriceChangeContext): Promise<void> {
    const { boot, cfg, user, settle, postIds, APPROVED_GROUP } = ctx;
    const T = (key: string, params: Record<string, string> = {}) => Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, v), ctx.T(key));
    const prevLimit = cfg.dailyBumpLimit;
    cfg.dailyBumpLimit = 2;
    const { h } = boot();
    const u = user();
    const other = user();
    await User.create({ userId: String(u), firstName: "Seller", authLevel: 0 });
    await User.create({ userId: String(other), firstName: "Other", authLevel: 0 });

    const seed = async (price: string, extra: Record<string, unknown> = {}, listingStatus: "live" | "taken_down" | "expired" = "live") => {
        const inserted = await Post.collection.insertOne({
            userId: String(u), title: "PC", description: "d", price, location: "l", media: [], status: "approved",
            createdAt: new Date(), lastBumpAt: null, dailyBumpCount: 0, ...extra,
        });
        const id = String(inserted.insertedId);
        postIds.push(id);
        const at = new Date();
        await Listing.collection.insertOne({ source: "bot", origin: "dm", postId: id, sellerId: String(u), title: "PC", price, status: listingStatus, createdAt: at, refreshedAt: at });
        return id;
    };
    const toasts = () => h.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.params.text ?? ""));
    const groupPosts = () => h.calls.filter((c) => c.method === "sendRichMessage" && Number(c.params.chat_id) === APPROVED_GROUP);
    const prompt = async (postId: string, uid = u) => {
        h.calls.length = 0;
        await h.pressButton(`lp_${postId}`, { userId: uid, messageId: 600 });
        await settle();
        return h.calls.find((c) => c.method === "sendMessage" && (c.params.reply_markup as { force_reply?: boolean } | undefined)?.force_reply);
    };
    const answer = async (p: RecordedCall, txt: string, uid = u) => {
        h.calls.length = 0;
        await h.sendText(txt, { userId: uid, replyToMessageId: messageId(p) });
        await settle();
    };
    const lastMessage = () => h.calls.filter((c) => c.method === "sendMessage").pop()!;
    // every message that ends the flow clears the force-reply prompt (Telegram re-offers it on every chat open otherwise)
    const markup = (c: RecordedCall) => c.params.reply_markup as { remove_keyboard?: boolean; force_reply?: boolean } | undefined;
    const clears = (c: RecordedCall) => assert.deepStrictEqual(markup(c), { remove_keyboard: true }, `${text(c)}: clears the reply prompt`);
    const keepsAsking = (c: RecordedCall) => assert.deepStrictEqual(markup(c), { force_reply: true }, `${text(c)}: keeps the reply prompt`);
    const dbPost = async (id: string): Promise<Record<string, unknown>> =>
        (await Post.collection.findOne({ _id: new mongoose.Types.ObjectId(id) } as never)) as Record<string, unknown>;
    const buttons = (c: RecordedCall) => (c.params.reply_markup as Markup).inline_keyboard.flat();

    // a cut at the daily limit works and uses no bump; the listing follows
    const atLimit = await seed("1000", { dailyBumpCount: 2, lastBumpAt: new Date() });
    let p = (await prompt(atLimit))!;
    assert.ok(p && text(p).includes("1000"), "the prompt names the current price");
    await answer(p, "800");
    assert.strictEqual(groupPosts().length, 1, "a cut re-posts to the group");
    let row = await dbPost(atLimit);
    assert.deepStrictEqual([row.price, row.previousPrice, row.dailyBumpCount], ["800", "1000", 2], "cut: new price, previousPrice, no bump used");
    const listed = (await Listing.collection.findOne({ postId: atLimit }))!;
    assert.deepStrictEqual([listed.price, listed.priceValue], ["800", 800], "the listing price follows");
    assert.strictEqual(text(lastMessage()), T("priceChangeCut", { price: "800" }));
    clears(lastMessage());
    await answer(p, "500"); // the flow ended: the same prompt is not an answer any more
    assert.strictEqual(groupPosts().length, 0, "no second cut from the same prompt");

    // a raise at the limit is refused after the price is entered; nothing changes
    p = (await prompt(atLimit))!;
    assert.ok(p, "the Change price button is live at the limit");
    await answer(p, "900");
    assert.strictEqual(groupPosts().length, 0);
    assert.strictEqual(text(lastMessage()), T("bumpLimitReached"));
    clears(lastMessage());
    row = await dbPost(atLimit);
    assert.deepStrictEqual([row.price, row.previousPrice, row.dailyBumpCount], ["800", "1000", 2], "a refused raise changes nothing");

    // same price and text are refused and keep the prompt open; then a valid cut goes through
    const retryId = await seed("1,400");
    p = (await prompt(retryId))!;
    await answer(p, "1400");
    assert.strictEqual(text(lastMessage()), T("priceChangeSame", { price: "1,400" }));
    keepsAsking(lastMessage());
    p = lastMessage();
    await answer(p, "cheap");
    assert.strictEqual(text(lastMessage()), T("priceChangeInvalid"));
    keepsAsking(lastMessage());
    p = lastMessage();
    await answer(p, "1 200");
    assert.strictEqual(groupPosts().length, 1);
    row = await dbPost(retryId);
    assert.deepStrictEqual([row.price, row.previousPrice, row.dailyBumpCount], ["1 200", "1,400", 0], "retry, then a cut; comma and space numbers compare as numbers");

    // a raise under the limit is a normal bump: counted, previousPrice cleared; the last bump disables the card's Bump
    const raiseId = await seed("500", { previousPrice: "700", dailyBumpCount: 1, lastBumpAt: new Date() });
    p = (await prompt(raiseId))!;
    await answer(p, "650");
    assert.strictEqual(groupPosts().length, 1);
    row = await dbPost(raiseId);
    assert.deepStrictEqual([row.price, row.dailyBumpCount, "previousPrice" in row], ["650", 2, false], "a raise is a counted bump and clears previousPrice");
    const refreshed = h.calls.find((c) => c.method === "editMessageReplyMarkup");
    assert.ok(refreshed, "the card's buttons are refreshed when the limit is used up");
    const after = buttons(refreshed);
    assert.ok(after.some((b) => b.disabled) && !after.some((b) => b.callback_data === `bump_${raiseId}`) && after.some((b) => b.callback_data === `lp_${raiseId}`), "Bump disabled, Change price live");

    // /myposts at the limit: Bump is Telegram's disabled button, Sold and Change price stay live
    h.calls.length = 0;
    await h.sendText("/myposts", { userId: u });
    await settle();
    const card = h.calls.find((c) => c.method === "sendRichMessage" && JSON.stringify(c.params.reply_markup).includes(`lp_${raiseId}`));
    assert.ok(card, "the post's card");
    const cardButtons = buttons(card);
    assert.deepStrictEqual(cardButtons.map((b) => b.callback_data ?? "disabled"), [`sold_${raiseId}`, "disabled", `lp_${raiseId}`]);
    assert.deepStrictEqual(cardButtons[1].disabled, {});
    assert.strictEqual(cardButtons[1].text, T("bumpLimitButton"));

    // an old message's live Bump past the limit still gets the refusal
    h.calls.length = 0;
    await h.pressButton(`bump_${raiseId}`, { userId: u, messageId: 601 });
    await settle();
    assert.deepStrictEqual(toasts(), [T("bumpLimitReached")]);
    assert.strictEqual(groupPosts().length, 0);

    // someone else's press, a sold post, a taken-down post, an expired one, a price that is not a number
    const mine = await seed("300");
    assert.ok(!(await prompt(mine, other)), "someone else gets no prompt");
    assert.deepStrictEqual(toasts(), [T("postNotFound")]);
    assert.ok(!(await prompt(await seed("300", { status: "sold" }))));
    assert.deepStrictEqual(toasts(), [T("staleButton")], "a sold post: the usual expired toast");
    assert.ok(!(await prompt(await seed("300", {}, "taken_down"))));
    assert.deepStrictEqual(toasts(), [T("postTakenDown")]);
    assert.ok(!(await prompt(await seed("300", {}, "expired"))));
    assert.deepStrictEqual(toasts(), [T("staleButton")], "an expired post: the usual expired toast");
    assert.ok(!(await prompt(await seed("negotiable"))));
    assert.deepStrictEqual(toasts(), [T("priceChangeNotNumeric")]);
    p = (await prompt(mine))!;
    await answer(p, "100", other); // someone else answering the owner's prompt
    assert.strictEqual((await dbPost(mine)).price, "300", "another user's reply changes nothing");

    // a restart between the prompt and the answer; /cancel drops the prompt
    p = (await prompt(mine))!;
    const two = boot().h;
    two.calls.length = 0;
    await two.sendText("250", { userId: u, replyToMessageId: messageId(p) });
    await settle();
    assert.strictEqual((await dbPost(mine)).price, "250", "the price change survives a restart");
    assert.strictEqual(two.calls.filter((c) => c.method === "sendRichMessage" && Number(c.params.chat_id) === APPROVED_GROUP).length, 1);
    h.calls.length = 0;
    p = (await prompt(mine))!;
    await two.sendText("/cancel", { userId: u });
    await settle();
    assert.strictEqual(text(two.calls.filter((c) => c.method === "sendMessage").pop()!), T("priceChangeCancelled"));
    clears(two.calls.filter((c) => c.method === "sendMessage").pop()!);
    await answer(p, "200");
    assert.strictEqual((await dbPost(mine)).price, "250", "no change after /cancel");

    cfg.dailyBumpLimit = prevLimit;
    console.log("  [OK] (l2) Change price: a cut at the limit is free, a raise is a bump, refusals, restart, disabled Bump, old live Bump.");
}
