import Listing, { IListing } from "../models/Listing";
import type { IMediaItem } from "../models/Post";
import type { CatchupItem } from "../services/catchupScan";
import { textHash } from "../services/classifier";
import type { Post } from "../types";

// First number in the price as written ("2,500" -> 2500); undefined when there is none.
export function priceValueOf(price: string | undefined): number | undefined {
    const m = price?.match(/\d[\d,]*/);
    return m ? Number(m[0].replace(/,/g, "")) : undefined;
}

export type NewGroupListing = {
    chatId: number;
    messageIds: number[];
    sellerId: string;
    sellerName: string;
    title: string;
    price: string;
    location?: string;
    text: string;
    media: IMediaItem[];
    isBundle: boolean;
    note?: { ephemeralMessageId: number; sentAt: Date };
};

export type RepostPatch = {
    messageIds: number[];
    text: string;
    media?: IMediaItem[];
    isBundle: boolean;
    title?: string;
    price?: string;
    priceValue?: number;
    location?: string;
};

class ListingRepository {
    findByPostId(postId: string): Promise<IListing | null> {
        return Listing.findOne({ source: "bot", postId }).exec();
    }

    // Idempotent per post (partial unique index on {source, postId}): the
    // startup reconcile and the approve path may both call it. The listing keeps
    // the post's own dates (an old post stays old for /stats and repost merges);
    // `now` only stands in for a post without a valid createdAt. `liveAt` is when
    // the listing goes public (approval): it starts the 30-day clock instead.
    createForPost(post: Post, origin: "dm" | "legacy", hold: boolean, now: Date, liveAt?: Date): Promise<IListing> {
        const postId = String(post._id);
        const text = [post.title, post.description].filter(Boolean).join("\n");
        const priceValue = priceValueOf(post.price);
        const validDate = (d: Date | null | undefined): d is Date => d instanceof Date && !isNaN(d.getTime());
        const createdAt = validDate(post.createdAt) ? post.createdAt : now;
        const refreshedAt = liveAt ?? (validDate(post.lastBumpAt) ? post.lastBumpAt : createdAt);
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
                    createdAt,
                    refreshedAt,
                },
            },
            { upsert: true, returnDocument: "after" }
        ).exec() as Promise<IListing>;
    }

    // A member's own group message that they said yes to.
    createFromCapture(input: NewGroupListing, now: Date): Promise<IListing> {
        const priceValue = priceValueOf(input.price);
        return Listing.create({
            ...input,
            ...(priceValue !== undefined ? { priceValue } : {}),
            textHash: textHash(input.text),
            source: "group",
            origin: "capture",
            status: "live",
            hold: false,
            createdAt: now,
            refreshedAt: now,
        });
    }

    // A past message found by the catch-up scan; the clock starts at its post date, so slice 3's expiry sees its real age.
    createFromCatchup(input: { chatId: number; messageId: number; sellerId: string; sellerName: string; item: CatchupItem; isBundle: boolean }, now: Date): Promise<IListing> {
        const { item } = input;
        const priceValue = priceValueOf(item.price);
        return Listing.create({
            chatId: input.chatId,
            messageIds: item.messageIds ?? [input.messageId],
            sellerId: input.sellerId,
            sellerName: input.sellerName,
            title: item.title,
            price: item.price,
            ...(item.location ? { location: item.location } : {}),
            text: item.text,
            media: [],
            isBundle: input.isBundle,
            ...(priceValue !== undefined ? { priceValue } : {}),
            textHash: textHash(item.text),
            source: "group",
            origin: "catchup",
            status: "live",
            hold: false,
            createdAt: now,
            refreshedAt: new Date(item.date),
        });
    }

    findLiveByMessage(chatId: number, messageId: number): Promise<IListing | null> {
        return Listing.findOne({ source: "group", status: "live", chatId, messageIds: messageId }).exec();
    }

    findGroupBySeller(sellerId: string): Promise<IListing[]> {
        return Listing.find({ source: "group", sellerId }).sort({ createdAt: -1 }).limit(50).exec();
    }

    countBySeller(sellerId: string): Promise<number> {
        return Listing.countDocuments({ sellerId }).exec();
    }

    // live|expired -> live, with a fresh clock. A repost of the same item also brings the newest
    // message ids, text, media and parsed fields (fields left undefined are not touched).
    refresh(id: string, now: Date, repost?: RepostPatch): Promise<IListing | null> {
        const $set: Record<string, unknown> = { status: "live", refreshedAt: now };
        if (repost) {
            $set.textHash = textHash(repost.text);
            for (const [key, value] of Object.entries(repost)) if (value !== undefined) $set[key] = value;
        }
        return Listing.findOneAndUpdate(
            { _id: id, status: { $in: ["live", "expired"] } },
            { $set, $unset: { nudgedAt: "", endedAt: "", endedBy: "" } },
            { returnDocument: "after" }
        ).exec();
    }

    // Only to undo a listing whose capture bookkeeping failed right after it was created.
    async deleteById(id: string): Promise<void> {
        await Listing.deleteOne({ _id: id }).exec();
    }

    // The member removes their own group listing; the content goes, as for takeDown.
    markRemoved(id: string, by: "seller" | "system", now: Date): Promise<IListing | null> {
        return Listing.findOneAndUpdate(
            { _id: id, status: { $in: ["live", "expired"] } },
            { $set: { status: "removed", endedAt: now, endedBy: by }, $unset: { text: "", media: "", title: "" } },
            { returnDocument: "after" }
        ).exec();
    }

    async setNote(id: string, note: { ephemeralMessageId: number; sentAt: Date }): Promise<void> {
        await Listing.updateOne({ _id: id }, { $set: { note } }).exec();
    }

    // Edit sync: only while live. Fields left undefined in the patch are not touched.
    applyEdit(id: string, patch: { title?: string; price?: string; priceValue?: number; location?: string; text: string; isBundle: boolean }): Promise<IListing | null> {
        const $set: Record<string, unknown> = { textHash: textHash(patch.text) };
        for (const [key, value] of Object.entries(patch)) if (value !== undefined) $set[key] = value;
        return Listing.findOneAndUpdate({ _id: id, status: "live" }, { $set }, { returnDocument: "after" }).exec();
    }

    // Final state; only a live or expired listing can be sold.
    markSold(id: string, now: Date): Promise<IListing | null> {
        return Listing.findOneAndUpdate(
            { _id: id, status: { $in: ["live", "expired"] } },
            { $set: { status: "sold", endedAt: now, endedBy: "seller" } },
            { returnDocument: "after" }
        ).exec();
    }

    findById(id: string): Promise<IListing | null> {
        return Listing.findById(id).exec();
    }

    // Moderator take-down: live|expired -> taken_down, and the content goes
    // (spec 5.3). Returns the document as it was before the update, so the
    // caller still has source, postId and sellerId; null for any other status.
    // ponytail: findOneAndUpdate runs no validators, so unsetting required-ish fields is fine.
    takeDown(id: string, now: Date): Promise<IListing | null> {
        return Listing.findOneAndUpdate(
            { _id: id, status: { $in: ["live", "expired"] } },
            { $set: { status: "taken_down", endedAt: now, endedBy: "moderator" }, $unset: { text: "", media: "", title: "" } },
            { returnDocument: "before" }
        ).exec();
    }

    async hasModeratorTakedownSince(sellerId: string, since: Date): Promise<boolean> {
        return (await Listing.exists({ sellerId, status: "taken_down", endedBy: "moderator", endedAt: { $gt: since } })) !== null;
    }

    findLiveForMatching(): Promise<IListing[]> {
        return Listing.find({ status: "live", hold: false }).exec();
    }

    findSellerRecent(sellerId: string, since: Date): Promise<IListing[]> {
        return Listing.find({ sellerId, status: { $in: ["live", "expired"] }, refreshedAt: { $gte: since } }).exec();
    }

    // Legacy listings waiting for the owner's release.
    countHeld(): Promise<number> {
        return Listing.countDocuments({ hold: true }).exec();
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
