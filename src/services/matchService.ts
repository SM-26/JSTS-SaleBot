import data from "./classifierData.json";
import type { IListing } from "../models/Listing";
import { normalize, tokenOverlap, tokens } from "./classifier";

// Alias heads ("glock", "m4", ...) are the strong terms; tokens() already rewrites every alias to its head.
const aliasHeads = new Set(data.aliases.map(([head]) => normalize(head)));
const isStrong = (t: string) => aliasHeads.has(t) || (t.length >= 2 && /\d/.test(t));

const CEILING_RE = /עד\s*(\d[\d,]*)/u;

type MatchListing = Pick<IListing, "_id" | "text" | "title" | "priceValue" | "refreshedAt">;

// Spec 7.1, rules only: a listing matches on one shared strong token (and sits
// under a stated ceiling "עד 800"); rank by token overlap, then newest refresh.
// A listing with no known price fails a stated ceiling.
export function rankMatches(query: string, listings: MatchListing[], max = 5): string[] {
    const ceilingText = CEILING_RE.exec(query)?.[1];
    const ceiling = ceilingText ? Number(ceilingText.replace(/,/g, "")) : undefined;
    const q = tokens(ceilingText ? query.replace(CEILING_RE, " ") : query);
    const strong = q.filter(isStrong);
    if (!strong.length) return [];

    return listings
        .filter(l => ceiling === undefined || (l.priceValue !== undefined && l.priceValue <= ceiling))
        .map(l => {
            const t = tokens([l.title, l.text].filter(Boolean).join("\n"));
            return { id: String(l._id), refreshedAt: l.refreshedAt.getTime(), shared: strong.some(s => t.includes(s)), overlap: tokenOverlap(q, t) };
        })
        .filter(l => l.shared)
        .sort((a, b) => b.overlap - a.overlap || b.refreshedAt - a.refreshedAt)
        .slice(0, max)
        .map(l => l.id);
}
