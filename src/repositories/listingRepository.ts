import Listing, { IListing } from "../models/Listing";
import { textHash } from "../services/classifier";
import type { Post } from "../types";

// First number in the price as written ("2,500" -> 2500); undefined when there is none.
function priceValueOf(price: string | undefined): number | undefined {
    const m = price?.match(/\d[\d,]*/);
    return m ? Number(m[0].replace(/,/g, "")) : undefined;
}

class ListingRepository {
    findByPostId(postId: string): Promise<IListing | null> {
        return Listing.findOne({ source: "bot", postId }).exec();
    }

    // Idempotent per post (partial unique index on {source, postId}): the
    // startup reconcile and the approve path may both call it.
    createForPost(post: Post, origin: "dm" | "legacy", hold: boolean, now: Date): Promise<IListing> {
        const postId = String(post._id);
        const text = [post.title, post.description].filter(Boolean).join("\n");
        const priceValue = priceValueOf(post.price);
        return Listing.findOneAndUpdate(
            { source: "bot", postId },
            {
                $setOnInsert: {
                    source: "bot",
                    postId,
                    origin,
                    hold,
                    sellerId: post.userId,
                    title: post.title,
                    price: post.price,
                    ...(priceValue !== undefined ? { priceValue } : {}),
                    location: post.location,
                    text,
                    textHash: textHash(text),
                    media: post.media.map(m => ({ fileId: m.fileId, type: m.type })),
                    messageIds: [],
                    status: "live",
                    isBundle: false,
                    createdAt: now,
                    refreshedAt: now,
                },
            },
            { upsert: true, returnDocument: "after" }
        ).exec() as Promise<IListing>;
    }

    // Final state; only a live or expired listing can be sold.
    markSold(id: string, now: Date): Promise<IListing | null> {
        return Listing.findOneAndUpdate(
            { _id: id, status: { $in: ["live", "expired"] } },
            { $set: { status: "sold", endedAt: now, endedBy: "seller" } },
            { returnDocument: "after" }
        ).exec();
    }

    findLiveForMatching(): Promise<IListing[]> {
        return Listing.find({ status: "live", hold: false }).exec();
    }

    findSellerRecent(sellerId: string, since: Date): Promise<IListing[]> {
        return Listing.find({ sellerId, status: { $in: ["live", "expired"] }, refreshedAt: { $gte: since } }).exec();
    }

    // Listings created since `since` (all time when omitted), grouped by status.
    async countByStatus(since?: Date): Promise<Record<string, number>> {
        const rows = await Listing.aggregate<{ _id: string; n: number }>([
            ...(since ? [{ $match: { createdAt: { $gte: since } } }] : []),
            { $group: { _id: "$status", n: { $sum: 1 } } },
        ]).exec();
        return Object.fromEntries(rows.map(r => [r._id, r.n]));
    }
}

export default new ListingRepository();
