import Member, { IMember } from "../models/Member";
import type { CatchupItem } from "../services/catchupScan";

const ASKED_MEMORY_MS = 30 * 24 * 3600 * 1000;
const ASKED_MEMORY_MAX = 20;
const CATCHUP_MS = 30 * 24 * 3600 * 1000;

class MemberRepository {
    // Only $setOnInsert: seeing a member again must never reset askMode.
    async touch(userId: string, now: Date): Promise<void> {
        await Member.updateOne({ userId }, { $setOnInsert: { firstSeenAt: now, askMode: "ask" } }, { upsert: true }).exec();
    }

    findByUserId(userId: string): Promise<IMember | null> {
        return Member.findOne({ userId }).exec();
    }

    async setAskMode(userId: string, mode: "ask" | "never", now: Date): Promise<void> {
        await Member.updateOne({ userId }, { $set: { askMode: mode }, $setOnInsert: { firstSeenAt: now } }, { upsert: true }).exec();
    }

    // Call at send time for every text a note went out for (answered or not), so
    // a repost of it gets no second note. Keeps the newest 20 hashes.
    async rememberAsked(userId: string, hash: string, now: Date): Promise<void> {
        await Member.updateOne(
            { userId },
            { $setOnInsert: { firstSeenAt: now, askMode: "ask" }, $push: { declined: { $each: [{ hash, at: now }], $slice: -ASKED_MEMORY_MAX } } },
            { upsert: true }
        ).exec();
    }

    findById(id: string): Promise<IMember | null> {
        return Member.findById(id).exec();
    }

    // Replaces the offer of an unsent member and clears armedAt (needs a new arm). Never twice, never "never".
    async importCatchup(userId: string, items: CatchupItem[], now: Date): Promise<boolean> {
        const m = await Member.findOne({ userId }).exec();
        if (m?.catchup?.sentAt || m?.askMode === "never") return false;
        await Member.updateOne(
            { userId },
            { $set: { pendingCatchup: items, catchup: { importedAt: now } }, $setOnInsert: { firstSeenAt: now, askMode: "ask" } },
            { upsert: true }
        ).exec();
        return true;
    }

    async armCatchup(now: Date): Promise<number> {
        const r = await Member.updateMany(
            { "catchup.importedAt": { $exists: true }, "catchup.armedAt": { $exists: false }, "catchup.sentAt": { $exists: false }, "pendingCatchup.0": { $exists: true } },
            { $set: { "catchup.armedAt": now } }
        ).exec();
        return r.modifiedCount;
    }

    // Atomic: one winner per member. A failed send must releaseCatchupDelivery.
    claimCatchupDelivery(userId: string, now: Date): Promise<IMember | null> {
        return Member.findOneAndUpdate(
            {
                userId,
                askMode: { $ne: "never" },
                "catchup.armedAt": { $gte: new Date(now.getTime() - CATCHUP_MS) },
                "catchup.sentAt": { $exists: false },
                "pendingCatchup.0": { $exists: true },
            },
            { $set: { "catchup.sentAt": now } },
            { returnDocument: "after" }
        ).exec();
    }

    async releaseCatchupDelivery(userId: string): Promise<void> {
        await Member.updateOne({ userId }, { $unset: { "catchup.sentAt": "" } }).exec();
    }

    async setCatchupNote(userId: string, ephemeralMessageId: number): Promise<void> {
        await Member.updateOne({ userId }, { $set: { "catchup.note": { ephemeralMessageId } } }).exec();
    }

    // Atomic: the filter holds the item, so concurrent taps have one winner.
    async takeCatchupItem(memberId: string, messageId: number): Promise<CatchupItem | null> {
        const before = await Member.findOneAndUpdate(
            { _id: memberId, "catchup.sentAt": { $exists: true }, "pendingCatchup.messageId": messageId },
            { $pull: { pendingCatchup: { messageId } } },
            { returnDocument: "before" }
        ).exec();
        return before?.pendingCatchup?.find(i => Number(i.messageId) === messageId) ?? null;
    }

    async restoreCatchupItem(memberId: string, item: CatchupItem): Promise<void> {
        await Member.updateOne({ _id: memberId }, { $push: { pendingCatchup: item } }).exec();
    }

    async dropCatchup(memberId: string): Promise<void> {
        await Member.updateOne({ _id: memberId }, { $unset: { pendingCatchup: "" } }).exec();
    }

    // R6: undelivered offers go 30 days after arming, never-armed imports 30 days after import, delivered ones 30 days after sending. Stamps stay.
    async dropExpiredCatchups(now: Date): Promise<number> {
        const cutoff = new Date(now.getTime() - CATCHUP_MS);
        const r = await Member.updateMany(
            {
                "pendingCatchup.0": { $exists: true },
                $or: [
                    { "catchup.sentAt": { $lt: cutoff } },
                    { "catchup.sentAt": { $exists: false }, "catchup.armedAt": { $lt: cutoff } },
                    { "catchup.sentAt": { $exists: false }, "catchup.armedAt": { $exists: false }, "catchup.importedAt": { $lt: cutoff } },
                ],
            },
            { $unset: { pendingCatchup: "" } }
        ).exec();
        return r.modifiedCount;
    }

    async catchupCounts(): Promise<{ imported: number; armed: number; sent: number; items: number }> {
        const [imported, armed, sent, sum] = await Promise.all([
            Member.countDocuments({ "catchup.importedAt": { $exists: true } }).exec(),
            Member.countDocuments({ "catchup.armedAt": { $exists: true } }).exec(),
            Member.countDocuments({ "catchup.sentAt": { $exists: true } }).exec(),
            Member.aggregate<{ n: number }>([{ $group: { _id: null, n: { $sum: { $size: { $ifNull: ["$pendingCatchup", []] } } } } }]).exec(),
        ]);
        return { imported, armed, sent, items: sum[0]?.n ?? 0 };
    }

    async wasAskedRecently(userId: string, hash: string, now: Date): Promise<boolean> {
        const since = new Date(now.getTime() - ASKED_MEMORY_MS);
        return (await Member.exists({ userId, declined: { $elemMatch: { hash, at: { $gte: since } } } })) !== null;
    }
}

export default new MemberRepository();
