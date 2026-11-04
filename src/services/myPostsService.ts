import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, InlineKeyboardButton, Message } from "node-telegram-bot-api/types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import listingRepository from "../repositories/listingRepository";
import { PostService } from "./postService";
import { localeService } from "./localeService";
import { isApiError } from "../config/telegramErrors";
import { BotConfig, Post, User } from "../types";

export class MyPostsService {
    constructor(
        private api: Api,
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

    private buildSummaryMessage(posts: Post[], locale: string): { text: string; buttons: InlineKeyboardButton[][] } {
        let text = localeService.t(locale, 'myPostsTitle') + "\n\n";

        const hasRejected = posts.some(p => p.status === 'rejected');
        const hasSold = posts.some(p => p.status === 'sold');

        const buttons: InlineKeyboardButton[][] = [[]]; //
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

    async showPosts(msg: Message): Promise<void> {
        const userId = String(msg.from!.id);
        const user: User | null = await userRepository.findByUserId(userId);
        const locale = localeService.resolveUserLocale(user); //
        const posts: Post[] = await postRepository.findByUserId(userId);

        if (!posts || posts.length === 0) {
            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'myPostsEmpty') });
            return;
        }

        const { text, buttons } = this.buildSummaryMessage(posts, locale);

        await this.api.sendMessage({
            chat_id: msg.chat.id,
            text,
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

    private async sendApprovedPostDetail(chatId: number, post: Post, user: User | null, locale: string): Promise<void> {
        // One Rich Message with the sold/bump buttons attached — no separate
        // follow-up message, so no button delay.
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
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

        await this.api.sendRichMessage({ chat_id: chatId, rich_message: richMessage, reply_markup: { inline_keyboard: buttons } });
    }

    private async refreshMessage(query: CallbackQuery): Promise<void> {
        if (!query.message) return;

        const user: User | null = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user); //
        const posts: Post[] = await postRepository.findByUserId(String(query.from.id));
        const { text, buttons } = this.buildSummaryMessage(posts, locale);

        await this.api.editMessageText({
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text,
            parse_mode: "HTML",
            reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
        });
    }

    async handleClearStatus(query: CallbackQuery, status: string): Promise<void> {
        const userId = String(query.from.id);
        const user: User | null = await userRepository.findByUserId(userId);
        const locale = localeService.resolveUserLocale(user); //

        const posts: Post[] = await postRepository.findByUserId(userId);
        const toDelete: Post[] = posts.filter(p => p.status === status);

        for (const post of toDelete) {
            await postRepository.deleteById(String(post._id));
        }

        const successKey = status === 'rejected' ? 'clearRejectedSuccess' : 'clearSoldSuccess';
        await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, successKey) });

        await this.refreshMessage(query);
    }

    // A moderator take-down leaves the post "approved" but off the market: no Bump, no Sold.
    private async refuseIfTakenDown(query: CallbackQuery, postId: string): Promise<boolean> {
        const listing = await listingRepository.findByPostId(postId);
        if (listing?.status !== "taken_down") return false;
        const user: User | null = await userRepository.findByUserId(String(query.from.id));
        await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(localeService.resolveUserLocale(user), 'postTakenDown'), show_alert: true });
        return true;
    }

    async handleSoldCallback(query: CallbackQuery): Promise<void> {
        const postId = query.data!.replace("sold_", "");
        const post: Post | null = await postRepository.findById(postId);

        if (!post || String(post.userId) !== String(query.from.id)) {
            const user: User | null = await userRepository.findByUserId(String(query.from.id));
            const locale = localeService.resolveUserLocale(user); //
            await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'postNotFound') });
            return;
        }

        if (await this.refuseIfTakenDown(query, postId)) return;

        await postRepository.updateStatus(postId, "sold");
        const user: User | null = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user); //
        await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'postMarkedSold') });

        const postUser = await userRepository.findByUserId(post.userId);
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(post.userId),
            username: postUser?.userName || undefined,
            firstName: postUser?.firstName || "User",
        }, { sold: true });

        // Edit the message in the approved group
        if (post.approvedMessageId) {
            await this.postService.markSoldInGroup(post.approvedMessageId, richMessage);
        }

        // The pressed card stays: re-render it as sold (photos kept), no buttons.
        // The /myposts summary is never touched by a card press.
        if (query.message) {
            try {
                await this.api.editMessageText({
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    rich_message: richMessage,
                    reply_markup: { inline_keyboard: [] },
                });
            } catch (err) {
                if (!isApiError(err, 400, "message is not modified")) {
                    console.error("[ERROR - handleSoldCallback]", (err as Error).message);
                }
            }
        }
    }

    private isSameDay(d1: Date, d2: Date): boolean {
        return d1.getFullYear() === d2.getFullYear()
            && d1.getMonth() === d2.getMonth()
            && d1.getDate() === d2.getDate();
    }

    async handleBumpCallback(query: CallbackQuery): Promise<void> {
        const postId = query.data!.replace("bump_", "");
        const post: Post | null = await postRepository.findById(postId);

        if (!post || String(post.userId) !== String(query.from.id)) {
            const user: User | null = await userRepository.findByUserId(String(query.from.id));
            const locale = localeService.resolveUserLocale(user); //
            await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'postNotFound') });
            return;
        }

        if (await this.refuseIfTakenDown(query, postId)) return;

        if (post.status !== "approved") {
            const user: User | null = await userRepository.findByUserId(String(query.from.id));
            const locale = localeService.resolveUserLocale(user); //
            await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'bumpNotApproved') });
            return;
        }

        // Reset counter if last bump was on a different day
        const now: Date = new Date();
        let bumpCount = post.dailyBumpCount || 0;
        if (post.lastBumpAt && this.isSameDay(new Date(post.lastBumpAt), now)) { //
            if (bumpCount >= this.config.dailyBumpLimit) {
                const user: User | null = await userRepository.findByUserId(String(query.from.id));
                const locale = localeService.resolveUserLocale(user); //
                await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'bumpLimitReached'), show_alert: true });
                return;
            }
        } else {
            bumpCount = 0;
        }

        // Answer callback immediately to avoid timeout
        const user: User | null = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user); //
        await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'bumpSuccess') });

        // Fetch user for formatting
        const postUser: User | null = await userRepository.findByUserId(post.userId);
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(post.userId),
            username: postUser?.userName || undefined,
            firstName: postUser?.firstName || "User",
        }, { showCta: true });

        const newMessageId = await this.postService.sendToApproved(richMessage);

        // Update bump tracking and store new message ID
        await postRepository.updateBump(postId, bumpCount + 1);
        if (newMessageId) {
            await postRepository.setApprovedMessageId(postId, newMessageId);
        }
    }
}
