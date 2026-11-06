import type { Api } from "node-telegram-bot-api";
import type { IListing } from "../models/Listing";
import listingRepository from "../repositories/listingRepository";
import postRepository from "../repositories/postRepository";
import type { BotConfig } from "../types";
import { createBotListing } from "./marketService";
import type { PostService } from "./postService";

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
        // ponytail: api, config and botUsername are unused until the nudge and card tasks land.
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
}
