import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery } from "node-telegram-bot-api/types";
import { AuthLevel, BotConfig } from "../types";
import type { IListing } from "../models/Listing";
import listingRepository from "../repositories/listingRepository";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { userService } from "./userService";
import { localeService } from "./localeService";
import { isApiError } from "../config/telegramErrors";

// Moderator take-down (`td_<listingId>`, spec 5.5): the listing leaves the market,
// the public message goes, the seller is told. The post itself stays "approved".
// A member's own message in a group is never touched, with one deliberate exception:
// a moderator can also delete it, with all its photos, from a group listing's card
// (`tx_<listingId>_<d|y|n>`: ask, confirm, cancel). A seller's Remove never deletes anything.
export class TakeDownService {
    constructor(private api: Api, private config: BotConfig, private syncNote?: (listing: IListing) => Promise<void>) { }

    // `tx_` press. d: swap the card's buttons for a confirm step (nothing is stored; the
    // listing is the state, so it survives a restart); n: put the two buttons back;
    // y: the same atomic claim as td_, then delete the member's messages.
    async handleDeleteCallback(query: CallbackQuery, arg: string): Promise<void> {
        const m = /^([0-9a-f]{24})_([dyn])$/i.exec(arg);
        if (!m) return;
        const [, listingId, action] = m;
        if (action === "y") {
            await this.handleCallback(query, listingId, true);
            return;
        }
        const mod = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(mod);
        const t = (key: string) => localeService.t(locale, key);
        try {
            if (!(await userService.hasAuthLevel(String(query.from.id), AuthLevel.MOD))) {
                await this.api.answerCallbackQuery({ callback_query_id: query.id, text: t("notAdmin"), show_alert: true });
                return;
            }
            const listing = await listingRepository.findById(listingId);
            if (!listing || listing.source !== "group" || !["live", "expired"].includes(listing.status)) {
                await this.api.answerCallbackQuery({ callback_query_id: query.id, text: t("takeDownAlready") });
                return;
            }
            const ask = action === "d";
            await this.api.answerCallbackQuery({ callback_query_id: query.id, ...(ask ? { text: t("takeDownDeleteWarn"), show_alert: true } : {}) });
            if (query.message) {
                await this.api.editMessageReplyMarkup({
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: ask ? confirmKeyboard(listingId, t) : groupCardKeyboard(listingId, t) },
                });
            }
        } catch (err) {
            console.error("[ERROR - TakeDownService.handleDeleteCallback]", { listingId }, (err as Error).message);
        }
    }

    async handleCallback(query: CallbackQuery, listingId: string, deleteOriginal = false): Promise<void> {
        const mod = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(mod);
        const answer = (key: string, alert = false) =>
            this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, key), ...(alert ? { show_alert: true } : {}) });

        // The only step that can stop the rest: the atomic take-down itself.
        let before: IListing | null;
        try {
            if (!(await userService.hasAuthLevel(String(query.from.id), AuthLevel.MOD))) {
                await answer("notAdmin", true);
                return;
            }
            // Atomic: only one press wins, a sold/removed/malformed id gets "already".
            // The delete button exists only on a group listing's card; a bot post never deletes here.
            if (deleteOriginal && (await listingRepository.findById(listingId))?.source !== "group") {
                await answer("takeDownAlready");
                return;
            }
            before = /^[0-9a-f]{24}$/i.test(listingId) ? await listingRepository.takeDown(listingId, new Date()) : null;
            if (!before) {
                await answer("takeDownAlready");
                return;
            }
        } catch (err) {
            console.error("[ERROR - TakeDownService.handleCallback]", { listingId }, (err as Error).message);
            return;
        }
        const taken: IListing = before;

        // From here the listing is taken_down and a second press only says "already",
        // so nothing retries: every effect is independent and best-effort, and a
        // failure logs the ids a moderator needs to finish by hand.
        const ids: { listingId: string; postId?: string; approvedMessageId?: number | null } = { listingId, postId: taken.postId };
        const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
            try {
                return await fn();
            } catch (err) {
                console.error("[ERROR - TakeDownService.handleCallback]", `${name} failed:`, (err as Error).message, ids);
                return null;
            }
        };

        await step("answerCallbackQuery", () => answer("takeDownDone"));

        // Deleting can't be undone: log who asked and exactly what, before trying.
        let left = 0;
        if (deleteOriginal) {
            const messageIds = [...taken.messageIds];
            console.info("[INFO - TakeDownService] moderator deletes the original post", { moderatorId: query.from.id, listingId, messageIds });
            left = await this.deleteOriginal(taken, messageIds, ids);
        }

        let title = taken.title ?? "";
        if (taken.source === "bot" && taken.postId) {
            const postId = taken.postId;
            const post = await step("load post", () => postRepository.findById(postId));
            if (post) {
                title = post.title ?? title;
                ids.approvedMessageId = post.approvedMessageId;
                if (post.approvedMessageId) await step("deleteMessage", () => this.deletePublicMessage(post.approvedMessageId!));
                await step("setApprovedMessageId", () => postRepository.setApprovedMessageId(postId, null));
            }
        }

        await step("notify seller", () => this.notifySeller(taken.sellerId, title));

        // A group listing's private note must stop offering Sold/Refresh/Remove.
        if (taken.note && this.syncNote) {
            await step("sync note", async () => {
                const ended = await listingRepository.findById(listingId);
                if (ended) await this.syncNote!(ended);
            });
        }

        // Closes the card (drops the button).
        const msg = query.message;
        if (msg) {
            await step("editMessageText", () => this.api.editMessageText({
                chat_id: msg.chat.id,
                message_id: msg.message_id,
                text: localeService.t(locale, deleteOriginal ? "statusTakenDownDeleted" : "statusTakenDown")
                    + (left > 0 ? "\n" + localeService.t(locale, "takeDownDeleteLeft", { count: String(left) }) : ""),
            }));
        }
    }

    // Telegram skips ids it can't find and answers true, so only a failed call (no
    // delete right, 48 h limit on the whole batch) is counted as left. deleteMessages takes 1-100 ids.
    private async deleteOriginal(listing: IListing, messageIds: number[], ids: object): Promise<number> {
        const chatId = listing.chatId ?? this.config.approvedGroupId;
        let left = 0;
        for (let i = 0; i < messageIds.length; i += 100) {
            const chunk = messageIds.slice(i, i + 100);
            try {
                await this.api.deleteMessages({ chat_id: chatId, message_ids: chunk });
            } catch (err) {
                left += chunk.length;
                console.error("[ERROR - TakeDownService.handleCallback]", "deleteMessages failed:", (err as Error).message, { ...ids, chatId, messageIds: chunk });
            }
        }
        return left;
    }

    // A message that is already gone counts as deleted; any other failure is thrown to the step.
    private async deletePublicMessage(messageId: number): Promise<void> {
        try {
            await this.api.deleteMessage({ chat_id: this.config.approvedGroupId, message_id: messageId });
        } catch (err) {
            if (!isApiError(err, 400, "message to delete not found")) throw err;
        }
    }

    // No users doc: nobody to tell. A send error (403 blocked) is only a warning.
    private async notifySeller(sellerId: string, title: string): Promise<void> {
        const seller = await userRepository.findByUserId(sellerId);
        if (!seller) return;
        try {
            await this.api.sendMessage({
                chat_id: Number(sellerId),
                text: localeService.t(localeService.resolveUserLocale(seller), "takeDownNotice", { title }),
            });
        } catch (err) {
            console.warn("[WARN - TakeDownService.notifySeller] could not tell the seller:", (err as Error).message);
        }
    }
}

type Translate = (key: string) => string;

// The group listing's moderation card: Remove from market (td_), or also delete the original (tx_..._d).
export function groupCardKeyboard(listingId: string, t: Translate) {
    return [
        [{ text: t("takeDownButton"), callback_data: `td_${listingId}` }],
        [{ text: t("takeDownDeleteButton"), callback_data: `tx_${listingId}_d` }],
    ];
}

function confirmKeyboard(listingId: string, t: Translate) {
    return [
        [{ text: t("takeDownDeleteConfirmButton"), callback_data: `tx_${listingId}_y` }],
        [{ text: t("takeDownDeleteCancelButton"), callback_data: `tx_${listingId}_n` }],
    ];
}
