import type { InlineKeyboardButton } from "node-telegram-bot-api/types";
import { normalize } from "./classifier";
import { deepLink } from "./deepLinks";

const MEETING_POINT = normalize("בית דגן");

export const isMeetupLocation = (location?: string): boolean => normalize(location ?? "") === MEETING_POINT;

// "{location} · {place}"; just the location when it already is the meeting point, just the place when empty.
// `place` is the part that names the meeting point (the words a post links to its FAQ).
export function meetupLocationParts(location: string | undefined, place: string): { before: string; place: string } {
    const loc = (location ?? "").trim();
    if (!loc) return { before: "", place };
    if (isMeetupLocation(loc) || normalize(loc) === normalize(place)) return { before: "", place: loc };
    return { before: `${loc} · `, place };
}

export function meetupLocationText(location: string | undefined, place: string): string {
    const parts = meetupLocationParts(location, place);
    return parts.before + parts.place;
}

export const MEETUP_FAQ_PAYLOAD = "faq_1";

export const meetupButton = (place: string, botUsername: string): InlineKeyboardButton => ({ text: `📍 ${place}`, url: deepLink(botUsername, MEETUP_FAQ_PAYLOAD) });
