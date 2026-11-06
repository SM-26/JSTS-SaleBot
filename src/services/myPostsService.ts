import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, InlineKeyboardButton, Message } from "node-telegram-bot-api/types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import { PostService } from "./postService";
import { GroupListingService } from "./groupListingService";
import { LifecycleService } from "./lifecycleService";
import { localeService } from "./localeService";
import { buildEndedCard, buildManagementCard, Card, lifecycleActionData } from "./listingCards";
import { safeTrustLine } from "./trustService";
import { meetupLocationText } from "./meetup";
import { isApiError } from "../config/telegramErrors";
import { BotConfig, Post, User } from "../types";

export class MyPostsService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private postService: PostService,
        private groupListings: GroupListingService,
        private lifecycle: LifecycleService
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
        try {
            await this.sendPosts(msg);
        } finally {
            await this.sendRelistSection(msg);
        }
    }

    // Expired bot listings, one Relist row each (expired group listings already have a 🔄 in the group section).
    private async sendRelistSection(msg: Message): Promise<void> {
        const userId = String(msg.from!.id);
        const expired = await listingRepository.findSellerExpired(userId, 10);
        if (!expired.length) return;
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        await this.api.sendMessage({
            chat_id: msg.chat.id,
            text: localeService.t(locale, 'endedSectionTitle'),
            reply_markup: { inline_keyboard: expired.map((l) => [{ text: localeService.t(locale, 'relistButton', { title: l.title ?? "" }), callback_data: lifecycleActionData(String(l._id), "r") }]) },
        });
    }

    private async sendPosts(msg: Message): Promise<void> {
        const userId = String(msg.from!.id);
        const user: User | null = await userRepository.findByUserId(userId);
        const locale = localeService.resolveUserLocale(user); //
        const posts: Post[] = await postRepository.findByUserId(userId);

        const section = await this.groupListings.renderGroupSection(userId, locale);
        const sectionExtra = section ? {
            parse_mode: "HTML" as const,
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: section.card.keyboard },
        } : undefined;

        if (!posts || posts.length === 0) {
            if (section?.hasListings) {
                await this.api.sendMessage({ chat_id: msg.chat.id, text: section.card.text, ...sectionExtra });
            } else {
                await this.api.sendMessage({
                    chat_id: msg.chat.id,
                    text: localeService.t(locale, 'myPostsEmpty'),
                    ...(section ? { reply_markup: sectionExtra!.reply_markup } : {}),
                });
            }
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
                try {
                    await this.sendApprovedPostDetail(msg.chat.id, post, user, locale);
                } catch (err) {
                    console.error(`[ERROR - sendPosts] post ${post._id}`, (err as Error).message);
                }
            }
        }

        if (section) await this.api.sendMessage({ chat_id: msg.chat.id, text: section.card.text, ...sectionExtra });
    }

    /** mk_set_ask / mk_set_never: flips the capture-note setting and re-renders the pressed message. */
    async handleAskToggle(query: CallbackQuery, arg: string, now = new Date()): Promise<void> {
        const userId = String(query.from.id);
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        const mode = arg === "set_ask" ? "ask" : arg === "set_never" ? "never" : null;
        if (!mode) {
            await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'staleButton') });
            return;
        }
        await memberRepository.setAskMode(userId, mode, now);
        await this.api.answerCallbackQuery({ callback_query_id: query.id });
        if (query.message) await this.groupListings.editSection(query.message.chat.id, query.message.message_id, userId, locale);
    }

    /** /start l_<listingId>: the seller's own card for one listing (no Remove on a bot post). */
    async showListingCard(msg: Message, listingId: string): Promise<void> {
        const userId = String(msg.from!.id);
        const user: User | null = await userRepository.findByUserId(userId);
        const locale = localeService.resolveUserLocale(user);
        const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
        const sendCard = (card: Card) => this.api.sendMessage({
            chat_id: msg.chat.id,
            text: card.text,
            ...(card.keyboard.length ? { reply_markup: { inline_keyboard: card.keyboard } } : {}),
        });

        const listing = /^[0-9a-f]{24}$/.test(listingId) ? await listingRepository.findById(listingId) : null;
        if (!listing || listing.sellerId !== userId) {
            await this.api.sendMessage({ chat_id: msg.chat.id, text: t("postNotFound") });
            return;
        }
        const active = listing.status === "live" || listing.status === "expired";
        if (listing.source === "group") {
            if (!active) {
                await sendCard(buildEndedCard(t, listing));
                return;
            }
            const card = buildManagementCard(t, listing, { surface: "c" });
            const trustLine = await safeTrustLine(userId, locale, "showListingCard");
            await sendCard(trustLine ? { ...card, text: `${card.text}\n${trustLine}` } : card);
            return;
        }
        if (listing.status === "expired") {
            const card = buildEndedCard(t, listing);
            await sendCard({ ...card, keyboard: [[{ text: t("relistButton", { title: listing.title ?? "" }), callback_data: lifecycleActionData(String(listing._id), "r") }]] });
            return;
        }
        const post = listing.status === "live" && listing.postId ? await postRepository.findById(listing.postId) : null;
        if (post?.status === "approved") await this.sendApprovedPostDetail(msg.chat.id, post, user, locale);
        else await sendCard(buildEndedCard(t, listing));
    }

    async sendApprovedPostDetail(chatId: number, post: Post, user: User | null, locale: string): Promise<void> {
        // One Rich Message with the sold/bump buttons attached — no separate
        // follow-up message, so no button delay.
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
            price: post.price,
            location: post.location,
            meetup: post.meetup,
            media: post.media,
            userId: Number(post.userId),
            username: user?.userName || undefined,
            firstName: user?.firstName || "User",
        }, { trustLine: await safeTrustLine(post.userId, locale, "sendApprovedPostDetail") });

        const buttons = [[
            { text: localeService.t(locale, 'markSoldButton'), callback_data: `sold_${post._id}` },
            { text: localeService.t(locale, 'bumpButton'), callback_data: `bump_${post._id}` },
        ]];

        try {
            await this.api.sendRichMessage({ chat_id: chatId, rich_message: richMessage, reply_markup: { inline_keyboard: buttons } });
        } catch (err) {
            // A photo Telegram refuses must not cost the seller the buttons: the same post as plain text.
            console.error(`[ERROR - sendApprovedPostDetail] post ${post._id}`, (err as Error).message);
            const location = post.meetup ? meetupLocationText(post.location, localeService.t(locale, 'meetupPlace')) : post.location;
            const text = [post.title, post.description, `💰 ${post.price}`, location ? `📍 ${location}` : ""].filter(Boolean).join("\n");
            await this.api.sendMessage({ chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } });
        }
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

        const richMessage = await this.postService.setPostSold(post);
        // Best-effort: Sold also ends the listing, so a moderator's take-down finds nothing to remove.
        try {
            await this.lifecycle.syncSoldForPost(postId, new Date());
        } catch (err) {
            console.error(`[ERROR - handleSoldCallback] post ${postId}`, (err as Error).message);
        }
        const user: User | null = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user); //
        await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'postMarkedSold') });
        if (post.approvedMessageId) await this.postService.markSoldInGroup(post.approvedMessageId, richMessage);

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
        const trustLine = await safeTrustLine(post.userId, this.config.lang, "handleBumpCallback");
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
            price: post.price,
            location: post.location,
            meetup: post.meetup,
            media: post.media,
            userId: Number(post.userId),
            username: postUser?.userName || undefined,
            firstName: postUser?.firstName || "User",
        }, { showCta: true, trustLine });

        const newMessageId = await this.postService.sendToApproved(richMessage);

        // Update bump tracking and store new message ID
        await postRepository.updateBump(postId, bumpCount + 1);
        if (newMessageId) {
            await postRepository.setApprovedMessageId(postId, newMessageId);
        }
        try {
            await this.lifecycle.refreshForPost(postId, new Date());
        } catch (err) {
            console.error(`[ERROR - handleBumpCallback] post ${postId}`, (err as Error).message);
        }
    }
}
