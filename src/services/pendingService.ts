import type { Api } from "node-telegram-bot-api";
import type { Message, SendRichMessageParams } from "node-telegram-bot-api/types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { AuthLevel, BotConfig, SendMessageOptions } from "../types";
import { PostService } from "./postService";
import { localeService } from "./localeService";

export class PendingService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private postService: PostService
    ) { }

    async handlePending(msg: Message): Promise<void> {
        console.debug('[DEBUG - pendingService.handlePending]', { userId: msg.from?.id, name: msg.from?.username, chatId: msg.chat.id });
        const user = await userRepository.findByUserId(String(msg.from!.id));
        console.debug(`[DEBUG - handlePending] Resolving locale for admin/mod: ${msg.from?.id}`);
        const locale = localeService.resolveUserLocale(user);

        const targetThreadId = msg.chat.id === this.config.moderationGroupId
            ? this.config.moderationTopicId
            : msg.message_thread_id;

        const options: SendMessageOptions = { parse_mode: "HTML" };
        if (targetThreadId && Number(targetThreadId) !== 1) {
            options.message_thread_id = Number(targetThreadId);
        }

        try {
            const isAuthorized = await userRepository.hasAuthLevel(String(msg.from!.id), AuthLevel.MOD);
            if (!isAuthorized) {
                console.warn('[WARN - PendingService.handlePending] non-admin attempted access', { userId: msg.from?.id });
                await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'notAdmin'), ...options });
                return;
            }

            const pendingPosts = await postRepository.getPendingPosts();

            if (!pendingPosts || pendingPosts.length === 0) {
                console.info('[INFO - handlePending] no pending posts available');
                await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'adminPendingEmpty'), ...options });
                return;
            }

            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'adminPendingTitle'), ...options });

            // Limit display to avoid hitting Telegram message size limits
            const displayPosts = pendingPosts.slice(0, 10);

            for (const post of displayPosts) {
                const user = await userRepository.findByUserId(post.userId);

                const chatIdStr = this.config.moderationGroupId.toString().replace(/^-100/, "");
                const richMessage = this.postService.formatPostRichMessage({
                    title: post.title,
                    description: post.description,
                    descriptionEntities: post.descriptionEntities,
                    price: post.price,
                    location: post.location,
                    meetup: post.meetup,
                    highlight: post.highlight,
                    media: post.media,
                    userId: Number(post.userId),
                    username: user?.userName || undefined,
                    firstName: user?.firstName || "Unknown",
                }, post.moderationMessageId ? {
                    link: {
                        label: localeService.t(locale, 'adminPendingLink'),
                        url: `https://t.me/c/${chatIdStr}/${post.moderationMessageId}`,
                    },
                } : {});

                // One Rich Message with the approve/reject buttons attached — a media
                // group can't carry buttons, which is what forced the old extra "👇".
                const richOptions: Pick<SendRichMessageParams, "message_thread_id" | "reply_markup"> = {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: localeService.t(locale, 'approveButton'), callback_data: `approve_${post._id}` },
                            { text: localeService.t(locale, 'rejectButton'), callback_data: `reject_${post._id}` }
                        ]]
                    }
                };
                if (targetThreadId && Number(targetThreadId) !== 1) {
                    richOptions.message_thread_id = Number(targetThreadId);
                }

                try {
                    await this.api.sendRichMessage({ chat_id: msg.chat.id, rich_message: richMessage, ...richOptions });
                } catch (err) {
                    // One photo Telegram refuses must not hide the rest of the queue: this post goes as plain text.
                    console.error(`[ERROR - PendingService.handlePending] post ${post._id}`, (err as Error).message);
                    const text = [post.title, post.description, `💰 ${post.price}`].filter(Boolean).join("\n");
                    await this.api.sendMessage({ chat_id: msg.chat.id, text, ...richOptions });
                }
            }

            if (pendingPosts.length > 10) {
                await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'pendingMore', { n: pendingPosts.length - 10 }), ...options });
            }
        } catch (err) {
            console.error("[ERROR - PendingService.handlePending]", err);
            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'adminError'), message_thread_id: targetThreadId });
        }
    }

    async handleClearPending(msg: Message): Promise<void> {
        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);

        try {

            const isAuthorized = await userRepository.hasAuthLevel(String(msg.from!.id), AuthLevel.MOD);
            if (!isAuthorized) {
                await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'notAdmin') });
                return;
            }

            await postRepository.expireAllPendingPosts();

            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'adminClearPendingSuccess') });
        } catch (err) {
            console.error("[ERROR - PendingService.handleClearPending]", err);
            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'adminError') });
        }
    }
}
