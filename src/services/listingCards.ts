import type { InlineKeyboardButton } from "node-telegram-bot-api/types";
import type { IListing } from "../models/Listing";
import type { Parsed } from "./classifier";
import { deepLink } from "./deepLinks";
import { isMeetupLocation, meetupLocationText } from "./meetup";

export type Translate = (key: string, params?: Record<string, string | number | boolean>) => string;
export type Surface = "n" | "c" | "l";
export interface Card { text: string; keyboard: InlineKeyboardButton[][] }

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

export function buildManagementCard(t: Translate, listing: Pick<IListing, "_id" | "title" | "price" | "location" | "meetup">, o: CardOptions): Card {
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
    const meetupLine = listing.meetup || isMeetupLocation(listing.location) ? `\n📍 ${meetupLocationText(listing.location, t("meetupPlace"))}` : "";
    return { text: t(o.refreshed ? "listingRefreshedCard" : "listingCard", params) + meetupLine, keyboard };
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
