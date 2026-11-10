import assert from "assert";
import { parseQuery } from "../services/matchService";
import { classify, normalize, partEntities, textHash, tokenOverlap, tokens, Parsed, Tier } from "../services/classifier";

// [name, text, hasMedia, expected tier, expected parsed fields (only the listed keys are compared)]
const rows: Array<[string, string, boolean, Tier, Partial<Parsed>?]> = [
    ["strict ₪", "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז", true, "strict", { priceValue: 1300, location: "מרכז", title: "גלוק 17 למכירה" }],
    ["strict שח", 'M4 למכירה 900 ש"ח', true, "strict", { priceValue: 900 }],
    ["strict ב-", "מוכר וסט ב-250 כמו חדש", true, "strict", { priceValue: 250 }],
    ["wtb first line beats price", "מחפש M4 עד 800₪", true, "wtb"],
    ["wtb english", "WTB glock 19", false, "wtb"],
    ["wtb only in first line", "תמונה\nמחפש משהו", true, "none"],
    ["ask bare price", "1300 מרכז", true, "ask", { title: undefined, priceValue: 1300 }],
    ["ask no photo", "למכירה כוונת 300₪", false, "ask"],
    ["no photo no sale word", "כוונת 300₪", false, "none"],
    ["bundle: several prices ask the seller", "למכירה\nM4 900₪\nגלוק 600₪", true, "ask", { isBundle: true, priceValue: 900 }],
    ["one total for everything stays strict", "למכירה\nM4 900₪\nגלוק 600₪\nהכל ב-1400", true, "strict", { isBundle: true, priceValue: 1400 }],
    ["total with ₪ and סה״כ", "למכירה M4 ומשקפת\nM4 900₪, משקפת 300₪\nסה״כ 1,100₪", true, "strict", { priceValue: 1100 }],
    ["a 'total' below an item price is no total", "למכירה\nM4 900₪\nגלוק 600₪\nסה״כ 2 פריטים", true, "ask"],
    ["shipping is a second price: ask", "למכירה M4 900₪\nמשלוח 30₪", true, "ask", { priceValue: 900 }],
    ["price in passing loses to מחיר", "למכירה וסט טקטי במצב טוב\nחסר אבזם, אפשר להזמין ב 3 שקל מאתר סיני\nמחיר 380₪", true, "ask", { priceValue: 380, title: "למכירה וסט טקטי במצב טוב" }],
    ["price in passing loses to a price line", "למכירה וסט טקטי במצב טוב\nחסר אבזם, אפשר להזמין ב 3 שקל מאתר סיני\n380₪", true, "ask", { priceValue: 380 }],
    ["מבקש is a price cue", "למכירה M4 במצב מעולה\nכולל 3 מחסניות\nמבקש 4800", true, "strict", { priceValue: 4800, price: "מבקש 4800" }],
    ["מבקשת with ש״ח", "מוכרת כוונת אדומה כמו חדשה\nמבקשת 1,200 ש\"ח", true, "strict", { priceValue: 1200 }],
    ["מבקש beats a ב price", "למכירה M4 עם משקפת ב-6500 לפני שנה\nמבקש 4800", true, "ask", { priceValue: 4800 }],
    ["purchase price is an old price", "למכירה M4\nקניתי ב-6500\nמבקש 4800", true, "strict", { priceValue: 4800, isBundle: false }],
    ["old price after במקום", "למכירה M4 750₪ במקום 900₪", true, "strict", { priceValue: 750, isBundle: false }],
    ["combining-stroke old price", "למכירה M4\n9̶0̶0̶₪ 750₪", true, "strict", { priceValue: 750, isBundle: false }],
    ["same price twice is no bundle", "למכירה M4 900₪\nאו 900 שח", true, "strict", { isBundle: false }],
    ["photo-only", "", true, "none"],
    ["chatter", "מישהו יודע מתי המשחק?", false, "none"],
    ["blocked", "מוכר נשק 500₪", true, "none"],
    ["blocked false positive", "מתנה לנשק 500₪ למכירה", true, "none"],
    ["price span mechir", "M4 למכירה מחיר 900₪", true, "strict", { title: "M4 למכירה", priceValue: 900, isBundle: false, price: "מחיר 900₪" }],
    ["price span b-prefix", "M4 למכירה ב-250 ₪", true, "strict", { title: "M4 למכירה", priceValue: 250, price: "ב-250 ₪" }],
    ["wtb word later in a sale line", "למכירה M4 לא צריך תיקונים 900₪", true, "strict"],
    ["wtb after greeting", "שלום, מחפש M4", false, "wtb"],
    ["wtb after blank line", "\nמחפש M4", false, "wtb"],
    ["wtb after emoji", "🔥 מחפש גלוק", false, "wtb"],
    ["bare largest wins", "גלוק 17 למכירה 900", true, "ask", { priceValue: 900, isBundle: false }],
    ["dashed phone is no price", "למכירה וסט 050-1234567", true, "none", { priceValue: undefined }],
    ["phone number is not a price", "למכירה 0501234567", true, "none"],
    ["radio fixture, new in box", "מכשיר קשר\nבאופנג UV-5R\nחדש באריזה\n270 ₪ בית דגן", true, "strict", { priceValue: 270, location: "בית דגן", title: "מכשיר קשר" }],
    // issue #123
    ["hello kitty: no location left in title, 2 is not the price", "למכירה hello kitty 1911 במצב מעולה, כולל 2 מחסניות. 1,200 ₪, אזור המרכז", true, "strict", { title: "למכירה hello kitty 1911 במצב מעולה, כולל 2 מחסניות", priceValue: 1200, location: "מרכז" }],
    ["trade, no price: a unit number is no price", "לטרייד: גלוק 19 (50 כדור) מחפש M4", true, "ask", { title: "גלוק 19 (50 כדור) מחפש M4", price: undefined, priceValue: undefined, trade: true }],
    ["trade word variants", "החלפה M4 בגלוק", true, "none", { trade: true }],
    ["trade with a real price is a normal post", "לטרייד או למכירה M4 1,500 ₪", true, "strict", { priceValue: 1500, trade: undefined }],
    ["trade with שקלים is a normal post", "להחלפה M4, או 1500 שקלים", true, "ask", { priceValue: 1500, trade: undefined }],
    ["trade with NIS is a normal post", "טרייד M4 or 1500 NIS", true, "ask", { trade: undefined }],
    ["unit number is not a price", "למכירה גלוק 50 כדורים", true, "none", { priceValue: undefined }],
    ["magazines are not a price", "למכירה M4 2 מחסניות 800", true, "ask", { priceValue: 800 }],
    ["watts are not a price", "למכירה AEG 350 וואט 600", true, "ask", { priceValue: 600 }],
    ["leading למכירה: is dropped", "למכירה: כוונת Holosun, 450₪", true, "strict", { title: "כוונת Holosun" }],
    ["location with ה and אזור goes", "M4 למכירה 900₪ אזור המרכז", true, "strict", { title: "M4 למכירה", location: "מרכז" }],
    ["long title cut at a word", "למכירה " + "מילה ".repeat(30) + "500₪", true, "strict", { title: "למכירה " + "מילה ".repeat(10).trim() }],
    // real posts
    ["lone opener line: next line is the title, area line is the location", "למכירה,\nColt m4 DD RIS 2 14.5”\nמחיר 3500 ₪\nאזור אש העין", true, "strict", { title: "Colt m4 DD RIS 2 14.5”", priceValue: 3500, location: "אש העין", description: "מחיר 3500 ₪" }],
    ["a size with a decimal is not a price", "למכירה\nבריח 14.5 מ", true, "none", { priceValue: undefined }],
    ["price in a sentence stays in the description", "Colt m4\nללא פנס וכוונת שבתמונה ימכר 3500 ₪ 🤯", true, "ask", { title: "Colt m4", price: "3500 ₪", priceValue: 3500, description: "ללא פנס וכוונת שבתמונה ימכר 3500 ₪ 🤯" }],
    ["area line as written, any place", "M4 900₪\nאזור: נווה זוהר.", true, "ask", { location: "נווה זוהר", description: undefined }],
];

let failed = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        console.log(`[OK] ${name}`);
    } catch (e) {
        failed++;
        console.error(`[FAIL] ${name}: ${(e as Error).message}`);
    }
}

for (const [name, text, media, tier, expected] of rows) {
    check(name, () => {
        const r = classify(text, media);
        assert.strictEqual(r.tier, tier, `tier ${r.tier} (rules ${r.rules.join(",")})`);
        for (const [k, v] of Object.entries(expected ?? {})) {
            assert.deepStrictEqual(r.parsed[k as keyof Parsed], v, `parsed.${k}`);
        }
    });
}

check("struck old price (strikethrough entity) is no second price", () => {
    const text = "למכירה M4\n900₪ 750₪";
    const r = classify(text, true, [{ type: "strikethrough", offset: text.indexOf("900"), length: 4 }]);
    assert.strictEqual(r.tier, "strict");
    assert.strictEqual(r.parsed.priceValue, 750);
    assert.strictEqual(classify(text, true).tier, "ask"); // without the entity: two prices
});
check("partEntities moves part offsets into the joined text", () => {
    const e = partEntities([{ text: "למכירה M4" }, { text: "900₪ 750₪", entities: [{ type: "strikethrough", offset: 0, length: 4 }] }]);
    assert.deepStrictEqual(e, [{ type: "strikethrough", offset: 10, length: 4 }]);
});
check("blocked rule id",() => assert.ok(classify("מוכר נשק 500₪", true).rules.includes("blocked-word")));
check("long caption", () => {
    const r = classify("למכירה " + "א".repeat(4000) + " 500₪", true);
    assert.strictEqual(r.tier, "strict");
    assert.ok(r.parsed.title !== undefined && r.parsed.title.length <= 60);
});
check("normalize ש״ח", () => assert.strictEqual(normalize("ש״ח"), normalize('ש"ח')));
check("normalize finals and niqqud", () => assert.strictEqual(normalize("שָׁלוֹם  ך"), normalize("שלום כ")));
check("normalize maqaf", () => assert.strictEqual(normalize("בן־אדם"), "בנ אדמ"));
check("tokens thousands comma", () => assert.deepStrictEqual(tokens("גלוק 1,300"), tokens("גלוק 1300")));
check("textHash ignores whitespace", () => assert.strictEqual(textHash("גלוק 17"), textHash("גלוק 17  ")));
check("alias overlap", () => assert.ok(tokenOverlap(tokens("גלוק 17 למכירה"), tokens("glock 17")) >= 0.8));
check("overlap empty", () => assert.strictEqual(tokenOverlap([], ["x"]), 0));
check("overlap different", () => assert.ok(tokenOverlap(tokens("גלוק 17"), tokens("כוונת אדומה")) < 0.8));

check("alias gluk = glock", () => assert.deepStrictEqual(tokens("גלוק"), tokens("glock")));
check("alias אם 4 = m4", () => assert.deepStrictEqual(tokens("אם 4"), tokens("m4")));
check("ceiling with comma", () => assert.strictEqual(parseQuery("מחפש glock עד 1,000").maxPrice, 1000));
check("עד inside a word is no ceiling", () => assert.strictEqual(parseQuery("מחפש glock מועד 2025").maxPrice, undefined));

if (failed) {
    console.error(`[FAIL] ${failed} classifier check(s) failed`);
    process.exit(1);
}
console.log("[OK] classifier checks passed");
