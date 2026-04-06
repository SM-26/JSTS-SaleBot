import TelegramBot from "node-telegram-bot-api";
import { BotConfig } from "../types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { PostService } from "./postService";
import { localeService } from "./localeService";

export class ModerationService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private postService: PostService
    ) { }

    private get lang() {
        return this.config.lang;
    }

    async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.data) return;

        const isApprove = query.data.startsWith("approve_");
        const isReject = query.data.startsWith("reject_");
        if (!isApprove && !isReject) return;

        const postId = query.data.replace(/^(approve_|reject_)/, "");

        const adminUser = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(adminUser);

        try {
            console.debug('[DEBUG - ModerationService.handleCallback]', { adminId: query.from.id, data: query.data });

            const isAdmin = await userRepository.isAdmin(String(query.from.id));
            if (!isAdmin) {
                this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'notAdmin'), show_alert: true });
                return;
            }

            const post = await postRepository.findById(postId);
            if (!post) {
                this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'adminPostNotFound') });
                return;
            }

            if (String(post.userId) === String(query.from.id)) {
                console.warn("[WARN - ModerationService.handleCallback]", "Admin is moderating their own post", { adminId: query.from.id, postId });
            }

            if (post.status !== "pending") {
                this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'adminPostHandled') });
                return;
            }

            const postAuthor = await userRepository.findByUserId(post.userId);
            if (!postAuthor) {
                this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'adminUserNotFound') });
                return;
            }

            if (isApprove) {
                await this.handleApproval(query, postId, post, postAuthor, locale);
            } else {
                await this.handleRejection(query, postId, post, postAuthor, locale);
            }

            if (query.message) {
                const statusText = isApprove
                    ? localeService.t(locale, 'statusApproved')
                    : localeService.t(locale, 'statusRejected');

                const topicId = (query.message as any)?.message_thread_id;

                this.bot.editMessageText(statusText, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id
                });
            }
        } catch (err) {
            console.error("[ERROR - ModerationService.handleCallback]", (err as Error).message);
            this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'adminError') });
        }
    }

    private async handleApproval(query: TelegramBot.CallbackQuery, postId: string, post: any, postAuthor: any, adminLocale: string): Promise<void> {
        const postText = this.postService.formatPostText({
            title: post.title,
            description: post.description,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(postAuthor.userId),
            username: postAuthor.userName || undefined,
            firstName: postAuthor.firstName || undefined,
        });

        const messageId = await this.postService.sendToApproved(postText, post.media);
        if (messageId) {
            await postRepository.setApprovedMessageId(postId, messageId);
        }

        // Only update status in DB after successful Telegram post
        await postRepository.updateStatus(postId, "approved");

        const authorLocale = localeService.resolveUserLocale(postAuthor);
        this.bot.sendMessage(Number(post.userId), localeService.t(authorLocale, 'postApproved'));
        this.bot.answerCallbackQuery(query.id, { text: localeService.t(adminLocale, 'adminApproved') });

        console.info('[INFO - ModerationService.handleApproval]', {
            action: 'APPROVED',
            postId,
            postTitle: post.title,
            admin: { id: query.from.id, username: query.from.username },
            author: { id: post.userId, username: postAuthor.userName, firstName: postAuthor.firstName }
        });
    }

    private async handleRejection(query: TelegramBot.CallbackQuery, postId: string, post: any, postAuthor: any, adminLocale: string): Promise<void> {
        this.bot.answerCallbackQuery(query.id, { text: localeService.t(adminLocale, 'adminRejected') });

        const reason = await this.askRejectReason(query);

        // Only update status in DB after reason is handled
        await postRepository.updateStatus(postId, "rejected");

        const authorLocale = localeService.resolveUserLocale(postAuthor);

        if (reason) {
            this.bot.sendMessage(Number(post.userId), localeService.t(authorLocale, 'postRejectedWithReason') + reason);
        } else {
            this.bot.sendMessage(Number(post.userId), localeService.t(authorLocale, 'postRejected'));
        }

        const actionLabel = reason ? 'REJECTED_WITH_REASON' : 'REJECTED_WITHOUT_REASON';
        console.info('[INFO - ModerationService.handleRejection]', {
            action: actionLabel,
            postId,
            postTitle: post.title,
            reason: reason || 'N/A',
            admin: { id: query.from.id, username: query.from.username },
            author: { id: post.userId, username: postAuthor.userName, firstName: postAuthor.firstName }
        });
    }

    async askRejectReason(query: TelegramBot.CallbackQuery): Promise<string | null> {
        const chatId = query.message!.chat.id;
        const topicId = (query.message as any)?.message_thread_id;
        const adminId = query.from.id;

        const skipCallbackData = `skip_reason_${adminId}_${Date.now()}`;

        const options: any = {
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(this.config.lang, 'skipReasonButton'), callback_data: skipCallbackData },
                ]],
            },
        };

        if (topicId && Number(topicId) !== 1) {
            options.message_thread_id = Number(topicId);
        }

        const sentMsg = await this.bot.sendMessage(chatId, localeService.t(this.config.lang, 'rejectReasonPrompt'), options);

        return new Promise((resolve) => {
            const cbListener = (cb: TelegramBot.CallbackQuery) => {
                if (cb.from.id !== adminId) return;
                if (cb.data !== skipCallbackData) return;

                this.bot.removeListener("callback_query", cbListener);
                this.bot.removeListener("message", msgListener);
                this.bot.answerCallbackQuery(cb.id);
                this.bot.editMessageReplyMarkup(
                    { inline_keyboard: [] },
                    { chat_id: chatId, message_id: sentMsg.message_id }
                );
                resolve(null);
            };

            const msgListener = (reply: TelegramBot.Message) => {
                if (reply.chat.id !== chatId || reply.from!.id !== adminId) return;
                if (topicId && Number(topicId) !== 1 && (reply as any).message_thread_id !== topicId) return;
                if (reply.text && reply.text.startsWith("/")) return;

                this.bot.removeListener("callback_query", cbListener);
                this.bot.removeListener("message", msgListener);
                this.bot.editMessageReplyMarkup(
                    { inline_keyboard: [] },
                    { chat_id: chatId, message_id: sentMsg.message_id }
                );
                resolve(reply.text || null);
            };

            this.bot.on("callback_query", cbListener);
            this.bot.on("message", msgListener);
        });
    }
}
