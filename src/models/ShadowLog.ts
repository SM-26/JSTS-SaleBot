import mongoose, { Schema, Document } from "mongoose";
import type { Tier } from "../services/classifier";

// What automatic capture would have done (collection `shadow_log`). No member
// text: only ids, the tier, the rule names and the parsed title/price, which
// /label shows. Expires after 120 days.
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
    parsedTitle?: string;
    parsedPrice?: string;
    label?: "sale" | "not_sale";
    labeledBy?: string;
    labeledAt?: Date;
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
    parsedTitle: { type: String },
    parsedPrice: { type: String },
    label: { type: String, enum: ["sale", "not_sale"] },
    labeledBy: { type: String },
    labeledAt: { type: Date },
}, { collection: "shadow_log", timestamps: false });

shadowLogSchema.index({ at: 1 }, { expireAfterSeconds: 120 * 24 * 3600 });

export default mongoose.model<IShadowLog>("ShadowLog", shadowLogSchema);
