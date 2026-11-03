import mongoose from "mongoose";
import type { SessionStore, SessionWriteOptions } from "node-telegram-bot-api";

// Mongo backing store for node-telegram-bot-api's session middleware (collection `bot_sessions`).
//
// Additive: v1 code never touches this collection, so rolling back to v1 leaves
// it as harmless leftovers. Documents are exactly:
//   { _id: "<chatId>:<userId>", value: <envelope JSON, verbatim>, expiresAt: Date | null, updatedAt: Date }
// The store is string-in/string-out on purpose (the middleware owns the codec),
// so this uses the raw driver collection rather than a mongoose model.
//
// read() checks expiresAt itself: Mongo's TTL monitor only runs about every 60s,
// so an expired-but-unreaped session would otherwise be resurrected.

type SessionDoc = { _id: string; value: string; expiresAt: Date | null; updatedAt: Date };

const COLLECTION = "bot_sessions";

// 3-day idle TTL: garbage collection for abandoned sessions, refreshed by activity.
export const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60;

export class MongoSessionStore implements SessionStore {
    // Resolved lazily: the store is built before the connection is up.
    constructor(private readonly connection: mongoose.Connection = mongoose.connection) {}

    private get coll() {
        const db = this.connection.db;
        if (!db) throw new Error("[ERROR - MongoSessionStore] mongoose is not connected");
        return db.collection<SessionDoc>(COLLECTION);
    }

    private expiry(ttlSeconds?: number): Date | null {
        return ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : null;
    }

    async init(): Promise<void> {
        // createIndex is a no-op when the same index already exists.
        await this.coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    }

    async read(key: string): Promise<string | undefined> {
        const doc = await this.coll.findOne({ _id: key });
        if (!doc) return undefined;
        if (doc.expiresAt && doc.expiresAt.getTime() <= Date.now()) return undefined;
        return doc.value;
    }

    async write(key: string, value: string, options?: SessionWriteOptions): Promise<void> {
        await this.coll.updateOne(
            { _id: key },
            { $set: { value, expiresAt: this.expiry(options?.ttlSeconds), updatedAt: new Date() } },
            { upsert: true },
        );
    }

    async touch(key: string, ttlSeconds: number): Promise<void> {
        await this.coll.updateOne(
            { _id: key },
            { $set: { expiresAt: this.expiry(ttlSeconds), updatedAt: new Date() } },
        );
    }

    async delete(key: string): Promise<void> {
        await this.coll.deleteOne({ _id: key });
    }
}
