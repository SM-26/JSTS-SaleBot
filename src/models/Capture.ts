import mongoose, { Schema, Document } from "mongoose";
import { entitySchema } from "./Post";
import type { IMediaItem, StoredEntity } from "./Post";
import type { Tier, Parsed } from "../services/classifier";

export type CaptureState = "open" | "closed" | "classified" | "asked" | "added" | "declined" | "ignored";

// One text-bearing message of the window; `text` is derived from these, in
// message-id order, so an edit can replace a single message's contribution.
export interface ICapturePart {
    messageId: number;
    text: string;
    entities?: StoredEntity[];
}

// One open posting window per sender in the sale topic, before any opt-in
// (collection `captures`). The only place a non-opted-in member's text is
// kept, and only for 7 days (TTL on lastAt).
export interface ICapture extends Document {
    chatId: number;
    senderId: string;
    senderName: string;
    messageIds: number[];
    mediaGroupIds: string[];
    parts: ICapturePart[];
    text: string;
    entities?: StoredEntity[]; // entities of the head text only
    media: IMediaItem[];
    firstAt: Date;
    lastAt: Date;
    state: CaptureState;
    classifyingAt?: Date;
    tier?: Tier;
    rules?: string[];
    parsed?: Parsed;
    note?: { ephemeralMessageId: number; sentAt: Date };
    listingId?: string;
}

const mediaItemSchema = new Schema<IMediaItem>({
    fileId: { type: String, required: true },
    type: { type: String, enum: ["photo", "video"], required: true },
}, { _id: false });

const partSchema = new Schema<ICapturePart>({
    messageId: { type: Number, required: true },
    text: { type: String, required: true },
    entities: { type: [entitySchema], default: undefined },
}, { _id: false });

const captureSchema = new Schema<ICapture>({
    chatId: { type: Number, required: true },
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    messageIds: { type: [Number], default: [] },
    mediaGroupIds: { type: [String], default: [] },
    parts: { type: [partSchema], default: [] },
    text: { type: String, default: "" },
    entities: { type: [entitySchema], default: undefined },
    media: { type: [mediaItemSchema], default: [] },
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
    state: { type: String, enum: ["open", "closed", "classified", "asked", "added", "declined", "ignored"], default: "open" },
    classifyingAt: { type: Date },
    tier: { type: String, enum: ["wtb", "strict", "ask", "none"] },
    rules: { type: [String], default: undefined },
    parsed: { type: Schema.Types.Mixed },
    note: { type: new Schema({ ephemeralMessageId: Number, sentAt: Date }, { _id: false }) },
    listingId: { type: String },
}, { collection: "captures", timestamps: false });

captureSchema.index({ lastAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
captureSchema.index({ chatId: 1, senderId: 1 }, { unique: true, partialFilterExpression: { state: "open" } });
captureSchema.index({ state: 1, lastAt: 1 });

export default mongoose.model<ICapture>("Capture", captureSchema);
