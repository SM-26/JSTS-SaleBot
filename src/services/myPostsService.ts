import TelegramBot from "node-telegram-bot-api";
import { BotConfig } from "../types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { PostService } from "./postService";
import { localeService } from "./localeService";

export class MyPostsService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private postService: PostService
    ) { }

    private get lang() {
        return this.config.lang;
    }

    private statusLabel(status: string, locale: string): string {
        const map: Record<string, string> = {
            pending: localeService.t(locale, 'myPostsStatusPending'),
            approved: localeService.t(locale, 'myPostsStatusApproved'),
            rejected: localeService.t(locale, 'myPostsStatusRejected'),
            sold: localeService.t(locale, 'myPostsStatusSold'),
        };
        return map[status] ?? status;
    }

    private buildSummaryMessage(posts: any[], locale: string): { text: string; buttons: TelegramBot.InlineKeyboardButton[][] } {
        let text = localeService.t(locale, 'myPostsTitle') + "\n\n";

        const hasRejected = posts.some(p => p.status === 'rejected');
        const hasSold = posts.some(p => p.status === 'sold');

        const buttons: TelegramBot.InlineKeyboardButton[][] = [[]];
        if (hasRejected) buttons[0].push({ text: localeService.t(locale, 'clearRejectedButton'), callback_data: 'clear_rejected' });
        if (hasSold) buttons[0].push({ text: localeService.t(locale, 'clearSoldButton'), callback_data: 'clear_sold' });

        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            const status = this.statusLabel(post.status, locale);
            const latest = i === 0 ? `  [${localeService.t(locale, 'latestPostTag')}]` : "";
            text += `- <b>${post.title}</b>  |  ${post.price}  |  ${status}${latest}`;

            if (post.status === "approved") {
                const used = post.dailyBumpCount || 0;
                const limit = this.config.dailyBumpLimit;
                text += `  |  ${localeService.t(locale, 'bumpsUsed')}: ${used}/${limit}`;
            }
            text += "\n";
        }

        return { text, buttons };
    }

    async showPosts(msg: TelegramBot.Message): Promise<void> {
        const userId = String(msg.from!.id);
        const user = await userRepository.findByUserId(userId);
        const locale = localeService.resolveUserLocale(user);
        const posts = await postRepository.findByUserId(userId);

        if (!posts || posts.length === 0) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'myPostsEmpty'));
            return;
        }

        const { text, buttons } = this.buildSummaryMessage(posts, locale);

        await this.bot.sendMessage(msg.chat.id, text, {
            parse_mode: "HTML",
            reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
        });

        // Show full details for approved posts
        for (const post of posts) {
            if (post.status === "approved") {
                await this.sendApprovedPostDetail(msg.chat.id, post, user, locale);
            }
        }
    }

    private async sendApprovedPostDetail(chatId: number, post: any, user: any, locale: string): Promise<void> {
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

        const buttons = [[
            { text: localeService.t(locale, 'markSoldButton'), callback_data: `sold_${post._id}` },
            { text: localeService.t(locale, 'bumpButton'), callback_data: `bump_${post._id}` },
        ]];

        if (post.media && post.media.length > 0) {
            const group = (this.postService as any).mediaService.buildMediaGroup(post.media, postText);
            await this.bot.sendMediaGroup(chatId, group);
            await this.bot.sendMessage(chatId, "👇", { reply_markup: { inline_keyboard: buttons } });
        } else {
            await this.bot.sendMessage(chatId, postText, { parse_mode: "HTML", reply_markup: { inline_keyboard: buttons } });
        }
    }

    private async refreshMessage(query: TelegramBot.CallbackQuery): Promise<void> {
        if (!query.message) return;

        const user = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user);
        const posts = await postRepository.findByUserId(String(query.from.id));
        const { text, buttons } = this.buildSummaryMessage(posts, locale);

        await this.bot.editMessageText(text, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
        });
    }

    async handleClearStatus(query: TelegramBot.CallbackQuery, status: string): Promise<void> {
        const userId = String(query.from.id);
        const user = await userRepository.findByUserId(userId);
        const locale = localeService.resolveUserLocale(user);

        const posts = await postRepository.findByUserId(userId);
        const toDelete = posts.filter(p => p.status === status);

        for (const post of toDelete) {
            await postRepository.deleteById(String(post._id));
        }

        const successKey = status === 'rejected' ? 'clearRejectedSuccess' : 'clearSoldSuccess';
        await this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, successKey) });

        await this.refreshMessage(query);
    }

    async handleSoldCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const postId = query.data!.replace("sold_", "");
        const post = await postRepository.findById(postId);

        if (!post || String(post.userId) !== String(query.from.id)) {
            const user = await userRepository.findByUserId(String(query.from.id));
            const locale = localeService.resolveUserLocale(user);
            await this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'postNotFound') });
            return;
        }

        await postRepository.updateStatus(postId, "sold");
        const user = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user);
        await this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'postMarkedSold') });

        // Edit the message in the approved group
        if (post.approvedMessageId) {
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
            const soldText = postText + localeService.t(this.config.lang, 'soldTag');
            await this.postService.markSoldInGroup(post.approvedMessageId, soldText, post.media.length > 0);
        }

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
            const user = await userRepository.findByUserId(String(query.from.id));
            const locale = localeService.resolveUserLocale(user);
            await this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'postNotFound') });
            return;
        }

        if (post.status !== "approved") {
            const user = await userRepository.findByUserId(String(query.from.id));
            const locale = localeService.resolveUserLocale(user);
            await this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'bumpNotApproved') });
            return;
        }

        // Reset counter if last bump was on a different day
        const now = new Date();
        let bumpCount = post.dailyBumpCount || 0;
        if (post.lastBumpAt && this.isSameDay(new Date(post.lastBumpAt), now)) {
            if (bumpCount >= this.config.dailyBumpLimit) {
                const user = await userRepository.findByUserId(String(query.from.id));
                const locale = localeService.resolveUserLocale(user);
                await this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'bumpLimitReached'), show_alert: true });
                return;
            }
        } else {
            bumpCount = 0;
        }

        // Answer callback immediately to avoid timeout
        const user = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user);
        await this.bot.answerCallbackQuery(query.id, { text: localeService.t(locale, 'bumpSuccess') });

        // Fetch user for formatting
        const postUser = await userRepository.findByUserId(post.userId);
        const postText = this.postService.formatPostText({
            title: post.title,
            description: post.description,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(post.userId),
            username: postUser?.userName || undefined,
            firstName: postUser?.firstName || "User",
        });

        const newMessageId = await this.postService.sendToApproved(postText, post.media);

        // Update bump tracking and store new message ID
        await postRepository.updateBump(postId, bumpCount + 1);
        if (newMessageId) {
            await postRepository.setApprovedMessageId(postId, newMessageId);
        }

        await this.refreshMessage(query);
    }
}
