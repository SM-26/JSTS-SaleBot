import assert from "assert";
import mongoose from "mongoose";
import { Bot, createSession } from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api";
import { MongoSessionStore, SESSION_TTL_SECONDS } from "../repositories/sessionStore";
import { idle } from "./harness";

// Guards the Mongo-backed session store: the contract (read/write/touch/delete/
// init, expiry) and, through the real node-telegram-bot-api session middleware, the two things
// the migration depends on -- sessions survive a restart, and a burst of
// updates for one key (an album) is serialized rather than losing writes.
// Needs a real Mongo for the same reason as checkModerationClaim.
const MONGO_URI = process.env.MONGO_URI;

// Unique per run, so we only ever touch (and clean up) our own documents.
const PREFIX = `check-store-${process.pid}-${Date.now()}:`;
const KEY = `${PREFIX}1`;

type Counter = { count: number; items: number[] };

// v2 posts form-encoded bodies and only needs an ok envelope back.
const fakeFetch = async () =>
    new Response(JSON.stringify({ ok: true, result: true }), { headers: { "content-type": "application/json" } });

function makeBot(store: MongoSessionStore) {
    const bot = new Bot("123:fake", { fetch: fakeFetch as typeof fetch });
    const session = createSession<Counter>({
        store,
        ttlSeconds: SESSION_TTL_SECONDS,
        getSessionKey: (ctx) => (ctx.chat && ctx.from ? `${PREFIX}${ctx.chat.id}:${ctx.from.id}` : undefined),
        initial: () => ({ count: 0, items: [] }),
    });
    bot.use(session);
    bot.use(async (ctx) => {
        const data = ctx.getSession<Counter>().data;
        data.count++;
        data.items.push(ctx.update.update_id);
    });
    return { bot, session };
}

function message(updateId: number, chatId: number, userId: number): Update {
    return {
        update_id: updateId,
        message: {
            message_id: updateId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private", first_name: "t" },
            from: { id: userId, is_bot: false, first_name: "t" },
            text: "hi",
        },
    } as Update;
}

async function run() {
    if (!MONGO_URI) {
        console.log("[SKIP] checkSessionStore: set MONGO_URI to run this test.");
        return;
    }

    console.log("[INFO] Checking Mongo session store...");
    await mongoose.connect(MONGO_URI);

    // idle() must wait for a read still opening its pool connection: connect() leaves one, so the second of a pair opens its own.
    let pingsDone = 0;
    for (let n = 0; n < 2; n++) void mongoose.connection.db!.command({ ping: 1 }).then(() => { pingsDone++; });
    await idle();
    assert.strictEqual(pingsDone, 2, "idle() returned while a read was waiting for a pool connection");

    const coll = mongoose.connection.db!.collection<{ _id: string; value: string; expiresAt: Date | null; updatedAt: Date }>(
        "bot_sessions",
    );
    const store = new MongoSessionStore();

    try {
        await store.init();
        await store.init(); // idempotent
        const indexes = await coll.indexes();
        const ttl = indexes.find((i) => i.key.expiresAt === 1);
        assert.ok(ttl, "init must create an index on expiresAt");
        assert.strictEqual(ttl.expireAfterSeconds, 0, "the TTL index must use expireAfterSeconds: 0");
        console.log("[OK] init creates the TTL index and is idempotent.");

        assert.strictEqual(await store.read(KEY), undefined, "a missing key reads as undefined");

        await store.write(KEY, '{"v":1,"data":{}}', { ttlSeconds: 100 });
        assert.strictEqual(await store.read(KEY), '{"v":1,"data":{}}', "write then read round-trips verbatim");
        let doc = await coll.findOne({ _id: KEY });
        const drift = Math.abs(doc!.expiresAt!.getTime() - (Date.now() + 100_000));
        assert.ok(drift < 5000, `expiresAt should be about now+ttl, off by ${drift}ms`);
        assert.ok(doc!.updatedAt instanceof Date, "updatedAt must be set");

        await store.write(KEY, "x");
        doc = await coll.findOne({ _id: KEY });
        assert.strictEqual(doc!.expiresAt, null, "a write without ttl stores expiresAt: null");

        await store.touch(KEY, 500);
        doc = await coll.findOne({ _id: KEY });
        assert.ok(Math.abs(doc!.expiresAt!.getTime() - (Date.now() + 500_000)) < 5000, "touch moves expiresAt");
        assert.strictEqual(doc!.value, "x", "touch must not change the value");

        await coll.updateOne({ _id: KEY }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        assert.strictEqual(await store.read(KEY), undefined, "an expired-but-unreaped doc must read as undefined");

        await store.write(KEY, "y", { ttlSeconds: 100 });
        await store.delete(KEY);
        assert.strictEqual(await store.read(KEY), undefined, "delete removes the doc");
        console.log("[OK] read/write/touch/expiry/delete behave.");

        // Restart survival: two bots, sharing nothing but Mongo.
        const a = makeBot(store);
        await a.bot.handleUpdate(message(1, 42, 7));
        await a.bot.close();

        const stored = await coll.findOne({ _id: `${PREFIX}42:7` });
        assert.ok(stored, "the session must be persisted under <chatId>:<userId>");
        const envelope = JSON.parse(stored.value) as { v: number; data: Counter };
        assert.strictEqual(envelope.v, 1, "envelope carries v");
        assert.strictEqual(envelope.data.count, 1, "envelope carries data");

        const b = makeBot(new MongoSessionStore());
        await b.bot.handleUpdate(message(2, 42, 7));
        const afterB = JSON.parse((await coll.findOne({ _id: `${PREFIX}42:7` }))!.value) as { data: Counter };
        assert.strictEqual(afterB.data.count, 2, "a fresh bot must continue from the persisted count");
        await b.bot.handleUpdate(message(3, 42, 7));
        const afterB2 = JSON.parse((await coll.findOne({ _id: `${PREFIX}42:7` }))!.value) as { data: Counter };
        assert.strictEqual(afterB2.data.count, 3, "and keep counting");
        console.log("[OK] session survives a bot restart.");

        // Burst for one key (album): the per-key lock must keep all writes.
        await Promise.all([10, 11, 12, 13, 14].map((id) => b.bot.handleUpdate(message(id, 99, 7))));
        const burst = JSON.parse((await coll.findOne({ _id: `${PREFIX}99:7` }))!.value) as { data: Counter };
        assert.strictEqual(burst.data.items.length, 5, `all 5 concurrent updates must land, got ${burst.data.items.length}`);
        assert.strictEqual(burst.data.count, 5, "count must reflect all 5 updates");
        console.log("[OK] concurrent updates for one key are serialized.");
        await b.bot.close();
    } finally {
        await coll.deleteMany({ _id: { $regex: `^${PREFIX}` } });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkSessionStore failed:", err);
    process.exit(1);
});
