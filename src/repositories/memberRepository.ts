import Member from "../models/Member";

class MemberRepository {
    // Only $setOnInsert: seeing a member again must never reset askMode.
    async touch(userId: string, now: Date): Promise<void> {
        await Member.updateOne({ userId }, { $setOnInsert: { firstSeenAt: now, askMode: "ask" } }, { upsert: true }).exec();
    }
}

export default new MemberRepository();
