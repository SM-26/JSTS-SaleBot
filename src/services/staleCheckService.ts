import type { Api, Context } from "node-telegram-bot-api";
import type { CallbackQuery, InlineKeyboardButton, Message } from "node-telegram-bot-api/types";
import { isApiError, isUnreachable } from "../config/telegramErrors";
import type { IListing } from "../models/Listing";
import type { IPost } from "../models/Post";
import listingRepository from "../repositories/listingRepository";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { AuthLevel } from "../types";
import type { BotConfig, UserSession } from "../types";
import { lifecycleActionData } from "./listingCards";
import { localeService } from "./localeService";

export interface StalePlan { sellers: Array<{ sellerId: string; listings: IListing[] }>; unknownIds: string[] }
export interface StaleReport { busy: boolean; sellersSent: number; listingsSent: number; blocked: number; failed: number }
interface StaleItem { listingId: string; title: string; price: string; postedAt: Date }

const PENDING_MAX_AGE_MS = 3600 * 1000;

export function parseSellerIds(args: string): { ids: string[]; invalid: string[] } {
    const ids: string[] = [];
    const invalid: string[] = [];
    for (const token of args.split(/\s+/).filter(Boolean)) (/^\d{3,15}$/.test(token) ? ids : invalid).push(token);
    return { ids, invalid };
}

const dmyUtc = (d: Date) => `${d.getUTCDate()}.${d.getUTCMonth() + 1}.${d.getUTCFullYear()}`;

// ponytail: one DM lists all of a seller's posts; legacy sellers hold few (28 listings across 14 sellers), well under
// Telegram's 4096-char limit. Chunk across messages if a seller ever holds dozens.
export function renderStaleDm(input: { firstName: string; items: StaleItem[]; locale: string }): { text: string; keyboard: InlineKeyboardButton[][] } {
    const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(input.locale, key, params);
    const intro = t("staleDmIntro", { firstName: input.firstName }).replace(/ {2,}/g, " ");
    const lines = input.items.map((item, n) => t("staleDmItem", { i: n + 1, title: item.title, price: item.price, date: dmyUtc(item.postedAt) }));
    return {
        text: `${intro}\n${lines.join("\n")}\n\n${t("staleDmOutro")}`,
        keyboard: input.items.map((item, n) => [
            { text: t("staleStillButton", { i: n + 1 }), callback_data: lifecycleActionData(item.listingId, "r") },
            { text: t("staleSoldButton", { i: n + 1 }), callback_data: lifecycleActionData(item.listingId, "s") },
        ]),
    };
}

const itemOf = (l: IListing, post?: IPost): StaleItem => ({
    listingId: String(l._id),
    title: l.title ?? post?.title ?? "",
    price: l.price ?? post?.price ?? "",
    postedAt: post?.createdAt ?? l.createdAt,
});

export class StaleCheckService {
    private running = false;

    constructor(private api: Api, private config: BotConfig) {}

    async plan(sellerIds: string[] | null): Promise<StalePlan> {
        const bySeller = new Map<string, IListing[]>();
        for (const l of await listingRepository.findStaleEligible(sellerIds)) {
            bySeller.set(l.sellerId, [...(bySeller.get(l.sellerId) ?? []), l]);
        }
        return {
            sellers: [...bySeller].map(([sellerId, listings]) => ({ sellerId, listings })),
            unknownIds: (sellerIds ?? []).filter(id => !bySeller.has(id)),
        };
    }

    async run(sellerIds: string[] | null, now: Date): Promise<StaleReport> {
        const report: StaleReport = { busy: false, sellersSent: 0, listingsSent: 0, blocked: 0, failed: 0 };
        // ponytail: single process, the per-listing claim is the real guard
        if (this.running) return { ...report, busy: true };
        this.running = true;
        try {
            for (const { sellerId, listings } of (await this.plan(sellerIds)).sellers) {
                try {
                    await this.sendToSeller(sellerId, listings, now, report);
                } catch (err) {
                    report.failed++;
                    console.error("[ERROR - StaleCheckService.run]", sellerId, (err as Error).message);
                }
            }
        } finally {
            this.running = false;
        }
        return report;
    }

    private async sendToSeller(sellerId: string, listings: IListing[], now: Date, report: StaleReport): Promise<void> {
        const claimed: IListing[] = [];
        for (const l of listings) {
            const c = await listingRepository.claimStale(String(l._id), now);
            if (c) claimed.push(c);
        }
        const kept: Array<{ listing: IListing; post: IPost }> = [];
        let text: string;
        let keyboard: InlineKeyboardButton[][];
        try {
            const posts = new Map((await postRepository.findByIds(claimed.flatMap(l => l.postId ? [l.postId] : []))).map(p => [String(p._id), p]));
            for (const l of claimed) {
                const post = l.postId ? posts.get(l.postId) : undefined;
                if (post?.status === "approved") kept.push({ listing: l, post });
                else if (post?.status === "sold") await listingRepository.markSold(String(l._id), now, "system");
                else await listingRepository.unclaimStale(String(l._id));
            }
            if (!kept.length) return;
            const user = await userRepository.findByUserId(sellerId);
            ({ text, keyboard } = renderStaleDm({
                firstName: user?.firstName ?? "",
                items: kept.map(k => itemOf(k.listing, k.post)),
                locale: localeService.resolveUserLocale(user),
            }));
        } catch (err) {
            // unclaim is guarded to live rows that still carry staleSentAt, so sold or refreshed ones stay as they are
            for (const l of claimed) await listingRepository.unclaimStale(String(l._id)).catch(() => undefined);
            throw err;
        }
        try {
            await this.api.sendMessage({ chat_id: Number(sellerId), text, reply_markup: { inline_keyboard: keyboard } });
            report.sellersSent++;
            report.listingsSent += kept.length;
        } catch (err) {
            if (isUnreachable(err)) {
                for (const k of kept) await listingRepository.markExpired(String(k.listing._id), now);
                report.blocked++;
            } else {
                for (const k of kept) await listingRepository.unclaimStale(String(k.listing._id));
                report.failed++;
                console.error("[ERROR - StaleCheckService.send]", sellerId, (err as Error).message);
            }
        }
    }

    // /stalecheck [userId ...]: the dry run. Nothing reaches a seller before the admin confirms.
    async handleCommand(ctx: Context, msg: Message, args: string): Promise<void> {
        const chatId = msg.chat.id;
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(String(msg.from!.id)));
        const t = (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
        const { ids, invalid } = parseSellerIds(args);
        if (invalid.length) {
            await this.api.sendMessage({ chat_id: chatId, text: t("staleBadIds", { ids: invalid.join(" ") }) });
            return;
        }
        const plan = await this.plan(ids.length ? ids : null);
        const unmatched = plan.unknownIds.length ? `\n${t("staleUnmatched", { ids: plan.unknownIds.join(" ") })}` : "";
        if (!plan.sellers.length) {
            await this.api.sendMessage({ chat_id: chatId, text: t("staleNothing") + unmatched });
            return;
        }
        const listingCount = plan.sellers.reduce((n, s) => n + s.listings.length, 0);
        await this.api.sendMessage({
            chat_id: chatId,
            text: t("staleDryRun", { listings: listingCount, sellers: plan.sellers.length, scope: ids.length ? ids.length : t("staleScopeAll") }) + unmatched,
        });
        const first = plan.sellers[0];
        const user = await userRepository.findByUserId(first.sellerId);
        const posts = new Map((await postRepository.findByIds(first.listings.flatMap(l => l.postId ? [l.postId] : []))).map(p => [String(p._id), p]));
        const dm = renderStaleDm({
            firstName: user?.firstName ?? "",
            items: first.listings.map(l => itemOf(l, l.postId ? posts.get(l.postId) : undefined)),
            locale: localeService.resolveUserLocale(user),
        });
        const labels = dm.keyboard.map(row => row.map(b => b.text).join("  |  "));
        const preview = await this.api.sendMessage({
            chat_id: chatId,
            text: [dm.text, ...labels].join("\n\n"),
            reply_markup: { inline_keyboard: [[
                { text: t("staleConfirmButton"), callback_data: "sc_go" },
                { text: t("staleCancelButton"), callback_data: "sc_no" },
            ]] },
        });
        ctx.getSession<UserSession>().data.pendingStalecheck = { sellerIds: plan.sellers.map(s => s.sellerId), at: Date.now(), promptMessageId: preview.message_id };
    }

    // sc_go / sc_no. The send loop runs detached and never touches the session.
    async handleCallback(ctx: Context, query: CallbackQuery, arg: string): Promise<void> {
        const from = String(query.from.id);
        const user = await userRepository.findByUserId(from);
        const locale = localeService.resolveUserLocale(user);
        const toast = (key: string) => this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, key) });
        const msg = query.message;
        if (!msg || msg.chat.type !== "private") { await toast("staleButton"); return; }
        if ((user?.authLevel ?? AuthLevel.USER) < AuthLevel.ADMIN) { await toast("notAdmin"); return; }

        const data = ctx.getSession<UserSession>().data;
        const pending = data.pendingStalecheck;
        const dropKeyboard = () => this.api.editMessageReplyMarkup({ chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } })
            .catch((err: unknown) => {
                if (!isApiError(err, 400, "message is not modified")) console.warn("[WARN - StaleCheckService] editMessageReplyMarkup failed:", (err as Error).message);
            });
        // only the newest dry run's own buttons count; anything else drops its keyboard and keeps the pending state
        if ((arg !== "go" && arg !== "no") || (pending && pending.promptMessageId !== msg.message_id)) {
            await dropKeyboard();
            await toast("staleButton");
            return;
        }
        delete data.pendingStalecheck;
        await dropKeyboard();
        if (arg === "no") { await this.api.answerCallbackQuery({ callback_query_id: query.id }); return; }
        if (!pending || Date.now() - pending.at > PENDING_MAX_AGE_MS) { await toast("staleButton"); return; }

        await this.api.answerCallbackQuery({ callback_query_id: query.id });
        const chatId = msg.chat.id;
        this.run(pending.sellerIds, new Date()).then(report => {
            const text = report.busy
                ? localeService.t(locale, "staleBusy")
                : localeService.t(locale, "staleDone", { sellers: report.sellersSent, listings: report.listingsSent, blocked: report.blocked, failed: report.failed });
            return this.api.sendMessage({ chat_id: chatId, text });
        }).catch(err => console.error("[ERROR - /stalecheck]", err));
    }
}
