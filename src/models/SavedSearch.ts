import mongoose, { Schema, Document } from "mongoose";

// A buyer's standing "wanted" query (collection `saved_searches`). Holds the
// parsed query, never the original message. Expires by TTL on `expiresAt`.
export interface ISavedSearch extends Document {
    userId: string;
    query: string;
    terms: string[];
    maxPrice?: number;
    meetup?: boolean;
    createdAt: Date;
    expiresAt: Date;
    scannedAt: Date;
    lastAlertAt?: Date;
    renewOfferedAt?: Date;
}

const savedSearchSchema = new Schema<ISavedSearch>({
    userId: { type: String, required: true },
    query: { type: String, required: true },
    terms: { type: [String], default: [] },
    maxPrice: { type: Number },
    meetup: { type: Boolean },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    scannedAt: { type: Date, required: true },
    lastAlertAt: { type: Date },
    renewOfferedAt: { type: Date },
}, { collection: "saved_searches", timestamps: false });

savedSearchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
savedSearchSchema.index({ userId: 1, query: 1 }, { unique: true });

export default mongoose.model<ISavedSearch>("SavedSearch", savedSearchSchema);
