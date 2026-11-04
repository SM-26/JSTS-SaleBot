import assert from "assert";
import mongoose from "mongoose";
import Capture from "../models/Capture";
import Listing from "../models/Listing";
import Member from "../models/Member";
import PostModel from "../models/Post";
import ShadowLog from "../models/ShadowLog";
import captureRepository from "../repositories/captureRepository";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import shadowLogRepository from "../repositories/shadowLogRepository";
import { LEGACY_CUTOFF, reconcileBotListings } from "../services/marketService";
import type { Post } from "../types";

// Market collections (slice 0). Needs a real Mongo: the guarantees under test
// are atomic updates and index behaviour (TTL, partial unique), which a mock
// would not exercise. Throwaway database only: the capture checks clear the
// whole `captures` collection so leftover rows cannot be claimed by accident.
const MONGO_URI = process.env.MONGO_URI;
const RUN = `mkt-${Date.now()}`;
const CHAT = -1000000000 - (Date.now() % 1000000);
const SEC = 1000;

async function run() {
    if (!MONGO_URI) {
        console.log("[SKIP] checkMarket: set MONGO_URI to run this test.");
        return;
    }
    console.log("[INFO] Checking market collections...");
    await mongoose.connect(MONGO_URI);
    assert.ok(/test/i.test(mongoose.connection.name), `refusing to run on database "${mongoose.connection.name}" (name must contain "test")`);

    try {
        await Capture.deleteMany({});

        // indexes exist
        await Promise.all([Capture.syncIndexes(), ShadowLog.syncIndexes(), Listing.syncIndexes(), Member.syncIndexes()]);
        const capIdx = await Capture.collection.indexes();
        const ttl = capIdx.find(i => i.key.lastAt === 1);
        assert.strictEqual(ttl?.expireAfterSeconds, 604800, "captures TTL on lastAt must be 7 days");
        const uniq = capIdx.find(i => i.unique && i.key.chatId === 1 && i.key.senderId === 1);
        assert.deepStrictEqual(uniq?.partialFilterExpression, { state: "open" }, "captures: one open window per sender");
        const shadowIdx = await ShadowLog.collection.indexes();
        assert.strictEqual(shadowIdx.find(i => i.key.at === 1)?.expireAfterSeconds, 10368000, "shadow_log TTL must be 120 days");
        const listIdx = await Listing.collection.indexes();
        const postUniq = listIdx.find(i => i.unique && i.key.source === 1 && i.key.postId === 1);
        assert.ok(postUniq?.partialFilterExpression, "listings {source,postId} must be partial unique");
        console.log("[OK] indexes exist.");

        // album then separate text joins one window
        const t0 = new Date();
        const at = (s: number) => new Date(t0.getTime() + s * SEC);
        const base = { chatId: CHAT, senderId: `${RUN}-a`, senderName: "A" };
        await captureRepository.appendMessage({ ...base, messageId: 1, media: [{ fileId: "f1", type: "photo" }], mediaGroupId: "g1" }, at(0));
        await captureRepository.appendMessage({ ...base, messageId: 2, media: [{ fileId: "f2", type: "photo" }], mediaGroupId: "g1" }, at(1));
        const joined = await captureRepository.appendMessage({ ...base, messageId: 3, text: "Selling a thing 100", media: [] }, at(40));
        assert.strictEqual(joined.messageIds.length, 3);
        assert.strictEqual(joined.media.length, 2);
        assert.strictEqual(joined.text, "Selling a thing 100");
        assert.strictEqual(await Capture.countDocuments({ senderId: base.senderId }), 1, "one capture for the album + text");
        const withMore = await captureRepository.appendMessage({ ...base, messageId: 4, text: "second line", media: [] }, at(50));
        assert.strictEqual(withMore.text, "Selling a thing 100\nsecond line", "first text stays the head, later text appends");
        console.log("[OK] album then separate text joins one window.");

        // new window after 90 s
        const b = { chatId: CHAT, senderId: `${RUN}-b`, senderName: "B" };
        const first = await captureRepository.appendMessage({ ...b, messageId: 10, text: "one", media: [] }, at(0));
        const second = await captureRepository.appendMessage({ ...b, messageId: 11, text: "two", media: [] }, at(95));
        assert.notStrictEqual(String(first._id), String(second._id));
        assert.strictEqual((await Capture.findById(first._id))!.state, "closed");
        assert.strictEqual(second.state, "open");
        console.log("[OK] new window after 90 s.");

        // concurrent album items
        const c = { chatId: CHAT, senderId: `${RUN}-c`, senderName: "C" };
        await Promise.all([20, 21, 22, 23, 24].map(id =>
            captureRepository.appendMessage({ ...c, messageId: id, media: [{ fileId: `f${id}`, type: "photo" }], mediaGroupId: "g2" }, at(0))));
        const albums = await Capture.find({ senderId: c.senderId });
        assert.strictEqual(albums.length, 1, "concurrent album items must land in one capture");
        assert.strictEqual(albums[0].messageIds.length, 5);
        assert.strictEqual(albums[0].media.length, 5);
        console.log("[OK] concurrent album items.");

        // user values in the pipeline update are data, not field paths
        const e = { chatId: CHAT, senderId: `${RUN}-e`, senderName: "E" };
        await captureRepository.appendMessage({ ...e, messageId: 40, text: "hello", media: [] }, at(0));
        for (const [i, name] of ["$$$ Deals", "$text", "$"].entries()) {
            const r = await captureRepository.appendMessage({ ...e, senderName: name, messageId: 41 + i, media: [], mediaGroupId: `$g${i}` }, at(1 + i));
            assert.strictEqual(r.senderName, name, "senderName is stored verbatim");
            assert.ok(r.mediaGroupIds.includes(`$g${i}`));
        }
        assert.strictEqual((await Capture.findOne({ senderId: e.senderId }))!.text, "hello");

        // lastAt never moves backwards; a redelivered messageId is a no-op
        const lateFirst = await captureRepository.appendMessage({ ...e, messageId: 60, media: [{ fileId: "late", type: "photo" }] }, at(20));
        const earlier = await captureRepository.appendMessage({ ...e, messageId: 61, media: [] }, at(10));
        assert.strictEqual(earlier.lastAt.getTime(), lateFirst.lastAt.getTime(), "lastAt must not move backwards");
        const redelivered = await captureRepository.appendMessage({ ...e, messageId: 60, media: [{ fileId: "late", type: "photo" }] }, at(21));
        assert.strictEqual(redelivered.messageIds.filter(m => m === 60).length, 1, "same messageId twice: one id");
        assert.strictEqual(redelivered.media.filter(m => m.fileId === "late").length, 1, "same messageId twice: one media item");
        console.log("[OK] pipeline values are literal, lastAt monotonic, redelivery is a no-op.");

        // edit replaces that message's text in an open capture
        const edited = await captureRepository.reparseOpen(CHAT, 3, "new text");
        assert.strictEqual(edited?.text, "new text\nsecond line");
        assert.strictEqual(await captureRepository.reparseOpen(CHAT, 999, "x"), null, "unknown message: nothing to reparse");
        console.log("[OK] reparseOpen.");

        const dollar = await captureRepository.appendMessage({ ...c, messageId: 25, text: "$price", media: [] }, at(1));
        assert.strictEqual(dollar.text, "$price", "text starting with $ is data, not a field path");

        // claimDue timing (clean slate: only this capture is open)
        await Capture.deleteMany({});
        const d = { chatId: CHAT, senderId: `${RUN}-d`, senderName: "D" };
        await captureRepository.appendMessage({ ...d, messageId: 30, text: "x", media: [] }, at(0));
        assert.strictEqual(await captureRepository.claimDue(at(29)), null, "not due at +29 s");
        const due = await captureRepository.claimDue(at(30));
        assert.ok(due, "due at +30 s");
        assert.strictEqual(due.state, "closed");
        assert.strictEqual(await captureRepository.claimDue(at(31)), null, "second claim is empty");
        console.log("[OK] claimDue timing.");

        // two sweeps claim once (the capture from above is closed with no tier)
        const claims = await Promise.all([captureRepository.claimClosed(), captureRepository.claimClosed()]);
        const won = claims.filter(Boolean);
        assert.strictEqual(won.length, 1, "exactly one sweeper wins");
        await captureRepository.saveClassification(String(won[0]!._id), "ask", ["r1"], { isBundle: false, title: "x" });
        const classified = await Capture.findById(won[0]!._id);
        assert.strictEqual(classified!.state, "classified");
        assert.strictEqual(classified!.tier, "ask");
        assert.strictEqual(await captureRepository.claimClosed(), null, "classified captures are not claimed again");
        console.log("[OK] two sweeps claim once.");

        // member touch keeps askMode
        const uid = `${RUN}-m`;
        await memberRepository.touch(uid, t0);
        await Member.updateOne({ userId: uid }, { $set: { askMode: "never" } });
        await memberRepository.touch(uid, at(60));
        const member = await Member.findOne({ userId: uid });
        assert.strictEqual(member!.askMode, "never");
        assert.strictEqual(member!.firstSeenAt.getTime(), t0.getTime());
        console.log("[OK] member touch keeps askMode.");

        // listings from a post
        const post = { _id: `${RUN}-post`, userId: `${RUN}-s`, title: "Gear", description: "Good shape", price: "100", location: "TLV", media: [{ fileId: "p1", type: "photo" }], createdAt: t0, status: "approved" } as Post;
        const listing = await listingRepository.createForPost(post, "dm", false, t0);
        assert.strictEqual(listing.source, "bot");
        assert.strictEqual(listing.status, "live");
        assert.strictEqual(listing.text, "Gear\nGood shape");
        assert.ok(listing.textHash);
        assert.strictEqual(listing.priceValue, 100);
        for (const [price, want] of [["2,500", 2500], ["3000 טיפה גמיש", 3000], ["מחיר לא ידוע", undefined]] as const) {
            const l = await listingRepository.createForPost({ ...post, _id: `${RUN}-pv-${price}`, price }, "dm", false, t0);
            assert.strictEqual(l.priceValue, want, `priceValue of "${price}"`);
        }
        const again = await listingRepository.createForPost(post, "dm", false, at(5));
        assert.strictEqual(String(again._id), String(listing._id), "createForPost is idempotent per post");
        assert.strictEqual((await listingRepository.findByPostId(post._id as string))!.title, "Gear");
        assert.ok((await listingRepository.findLiveForMatching()).some(l => String(l._id) === String(listing._id)));
        assert.ok((await listingRepository.findSellerRecent(post.userId, new Date(t0.getTime() - SEC))).some(l => String(l._id) === String(listing._id)));
        const sold = await listingRepository.markSold(String(listing._id), at(10));
        assert.strictEqual(sold?.status, "sold");
        assert.strictEqual(await listingRepository.markSold(String(listing._id), at(11)), null, "sold is final");
        assert.ok((await listingRepository.countByStatus(new Date(t0.getTime() - SEC))).sold >= 1);
        console.log("[OK] listings.");

        // reconcile posts -> bot listings (clean slate: it walks every approved/sold post)
        await Promise.all([PostModel.deleteMany({}), Listing.deleteMany({})]);
        const mk = (name: string, createdAt: Date, status: "approved" | "sold" | "pending") =>
            PostModel.create({ userId: `${RUN}-r-${name}`, title: name, description: "d", price: "10", location: "TLV", media: [], createdAt, status });
        const oldPost = await mk("old", new Date("2026-09-09T00:00:00Z"), "approved");
        const newPost = await mk("new", new Date(LEGACY_CUTOFF.getTime() + SEC), "approved");
        await mk("pending", new Date("2026-09-09T00:00:00Z"), "pending");
        const soldOld = await mk("soldold", new Date("2026-09-09T00:00:00Z"), "sold");
        const r1 = await reconcileBotListings(t0);
        assert.deepStrictEqual(r1, { created: 3, sold: 1 }, "pending posts get no listing; sold-at-creation posts end sold");
        const oldL = await listingRepository.findByPostId(String(oldPost._id));
        assert.ok(oldL && oldL.origin === "legacy" && oldL.hold === true && oldL.status === "live", "reconcile creates legacy hold");
        const newL = await listingRepository.findByPostId(String(newPost._id));
        assert.ok(newL && newL.origin === "dm" && newL.hold === false && newL.status === "live", "reconcile new post not held");
        const soldL = await listingRepository.findByPostId(String(soldOld._id));
        assert.ok(soldL && soldL.origin === "legacy" && soldL.hold === false && soldL.status === "sold", "sold legacy post: no hold, sold");
        await PostModel.updateOne({ _id: newPost._id }, { $set: { status: "sold" } });
        assert.deepStrictEqual(await reconcileBotListings(at(1)), { created: 0, sold: 1 });
        assert.strictEqual((await listingRepository.findByPostId(String(newPost._id)))!.status, "sold", "reconcile sold");
        assert.deepStrictEqual(await reconcileBotListings(at(2)), { created: 0, sold: 0 }, "reconcile idempotent");
        assert.strictEqual(await Listing.countDocuments({ source: "bot" }), 3, "one listing per post");
        console.log("[OK] reconcile.");

        // fail closed: an undated post is legacy and held, never a fresh dm listing
        const undated = await mk("undated", new Date("2026-09-09T00:00:00Z"), "approved");
        await PostModel.collection.updateOne({ _id: undated._id }, { $unset: { createdAt: "" } });
        // an expired listing whose post is sold ends sold
        const expPost = await mk("expired", new Date("2026-09-09T00:00:00Z"), "approved");
        await reconcileBotListings(at(3));
        const undatedL = await listingRepository.findByPostId(String(undated._id));
        assert.ok(undatedL && undatedL.origin === "legacy" && undatedL.hold === true, "undated post reconciles to legacy hold");
        const expL = (await listingRepository.findByPostId(String(expPost._id)))!;
        await Listing.updateOne({ _id: expL._id }, { $set: { status: "expired" } });
        await PostModel.updateOne({ _id: expPost._id }, { $set: { status: "sold" } });
        assert.deepStrictEqual(await reconcileBotListings(at(4)), { created: 0, sold: 1 });
        assert.strictEqual((await listingRepository.findByPostId(String(expPost._id)))!.status, "sold", "expired listing of a sold post becomes sold");

        // one bad post (media: null makes createForPost throw) does not abort the run
        const bad = await mk("bad", new Date("2026-09-09T00:00:00Z"), "sold");
        await PostModel.collection.updateOne({ _id: bad._id }, { $set: { media: null } });
        const good = await mk("good", new Date("2026-09-09T00:00:00Z"), "approved");
        const realError = console.error;
        const logged: string[] = [];
        console.error = (...a: unknown[]) => { logged.push(a.join(" ")); };
        try {
            assert.deepStrictEqual(await reconcileBotListings(at(5)), { created: 1, sold: 0 });
        } finally {
            console.error = realError;
        }
        assert.ok(await listingRepository.findByPostId(String(good._id)), "a later post still gets its listing");
        assert.strictEqual(await listingRepository.findByPostId(String(bad._id)), null);
        assert.ok(logged.some(l => l.includes("[ERROR - reconcileBotListings]") && l.includes(String(bad._id))), "the bad post is logged");
        console.log("[OK] reconcile fail-closed and per-post isolation.");

        // shadow log
        const row = await shadowLogRepository.insert({ chatId: CHAT, messageIds: [1], senderId: `${RUN}-x`, at: t0, tier: "strict", rules: ["r"], wouldList: true, parsedTitle: "t", parsedPrice: "5" });
        assert.ok(await shadowLogRepository.sampleUnlabeled(), "an unlabeled would-list row exists");
        const labeled = await shadowLogRepository.setLabel(String(row._id), "sale", "mod1", at(1));
        assert.strictEqual(labeled?.label, "sale");
        assert.strictEqual(await shadowLogRepository.setLabel(String(row._id), "not_sale", "mod2", at(2)), null, "labels are set once");
        const stats = await shadowLogRepository.stats(new Date(t0.getTime() - SEC));
        assert.ok(stats.byTier.strict >= 1 && stats.wouldList >= 1 && stats.labeled >= 1 && stats.sale >= 1);
        assert.strictEqual(typeof stats.byTier.none, "number");
        assert.strictEqual((await shadowLogRepository.lastRows(1)).length, 1);
        console.log("[OK] shadow log.");
    } finally {
        const like = new RegExp(`^${RUN}`);
        await Promise.all([
            Capture.deleteMany({ chatId: CHAT }),
            Listing.deleteMany({ sellerId: like }),
            PostModel.deleteMany({ userId: like }),
            Member.deleteMany({ userId: like }),
            ShadowLog.deleteMany({ chatId: CHAT }),
        ]);
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkMarket failed:", err);
    process.exit(1);
});
