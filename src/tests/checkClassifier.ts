import assert from "assert";
import { classify, normalize, textHash, tokenOverlap, tokens, Parsed, Tier } from "../services/classifier";

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
    ["bundle", "למכירה\nM4 900₪\nגלוק 600₪", true, "strict", { isBundle: true }],
    ["same price twice is no bundle", "למכירה M4 900₪\nאו 900 שח", true, "strict", { isBundle: false }],
    ["photo-only", "", true, "none"],
    ["chatter", "מישהו יודע מתי המשחק?", false, "none"],
    ["blocked", "מוכר נשק 500₪", true, "none"],
    ["blocked false positive", "מתנה לנשק 500₪ למכירה", true, "none"],
    ["phone number is not a price", "למכירה 0501234567", true, "none"],
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

check("blocked rule id", () => assert.ok(classify("מוכר נשק 500₪", true).rules.includes("blocked-word")));
check("long caption", () => {
    const r = classify("למכירה " + "א".repeat(4000) + " 500₪", true);
    assert.strictEqual(r.tier, "strict");
    assert.ok(r.parsed.title !== undefined && r.parsed.title.length <= 60);
});
check("normalize ש״ח", () => assert.strictEqual(normalize("ש״ח"), normalize('ש"ח')));
check("normalize finals and niqqud", () => assert.strictEqual(normalize("שָׁלוֹם  ך"), normalize("שלום כ")));
check("textHash ignores whitespace", () => assert.strictEqual(textHash("גלוק 17"), textHash("גלוק 17  ")));
check("alias overlap", () => assert.ok(tokenOverlap(tokens("גלוק 17 למכירה"), tokens("glock 17")) >= 0.8));
check("overlap empty", () => assert.strictEqual(tokenOverlap([], ["x"]), 0));
check("overlap different", () => assert.ok(tokenOverlap(tokens("גלוק 17"), tokens("כוונת אדומה")) < 0.8));

if (failed) {
    console.error(`[FAIL] ${failed} classifier check(s) failed`);
    process.exit(1);
}
console.log("[OK] classifier checks passed");
