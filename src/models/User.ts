import mongoose, { Schema, Document } from "mongoose";
import { AuthLevel } from "../types";

export interface IUser extends Document {
    userId: string;
    firstName: string | null;
    lastName: string | null;
    userName: string | null;
    authLevel: AuthLevel;
    languageCode?: string;
    preferredLocale?: string;
}

const userSchema = new Schema<IUser>(
    {
        userId: { type: String, required: true, unique: true },
        firstName: { type: String, default: null },
        lastName: { type: String, default: null },
        userName: { type: String, default: null },
        authLevel: {
            type: Number,
            enum: [AuthLevel.USER, AuthLevel.MOD, AuthLevel.ADMIN],
            default: AuthLevel.USER,
            required: true,
        },
        languageCode: { type: String, default: null },
        preferredLocale: { type: String, default: null },
    },
    { timestamps: true, versionKey: false }
);

export default mongoose.model<IUser>("User", userSchema);
