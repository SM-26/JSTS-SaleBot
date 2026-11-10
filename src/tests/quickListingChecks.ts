import assert from "assert";
import Post from "../models/Post";
import Draft from "../models/Draft";
import Listing from "../models/Listing";
import { QUICK_ALBUM_DELAY_MS, QUICK_TEXT_WINDOW_MS } from "../services/wizardService";
import { FAQ_PADDING } from "../services/faqService";
import { displayQuery } from "../services/buyerCards";
import { parseQuery } from "../services/matchService";
import { seedCapture } from "./fixtures";
import { createHarness, idle, RecordedCall, HarnessOptions } from "./harness";
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
    MOD_GROUP: number;
}

export async function quickListingChecks(ctx: QuickListingContext): Promise<void> {
    const { boot, cfg, user, settle, T, postIds, APPROVED_GROUP, MOD_GROUP } = ctx;
    const { default: draftRepository } = await import("../repositories/draftRepository");
    const draftOf = (u: number) => draftRepository.findByUserId(String(u));
    const rawDraft = (u: number) => Draft.collection.findOne({ userId: String(u) });
    const PLACE = T("meetupPlace");
    const wasQuick = cfg.quickListing;
    const wasMin = cfg.minimumPhotos;
    const wasMatches = cfg.buyerMatches;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    // The album timer was armed before this sleep started, so it has fired when the sleep ends; idle() then proves its work is done.
    const waitTimer = async () => { await sleep(QUICK_ALBUM_DELAY_MS); await idle(); };
    const photo = (id: string) => ({ photo: [{ file_id: id, file_unique_id: id, width: 10, height: 10 }] });
    const outbound = (h: H) => h.calls.filter((c) => c.method !== "getMe");
    const previews = (h: H) => h.calls.filter((c) => c.method === "sendRichMessage");
    const sent = (h: H) => h.calls.filter((c) => c.method === "sendMessage");
    const album = (h: H, u: number, gid: string, captionOn: number, caption: string, n = 3) =>
        Promise.all(Array.from({ length: n }, (_, i) => h.message(photo(`${gid}${i}`), { userId: u, mediaGroupId: gid, ...(i === captionOn ? { caption } : {}) })));
    const single = (h: H, u: number, caption: string, id = "s1") => h.message(photo(id), { userId: u, caption });
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
            assert.deepStrictEqual(rows(preview), [["confirm", "cancel"], ["draft_edit_title", "draft_edit_description"], ["draft_edit_price", "draft_edit_location"], ["draft_meetup"]]);
            assert.deepStrictEqual(labels(preview).slice(2), [T("editTitleButton"), T("editDescriptionButton"), T("editPriceButton"), T("editLocationButton"), `📍 ${PLACE}`]);
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
            assert.ok(JSON.stringify(edit.params.rich_message).includes("Tel Aviv · ") && JSON.stringify(edit.params.rich_message).includes(PLACE), "the preview shows the place");
            assert.deepStrictEqual(labels(edit).slice(-1), [`✅ 📍 ${PLACE}`]);
            assert.deepStrictEqual(keyboard(edit).map((r) => r.length), [2, 2, 2, 1]);
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

        // ---- one-message quick draft (key on, minimumPhotos 0 unless a case says otherwise)
        cfg.minimumPhotos = 0;

        // (k7) an album with a caption: one draft, one preview after the delay, nothing before it
        {
            cfg.minimumPhotos = 2;
            const { h } = boot();
            const u = user();
            await album(h, u, `g${u}`, 1, "Glock 17\nnice shape\n900₪ Tel Aviv");
            await settle();
            assert.strictEqual(outbound(h).length, 0, "no reply while the album is collected");
            const collecting = (await rawDraft(u))!;
            assert.deepStrictEqual([collecting.collecting, collecting.media.length], [true, 3]);
            assert.strictEqual(await Draft.countDocuments({ userId: String(u) }), 1);
            await waitTimer();
            assert.strictEqual(previews(h).length, 1, "exactly one preview");
            assert.strictEqual(sent(h).length, 0);
            const d = (await rawDraft(u))!;
            assert.deepStrictEqual([d.step, d.quick, d.collecting, d.media.length, d.title, d.price, d.caption], ["confirm", true, undefined, 3, "Glock 17", "900", undefined]);
            assert.strictEqual(d.promptMessageId, messageId(previews(h)[0]));
            cfg.minimumPhotos = 0;
            console.log("  [OK] (k7) an album with a caption: one draft, 3 media, one preview after the delay, no reply before.");
        }

        // (k8) a single photo with a full caption previews at once; a one-line caption has no blockquote and no bare pin
        {
            const { h } = boot();
            const u = user();
            await single(h, u, "Glock 17 900 ₪");
            await settle();
            assert.strictEqual(previews(h).length, 1, "no delay for a single photo");
            const rich = JSON.stringify(previews(h)[0].params.rich_message);
            assert.ok(!rich.includes("blockquote") && !rich.includes("📍"), rich);
            const d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.quick, d.media.length], ["confirm", true, 1]);
            console.log("  [OK] (k8) a single photo with a full caption previews at once, no empty description or place.");
        }

        // (k9) a missing price or title is asked for once; minimumPhotos sends a media prompt
        {
            const { h } = boot();
            const u = user();
            // the classifier reads a bare "17" as a price, so the model number stays out of this caption
            await single(h, u, "Glock\nnice");
            await settle();
            const prompt = sent(h)[0];
            assert.strictEqual(text(prompt), T("enterPrice"), "no n of 5");
            assert.strictEqual(previews(h).length, 0);
            let d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.title, d.description, d.promptMessageId], ["price", "Glock", "nice", messageId(prompt)]);
            h.calls.length = 0;
            await h.sendText("750", { userId: u });
            await settle();
            assert.strictEqual(previews(h).length, 1);
            assert.strictEqual((await draftOf(u))!.price, "750");

            const { h: h2 } = boot();
            const u2 = user();
            await single(h2, u2, "900 ₪");
            await settle();
            assert.strictEqual(text(sent(h2)[0]), T("welcome"), "title prompt, no indicator");
            await h2.sendText("Glock", { userId: u2 });
            await settle();
            d = (await draftOf(u2))!;
            assert.deepStrictEqual([d.step, d.price], ["confirm", "900"]);
            assert.strictEqual(previews(h2).length, 1);

            cfg.minimumPhotos = 2;
            const { h: h3 } = boot();
            const u3 = user();
            await single(h3, u3, "Glock 17 900₪");
            await settle();
            assert.strictEqual(text(sent(h3)[0]), T("enterMedia"));
            assert.strictEqual(previews(h3).length, 0);
            d = (await draftOf(u3))!;
            assert.strictEqual(d.step, "media");
            h3.calls.length = 0;
            await h3.pressButton(`done_media_${u3}`, { userId: u3, messageId: d.promptMessageId });
            await settle();
            assert.deepStrictEqual(sent(h3).map(text), [T("notEnoughMedia")]);
            assert.strictEqual(await draftOf(u3), null);

            const { h: h4 } = boot();
            const u4 = user();
            await single(h4, u4, "Glock 17 900₪");
            await settle();
            await h4.sendPhoto("more", { userId: u4 });
            h4.calls.length = 0;
            await h4.pressButton(`done_media_${u4}`, { userId: u4, messageId: (await draftOf(u4))!.promptMessageId });
            await settle();
            assert.strictEqual(previews(h4).length, 1, "enough photos: Done goes to the preview");
            assert.strictEqual((await draftOf(u4))!.step, "confirm");
            cfg.minimumPhotos = 0;
            console.log("  [OK] (k9) a missing price/title is asked for without an indicator; minimumPhotos asks for media.");
        }

        // (k10) validatePrice stays on: the parsed price is a plain number
        {
            const { h } = boot();
            const u = user();
            await single(h, u, "Glock 17\nמכירה ב-800");
            await settle();
            assert.strictEqual((await draftOf(u))!.price, "800");
            const u2 = user();
            await single(h, u2, "Glock 900₪", "s2");
            await settle();
            assert.strictEqual((await draftOf(u2))!.price, "900");
            console.log("  [OK] (k10) validatePrice on: parsed prices are numeric.");
        }

        // (k11) a WTB caption: matches in the DM, no draft, no preview
        {
            const stamp = new Date();
            const tag = `zq${String(user()).slice(-5)}`;
            const mk = (sellerId: string, title: string) => Listing.create({
                source: "group", origin: "capture", chatId: APPROVED_GROUP, messageIds: [990_000 + Math.floor(Math.random() * 9000)], sellerId, title, text: `${title} למכירה`,
                priceValue: 100, price: "100", media: [], isBundle: false, status: "live", hold: false, createdAt: stamp, refreshedAt: stamp,
            });
            await mk("someone-else", `Rifle ${tag} scope`);
            const { h } = boot();
            const mine = user();
            await mk(String(mine), `Mine ${tag} own`);
            cfg.buyerMatches = "on";
            await single(h, mine, `מחפש ${tag}`);
            await settle();
            assert.strictEqual(await draftOf(mine), null, "no draft");
            assert.strictEqual(previews(h).length, 0);
            const reply = sent(h)[0];
            assert.ok(text(reply).includes(`Rifle ${tag} scope`), text(reply));
            assert.ok(!text(reply).includes("own"), "the user's own listing is not listed");
            assert.strictEqual(reply.params.parse_mode, "HTML");
            const q = displayQuery(parseQuery(`מחפש ${tag}`).query);
            assert.ok(text(reply).includes(T("dmAlertHint").replace("{query}", q)), text(reply));
            assert.strictEqual(text(reply).split("\n").pop(), T("dmSellHint"), "the sell hint is the last line");

            h.calls.length = 0;
            await single(h, user(), "מחפש nomatchzz77", "s4");
            await settle();
            assert.ok(text(sent(h)[0]).startsWith(T("buyerNoteEmpty")), text(sent(h)[0]));
            assert.ok(text(sent(h)[0]).endsWith(T("dmSellHint")));

            // off: no search, no list, no hints; one line
            cfg.buyerMatches = "off";
            h.calls.length = 0;
            const offUser = user();
            await single(h, offUser, `מחפש ${tag}`, "s5");
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("dmWantedOff")]);
            assert.strictEqual(await draftOf(offUser), null);
            cfg.buyerMatches = undefined;
            console.log("  [OK] (k11) a WTB caption: buyerMatches on lists live matches (not the user's own) with the /alerts and sell hints; off, one line; never a draft.");
        }

        // (k12) restart: a second controller finishes the album through /newpost then Continue; the old timer then finds nothing
        {
            const { h } = boot();
            const u = user();
            await album(h, u, `r${u}`, 0, "Glock 17 900₪ Haifa");
            await settle();
            const { h: h2 } = boot();
            await h2.sendText("/newpost", { userId: u });
            await settle();
            assert.strictEqual(text(sent(h2)[0]), T("draftInProgress"));
            const question = (await draftOf(u))!.promptMessageId;
            h2.calls.length = 0;
            await h2.pressButton(`draft_continue_${u}`, { userId: u, messageId: question });
            await settle();
            assert.strictEqual(previews(h2).length, 1, "Continue gives the preview");
            await waitTimer();
            assert.strictEqual(previews(h).length, 0, "the first controller's timer found nothing to do");
            assert.strictEqual(previews(h2).length, 1, "still one preview");
            assert.strictEqual((await draftOf(u))!.step, "confirm");
            console.log("  [OK] (k12) restart mid-album: /newpost then Continue gives one preview; the old timer adds none.");
        }

        // (k13) a blocked word stops the preview, trusted sellers too
        {
            const { h } = boot();
            const u = user();
            await single(h, u, "Glock 17 900₪ https://t.me/vipemployment_bot");
            await settle();
            assert.ok(sent(h).some((c) => text(c).includes("vipemployment_bot")), "the notice names the word");
            assert.strictEqual(previews(h).length, 0);
            assert.strictEqual((await draftOf(u))!.fixing, true);
            assert.strictEqual(await Post.countDocuments({ userId: String(u) }), 0);

            const trusted = user();
            const earlier = await Post.create({ userId: String(trusted), title: "t", description: "d", price: "10", location: "l", media: [], status: "approved" });
            postIds.push(String(earlier._id));
            const { h: h2 } = boot();
            await single(h2, trusted, "Glock 17 900₪ https://t.me/vipemployment_bot");
            await settle();
            assert.strictEqual((await draftOf(trusted))!.fixing, true, "trusted sellers are stopped too");
            assert.strictEqual(previews(h2).length, 0);
            assert.strictEqual(await Post.countDocuments({ userId: String(trusted), status: "pending" }), 0);
            console.log("  [OK] (k13) a blocked word in the caption asks for the field again, trusted sellers included.");
        }

        // (k14) Confirm on a quick preview: a new seller goes to moderation, a trusted seller publishes at once
        {
            const { h } = boot();
            const u = user();
            await single(h, u, "Glock 17 900₪");
            await settle();
            const post = await confirm(h, u, previews(h)[0]);
            assert.strictEqual(post!.status, "pending");
            assert.strictEqual(previews(h).filter((c) => Number(c.params.chat_id) === MOD_GROUP).length, 1, "moderation card");
            assert.strictEqual(await draftOf(u), null);

            const trusted = user();
            const earlier = await Post.create({ userId: String(trusted), title: "t", description: "d", price: "10", location: "l", media: [], status: "approved" });
            postIds.push(String(earlier._id));
            const { h: h2 } = boot();
            await single(h2, trusted, "Glock 17 900₪");
            await settle();
            const post2 = await Post.findOne({ userId: String(trusted), _id: { $ne: earlier._id } });
            assert.strictEqual(post2, null, "nothing yet");
            await confirm(h2, trusted, previews(h2)[0]);
            const made = await Post.findOne({ userId: String(trusted), _id: { $ne: earlier._id } });
            postIds.push(String(made!._id));
            assert.strictEqual(made!.status, "approved");
            assert.ok(previews(h2).some((c) => Number(c.params.chat_id) === APPROVED_GROUP), "published at once");
            console.log("  [OK] (k14) Confirm: a new seller reaches moderation (pending), a trusted seller publishes at once.");
        }

        // (k15) /cancel inside the album window; a live draft; an expired draft
        {
            const { h } = boot();
            const u = user();
            await album(h, u, `c${u}`, 0, "Glock 17 900₪");
            await settle();
            await h.sendText("/cancel", { userId: u });
            await settle();
            h.calls.length = 0;
            await waitTimer();
            assert.strictEqual(outbound(h).length, 0, "nothing after the delay");
            assert.strictEqual(await draftOf(u), null);

            // a live draft at the title step: a captioned photo is today's expectedText, no quick draft
            const u2 = user();
            await h.sendText("/newpost", { userId: u2 });
            h.calls.length = 0;
            await single(h, u2, "Glock 17 900₪", "s5");
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("expectedText")]);
            const d2 = (await rawDraft(u2))!;
            assert.deepStrictEqual([d2.quick, d2.step, d2.media.length], [undefined, "title", 0]);

            // an expired draft + a captioned photo: one quick draft, no draftExpired
            const u3 = user();
            await h.sendText("/newpost", { userId: u3 });
            await Draft.updateOne({ userId: String(u3) }, { $set: { updatedAt: new Date(Date.now() - 3 * 3600_000) } });
            h.calls.length = 0;
            await single(h, u3, "Glock 17 900₪", "s6");
            await settle();
            assert.ok(!sent(h).some((c) => text(c) === T("draftExpired")), "no draftExpired");
            assert.strictEqual(previews(h).length, 1);
            const d3 = (await rawDraft(u3))!;
            assert.deepStrictEqual([d3.quick, d3.step, d3.media.length], [true, "confirm", 1]);
            assert.strictEqual(await Draft.countDocuments({ userId: String(u3) }), 1);

            // an expired draft + a caption-less photo: today's draftExpired
            const u4 = user();
            await h.sendText("/newpost", { userId: u4 });
            await Draft.updateOne({ userId: String(u4) }, { $set: { updatedAt: new Date(Date.now() - 3 * 3600_000) } });
            h.calls.length = 0;
            await h.sendPhoto("bare", { userId: u4 });
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("draftExpired")]);
            assert.strictEqual(await draftOf(u4), null);
            console.log("  [OK] (k15) /cancel in the window leaves nothing; a live draft keeps expectedText; an expired draft is replaced.");
        }

        // (k16) a late album item after the preview; ignored messages
        {
            const { h } = boot();
            const u = user();
            const gid = `l${u}`;
            await h.message(photo("a0"), { userId: u, mediaGroupId: gid, caption: "Glock 17 900₪" });
            await h.message(photo("a1"), { userId: u, mediaGroupId: gid });
            await settle();
            await waitTimer();
            assert.strictEqual(previews(h).length, 1);
            const d = (await draftOf(u))!;
            h.calls.length = 0;
            await h.message(photo("a2"), { userId: u, mediaGroupId: gid });
            await settle();
            assert.strictEqual(calls(h, "editMessageText").length, 1, "the preview is edited");
            assert.strictEqual(Number(calls(h, "editMessageText")[0].params.message_id), d.promptMessageId);
            assert.strictEqual(sent(h).length, 0, "no expectedText");
            assert.strictEqual((await draftOf(u))!.media.length, 3);

            // text only: not ours; a bare photo: only the hint (k27)
            const u2 = user();
            h.calls.length = 0;
            await h.sendText("hello there", { userId: u2 });
            await settle();
            assert.strictEqual(outbound(h).length, 0);
            await h.sendPhoto("lonely", { userId: u2 });
            await settle();
            assert.deepStrictEqual(outbound(h).map(text), [T("quickPhotoHint")]);
            assert.ok((await draftOf(u2))!.awaitText, "the photo waits for its text, no more");
            console.log("  [OK] (k16) a late album item grows the media and redraws the preview; text and a bare photo create nothing.");
        }

        // (k17) /start sell: key on, no draft -> the hint; live draft -> Continue / Start over; key off -> the title prompt
        {
            const { h } = boot();
            const u = user();
            await h.sendText("/start sell", { userId: u });
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("quickSellHint")]);
            assert.strictEqual(await draftOf(u), null);
            await h.sendText("/newpost", { userId: u });
            h.calls.length = 0;
            await h.sendText("/start sell", { userId: u });
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("draftInProgress")]);
            console.log("  [OK] (k17) /start sell: the hint, or the Continue / Start over question.");
        }

        // (k18) key off: an album with a caption is nothing, /start sell is the title prompt
        {
            cfg.quickListing = false;
            const { h } = boot();
            const u = user();
            await album(h, u, `o${u}`, 0, "Glock 17 900₪");
            await waitTimer();
            assert.strictEqual(outbound(h).length, 0, "no reply");
            assert.strictEqual(await draftOf(u), null, "no draft");
            await h.sendText("/start sell", { userId: u });
            await settle();
            assert.ok(text(sent(h)[0]).includes(T("welcome")), "the title prompt");
            assert.strictEqual((await draftOf(u))!.step, "title");
            cfg.quickListing = true;
            console.log("  [OK] (k18) key off: an album with a caption is ignored; /start sell asks for the title.");
        }

        // (k19) a caption-less album is silence; so is a straggler item after a WTB reply
        {
            const { h } = boot();
            const u = user();
            await album(h, u, `n${u}`, -1, "");
            await waitTimer();
            assert.strictEqual(outbound(h).length, 0, "no message");
            assert.ok((await draftOf(u))!.awaitText && !(await draftOf(u))!.title, "only a draft waiting for its text");

            const w = user();
            await h.message(photo("w0"), { userId: w, mediaGroupId: `w${w}`, caption: "מחפש nomatchzz78" });
            await waitTimer();
            assert.ok(sent(h).length === 1, "the WTB reply");
            h.calls.length = 0;
            await h.message(photo("w1"), { userId: w, mediaGroupId: `w${w}` });
            await waitTimer();
            assert.strictEqual(outbound(h).length, 0, "a straggler says nothing");
            assert.ok(!(await draftOf(w))?.title, "a straggler holds no listing");
            console.log("  [OK] (k19) a caption-less album or a straggler item leaves no draft and no message.");
        }

        // (k20) Continue on a quick draft left at step media with title and price: the preview
        {
            const { h } = boot();
            const u = user();
            const now = new Date();
            await Draft.create({ userId: String(u), chatId: u, locale: "en", step: "media", quick: true, title: "Glock", price: "900", media: [{ fileId: "m1", type: "photo" }], promptMessageId: 0, startedAt: now, updatedAt: now });
            await h.sendText("/newpost", { userId: u });
            await settle();
            h.calls.length = 0;
            await h.pressButton(`draft_continue_${u}`, { userId: u, messageId: (await draftOf(u))!.promptMessageId });
            await settle();
            assert.strictEqual(previews(h).length, 1);
            assert.strictEqual((await draftOf(u))!.step, "confirm");
            console.log("  [OK] (k20) Continue on a crashed quick draft gives the preview.");
        }

        // (k21) the DM reply lists a meetup listing with the place and a faq_1 button; a plain one has no keyboard
        {
            cfg.buyerMatches = "on";
            const stamp = new Date();
            const tag = `zr${String(user()).slice(-5)}`;
            const mk = (title: string, extra: Record<string, unknown>) => Listing.create({
                source: "group", origin: "capture", chatId: APPROVED_GROUP, messageIds: [980_000 + Math.floor(Math.random() * 9000)], sellerId: "someone-else", title, text: `${title} למכירה`,
                priceValue: 100, price: "100", location: "Haifa", media: [], isBundle: false, status: "live", hold: false, createdAt: stamp, refreshedAt: stamp, ...extra,
            });
            const { h } = boot();
            const u = user();
            const meetup = await mk(`Rifle ${tag} scope`, { meetup: true });
            await single(h, u, `מחפש ${tag}`);
            await settle();
            const reply = sent(h)[0];
            assert.ok(text(reply).includes(`Haifa · ${PLACE}`), text(reply));
            assert.ok(buttons(reply).some((b) => (b as unknown as { url: string }).url.endsWith("?start=faq_1")), "faq_1 button");
            await Listing.deleteOne({ _id: meetup._id });
            await mk(`Rifle ${tag} scope`, {});
            h.calls.length = 0;
            await single(h, u, `מחפש ${tag}`, "s2");
            await settle();
            assert.ok(!text(sent(h)[0]).includes(PLACE) && !sent(h)[0].params.reply_markup, "plain listing: no place, no keyboard");
            cfg.buyerMatches = undefined;
console.log("  [OK] (k21) the DM reply shows the meeting point and its button only for a meetup listing.");
        }

        // (k22) bumping a post with meetup keeps the faq_1 link
        {
            const { h } = boot();
            const u = user();
            await h.sendText("hi", { userId: u });
            const post = await Post.create({ userId: String(u), title: "Bumpy", description: "d", price: "10", location: "l", media: [], status: "approved", meetup: true });
            postIds.push(String(post._id));
            h.calls.length = 0;
            await h.pressButton(`bump_${post._id}`, { userId: u, messageId: 777 });
            await settle();
            const out = h.calls.find((c) => c.method === "sendRichMessage" && Number(c.params.chat_id) === APPROVED_GROUP)!;
            assert.ok(JSON.stringify(out.params.rich_message).includes("?start=faq_1"), "bump keeps the meeting-point link");
            assert.ok(!out.params.reply_markup, "no button under the group post");
            console.log("  [OK] (k22) a bumped meetup post is re-posted with the faq_1 link in its location line.");
        }

        // (k23) a long one-liner keeps what the title cut left; a model number is a title, not a price
        {
            const { h } = boot();
            const u = user();
            const long = "Glock 17 Gen3 with two spare magazines, holster, light and a case 900₪";
            await single(h, u, long);
            await settle();
            let d = (await draftOf(u))!;
            assert.ok(long.length > 60);
            assert.ok(`${d.title} ${d.description ?? ""}`.includes("holster, light and a case"), "no text lost");
            assert.strictEqual(d.description, "case", "only what the title cut left, never the title or the price");

            const u2 = user();
            await single(h, u2, "Glock 17\nnice", "s7");
            await settle();
            d = (await draftOf(u2))!;
            assert.deepStrictEqual([d.step, d.title, d.price, d.description], ["price", "Glock 17", undefined, "nice"]);
            const u3 = user();
            await single(h, u3, "Glock 17 900", "s8");
            await settle();
            d = (await draftOf(u3))!;
            assert.deepStrictEqual([d.step, d.title, d.price], ["confirm", "Glock 17", "900"]);
            console.log("  [OK] (k23) a long first line keeps what the title cut left; a bare number under 100 is part of the title.");
        }

        // (k24) a new captioned photo at a pending preview asks Continue / Start over; key off stays silent
        {
            const { h } = boot();
            const u = user();
            await single(h, u, "Glock 17 900₪");
            await settle();
            h.calls.length = 0;
            await single(h, u, "Hammer 12 300₪", "s9");
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("draftInProgress")]);
            assert.strictEqual((await draftOf(u))!.media.length, 1);
            cfg.quickListing = false;
            h.calls.length = 0;
            await single(h, u, "Hammer 12 300₪", "s10");
            await settle();
            assert.strictEqual(outbound(h).length, 0, "key off: silent as before");
            cfg.quickListing = true;
            console.log("  [OK] (k24) a new captioned photo at a preview gets the Continue / Start over question; key off is silent.");
        }

        // (k25) a crash between the claim and the update: Continue parses the caption
        {
            const { h } = boot();
            const u = user();
            const now = new Date();
            await Draft.create({ userId: String(u), chatId: u, locale: "en", step: "media", quick: true, caption: "Glock 17 900₪", media: [{ fileId: "m1", type: "photo" }], promptMessageId: 0, startedAt: now, updatedAt: now });
            await h.sendText("/newpost", { userId: u });
            await settle();
            h.calls.length = 0;
            await h.pressButton(`draft_continue_${u}`, { userId: u, messageId: (await draftOf(u))!.promptMessageId });
            await settle();
            assert.strictEqual(previews(h).length, 1);
            const d = (await rawDraft(u))!;
            assert.deepStrictEqual([d.step, d.title, d.price, d.caption], ["confirm", "Glock 17", "900", undefined]);
            console.log("  [OK] (k25) Continue on a draft that kept its caption gives the parsed preview.");
        }

        // (k26) a photo captioned with a command creates nothing
        {
            const { h } = boot();
            const u = user();
            await single(h, u, "/cancel", "s11");
            await settle();
            assert.strictEqual(await draftOf(u), null);
            assert.strictEqual(outbound(h).length, 0);
            console.log("  [OK] (k26) a photo captioned /cancel creates nothing.");
        }

        // (k27) a single caption-less photo gets a hint and no draft; an album item is silent; key off is silent
        {
            const { h } = boot();
            const u = user();
            await h.sendPhoto("bare1", { userId: u });
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("quickPhotoHint")]);
            assert.ok((await draftOf(u))!.awaitText);
            h.calls.length = 0;
            await h.sendPhoto("late1", { userId: u, mediaGroupId: "k27" });
            await waitTimer();
            assert.strictEqual(outbound(h).length, 0, "an album item stays silent");
            cfg.quickListing = false;
            await h.sendPhoto("bare2", { userId: u });
            await settle();
            cfg.quickListing = true;
            assert.strictEqual(outbound(h).length, 0, "key off: no hint");
            console.log("  [OK] (k27) a single caption-less photo gets one hint, an album item and key off stay silent.");
        }

        // (k28) the description is only what the title, price and location left
        {
            const cases: [string, string | undefined][] = [
                ["Glock 900₪", undefined],
                ["Glock\n900₪", undefined],
                ["Glock\nמחיר: 900\nחיפה", undefined],
                ["Glock\nprice: 900\nlocation: חיפה", undefined],
                ["Glock 17 מצוין\n1,300₪ מרכז", undefined],
                ["Glock\nבמצב מעולה\n1,300₪ מרכז\nטלפון 0509001234", "במצב מעולה\nטלפון 0509001234"],
                ["Glock 900₪\nשתי מחסניות, בחיפה", "שתי מחסניות"],
            ];
            const { h } = boot();
            for (const [caption, want] of cases) {
                const u = user();
                await single(h, u, caption);
                await settle();
                assert.strictEqual((await draftOf(u))!.description, want, caption);
            }
            console.log("  [OK] (k28) a quick description never repeats the title, price or location; nothing left means none.");
        }

        // (k29) /faq and start=faq_1 send the widget in a DM; a press on an old text FAQ edits it (with the padding);
        // "text version" under a widget sends the text FAQ as a new message; a refused widget falls back to the text
        {
            const { h } = boot();
            const u = user();
            await h.sendText("/faq", { userId: u });
            await settle();
            await h.sendText("/start faq_1", { userId: u });
            await settle();
            const widgets = h.calls.filter((c) => c.method === "sendWidget");
            assert.strictEqual(widgets.length, 2, "/faq and start=faq_1 each send a widget");
            for (const w of widgets) {
                assert.strictEqual(Number(w.params.chat_id), u);
                assert.ok(String(w.params.html).includes(`<button data-i="0" class="on">`), "faq_1 opens the meeting-point topic");
                assert.deepStrictEqual(rows(w), [["faq_root"]], "one text-version button");
            }
            assert.ok(!h.calls.some((c) => c.method === "sendMessage" && String(c.params.text ?? "").includes("<b>")), "no text FAQ next to a widget");
            await h.pressButton("faq_1", { userId: u, messageId: 900 });
            await settle();
            await h.send({ callback_query: { id: "cbw", chat_instance: "ci", from: { id: u, is_bot: false, first_name: "Tester" }, data: "faq_root",
                message: { message_id: 901, date: 0, chat: { id: u, type: "private" }, widget: { html: "<p>x</p>" } } } });
            await settle();
            const msgs = h.calls.filter((c) => ["sendMessage", "editMessageText"].includes(c.method) && String(c.params.text ?? "").includes("<b>"));
            assert.deepStrictEqual(msgs.map((c) => c.method), ["editMessageText", "sendMessage"], "old text FAQ is edited, a widget's text version is a new message");
            assert.strictEqual(Number(msgs[0].params.message_id), 900);
            for (const m of msgs) assert.ok(text(m).endsWith(FAQ_PADDING), text(m));
            assert.strictEqual(FAQ_PADDING, "\n" + "\u2800".repeat(30));

            const { h: h2 } = boot({ responses: { sendWidget: { ok: false, error_code: 400, description: "Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED" } } });
            await h2.sendText("/faq", { userId: u });
            await settle();
            const fallback = h2.calls.filter((c) => c.method === "sendMessage" && String(c.params.text ?? "").includes("<b>"));
            assert.strictEqual(fallback.length, 1, "a refused widget falls back to the text FAQ");
            assert.ok(text(fallback[0]).endsWith(FAQ_PADDING));
            console.log("  [OK] (k29) /faq and start=faq_1 send the widget, its text version and a refused widget fall back to the text FAQ.");
        }

        // (k32) the preview's description button asks for it and comes back to the preview with the new text
        {
            const { h } = boot();
            const u = user();
            const preview = await toPreview(h, u);
            await press(h, u, `draft_edit_description_${u}`, messageId(preview));
            assert.strictEqual((await draftOf(u))!.step, "description");
            assert.strictEqual((await draftOf(u))!.fixing, true);
            await h.sendText("תיאור חדש לגמרי", { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.description, d.fixing], ["confirm", "תיאור חדש לגמרי", undefined]);
            console.log("  [OK] (k32) the preview can edit the description.");
        }

        // (k31) /pending: a refused photo falls back to text with the buttons, and the next post still goes
        {
            const { default: User } = await import("../models/User");
            const { h } = boot({ responses: { sendRichMessage: (p: Record<string, unknown>) => JSON.stringify(p.rich_message).includes("BrokenPending") ? { ok: false, error_code: 400, description: "Bad Request: RICH_MESSAGE_PHOTO_INVALID" } : undefined } });
            const u = user();
            await h.sendText("hi", { userId: u });
            await User.updateOne({ userId: String(u) }, { $set: { authLevel: 2 } }).exec();
            await Post.deleteMany({ status: "pending" }).exec(); // the queue shows 10 at most; this is the throwaway test DB
            const later = new Date();
            for (const title of ["BrokenPending", "FinePending"]) {
                const p = await Post.create({ userId: String(u), title, description: "d", price: "10", location: "l", media: [], status: "pending", createdAt: later });
                postIds.push(String(p._id));
            }
            h.calls.length = 0;
            await h.sendText("/pending", { userId: u });
            await settle();
            const pendingIds = await Post.find({ status: "pending", title: "BrokenPending", userId: String(u) }).exec();
            const fallback = sent(h).find((c) => text(c).startsWith("BrokenPending"));
            assert.ok(fallback, "the refused post goes as text");
            assert.deepStrictEqual(buttons(fallback!).map((b) => b.callback_data), [`approve_${pendingIds[0]._id}`, `reject_${pendingIds[0]._id}`]);
            assert.ok(h.calls.some((c) => c.method === "sendRichMessage" && JSON.stringify(c.params.rich_message).includes("FinePending")), "the next post still goes");
            assert.ok(!sent(h).some((c) => text(c) === T("adminError")), "no error for the whole command");
            await Post.deleteMany({ _id: { $in: postIds } }).exec();
            await User.deleteOne({ userId: String(u) }).exec();
            postIds.length = 0;
            console.log("  [OK] (k31) /pending: a refused photo falls back to text.");
        }

        // (k30) /myposts: a refused photo falls back to text with the buttons, the next post and the Relist row still go
        {
            const { default: listingRepository } = await import("../repositories/listingRepository");
            const { h } = boot({ responses: { sendRichMessage: (p: Record<string, unknown>) => JSON.stringify(p.rich_message).includes("Broken") ? { ok: false, error_code: 400, description: "Bad Request: RICH_MESSAGE_PHOTO_INVALID" } : undefined } });
            const u = user();
            await h.sendText("hi", { userId: u });
            const mk = async (title: string, extra: Record<string, unknown> = {}) => {
                const p = await Post.create({ userId: String(u), title, description: "d", price: "10", location: "l", media: [], status: "approved", createdAt: new Date(), ...extra });
                postIds.push(String(p._id));
                return p;
            };
            const broken = await mk("Broken");
            await mk("Fine");
            const ended = await listingRepository.createForPost(await mk("Ended", { status: "sold" }), "dm", false, new Date());
            await listingRepository.markExpired(String(ended._id), new Date());
            h.calls.length = 0;
            await h.sendText("/myposts", { userId: u });
            await settle();
            const fallback = sent(h).find((c) => text(c).startsWith("Broken"))!;
            assert.ok(text(fallback).includes("💰 10") && text(fallback).includes("📍 l"), text(fallback));
            assert.deepStrictEqual(buttons(fallback).map((b) => b.callback_data), [`sold_${broken._id}`, `bump_${broken._id}`, `lp_${broken._id}`]);
            assert.ok(previews(h).some((c) => JSON.stringify(c.params.rich_message).includes("Fine")), "the next post still goes");
            const relist = sent(h).find((c) => text(c) === T("endedSectionTitle"))!;
            assert.ok(relist, "the Relist section still goes");
            // Relist itself sends nothing rich, so a bad photo cannot break it
            h.calls.length = 0;
            await h.pressButton(buttons(relist)[0].callback_data, { userId: u, messageId: 901 });
            await settle();
            assert.deepStrictEqual(toasts(h), [T("listingRefreshedToast")]);
            assert.strictEqual(previews(h).length, 0);
            console.log("  [OK] (k30) a refused photo costs that post its picture only: text with buttons, next post, Relist.");
        }

        // (k31) a caption-less photo, then its text: one quick draft; the hint went out at once
        {
            const { h } = boot();
            const u = user();
            await h.sendPhoto("pt1", { userId: u });
            await settle();
            assert.deepStrictEqual(sent(h).map(text), [T("quickPhotoHint")], "the hint at once");
            const waiting = (await draftOf(u))!;
            assert.ok(waiting.awaitText && waiting.awaitText.getTime() - Date.now() <= QUICK_TEXT_WINDOW_MS && waiting.awaitText.getTime() > Date.now());
            h.calls.length = 0;
            await h.sendText("Glock 17 900₪ חיפה", { userId: u });
            await settle();
            assert.strictEqual(previews(h).length, 1, "one preview");
            const d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.title, d.price, d.media.length, d.awaitText], ["confirm", "Glock 17", "900", 1, undefined]);
            h.calls.length = 0;
            await h.sendText("another text", { userId: u });
            await settle();
            assert.strictEqual(outbound(h).length, 0, "a second text is nothing");
            assert.strictEqual(await Draft.countDocuments({ userId: String(u) }), 1);
            console.log("  [OK] (k31) a photo then its text join into one quick draft; the hint is not held back.");
        }

        // (k32) restart between the photo and its text
        {
            const { h } = boot();
            const u = user();
            await h.sendPhoto("pt2", { userId: u });
            await settle();
            const { h: h2 } = boot();
            await h2.sendText("Glock 19 700₪", { userId: u });
            await settle();
            assert.strictEqual(previews(h2).length, 1, "the new controller finishes it");
            assert.strictEqual((await draftOf(u))!.title, "Glock 19");
            console.log("  [OK] (k32) a restart between photo and text loses nothing.");
        }

        // (k33) forwarded photo and text; an album then its text (while collecting, and after)
        {
            const { h } = boot();
            const u = user();
            const forwardOrigin = { type: "hidden_user", date: 1, sender_user_name: "Seller" };
            await h.message(photo("f1"), { userId: u, forwardOrigin });
            await settle();
            await h.sendText("M4 1,200 ₪ חיפה", { userId: u, forwardOrigin });
            await settle();
            assert.strictEqual(previews(h).length, 1, "forward: one preview");
            assert.strictEqual((await draftOf(u))!.price, "1200");

            const a = user();
            h.calls.length = 0;
            await album(h, a, `ga${a}`, -1, "");
            await h.sendText("M4 1,200 ₪ חיפה", { userId: a });
            await waitTimer();
            assert.strictEqual(previews(h).length, 1, "album, text at once: one preview");
            assert.strictEqual((await draftOf(a))!.media.length, 3);

            const b = user();
            h.calls.length = 0;
            await album(h, b, `gb${b}`, -1, "");
            await waitTimer();
            assert.strictEqual(outbound(h).length, 0, "the bare album is silent");
            await h.sendText("M4 1,200 ₪ חיפה", { userId: b });
            await settle();
            assert.strictEqual(previews(h).length, 1, "album, text after: one preview");
            assert.strictEqual((await draftOf(b))!.media.length, 3);
            console.log("  [OK] (k33) a forwarded photo and text, and an album then text, each give one draft.");
        }

        // (k34) no photo, no draft; a late text; a photo with no text; a new photo restarts the wait
        {
            const { h } = boot();
            const u = user();
            await h.sendText("Glock 17 900₪", { userId: u });
            await settle();
            assert.strictEqual(outbound(h).length, 0);
            assert.strictEqual(await Draft.countDocuments({ userId: String(u) }), 0, "text alone starts nothing");

            await h.sendPhoto("late", { userId: u });
            await settle();
            h.calls.length = 0;
            await Draft.updateOne({ userId: String(u) }, { awaitText: new Date(Date.now() - 1000) });
            await h.sendText("Glock 17 900₪", { userId: u });
            await settle();
            assert.strictEqual(outbound(h).length, 0, "past the window the text is nothing");
            assert.strictEqual(await Draft.countDocuments({ userId: String(u) }), 0, "and the photo is gone");

            await h.sendPhoto("p-a", { userId: u });
            await h.sendPhoto("p-b", { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            assert.deepStrictEqual(d.media.map((m) => m.fileId), ["p-b"], "a new photo restarts the wait");
            assert.strictEqual(previews(h).length, 0, "a photo with no text gets the hint only");

            // /newpost right after a bare photo is the wizard, not Continue / Start over
            h.calls.length = 0;
            await h.sendText("/newpost", { userId: u });
            await settle();
            assert.ok(text(sent(h)[0]).startsWith(T("welcome")));
            // key off: nothing waits
            const w = user();
            cfg.quickListing = false;
            await h.sendPhoto("off1", { userId: w });
            cfg.quickListing = true;
            assert.strictEqual(await Draft.countDocuments({ userId: String(w) }), 0);
            console.log("  [OK] (k34) text alone starts nothing, a late text is nothing, /newpost ignores the wait, key off holds no photo.");
        }

        // (k35) the wizard's own media step still takes photos; a WTB text after a photo is a buyer reply
        {
            const { h } = boot();
            const u = user();
            await toLocation(h, u);
            await h.sendText("Tel Aviv", { userId: u });
            await settle();
            await h.sendPhoto("w1", { userId: u });
            await h.sendPhoto("w2", { userId: u });
            await settle();
            const d = (await draftOf(u))!;
            assert.deepStrictEqual([d.step, d.media.length, d.awaitText], ["media", 2, undefined]);

            const b = user();
            await h.sendPhoto("wtb1", { userId: b });
            h.calls.length = 0;
            await h.sendText("מחפש nomatchzz78", { userId: b });
            await settle();
            assert.strictEqual(sent(h).length, 1, "the buyer reply");
            assert.strictEqual(await Draft.countDocuments({ userId: String(b) }), 0);
            console.log("  [OK] (k35) the wizard media step is untouched; a wanted text after a photo is a buyer reply, no draft.");
        }

        // (k36) real captions: lone opener line, a price inside a sentence, an area line
        {
            const { h } = boot();
            const u = user();
            const sentence = "ללא פנס וכוונת שבתמונה ימכר 3500 ₪ 🤯";
            await single(h, u, `למכירה,\nColt m4 DD RIS 2 14.5”\n${sentence}\nאזור אש העין`);
            await settle();
            const d = (await draftOf(u))!;
            assert.deepStrictEqual([d.title, d.price, d.location, d.description], ["Colt m4 DD RIS 2 14.5”", "3500", "אש העין", sentence]);

            const v = user();
            await single(h, v, "למכירה: Glock 17 Gen3 with two spare magazines, holster, light and a case 900₪", "s36");
            await settle();
            const e = (await draftOf(v))!;
            assert.ok(!e.title!.startsWith("למכירה"));
            assert.ok(`${e.title} ${e.description ?? ""}`.includes("holster, light and a case"), "no text lost after a dropped opener");
            console.log("  [OK] (k36) a lone opener line, a price inside a sentence and an area line parse into the draft.");
        }
    } finally {
        cfg.quickListing = wasQuick;
        cfg.minimumPhotos = wasMin;
        cfg.buyerMatches = wasMatches;
    }
}
