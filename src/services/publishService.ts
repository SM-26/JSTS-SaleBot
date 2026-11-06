import type { Api } from "node-telegram-bot-api";
import type { BotConfig, Post, User } from "../types";
import type { IListing } from "../models/Listing";
import postRepository from "../repositories/postRepository";
import listingRepository from "../repositories/listingRepository";
import userRepository from "../repositories/userRepository";
import { PostService, PostData } from "./postService";
import { localeService } from "./localeService";
import { findBlockedWord, withLinkUrls } from "./blockedWords";
import { isTrustedSeller, safeTrustLine } from "./trustService";

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

        const blocked = findBlockedWord([data.title, withLinkUrls(data.description, data.descriptionEntities), data.price, data.location].join("\n")) !== null;
        const author = blocked ? null : await userRepository.findByUserId(post.userId);
        if (!blocked && !author) console.warn("[WARN - PublishService.submitPost] no user record, sending to moderation", { userId: post.userId, postId });
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
            // publishApproved only throws before the group message exists.
            console.error(`[ERROR - PublishService.submitPost] post ${postId}: publishing failed, sending to moderation:`, (err as Error).message);
            try {
                await postRepository.updateStatus(postId, "pending");
                return await toModeration();
            } catch (fallbackErr) {
                // The wizard's catch tells the author; a stuck post is for a human to repair.
                console.error(`[ERROR - PublishService.submitPost] post ${postId}: moderation fallback failed:`, (fallbackErr as Error).message);
                throw fallbackErr;
            }
        }

        try {
            const cardId = await this.postService.sendTrustedCard(listing ? String(listing._id) : null, data);
            if (cardId) await postRepository.setModerationMessageId(postId, cardId);
        } catch (err) {
            console.error("[ERROR - PublishService.submitPost] trusted review card failed:", (err as Error).message);
        }
        return "published";
    }

    // A sendToApproved error propagates (nothing is public yet): the caller
    // releases the claim. Everything after the send is best-effort and logged.
    async publishApproved(post: Post, author: User): Promise<IListing | null> {
        const postId = String(post._id);
        const trustLine = await safeTrustLine(post.userId, this.config.lang, "PublishService.publishApproved");
        const richMessage = this.postService.formatPostRichMessage({
            title: post.title,
            description: post.description,
            descriptionEntities: post.descriptionEntities,
            price: post.price,
            location: post.location,
            meetup: post.meetup,
            media: post.media,
            userId: Number(author.userId),
            username: author.userName || undefined,
            firstName: author.firstName || "User",
        }, { showCta: true, trustLine });

        // Only this send may throw. Once the message exists the post is public:
        // nothing below rejects, or a caller would release the claim / fall back
        // to moderation and publish it twice.
        const messageId = await this.postService.sendToApproved(richMessage);
        if (messageId) {
            try {
                await postRepository.setApprovedMessageId(postId, messageId);
            } catch (err) {
                console.error(`[ERROR - PublishService.publishApproved] post ${postId} message ${messageId}: storing approvedMessageId failed, repair by hand:`, (err as Error).message);
            }
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
            console.error(`[ERROR - PublishService.publishApproved] post ${postId} message ${messageId}: creating the listing failed:`, (err as Error).message);
        }

        // The post is public whatever happened to the listing, so the author is told.
        // Detached: the moderator's callback never waits on this DM.
        try {
            const authorLocale = localeService.resolveUserLocale(author);
            this.api.sendMessage({ chat_id: Number(post.userId), text: localeService.t(authorLocale, "postApproved") })
                .catch((err: Error) => console.error(`[ERROR - PublishService.publishApproved] post ${postId} message ${messageId}: notifying the author failed:`, err.message));
        } catch (err) {
            console.error(`[ERROR - PublishService.publishApproved] post ${postId} message ${messageId}: notifying the author failed:`, (err as Error).message);
        }
        return listing;
    }
}
