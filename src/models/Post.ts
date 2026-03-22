import mongoose, { Schema, Document } from "mongoose";

export interface IMediaItem {
    fileId: string;
    type: "photo" | "video";
}

export interface IPost extends Document {
    userId: string;
    status: "pending" | "approved" | "rejected" | "sold";
    price: number;
    title: string;
    description: string;
    location: string;
    media: IMediaItem[];
    createdAt: Date;
    isExpired: boolean;
    lastBumpAt: Date | null;
    dailyBumpCount: number;
}

const mediaItemSchema = new Schema<IMediaItem>({
    fileId: { type: String, required: true },
    type: { type: String, enum: ["photo", "video"], required: true },
}, { _id: false });

const postSchema = new Schema<IPost>({
    userId: { type: String, required: true },
    status: { type: String, enum: ["pending", "approved", "rejected", "sold"], default: "pending" },
    price: { type: Number, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    location: { type: String, default: "" },
    media: [mediaItemSchema],
    createdAt: { type: Date, default: Date.now },
    isExpired: { type: Boolean, default: false },
    lastBumpAt: { type: Date, default: null },
    dailyBumpCount: { type: Number, default: 0 },
});

export default mongoose.model<IPost>("Post", postSchema);
