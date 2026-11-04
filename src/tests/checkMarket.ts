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
import { rankMatches } from "../services/matchService";
import { tick } from "../services/shadowService";
import { startSweeper } from "../services/sweeper";
import type { BotConfig, Post } from "../types";

// Market collections (slice 0). Needs a real Mongo: the guarantees under test
// are atomic updates and index behaviour (TTL, partial unique), which a mock
// would not exercise. Throwaway database only: the capture checks clear the
// whole `captures` collection so leftover rows cannot be claimed by accident.
const MONGO_URI = process.env.MONGO_URI;
const RUN = `mkt-${Date.now()}`;
const CHAT = -1000000000 - (Date.now() % 1000000);
const SEC = 1000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Pure checks (no Mongo): the scheduler and the WTB ranking.
async function checkPure() {
    // a failing job does not stop the scheduler; stop() halts it
    let ran = 0;
    let threw = false;
    const realError = console.error;
    console.error = () => {};
    try {
        const s = startSweeper([{ name: "flaky", everyMs: 50, run: async () => { if (!threw) { threw = true; throw new Error("boom"); } ran++; } }]);
        await sleep(125);
        s.stop();
        const seen = ran;
        assert.ok(seen >= 1, "the job ran again after throwing once");
        await sleep(150);
        assert.strictEqual(ran, seen, "stop() halts the job");
    } finally {
        console.error = realError;
    }
    let active = 0;
    let maxActive = 0;
    const slow = startSweeper([{ name: "slow", everyMs: 20, run: async () => { active++; maxActive = Math.max(maxActive, active); await sleep(90); active--; } }]);
    await sleep(200);
    slow.stop();
    await sleep(100);
    assert.strictEqual(maxActive, 1, "a job never overlaps itself");
    console.log("[OK] sweeper survives a throwing job, stops, never overlaps.");

    const L = (id: string, text: string, priceValue: number | undefined, ageSec: number) =>
        ({ _id: id, title: undefined, text, priceValue, refreshedAt: new Date(1_000_000_000_000 - ageSec * SEC) }) as unknown as Parameters<typeof rankMatches>[1][number]; // string ids: only String(_id) is read
    const glock = L("glock", "גלוק 17 במצב טוב", 700, 0);
    assert.deepStrictEqual(rankMatches("מחפש glock", [glock, L("other", "תיק גב", 50, 0)]), ["glock"], "alias matches across scripts; no strong token, no match");
    assert.deepStrictEqual(rankMatches("מחפש glock 17 עד 800", [glock, L("dear", "glock 17 מצוין", 900, 0), L("noprice", "glock 17", undefined, 0)]), ["glock"], "ceiling filters on priceValue");
    assert.deepStrictEqual(rankMatches("מחפש glock 17 עד 1,000", [L("dear", "glock 17 מצוין", 900, 0)]), ["dear"], "ceiling with a thousands comma");
    const many = Array.from({ length: 8 }, (_, i) => L(`m${i}`, "glock 17", 100, i));
    assert.strictEqual(rankMatches("מחפש glock", many).length, 5, "at most 5");
    assert.strictEqual(rankMatches("מחפש glock", many, 2).length, 2, "max is a parameter");
    assert.deepStrictEqual(rankMatches("מחפש את זה", many), [], "stop words only: nothing");
    assert.deepStrictEqual(rankMatches("מחפש תיק", [L("bag", "תיק גב", 50, 0)]), [], "no strong token: nothing");
    assert.deepStrictEqual(rankMatches("מחפש glock 17", [L("old", "glock 17", 1, 100), L("fresh", "glock 17", 1, 0), L("older", "glock 17", 1, 200)]), ["fresh", "old", "older"], "equal overlap: newest refresh first");
    assert.deepStrictEqual(rankMatches("מחפש glock 17 מצוין", [L("partial", "glock 17 תיק נרתיק", 1, 0), L("full", "glock 17 מצוין", 1, 500)]), ["full", "partial"], "higher overlap first, even if older");
    console.log("[OK] rankMatches.");
}

async function run() {
    await checkPure();
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

        // a listing keeps its post's dates: a 100-day-old post is not "recent" and cannot be a repost target
        const DAY = 24 * 3600 * SEC;
        const liveSince = async (since: Date) => (await listingRepository.countByStatus(since)).live ?? 0;
        const liveBefore = [await liveSince(new Date(t0.getTime() - 30 * DAY)), await liveSince(new Date(t0.getTime() - 7 * DAY))];
        const agedSeller = `${RUN}-aged`;
        const aged = await listingRepository.createForPost(
            { ...post, _id: `${RUN}-aged-post`, userId: agedSeller, createdAt: new Date(t0.getTime() - 100 * DAY) } as Post, "dm", false, t0);
        assert.strictEqual(aged.createdAt.getTime(), t0.getTime() - 100 * DAY, "createdAt is the post's date");
        assert.strictEqual(aged.refreshedAt.getTime(), t0.getTime() - 100 * DAY, "refreshedAt falls back to the post's date");
        assert.deepStrictEqual([await liveSince(new Date(t0.getTime() - 30 * DAY)), await liveSince(new Date(t0.getTime() - 7 * DAY))], liveBefore, "an old post is not in the 7/30-day /stats columns");
        assert.strictEqual((await listingRepository.findSellerRecent(agedSeller, new Date(t0.getTime() - 30 * DAY))).length, 0, "an old listing is not a repost target");
        const bumped = await listingRepository.createForPost(
            { ...post, _id: `${RUN}-bumped-post`, userId: agedSeller, createdAt: new Date(t0.getTime() - 100 * DAY), lastBumpAt: new Date(t0.getTime() - 2 * DAY) } as Post, "dm", false, t0);
        assert.strictEqual(bumped.refreshedAt.getTime(), t0.getTime() - 2 * DAY, "refreshedAt is the last bump");
        assert.strictEqual((await listingRepository.findSellerRecent(agedSeller, new Date(t0.getTime() - 30 * DAY))).length, 1, "a recently bumped post is a repost target");
        const undatedPost = await listingRepository.createForPost({ ...post, _id: `${RUN}-undated-post`, userId: agedSeller, createdAt: undefined } as unknown as Post, "dm", false, at(7));
        assert.strictEqual(undatedPost.createdAt.getTime(), at(7).getTime(), "a post without a date falls back to now");
        console.log("[OK] listing dates come from the post.");

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

        // shadow classification of closed windows (clean slate: tick drains every closed capture)
        await Promise.all([Capture.deleteMany({}), Listing.deleteMany({}), ShadowLog.deleteMany({ chatId: CHAT })]);
        const cfg = { captureMode: "shadow", buyerMatches: "shadow" } as BotConfig;
        const sender = (n: string) => `${RUN}-sh-${n}`;
        let mid = 1000;
        const say = (n: string, text: string, media = true) => captureRepository.appendMessage(
            { chatId: CHAT, senderId: sender(n), senderName: n, messageId: mid++, text, media: media ? [{ fileId: "f", type: "photo" }] : [] }, at(0));
        const rowOf = (n: string) => ShadowLog.collection.findOne({ chatId: CHAT, senderId: sender(n) });
        const mkPost = (n: string, title: string, description: string, price: string) =>
            ({ _id: `${RUN}-sp-${n}`, userId: sender(n.split("-")[0]), title, description, price, location: "TLV", media: [], createdAt: t0, status: "approved" } as Post);
        const SALE = ["Glock 17 למכירה", 'במצב מצוין 900 ש"ח'];
        const saleText = SALE.join("\n");

        // window closes after restart: nothing but Mongo state is used
        await say("restart", saleText);
        await tick(cfg, at(20));
        assert.strictEqual(await ShadowLog.countDocuments({ chatId: CHAT }), 0, "window still open at +20 s");
        await tick(cfg, at(31));
        assert.strictEqual(await ShadowLog.countDocuments({ chatId: CHAT }), 1, "one shadow_log row after the window closed");
        assert.strictEqual((await Capture.findOne({ senderId: sender("restart") }))!.state, "classified");
        await tick(cfg, at(32));
        assert.strictEqual(await ShadowLog.countDocuments({ chatId: CHAT }), 1, "a classified capture is not logged twice");
        console.log("[OK] window closes after restart.");

        // strict row, and no member text in it
        const strict = await rowOf("restart");
        assert.ok(strict && strict.tier === "strict" && strict.wouldList === true, "strict with media would list");
        assert.strictEqual(strict.parsedPrice, '900 ש"ח');
        const allowed = new Set(["_id", "__v", "chatId", "messageIds", "senderId", "at", "tier", "rules", "wouldList", "mergeWith", "matches", "parsedTitle", "parsedPrice"]);
        for (const k of Object.keys(strict)) assert.ok(allowed.has(k), `shadow_log field "${k}" is not an allowed field`);
        assert.ok(!("text" in strict), "no member text in shadow_log");
        console.log("[OK] strict row, no member text.");

        // repost merges (same text, and near-duplicate text); a >30-day-old or removed listing does not
        const mine = await listingRepository.createForPost(mkPost("rp-1", SALE[0], SALE[1], "900"), "dm", false, at(0));
        await say("rp", saleText);
        const nearText = "Leupold scope 4x32 mount included brand new";
        await listingRepository.createForPost(mkPost("ov-1", nearText, "", "300"), "dm", false, at(0));
        await say("ov", `${nearText} boxed 300 ש"ח למכירה`);
        for (const [name, patch] of [["old", { refreshedAt: new Date(t0.getTime() - 31 * 24 * 3600 * SEC) }], ["gone", { status: "removed" }]] as const) {
            const l = await listingRepository.createForPost(mkPost(`${name}-1`, SALE[0], SALE[1], "900"), "dm", false, at(0));
            await Listing.updateOne({ _id: l._id }, { $set: patch });
            await say(name, saleText);
        }
        await tick(cfg, at(31));
        const merged = await rowOf("rp");
        assert.strictEqual(merged?.mergeWith, String(mine._id), "same text merges with the seller's listing");
        assert.strictEqual(merged?.wouldList, false);
        assert.ok((await rowOf("ov"))?.mergeWith, "near-duplicate text (overlap >= 0.8) merges");
        for (const name of ["old", "gone"]) {
            const r = await rowOf(name);
            assert.ok(r && r.mergeWith === undefined && r.wouldList === true, `a ${name} listing is not a repost`);
        }
        console.log("[OK] repost merges.");

        // wtb logs matches, never a held listing; only with buyerMatches=shadow
        const gl = await listingRepository.createForPost(mkPost("gl-1", "גלוק 17", "במצב טוב", "800"), "dm", false, at(0));
        const held = await listingRepository.createForPost(mkPost("gh-1", "גלוק 17 ישן", "מושבת", "800"), "legacy", true, at(0));
        await say("wtb", "מחפש glock 17", false);
        await tick(cfg, at(31));
        const wtb = await rowOf("wtb");
        assert.strictEqual(wtb?.tier, "wtb");
        assert.strictEqual(wtb?.wouldList, false);
        assert.ok(wtb?.matches?.includes(String(gl._id)), "the live listing matches");
        assert.ok(!wtb?.matches?.includes(String(held._id)), "a held listing is never matched");
        await say("wtboff", "מחפש glock 17", false);
        await tick({ ...cfg, buyerMatches: "off" }, at(62));
        assert.strictEqual((await rowOf("wtboff"))?.matches, undefined, "no matches unless buyerMatches is shadow");
        console.log("[OK] wtb logs matches.");
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
