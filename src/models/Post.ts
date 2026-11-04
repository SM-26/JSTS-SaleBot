import mongoose, { Schema, Document } from "mongoose";
import type { MessageEntity } from "node-telegram-bot-api/types";

export interface IMediaItem {
    fileId: string;
    type: "photo" | "video";
}

// Telegram's MessageEntity as stored (plain objects), only the fields we render.
export type StoredEntity = Pick<MessageEntity, "type" | "offset" | "length" | "url" | "user" | "language" | "custom_emoji_id">;

// Only the fields we store, as a plain object (also detaches Mongoose subdocuments).
export function storedEntity(e: MessageEntity): StoredEntity {
    const { type, offset, length, url, user, language, custom_emoji_id } = e;
    return JSON.parse(JSON.stringify({ type, offset, length, url, user, language, custom_emoji_id }));
}

export interface IPost extends Document {
    userId: string;
    status: "pending" | "approved" | "rejected" | "sold";
    price: string;
    title: string;
    description: string;
    descriptionEntities?: StoredEntity[];
    location: string;
    media: IMediaItem[];
    createdAt: Date;
    isExpired: boolean;
    lastBumpAt: Date | null;
    dailyBumpCount: number;
    approvedMessageId: number | null;
    moderationMessageId: number | null;
    rejectionReason?: string;
}

const mediaItemSchema = new Schema<IMediaItem>({
    fileId: { type: String, required: true },
    type: { type: String, enum: ["photo", "video"], required: true },
}, { _id: false });

// Shared with the Draft model. `user` is the raw Telegram User object.
export const entitySchema: Schema<StoredEntity> = new Schema<StoredEntity>({
    type: { type: String, required: true },
    offset: { type: Number, required: true },
    length: { type: Number, required: true },
    url: { type: String },
    user: { type: Schema.Types.Mixed },
    language: { type: String },
    custom_emoji_id: { type: String },
}, { _id: false });

const postSchema = new Schema<IPost>({
    userId: { type: String, required: true },
    status: { type: String, enum: ["pending", "approved", "rejected", "sold"], default: "pending" },
    price: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    // default undefined: absent (not []) unless the description had formatting.
    descriptionEntities: { type: [entitySchema], default: undefined },
    location: { type: String, default: "" },
    media: [mediaItemSchema],
    createdAt: { type: Date, default: Date.now },
    isExpired: { type: Boolean, default: false },
    lastBumpAt: { type: Date, default: null },
    dailyBumpCount: { type: Number, default: 0 },
    approvedMessageId: { type: Number, default: null },
    moderationMessageId: { type: Number, default: null },
    rejectionReason: { type: String, default: null },
});

export default mongoose.model<IPost>("Post", postSchema);
