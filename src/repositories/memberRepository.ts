import Member, { IMember } from "../models/Member";

const ASKED_MEMORY_MS = 30 * 24 * 3600 * 1000;
const ASKED_MEMORY_MAX = 20;

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

    async setLastBuyerNote(userId: string, now: Date): Promise<void> {
        await Member.updateOne({ userId }, { $set: { lastBuyerNoteAt: now }, $setOnInsert: { firstSeenAt: now, askMode: "ask" } }, { upsert: true }).exec();
    }

    async wasAskedRecently(userId: string, hash: string, now: Date): Promise<boolean> {
        const since = new Date(now.getTime() - ASKED_MEMORY_MS);
        return (await Member.exists({ userId, declined: { $elemMatch: { hash, at: { $gte: since } } } })) !== null;
    }
}

export default new MemberRepository();
