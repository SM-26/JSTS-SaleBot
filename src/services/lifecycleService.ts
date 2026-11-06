import type { Api } from "node-telegram-bot-api";
import { isUnreachable } from "../config/telegramErrors";
import type { IListing } from "../models/Listing";
import captureRepository from "../repositories/captureRepository";
import listingRepository from "../repositories/listingRepository";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import type { BotConfig } from "../types";
import { deleteNote, sendNote } from "./ephemeralNotes";
import { nudgeKeyboard } from "./listingCards";
import type { Card } from "./listingCards";
import { localeService } from "./localeService";
import { createBotListing } from "./marketService";
import type { PostService } from "./postService";
import type { SweeperJob } from "./sweeper";

export const NUDGE_AFTER_DAYS = 7;
export const EXPIRE_AFTER_DAYS = 30;
export const STALE_ANSWER_DAYS = 7;
export const NUDGE_BATCH = 25;
export const HELD_RELEASE_DELAY_MS = 120_000;
export const NEW_SELLER_DAYS = 30;

export type LifecycleOutcome = "ok" | "ended" | "forbidden" | "not_found" | "not_allowed";
export interface LifecycleResult {
    outcome: LifecycleOutcome;
    listing?: IListing;
    groupEdited?: boolean;
}

const id = (l: IListing) => String(l._id);

// One implementation of each state change a seller can make on a listing.
export class LifecycleService {
    constructor(
        protected api: Api,
        protected config: BotConfig,
        private postService: PostService,
        protected botUsername: () => string,
    ) {}

    // The seller's own live|expired listing, or the outcome that stops the action.
    private async load(listingId: string, actorId: string): Promise<{ listing: IListing } | { result: LifecycleResult }> {
        const listing = await listingRepository.findById(listingId);
        if (!listing) return { result: { outcome: "not_found" } };
        if (listing.sellerId !== actorId) return { result: { outcome: "forbidden", listing } };
        if (listing.status !== "live" && listing.status !== "expired") return { result: { outcome: "ended", listing } };
        return { listing };
    }

    private async ended(listingId: string): Promise<LifecycleResult> {
        return { outcome: "ended", listing: (await listingRepository.findById(listingId)) ?? undefined };
    }

    async refreshListing(listingId: string, actorId: string, now: Date): Promise<LifecycleResult> {
        const l = await this.load(listingId, actorId);
        if ("result" in l) return l.result;
        const refreshed = await listingRepository.refresh(listingId, now);
        return refreshed ? { outcome: "ok", listing: refreshed } : this.ended(listingId);
    }

    async sellListing(listingId: string, actorId: string, now: Date): Promise<LifecycleResult> {
        const l = await this.load(listingId, actorId);
        if ("result" in l) return l.result;
        let groupEdited: boolean | undefined;
        try {
            if (l.listing.source === "bot" && l.listing.postId) {
                // Post first: if the listing update then fails, both are retryable.
                const post = await postRepository.findById(l.listing.postId);
                if (post) groupEdited = (await this.postService.markPostSold(post)).groupEdited;
            }
            const sold = await listingRepository.markSold(listingId, now);
            return sold ? { outcome: "ok", listing: sold, groupEdited } : this.ended(listingId);
        } catch (err) {
            console.error(`[ERROR - lifecycle.sellListing] listing ${listingId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }

    // Group listings only; a seller can never remove an approved bot post, and the member's message is never touched.
    async removeListing(listingId: string, actorId: string, now: Date): Promise<LifecycleResult> {
        const l = await this.load(listingId, actorId);
        if ("result" in l) return l.result;
        if (l.listing.source !== "group") return { outcome: "not_allowed", listing: l.listing };
        const removed = await listingRepository.markRemoved(listingId, "seller", now);
        return removed ? { outcome: "ok", listing: removed } : this.ended(listingId);
    }

    // The listing of an approved or sold post, created like the reconcile does if the hourly job has not run yet.
    async ensureBotListing(postId: string, now: Date): Promise<IListing | null> {
        const existing = await listingRepository.findByPostId(postId);
        if (existing) return existing;
        const post = await postRepository.findById(postId);
        if (!post || (post.status !== "approved" && post.status !== "sold")) return null;
        try {
            return await createBotListing(post, now);
        } catch (err) {
            if ((err as { code?: number }).code === 11000) return listingRepository.findByPostId(postId);
            console.error(`[ERROR - lifecycle.ensureBotListing] post ${postId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }

    // The sold_ handler already set the post sold; this only brings the listing along.
    async syncSoldForPost(postId: string, now: Date): Promise<void> {
        const listing = await this.ensureBotListing(postId, now);
        if (listing) await listingRepository.markSold(id(listing), now);
    }

    async refreshForPost(postId: string, now: Date): Promise<void> {
        const listing = await this.ensureBotListing(postId, now);
        if (listing) await listingRepository.refresh(id(listing), now);
    }

    private async translatorFor(sellerId: string) {
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(sellerId));
        return (key: string, params?: Record<string, string | number | boolean>) => localeService.t(locale, key, params);
    }

    private async nudgeCard(listing: IListing, withManageLink: boolean): Promise<Card> {
        const t = await this.translatorFor(listing.sellerId);
        return {
            text: t("nudgeAsk", { title: listing.title ?? "", price: listing.price ?? "" }),
            keyboard: nudgeKeyboard(listing, t, withManageLink ? this.botUsername() : undefined),
        };
    }

    // Expiry always runs; the nudge only when config.nudges is on (read live).
    async tick(now: Date): Promise<{ expired: number; staleExpired: number; nudged: number; held: number }> {
        const expired = (await listingRepository.expireDue(now)).length;
        const staleExpired = (await listingRepository.expireStaleUnanswered(now)).length;
        let nudged = 0;
        let held = 0;
        if (this.config.nudges === true) {
            for (const candidate of await listingRepository.findNudgeCandidates(now, NUDGE_BATCH)) {
                try {
                    const outcome = await this.nudgeOne(candidate, now);
                    if (outcome === "sent") nudged++;
                    else if (outcome === "held") held++;
                } catch (err) {
                    console.error(`[ERROR - lifecycle.nudgeOne] listing ${id(candidate)}: ${err instanceof Error ? err.message : String(err)}`);
                    await listingRepository.releaseNudgeClaim(id(candidate)).catch(() => undefined);
                }
            }
        }
        return { expired, staleExpired, nudged, held };
    }

    async nudgeOne(listing: IListing, now: Date): Promise<"sent" | "held" | "skipped" | "retry"> {
        const claimed = await listingRepository.claimNudge(id(listing), now);
        if (!claimed) return "skipped";
        if (claimed.source === "bot" && claimed.postId) {
            const post = await postRepository.findById(claimed.postId);
            if (!post || post.status !== "approved") {
                if (post?.status === "sold") await listingRepository.markSold(id(claimed), now, "system");
                return "skipped";
            }
        }
        try {
            const card = await this.nudgeCard(claimed, false);
            await this.api.sendMessage({ chat_id: Number(claimed.sellerId), text: card.text, reply_markup: { inline_keyboard: card.keyboard } });
            return "sent";
        } catch (err) {
            if (isUnreachable(err)) {
                await listingRepository.holdNudge(id(claimed));
                return "held";
            }
            console.error(`[ERROR - lifecycle.nudgeOne] listing ${id(claimed)}: ${err instanceof Error ? err.message : String(err)}`);
            await listingRepository.releaseNudgeClaim(id(claimed));
            return "retry";
        }
    }

    // A held nudge goes out as a private note once the member has posted in the sale topic and settled.
    async releaseHeldNudges(now: Date): Promise<number> {
        if (this.config.nudges !== true) return 0;
        let released = 0;
        for (const held of await listingRepository.findHeldNudges()) {
            try {
                const settledBefore = new Date(now.getTime() - HELD_RELEASE_DELAY_MS);
                if (!held.nudgedAt || !(await captureRepository.hasSettledSince(this.config.approvedGroupId, held.sellerId, held.nudgedAt, settledBefore))) continue;
                const claimed = await listingRepository.claimHeldRelease(id(held));
                if (!claimed) continue;
                const ephemeralMessageId = await sendNote(this.api, this.config, Number(claimed.sellerId), await this.nudgeCard(claimed, true));
                if (ephemeralMessageId === null) continue; // logged by sendNote; not retried, the listing expires on day 30
                released++;
                if (claimed.source === "group" && claimed.chatId !== undefined) {
                    try {
                        await listingRepository.setNote(id(claimed), { ephemeralMessageId, sentAt: now });
                        const previous = claimed.note?.ephemeralMessageId;
                        if (previous !== undefined) await deleteNote(this.api, claimed.chatId, Number(claimed.sellerId), previous);
                    } catch (err) {
                        console.error(`[ERROR - lifecycle.releaseHeldNudges] note bookkeeping ${id(claimed)}: ${err instanceof Error ? err.message : String(err)}`);
                    }
                }
            } catch (err) {
                console.error(`[ERROR - lifecycle.releaseHeldNudges] listing ${id(held)}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return released;
    }

    // Both stay registered when captureMode is off: expiry never depends on capture.
    jobs(): SweeperJob[] {
        return [
            { name: "lifecycle", everyMs: 600_000, run: async () => { await this.tick(new Date()); } },
            { name: "held-nudges", everyMs: 10_000, run: async () => { await this.releaseHeldNudges(new Date()); } },
        ];
    }
}
