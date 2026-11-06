import type { InlineKeyboardButton } from "node-telegram-bot-api/types";
import { deepLink } from "./deepLinks";
import { escapeHtml, type Card, type Translate } from "./listingCards";

export interface ListingLine { title: string; price?: string; location?: string; date: string; link?: string }
type AlertAction = "d" | "r";

export const alertActionData = (searchId: string, action: AlertAction): string => `al_${searchId}_${action}`;

export function parseAlertArg(arg: string): { searchId: string; action: AlertAction } | null {
    const m = /^([0-9a-f]{24})_([dr])$/.exec(arg);
    return m ? { searchId: m[1], action: m[2] as AlertAction } : null;
}

function renderLine(l: ListingLine): string {
    const title = escapeHtml(l.title);
    const head = l.link ? `<a href="${escapeHtml(l.link).replace(/"/g, "&quot;")}">${title}</a>` : title;
    return [head, ...[l.price, l.location, l.date].map(p => (p ? escapeHtml(p) : ""))].filter(Boolean).join(" · ");
}

// The stored query is the unique key (and has lost its final letters to the tokenizer); members see this instead.
const FINALS: Record<string, string> = { כ: "ך", מ: "ם", נ: "ן", צ: "ץ" };
export const displayQuery = (query: string): string =>
    query.split(/\s+/).filter(Boolean).slice(0, 6).map(w => (w.length > 1 ? w.replace(/[כמנצ]$/, c => FINALS[c]) : w)).join(" ");

// What a saved search says to its owner: the query, the ceiling and the meeting point.
export const describeSearch = (t: Translate, s: { query: string; maxPrice?: number; meetup?: boolean }): string =>
    `${displayQuery(s.query)}${s.maxPrice ? ` ≤ ${s.maxPrice}` : ""}${s.meetup ? ` · ${t("alertMeetup")}` : ""}`;

export function buildBuyerNote(t: Translate, lines: ListingLine[], captureId: string, botUsername: string): Card {
    const text = lines.length === 0 ? t("buyerNoteEmpty") : [t("buyerNoteTitle", { n: lines.length }), ...lines.map(renderLine)].join("\n");
    return { text, html: true, keyboard: [[{ text: t("buyerNoteAlertButton"), url: deepLink(botUsername, `s_${captureId}`) }]] };
}

export function buildAlertCard(t: Translate, query: string, line: ListingLine): Card {
    return { text: `${t("alertTitle", { query: escapeHtml(displayQuery(query)) })}\n${renderLine(line)}`, html: true, keyboard: [] };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

export function buildAlertsList(t: Translate, searches: { id: string; query: string; maxPrice?: number; meetup?: boolean; expiresAt: Date }[]): Card {
    if (searches.length === 0) return { text: t("alertsEmpty"), keyboard: [] };
    const rows = searches.map((s) => `• ${describeSearch(t, s)} (${day(s.expiresAt)})`);
    const keyboard: InlineKeyboardButton[][] = searches.map((s) => [
        { text: `🗑 ${displayQuery(s.query)}`.slice(0, 30), callback_data: alertActionData(s.id, "d") },
    ]);
    return { text: [t("alertsTitle"), ...rows].join("\n"), keyboard };
}

export function buildRenewOffer(t: Translate, search: { id: string; query: string; expiresAt: Date }): Card {
    return {
        text: t("alertRenewOffer", { query: displayQuery(search.query), date: day(search.expiresAt) }),
        keyboard: [[{ text: t("alertRenewButton"), callback_data: alertActionData(search.id, "r") }]],
    };
}
