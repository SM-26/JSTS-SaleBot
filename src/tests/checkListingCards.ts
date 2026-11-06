import assert from "assert";
import { Types } from "mongoose";
import {
    buildAskNote, buildEndedCard, buildManagementCard, buildNeverNote, escapeHtml,
    parseCaptureArg, parseListingArg, type Card,
} from "../services/listingCards";

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

// management card n / c
{
    const listing = { _id: new Types.ObjectId(ID), title: "גלוק", price: "100" };
    const n = buildManagementCard(t, listing, { surface: "n", botUsername: BOT });
    all.push(n);
    assert(n.text.startsWith("listingCard"));
    assert.strictEqual(n.keyboard.length, 2);
    assert.deepStrictEqual(datas(n).slice(0, 3), [`ls_${ID}_s_n`, `ls_${ID}_f_n`, `ls_${ID}_r_n`]);
    assert.strictEqual(n.keyboard[1].length, 1);
    assert.strictEqual(urls(n)[3], `https://t.me/${BOT}?start=l_${ID}`);
    assert.strictEqual(datas(n)[3], undefined);
    const c = buildManagementCard(t, listing, { surface: "c" });
    all.push(c);
    assert.strictEqual(c.keyboard.length, 1);
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

// callback_data size
for (const c of all) for (const d of datas(c)) if (d) assert(Buffer.byteLength(d) <= 64, d);

assert.strictEqual(escapeHtml("a<b>&"), "a&lt;b&gt;&amp;");

console.log("[PASS] Listing cards OK");
