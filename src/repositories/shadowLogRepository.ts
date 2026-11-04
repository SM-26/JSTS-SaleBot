import mongoose from "mongoose";
import ShadowLog, { IShadowLog, ShadowLogRow } from "../models/ShadowLog";
import type { Tier } from "../services/classifier";

export type ShadowStats = {
    byTier: Record<Tier, number>;
    wouldList: number;
    merges: number;
    labeled: number;
    sale: number;
    notSale: number;
};

class ShadowLogRepository {
    insert(row: ShadowLogRow): Promise<IShadowLog> {
        return ShadowLog.create(row);
    }

    // A random would-list row nobody has labeled yet, for /label (not `excludeId`: the row just skipped).
    async sampleUnlabeled(excludeId?: string): Promise<IShadowLog | null> {
        const [row] = await ShadowLog.aggregate([
            { $match: { wouldList: true, label: { $exists: false }, ...(excludeId ? { _id: { $ne: new mongoose.Types.ObjectId(excludeId) } } : {}) } },
            { $sample: { size: 1 } },
        ]).exec();
        return row ? ShadowLog.hydrate(row) : null;
    }

    // Only while unlabeled: the first label wins.
    setLabel(id: string, label: "sale" | "not_sale", by: string, now: Date): Promise<IShadowLog | null> {
        return ShadowLog.findOneAndUpdate(
            { _id: id, label: { $exists: false } },
            { $set: { label, labeledBy: by, labeledAt: now } },
            { returnDocument: "after" }
        ).exec();
    }

    async stats(since: Date): Promise<ShadowStats> {
        const out: ShadowStats = { byTier: { strict: 0, ask: 0, wtb: 0, none: 0 }, wouldList: 0, merges: 0, labeled: 0, sale: 0, notSale: 0 };
        const rows = await ShadowLog.aggregate<{ _id: Tier; n: number; wouldList: number; merges: number; labeled: number; sale: number; notSale: number }>([
            { $match: { at: { $gte: since } } },
            {
                $group: {
                    _id: "$tier",
                    n: { $sum: 1 },
                    wouldList: { $sum: { $cond: ["$wouldList", 1, 0] } },
                    merges: { $sum: { $cond: [{ $ifNull: ["$mergeWith", false] }, 1, 0] } },
                    labeled: { $sum: { $cond: [{ $ifNull: ["$label", false] }, 1, 0] } },
                    sale: { $sum: { $cond: [{ $eq: ["$label", "sale"] }, 1, 0] } },
                    notSale: { $sum: { $cond: [{ $eq: ["$label", "not_sale"] }, 1, 0] } },
                },
            },
        ]).exec();
        for (const r of rows) {
            out.byTier[r._id] = r.n;
            out.wouldList += r.wouldList;
            out.merges += r.merges;
            out.labeled += r.labeled;
            out.sale += r.sale;
            out.notSale += r.notSale;
        }
        return out;
    }

    lastRows(n: number): Promise<IShadowLog[]> {
        return ShadowLog.find().sort({ at: -1 }).limit(n).exec();
    }
}

export default new ShadowLogRepository();
