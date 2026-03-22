import TelegramBot from "node-telegram-bot-api";
import { BotConfig, Locals } from "../types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { PostService } from "./postService";

export class MyPostsService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private locals: Locals,
        private postService: PostService
    ) {}

    private get lang() {
        return this.config.lang;
    }

    private statusLabel(status: string): string {
        const map: Record<string, string> = {
            pending: this.locals[this.lang].myPostsStatusPending,
            approved: this.locals[this.lang].myPostsStatusApproved,
            rejected: this.locals[this.lang].myPostsStatusRejected,
            sold: this.locals[this.lang].myPostsStatusSold,
        };
        return map[status] ?? status;
    }

    private buildPostsMessage(posts: any[]): { text: string; buttons: TelegramBot.InlineKeyboardButton[][] } {
        let text = this.locals[this.lang].myPostsTitle + "\n\n";
        const buttons: TelegramBot.InlineKeyboardButton[][] = [];

        for (const post of posts) {
            const status = this.statusLabel(post.status);
            text += `- <b>${post.title}</b>  |  ${post.price}  |  ${status}`;

            if (post.status === "approved") {
                const used = post.dailyBumpCount || 0;
                const limit = this.config.dailyBumpLimit;
                text += `  |  ${this.locals[this.lang].bumpsUsed}: ${used}/${limit}`;
                buttons.push([
                    { text: `${this.locals[this.lang].markSoldButton} — ${post.title}`, callback_data: `sold_${post._id}` },
                    { text: `${this.locals[this.lang].bumpButton} — ${post.title}`, callback_data: `bump_${post._id}` },
                ]);
            }

            text += "\n";
        }

        return { text, buttons };
    }

    async showPosts(msg: TelegramBot.Message): Promise<void> {
        const userId = String(msg.from!.id);
        const posts = await postRepository.findByUserId(userId);

        if (!posts || posts.length === 0) {
            await this.bot.sendMessage(msg.chat.id, this.locals[this.lang].myPostsEmpty);
            return;
        }

        const { text, buttons } = this.buildPostsMessage(posts);

        await this.bot.sendMessage(msg.chat.id, text, {
            parse_mode: "HTML",
            reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
        });
    }

    private async refreshMessage(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.message) return;

        const posts = await postRepository.findByUserId(String(query.from.id));
        const { text, buttons } = this.buildPostsMessage(posts);

        await this.bot.editMessageText(text, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
        });
    }

    async handleSoldCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const postId = query.data!.replace("sold_", "");
        const post = await postRepository.findById(postId);

        if (!post || String(post.userId) !== String(query.from.id)) {
            await this.bot.answerCallbackQuery(query.id, { text: this.locals[this.lang].postNotFound });
            return;
        }

        await postRepository.updateStatus(postId, "sold");
        await this.bot.answerCallbackQuery(query.id, { text: this.locals[this.lang].postMarkedSold });
        await this.refreshMessage(query);
    }

    private isSameDay(d1: Date, d2: Date): boolean {
        return d1.getFullYear() === d2.getFullYear()
            && d1.getMonth() === d2.getMonth()
            && d1.getDate() === d2.getDate();
    }

    async handleBumpCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const postId = query.data!.replace("bump_", "");
        const post = await postRepository.findById(postId);

        if (!post || String(post.userId) !== String(query.from.id)) {
            await this.bot.answerCallbackQuery(query.id, { text: this.locals[this.lang].postNotFound });
            return;
        }

        if (post.status !== "approved") {
            await this.bot.answerCallbackQuery(query.id, { text: this.locals[this.lang].bumpNotApproved });
            return;
        }

        // Reset counter if last bump was on a different day
        const now = new Date();
        let bumpCount = post.dailyBumpCount || 0;
        if (post.lastBumpAt && this.isSameDay(new Date(post.lastBumpAt), now)) {
            if (bumpCount >= this.config.dailyBumpLimit) {
                await this.bot.answerCallbackQuery(query.id, { text: this.locals[this.lang].bumpLimitReached, show_alert: true });
                return;
            }
        } else {
            bumpCount = 0;
        }

        // Answer callback immediately to avoid timeout
        await this.bot.answerCallbackQuery(query.id, { text: this.locals[this.lang].bumpSuccess });

        // Fetch user for formatting
        const user = await userRepository.findByUserId(post.userId);
        const postText = this.postService.formatPostText({
            title: post.title,
            description: post.description,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(post.userId),
            username: user?.userName || undefined,
            firstName: user?.firstName || "User",
        });

        await this.postService.sendToApproved(postText, post.media);

        // Update bump tracking
        await postRepository.updateBump(postId, bumpCount + 1);

        await this.refreshMessage(query);
    }
}
