import mongoose, { Schema, Document } from "mongoose";

// One row per (saved search, listing) alert (collection `alert_log`): the
// unique pair is the "send once" claim; `ok: false` marks a failed send.
export interface IAlertLog extends Document {
    searchId: string;
    userId: string;
    listingId: string;
    sentAt: Date;
    ok: boolean;
}

const alertLogSchema = new Schema<IAlertLog>({
    searchId: { type: String, required: true },
    userId: { type: String, required: true },
    listingId: { type: String, required: true },
    sentAt: { type: Date, required: true },
    ok: { type: Boolean, default: true },
}, { collection: "alert_log", timestamps: false });

alertLogSchema.index({ searchId: 1, listingId: 1 }, { unique: true });
alertLogSchema.index({ userId: 1, listingId: 1 });
alertLogSchema.index({ sentAt: 1 });

export default mongoose.model<IAlertLog>("AlertLog", alertLogSchema);
