import TelegramBot from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { BotConfig } from "../types";
import { PostService } from "./postService";
import { MediaService } from "./photoService";
import { localeService } from "./localeService";

export class PendingService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private postService: PostService,
        private mediaService: MediaService
    ) { }

    async handlePending(msg: TelegramBot.Message): Promise<void> {
        console.info('[INFO - pendingService.handlePending]', { userId: msg.from?.id, chatId: msg.chat.id });
        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);

        try {

            const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
            if (!isAdmin) {
                console.warn('[WARN - PendingService.handlePending] non-admin attempted access', { userId: msg.from?.id });
                await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
                return;
            }

            const pendingPosts = await postRepository.getPendingPosts();

            if (!pendingPosts || pendingPosts.length === 0) {
                console.info('[INFO - handlePending] no pending posts available');
                await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'adminPendingEmpty'));
                return;
            }

            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'adminPendingTitle'), { parse_mode: "HTML" });

            // Limit display to avoid hitting Telegram message size limits
            const displayPosts = pendingPosts.slice(0, 10);

            for (const post of displayPosts) {
                const user = await userRepository.findByUserId(post.userId);

                const postTextBody = this.postService.formatPostText({
                    title: post.title,
                    description: post.description,
                    price: post.price,
                    location: post.location,
                    media: post.media,
                    userId: Number(post.userId),
                    username: user?.userName || undefined,
                    firstName: user?.firstName || "Unknown",
                });

                const chatIdStr = this.config.moderationGroupId.toString().replace(/^-100/, "");
                const link = post.moderationMessageId
                    ? `\n<a href="https://t.me/c/${chatIdStr}/${post.moderationMessageId}">${localeService.t(locale, 'adminPendingLink')}</a>`
                    : "";
                const postText = postTextBody + link;

                const replyMarkup = {
                    inline_keyboard: [[
                        { text: localeService.t(locale, 'approveButton'), callback_data: `approve_${post._id}` },
                        { text: localeService.t(locale, 'rejectButton'), callback_data: `reject_${post._id}` }
                    ]]
                };

                if (post.media && post.media.length > 0) {
                    const group = this.mediaService.buildMediaGroup(post.media, postText);
                    await this.bot.sendMediaGroup(msg.chat.id, group);
                    // Buttons cannot be attached to a media group, so we send them in a separate message
                    await this.bot.sendMessage(msg.chat.id, "👇", {
                        reply_markup: replyMarkup
                    });
                } else {
                    await this.bot.sendMessage(msg.chat.id, postText, {
                        parse_mode: "HTML",
                        disable_web_page_preview: true,
                        reply_markup: replyMarkup
                    });
                }
            }

            if (pendingPosts.length > 10) {
                await this.bot.sendMessage(msg.chat.id, `...and ${pendingPosts.length - 10} more.`);
            }
        } catch (err) {
            console.error("[ERROR - PendingService.handlePending]", err);
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'adminError'));
        }
    }

    async handleClearPending(msg: TelegramBot.Message): Promise<void> {
        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);

        try {

            const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
            if (!isAdmin) {
                await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
                return;
            }

            await postRepository.expireAllPendingPosts();

            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'adminClearPendingSuccess'));
        } catch (err) {
            console.error("[ERROR - PendingService.handleClearPending]", err);
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'adminError'));
        }
    }
}
