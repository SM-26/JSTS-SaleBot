import SavedSearch, { ISavedSearch } from "../models/SavedSearch";
import type { BuyerQuery } from "../services/matchService";

export const SEARCH_LIFE_MS = 60 * 24 * 3600 * 1000;

const fields = (q: BuyerQuery) => ({ query: q.query, terms: q.terms, maxPrice: q.maxPrice, meetup: q.meetup });

class SavedSearchRepository {
    countActive(userId: string, now: Date): Promise<number> {
        return SavedSearch.countDocuments({ userId, expiresAt: { $gt: now } }).exec();
    }

    findByUser(userId: string, now: Date): Promise<ISavedSearch[]> {
        return SavedSearch.find({ userId, expiresAt: { $gt: now } }).sort({ createdAt: 1 }).exec();
    }

    findById(id: string): Promise<ISavedSearch | null> {
        return SavedSearch.findById(id).exec();
    }

    findActive(now: Date): Promise<ISavedSearch[]> {
        return SavedSearch.find({ expiresAt: { $gt: now } }).exec();
    }

    countAllActive(now: Date): Promise<number> {
        return SavedSearch.countDocuments({ expiresAt: { $gt: now } }).exec();
    }

    // Only $setOnInsert: a double tap returns the existing row.
    upsert(userId: string, q: BuyerQuery, now: Date): Promise<ISavedSearch> {
        return SavedSearch.findOneAndUpdate(
            { userId, query: q.query },
            { $setOnInsert: { ...fields(q), createdAt: now, scannedAt: now, expiresAt: new Date(now.getTime() + SEARCH_LIFE_MS) } },
            { upsert: true, returnDocument: "after" }
        ).exec() as Promise<ISavedSearch>;
    }

    update(id: string, q: BuyerQuery, now: Date): Promise<ISavedSearch | null> {
        return SavedSearch.findByIdAndUpdate(id, { $set: { ...fields(q), scannedAt: now } }, { returnDocument: "after" }).exec();
    }

    async deleteOne(id: string, userId: string): Promise<boolean> {
        return (await SavedSearch.deleteOne({ _id: id, userId }).exec()).deletedCount === 1;
    }

    async deleteByUser(userId: string): Promise<number> {
        return (await SavedSearch.deleteMany({ userId }).exec()).deletedCount;
    }

    async setScanned(id: string, now: Date, alerted: boolean): Promise<void> {
        await SavedSearch.updateOne({ _id: id }, { $set: alerted ? { scannedAt: now, lastAlertAt: now } : { scannedAt: now } }).exec();
    }

    findDueRenewal(now: Date, until: Date, limit: number): Promise<ISavedSearch[]> {
        return SavedSearch.find({ expiresAt: { $gt: now, $lte: until }, renewOfferedAt: { $exists: false } }).limit(limit).exec();
    }

    async claimRenewOffer(id: string, now: Date): Promise<boolean> {
        return (await SavedSearch.updateOne({ _id: id, renewOfferedAt: { $exists: false } }, { $set: { renewOfferedAt: now } }).exec()).modifiedCount === 1;
    }

    async releaseRenewOffer(id: string): Promise<void> {
        await SavedSearch.updateOne({ _id: id }, { $unset: { renewOfferedAt: "" } }).exec();
    }

    renew(id: string, userId: string, now: Date): Promise<ISavedSearch | null> {
        return SavedSearch.findOneAndUpdate(
            { _id: id, userId },
            { $set: { expiresAt: new Date(now.getTime() + SEARCH_LIFE_MS) }, $unset: { renewOfferedAt: "" } },
            { returnDocument: "after" }
        ).exec();
    }
}

export default new SavedSearchRepository();
