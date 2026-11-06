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
// the public message goes, the seller is told. The post itself stays "approved";
// a member's own message in a group is never touched.
export class TakeDownService {
    constructor(private api: Api, private config: BotConfig, private syncNote?: (listing: IListing) => Promise<void>) { }

    async handleCallback(query: CallbackQuery, listingId: string): Promise<void> {
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
                text: localeService.t(locale, "statusTakenDown"),
            }));
        }
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
