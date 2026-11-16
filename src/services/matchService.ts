import data from "./classifierData.json";
import type { IListing } from "../models/Listing";
import { normalize, phoneRe, tokenOverlap, tokens } from "./classifier";

// Alias heads ("glock", "m4", ...) are the strong terms; tokens() already rewrites every alias to its head.
const aliasHeads = new Set(data.aliases.map(([head]) => normalize(head)));
// a round number ("1400", "2500") is a price, not a model ("1911", "416")
const priceLike = (t: string) => /^\d{3,}$/.test(t) && /(00|50)$/.test(t);
const isStrong = (t: string) => aliasHeads.has(t) || (t.length >= 2 && /\d/.test(t) && !priceLike(t));

// category heads, not models: they must not silence a model number
const categoryHeads = new Set(["gbb", "aeg", "hpa"]);

// What the item is. A buyer's first item word names what they want; a listing's line names what it sells.
// "gun" is any whole replica; every other kind is a part or accessory.
const KINDS: Record<string, string[]> = {
    gun: ["כלי", "כלים", "אקדח", "אקדחים", "רובה", "רובים", "צלף", "צלפים", "קרבין", "gun", "pistol", "rifle", "sniper", "smg"],
    mag: ["מחסנית", "מחסניות", "מגזין", "מגזינים", "magazine", "magazines", "mag", "mags", "midcap", "hicap", "drum"],
    spring: ["קפיץ", "קפיצים", "spring"],
    holster: ["נרתיק", "נרתיקים", "הולסטר", "holster"],
    sight: ["כוונת", "כוונות", "סקופ", "scope", "sight", "optic", "lpvo", "רדדוט", "reddot"],
    stock: ["קת", "קתות", "stock"],
    regulator: ["רגולטור", "ריגולטור", "ווסת", "regulator"],
    bottle: ["בלון", "בלונים", "בלוני", "בקבוק", "מיכל", "tank"],
    hopup: ["הופאפ", "הופ", "hopup", "hop", "גומיה", "גומייה"],
    barrel: ["קנה", "קנים", "barrel"],
    battery: ["סוללה", "סוללות", "battery", "lipo"],
    charger: ["מטען", "מטענים", "charger"],
    vest: ["וסט", "ווסט", "אפוד", "vest"],
    motor: ["מנוע", "motor"],
    gearbox: ["גירבוקס", "גיר", "gearbox"],
    suppressor: ["משתיק", "suppressor", "silencer"],
    hider: ["סטרשף", "סתרשף"],
    light: ["פנס", "flashlight"],
    laser: ["לייזר", "laser"],
    grip: ["גריפ", "grip", "ידית"],
    helmet: ["קסדה", "helmet"],
    pouch: ["פאוץ", "pouch"],
    goggles: ["משקף", "משקפי", "מסכה", "mask", "goggles"],
    rail: ["מסילה", "מסילות", "rail", "mount", "מתאם"],
    parts: ["חלקים", "parts"],
    system: ["מערכת"],
};
const kindOf = new Map(Object.entries(KINDS).flatMap(([kind, words]) => words.map(w => [normalize(w), kind] as const)));
const isModel = (t: string) => isStrong(t) && !categoryHeads.has(t);
// the first item word of a line, and whether a model term (glock, 17) comes before it
function lineKind(t: string[]): { kind?: string; afterModel: boolean } {
    const at = t.findIndex(x => kindOf.has(x));
    return at < 0 ? { afterModel: false } : { kind: kindOf.get(t[at]), afterModel: t.slice(0, at).some(isModel) };
}

const leadsWithPart = (k: ReturnType<typeof lineKind>) => !!k.kind && k.kind !== "gun" && !k.afterModel;

const MEETUP = normalize("בית דגן");
const MEETUP_RE = new RegExp(`(?<![\\p{L}\\p{N}])[בלמה]?${MEETUP}(?![\\p{L}\\p{N}])`, "gu"); // prefixed like `cities`
const NUM = String.raw`\d[\d,]*`;
const SHEKEL = String.raw`(?:₪|(?:ש["״']?ח|שקל(?:ים)?|nis)(?!\p{L}))`;
// "עד 800", "תקציב 800", "עד 1300-1400", "בין 2000 ל 2800": the ceiling is the top of the range.
// "עד" is a word of its own, not the end of one ("מועד 2025"); "תקציב 800+" is a floor, not a ceiling.
const CEILING_RE = new RegExp(String.raw`(?<!\p{L})(?:עד|ב?תקציב(?:\s+של)?|בין\s*${NUM}\s*(?:ל|עד|-))\s*(?:${NUM}\s*-\s*)?(${NUM})\s*${SHEKEL}?\s*(\+)?`, "u");
// a price the buyer names ("400₪", "מחיר 300") and a quantity ("14 מ\"מ", "1.3j") are not search words
const PRICE_RE = new RegExp(String.raw`₪\s*${NUM}|${NUM}\s*${SHEKEL}|(?<!\p{L})ב?מחיר\s*:?\s*${NUM}`, "giu");
const UNIT_RE = /\d+(?:[.,]\d+)?\s*(?:mm|מ["״]?מ|מילימטר|j|ג['׳]?ול|fps|וואט|גרם|%)(?![\p{L}])/giu;
// what the buyer offers in trade, or a sale tacked on ("מחפש X, מציע Y", "קונה: X מוכר: Y") is not what they want
const TRADE_CUT = new RegExp(`(?<![\\p{L}\\p{N}])(?:${["מציע", "מציעה", "להחלפה", "בהחלפה", "החלפה", "תמורת", "בתמורה", "טרייד", "לטרייד", "יש לי", "מוכר", "מוכרת", "למכירה"].map(normalize).join("|")})(?![\\p{L}\\p{N}])`, "gu");
// in a listing, what follows "החלפה על X" or "מחפש X" is what the seller wants, not what they sell
const SELLER_WANTS = /(?<![\p{L}\p{N}])(?:[לב]?החלפה (?:על |ב)|להחליפ (?:על |ב)|מחפש(?:ת|ימ)?(?![\p{L}\p{N}]))/u;
const SALE_RE = new RegExp(`(?<![\\p{L}\\p{N}])${normalize("למכירה")}(?![\\p{L}\\p{N}])`, "u");
// a listing that only swaps, or names no price beside a trade word, is not for sale
const tradeWordRe = new RegExp(`(?<![\\p{L}\\p{N}])(?:${data.tradeWords.map(normalize).join("|")})(?![\\p{L}\\p{N}])`, "u");
const TRADE_ONLY = new RegExp(`(?<![\\p{L}\\p{N}])(?:רק (?:ל)?(?:החלפה|החליפ|טרייד)|(?:החלפה|טרייד) בלבד)(?![\\p{L}\\p{N}])`, "u");

type MatchListing = Pick<IListing, "_id" | "text" | "title" | "priceValue" | "refreshedAt" | "location" | "meetup">;

export interface BuyerQuery { query: string; terms: string[]; maxPrice?: number; meetup: boolean }

// The ceiling, prices, quantities, phone numbers, the meeting point and anything offered in trade are not
// search words: take them out before tokens().
export function parseQuery(text: string): BuyerQuery {
    const ceiling = CEILING_RE.exec(text);
    const maxPrice = ceiling && !ceiling[2] ? Number(ceiling[1].replace(/,/g, "")) : undefined;
    let rest = normalize(text.replace(CEILING_RE, " ").replace(PRICE_RE, " ").replace(UNIT_RE, " ").replace(phoneRe, " "));
    const meetup = new RegExp(MEETUP_RE.source, "u").test(rest);
    rest = rest.replace(MEETUP_RE, " ");
    // a sale posted as "wanted" ("שוב למכירה X") names no wanted item
    const sale = SALE_RE.exec(rest);
    if (sale && !tokens(rest.slice(0, sale.index)).some(isStrong)) rest = "";
    // cut at the first trade cue that follows a wanted term; a leading cue ("מחפש החלפה על X") keeps X
    for (const m of rest.matchAll(TRADE_CUT)) {
        if (tokens(rest.slice(0, m.index)).some(isStrong)) { rest = rest.slice(0, m.index); break; }
    }
    const terms = tokens(rest).slice(0, 20);
    return { query: terms.slice(0, 12).join(" "), terms, maxPrice, meetup };
}

// "מחפש החלפה על X" asks for a swap, not a sale
const swapLead = new Set([...data.tradeWords, "בהחלפה"].map(normalize));

// What decides a match, or undefined when the query has nothing to search for.
function plan(terms: string[]) {
    const strong = terms.filter(isStrong);
    if (!strong.length || swapLead.has(terms[0])) return undefined;
    // model names (glock, ssp18) and model numbers (17, 19); a category head (gbb, aeg, hpa) decides only when nothing else does
    const named = strong.filter(s => /\p{L}/u.test(s) && !categoryHeads.has(s));
    const nums = strong.filter(s => !/\p{L}/u.test(s));
    // a Latin word right before the number names the model ("cz 75"): it must match too
    const brand = !named.length && nums.length ? terms[terms.indexOf(nums[0]) - 1] : undefined;
    if (brand && /^[a-z]{2,}$/.test(brand) && !categoryHeads.has(brand)) named.push(brand);
    // what the buyer wants is the item word before any model ("מחסנית לגלוק 17"); one after it is a detail ("גלוק 19 על גז")
    const want = lineKind(terms);
    const part = want.kind && want.kind !== "gun" && !want.afterModel ? want.kind : undefined;
    // a two-digit number alone ("42", "19") is a size or a count as often as a model; it decides only for a part
    if (!named.length && !part && nums.length && nums.every(s => s.length < 3)) return undefined;
    return { strong, named, nums, part };
}

export const isSearchable = (q: Pick<BuyerQuery, "terms">): boolean => plan(q.terms) !== undefined;

// Spec 7.1, rules only: every model name in the query, and one of its model numbers, must be in the listing (and it
// sits under a stated ceiling "עד 800", and at the meeting point when asked); rank by token overlap, then newest
// refresh. A listing with no known price fails a stated ceiling. Trade-only listings never match.
// A part request ("מחסנית לגלוק 17") needs a listing line that sells that part. Any other request skips listings
// that lead with a part, and needs the model on one line near the top that doesn't lead with a part.
export function matchListings(q: Pick<BuyerQuery, "terms" | "maxPrice" | "meetup">, listings: MatchListing[], max = 5): string[] {
    const p = plan(q.terms);
    if (!p) return [];
    const { strong, named, nums, part } = p;
    const decisive = named.length || nums.length ? [...named, ...nums] : strong;
    const has = (t: string[]) => named.length || nums.length
        ? named.every(s => t.includes(s)) && (!nums.length || nums.some(s => t.includes(s)))
        : strong.some(s => t.includes(s));

    return listings
        .filter(l => q.maxPrice === undefined || (l.priceValue !== undefined && l.priceValue <= q.maxPrice))
        .filter(l => !q.meetup || l.meetup === true || (l.location !== undefined && normalize(l.location) === MEETUP))
        .filter(l => {
            const norm = normalize(l.text ?? "");
            return !TRADE_ONLY.test(norm) && !(l.priceValue === undefined && tradeWordRe.test(norm));
        })
        .map(l => {
            const lines = [l.title ?? "", ...(l.text ?? "").split("\n")].map(x => tokens(normalize(x).split(SELLER_WANTS)[0])).filter(x => x.length);
            const t = lines.flat();
            const head = lineKind(lines[0] ?? []);
            // a long listing names what it sells near the top: a model further down its list is a passing mention
            const top = lines.length >= 5 ? lines.slice(0, 5) : lines;
            const shared = part
                ? has(t) && (head.kind === part || lines.some(x => lineKind(x).kind === part && decisive.some(s => x.includes(s))))
                : !leadsWithPart(head) && top.some(x => !leadsWithPart(lineKind(x)) && has(x));
            return { id: String(l._id), refreshedAt: l.refreshedAt.getTime(), shared, overlap: tokenOverlap(q.terms, t) };
        })
        .filter(l => l.shared)
        .sort((a, b) => b.overlap - a.overlap || b.refreshedAt - a.refreshedAt)
        .slice(0, max)
        .map(l => l.id);
}

export const rankMatches = (query: string, listings: MatchListing[], max = 5): string[] => matchListings(parseQuery(query), listings, max);
