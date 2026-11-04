import Draft, { IDraft, DraftStep } from "../models/Draft";
import type { IMediaItem } from "../models/Post";

export type DraftFields = Partial<Pick<IDraft, "step" | "title" | "description" | "descriptionEntities" | "price" | "location" | "promptMessageId" | "fixing">>;

/** `timeOut` is minutes from config.json; 0 (or less) means drafts never expire. */
export function isDraftExpired(draft: Pick<IDraft, "updatedAt">, timeOutMinutes: number, now = Date.now()): boolean {
    return timeOutMinutes > 0 && draft.updatedAt.getTime() + timeOutMinutes * 60_000 < now;
}

class DraftRepository {
    findByUserId(userId: string) {
        return Draft.findOne({ userId }).exec();
    }

    // Replaces any existing draft: one per user (unique index on userId).
    start(userId: string, chatId: number, locale: string, promptMessageId: number) {
        const now = new Date();
        return Draft.findOneAndUpdate(
            { userId },
            {
                $set: { chatId, locale, step: "title", media: [], promptMessageId, startedAt: now, updatedAt: now },
                $unset: { title: 1, description: 1, descriptionEntities: 1, price: 1, location: 1, fixing: 1 },
            },
            { upsert: true, returnDocument: "after" }
        ).exec();
    }

    // A field passed as `undefined` is removed from the document.
    update(userId: string, fields: DraftFields) {
        const $set: Record<string, unknown> = { updatedAt: new Date() };
        const $unset: Record<string, 1> = {};
        for (const [key, value] of Object.entries(fields)) {
            if (value === undefined) $unset[key] = 1;
            else $set[key] = value;
        }
        return Draft.findOneAndUpdate({ userId }, Object.keys($unset).length ? { $set, $unset } : { $set }, { returnDocument: "after" }).exec();
    }

    // ponytail: atomic $push, so an album burst (several updates at once) cannot lose items.
    pushMedia(userId: string, item: IMediaItem) {
        return Draft.findOneAndUpdate(
            { userId, step: "media" },
            { $push: { media: item }, $set: { updatedAt: new Date() } },
            { returnDocument: "after" }
        ).exec();
    }

    delete(userId: string): Promise<boolean> {
        return Draft.deleteOne({ userId }).exec().then(r => r.deletedCount > 0);
    }

    // Atomic take: only one of two concurrent Confirm/Cancel presses gets the draft.
    claim(userId: string, step: DraftStep, promptMessageId: number) {
        return Draft.findOneAndDelete({ userId, step, promptMessageId }).exec();
    }

    async deleteExpired(timeOutMinutes: number): Promise<number> {
        if (timeOutMinutes <= 0) return 0;
        const result = await Draft.deleteMany({ updatedAt: { $lt: new Date(Date.now() - timeOutMinutes * 60_000) } }).exec();
        return result.deletedCount;
    }

    findActiveUserIds(timeOutMinutes: number): Promise<string[]> {
        const live = timeOutMinutes > 0 ? { updatedAt: { $gte: new Date(Date.now() - timeOutMinutes * 60_000) } } : {};
        return Draft.distinct("userId", live).exec();
    }
}

export default new DraftRepository();
