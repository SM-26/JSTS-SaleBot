import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery } from "node-telegram-bot-api/types";
import { AuthLevel, BotConfig } from "../types";
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
    constructor(private api: Api, private config: BotConfig) { }

    async handleCallback(query: CallbackQuery, listingId: string): Promise<void> {
        const mod = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(mod);
        const answer = (key: string, alert = false) =>
            this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, key), ...(alert ? { show_alert: true } : {}) });

        try {
            if (!(await userService.hasAuthLevel(String(query.from.id), AuthLevel.MOD))) {
                await answer("notAdmin", true);
                return;
            }

            // Atomic: only one press wins, a sold/removed/malformed id gets "already".
            const before = /^[0-9a-f]{24}$/i.test(listingId) ? await listingRepository.takeDown(listingId, new Date()) : null;
            if (!before) {
                await answer("takeDownAlready");
                return;
            }
            await answer("takeDownDone");

            let title = before.title ?? "";
            if (before.source === "bot" && before.postId) {
                const post = await postRepository.findById(before.postId);
                title = post?.title ?? title;
                if (post?.approvedMessageId) await this.deletePublicMessage(post.approvedMessageId);
                await postRepository.setApprovedMessageId(before.postId, null);
            }

            await this.notifySeller(before.sellerId, title);

            // Best-effort: closes the card (drops the button).
            if (query.message) {
                await this.api.editMessageText({
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    text: localeService.t(locale, "statusTakenDown"),
                }).catch((err: Error) => console.warn("[WARN - TakeDownService.handleCallback] editMessageText failed:", err.message));
            }
        } catch (err) {
            console.error("[ERROR - TakeDownService.handleCallback]", (err as Error).message);
        }
    }

    // A message that is already gone counts as deleted; any other failure is
    // logged and the take-down stands.
    private async deletePublicMessage(messageId: number): Promise<void> {
        try {
            await this.api.deleteMessage({ chat_id: this.config.approvedGroupId, message_id: messageId });
        } catch (err) {
            if (!isApiError(err, 400, "message to delete not found")) {
                console.error("[ERROR - TakeDownService.handleCallback]", "deleteMessage failed:", (err as Error).message);
            }
        }
    }

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
