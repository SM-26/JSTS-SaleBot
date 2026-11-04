import mongoose, { Schema, Document } from "mongoose";
import type { IMediaItem } from "./Post";

// The market's unit of "something for sale" (collection `listings`), whether it
// came from a bot post or a group message. Additive: v1 never reads it.
export interface IListing extends Document {
    source: "bot" | "group";
    origin: "dm" | "capture" | "catchup" | "legacy";
    postId?: string;
    chatId?: number;
    messageIds: number[];
    sellerId: string;
    sellerName?: string;
    title?: string;
    price?: string;
    priceValue?: number;
    location?: string;
    text?: string;
    textHash?: string;
    media: IMediaItem[];
    status: "live" | "sold" | "expired" | "removed" | "taken_down";
    hold: boolean;
    isBundle: boolean;
    createdAt: Date;
    refreshedAt: Date;
    nudgedAt?: Date;
    endedAt?: Date;
    endedBy?: "seller" | "moderator" | "system";
    note?: { ephemeralMessageId: number; sentAt: Date };
}

const mediaItemSchema = new Schema<IMediaItem>({
    fileId: { type: String, required: true },
    type: { type: String, enum: ["photo", "video"], required: true },
}, { _id: false });

const listingSchema = new Schema<IListing>({
    source: { type: String, enum: ["bot", "group"], required: true },
    origin: { type: String, enum: ["dm", "capture", "catchup", "legacy"], required: true },
    postId: { type: String },
    chatId: { type: Number },
    messageIds: { type: [Number], default: [] },
    sellerId: { type: String, required: true },
    sellerName: { type: String },
    title: { type: String },
    price: { type: String },
    priceValue: { type: Number },
    location: { type: String },
    text: { type: String },
    textHash: { type: String },
    media: { type: [mediaItemSchema], default: [] },
    status: { type: String, enum: ["live", "sold", "expired", "removed", "taken_down"], default: "live" },
    hold: { type: Boolean, default: false },
    isBundle: { type: Boolean, default: false },
    createdAt: { type: Date, required: true },
    refreshedAt: { type: Date, required: true },
    nudgedAt: { type: Date },
    endedAt: { type: Date },
    endedBy: { type: String, enum: ["seller", "moderator", "system"] },
    note: { type: new Schema({ ephemeralMessageId: Number, sentAt: Date }, { _id: false }) },
}, { collection: "listings", timestamps: false });

listingSchema.index({ status: 1, refreshedAt: 1 });
listingSchema.index({ sellerId: 1, status: 1 });
listingSchema.index({ source: 1, postId: 1 }, { unique: true, partialFilterExpression: { postId: { $exists: true } } });
listingSchema.index({ chatId: 1, messageIds: 1 });

export default mongoose.model<IListing>("Listing", listingSchema);
