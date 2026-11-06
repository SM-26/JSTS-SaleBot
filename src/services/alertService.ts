import { TelegramApiError, type Api } from "node-telegram-bot-api";
import { isApiError } from "../config/telegramErrors";
import type { IListing } from "../models/Listing";
import type { ISavedSearch } from "../models/SavedSearch";
import alertLogRepository from "../repositories/alertLogRepository";
import listingRepository from "../repositories/listingRepository";
import savedSearchRepository from "../repositories/savedSearchRepository";
import userRepository from "../repositories/userRepository";
import type { BotConfig } from "../types";
import { findBlockedWord } from "./blockedWords";
import { listingLines } from "./buyerNoteService";
import { buildAlertCard, buildRenewOffer, type ListingLine } from "./buyerCards";
import type { GroupListingService } from "./groupListingService";
import type { Card } from "./listingCards";
import { localeService } from "./localeService";
import { matchListings } from "./matchService";

const ALERTS_PER_TICK = 25;
const SCAN_OVERLAP_MS = 5 * 60_000;
const RENEW_BEFORE_MS = 3 * 24 * 3600_000;

type Outcome = "ok" | "blocked" | "retry" | "failed";

// 403: the user blocked the bot. 429, 5xx and anything that is not an API error: try again later.
function outcomeOf(err: unknown): Outcome {
    if (!(err instanceof TelegramApiError)) return "retry";
    if (err.errorCode === 403) return "blocked";
    return err.errorCode === 429 || err.errorCode >= 500 ? "retry" : "failed";
}

const query = (s: ISavedSearch) => ({ terms: s.terms, maxPrice: s.maxPrice, meetup: s.meetup ?? false });
const alertable = (l: IListing) => !findBlockedWord(l.title ?? "");

// DMs saved-search alerts and renew offers (buyerMatches "on").
export class AlertService {
    constructor(private api: Api, private config: BotConfig, private groupListings: GroupListingService) { }

    private async translator(userId: string) {
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        return (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
    }

    private async sendText(userId: string, card: Card, parse: boolean): Promise<void> {
        await this.api.sendMessage({
            chat_id: Number(userId),
            text: card.text,
            ...(parse ? { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } } : {}),
            ...(card.keyboard.length ? { reply_markup: { inline_keyboard: card.keyboard } } : {}),
        });
    }

    // The media goes with the text as caption; a 400 on it falls back to the text alone.
    private async sendAlert(userId: string, card: Card, listing: IListing): Promise<void> {
        const media = listing.media[0];
        if (media) {
            try {
                const base = { chat_id: Number(userId), caption: card.text, parse_mode: "HTML" as const };
                if (media.type === "video") await this.api.sendVideo({ ...base, video: media.fileId });
                else await this.api.sendPhoto({ ...base, photo: media.fileId });
                return;
            } catch (err) {
                if (!isApiError(err, 400, "")) throw err;
            }
        }
        await this.sendText(userId, card, true);
    }

    async tick(now: Date): Promise<void> {
        if (this.config.buyerMatches !== "on") return;
        const searches = await savedSearchRepository.findActive(now);
        if (!searches.length) return;

        const since = new Date(Math.min(...searches.map(s => s.scannedAt.getTime())) - SCAN_OVERLAP_MS);
        const live = (await listingRepository.findLiveRefreshedSince(since)).filter(alertable);
        const byId = new Map(live.map(l => [String(l._id), l]));
        const lines = new Map<string, Promise<ListingLine>>();
        const lineOf = (l: IListing) => {
            const id = String(l._id);
            if (!lines.has(id)) lines.set(id, listingLines([l], this.groupListings).then(r => r[0]));
            return lines.get(id)!;
        };
        const gone = new Set<string>(); // users who blocked the bot this tick
        let budget = ALERTS_PER_TICK;

        for (const s of searches) {
            if (gone.has(s.userId)) continue;
            const from = Math.max(s.createdAt.getTime(), s.scannedAt.getTime() - SCAN_OVERLAP_MS);
            const candidates = live.filter(l => l.refreshedAt.getTime() >= from && l.sellerId !== s.userId);
            const searchId = String(s._id);
            let delivered = false;
            let blocked = false;

            for (const id of matchListings(query(s), candidates, candidates.length)) {
                if (await alertLogRepository.userHas(s.userId, id)) continue;
                if (budget === 0) return; // cursor unmoved: the rest goes out next tick
                if (!(await alertLogRepository.claim(searchId, s.userId, id, now))) continue;
                budget--;
                let outcome: Outcome = "ok";
                try {
                    const t = await this.translator(s.userId);
                    const listing = byId.get(id)!;
                    await this.sendAlert(s.userId, buildAlertCard(t, s.query, await lineOf(listing)), listing);
                } catch (err) {
                    outcome = outcomeOf(err);
                }
                if (outcome === "ok") delivered = true;
                else if (outcome === "failed") await alertLogRepository.markFailed(searchId, id);
                else {
                    await alertLogRepository.release(searchId, id);
                    if (outcome === "retry") return;
                    blocked = true;
                    break;
                }
            }

            if (blocked) {
                gone.add(s.userId);
                await savedSearchRepository.deleteByUser(s.userId);
            } else await savedSearchRepository.setScanned(searchId, now, delivered);
        }

        const due = await savedSearchRepository.findDueRenewal(now, new Date(now.getTime() + RENEW_BEFORE_MS), budget);
        for (const s of due) {
            if (gone.has(s.userId)) continue;
            const searchId = String(s._id);
            if (!(await savedSearchRepository.claimRenewOffer(searchId, now))) continue;
            try {
                await this.sendText(s.userId, buildRenewOffer(await this.translator(s.userId), { id: searchId, query: s.query, expiresAt: s.expiresAt }), false);
            } catch (err) {
                const outcome = outcomeOf(err);
                if (outcome === "blocked") {
                    gone.add(s.userId);
                    await savedSearchRepository.deleteByUser(s.userId);
                } else if (outcome === "retry") {
                    await savedSearchRepository.releaseRenewOffer(searchId);
                    return;
                }
            }
        }
    }

    // /test: up to 3 matches per search of this user, no alert_log, no cursor. Returns how many were sent.
    async sendNow(userId: string, now: Date): Promise<number> {
        const searches = await savedSearchRepository.findByUser(userId, now);
        if (!searches.length) return 0;
        const live = (await listingRepository.findLiveForMatching()).filter(alertable);
        const byId = new Map(live.map(l => [String(l._id), l]));
        const t = await this.translator(userId);
        let sent = 0;
        for (const s of searches) {
            for (const id of matchListings(query(s), live, 3)) {
                const listing = byId.get(id)!;
                await this.sendAlert(userId, buildAlertCard(t, s.query, (await listingLines([listing], this.groupListings))[0]), listing);
                sent++;
            }
        }
        return sent;
    }
}
