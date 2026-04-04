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
            console.info('[INFO - ModerationService.handleCallback]', { adminId: query.from.id, data: query.data });

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
                console.warn("[WARN - ModerationService.handleCallback]", "Admin attempted to moderate own post", { adminId: query.from.id, postId });
                this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'adminError'), show_alert: true });
                return;
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

                this.bot.editMessageText(statusText, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                });
            }
        } catch (err) {
            console.error("[ERROR - ModerationService.handleCallback]", (err as Error).message);
            this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'adminError') });
        }
    }

    private async handleApproval(query: TelegramBot.CallbackQuery, postId: string, post: any, postAuthor: any, adminLocale: string): Promise<void> {
        await postRepository.updateStatus(postId, "approved");

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

        const authorLocale = localeService.resolveUserLocale(postAuthor);
        this.bot.sendMessage(Number(post.userId), localeService.t(authorLocale, 'postApproved'));
        this.bot.answerCallbackQuery(query.id, { text: localeService.t(adminLocale, 'adminApproved') });
    }

    private async handleRejection(query: TelegramBot.CallbackQuery, postId: string, post: any, postAuthor: any, adminLocale: string): Promise<void> {
        await postRepository.updateStatus(postId, "rejected");
        this.bot.answerCallbackQuery(query.id, { text: localeService.t(adminLocale, 'adminRejected') });

        const reason = await this.askRejectReason(query);

        const authorLocale = localeService.resolveUserLocale(postAuthor);

        if (reason) {
            this.bot.sendMessage(Number(post.userId), localeService.t(authorLocale, 'postRejectedWithReason') + reason);
        } else {
            this.bot.sendMessage(Number(post.userId), localeService.t(authorLocale, 'postRejected'));
        }
    }

    async askRejectReason(query: TelegramBot.CallbackQuery): Promise<string | null> {
        const chatId = query.message!.chat.id;
        const topicId = (query.message as any)?.message_thread_id;
        const adminId = query.from.id;

        const skipCallbackData = `skip_reason_${adminId}_${Date.now()}`;

        const sentMsg = await this.bot.sendMessage(chatId, localeService.t(this.config.lang, 'rejectReasonPrompt'), {
            ...(topicId ? { reply_to_message_id: topicId } : {}),
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(this.config.lang, 'skipReasonButton'), callback_data: skipCallbackData },
                ]],
            },
        } as any);

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
                if (topicId && (reply as any).message_thread_id !== topicId) return;
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
