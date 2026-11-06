import assert from "assert";
import Post from "../models/Post";
import Draft from "../models/Draft";
import Listing from "../models/Listing";
import { seedCapture } from "./fixtures";
import { createHarness, RecordedCall, HarnessOptions } from "./harness";
import type { BotConfig } from "../types";

// quickListing (slice 5): field-edit buttons and the Beit Dagan toggle on the wizard, run from
// checkFlows (its single run() is at the type checker's recursion limit, hence the separate module).
type H = ReturnType<typeof createHarness>;
type Keyboard = { inline_keyboard: { text: string; callback_data: string }[][] };
const text = (c: RecordedCall) => String(c.params.text);
const keyboard = (c: RecordedCall) => (c.params.reply_markup as Keyboard).inline_keyboard;
const buttons = (c: RecordedCall) => keyboard(c).flat();
const labels = (c: RecordedCall) => buttons(c).map((b) => b.text);
// callback_data without the trailing numbers (user id, stamp): confirm_<id>_<stamp> -> confirm
const rows = (c: RecordedCall) => keyboard(c).map((r) => r.map((b) => b.callback_data.replace(/(_\d+)+$/, "")));
const messageId = (c: RecordedCall) => (c.result as { message_id: number }).message_id;

export interface QuickListingContext {
    boot: (options?: HarnessOptions) => { h: H };
    cfg: BotConfig;
    user: () => number;
    settle: () => Promise<unknown>;
    T: (key: string) => string;
    postIds: string[];
    APPROVED_GROUP: number;
}

export async function quickListingChecks(ctx: QuickListingContext): Promise<void> {
    const { boot, cfg, user, settle, T, postIds, APPROVED_GROUP } = ctx;
    const { default: draftRepository } = await import("../repositories/draftRepository");
    const draftOf = (u: number) => draftRepository.findByUserId(String(u));
    const rawDraft = (u: number) => Draft.collection.findOne({ userId: String(u) });
    const PLACE = T("meetupPlace");
    const wasQuick = cfg.quickListing;
    const calls = (h: H, method: string) => h.calls.filter((c) => c.method === method);
    const toasts = (h: H) => calls(h, "answerCallbackQuery").map((c) => c.params.text);

    // /newpost, title, description, price: ends on the location prompt (returns it).
    const toLocation = async (h: H, u: number) => {
        await h.sendText("/newpost", { userId: u });
        await h.sendText("Bike", { userId: u });
        await h.sendText("Blue mountain bike", { userId: u });
        h.calls.length = 0;
        await h.sendText("1,500", { userId: u });
        await settle();
        return calls(h, "sendMessage")[0];
    };
    // ... through location and two photos to the preview (returns it).
    const toPreview = async (h: H, u: number, location = "Tel Aviv") => {
        await toLocation(h, u);
        await h.sendText(location, { userId: u });
        await settle();
        const d = (await draftOf(u))!;
        for (const id of ["p1", "p2"]) await h.sendPhoto(id, { userId: u });
        h.calls.length = 0;
        await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
        await settle();
        return calls(h, "sendRichMessage")[0];
    };
    const press = async (h: H, u: number, data: string, onMessage: number) => {
        h.calls.length = 0;
        await h.pressButton(data, { userId: u, messageId: onMessage });
        await settle();
    };
    const confirm = async (h: H, u: number, preview: RecordedCall) => {
        const data = buttons(preview).find((b) => b.callback_data.startsWith("confirm_"))!.callback_data;
        await press(h, u, data, messageId(preview));
        const post = await Post.findOne({ userId: String(u) });
        if (post) postIds.push(String(post._id));
        return post;
    };

    try {
        // (k1) key off: today's behavior, byte for byte
        {
            cfg.quickListing = false;
            const { h } = boot();
            const u = user();
            const prompt = await toLocation(h, u);
            assert.strictEqual(prompt.params.reply_markup, undefined, "the location prompt has no buttons");
            await h.sendText("Tel Aviv", { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            for (const id of ["p1", "p2"]) await h.sendPhoto(id, { userId: u });
            h.calls.length = 0;
            await h.pressButton(`done_media_${u}`, { userId: u, messageId: d.promptMessageId });
            await settle();
            const live = calls(h, "sendRichMessage")[0];
            const data = buttons(live).map((b) => b.callback_data);
            assert.strictEqual(keyboard(live).length, 1, "one row");
            assert.ok(data.length === 2 && /^confirm_\d+_\d+$/.test(data[0]) && /^cancel_\d+_\d+$/.test(data[1]), data.join());
            for (const stale of [`draft_meetup_${u}`, `draft_edit_title_${u}`]) {
                await press(h, u, stale, messageId(live));
                assert.deepStrictEqual(toasts(h), [T("staleButton")], stale);
            }
            const after = (await draftOf(u))!;
            assert.deepStrictEqual([after.step, after.meetup], ["confirm", undefined]);
            console.log("  [OK] (k1) key off: no buttons on the location prompt, a two-button preview, edit and meetup presses are stale.");
        }

        cfg.quickListing = true;

        // (k2) key on: preview layout, the edit-price round trip, a bad price, no step indicator
        {
            const { h } = boot();
            const u = user();
            const preview = await toPreview(h, u);
            assert.deepStrictEqual(rows(preview), [["confirm", "cancel"], ["draft_edit_title", "draft_edit_price"], ["draft_edit_location", "draft_meetup"]]);
            assert.deepStrictEqual(labels(preview).slice(2), [T("editTitleButton"), T("editPriceButton"), T("editLocationButton"), `📍 ${PLACE}`]);
            const id = messageId(preview);

            await press(h, u, `draft_edit_price_${u}`, id);
            const removed = calls(h, "editMessageReplyMarkup")[0];
            assert.deepStrictEqual([Number(removed.params.message_id), keyboard(removed)], [id, []]);
            const prompt = calls(h, "sendMessage")[0];
            assert.strictEqual(text(prompt), T("enterPrice"), "no n of 5 indicator");
            let d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.fixing, d.promptMessageId], ["price", true, messageId(prompt)]);

            h.calls.length = 0;
            await h.sendText("abc", { userId: u });
            await settle();
            assert.strictEqual(text(calls(h, "sendMessage")[0]), T("invalidPrice"));
            assert.strictEqual((await draftOf(u))!.step, "price");

            h.calls.length = 0;
            await h.sendText("2,000", { userId: u });
            await settle();
            const again = calls(h, "sendRichMessage")[0];
            assert.deepStrictEqual(rows(again), rows(preview));
            assert.ok(JSON.stringify(again.params.rich_message).includes("2,000"));
            d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.price, d.promptMessageId], ["confirm", "2,000", messageId(again)]);
            assert.strictEqual((await rawDraft(u))!.fixing, undefined, "fixing is cleared");
            console.log("  [OK] (k2) key on: three-row preview; edit price asks once, rejects a bad price, returns to a new preview.");
        }

        // (k3) a stale press, a blocked word in an edited field, title and location edits
        {
            const { h } = boot();
            const u = user();
            const preview = await toPreview(h, u);
            await press(h, u, `draft_edit_title_${u}`, 999_999);
            assert.deepStrictEqual(toasts(h), [T("staleButton")], "an older message is stale");
            assert.strictEqual((await draftOf(u))!.step, "confirm");

            await press(h, u, `draft_edit_title_${u}`, messageId(preview));
            assert.strictEqual(text(calls(h, "sendMessage")[0]), T("welcome"));
            h.calls.length = 0;
            await h.sendText("buy https://t.me/vipemployment_bot", { userId: u });
            await settle();
            assert.ok(calls(h, "sendMessage").some((c) => text(c).includes("vipemployment_bot")), "the blocked-word notice names the word");
            assert.strictEqual(calls(h, "sendRichMessage").length, 0, "no preview");
            let d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.fixing], ["title", true]);
            await h.sendText("Road bike", { userId: u });
            await settle();
            d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.title], ["confirm", "Road bike"]);

            await press(h, u, `draft_edit_location_${u}`, d.promptMessageId);
            assert.strictEqual(text(calls(h, "sendMessage")[0]), T("enterLocation"), "no indicator");
            console.log("  [OK] (k3) a stale edit press, a blocked word in an edited field is refused, title and location edits.");
        }

        // (k4) the toggle on the location step and on the preview, then Confirm
        {
            const { h } = boot();
            const u = user();
            const prompt = await toLocation(h, u);
            assert.deepStrictEqual(labels(prompt), [`📍 ${PLACE}`]);
            assert.strictEqual(buttons(prompt)[0].callback_data, `draft_meetup_${u}`);
            const id = messageId(prompt);
            await press(h, u, `draft_meetup_${u}`, id);
            assert.deepStrictEqual(labels(calls(h, "editMessageReplyMarkup")[0]), [`✅ 📍 ${PLACE}`]);
            let d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.promptMessageId, d.meetup], ["location", id, true]);
            await press(h, u, `draft_meetup_${u}`, id);
            assert.deepStrictEqual(labels(calls(h, "editMessageReplyMarkup")[0]), [`📍 ${PLACE}`]);
            assert.strictEqual((await rawDraft(u))!.meetup, undefined, "off leaves no meetup:false");
            assert.strictEqual((await draftOf(u))!.promptMessageId, id);

            await h.sendText("Tel Aviv", { userId: u });
            await settle();
            const dd = (await draftOf(u))!;
            for (const p of ["p1", "p2"]) await h.sendPhoto(p, { userId: u });
            h.calls.length = 0;
            await h.pressButton(`done_media_${u}`, { userId: u, messageId: dd.promptMessageId });
            await settle();
            const preview = calls(h, "sendRichMessage")[0];
            assert.ok(!JSON.stringify(preview.params.rich_message).includes(PLACE));
            await press(h, u, `draft_meetup_${u}`, messageId(preview));
            const edit = calls(h, "editMessageText")[0];
            assert.strictEqual(Number(edit.params.message_id), messageId(preview));
            assert.ok(JSON.stringify(edit.params.rich_message).includes(`Tel Aviv · ${PLACE}`), "the preview shows the place");
            assert.deepStrictEqual(labels(edit).slice(-1), [`✅ 📍 ${PLACE}`]);
            assert.deepStrictEqual(keyboard(edit).map((r) => r.length), [2, 2, 2]);
            d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.meetup, d.promptMessageId], ["confirm", true, messageId(preview)]);

            // Telegram's "message is not modified" is not an error
            const { h: h2 } = boot({ responses: { editMessageText: () => ({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }) } });
            const u2 = user();
            const p2 = await toPreview(h2, u2);
            await press(h2, u2, `draft_meetup_${u2}`, messageId(p2));
            assert.strictEqual((await draftOf(u2))!.meetup, true);
            assert.strictEqual(calls(h2, "sendMessage").length, 0, "no generalError");

            const post = await confirm(h, u, preview);
            assert.strictEqual(post!.meetup, true);
            console.log("  [OK] (k4) the toggle flips on the prompt and on the preview, never writes false, and Confirm keeps meetup.");
        }

        // (k5) typing the meeting point sets meetup; key off with a live preview
        {
            const { h } = boot();
            const u = user();
            const preview = await toPreview(h, u, "בית דגן");
            const post = await confirm(h, u, preview);
            assert.strictEqual(post!.meetup, true, "location typed as Beit Dagan");

            const { h: h2 } = boot();
            const u2 = user();
            const live = await toPreview(h2, u2);
            cfg.quickListing = false;
            await press(h2, u2, `draft_edit_price_${u2}`, messageId(live));
            assert.deepStrictEqual(toasts(h2), [T("staleButton")]);
            await press(h2, u2, `draft_meetup_${u2}`, messageId(live));
            assert.deepStrictEqual(toasts(h2), [T("staleButton")]);
            const post2 = await confirm(h2, u2, live);
            assert.ok(post2, "Confirm still publishes");
            assert.strictEqual(post2.meetup, undefined);
            cfg.quickListing = true;
            console.log("  [OK] (k5) Beit Dagan typed sets meetup; with the key off a live preview's edit is stale and Confirm works.");
        }

        // (k6) a capture draft: the toggle, then Confirm gives a listing with meetup and no posts row
        {
            const { h } = boot();
            const u = user();
            const cap = await seedCapture({
                senderId: String(u), chatId: APPROVED_GROUP, messageIds: [880_001], text: "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז", state: "classified",
                media: [{ type: "photo", fileId: "cap1" }],
            });
            await h.sendText(`/start c_${cap._id}`, { userId: u });
            await settle();
            let d = (await draftOf(u))!;
            assert.strictEqual(d.step, "confirm", "the capture parsed a title and a price");
            const preview = calls(h, "sendRichMessage")[0];
            await press(h, u, `draft_meetup_${u}`, messageId(preview));
            d = (await draftOf(u))!;
            assert.strictEqual(d.meetup, true);
            await confirm(h, u, preview);
            const listing = await Listing.findOne({ sellerId: String(u) });
            assert.strictEqual(listing!.meetup, true);
            assert.strictEqual(await Post.countDocuments({ userId: String(u) }), 0);
            console.log("  [OK] (k6) a capture draft's meetup lands on the group listing, no posts row.");
        }
    } finally {
        cfg.quickListing = wasQuick;
    }
}
