import type { InlineKeyboardButton } from "node-telegram-bot-api/types";
import { normalize } from "./classifier";
import { deepLink } from "./deepLinks";

const MEETING_POINT = normalize("בית דגן");

export const isMeetupLocation = (location?: string): boolean => normalize(location ?? "") === MEETING_POINT;

// "{location} · {place}"; just the location when it already is the meeting point, just the place when empty.
export function meetupLocationText(location: string | undefined, place: string): string {
    const loc = (location ?? "").trim();
    if (!loc) return place;
    if (isMeetupLocation(loc) || normalize(loc) === normalize(place)) return loc;
    return `${loc} · ${place}`;
}

export const meetupButton = (place: string, botUsername: string): InlineKeyboardButton => ({ text: `📍 ${place}`, url: deepLink(botUsername, "faq_1") });
