import assert from "assert";
import fs from "fs";
import { BLOCKED_WORDS_PATH } from "../services/blockedWords";
import { scanExport, formatSummary, parseCatchupFile } from "../services/catchupScan";

let failed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
    } catch (err) {
        failed++;
        console.error(`[FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

const now = new Date("2026-11-06T12:00:00Z");
// synthetic export: seconds after a base time inside the 30-day range
const base = Math.floor(new Date("2026-11-01T10:00:00Z").getTime() / 1000);
let nextId = 1;
type Row = Record<string, unknown>;
const msg = (id: number, user: number, at: number, extra: Row): Row => ({
    id,
    type: "message",
    date_unixtime: String(base + at),
    from: `Seller ${user}`,
    from_id: `user${user}`,
    ...extra,
});
const sale = (user: number, at: number, text: string, extra: Row = {}): Row => msg(nextId++, user, at, { text, photo: "photos/p.jpg", ...extra });
const scan = (messages: Row[], opts: { topicId?: number; exclude?: string[] } = {}) => scanExport({ messages }, { now, ...opts });
const P = "למכירה M4 900₪";

check("last 30 days only", () => {
    const old = { ...sale(1, 0, P), date_unixtime: String(Math.floor(now.getTime() / 1000) - 31 * 86400) };
    assert.strictEqual(scan([old]).file.sellers.length, 0);
    assert.strictEqual(scan([sale(1, 0, P)]).file.sellers.length, 1);
});

check("date falls back from date_unixtime", () => {
    const m = sale(1, 0, P);
    delete m.date_unixtime;
    m.date = "2026-11-01T10:00:00";
    assert.strictEqual(scan([m]).file.sellers[0].items.length, 1);
});

check("text and photo 20 s apart are one window with media", () => {
    const r = scan([msg(1, 1, 0, { text: "גלוק 17 למכירה 1,300₪" }), msg(2, 1, 20, { text: "", photo: "p.jpg" })]);
    assert.strictEqual(r.summary.windows, 1);
    assert.strictEqual(r.summary.byTier.strict, 1); // media seen: strict, not ask
    assert.strictEqual(r.file.sellers[0].items[0].messageId, 1);
});

check("40 s apart are two windows", () => {
    const r = scan([sale(1, 0, "גלוק 17 למכירה 1,300₪"), sale(1, 40, "כוונת אדומה למכירה 300₪")]);
    assert.strictEqual(r.summary.windows, 2);
    assert.strictEqual(r.summary.items, 2);
});

check("a run past 90 s from the first splits", () => {
    const texts = ["", "", "", "", ""].map((_, i) => msg(100 + i, 1, i * 25, { text: i === 0 ? "גלוק 17 למכירה 1,300₪" : "", photo: "p.jpg" }));
    // 0, 25, 50, 75 join (all < 30 s apart, < 90 s from first); 100 s is past the cap
    assert.strictEqual(scan(texts).summary.windows, 2);
});

check("tiers: strict and ask kept, wtb and none dropped, blocked is none", () => {
    const r = scan([
        sale(1, 0, "גלוק 17 למכירה 1,300₪"),
        sale(2, 0, "1300 מרכז כוונת"),
        sale(3, 0, "מחפש M4 עד 800₪"),
        sale(4, 0, "מישהו יודע מתי המשחק?"),
        sale(5, 0, "מוכר נשק 500₪"),
    ]);
    assert.deepStrictEqual(r.summary.byTier, { strict: 1, ask: 1, wtb: 1, none: 2 });
    assert.deepStrictEqual(r.file.sellers.map(s => s.userId), ["1", "2"]);
});

check("same text twice merges to the newest messageId and date", () => {
    const a = sale(1, 0, P);
    const b = sale(1, 3600, P);
    const r = scan([a, b]);
    const items = r.file.sellers[0].items;
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].messageId, b.id);
    assert.strictEqual(items[0].date, new Date((base + 3600) * 1000).toISOString());
    assert.strictEqual(r.summary.merged, 1);
});

check("overlap over 0.8 with a different title stays two items", () => {
    const r = scan([sale(1, 0, "גלוק 17 למכירה 1,300₪ מרכז"), sale(1, 3600, "גלוק 19 למכירה 1,300₪ מרכז")]);
    assert.strictEqual(r.file.sellers[0].items.length, 2);
});

check("no title is dropped and counted", () => {
    const r = scan([sale(1, 0, "1300")]);
    assert.strictEqual(r.summary.noTitle, 1);
    assert.strictEqual(r.summary.items, 0);
});

check("skipped without throwing", () => {
    const r = scan([
        msg(900, 1, 0, { type: "service", text: P }),
        msg(901, 1, 100, { text: P, from_id: "channel1" }),
        msg(902, 1, 200, { text: P, forwarded_from: "x" }),
        msg(903, 1, 300, { text: P, reply_to_message_id: 5 }),
        msg(904, 1, 400, { text: "/newPost " + P }),
        msg(905, 1, 500, { text: ["למכירה ", { type: "bold", text: "M4" }, " 900₪"], photo: "p.jpg" }),
    ]);
    assert.strictEqual(r.summary.items, 1);
    assert.strictEqual(r.file.sellers[0].items[0].messageId, 905);
    assert.strictEqual(scanExport({}, { now }).summary.items, 0);
    assert.strictEqual(scanExport(42, { now }).summary.items, 0);
});

check("topicId keeps only that topic", () => {
    const r = scan([sale(1, 0, P, { reply_to_message_id: 73 }), sale(2, 0, P, { reply_to_message_id: 74 }), sale(3, 0, P)], { topicId: 73 });
    assert.deepStrictEqual(r.file.sellers.map(s => s.userId), ["1"]);
});

check("exclude drops that user", () => {
    const r = scan([sale(1, 0, P), sale(2, 0, P)], { exclude: ["1"] });
    assert.deepStrictEqual(r.file.sellers.map(s => s.userId), ["2"]);
});

check("parseCatchupFile round-trips and rejects bad rows", () => {
    const { file } = scan([sale(1, 0, P)]);
    assert.deepStrictEqual(parseCatchupFile(JSON.parse(JSON.stringify(file))), file);
    type F = Record<string, unknown> & { sellers: (Record<string, unknown> & { items: Record<string, unknown>[] })[] };
    const bad = (mut: (f: F) => void) => {
        const f = JSON.parse(JSON.stringify(file)) as F;
        mut(f);
        return parseCatchupFile(f);
    };
    assert.strictEqual(parseCatchupFile("x"), null);
    assert.strictEqual(parseCatchupFile(null), null);
    assert.strictEqual(bad(f => (f.version = 2)), null);
    assert.strictEqual(bad(f => (f.sellers[0].userId = "abc")), null);
    assert.strictEqual(bad(f => (f.sellers[0].items[0].messageId = "5")), null);
    assert.strictEqual(bad(f => (f.sellers[0].items[0].title = "")), null);
    assert.strictEqual(bad(f => (f.sellers[0].items[0].tier = "wtb")), null);
});

check("same title with overlap over 0.8 merges to the newest", () => {
    const a = sale(1, 0, "גלוק 17 למכירה 1,300₪\nמרכז במצב מצוין כולל תיק ושני מגזינים");
    const b = sale(1, 3600, "גלוק 17 למכירה 1,300₪\nמרכז במצב מצוין כולל תיק ושני מגזינים ומחסנית");
    const r = scan([a, b]);
    assert.strictEqual(r.file.sellers[0].items.length, 1);
    assert.strictEqual(r.file.sellers[0].items[0].messageId, b.id);
    assert.strictEqual(r.summary.merged, 1);
});

check("a forward from a deleted account (null) is skipped", () => {
    assert.strictEqual(scan([sale(1, 0, P, { forwarded_from: null })]).summary.messages, 0);
});

check("media is photo or video only: stickers, animations and video messages are not", () => {
    for (const media_type of ["sticker", "animation", "video_message"]) {
        assert.strictEqual(scan([msg(nextId++, 1, 0, { text: "", mime_type: "video/mp4", media_type })]).summary.messages, 0, media_type);
    }
    assert.strictEqual(scan([msg(nextId++, 1, 0, { text: "", mime_type: "video/mp4", media_type: "video_file" })]).summary.messages, 1);
    const r = scan([msg(nextId++, 1, 0, { text: P, mime_type: "video/mp4", media_type: "sticker" })]);
    assert.strictEqual(r.summary.byTier.strict, 0, "a sticker is not media for the tier");
});

check("a message with no text and no media neither opens nor extends a window", () => {
    assert.strictEqual(scan([msg(nextId++, 1, 0, { text: "" })]).summary.windows, 0);
    const r = scan([sale(1, 0, P), msg(nextId++, 1, 20, { text: "" }), sale(1, 45, "כוונת אדומה למכירה 300₪")]);
    assert.strictEqual(r.summary.windows, 2, "the empty message did not extend the first window");
});

check("topic 1 means General", () => {
    const r = scan([sale(1, 0, P), sale(2, 0, P, { reply_to_message_id: 73 })], { topicId: 1 });
    assert.deepStrictEqual(r.file.sellers.map(s => s.userId), ["1"]);
});

check("a blocked word in a hidden link makes the window tier none", () => {
    const word = (JSON.parse(fs.readFileSync(BLOCKED_WORDS_PATH, "utf8")) as string[]).find(w => !w.includes("*"));
    assert.ok(word, "the blocklist has a plain entry");
    const text = ["גלוק 17 למכירה 1,300₪ ", { type: "text_link", text: "link", href: `https://x.test/${word}` }];
    const r = scan([sale(1, 0, text as unknown as string)]);
    assert.strictEqual(r.summary.byTier.none, 1);
    assert.strictEqual(r.summary.items, 0);
    const ok = scan([sale(1, 0, ["גלוק 17 למכירה 1,300₪ ", { type: "text_link", text: "link", href: "https://x.test/fine" }] as unknown as string)]);
    assert.strictEqual(ok.summary.items, 1);
});

check("formatSummary has counts only", () => {
    const r = scan([sale(1, 0, P)]);
    const s = formatSummary(r.summary);
    assert.ok(!s.includes("Seller 1") && !s.includes("M4"));
    assert.ok(s.includes("1"));
});

if (failed) {
    console.error(`[FAIL] ${failed} catchup check(s) failed`);
    process.exit(1);
}
console.log("[OK] catchup checks passed");
