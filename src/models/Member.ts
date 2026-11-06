import mongoose, { Schema, Document } from "mongoose";

// Group members the bot has seen, whether or not they started the bot
// (collection `members`). Never feeds /broadcastUsers: these people may not be
// DM-able. `pendingCatchup` holds the catch-up offer's items (shape owned by
// the catch-up flow).
export interface IMember extends Document {
    userId: string;
    firstSeenAt: Date;
    askMode: "ask" | "never";
    lastNoteAt?: Date;
    lastBuyerNoteAt?: Date;
    // Texts a note was sent for (newest last, at most 20, kept 30 days): a repost of one gets no new note. Name kept from when it only held declines.
    declined?: { hash: string; at: Date }[];
    pendingCatchup?: Record<string, unknown>[];
}

const memberSchema = new Schema<IMember>({
    userId: { type: String, required: true, unique: true },
    firstSeenAt: { type: Date, required: true },
    askMode: { type: String, enum: ["ask", "never"], default: "ask" },
    lastNoteAt: { type: Date },
    lastBuyerNoteAt: { type: Date },
    declined: { type: [new Schema({ hash: String, at: Date }, { _id: false })], default: undefined },
    pendingCatchup: { type: [Schema.Types.Mixed], default: undefined },
}, { collection: "members", timestamps: false });

export default mongoose.model<IMember>("Member", memberSchema);
