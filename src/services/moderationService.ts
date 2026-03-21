import TelegramBot from "node-telegram-bot-api";
import { BotConfig, Locals } from "../types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { PostService } from "./postService";

export class ModerationService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private locals: Locals,
        private postService: PostService
    ) {}

    private get lang() {
        return this.config.lang;
    }

    async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.data) return;

        const isApprove = query.data.startsWith("approve_");
        const isReject = query.data.startsWith("reject_");
        if (!isApprove && !isReject) return;

        const postId = query.data.replace(/^(approve_|reject_)/, "");

        try {
            const isAdmin = await userRepository.isAdmin(String(query.from.id));
            if (!isAdmin) {
                this.bot.answerCallbackQuery(query.id, { text: this.locals[this.lang].notAdmin, show_alert: true });
                return;
            }

            const post = await postRepository.findById(postId);
            if (!post) {
                this.bot.answerCallbackQuery(query.id, { text: "Post not found" });
                return;
            }

            if (post.status !== "pending") {
                this.bot.answerCallbackQuery(query.id, { text: "Post already handled" });
                return;
            }

            const user = await userRepository.findByUserId(post.userId);
            if (!user) {
                this.bot.answerCallbackQuery(query.id, { text: "User not found" });
                return;
            }

            if (isApprove) {
                await this.handleApproval(query, postId, post, user);
            } else {
                await this.handleRejection(query, postId, post);
            }

            if (query.message) {
                const statusText = isApprove
                    ? this.locals[this.lang].statusApproved
                    : this.locals[this.lang].statusRejected;

                this.bot.editMessageText(statusText, {
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                });
            }
        } catch (err) {
            console.error("[ERROR - handleModerationCallback]", (err as Error).message);
            this.bot.answerCallbackQuery(query.id, { text: "Error processing" });
        }
    }

    private async handleApproval(query: TelegramBot.CallbackQuery, postId: string, post: any, user: any): Promise<void> {
        await postRepository.updateStatus(postId, "approved");

        const postText = this.postService.formatPostText({
            title: post.title,
            description: post.description,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(user.userId),
            username: user.userName || undefined,
            firstName: user.firstName || undefined,
        });

        const messageId = await this.postService.sendToApproved(postText, post.media);
        if (messageId) {
            await postRepository.setApprovedMessageId(postId, messageId);
        }

        this.bot.sendMessage(Number(post.userId), this.locals[this.lang].postApproved);
        this.bot.answerCallbackQuery(query.id, { text: "✅ Approved" });
    }

    private async handleRejection(query: TelegramBot.CallbackQuery, postId: string, post: any): Promise<void> {
        await postRepository.updateStatus(postId, "rejected");
        this.bot.answerCallbackQuery(query.id, { text: "❌ Rejected" });

        const reason = await this.askRejectReason(query);

        if (reason) {
            this.bot.sendMessage(Number(post.userId), this.locals[this.lang].postRejectedWithReason + reason);
        } else {
            this.bot.sendMessage(Number(post.userId), this.locals[this.lang].postRejected);
        }
    }

    askRejectReason(query: TelegramBot.CallbackQuery): Promise<string | null> {
        const chatId = query.message!.chat.id;
        const topicId = (query.message as any)?.message_thread_id;
        const adminId = query.from.id;

        const skipCallbackData = `skip_reason_${adminId}_${Date.now()}`;

        return new Promise(async (resolve) => {
            const sentMsg = await this.bot.sendMessage(chatId, this.locals[this.lang].rejectReasonPrompt, {
                ...(topicId ? { reply_to_message_id: topicId } : {}),
                reply_markup: {
                    inline_keyboard: [[
                        { text: this.locals[this.lang].skipReasonButton, callback_data: skipCallbackData },
                    ]],
                },
            } as any);

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
