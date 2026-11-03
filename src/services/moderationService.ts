import { expectReply, matchReply, forgetReply, expectCallback, matchCallback, forgetCallback } from "node-telegram-bot-api";
import type { Api, Context } from "node-telegram-bot-api";
import type { CallbackQuery } from "node-telegram-bot-api/types";
import { AuthLevel, BotConfig, Post, User, UserSession } from "../types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { userService } from "./userService";
import { PostService } from "./postService";
import { localeService } from "./localeService";
import { sessionKey } from "../controllers/middleware";

// Reply marker on the reject prompt; press marker on the Skip message. Each knows the other's id.
type RejectReplyMarker = { postId: string; skipMsgId: number };
type RejectSkipMarker = { postId: string; promptId: number };

export class ModerationService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private postService: PostService
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
                await this.handleApproval(query, postId, post, postAuthor, locale);
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
                    text: statusText
                }).catch((err: Error) => console.warn("[WARN - ModerationService.handleCallback] editMessageText failed:", err.message));
            }
        } catch (err) {
            console.error("[ERROR - ModerationService.handleCallback]", (err as Error).message);
            // Release the claim so the post returns to the queue and can be retried.
            if (claimed) await postRepository.updateStatus(postId, "pending");
            this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'adminError') });
        }
    }

    private async handleApproval(query: CallbackQuery, postId: string, post: Post, postAuthor: User, adminLocale: string): Promise<void> {
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(postAuthor.userId),
            username: postAuthor.userName || undefined,
            firstName: postAuthor.firstName || "User",
        }, { showCta: true });

        const messageId = await this.postService.sendToApproved(richMessage);
        if (messageId) {
            await postRepository.setApprovedMessageId(postId, messageId);
        }

        const authorLocale = localeService.resolveUserLocale(postAuthor);
        this.api.sendMessage({ chat_id: Number(post.userId), text: localeService.t(authorLocale, 'postApproved') });
        this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(adminLocale, 'adminApproved') });

        console.info('[INFO - ModerationService.handleApproval]', {
            action: 'APPROVED',
            postId,
            postTitle: post.title,
            admin: { id: query.from.id, username: query.from.username },
            author: { id: post.userId, username: postAuthor.userName, firstName: postAuthor.firstName }
        });
    }

    // Reject = claim (done by the caller), then ask for a reason. The author is
    // told only after a reason or a Skip, in a later update (handleRejectReply /
    // handleSkip): the prompt is persisted reply tracking, not a pending promise.
    private async handleRejection(ctx: Context, query: CallbackQuery, postId: string, adminLocale: string): Promise<void> {
        this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(adminLocale, 'adminRejected') });
        await this.askRejectReason(ctx, query, postId);
    }

    // Two messages, because Telegram cannot combine force_reply and an inline
    // keyboard on one message: the prompt forces a reply, a second tiny message
    // right under it carries the Skip button.
    private async askRejectReason(ctx: Context, query: CallbackQuery, postId: string): Promise<void> {
        const chatId = query.message!.chat.id;
        const topicId = query.message && "message_thread_id" in query.message ? query.message.message_thread_id : undefined;
        const moderatorId = query.from.id;
        const thread = topicId && Number(topicId) !== 1 ? { message_thread_id: Number(topicId) } : {};

        const prompt = await this.api.sendMessage({
            chat_id: chatId,
            text: localeService.t(this.lang, 'rejectReasonPrompt'),
            reply_markup: { force_reply: true, selective: true },
            ...thread,
        });
        const skip = await this.api.sendMessage({
            chat_id: chatId,
            text: "👆",
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(this.lang, 'skipReasonButton'), callback_data: `skip_reason_${moderatorId}_${Date.now()}` },
                ]],
            },
            ...thread,
        });

        expectReply(ctx, prompt.message_id, { postId, skipMsgId: skip.message_id } satisfies RejectReplyMarker);
        expectCallback(ctx, skip.message_id, { postId, promptId: prompt.message_id } satisfies RejectSkipMarker);
        // The reply-tracking table has no read-only peek, so keep a mirror of what is pending.
        const data = ctx.getSession<UserSession>().data;
        data.pendingRejects = [...(data.pendingRejects ?? []), { promptId: prompt.message_id, skipMsgId: skip.message_id }];
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

    // Persist before notifying: the schema has carried this field all along
    // but nothing ever wrote it, so reasons only existed in the logs.
    private async finishRejection(postId: string, reason: string | null, admin: { id: number; username?: string }): Promise<void> {
        const post = await postRepository.findById(postId);
        if (!post) {
            console.error("[ERROR - ModerationService.finishRejection] post not found", { postId });
            return;
        }
        const postAuthor = await userRepository.findByUserId(post.userId);
        if (reason) {
            await postRepository.setRejectionReason(postId, reason);
        }

        const authorLocale = localeService.resolveUserLocale(postAuthor);
        const text = reason
            ? localeService.t(authorLocale, 'postRejectedWithReason') + reason
            : localeService.t(authorLocale, 'postRejected');
        await this.api.sendMessage({ chat_id: Number(post.userId), text })
            .catch((err: Error) => console.error("[ERROR - ModerationService.finishRejection] notifying the author failed:", err.message));

        console.info('[INFO - ModerationService.handleRejection]', {
            action: reason ? 'REJECTED_WITH_REASON' : 'REJECTED_WITHOUT_REASON',
            postId,
            postTitle: post.title,
            reason: reason || 'N/A',
            admin,
            author: { id: post.userId, username: postAuthor?.userName, firstName: postAuthor?.firstName }
        });
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
            const locale = localeService.resolveUserLocale(await userRepository.findByUserId(String(msg.from.id)));
            const topicId = msg.message_thread_id;
            await this.api.sendMessage({
                chat_id: msg.chat.id,
                text: localeService.t(locale, 'replyToPromptHint'),
                ...(topicId && Number(topicId) !== 1 ? { message_thread_id: Number(topicId) } : {}),
            });
            return false;
        }

        forgetCallback(ctx, hit.skipMsgId);
        this.dropPending(ctx, msg.reply_to_message!.message_id);
        await this.removeKeyboard(msg.chat.id, hit.skipMsgId);
        await this.finishRejection(hit.postId, msg.text!, { id: msg.from.id, username: msg.from.username });
        return true;
    }

    /** The Skip button on a reject prompt. False = not a live Skip (falls through to the stale-button toast). */
    async handleSkip(ctx: Context): Promise<boolean> {
        const query = ctx.callbackQuery;
        if (!query?.data?.startsWith("skip_reason_") || !query.message) return false;

        // The button names its moderator; another moderator's session holds no marker for it.
        if (query.data.split("_")[2] !== String(query.from.id)) {
            const locale = localeService.resolveUserLocale(await userRepository.findByUserId(String(query.from.id)));
            await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'notYourButton') });
            return true;
        }

        const hit = sessionKey(ctx) ? matchCallback<RejectSkipMarker>(ctx, { once: true }) : undefined;
        if (!hit) return false;

        await this.api.answerCallbackQuery({ callback_query_id: query.id });
        forgetReply(ctx, hit.promptId);
        this.dropPending(ctx, hit.promptId);
        await this.removeKeyboard(query.message.chat.id, query.message.message_id);
        await this.finishRejection(hit.postId, null, { id: query.from.id, username: query.from.username });
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
