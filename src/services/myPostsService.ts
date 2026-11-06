import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, InlineKeyboardButton, Message } from "node-telegram-bot-api/types";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import { PostService } from "./postService";
import { priceNumber } from "./inputService";
import { GroupListingService } from "./groupListingService";
import { LifecycleService } from "./lifecycleService";
import { localeService } from "./localeService";
import { buildEndedCard, buildManagementCard, Card, lifecycleActionData } from "./listingCards";
import { safeTrustLine, sellerLayout } from "./trustService";
import { meetupLocationText } from "./meetup";
import { isApiError } from "../config/telegramErrors";
import { BotConfig, Post, User, UserSession } from "../types";

// A Change price prompt stops waiting after this long.
const PRICE_CUT_WINDOW_MS = 30 * 60_000;

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
            previousPrice: post.previousPrice,
            location: post.location,
            meetup: post.meetup,
            highlight: post.highlight,
            media: post.media,
            userId: Number(post.userId),
            username: user?.userName || undefined,
            firstName: user?.firstName || "User",
        }, await sellerLayout(post.userId, locale, "sendApprovedPostDetail", post.layoutTier));

        // No Change price on an expired or taken-down listing.
        const listingStatus = (await listingRepository.findByPostId(String(post._id)))?.status;
        const buttons = this.approvedKeyboard(post, locale, listingStatus !== "expired" && listingStatus !== "taken_down");

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

    // Sold + Bump (+ Change price). At dailyBumpLimit the Bump button is Telegram's disabled type: a press never reaches the bot.
    private approvedKeyboard(post: Post, locale: string, canChangePrice: boolean, now = new Date()): InlineKeyboardButton[][] {
        const t = (key: string) => localeService.t(locale, key);
        const full = this.atBumpLimit(post, now);
        return [
            [
                { text: t('markSoldButton'), callback_data: `sold_${post._id}` },
                full ? { text: t('bumpLimitButton'), disabled: {} } : { text: t('bumpButton'), callback_data: `bump_${post._id}` },
            ],
            // Changing the price stays live at the limit: a cut is not a counted bump.
            ...(canChangePrice ? [[{ text: t('priceChangeButton'), callback_data: `lp_${post._id}` }]] : []),
        ];
    }

    // After a bump that used the last one of the day, the pressed card swaps its live buttons for disabled ones (best effort).
    private async disableAtLimit(chatId: number | undefined, messageId: number | undefined, post: Post, bumpCount: number, locale: string, now: Date): Promise<void> {
        if (chatId === undefined || messageId === undefined || bumpCount < this.config.dailyBumpLimit) return;
        try {
            await this.api.editMessageReplyMarkup({
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: this.approvedKeyboard({ _id: post._id, lastBumpAt: now, dailyBumpCount: bumpCount } as Post, locale, true, now) },
            });
        } catch (err) {
            if (!isApiError(err, 400, "message is not modified")) console.error("[ERROR - disableAtLimit]", (err as Error).message);
        }
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

    // Bumps used today: the counter resets when the last bump was on another day.
    private bumpsToday(post: Post, now: Date): number {
        return post.lastBumpAt && this.isSameDay(new Date(post.lastBumpAt), now) ? (post.dailyBumpCount || 0) : 0;
    }

    private atBumpLimit(post: Post, now: Date): boolean {
        return Boolean(post.lastBumpAt && this.isSameDay(new Date(post.lastBumpAt), now)) && (post.dailyBumpCount || 0) >= this.config.dailyBumpLimit;
    }

    // Posts the card to the approved group again (a bump); `over` carries a price cut that is not stored yet.
    private async rePost(post: Post, over: { price?: string; previousPrice?: string | null } = {}): Promise<number | null> {
        const postUser: User | null = await userRepository.findByUserId(post.userId);
        const layout = await sellerLayout(post.userId, this.config.lang, "rePost", post.layoutTier);
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
            price: over.price ?? post.price,
            previousPrice: ("previousPrice" in over ? over.previousPrice : post.previousPrice) ?? undefined,
            location: post.location,
            meetup: post.meetup,
            highlight: post.highlight,
            media: post.media,
            userId: Number(post.userId),
            username: postUser?.userName || undefined,
            firstName: postUser?.firstName || "User",
        }, { showCta: true, ...layout });
        return this.postService.sendToApproved(richMessage);
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

        // An old message can still carry the live button: the refusal stays.
        const now: Date = new Date();
        const bumpCount = this.bumpsToday(post, now);
        if (this.atBumpLimit(post, now)) {
            const user: User | null = await userRepository.findByUserId(String(query.from.id));
            const locale = localeService.resolveUserLocale(user); //
            await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'bumpLimitReached'), show_alert: true });
            return;
        }

        // Answer callback immediately to avoid timeout
        const user: User | null = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user); //
        await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, 'bumpSuccess') });

        const newMessageId = await this.rePost(post);

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
        await this.disableAtLimit(query.message?.chat.id, query.message?.message_id, post, bumpCount + 1, locale, now);
    }

    // True when this seller's approved post is live on the market (not expired, not taken down) and so may take a price cut.
    private async canCutPrice(post: Post | null, userId: string): Promise<boolean> {
        if (!post || String(post.userId) !== userId || post.status !== "approved") return false;
        const status = (await listingRepository.findByPostId(String(post._id)))?.status;
        return status !== "expired" && status !== "taken_down";
    }

    // lp_<postId>: asks for the new price (a force-reply prompt); the state lives in the persisted session.
    async handlePriceChangeCallback(query: CallbackQuery, session: UserSession, now = new Date()): Promise<void> {
        const from = String(query.from.id);
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(from));
        const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
        const toast = async (key: string, alert = false) => { await this.api.answerCallbackQuery({ callback_query_id: query.id, text: t(key), show_alert: alert }); };

        const postId = query.data!.replace("lp_", "");
        const post: Post | null = /^[0-9a-f]{24}$/.test(postId) ? await postRepository.findById(postId) : null;
        if (!post || String(post.userId) !== from) return toast('postNotFound');
        if (await this.refuseIfTakenDown(query, postId)) return;
        if (!await this.canCutPrice(post, from)) return toast('staleButton');
        // No limit check here: a cut never uses a bump. A raise at the limit is refused after the price is entered.
        if (isNaN(priceNumber(post.price))) return toast('priceChangeNotNumeric', true);

        await this.api.answerCallbackQuery({ callback_query_id: query.id });
        const prompt = await this.api.sendMessage({
            chat_id: query.message?.chat.id ?? query.from.id,
            text: t('priceChangePrompt', { price: post.price }),
            reply_markup: { force_reply: true },
        });
        session.pendingPriceCut = { postId, promptId: prompt.message_id, cardId: query.message?.message_id, at: now.getTime() };
    }

    /** /cancel in private: drops a pending Change price prompt. True when there was one. */
    async cancelPriceCut(msg: Message, session: UserSession): Promise<boolean> {
        if (!session.pendingPriceCut) return false;
        delete session.pendingPriceCut;
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(String(msg.from!.id)));
        await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'priceChangeCancelled') });
        return true;
    }

    /** The seller's reply to the Change price prompt. True when the message was an answer to it (valid or not). */
    async handlePriceReply(msg: Message, session: UserSession | undefined, now = new Date()): Promise<boolean> {
        const pending = session?.pendingPriceCut;
        if (!session || !pending || !msg.from || !msg.text || msg.text.startsWith("/")) return false;
        if (msg.reply_to_message?.message_id !== pending.promptId) return false;

        const from = String(msg.from.id);
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(from));
        const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
        const say = (key: string, params?: Record<string, string | number | boolean>, force = false) => this.api.sendMessage({
            chat_id: msg.chat.id,
            text: t(key, params),
            ...(force ? { reply_markup: { force_reply: true as const } } : {}),
        });
        const end = async (key: string) => { delete session.pendingPriceCut; await say(key); return true; };

        if (now.getTime() - pending.at >= PRICE_CUT_WINDOW_MS) return end('priceChangeGone');
        const post = await postRepository.findById(pending.postId);
        if (!post || !await this.canCutPrice(post, from)) return end('priceChangeGone');
        const current = priceNumber(post.price);
        if (isNaN(current)) return end('priceChangeNotNumeric');

        const newPrice = msg.text.trim();
        const value = priceNumber(newPrice);
        // A wrong answer keeps the prompt open: the next reply goes to the new message.
        const retry = async (key: string) => { pending.promptId = (await say(key, { price: post.price }, true)).message_id; return true; };
        if (isNaN(value) || value <= 0) return retry('priceChangeInvalid');
        if (value === current) return retry('priceChangeSame');
        const cut = value < current;
        // A raise is a normal bump: refused at the daily limit. A cut is not counted.
        if (!cut && this.atBumpLimit(post, now)) return end('bumpLimitReached');

        const postId = String(post._id);
        const bumpCount = this.bumpsToday(post, now);
        const newMessageId = await this.rePost(post, { price: newPrice, previousPrice: cut ? post.price : null });
        await postRepository.applyPriceChange(postId, newPrice, cut ? { previousPrice: post.price } : { bumpCount: bumpCount + 1 });
        if (newMessageId) await postRepository.setApprovedMessageId(postId, newMessageId);
        try {
            await this.lifecycle.refreshForPost(postId, now);
            await listingRepository.setPriceByPostId(postId, newPrice);
        } catch (err) {
            console.error(`[ERROR - handlePriceReply] post ${postId}`, (err as Error).message);
        }
        delete session.pendingPriceCut;
        await say(cut ? 'priceChangeCut' : 'priceChangeRaised', { price: newPrice });
        if (!cut) await this.disableAtLimit(msg.chat.id, pending.cardId, post, bumpCount + 1, locale, now);
        return true;
    }
}
