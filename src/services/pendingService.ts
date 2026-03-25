import TelegramBot from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { BotConfig, Locals } from "../types";
import { PostService } from "./postService";
import { MediaService } from "./photoService";

export class PendingService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private locals: Locals,
        private postService: PostService,
        private mediaService: MediaService
    ) { }

    async handlePending(msg: TelegramBot.Message): Promise<void> {
        try {
            const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
            if (!isAdmin) {
                await this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].notAdmin);
                return;
            }

            const pendingPosts = await postRepository.getPendingPosts();

            if (!pendingPosts || pendingPosts.length === 0) {
                await this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].adminPendingEmpty);
                return;
            }

            await this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].adminPendingTitle, { parse_mode: "HTML" });

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
                    ? `\n<a href="https://t.me/c/${chatIdStr}/${post.moderationMessageId}">${this.locals[this.config.lang].adminPendingLink}</a>`
                    : "";
                const postText = postTextBody + link;

                const replyMarkup = {
                    inline_keyboard: [[
                        { text: this.locals[this.config.lang].approveButton, callback_data: `approve_${post._id}` },
                        { text: this.locals[this.config.lang].rejectButton, callback_data: `reject_${post._id}` }
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
            console.error("[ERROR - handlePending]", err);
            await this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].adminError);
        }
    }

    async handleClearPending(msg: TelegramBot.Message): Promise<void> {
        try {
            const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
            if (!isAdmin) {
                await this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].notAdmin);
                return;
            }

            await postRepository.expireAllPendingPosts();

            await this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].adminClearPendingSuccess);
        } catch (err) {
            console.error("[ERROR - handleClearPending]", err);
            await this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].adminError);
        }
    }
}
