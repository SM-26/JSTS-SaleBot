import data from "./classifierData.json";
import type { IListing } from "../models/Listing";
import { normalize, phoneRe, tokenOverlap, tokens } from "./classifier";

// Alias heads ("glock", "m4", ...) are the strong terms; tokens() already rewrites every alias to its head.
const aliasHeads = new Set(data.aliases.map(([head]) => normalize(head)));
const isStrong = (t: string) => aliasHeads.has(t) || (t.length >= 2 && /\d/.test(t));

// category heads, not models: they must not silence a model number
const categoryHeads = new Set(["gbb", "aeg", "hpa"]);

const MEETUP = normalize("בית דגן");
const MEETUP_RE = new RegExp(`(?<![\\p{L}\\p{N}])[בלמה]?${MEETUP}(?![\\p{L}\\p{N}])`, "gu"); // prefixed like `cities`
const CEILING_RE = /(?<!\p{L})עד\s*(\d[\d,]*)/u; // a word of its own, not the end of one ("מועד 2025")

type MatchListing = Pick<IListing, "_id" | "text" | "title" | "priceValue" | "refreshedAt" | "location" | "meetup">;

export interface BuyerQuery { query: string; terms: string[]; maxPrice?: number; meetup: boolean }

// The ceiling, phone numbers and the meeting point are not search words: take them out before tokens().
export function parseQuery(text: string): BuyerQuery {
    const ceilingText = CEILING_RE.exec(text)?.[1];
    const maxPrice = ceilingText ? Number(ceilingText.replace(/,/g, "")) : undefined;
    const rest = normalize(text.replace(CEILING_RE, " ").replace(phoneRe, " "));
    const meetup = new RegExp(MEETUP_RE.source, "u").test(rest);
    const terms = tokens(rest.replace(MEETUP_RE, " ")).slice(0, 20);
    return { query: terms.slice(0, 12).join(" "), terms, maxPrice, meetup };
}

export const isSearchable = (q: Pick<BuyerQuery, "terms">): boolean => q.terms.some(isStrong);

// Spec 7.1, rules only: a listing matches on one shared strong token (and sits
// under a stated ceiling "עד 800", and at the meeting point when asked); rank
// by token overlap, then newest refresh. A listing with no known price fails a stated ceiling.
export function matchListings(q: Pick<BuyerQuery, "terms" | "maxPrice" | "meetup">, listings: MatchListing[], max = 5): string[] {
    const strong = q.terms.filter(isStrong);
    if (!strong.length) return [];
    // a budget ("תקציב 800") is a bare number: when the query names a model (glock, m4), only the names decide; numbers still rank
    const named = strong.filter(s => /\p{L}/u.test(s) && !categoryHeads.has(s));
    const decisive = named.length ? named : strong;

    return listings
        .filter(l => q.maxPrice === undefined || (l.priceValue !== undefined && l.priceValue <= q.maxPrice))
        .filter(l => !q.meetup || l.meetup === true || (l.location !== undefined && normalize(l.location) === MEETUP))
        .map(l => {
            const t = tokens([l.title, l.text].filter(Boolean).join("\n"));
            return { id: String(l._id), refreshedAt: l.refreshedAt.getTime(), shared: decisive.some(s => t.includes(s)), overlap: tokenOverlap(q.terms, t) };
        })
        .filter(l => l.shared)
        .sort((a, b) => b.overlap - a.overlap || b.refreshedAt - a.refreshedAt)
        .slice(0, max)
        .map(l => l.id);
}

export const rankMatches = (query: string, listings: MatchListing[], max = 5): string[] => matchListings(parseQuery(query), listings, max);
