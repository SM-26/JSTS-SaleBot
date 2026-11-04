import type { Api } from "node-telegram-bot-api";
import type { BotConfig, Post, User } from "../types";
import type { IListing } from "../models/Listing";
import postRepository from "../repositories/postRepository";
import listingRepository from "../repositories/listingRepository";
import userRepository from "../repositories/userRepository";
import { PostService, PostData } from "./postService";
import { localeService } from "./localeService";
import { findBlockedWord } from "./blockedWords";
import { isTrustedSeller } from "./trustService";

// Publishes an approved post (moderator approval today, trusted sellers later)
// and gives it a `bot` listing.
export class PublishService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private postService: PostService
    ) { }

    // Called by the wizard for a freshly saved pending post. A trusted seller
    // publishes at once and moderation gets a review card with Take down; anyone
    // else (or a blocked word, Decision 7, or a failed publish) gets the
    // approve/reject card. `trusted` overrides the lookup (tests, callers that know).
    async submitPost(post: Post, data: PostData, trusted?: boolean): Promise<"published" | "moderation"> {
        const postId = String(post._id);
        const toModeration = async (): Promise<"moderation"> => {
            const modMsgId = await this.postService.sendToModeration(postId, data);
            if (modMsgId) await postRepository.setModerationMessageId(postId, modMsgId);
            return "moderation";
        };

        const blocked = findBlockedWord([data.title, data.description, data.price, data.location].join("\n")) !== null;
        const author = blocked ? null : await userRepository.findByUserId(post.userId);
        if (blocked || !author || !(trusted ?? await isTrustedSeller(post.userId, new Date()))) return toModeration();

        const claimed = await postRepository.claimPending(postId, "approved");
        if (!claimed) {
            console.warn("[WARN - PublishService.submitPost] post already handled", { postId });
            return "published";
        }

        let listing: IListing | null;
        try {
            listing = await this.publishApproved(claimed, author);
        } catch (err) {
            console.error("[ERROR - PublishService.submitPost] publishing failed, sending to moderation:", (err as Error).message);
            await postRepository.updateStatus(postId, "pending");
            return toModeration();
        }

        try {
            const cardId = await this.postService.sendTrustedCard(listing ? String(listing._id) : null, data);
            if (cardId) await postRepository.setModerationMessageId(postId, cardId);
        } catch (err) {
            console.error("[ERROR - PublishService.submitPost] trusted review card failed:", (err as Error).message);
        }
        return "published";
    }

    // A sendToApproved error propagates: the caller releases the claim. The
    // listing and the author's DM are best-effort: the post is already public.
    async publishApproved(post: Post, author: User): Promise<IListing | null> {
        const postId = String(post._id);
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
            price: post.price,
            location: post.location,
            media: post.media,
            userId: Number(author.userId),
            username: author.userName || undefined,
            firstName: author.firstName || "User",
        }, { showCta: true });

        const messageId = await this.postService.sendToApproved(richMessage);
        if (messageId) {
            await postRepository.setApprovedMessageId(postId, messageId);
        }

        let listing: IListing | null = null;
        try {
            const now = new Date();
            try {
                listing = await listingRepository.createForPost(post, "dm", false, now, now);
            } catch (err) {
                if ((err as { code?: number }).code !== 11000) throw err;
                listing = await listingRepository.findByPostId(postId); // lost a race with the reconcile
            }
        } catch (err) {
            console.error("[ERROR - PublishService.publishApproved]", (err as Error).message);
        }

        // The post is public whatever happened to the listing, so the author is told.
        // Detached: the moderator's callback never waits on this DM.
        const authorLocale = localeService.resolveUserLocale(author);
        this.api.sendMessage({ chat_id: Number(post.userId), text: localeService.t(authorLocale, "postApproved") })
            .catch((err: Error) => console.error("[ERROR - PublishService.publishApproved] notifying the author failed:", err.message));
        return listing;
    }
}
