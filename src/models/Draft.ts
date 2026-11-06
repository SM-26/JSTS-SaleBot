import mongoose, { Schema, Document } from "mongoose";
import { entitySchema } from "./Post";
import type { IMediaItem, StoredEntity } from "./Post";

export type DraftStep = "title" | "description" | "price" | "location" | "media" | "confirm";

// One in-progress /newpost wizard per user (collection `drafts`). Additive:
// v1 never reads it. Expiry is evaluated against the live config.timeOut on
// every touch (see draftRepository), so there is deliberately no TTL index.
export interface IDraft extends Document {
    userId: string;
    chatId: number;
    locale: string;
    step: DraftStep;
    title?: string;
    description?: string;
    descriptionEntities?: StoredEntity[];
    price?: string;
    location?: string;
    media: IMediaItem[];
    promptMessageId: number;
    // Set while the seller re-enters a field that held a blocked word (see WizardService.previewOrFix).
    fixing?: boolean;
    // Set when the draft was started from a captured group message (opt-in note).
    captureId?: string;
    // Slice 5 (all optional, absent unless set): meeting point, quick one-message listing, album/caption collection.
    meetup?: boolean;
    quick?: boolean;
    collecting?: boolean;
    mediaGroupId?: string;
    caption?: string;
    // A caption-less photo waits for its text until this time (quickListing); gone once the text arrives or the time passes.
    awaitText?: Date;
    startedAt: Date;
    updatedAt: Date;
}

const mediaItemSchema = new Schema<IMediaItem>({
    fileId: { type: String, required: true },
    type: { type: String, enum: ["photo", "video"], required: true },
}, { _id: false });

const draftSchema = new Schema<IDraft>({
    userId: { type: String, required: true, unique: true },
    chatId: { type: Number, required: true },
    locale: { type: String, required: true },
    step: { type: String, enum: ["title", "description", "price", "location", "media", "confirm"], required: true },
    title: { type: String },
    description: { type: String },
    descriptionEntities: { type: [entitySchema], default: undefined },
    price: { type: String },
    location: { type: String },
    media: { type: [mediaItemSchema], default: [] },
    promptMessageId: { type: Number, required: true },
    fixing: { type: Boolean, default: undefined },
    captureId: { type: String },
    meetup: { type: Boolean },
    quick: { type: Boolean },
    collecting: { type: Boolean },
    mediaGroupId: { type: String },
    caption: { type: String },
    awaitText: { type: Date },
    startedAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
}, { timestamps: false });

export default mongoose.model<IDraft>("Draft", draftSchema);
