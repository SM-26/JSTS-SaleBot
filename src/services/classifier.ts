import { createHash } from "crypto";
import data from "./classifierData.json";
import { findBlockedWord } from "./blockedWords";

export type Tier = "wtb" | "strict" | "ask" | "none";

export interface Parsed {
    title?: string;
    price?: string;
    priceValue?: number;
    location?: string;
    description?: string;
    isBundle: boolean;
    /** a trade/swap post with no shekel price: its note offers Edit only */
    trade?: boolean;
}

export interface ClassifyResult {
    tier: Tier;
    rules: string[];
    parsed: Parsed;
}

const FINALS: Record<string, string> = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };

/** Lowercase, no punctuation/niqqud, final letters folded, ש״ח unified to שח, whitespace collapsed. */
export function normalize(text: string): string {
    return text
        .toLowerCase()
        .replace(/־/g, " ") // maqaf joins words; the niqqud range below would swallow it
        .replace(/[֑-ׇ]/g, "")
        .replace(/(?<!\p{L})ש["״'׳]?ח(?!\p{L})/gu, "שח")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/[ךםןףץ]/g, c => FINALS[c])
        .trim();
}

export function textHash(text: string): string {
    return createHash("sha1").update(normalize(text)).digest("hex");
}

export function tokenOverlap(a: string[], b: string[]): number {
    const sa = new Set(a);
    const sb = new Set(b);
    if (!sa.size || !sb.size) return 0;
    let common = 0;
    for (const t of sa) if (sb.has(t)) common++;
    return common / Math.min(sa.size, sb.size);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// whole phrase between word boundaries of an already-normalized string
const phraseRe = (phrase: string, flags = "u") => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase)}(?![\\p{L}\\p{N}])`, flags);

const wtbOpeners = data.wtbOpeners.map(normalize).map(p => phraseRe(p));
const saleWords = data.saleWords.map(normalize).map(p => phraseRe(p));
const cities = data.cities.map(city => ({ city, re: new RegExp(`(?<![\\p{L}\\p{N}])[בלמה]?${escapeRe(normalize(city))}(?![\\p{L}\\p{N}])`, "u") }));
// longest first so "אם 4" goes before "אם"
const dropPhrases = [...data.wtbOpeners, ...data.saleWords, ...data.stopWords].map(normalize).sort((x, y) => y.length - x.length).map(p => phraseRe(p, "gu"));
const aliasRules = data.aliases.flatMap(([head, ...rest]) => rest.map(alias => ({ re: phraseRe(normalize(alias), "gu"), head: normalize(head) })));

export function tokens(text: string): string[] {
    let s = normalize(text.replace(/(?<=\d),(?=\d{3}(?!\d))/g, ""));
    for (const { re, head } of aliasRules) s = s.replace(re, head);
    for (const re of dropPhrases) s = s.replace(re, " ");
    return s.split(/\s+/).filter(Boolean);
}

// a number followed by one of these is a quantity, not a price ("50 כדור", "2 מחסניות")
const unitRe = new RegExp("^\\s*(?:" + data.units.map(escapeRe).join("|") + ")(?![\\p{L}])", "iu");
const tradeWords = data.tradeWords.map(normalize).map(p => phraseRe(p));
const shekelWords = data.shekelWords.map(normalize).map(p => phraseRe(p));
// a first line that is only an opener ("למכירה,") is not the title
const LONE_LEAD = new Set(["למכירה", "להחלפה", "לטרייד", "טרייד", "החלפה"]);
/** Index of the line that carries the title: the first non-empty line that is not just an opener. */
export function titleLineIndex(text: string): number {
    const lines = text.split("\n");
    const i = lines.findIndex(l => { const n = normalize(l); return n && !LONE_LEAD.has(n); });
    return i < 0 ? 0 : i;
}
// "אזור <place>" alone on a line: the place, as the seller wrote it
const AREA_LINE = /^\s*(?:אזור|איזור)\s*:?\s*(\S[^\n]{0,39}?)\s*[.,;!]*\s*$/u;
const LEAD = /^(?:לטרייד|להחלפה|טרייד|החלפה|למכירה)\s*[:\-–]\s*/u;
const FOLD_BACK: Record<string, string> = { כ: "[כך]", מ: "[מם]", נ: "[נן]", פ: "[פף]", צ: "[צץ]" };
// the city as written in the raw text (final letters either way), with its prefix letter and a leading "אזור"
const cityTitleRes = new Map(data.cities.map(c => [c, new RegExp("(?:אזור\\s+)?(?<![\\p{L}\\p{N}])[בלמה]?" + normalize(c).split("").map(ch => FOLD_BACK[ch] ?? (ch === " " ? "\\s+" : escapeRe(ch))).join("") + "(?![\\p{L}\\p{N}])", "u")]));

/** The title line without its price: location (with its ה/אזור), stray punctuation and a leading opener gone. Not cut yet. */
export function cleanTitleLine(line: string, location?: string): string {
    const re = location ? cityTitleRes.get(location) : undefined;
    return (re ? line.replace(re, " ") : line).replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/([,.;:])(?:\s*[,;:])+/g, "$1")
        .replace(/^[\s,.\-–:;]+|[\s,.\-–:;]+$/g, "").replace(LEAD, "");
}

const NUM = "\\d{1,3}(?:,\\d{3})+|\\d+";
const NUM2 = "\\d{1,3}(?:,\\d{3})+|\\d{2,}"; // ב / bare prices need 2+ digits
const CUR = '(?:₪|ש["״\'׳]?ח(?!\\p{L})|שקל(?:ים)?(?!\\p{L}))';
const explicitRes = [
    new RegExp(`(?<![\\d,.])(?:${NUM})\\s*${CUR}`, "gu"),
    new RegExp(`₪\\s*(?:${NUM})(?!\\d)`, "gu"),
    new RegExp(`מחיר\\s*:?\\s*(?:${NUM})(?!\\d)`, "gu"),
    new RegExp(`(?<![\\p{L}\\d])ב-?(?:${NUM2})(?!\\d)`, "gu"),
];
const bareRe = /(?<![\d,.])(?:\d{1,3}(?:,\d{3})+|\d{2,6})(?!\d|\.\d)/gu; // "14.5" is a size, not a price

interface PriceMatch { str: string; value: number; index: number; rule: string }

function findPrices(text: string, res: RegExp[], rule: (i: number) => string): PriceMatch[] {
    const out: PriceMatch[] = [];
    res.forEach((re, i) => {
        for (const m of text.matchAll(re)) {
            const digits = /\d{1,3}(?:,\d{3})+|\d+/.exec(m[0].replace(/^ב-?/, ""));
            if (digits && !unitRe.test(text.slice((m.index ?? 0) + m[0].length))) out.push({ str: m[0], value: Number(digits[0].replace(/,/g, "")), index: m.index ?? 0, rule: rule(i) });
        }
    });
    out.sort((x, y) => x.index - y.index);
    // overlapping matches ("מחיר 900" + "900₪") are one price: keep the union span
    const merged: PriceMatch[] = [];
    for (const m of out) {
        const last = merged[merged.length - 1];
        if (last && m.index < last.index + last.str.length) {
            const end = Math.max(last.index + last.str.length, m.index + m.str.length);
            last.str = text.slice(last.index, end);
        } else merged.push({ ...m });
    }
    return merged;
}

export const phoneRe = /(?<![\d,.])(?:0\d{1,2}-?\d{7}|\d{9,10})(?!\d)/gu;

function parse(text: string, explicit: PriceMatch[], bare: PriceMatch[]): Parsed {
    // ponytail: bare numbers are noisy ("glock 17 ... 900"), so the largest wins
    const price = explicit.length ? explicit[0] : bare.reduce<PriceMatch | undefined>((best, m) => (!best || m.value > best.value ? m : best), undefined);
    const lines = text.split("\n");
    const ti = titleLineIndex(text);
    const first = lines[ti] ?? "";
    const offset = lines.slice(0, ti).reduce((n, l) => n + l.length + 1, 0);
    let rest = lines.slice(ti + 1);

    const norm = normalize(text);
    const found = cities.map(c => ({ city: c.city, at: norm.search(c.re) })).filter(c => c.at >= 0).sort((x, y) => x.at - y.at)[0];
    // an "אזור <place>" line names any place, as written; else the known cities
    const areaAt = rest.findIndex(l => AREA_LINE.test(l));
    const area = areaAt >= 0 ? AREA_LINE.exec(rest[areaAt])![1] : undefined;
    if (areaAt >= 0) rest = rest.filter((_, i) => i !== areaAt);
    const location = area ?? found?.city;

    // ponytail: trade = keyword and no shekel word anywhere; a trade post's number is not a price
    const trade = tradeWords.some(re => re.test(norm)) && !shekelWords.some(re => re.test(norm)) && !text.includes("₪");
    const at = price ? price.index - offset : -1;
    let title = price && !trade && at >= 0 && at < first.length ? first.slice(0, at) + " " + first.slice(at + price.str.length) : first;
    title = cleanTitleLine(title, area ? undefined : location);
    if (title.length > 60) { // cut at a word, not in the middle of one
        const cut = title.slice(0, 60);
        title = cut.slice(0, title[60] !== " " && cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60).replace(/[\s,.\-–:;]+$/g, "");
    }
    if (!title || (location && normalize(title) === normalize(location))) title = "";

    const description = rest.join("\n").trim();
    return {
        title: title || undefined,
        price: trade ? undefined : price?.str,
        priceValue: trade ? undefined : price?.value,
        location,
        description: description || undefined,
        isBundle: new Set(explicit.map(p => p.value)).size >= 2,
        ...(trade ? { trade } : {}),
    };
}

export function classify(text: string, hasMedia: boolean): ClassifyResult {
    const explicit = findPrices(text, explicitRes, i => (i === 3 ? "price-b-prefix" : "price-currency"));
    const phones = [...text.matchAll(phoneRe)].map(m => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
    const bare = explicit.length ? [] : findPrices(text, [bareRe], () => "price-bare").filter(b => !phones.some(([from, to]) => b.index >= from && b.index < to));
    const parsed = parse(text, explicit, bare);

    const norm = normalize(text);
    // an opener counts only in the first 3 words of the first non-empty line (emoji and punctuation drop out in normalize)
    const firstLine = normalize(text.split("\n").find(l => normalize(l)) ?? "").split(" ").slice(0, 3).join(" ");
    const sale = saleWords.some(re => re.test(norm));
    const wtb = wtbOpeners.some(re => re.test(firstLine));

    const rules: string[] = [];
    const blocked = findBlockedWord(text) !== null;
    if (blocked) rules.push("blocked-word");
    if (wtb) rules.push("wtb-opener");
    if (hasMedia) rules.push("has-media");
    for (const rule of new Set([...explicit, ...bare].map(p => p.rule))) rules.push(rule);
    if (sale) rules.push("sale-word");

    let tier: Tier = "none";
    if (blocked) tier = "none";
    else if (wtb) tier = "wtb";
    else if (hasMedia && explicit.length && sale) tier = "strict";
    // ponytail: media + any price-like number asks, explicit or bare; a lone "5₪" photo still asks
    else if ((hasMedia && (explicit.length || bare.length)) || (sale && explicit.length)) tier = "ask";
    return { tier, rules, parsed };
}
