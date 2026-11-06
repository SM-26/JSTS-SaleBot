import assert from "assert";
import { Types } from "mongoose";
import {
    buildAskNote, buildCatchupList, buildCatchupNote, buildEndedCard, buildManagementCard, buildNeverNote, escapeHtml,
    catchupActionData, nudgeKeyboard, parseCaptureArg, parseCatchupArg, parseListingArg, type Card,
} from "../services/listingCards";
import type { CatchupItem } from "../services/catchupScan";
import { alertActionData, displayQuery, buildAlertCard, buildAlertsList, buildBuyerNote, buildRenewOffer, parseAlertArg } from "../services/buyerCards";

/** Pure card builders and callback_data codecs; no Mongo, no config. Run: pnpm run check-cards */

console.log("[INFO] Checking listing cards...");

const ID = "65f1c2a9e4b0c3d2a1f09876";
const BOT = "JSTS_testing_bot";
const t = (k: string, p?: Record<string, string | number | boolean>): string => k + (p ? JSON.stringify(p) : "");
const all: Card[] = [];
const datas = (c: Card): Array<string | undefined> => c.keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : undefined));
const urls = (c: Card): Array<string | undefined> => c.keyboard.flat().map((b) => ("url" in b ? b.url : undefined));

// ask note complete
{
    const c = buildAskNote(t, { id: ID, parsed: { title: "גלוק 17", price: "1,300₪", location: "מרכז", isBundle: false } }, BOT);
    all.push(c);
    assert(c.text.startsWith("captureNoteComplete"));
    assert(c.text.includes('"title":"גלוק 17"') && c.text.includes('"details":"1,300₪ · מרכז"'));
    assert.deepStrictEqual(c.keyboard.map((r) => r.length), [1, 2]); // Add alone, then Not now + Don't ask again
    assert.deepStrictEqual(datas(c), [`mk_${ID}_a`, `mk_${ID}_n`, `mk_${ID}_x`]);
    assert.strictEqual(c.keyboard[0][0].style, "success"); // green Add (a ➕ alone was hard to see)
}

// catch-up note and list (synthetic items)
{
    const n = buildCatchupNote(t, { memberId: ID, count: 3 }, BOT);
    all.push(n);
    assert.strictEqual(n.text, 'catchupOfferNote{"n":3}');
    assert.deepStrictEqual(n.keyboard.map((r) => r.length), [1, 1]);
    assert.deepStrictEqual(urls(n), [`https://t.me/${BOT}?start=k_${ID}`, undefined]);
    assert.deepStrictEqual(datas(n), [undefined, `ck_${ID}_x`]);
    assert.strictEqual(n.keyboard[0][0].style, "success");
    assert.strictEqual((n.keyboard[0][0] as { text: string }).text, "catchupPickButton");
    assert.strictEqual((n.keyboard[1][0] as { text: string }).text, "catchupNoThanksButton");

    assert.strictEqual(catchupActionData(ID, "x"), `ck_${ID}_x`);
    assert.strictEqual(catchupActionData(ID, 1234567), `ck_${ID}_1234567`);
    assert.deepStrictEqual(parseCatchupArg(`${ID}_x`), { memberId: ID, action: "x" });
    assert.deepStrictEqual(parseCatchupArg(`${ID}_42`), { memberId: ID, action: "add", messageId: 42 });
    for (const bad of [`${ID}_0`, `${ID}_a`, `${ID}_`, `${ID}_01`, "abc123_x", `${ID}x_5`, ""]) assert.strictEqual(parseCatchupArg(bad), null, bad);

    const item = (i: number, title = `Item ${i}`): CatchupItem => ({ messageId: 1000 + i, date: "2026-10-20T10:00:00", title, price: `${i}00₪`, location: "Center", text: "x", tier: "strict" });
    const l = buildCatchupList(t, { memberId: ID, items: [item(1), item(2, "ציוד טקטי ארוך מאוד מאוד מאוד מאוד מאוד מאוד מאוד מאוד")] });
    all.push(l);
    assert.deepStrictEqual(datas(l), [`ck_${ID}_1001`, `ck_${ID}_1002`]);
    assert(l.text.startsWith("catchupListTitle"));
    assert(l.text.includes("1. Item 1 · 100₪ · Center") && l.text.includes("2. "));
    const labels = l.keyboard.flat().map((b) => b.text);
    assert.strictEqual(labels[0], "➕ 1. Item 1");
    assert(labels.every((x) => [...x].length <= 32), "labels trimmed to 32");
    const many = buildCatchupList(t, { memberId: ID, items: Array.from({ length: 20 }, (_, i) => item(i + 1)) });
    all.push(many);
    assert.strictEqual(many.keyboard.flat().length, 15);
    assert(many.text.length < 4096);
    const none = buildCatchupList(t, { memberId: ID, items: [] });
    assert.strictEqual(none.text, "catchupAllDone");
    assert.strictEqual(none.keyboard.length, 0);
}

// ask note incomplete (no title, or no price)
for (const parsed of [{ price: "100", isBundle: false }, { title: "x", isBundle: false }]) {
    const c = buildAskNote(t, { id: ID, parsed }, BOT);
    all.push(c);
    assert(c.text.startsWith("captureNoteIncomplete"));
    assert.deepStrictEqual(c.keyboard.map((r) => r.length), [1, 2]);
    assert.strictEqual(urls(c)[0], `https://t.me/${BOT}?start=c_${ID}`);
    assert.strictEqual(datas(c)[0], undefined);
    assert.deepStrictEqual(datas(c).slice(1), [`mk_${ID}_n`, `mk_${ID}_x`]);
}

// nudge keyboard: lc_ formats, remove only for a group listing
{
    const g = nudgeKeyboard({ _id: new Types.ObjectId(ID), source: "group" }, t, BOT).flat().map((b) => ("callback_data" in b ? b.callback_data : undefined));
    assert.deepStrictEqual(g, [`lc_r_${ID}`, `lc_s_${ID}`, `lc_x_${ID}`, undefined]);
    const b = nudgeKeyboard({ _id: new Types.ObjectId(ID), source: "bot" }, t).flat().map((x) => ("callback_data" in x ? x.callback_data : undefined));
    assert.deepStrictEqual(b, [`lc_r_${ID}`, `lc_s_${ID}`]);
}

// management card n / c
{
    const listing = { _id: new Types.ObjectId(ID), title: "גלוק", price: "100" };
    const n = buildManagementCard(t, listing, { surface: "n", botUsername: BOT });
    all.push(n);
    assert(n.text.startsWith("listingCard"));
    assert.strictEqual(n.keyboard.length, 2);
    assert.deepStrictEqual(datas(n).slice(0, 3), [`ls_${ID}_s_n`, `ls_${ID}_f_n`, `ls_${ID}_r_n`]);
    assert.deepStrictEqual(n.keyboard.map((r) => r.length), [2, 2]);
    assert.strictEqual(urls(n)[3], `https://t.me/${BOT}?start=l_${ID}`);
    assert.strictEqual(datas(n)[3], undefined);
    const c = buildManagementCard(t, listing, { surface: "c" });
    all.push(c);
    assert.deepStrictEqual(c.keyboard.map((r) => r.length), [2, 1]);
    assert(datas(c).every((d) => d?.endsWith("_c")));
    const r = buildManagementCard(t, listing, { surface: "c", refreshed: true });
    all.push(r);
    assert(r.text.startsWith("listingRefreshedCard"));
}

// ended card
for (const [status, key] of [["sold", "listingSoldNote"], ["removed", "listingRemovedNote"], ["taken_down", "listingEnded"], ["expired", "listingEnded"]] as const) {
    const c = buildEndedCard(t, { status, title: "x" });
    all.push(c);
    assert(c.text.startsWith(key), status);
    assert.deepStrictEqual(c.keyboard, []);
}

// never note
{
    const c = buildNeverNote(t, BOT);
    all.push(c);
    assert(c.text.startsWith("captureNeverNote"));
    assert.strictEqual(c.keyboard.length, 1);
    assert.deepStrictEqual(urls(c), [`https://t.me/${BOT}`]);
}

// parse round trip
assert.deepStrictEqual(parseListingArg(ID + "_f_c"), { listingId: ID, action: "f", surface: "c" });
for (const bad of [`${ID}_x_c`, `${ID}_s_z`, "zz_s_n"]) assert.strictEqual(parseListingArg(bad), null, bad);
assert.deepStrictEqual(parseCaptureArg(ID + "_x"), { captureId: ID, action: "x" });
assert.strictEqual(parseCaptureArg("set_ask"), null);

// buyer cards
{
    const lines = [
        { title: "Glock <b>17</b>", price: "1,300", location: "North", date: "2026-11-01", link: "https://t.me/c/1/2" },
        { title: "Hi-capa", date: "2026-10-30" },
    ];
    const n = buildBuyerNote(t, lines, ID, BOT);
    all.push(n);
    assert(n.html === true && n.text.startsWith("buyerNoteTitle") && n.text.includes('"n":2'));
    assert(n.text.includes("Glock &lt;b&gt;17") && !n.text.includes("<b>17") && n.text.includes("Hi-capa"));
    assert(n.text.includes('<a href="https://t.me/c/1/2">') && n.text.includes("2026-11-01"));
    assert(urls(n)[0]!.endsWith(`?start=s_${ID}`));
    assert.strictEqual(buildBuyerNote(t, [], ID, BOT).text, "buyerNoteEmpty");
    assert(!buildAlertCard(t, "q", lines[1]).text.includes("<a"));
    assert(buildAlertCard(t, "a<b", lines[0]).text.includes("a&lt;b"));
    const list = buildAlertsList(t, [{ id: ID, query: "x".repeat(200), expiresAt: new Date("2026-12-01") }]);
    all.push(list);
    assert.deepStrictEqual(datas(list), [`al_${ID}_d`]);
    assert(list.keyboard[0][0].text.startsWith("🗑") && list.keyboard[0][0].text.length <= 30);
    assert.strictEqual(buildAlertsList(t, []).text, "alertsEmpty");
    const r = buildRenewOffer(t, { id: ID, query: "q", expiresAt: new Date("2026-12-01") });
    all.push(r);
    assert.deepStrictEqual(datas(r), [`al_${ID}_r`]);
    assert.deepStrictEqual(parseAlertArg(`${ID}_d`), { searchId: ID, action: "d" });
    assert.strictEqual(parseAlertArg(`${ID}_x`), null);
    assert.strictEqual(alertActionData(ID, "r"), `al_${ID}_r`);
    assert.strictEqual(displayQuery("בירושלימ ומשלוח לחיפה"), "בירושלים ומשלוח לחיפה");
    assert.strictEqual(displayQuery("גריפ"), "גריפ");
    assert.strictEqual(displayQuery("מ מ"), "מ מ");
    assert.strictEqual(displayQuery("בירושלימ"), "בירושלים");
    assert.strictEqual(displayQuery("glock 17"), "glock 17");
    assert.strictEqual(displayQuery("a b c d e f g h i j"), "a b c d e f");
    const raw = buildBuyerNote(t, [{ title: "", price: "<500", date: "2026-11-01" }], ID, BOT).text;
    assert(!raw.includes("<500") && raw.includes("&lt;500"), "an empty title leaves the price escaped");
}

// callback_data size
for (const c of all) for (const d of datas(c)) if (d) assert(Buffer.byteLength(d) <= 64, d);

assert.strictEqual(escapeHtml("a<b>&"), "a&lt;b&gt;&amp;");

console.log("[PASS] Listing cards OK");
