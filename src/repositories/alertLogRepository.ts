import AlertLog from "../models/AlertLog";

class AlertLogRepository {
    // false when the pair was already claimed (duplicate key).
    async claim(searchId: string, userId: string, listingId: string, now: Date): Promise<boolean> {
        try {
            await AlertLog.create({ searchId, userId, listingId, sentAt: now, ok: true });
            return true;
        } catch (err) {
            if ((err as { code?: number }).code === 11000) return false;
            throw err;
        }
    }

    // Has this user been alerted about the listing by any search?
    async userHas(userId: string, listingId: string): Promise<boolean> {
        return (await AlertLog.exists({ userId, listingId })) !== null;
    }

    async release(searchId: string, listingId: string): Promise<void> {
        await AlertLog.deleteOne({ searchId, listingId }).exec();
    }

    async markFailed(searchId: string, listingId: string): Promise<void> {
        await AlertLog.updateOne({ searchId, listingId }, { $set: { ok: false } }).exec();
    }

    countSentSince(since: Date): Promise<number> {
        return AlertLog.countDocuments({ sentAt: { $gte: since }, ok: true }).exec();
    }
}

export default new AlertLogRepository();
