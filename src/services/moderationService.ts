import { expectReply, matchReply, forgetReply, expectCallback, matchCallback, forgetCallback } from "node-telegram-bot-api";
import type { Api, Context } from "node-telegram-bot-api";
import type { CallbackQuery, InlineKeyboardMarkup } from "node-telegram-bot-api/types";
import { AuthLevel, BotConfig, Post, User, UserSession } from "../types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { userService } from "./userService";
import { PostService } from "./postService";
import { PublishService } from "./publishService";
import type { IListing } from "../models/Listing";
import { localeService } from "./localeService";
import { sessionKey } from "../controllers/middleware";

// Reply marker on the reject prompt; press marker on the Skip message. Each knows the other's id.
type RejectReplyMarker = { postId: string; skipMsgId: number };
type RejectSkipMarker = { postId: string; promptId: number };

export class ModerationService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private postService: PostService,
        private publishService: PublishService,
        private getBotUsername: () => string // the reject notice's "Fix and resend" deep link
    ) { }

    private get lang() {
        return this.config.lang;
    }

    async handleCallback(ctx: Context, query: CallbackQuery): Promise<void> {
        if (!query.data) return;

        const isApprove = query.data.startsWith("approve_");
        const isReject = query.data.startsWith("reject_");
        if (!isApprove && !isReject) return;

        const postId = query.data.replace(/^(approve_|reject_)/, "");

        const adminUser = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(adminUser);

        let claimed = null;
        let listing: IListing | null = null;

        try {
            console.debug('[DEBUG - ModerationService.handleCallback]', { adminId: query.from.id, data: query.data });

            const isAuthorized = await userService.hasAuthLevel(String(query.from.id), AuthLevel.MOD);
            if (!isAuthorized) {
                this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'notAdmin'), show_alert: true });
                return;
            }

            const post = await postRepository.findById(postId);
            if (!post) {
                this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'adminPostNotFound') });
                return;
            }

            if (String(post.userId) === String(query.from.id)) {
                console.warn("[WARN - ModerationService.handleCallback]", "Admin is moderating their own post", { adminId: query.from.id, postId });
            }

            // Claim the post first: the reject-reason prompt waits on a human, and
            // a read-then-check here lets a second moderator through.
            claimed = await postRepository.claimPending(postId, isApprove ? "approved" : "rejected");
            if (!claimed) {
                this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'adminPostHandled') });
                return;
            }

            const postAuthor = await userRepository.findByUserId(post.userId);
            if (!postAuthor) {
                this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'adminUserNotFound') });
                return;
            }

            if (isApprove) {
                listing = await this.handleApproval(query, postId, post, postAuthor, locale);
            } else {
                await this.handleRejection(ctx, query, postId, locale);
            }

            if (query.message) {
                const statusText = isApprove
                    ? localeService.t(locale, 'statusApproved')
                    : localeService.t(locale, 'statusRejected');

                // Best-effort: a duplicate/failed redraw must not reach the outer
                // catch, which would release the claim and un-moderate the post.
                this.api.editMessageText({
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    text: statusText,
                    // Every published card can be taken down (Decision 6).
                    ...(listing ? { reply_markup: { inline_keyboard: [[{ text: localeService.t(this.lang, 'takeDownButton'), callback_data: `td_${listing._id}` }]] } } : {}),
                }).catch((err: Error) => console.warn("[WARN - ModerationService.handleCallback] editMessageText failed:", err.message));
            }
        } catch (err) {
            console.error("[ERROR - ModerationService.handleCallback]", (err as Error).message);
            // Release the claim so the post returns to the queue and can be retried.
            if (claimed) await postRepository.updateStatus(postId, "pending");
            this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'adminError') });
        }
    }

    private async handleApproval(query: CallbackQuery, postId: string, post: Post, postAuthor: User, adminLocale: string): Promise<IListing | null> {
        const listing = await this.publishService.publishApproved(post, postAuthor);

        this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(adminLocale, 'adminApproved') });

        console.info('[INFO - ModerationService.handleApproval]', {
            action: 'APPROVED',
            postId,
            postTitle: post.title,
            admin: { id: query.from.id, username: query.from.username },
            author: { id: post.userId, username: postAuthor.userName, firstName: postAuthor.firstName }
        });
        return listing;
    }

    // Reject = claim (done by the caller), then ask for a reason. The author is
    // told only after a reason or a Skip, in a later update (handleRejectReply /
    // handleSkip): the prompt is persisted reply tracking, not a pending promise.
    private async handleRejection(ctx: Context, query: CallbackQuery, postId: string, adminLocale: string): Promise<void> {
        this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(adminLocale, 'adminRejected') });
        await this.askRejectReason(ctx, query, postId);
    }

    // One message: the prompt carries the four preset buttons (rr_) and the moderator
    // may instead reply to it. No force_reply: it can't share a message with an inline
    // keyboard, and in live testing it opened nothing. Reply and press markers live in
    // separate tables, so both key on the same message id (promptId === skipMsgId); the
    // press marker is what a legacy Skip button (skip_reason_) still resolves against.
    private async askRejectReason(ctx: Context, query: CallbackQuery, postId: string): Promise<void> {
        const chatId = query.message!.chat.id;
        const topicId = query.message && "message_thread_id" in query.message ? query.message.message_thread_id : undefined;
        const thread = topicId && Number(topicId) !== 1 ? { message_thread_id: Number(topicId) } : {};

        const prompt = await this.api.sendMessage({
            chat_id: chatId,
            text: localeService.t(this.lang, 'rejectReasonPrompt'),
            reply_markup: {
                inline_keyboard: ([1, 2, 3, 4] as const).map(n => [
                    { text: localeService.t(this.lang, `rejectPreset${n}`), callback_data: `rr_${postId}_${n}` },
                ]),
            },
            ...thread,
        });
        const id = prompt.message_id;

        expectReply(ctx, id, { postId, skipMsgId: id } satisfies RejectReplyMarker);
        expectCallback(ctx, id, { postId, promptId: id } satisfies RejectSkipMarker);
        // The reply-tracking table has no read-only peek, so keep a mirror of what is pending.
        const data = ctx.getSession<UserSession>().data;
        data.pendingRejects = [...(data.pendingRejects ?? []), { promptId: id, skipMsgId: id }];
    }

    private async removeKeyboard(chatId: number, messageId: number): Promise<void> {
        await this.api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
            .catch((err: Error) => console.warn("[WARN - ModerationService.removeKeyboard] editMessageReplyMarkup failed:", err.message));
    }

    private dropPending(ctx: Context, promptId: number): void {
        const data = ctx.getSession<UserSession>().data;
        const rest = (data.pendingRejects ?? []).filter(p => p.promptId !== promptId);
        if (rest.length > 0) data.pendingRejects = rest;
        else delete data.pendingRejects;
    }

    // The claim comes first (atomic, stores the reason): presets, typed replies and
    // Skip race, and only the winner tells the author.
    private async finishRejection(
        postId: string,
        reason: { preset: 1 | 2 | 3 | 4 } | { text: string } | null,
        admin: { id: number; username?: string }
    ): Promise<"notified" | "unreachable" | "handled" | "missing"> {
        const post = await postRepository.findById(postId);
        if (!post) {
            console.error("[ERROR - ModerationService.finishRejection] post not found", { postId });
            return "missing";
        }
        const reasonIn = (locale: string): string | null =>
            reason === null ? null : "preset" in reason ? localeService.t(locale, `rejectPreset${reason.preset}`) : reason.text;

        if (!await postRepository.claimRejectionNotice(postId, reasonIn(this.lang))) return "handled";

        const postAuthor = await userRepository.findByUserId(post.userId);
        const authorLocale = localeService.resolveUserLocale(postAuthor);
        const authorReason = reasonIn(authorLocale);
        const text = authorReason
            ? localeService.t(authorLocale, 'postRejectedWithReason') + authorReason
            : localeService.t(authorLocale, 'postRejected');
        let result: "notified" | "unreachable" = "notified";
        await this.api.sendMessage({ chat_id: Number(post.userId), text, reply_markup: this.buildRejectNoticeKeyboard(authorLocale) })
            .catch((err: Error) => {
                result = "unreachable";
                console.error("[ERROR - ModerationService.finishRejection] notifying the author failed:", err.message);
            });

        console.info('[INFO - ModerationService.handleRejection]', {
            action: authorReason ? 'REJECTED_WITH_REASON' : 'REJECTED_WITHOUT_REASON',
            postId,
            postTitle: post.title,
            reason: authorReason || 'N/A',
            admin,
            author: { id: post.userId, username: postAuthor?.userName, firstName: postAuthor?.firstName }
        });
        return result;
    }

    // Row 1 sends the seller back into the wizard (/start sell), row 2 (if configured) to the group rules.
    private buildRejectNoticeKeyboard(locale: string): InlineKeyboardMarkup {
        const rows: InlineKeyboardMarkup["inline_keyboard"] = [[
            { text: localeService.t(locale, 'rejectFixButton'), url: `https://t.me/${this.getBotUsername()}?start=sell` },
        ]];
        if (this.config.rulesUrl) rows.push([{ text: localeService.t(locale, 'rejectRulesButton'), url: this.config.rulesUrl }]);
        return { inline_keyboard: rows };
    }

    /** A preset button (rr_<postId>_<n>) on a reject prompt. */
    async handleReasonCallback(ctx: Context, query: CallbackQuery, arg: string): Promise<void> {
        const adminUser = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(adminUser);
        const m = /^([0-9a-f]{24})_([1-4])$/.exec(arg);
        if (!m) {
            this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'staleButton') });
            return;
        }
        if (!await userService.hasAuthLevel(String(query.from.id), AuthLevel.MOD)) {
            this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'notAdmin'), show_alert: true });
            return;
        }

        const preset = Number(m[2]) as 1 | 2 | 3 | 4;
        const result = await this.finishRejection(m[1], { preset }, { id: query.from.id, username: query.from.username });

        // The presser may be the moderator who holds the reply marker for this prompt: drop it.
        const hit = sessionKey(ctx) ? matchCallback<RejectSkipMarker>(ctx, { once: true }) : undefined;
        if (hit) {
            forgetReply(ctx, hit.promptId);
            this.dropPending(ctx, hit.promptId);
        }

        if (result === "handled" || result === "missing") {
            this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, result === "handled" ? 'adminPostHandled' : 'adminPostNotFound') });
            return;
        }
        this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'adminRejected') });
        if (query.message) {
            // Editing the text drops the keyboard too.
            const lines = [localeService.t(this.lang, 'statusRejected'), localeService.t(this.lang, `rejectPreset${preset}`)];
            if (result === "unreachable") lines.push(localeService.t(this.lang, 'authorNotNotified'));
            this.api.editMessageText({ chat_id: query.message.chat.id, message_id: query.message.message_id, text: lines.join("\n") })
                .catch((err: Error) => console.warn("[WARN - ModerationService.handleReasonCallback] editMessageText failed:", err.message));
        }
    }

    /**
     * A group message from a moderator with a reject prompt pending. Returns true
     * when it was the reason (the chain stops); otherwise it may only nudge the
     * moderator and returns false.
     */
    async handleRejectReply(ctx: Context): Promise<boolean> {
        const msg = ctx.message;
        if (!msg?.from || msg.chat.type === "private" || !sessionKey(ctx)) return false;
        if (!ctx.getSession<UserSession>().data.pendingRejects?.length) return false;
        if (msg.text?.startsWith("/")) return false;

        const hit = msg.text ? matchReply<RejectReplyMarker>(ctx) : undefined;
        if (!hit) {
            // Group language, like the prompt itself (owner's decision for the moderation group).
            const topicId = msg.message_thread_id;
            await this.api.sendMessage({
                chat_id: msg.chat.id,
                text: localeService.t(this.lang, 'replyToPromptHint'),
                ...(topicId && Number(topicId) !== 1 ? { message_thread_id: Number(topicId) } : {}),
            });
            return false;
        }

        forgetCallback(ctx, hit.skipMsgId);
        this.dropPending(ctx, msg.reply_to_message!.message_id);
        await this.removeKeyboard(msg.chat.id, hit.skipMsgId);
        const result = await this.finishRejection(hit.postId, { text: msg.text! }, { id: msg.from.id, username: msg.from.username });
        if (result === "handled") {
            const topicId = msg.message_thread_id;
            await this.api.sendMessage({
                chat_id: msg.chat.id,
                text: localeService.t(this.lang, 'adminPostHandled'),
                ...(topicId && Number(topicId) !== 1 ? { message_thread_id: topicId } : {}),
            });
        }
        return true;
    }

    /** The Skip button on a reject prompt. False = not a live Skip (falls through to the stale-button toast). */
    async handleSkip(ctx: Context): Promise<boolean> {
        const query = ctx.callbackQuery;
        if (!query?.data?.startsWith("skip_reason_") || !query.message) return false;

        // The button names its moderator; another moderator's session holds no marker for it.
        if (query.data.split("_")[2] !== String(query.from.id)) {
            await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(this.lang, 'notYourButton') });
            return true;
        }

        const hit = sessionKey(ctx) ? matchCallback<RejectSkipMarker>(ctx, { once: true }) : undefined;
        if (!hit) return false;

        forgetReply(ctx, hit.promptId);
        this.dropPending(ctx, hit.promptId);
        await this.removeKeyboard(query.message.chat.id, query.message.message_id);
        const result = await this.finishRejection(hit.postId, null, { id: query.from.id, username: query.from.username });
        // One answer per press: the toast says so when someone else already told the author.
        await this.api.answerCallbackQuery({ callback_query_id: query.id, ...(result === "handled" ? { text: localeService.t(this.lang, 'adminPostHandled') } : {}) });
        return true;
    }

    /** /cancel in a group: forget this moderator's pending reject prompts in this chat. Returns how many. */
    async forgetPendingRejects(ctx: Context): Promise<number> {
        const chatId = ctx.chat?.id;
        if (!chatId || !sessionKey(ctx)) return 0;
        const data = ctx.getSession<UserSession>().data;
        const pending = data.pendingRejects ?? [];
        for (const p of pending) {
            forgetReply(ctx, p.promptId);
            forgetCallback(ctx, p.skipMsgId);
            await this.removeKeyboard(chatId, p.skipMsgId);
        }
        delete data.pendingRejects;
        return pending.length;
    }
}
