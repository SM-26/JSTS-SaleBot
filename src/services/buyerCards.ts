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
    return [head, l.price, l.location, l.date].filter(Boolean).map((p, i) => (i === 0 ? p : escapeHtml(p as string))).join(" · ");
}

export function buildBuyerNote(t: Translate, lines: ListingLine[], captureId: string, botUsername: string): Card {
    const text = lines.length === 0 ? t("buyerNoteEmpty") : [t("buyerNoteTitle", { n: lines.length }), ...lines.map(renderLine)].join("\n");
    return { text, html: true, keyboard: [[{ text: t("buyerNoteAlertButton"), url: deepLink(botUsername, `s_${captureId}`) }]] };
}

export function buildAlertCard(t: Translate, query: string, line: ListingLine): Card {
    return { text: `${t("alertTitle", { query: escapeHtml(query) })}\n${renderLine(line)}`, html: true, keyboard: [] };
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

export function buildAlertsList(t: Translate, searches: { id: string; query: string; maxPrice?: number; expiresAt: Date }[]): Card {
    if (searches.length === 0) return { text: t("alertsEmpty"), keyboard: [] };
    const rows = searches.map((s) => `• ${s.query}${s.maxPrice ? ` ≤ ${s.maxPrice}` : ""} (${day(s.expiresAt)})`);
    const keyboard: InlineKeyboardButton[][] = searches.map((s) => [
        { text: `🗑 ${s.query}`.slice(0, 30), callback_data: alertActionData(s.id, "d") },
    ]);
    return { text: [t("alertsTitle"), ...rows].join("\n"), keyboard };
}

export function buildRenewOffer(t: Translate, search: { id: string; query: string; expiresAt: Date }): Card {
    return {
        text: t("alertRenewOffer", { query: search.query, date: day(search.expiresAt) }),
        keyboard: [[{ text: t("alertRenewButton"), callback_data: alertActionData(search.id, "r") }]],
    };
}
