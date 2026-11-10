import mongoose, { Schema, Document } from "mongoose";
import type { Tier } from "../services/classifier";

// What automatic capture would have done (collection `shadow_log`). No member
// text: only ids, the tier, the rule names and, for would-list rows, the
// parsed price number (/label shows it; the labeler reads the original in the
// group). Expires after 120 days.
export interface ShadowLogRow {
    chatId: number;
    messageIds: number[];
    senderId: string;
    at: Date;
    tier: Tier;
    rules: string[];
    wouldList: boolean;
    mergeWith?: string;
    matches?: string[];
    parsedPriceValue?: number;
    label?: "sale" | "not_sale" | "gone"; // gone: the group post was deleted, so it cannot be labeled
    labeledBy?: string;
    labeledAt?: Date;
    matchLabel?: "useful" | "not_useful";
    matchLabeledBy?: string;
    matchLabeledAt?: Date;
    buyerNoteAt?: Date;
}

export interface IShadowLog extends Document, ShadowLogRow {}

const shadowLogSchema = new Schema<IShadowLog>({
    chatId: { type: Number, required: true },
    messageIds: { type: [Number], default: [] },
    senderId: { type: String, required: true },
    at: { type: Date, required: true },
    tier: { type: String, enum: ["wtb", "strict", "ask", "none"], required: true },
    rules: { type: [String], default: [] },
    wouldList: { type: Boolean, required: true },
    mergeWith: { type: String },
    matches: { type: [String], default: undefined },
    parsedPriceValue: { type: Number },
    label: { type: String, enum: ["sale", "not_sale", "gone"] },
    labeledBy: { type: String },
    labeledAt: { type: Date },
    matchLabel: { type: String, enum: ["useful", "not_useful"] },
    matchLabeledBy: { type: String },
    matchLabeledAt: { type: Date },
    buyerNoteAt: { type: Date },
}, { collection: "shadow_log", timestamps: false });

shadowLogSchema.index({ at: 1 }, { expireAfterSeconds: 120 * 24 * 3600 });

export default mongoose.model<IShadowLog>("ShadowLog", shadowLogSchema);
