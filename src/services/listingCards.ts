import type { InlineKeyboardButton } from "node-telegram-bot-api/types";
import type { IListing } from "../models/Listing";
import type { Parsed } from "./classifier";
import type { CatchupItem } from "./catchupScan";
import { deepLink } from "./deepLinks";

export type Translate = (key: string, params?: Record<string, string | number | boolean>) => string;
export type Surface = "n" | "c" | "l";
export interface Card { text: string; keyboard: InlineKeyboardButton[][]; html?: boolean }

type ListingAction = "s" | "f" | "r";
type CaptureAction = "a" | "n" | "x";

export const listingActionData = (listingId: string, action: ListingAction, surface: Surface): string => `ls_${listingId}_${action}_${surface}`;
export const lifecycleActionData = (listingId: string, action: "r" | "s" | "x"): string => `lc_${action}_${listingId}`;
export const captureActionData = (captureId: string, action: CaptureAction): string => `mk_${captureId}_${action}`;

export function parseListingArg(arg: string): { listingId: string; action: ListingAction; surface: Surface } | null {
    const m = /^([0-9a-f]{24})_([sfr])_([ncl])$/.exec(arg);
    return m ? { listingId: m[1], action: m[2] as ListingAction, surface: m[3] as Surface } : null;
}

// set_ask and anything else that isn't <id>_<a|n|x> is not a capture button.
export function parseCaptureArg(arg: string): { captureId: string; action: CaptureAction } | null {
    const m = /^([0-9a-f]{24})_([anx])$/.exec(arg);
    return m ? { captureId: m[1], action: m[2] as CaptureAction } : null;
}

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function buildAskNote(t: Translate, capture: { id: string; parsed: Parsed }, botUsername: string): Card {
    const { parsed, id } = capture;
    const complete = Boolean(parsed.title && parsed.price);
    const first: InlineKeyboardButton = complete
        ? { text: t("captureAddButton"), callback_data: captureActionData(id, "a"), style: "success" }
        : { text: t("captureCompleteButton"), url: deepLink(botUsername, `c_${id}`), style: "success" };
    return {
        text: complete
            ? t("captureNoteComplete", { title: parsed.title ?? "", details: [parsed.price, parsed.location].filter(Boolean).join(" · ") })
            : t("captureNoteIncomplete"),
        // Add on its own row, so the two longer labels get half a row each (three in a row cut "לא לשאול שוב").
        keyboard: [
            [first],
            [
                { text: t("captureNotNowButton"), callback_data: captureActionData(id, "n") },
                { text: t("captureNeverButton"), callback_data: captureActionData(id, "x") },
            ],
        ],
    };
}

type CardOptions = { surface: "n"; botUsername: string; refreshed?: boolean } | { surface: "c"; refreshed?: boolean };

export function buildManagementCard(t: Translate, listing: Pick<IListing, "_id" | "title" | "price">, o: CardOptions): Card {
    const id = String(listing._id);
    const params = { title: listing.title ?? "", price: listing.price ?? "" };
    // Two to a row: three in a row clip the labels on a phone.
    const keyboard: InlineKeyboardButton[][] = [
        [
            { text: t("listingSoldButton"), callback_data: listingActionData(id, "s", o.surface) },
            { text: t("listingRefreshButton"), callback_data: listingActionData(id, "f", o.surface) },
        ],
        [{ text: t("listingRemoveButton"), callback_data: listingActionData(id, "r", o.surface) }],
    ];
    if (o.surface === "n") keyboard[1].push({ text: t("listingManageButton"), url: deepLink(o.botUsername, `l_${id}`) });
    return { text: t(o.refreshed ? "listingRefreshedCard" : "listingCard", params), keyboard };
}

export function buildEndedCard(t: Translate, listing: Pick<IListing, "status" | "title">): Card {
    const text = listing.status === "sold" ? t("listingSoldNote", { title: listing.title ?? "" })
        : listing.status === "removed" ? t("listingRemovedNote")
            : t("listingEnded");
    return { text, keyboard: [] };
}

export function buildNeverNote(t: Translate, botUsername: string): Card {
    return { text: t("captureNeverNote"), keyboard: [[{ text: t("captureOpenBotButton"), url: `https://t.me/${botUsername}` }]] };
}

export const catchupActionData = (memberId: string, action: "x" | number): string => `ck_${memberId}_${action}`;

export function parseCatchupArg(arg: string): { memberId: string; action: "x" } | { memberId: string; action: "add"; messageId: number } | null {
    const m = /^([0-9a-f]{24})_(x|[1-9]\d*)$/.exec(arg);
    if (!m) return null;
    return m[2] === "x" ? { memberId: m[1], action: "x" } : { memberId: m[1], action: "add", messageId: Number(m[2]) };
}

export function buildCatchupNote(t: Translate, o: { memberId: string; count: number }, botUsername: string): Card {
    return {
        text: t("catchupOfferNote", { n: o.count }),
        keyboard: [
            [{ text: t("catchupPickButton"), url: deepLink(botUsername, `k_${o.memberId}`), style: "success" }],
            [{ text: t("catchupNoThanksButton"), callback_data: catchupActionData(o.memberId, "x") }],
        ],
    };
}

// ponytail: capped at 15 so the text stays under Telegram's 4096 characters; the rest appear as earlier ones are added.
const CATCHUP_LIST_MAX = 15;

export function buildCatchupList(t: Translate, o: { memberId: string; items: CatchupItem[] }): Card {
    const items = o.items.slice(0, CATCHUP_LIST_MAX);
    if (!items.length) return { text: t("catchupAllDone"), keyboard: [] };
    const lines = items.map((it, i) => `${i + 1}. ${[it.title, it.price, it.location].filter(Boolean).join(" · ")}`);
    return {
        text: [t("catchupListTitle"), "", ...lines].join("\n"),
        keyboard: items.map((it, i) => [{ text: [...`➕ ${i + 1}. ${it.title}`].slice(0, 32).join(""), callback_data: catchupActionData(o.memberId, it.messageId) }]),
    };
}

// The nudge keyboard: two to a row. A bot listing never gets Remove; the DM omits the Manage link.
export function nudgeKeyboard(listing: Pick<IListing, "_id" | "source">, t: Translate, botUsername?: string): InlineKeyboardButton[][] {
    const id = String(listing._id);
    const keyboard: InlineKeyboardButton[][] = [
        [
            { text: t("nudgeStillButton"), callback_data: lifecycleActionData(id, "r") },
            { text: t("listingSoldButton"), callback_data: lifecycleActionData(id, "s") },
        ],
    ];
    const row: InlineKeyboardButton[] = [];
    if (listing.source === "group") row.push({ text: t("listingRemoveButton"), callback_data: lifecycleActionData(id, "x") });
    if (botUsername) row.push({ text: t("listingManageButton"), url: deepLink(botUsername, `l_${id}`) });
    if (row.length) keyboard.push(row);
    return keyboard;
}
