import assert from "assert";
import { Types } from "mongoose";
import {
    buildAskNote, buildEndedCard, buildManagementCard, buildNeverNote, escapeHtml,
    nudgeKeyboard, parseCaptureArg, parseListingArg, type Card,
} from "../services/listingCards";
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

// meeting point line: flag or location, never when neither
{
    const base = { _id: new Types.ObjectId(ID), title: "גלוק", price: "100" };
    const plain = buildManagementCard(t, base, { surface: "c" });
    all.push(plain);
    assert(!plain.text.includes("📍"));
    const flagged = buildManagementCard(t, { ...base, meetup: true, location: "Haifa" }, { surface: "c" });
    all.push(flagged);
    assert.strictEqual(flagged.text, `${plain.text}
📍 Haifa · meetupPlace`);
    const byName = buildManagementCard(t, { ...base, location: "בית דגן" }, { surface: "c" });
    all.push(byName);
    assert.strictEqual(byName.text, `${plain.text}
📍 בית דגן`);
    assert.strictEqual(buildManagementCard(t, { ...base, location: "Haifa" }, { surface: "c" }).text, plain.text);
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
