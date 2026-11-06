import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, InlineKeyboardButton, Message } from "node-telegram-bot-api/types";
import { isApiError } from "../config/telegramErrors";
import type { ICapture } from "../models/Capture";
import type { IListing } from "../models/Listing";
import captureRepository from "../repositories/captureRepository";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import userRepository from "../repositories/userRepository";
import type { BotConfig } from "../types";
import { findBlockedWord, withLinkUrls } from "./blockedWords";
import { classify, textHash, type Parsed } from "./classifier";
import { groupMessageLink } from "./deepLinks";
import { editNote } from "./ephemeralNotes";
import { buildEndedCard, buildManagementCard, escapeHtml, listingActionData, parseListingArg, Card } from "./listingCards";
import { localeService } from "./localeService";

export type AddResult =
    | { kind: "added"; listing: IListing }
    | { kind: "already"; listing: IListing | null }
    | { kind: "gone" };

const normTitle = (title?: string): string => (title ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// A repost refreshes a listing only for the same item: the same text, or the same title (the
// caller already knows the texts overlap). "Glock 19" after "Glock 17" is another item.
export function isSameItem(listing: IListing, text: string, parsed: Parsed): boolean {
    if (listing.textHash === textHash(text)) return true;
    const title = normTitle(parsed.title);
    return title !== "" && title === normTitle(classify(listing.text ?? "", listing.media.length > 0).parsed.title);
}

const SECTION_MAX = 15;
const TOASTS = { s: "listingSoldToast", f: "listingRefreshedToast", r: "listingRemovedToast" } as const;

// A member's own group message, once they said yes: Add, then Sold / Refresh /
// Remove from the private note or the bot, and edit sync. A member's message in the
// group is never touched, and every ls_ button is refused on a bot post.
export class GroupListingService {
    private groupUsername?: string;

    constructor(private api: Api, private config: BotConfig, private getBotUsername: () => string) { }

    async addToMarket(captureId: string, fields: { title: string; price: string; location?: string }, now = new Date()): Promise<AddResult> {
        const peek = await captureRepository.findById(captureId);
        // only a sale post can be listed (a forged button on a want-to-buy must not)
        if (!peek || (peek.tier !== "strict" && peek.tier !== "ask")) return { kind: "gone" };
        const previous = peek.state === "classified" ? "classified" : "asked";
        const firstForSeller = (await listingRepository.countBySeller(peek.senderId)) === 0; // before the claim: a failure here leaves the capture alone

        // The atomic claim: a double press has exactly one winner.
        const capture = await captureRepository.transition(captureId, ["classified", "asked"], "added");
        if (!capture) {
            const existing = await captureRepository.findById(captureId);
            // The winner may not have written listingId yet: still "already", without the listing.
            if (existing?.state !== "added") return { kind: "gone" };
            return { kind: "already", listing: existing.listingId ? await listingRepository.findById(existing.listingId) : null };
        }

        let listing: IListing | undefined;
        try {
            listing = await listingRepository.createFromCapture({
                chatId: capture.chatId,
                messageIds: capture.messageIds,
                sellerId: capture.senderId,
                sellerName: capture.senderName,
                ...fields,
                text: capture.text,
                media: capture.media,
                isBundle: capture.parsed?.isBundle ?? false,
                note: capture.note && { ephemeralMessageId: capture.note.ephemeralMessageId, sentAt: capture.note.sentAt },
            }, now);
            await captureRepository.setListing(captureId, String(listing._id));
        } catch (err) {
            console.error("[ERROR - GroupListingService.addToMarket]", { captureId, userId: capture.senderId }, (err as Error).message);
            // undo, so the button works again and a second press cannot double-list
            if (listing) await listingRepository.deleteById(String(listing._id)).catch((e: Error) => console.error("[ERROR - GroupListingService.addToMarket]", "undo failed:", e.message));
            await captureRepository.transition(captureId, ["added"], previous).catch((e: Error) => console.error("[ERROR - GroupListingService.addToMarket]", "rollback failed:", e.message));
            throw err;
        }
        if (firstForSeller) await this.notifyNewSeller(listing);
        return { kind: "added", listing };
    }

    // One card in the moderation topic for a seller's first captured listing; the
    // existing td_ button takes it down without touching the member's message.
    private async notifyNewSeller(listing: IListing): Promise<void> {
        if (!this.config.moderationGroupId) return;
        try {
            const t = (key: string, params?: Record<string, string>) => localeService.t(this.config.lang, key, params);
            const topic = Number(this.config.moderationTopicId);
            await this.api.sendMessage({
                chat_id: this.config.moderationGroupId,
                ...(topic && topic !== 1 ? { message_thread_id: topic } : {}),
                text: t("captureModCard", {
                    name: listing.sellerName ?? "",
                    title: listing.title ?? "",
                    price: listing.price ?? "",
                    link: await this.groupLink(listing.messageIds[0]),
                }),
                reply_markup: { inline_keyboard: [[{ text: t("takeDownButton"), callback_data: `td_${listing._id}` }]] },
            });
        } catch (err) {
            console.error("[ERROR - GroupListingService.notifyNewSeller]", (err as Error).message);
        }
    }

    async groupLink(messageId: number): Promise<string> {
        if (this.groupUsername === undefined) {
            try {
                const chat: unknown = await this.api.getChat({ chat_id: this.config.approvedGroupId });
                this.groupUsername = typeof chat === "object" && chat !== null ? (chat as { username?: string }).username ?? "" : "";
            } catch (err) {
                console.error("[ERROR - GroupListingService.groupLink]", (err as Error).message); // not cached: try again next time
            }
        }
        return groupMessageLink({ id: this.config.approvedGroupId, username: this.groupUsername || undefined }, messageId);
    }

    async handleListingCallback(query: CallbackQuery, arg: string, now = new Date()): Promise<void> {
        let locale = this.config.lang;
        let answered = false;
        // Exactly one answer per press; a failing answer never stops the effects.
        const answer = async (key: string): Promise<void> => {
            if (answered) return;
            answered = true;
            try {
                await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, key) });
            } catch (err) {
                console.error("[ERROR - GroupListingService.handleListingCallback]", "answerCallbackQuery failed:", (err as Error).message);
            }
        };

        try {
            const from = String(query.from.id);
            locale = localeService.resolveUserLocale(await userRepository.findByUserId(from));
            const parsed = parseListingArg(arg);
            if (!parsed) return await answer("staleButton");
            const listing = await listingRepository.findById(parsed.listingId);
            if (!listing) return await answer("postNotFound");
            if (from !== listing.sellerId) return await answer("notYourButton");
            if (listing.source !== "group") return await answer("staleButton"); // a bot post is never managed with ls_

            let current: IListing | null = listing;
            if (listing.status === "live" || listing.status === "expired") {
                const id = parsed.listingId;
                const changed = parsed.action === "s" ? await listingRepository.markSold(id, now)
                    : parsed.action === "f" ? await listingRepository.refresh(id, now)
                        : await listingRepository.markRemoved(id, "seller", now);
                if (changed) {
                    current = changed;
                    await answer(TOASTS[parsed.action]);
                } else {
                    current = (await listingRepository.findById(id)) ?? listing; // lost a race: show what won
                    await answer("listingEnded");
                }
            } else {
                await answer("listingEnded");
            }

            const refreshed = parsed.action === "f" && current.status === "live";
            await this.syncNote(current, refreshed);
            // the card and the list live in the member's private chat: a press from anywhere else (a forged _c/_l) edits nothing
            const inPrivate = query.message?.chat.type === "private";
            if (parsed.surface === "c" && query.message && inPrivate) {
                await this.editCard(query.message.chat.id, query.message.message_id, current, refreshed, locale);
            }
            if (parsed.surface === "l" && query.message && inPrivate) {
                await this.editSection(query.message.chat.id, query.message.message_id, from, locale);
            }
        } catch (err) {
            console.error("[ERROR - GroupListingService.handleListingCallback]", (err as Error).message);
            await answer("staleButton");
        }
    }

    // The /myposts group section: live and expired listings with their buttons, then the settings row.
    async renderGroupSection(userId: string, locale: string): Promise<{ card: Card; hasListings: boolean } | null> {
        const listings = await listingRepository.findGroupBySeller(userId);
        const hasListings = listings.length > 0;
        if (!hasListings && this.config.captureMode !== "optin") return null;
        const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
        const active = listings.filter((l) => l.status === "live" || l.status === "expired");
        const shown = active.slice(0, SECTION_MAX);
        const ended = listings.length - active.length;

        const lines: string[] = [];
        if (hasListings) {
            lines.push(t("myPostsGroupTitle"));
            for (const [i, l] of shown.entries()) {
                lines.push(`${i + 1}. <a href="${await this.groupLink(l.messageIds[0])}">${escapeHtml(l.title ?? "")}</a> · ${escapeHtml(l.price ?? "")}`);
            }
            if (active.length > shown.length) lines.push(`+${active.length - shown.length}`);
            if (ended > 0) lines.push(t("myPostsGroupEnded", { n: ended }));
        }
        const never = (await memberRepository.findByUserId(userId))?.askMode === "never";
        const text = [...lines, ...(lines.length ? [""] : []), t(never ? "myPostsAskOff" : "myPostsAskOn")].join("\n");

        const keyboard: InlineKeyboardButton[][] = shown.map((l, i) => {
            const id = String(l._id);
            return [
                { text: `🤝 ${i + 1}`, callback_data: listingActionData(id, "s", "l") },
                { text: `🔄 ${i + 1}`, callback_data: listingActionData(id, "f", "l") },
                { text: `🗑 ${i + 1}`, callback_data: listingActionData(id, "r", "l") },
            ];
        });
        keyboard.push([never
            ? { text: t("myPostsAskResumeButton"), callback_data: "mk_set_ask" }
            : { text: t("myPostsAskStopButton"), callback_data: "mk_set_never" }]);
        return { card: { text, keyboard }, hasListings };
    }

    // Re-renders a pressed /myposts section message.
    async editSection(chatId: number, messageId: number, userId: string, locale: string): Promise<void> {
        const section = await this.renderGroupSection(userId, locale);
        if (!section) return;
        try {
            await this.api.editMessageText({
                chat_id: chatId, message_id: messageId, text: section.card.text, parse_mode: "HTML",
                link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: section.card.keyboard },
            });
        } catch (err) {
            if (!isApiError(err, 400, "message is not modified")) {
                console.error("[ERROR - GroupListingService.editSection]", (err as Error).message);
            }
        }
    }

    private async editCard(chatId: number, messageId: number, listing: IListing, refreshed: boolean, locale: string): Promise<void> {
        const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
        const card = listing.status === "live" ? buildManagementCard(t, listing, { surface: "c", refreshed }) : buildEndedCard(t, listing);
        try {
            await this.api.editMessageText({ chat_id: chatId, message_id: messageId, text: card.text, reply_markup: { inline_keyboard: card.keyboard } });
        } catch (err) {
            if (!isApiError(err, 400, "message is not modified")) {
                console.error("[ERROR - GroupListingService.handleListingCallback]", "editMessageText failed:", (err as Error).message);
            }
        }
    }

    // Brings the private note in line with the listing; best effort, and never from query.message.
    async syncNote(listing: IListing, refreshed = false): Promise<void> {
        if (!listing.note || listing.chatId === undefined) return;
        try {
            const locale = localeService.resolveUserLocale(await userRepository.findByUserId(listing.sellerId));
            const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
            const card: Card = listing.status === "live"
                ? buildManagementCard(t, listing, { surface: "n", botUsername: this.getBotUsername(), refreshed })
                : buildEndedCard(t, listing);
            await editNote(this.api, listing.chatId, Number(listing.sellerId), listing.note.ephemeralMessageId, card);
        } catch (err) {
            console.error("[ERROR - GroupListingService.syncNote]", (err as Error).message);
        }
    }

    // The member reposted the same item: the old listing gets a fresh clock and follows the newest
    // repost (message ids, text, media, price...).
    refreshFromRepost(listing: IListing, capture: Pick<ICapture, "messageIds" | "text" | "media">, parsed: Parsed, now: Date): Promise<IListing | null> {
        return listingRepository.refresh(String(listing._id), now, {
            messageIds: capture.messageIds,
            text: capture.text,
            ...(capture.media.length ? { media: capture.media } : {}),
            isBundle: parsed.isBundle,
            title: parsed.title,
            price: parsed.price,
            priceValue: parsed.priceValue,
            location: parsed.location,
        });
    }

    // An edit of the member's message keeps the listing in step; a blocked word ends it (never a take-down).
    async handleEdit(msg: Message, now = new Date()): Promise<void> {
        try {
            const listing = await listingRepository.findLiveByMessage(msg.chat.id, msg.message_id);
            if (!listing) return;
            const text = msg.text ?? msg.caption ?? ""; // empty: an album item
            if (!text) return;
            const id = String(listing._id);
            if (findBlockedWord(withLinkUrls(text, msg.text !== undefined ? msg.entities : msg.caption_entities))) {
                const removed = await listingRepository.markRemoved(id, "system", now);
                if (removed) await this.syncNote(removed);
                return;
            }
            const { parsed } = classify(text, listing.media.length > 0);
            const updated = await listingRepository.applyEdit(id, {
                text,
                isBundle: parsed.isBundle,
                title: parsed.title,
                price: parsed.price,
                priceValue: parsed.priceValue,
                location: parsed.location,
            });
            if (updated) await this.syncNote(updated);
        } catch (err) {
            console.error("[ERROR - GroupListingService.handleEdit]", (err as Error).message);
        }
    }
}
