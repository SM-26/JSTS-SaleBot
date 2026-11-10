import assert from "assert";
import mongoose from "mongoose";
import Capture from "../models/Capture";
import Draft from "../models/Draft";
import Listing from "../models/Listing";
import Member from "../models/Member";
import PostModel from "../models/Post";
import ShadowLog from "../models/ShadowLog";
import captureRepository from "../repositories/captureRepository";
import draftRepository from "../repositories/draftRepository";
import postRepository from "../repositories/postRepository";
import listingRepository,{ priceValueOf } from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import shadowLogRepository from "../repositories/shadowLogRepository";
import { textHash } from "../services/classifier";
import { LifecycleService } from "../services/lifecycleService";
import { asPostService, plusDays, fakeApi, seedPost, stubPostService, T0 as LT0 } from "./lifecycleFakes";
import { LEGACY_CUTOFF, reconcileBotListings } from "../services/marketService";
import { rankMatches } from "../services/matchService";
import { formatSince, isTrustedSeller, trustLineFor, TRUST_REVOKE_MS } from "../services/trustService";
import User from "../models/User";
import { tick } from "../services/shadowService";
import { StaleCheckService, parseSellerIds, renderStaleDm } from "../services/staleCheckService";
import { startSweeper } from "../services/sweeper";
import type { BotConfig, Post } from "../types";
import { seedCapture } from "./fixtures";
import { catchupMarketChecks } from "./catchupMarketChecks";

// Market collections (slice 0). Needs a real Mongo: the guarantees under test
// are atomic updates and index behaviour (TTL, partial unique), which a mock
// would not exercise. Throwaway database only: the capture checks clear the
// whole `captures` collection so leftover rows cannot be claimed by accident.
const MONGO_URI = process.env.MONGO_URI;
const RUN = `mkt-${Date.now()}`;
const CHAT = -1000000000 - (Date.now() % 1000000);
const SEC = 1000;
const odIds: string[] = []; // numeric member ids of the offer-delivery section

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
        for (const end = Date.now() + 2000; ran < 1 && Date.now() < end;) await sleep(10); // poll, not a fixed sleep
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
    assert.deepStrictEqual(rankMatches("מחפש glock 17 מועד 2025", [L("dear", "glock 17 מצוין", 3000, 0)]), ["dear"], "'עד' inside a word is not a ceiling");
    assert.deepStrictEqual(rankMatches("מחפש glock 17, עד 800", [L("dear", "glock 17 מצוין", 900, 0), glock]), ["glock"], "a ceiling after punctuation still counts");
    const many =Array.from({ length: 8 }, (_, i) => L(`m${i}`, "glock 17", 100, i));
    assert.strictEqual(rankMatches("מחפש glock", many).length, 5, "at most 5");
    assert.strictEqual(rankMatches("מחפש glock", many, 2).length, 2, "max is a parameter");
    assert.deepStrictEqual(rankMatches("מחפש את זה", many), [], "stop words only: nothing");
    assert.deepStrictEqual(rankMatches("מחפש תיק", [L("bag", "תיק גב", 50, 0)]), [], "no strong token: nothing");
    assert.deepStrictEqual(rankMatches("מחפש glock 17", [L("old", "glock 17", 1, 100), L("fresh", "glock 17", 1, 0), L("older", "glock 17", 1, 200)]), ["fresh", "old", "older"], "equal overlap: newest refresh first");
    assert.deepStrictEqual(rankMatches("מחפש glock 17 מצוין", [L("partial", "glock 17 תיק נרתיק", 1, 0), L("full", "glock 17 מצוין", 1, 500)]), ["full", "partial"], "higher overlap first, even if older");
    console.log("[OK] rankMatches.");

    const { isCaptureOn } = await import("../services/captureService");
    assert.deepStrictEqual([undefined, "off", "shadow", "optin"].map(captureMode => isCaptureOn({ captureMode } as BotConfig)), [false, false, true, true], "capture runs only for shadow/optin");
    console.log("[OK] isCaptureOn.");
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
        const liveAgain = await listingRepository.createForPost(post, "dm", false, at(5), at(6));
        assert.strictEqual(liveAgain.refreshedAt.getTime(), listing.refreshedAt.getTime(), "a repeat call with liveAt leaves the clock alone");
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
        const row = await shadowLogRepository.insert({ chatId: CHAT, messageIds: [1], senderId: `${RUN}-x`, at: t0, tier: "strict", rules: ["r"], wouldList: true, parsedPriceValue: 5 });
        assert.ok(await shadowLogRepository.sampleUnlabeled(), "an unlabeled would-list row exists");
        const labeled = await shadowLogRepository.setLabel(String(row._id), "sale", "mod1", at(1));
        assert.strictEqual(labeled?.label, "sale");
        assert.strictEqual(await shadowLogRepository.setLabel(String(row._id), "not_sale", "mod2", at(2)), null, "labels are set once");
        const stats = await shadowLogRepository.stats(new Date(t0.getTime() - SEC));
        assert.ok(stats.byTier.strict >= 1 && stats.wouldList >= 1 && stats.labeled >= 1 && stats.sale >= 1);
        assert.strictEqual(typeof stats.byTier.none, "number");
        // gone (the group post was deleted): never offered again, and outside precision and the gate's n
        const goneRow = await shadowLogRepository.insert({ chatId: CHAT, messageIds: [2], senderId: `${RUN}-x`, at: t0, tier: "strict", rules: ["r"], wouldList: true });
        assert.strictEqual((await shadowLogRepository.setLabel(String(goneRow._id), "gone", "mod1", at(1)))?.label, "gone");
        const afterGone = await shadowLogRepository.stats(new Date(t0.getTime() - SEC));
        assert.deepStrictEqual([afterGone.labeled, afterGone.sale, afterGone.notSale, afterGone.gone], [stats.labeled, stats.sale, stats.notSale, stats.gone + 1]);
        for (let i = 0; i < 20; i++) assert.notStrictEqual(String((await shadowLogRepository.sampleUnlabeled())?._id), String(goneRow._id), "a gone row is never sampled");
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
        assert.strictEqual(strict.parsedPriceValue, 900, "a would-list row keeps the price number");
        const allowed = new Set(["_id", "__v", "chatId", "messageIds", "senderId", "at", "tier", "rules", "wouldList", "mergeWith", "matches", "parsedPriceValue"]);
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
        assert.ok(merged && !("parsedPriceValue" in merged), "the price number is stored only for would-list rows");
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
        // a wanted post is never a repost, even when it repeats the sender's own listing text
        await listingRepository.createForPost(mkPost("wtbself-1", "מחפש glock 17", "", "100"), "dm", false, at(0));
        await say("wtbself", "מחפש glock 17", false);
        await tick(cfg, at(31));
        const wtbSelf = await rowOf("wtbself");
        assert.ok(wtbSelf?.tier === "wtb" && wtbSelf.mergeWith === undefined, "a wtb capture never merges");
        // merged % = merges / (strict + ask), "—" when there are none
        const { mergedPct } = await import("../services/shadowAdminService");
        const stat = (strict: number, ask: number, merges: number) => ({ byTier: { strict, ask, wtb: 9, none: 9 }, merges, wouldList: 99 }) as Parameters<typeof mergedPct>[0];
        assert.deepStrictEqual([mergedPct(stat(3, 1, 1)), mergedPct(stat(0, 0, 0)), mergedPct(stat(1, 0, 1))], ["25%", "—", "100%"], "merged % is over strict + ask");
        await say("wtboff", "מחפש glock 17", false);
        await tick({ ...cfg, buyerMatches: "off" }, at(62));
        assert.strictEqual((await rowOf("wtboff"))?.matches, undefined, "no matches unless buyerMatches is shadow");
        console.log("[OK] wtb logs matches.");

        // take-down: live|expired only, atomic, text/media/title dropped
        const mkListing = (seller: string, extra: Record<string, unknown> = {}) => Listing.create({
            source: "group", origin: "capture", sellerId: `${RUN}-${seller}`, chatId: CHAT, messageIds: [1],
            title: "t", text: "secret text", media: [{ fileId: "f", type: "photo" }], status: "live", createdAt: t0, refreshedAt: t0, ...extra,
        });
        const T = at(5);
        const td = await mkListing("td1");
        const before = await listingRepository.takeDown(String(td._id), T);
        assert.ok(before && before.status === "live" && before.title === "t" && before.sellerId === `${RUN}-td1`, "takeDown returns the before-document");
        const tdRaw = await Listing.collection.findOne({ _id: td._id });
        assert.ok(tdRaw?.status === "taken_down" && tdRaw.endedBy === "moderator" && +tdRaw.endedAt === +T, "taken_down by moderator at T");
        assert.ok(!("text" in tdRaw) && !("media" in tdRaw) && !("title" in tdRaw), "text, media and title are unset");
        assert.strictEqual((await listingRepository.findById(String(td._id)))?.status, "taken_down", "findById");
        assert.strictEqual(await listingRepository.takeDown(String(td._id), T), null, "second takeDown loses");
        const tdSold = await mkListing("td2", { status: "sold" });
        assert.strictEqual(await listingRepository.takeDown(String(tdSold._id), T), null, "sold is final");
        const tdExp = await mkListing("td3", { status: "expired" });
        assert.ok(await listingRepository.takeDown(String(tdExp._id), T), "an expired listing can be taken down");
        const raceL = await mkListing("td4");
        const race = await Promise.all([listingRepository.takeDown(String(raceL._id), T), listingRepository.takeDown(String(raceL._id), T)]);
        assert.strictEqual(race.filter(Boolean).length, 1, "concurrent takeDown: exactly one wins");
        console.log("[OK] takeDown.");

        // trust: a published post earns it; a moderator take-down of anything revokes it for 90 days
        const NOW = at(100);
        const seller = (n: string) => `${RUN}-tr-${n}`;
        const mkTrustPost = (n: string, status: Post["status"]) => PostModel.create({ userId: seller(n), title: "p", price: "1", status });
        await mkTrustPost("pend", "pending");
        await mkTrustPost("rej", "rejected");
        await mkTrustPost("appr", "approved");
        await mkTrustPost("sold", "sold");
        await mkTrustPost("rev", "approved");
        await mkTrustPost("revg", "approved");
        await mkTrustPost("rm", "approved");
        await mkListing(`tr-grp`);
        const takenAt = (n: string, extra: Record<string, unknown> = {}) => mkListing(`tr-${n}`, { status: "taken_down", endedBy: "moderator", endedAt: NOW, ...extra });
        await takenAt("rev", { source: "bot", origin: "dm", chatId: undefined, postId: "p-rev" });
        await takenAt("revg");
        await mkListing("tr-rm", { status: "removed", endedBy: "seller", endedAt: NOW });
        const trust = (n: string, now = NOW) => isTrustedSeller(`${RUN}-tr-${n}`, now);
        assert.deepStrictEqual(
            [await trust("none"), await trust("pend"), await trust("rej"), await trust("appr"), await trust("sold"), await trust("grp")],
            [false, false, false, true, true, false], "trust follows approved/sold posts only; captured listings do not count");
        const day = 24 * 60 * 60 * 1000;
        assert.strictEqual(await trust("rev", new Date(NOW.getTime() + TRUST_REVOKE_MS - 1)), false, "revoked until T + 90 d - 1 ms");
        assert.strictEqual(await trust("rev", new Date(NOW.getTime() + TRUST_REVOKE_MS)), true, "restored at T + 90 d");
        assert.strictEqual(await trust("revg", new Date(NOW.getTime() + day)), false, "a group take-down revokes too");
        assert.strictEqual(await trust("rm"), true, "a seller's own removal does not revoke");
        console.log("[OK] isTrustedSeller.");

        // ---- slice 2 data layer ----
        const HOUR = 3600 * SEC;
        const S2 = new Date();
        const ago = (ms: number) => new Date(S2.getTime() - ms);
        const mkCap = (seller: string, extra: Partial<Parameters<typeof seedCapture>[0]> = {}) =>
            seedCapture({ senderId: `${RUN}-s2-${seller}`, chatId: CHAT, text: "Glock 17 למכירה 900 ש\"ח", media: [{ fileId: "f", type: "photo" }], ...extra });
        const note = (sentAt: Date, kind: "ask" | "refresh" = "ask") => ({ ephemeralMessageId: 1, sentAt, kind });

        const tr = await mkCap("tr");
        assert.strictEqual(tr.tier, "strict", "seedCapture classifies");
        const trRace = await Promise.all([
            captureRepository.transition(String(tr._id), ["classified"], "added"),
            captureRepository.transition(String(tr._id), ["classified"], "added"),
        ]);
        assert.strictEqual(trRace.filter(Boolean).length, 1, "transition is atomic: exactly one wins");
        assert.strictEqual(trRace.find(Boolean)!.state, "added");
        assert.strictEqual((await captureRepository.findById(String(tr._id)))!.state, "added");
        assert.strictEqual(await captureRepository.transition(String(tr._id), ["asked"], "declined"), null, "wrong from-state: null");
        console.log("[OK] transition is atomic.");

        const ns = `${RUN}-s2-ns`;
        for (const h of [1, 23, 25]) await mkCap("ns", { senderId: ns, note: note(ago(h * HOUR)) });
        assert.strictEqual(await captureRepository.countNotesSince(ns, ago(24 * HOUR)), 2, "notes in the last 24 h");
        assert.strictEqual(await captureRepository.countNotesSince(`${RUN}-s2-nobody`, ago(24 * HOUR)), 0);
        console.log("[OK] countNotesSince.");

        const stats0 = await captureRepository.noteStats(ago(HOUR));
        await mkCap("st1", { state: "added", note: note(S2) });
        await mkCap("st2", { state: "declined", note: note(S2) });
        await mkCap("st3", { state: "added", note: note(S2, "refresh") });
        const stats1 = await captureRepository.noteStats(ago(HOUR));
        assert.deepStrictEqual(
            { notes: stats1.notes - stats0.notes, added: stats1.added - stats0.added, declined: stats1.declined - stats0.declined },
            { notes: 2, added: 1, declined: 1 }, "noteStats counts ask notes only");
        console.log("[OK] noteStats.");

        // the capture's note is set, its listing linked
        await captureRepository.setNote(String(tr._id), note(S2));
        await captureRepository.setListing(String(tr._id), "lst1");
        const trRow = await captureRepository.findById(String(tr._id));
        assert.ok(trRow?.note?.kind === "ask" && trRow.note.ephemeralMessageId === 1 && trRow.listingId === "lst1", "setNote and setListing");

        // decline memory: remembers every text a note was sent for (30 days, 20 hashes)
        const dm = `${RUN}-s2-dm`;
        for (let i = 0; i < 22; i++) await memberRepository.rememberAsked(dm, `h${i}`, new Date(S2.getTime() + i));
        const dmRow = (await memberRepository.findByUserId(dm))!;
        assert.strictEqual(dmRow.declined?.length, 20, "at most 20 hashes");
        assert.deepStrictEqual(dmRow.declined?.map(d => d.hash).slice(0, 2), ["h2", "h3"], "the oldest are dropped");
        assert.strictEqual(dmRow.askMode, "ask", "rememberAsked on an unseen user creates it with askMode ask");
        assert.ok(dmRow.firstSeenAt instanceof Date);
        const DAY30 = 30 * 24 * HOUR;
        assert.strictEqual(await memberRepository.wasAskedRecently(dm, "h21", new Date(S2.getTime() + 21)), true, "asked just now");
        assert.strictEqual(await memberRepository.wasAskedRecently(dm, "h21", new Date(S2.getTime() + 21 + DAY30 - HOUR)), true, "still inside 30 days");
        assert.strictEqual(await memberRepository.wasAskedRecently(dm, "h21", new Date(S2.getTime() + 21 + DAY30 + HOUR)), false, "forgotten after 30 days");
        assert.strictEqual(await memberRepository.wasAskedRecently(dm, "h0", S2), false, "a dropped hash is forgotten");
        assert.strictEqual(await memberRepository.wasAskedRecently(`${RUN}-s2-nobody`, "h21", S2), false, "unknown member");
        await memberRepository.setAskMode(dm, "never", S2);
        await memberRepository.touch(dm, S2);
        assert.strictEqual((await memberRepository.findByUserId(dm))!.askMode, "never", "touch keeps never");
        const fresh = `${RUN}-s2-fresh`;
        await memberRepository.setAskMode(fresh, "never", S2);
        const freshRow = (await memberRepository.findByUserId(fresh))!;
        assert.ok(freshRow.askMode === "never" && freshRow.firstSeenAt.getTime() === S2.getTime(), "setAskMode creates an unseen member");
        assert.strictEqual(await memberRepository.findByUserId(`${RUN}-s2-nobody`), null);
        console.log("[OK] decline memory.");

        // listings of a group capture
        const grpL = await listingRepository.createFromCapture({
            chatId: CHAT, messageIds: [501, 502], sellerId: `${RUN}-s2-g`, sellerName: "G", title: "Glock", price: "1,300₪", text: "Glock 17 1,300₪",
            media: [{ fileId: "f", type: "photo" }], isBundle: false, note: { ephemeralMessageId: 9, sentAt: S2 },
        }, S2);
        assert.ok(grpL.source === "group" && grpL.origin === "capture" && grpL.status === "live" && grpL.hold === false, "createFromCapture shape");
        assert.strictEqual(grpL.priceValue, 1300, "priceValue from 1,300₪");
        assert.strictEqual(grpL.textHash, textHash("Glock 17 1,300₪"));
        assert.ok(grpL.note?.ephemeralMessageId === 9 && grpL.createdAt.getTime() === S2.getTime() && grpL.refreshedAt.getTime() === S2.getTime());
        assert.strictEqual(priceValueOf("2,500"), 2500, "priceValueOf is exported");
        const noNote = await listingRepository.createFromCapture({
            chatId: CHAT, messageIds: [503], sellerId: `${RUN}-s2-g`, sellerName: "G", title: "x", text: "x", price: "", media: [], isBundle: true,
        }, ago(HOUR));
        assert.strictEqual(noNote.note, undefined, "no note when none given");
        console.log("[OK] createFromCapture.");

        assert.strictEqual(String((await listingRepository.findLiveByMessage(CHAT, 502))?._id), String(grpL._id), "found by its second messageId");
        assert.strictEqual(await listingRepository.findLiveByMessage(CHAT, 999), null);
        assert.strictEqual(await listingRepository.findLiveByMessage(CHAT + 1, 502), null, "another chat");
        const byG = await listingRepository.findGroupBySeller(`${RUN}-s2-g`);
        assert.deepStrictEqual(byG.map(l => String(l._id)), [String(grpL._id), String(noNote._id)], "findGroupBySeller: newest first");
        await listingRepository.markSold(String(grpL._id), S2);
        assert.strictEqual(await listingRepository.findLiveByMessage(CHAT, 502), null, "a sold listing is not live");
        await mkListing("cnt-legacy", { source: "bot", origin: "legacy", chatId: undefined, postId: `${RUN}-cnt-p`, status: "live" });
        const cntSeller = `${RUN}-s2-g`;
        await Listing.updateOne({ postId: `${RUN}-cnt-p` }, { $set: { sellerId: cntSeller } });
        assert.strictEqual(await listingRepository.countBySeller(cntSeller), 3, "countBySeller: any source, any status");
        assert.strictEqual((await listingRepository.findGroupBySeller(cntSeller)).length, 2, "findGroupBySeller skips bot listings");
        console.log("[OK] findLiveByMessage, findGroupBySeller, countBySeller.");

        const ex = await mkListing("ex", { status: "expired", nudgedAt: S2, endedAt: S2, endedBy: "system", messageIds: [1] });
        const refreshed = await listingRepository.refresh(String(ex._id), at(50), { messageIds: [7, 8], text: "new text", media: [], isBundle: false, price: "90₪", priceValue: 90 });
        assert.ok(refreshed?.status === "live" && refreshed.refreshedAt.getTime() === at(50).getTime(), "refresh from expired");
        assert.deepStrictEqual(refreshed.messageIds, [7, 8], "messageIds replaced when given");
        assert.deepStrictEqual([refreshed.text, refreshed.price, refreshed.priceValue, refreshed.title], ["new text", "90₪", 90, ex.title], "a repost brings text and price; an undefined title keeps the old one");
        const exRaw = await Listing.collection.findOne({ _id: ex._id });
        assert.ok(exRaw && !("nudgedAt" in exRaw) && !("endedAt" in exRaw) && !("endedBy" in exRaw), "nudgedAt, endedAt and endedBy are unset");
        const kept = await listingRepository.refresh(String(ex._id), at(51));
        assert.deepStrictEqual(kept?.messageIds, [7, 8], "messageIds kept when not given");
        const soldEx = await mkListing("exsold", { status: "sold" });
        assert.strictEqual(await listingRepository.refresh(String(soldEx._id), at(50)), null, "a sold listing cannot be refreshed");
        console.log("[OK] refresh from expired.");

        const rm = await mkListing("rm");
        const removed = await listingRepository.markRemoved(String(rm._id), "seller", at(60));
        assert.strictEqual(removed?.status, "removed");
        const rmRaw = await Listing.collection.findOne({ _id: rm._id });
        assert.ok(rmRaw?.status === "removed" && rmRaw.endedBy === "seller" && +rmRaw.endedAt === +at(60), "removed by seller");
        assert.ok(!("text" in rmRaw) && !("title" in rmRaw) && !("media" in rmRaw), "text, title and media are unset");
        assert.strictEqual(await listingRepository.markRemoved(String(rm._id), "seller", at(61)), null, "second markRemoved loses");
        assert.strictEqual(await listingRepository.markSold(String(rm._id), at(62)), null, "markSold on a removed listing");
        console.log("[OK] markRemoved unsets text.");

        const ed = await mkListing("ed", { price: "100", priceValue: 100, textHash: "old" });
        assert.strictEqual(await listingRepository.applyEdit(String(soldEx._id), { text: "x", isBundle: false }), null, "applyEdit on a sold listing");
        const edited2 = await listingRepository.applyEdit(String(ed._id), { price: "200", priceValue: 200, text: "new text", isBundle: true });
        assert.ok(edited2?.price === "200" && edited2.priceValue === 200 && edited2.isBundle === true && edited2.text === "new text", "applyEdit updates");
        assert.strictEqual(edited2.textHash, textHash("new text"));
        assert.strictEqual(edited2.title, "t", "title untouched when the patch has none");
        await listingRepository.setNote(String(ed._id), { ephemeralMessageId: 4, sentAt: S2 });
        assert.strictEqual((await listingRepository.findById(String(ed._id)))!.note?.ephemeralMessageId, 4, "setNote");
        console.log("[OK] applyEdit, setNote.");

        // draft from a capture, and a normal start over it drops captureId
        const du = `${RUN}-s2-draft`;
        const d1 = await draftRepository.startFromCapture({
            userId: du, chatId: 5, locale: "en", step: "price", promptMessageId: 70, captureId: "c1", title: "T", media: [{ fileId: "m1", type: "photo" }],
        });
        assert.ok(d1.captureId === "c1" && d1.step === "price" && d1.title === "T" && d1.media.length === 1 && d1.promptMessageId === 70, "startFromCapture");
        const d2 = await draftRepository.startFromCapture({ userId: du, chatId: 5, locale: "en", step: "title", promptMessageId: 71, captureId: "c2", media: [] });
        assert.ok(d2.captureId === "c2" && d2.title === undefined && d2.media.length === 0, "startFromCapture replaces the draft");
        const d3 = await draftRepository.start(du, 5, "en", 72);
        assert.ok(d3 && d3.captureId === undefined && d3.step === "title", "start over a capture draft leaves no captureId");
        assert.ok(!("captureId" in (await Draft.collection.findOne({ userId: du }))!), "captureId is gone from the document");
        console.log("[OK] draft startFromCapture.");

        await catchupMarketChecks(RUN, CHAT, odIds);

        // slice 3: lifecycle clock fields and atomic claims (fake clock, nothing calls new Date())
        {
            const T0 = new Date("2026-12-01T10:00:00Z");
            const L = (n: number) => new Date(T0.getTime() + n * 24 * 3600 * 1000);
            const HR = 3600 * 1000;
            const P = `${RUN}-s3`;
            const mk = (seller: string, extra: Record<string, unknown> = {}) => Listing.create({
                source: "group", origin: "capture", sellerId: `${P}-${seller}`, chatId: CHAT, messageIds: [1],
                title: "t", text: "x", media: [{ fileId: "f", type: "photo" }], status: "live", createdAt: T0, refreshedAt: T0, ...extra,
            });
            const mine = <T extends { sellerId: string }>(rows: T[]) => rows.filter(r => r.sellerId.startsWith(P));
            const id = (l: { _id: unknown }) => String(l._id);

            const n1 = await mk("n1");
            assert.strictEqual(await listingRepository.claimNudge(id(n1), new Date(L(7).getTime() - 1)), null, "claimNudge one ms early");
            const claimed = await listingRepository.claimNudge(id(n1), L(7));
            assert.ok(claimed && claimed.nudgedAt?.getTime() === L(7).getTime(), "claimNudge at day 7 sets nudgedAt");
            assert.strictEqual(await listingRepository.claimNudge(id(n1), L(7)), null, "claimNudge only once");
            await listingRepository.holdNudge(id(n1));
            await listingRepository.releaseNudgeClaim(id(n1));
            const rel = await Listing.collection.findOne({ _id: n1._id });
            assert.ok(rel && !("nudgedAt" in rel) && !("nudgeHeld" in rel), "releaseNudgeClaim unsets both");
            console.log("[OK] claimNudge.");

            await mk("c-hold", { refreshedAt: L(23), hold: true });
            await mk("c-nudged", { refreshedAt: L(23), nudgedAt: L(30) });
            await mk("c-sold", { refreshedAt: L(23), status: "sold" });
            await mk("c-old", { refreshedAt: L(0) });
            const okL = await mk("c-ok", { refreshedAt: L(23) });
            const found = mine(await listingRepository.findNudgeCandidates(L(31), 500)).filter(r => r.sellerId.startsWith(`${P}-c-`));
            assert.deepStrictEqual(found.map(id), [id(okL)], "only the 8-day-old live unheld un-nudged listing");
            console.log("[OK] nudge candidates filter.");

            const r1 = await mk("r1", { nudgedAt: L(1), nudgeHeld: true, staleSentAt: L(1), hold: true, endedAt: L(2), endedBy: "system" });
            assert.ok(await listingRepository.refresh(id(r1), L(3)), "refresh returns the listing");
            const r1raw = await Listing.collection.findOne({ _id: r1._id });
            assert.ok(r1raw && r1raw.hold === false && r1raw.status === "live" && +r1raw.refreshedAt === +L(3), "refresh sets clock, hold false");
            for (const f of ["nudgedAt", "nudgeHeld", "staleSentAt", "endedAt", "endedBy"]) assert.ok(!(f in r1raw), `refresh unsets ${f}`);
            const r2 = await mk("r2", { status: "expired", endedAt: L(1), endedBy: "system" });
            assert.strictEqual((await listingRepository.refresh(id(r2), L(3)))?.status, "live", "expired -> live");
            const r3 = await mk("r3", { status: "sold" });
            assert.strictEqual(await listingRepository.refresh(id(r3), L(3)), null, "sold stays sold");
            assert.strictEqual((await listingRepository.findById(id(r3)))?.status, "sold");
            console.log("[OK] refresh clears everything.");

            const e1 = await mk("e1");
            const e2 = await mk("e2", { hold: true });
            const e3 = await mk("e3", { status: "sold" });
            assert.deepStrictEqual(mine(await listingRepository.expireDue(new Date(L(30).getTime() - 1))), [], "nothing expires at day 30 minus 1 ms");
            assert.ok(mine(await listingRepository.expireDue(L(30))).some(r => id(r) === id(e1)), "expireDue returns e1");
            const e1raw = await Listing.collection.findOne({ _id: e1._id });
            assert.ok(e1raw?.status === "expired" && e1raw.endedBy === "system" && +e1raw.endedAt === +L(30), "expired by system at now");
            assert.strictEqual((await listingRepository.findById(id(e2)))?.status, "live", "hold untouched");
            assert.strictEqual((await listingRepository.findById(id(e3)))?.status, "sold", "sold untouched");
            console.log("[OK] expireDue.");

            const s1 = await mk("s1", { staleSentAt: T0, refreshedAt: L(5) });
            const s2 = await mk("s2", { nudgedAt: T0, refreshedAt: L(5) });
            assert.deepStrictEqual(mine(await listingRepository.expireStaleUnanswered(new Date(L(7).getTime() - 1))), [], "stale window not over");
            assert.deepStrictEqual(mine(await listingRepository.expireStaleUnanswered(L(7))).map(id), [id(s1)], "expired exactly at 7 days");
            assert.strictEqual((await listingRepository.findById(id(s1)))?.endedBy, "system");
            assert.strictEqual((await listingRepository.findById(id(s2)))?.status, "live", "nudged without staleSentAt untouched");
            console.log("[OK] expireStaleUnanswered.");

            const st = await mk("st", { origin: "legacy", hold: true, source: "bot", chatId: undefined });
            const stId = id(st);
            assert.ok(mine(await listingRepository.findStaleEligible([`${P}-st`])).some(r => id(r) === stId), "eligible for its seller");
            assert.ok(!mine(await listingRepository.findStaleEligible([`${P}-other`])).some(r => id(r) === stId), "not for another seller");
            assert.ok(mine(await listingRepository.findStaleEligible(null)).some(r => id(r) === stId), "null = everyone");
            const both = await Promise.all([listingRepository.claimStale(stId, L(2)), listingRepository.claimStale(stId, L(2))]);
            assert.strictEqual(both.filter(Boolean).length, 1, "exactly one claimStale wins");
            const stRaw = await Listing.collection.findOne({ _id: st._id });
            assert.ok(stRaw && stRaw.hold === false && +stRaw.nudgedAt === +L(2) && +stRaw.staleSentAt === +L(2) && +stRaw.refreshedAt === +L(2), "claimStale sets all three clocks");
            await listingRepository.unclaimStale(stId);
            const stBack = await Listing.collection.findOne({ _id: st._id });
            assert.ok(stBack && stBack.hold === true && !("nudgedAt" in stBack) && !("staleSentAt" in stBack), "unclaimStale restores");
            // unclaim on a row that is no longer a live stale claim changes nothing
            const uc = await mk("uc", { source: "bot", hold: false, status: "sold", staleSentAt: L(2), nudgedAt: L(2) });
            await listingRepository.unclaimStale(id(uc));
            assert.strictEqual((await Listing.collection.findOne({ _id: uc._id }))!.hold, false, "unclaimStale skips a sold row");
            const uc2 = await mk("uc2", { source: "bot", hold: false });
            await listingRepository.unclaimStale(id(uc2));
            assert.strictEqual((await Listing.collection.findOne({ _id: uc2._id }))!.hold, false, "unclaimStale skips a refreshed row (no staleSentAt)");
            // holdNudge needs a live nudge claim; countHeld counts live rows only
            const hn = await mk("hn");
            await listingRepository.holdNudge(id(hn));
            assert.ok(!("nudgeHeld" in (await Listing.collection.findOne({ _id: hn._id }))!), "holdNudge skips an unclaimed (refreshed) row");
            const heldBefore = await listingRepository.countHeld();
            await mk("hs", { hold: true, status: "sold" });
            assert.strictEqual(await listingRepository.countHeld(), heldBefore, "countHeld ignores ended rows");
            console.log("[OK] claimStale once.");

            const h = await mk("h1", { nudgedAt: L(7) });
            await listingRepository.holdNudge(id(h));
            assert.ok(mine(await listingRepository.findHeldNudges()).some(r => id(r) === id(h)), "findHeldNudges");
            const rels = await Promise.all([listingRepository.claimHeldRelease(id(h)), listingRepository.claimHeldRelease(id(h))]);
            assert.strictEqual(rels.filter(Boolean).length, 1, "exactly one release wins");
            console.log("[OK] claimHeldRelease once.");

            const m1 = await mk("m1");
            const sys = await listingRepository.markSold(id(m1), L(1), "system");
            assert.ok(sys?.status === "sold" && sys.endedBy === "system", "markSold by system");
            const m2 = await mk("m2");
            assert.strictEqual((await listingRepository.markSold(id(m2), L(1)))?.endedBy, "seller", "markSold defaults to seller");
            const m3 = await mk("m3");
            const ex = await listingRepository.markExpired(id(m3), L(2));
            assert.ok(ex?.status === "expired" && ex.endedBy === "system" && +ex.endedAt! === +L(2), "markExpired");
            assert.strictEqual(await listingRepository.markExpired(id(m3), L(3)), null, "markExpired only from live");
            assert.strictEqual(await listingRepository.markExpired(id(m1), L(3)), null, "markExpired not from sold");
            assert.strictEqual(await listingRepository.countSold(`${P}-m1`), 1, "countSold");
            assert.strictEqual(await listingRepository.countSold(`${P}-m3`), 0);
            const x1 = await mk("xp", { source: "bot", status: "expired", endedAt: L(4) });
            const x2 = await mk("xp", { source: "bot", status: "expired", endedAt: L(6) });
            await mk("xp", { source: "group", status: "expired", endedAt: L(8) });
            await mk("xp", { source: "bot", status: "live" });
            assert.deepStrictEqual((await listingRepository.findSellerExpired(`${P}-xp`, 10)).map(id), [id(x2), id(x1)], "bot expired only, newest endedAt first");
            assert.strictEqual((await listingRepository.findSellerExpired(`${P}-xp`, 1)).length, 1, "limit");
            const ck = await mk("ck");
            await listingRepository.setClockForTest(id(ck), L(9));
            assert.strictEqual(+(await listingRepository.findById(id(ck)))!.refreshedAt, +L(9), "setClockForTest");
            console.log("[OK] markSold by, markExpired, countSold, findSellerExpired, setClockForTest.");

            const pu = `${P}-pu`;
            const mkPost = (title: string, createdAt: Date) => PostModel.create({ userId: pu, title, description: "d", price: "1", location: "l", media: [], status: "approved", createdAt });
            const pA = await mkPost("a", L(3));
            const pB = await mkPost("b", L(1));
            assert.strictEqual((await postRepository.findByIds([String(pA._id), String(pB._id)])).length, 2, "findByIds");
            assert.deepStrictEqual(await postRepository.findByIds([]), [], "findByIds empty");
            assert.strictEqual(+(await postRepository.firstCreatedAt(pu))!, +L(1), "firstCreatedAt is the oldest");
            assert.strictEqual(await postRepository.firstCreatedAt(`${P}-nobody`), null, "firstCreatedAt none");
            await PostModel.collection.insertOne({ userId: `${P}-nodate`, title: "t", status: "approved" } as never);
            assert.strictEqual(await postRepository.firstCreatedAt(`${P}-nodate`), null, "a post with no date is not a first date");
            await PostModel.collection.deleteMany({ userId: `${P}-nodate` });
            console.log("[OK] postRepository.findByIds, firstCreatedAt.");

            const cs = `${P}-cap`;
            const base = { chatId: CHAT, senderId: cs, senderName: "s", messageIds: [1], parts: [], text: "x", media: [], mediaGroupIds: [], firstAt: T0 };
            await Capture.collection.insertOne({ ...base, state: "classified", lastAt: new Date(T0.getTime() + HR) });
            await Capture.collection.insertOne({ ...base, state: "open", lastAt: new Date(T0.getTime() + HR) });
            assert.strictEqual(await captureRepository.hasSettledSince(CHAT, cs, T0, new Date(T0.getTime() + 2 * HR)), true, "settled capture inside range");
            assert.strictEqual(await captureRepository.hasSettledSince(CHAT, cs, T0, new Date(T0.getTime() + HR / 2)), false, "settledBefore too early");
            assert.strictEqual(await captureRepository.hasSettledSince(CHAT, `${P}-cap2`, T0, new Date(T0.getTime() + 2 * HR)), false, "other sender");
            await Capture.deleteMany({ senderId: cs, state: "classified" });
            assert.strictEqual(await captureRepository.hasSettledSince(CHAT, cs, T0, new Date(T0.getTime() + 2 * HR)), false, "an open capture does not count");
            console.log("[OK] hasSettledSince.");
        }

        // slice 3: LifecycleService refresh, sold, remove
        {
            const P = `${RUN}-lc`;
            const ps = stubPostService();
            const svc = new LifecycleService(fakeApi().api, {} as BotConfig, asPostService(ps), () => "bot");
            const gl = (seller: string, extra: Record<string, unknown> = {}) => Listing.create({
                source: "group", origin: "capture", sellerId: `${P}-${seller}`, chatId: CHAT, messageIds: [1],
                title: "t", text: "x", media: [{ fileId: "f", type: "photo" }], status: "live", createdAt: LT0, refreshedAt: LT0, ...extra,
            });
            const bl = async (seller: string) => {
                const post = await seedPost(`${P}-${seller}`);
                return { post, listing: await listingRepository.createForPost(post, "dm", false, LT0) };
            };
            const sid = (n: string) => `${P}-${n}`;
            const lid = (l: { _id: unknown }) => String(l._id);

            const b1 = await bl("b1");
            const r1 = await svc.sellListing(lid(b1.listing), sid("b1"), LT0);
            assert.strictEqual(r1.outcome, "ok");
            assert.strictEqual((await postRepository.findById(String(b1.post._id)))?.status, "sold", "post sold");
            const l1 = await listingRepository.findById(lid(b1.listing));
            assert.ok(l1?.status === "sold" && l1.endedBy === "seller", "listing sold by seller");
            assert.strictEqual(ps.sold.length, 1, "markPostSold once");
            const r1b = await svc.sellListing(lid(b1.listing), sid("b1"), LT0);
            assert.ok(r1b.outcome === "ended" && r1b.listing?.status === "sold", "sold twice is ended");
            assert.strictEqual(ps.sold.length, 1, "markPostSold still once");

            const g1 = await gl("g1");
            assert.strictEqual((await svc.sellListing(lid(g1), sid("g1"), LT0)).outcome, "ok");
            assert.strictEqual(ps.sold.length, 1, "group sold leaves posts alone");

            const g2 = await gl("g2");
            const rf = await svc.sellListing(lid(g2), sid("other"), LT0);
            assert.ok(rf.outcome === "forbidden" && rf.listing, "sold by another user");
            assert.strictEqual((await listingRepository.findById(lid(g2)))?.status, "live");
            assert.strictEqual((await svc.sellListing("000000000000000000000000", sid("g2"), LT0)).outcome, "not_found");

            const b2 = await bl("b2");
            ps.groupEdited = false;
            const r2 = await svc.sellListing(lid(b2.listing), sid("b2"), LT0);
            ps.groupEdited = true;
            assert.ok(r2.outcome === "ok" && r2.groupEdited === false, "deleted group message");
            assert.strictEqual((await listingRepository.findById(lid(b2.listing)))?.status, "sold");
            assert.strictEqual((await postRepository.findById(String(b2.post._id)))?.status, "sold");

            const b3 = await bl("b3");
            const rn = await svc.removeListing(lid(b3.listing), sid("b3"), LT0);
            const b3l = await listingRepository.findById(lid(b3.listing));
            assert.ok(rn.outcome === "not_allowed" && b3l?.status === "live" && b3l.text, "remove bot listing refused");
            const g3 = await gl("g3");
            assert.strictEqual((await svc.removeListing(lid(g3), sid("g3"), LT0)).outcome, "ok");
            const g3l = (await Listing.collection.findOne({ _id: g3._id }))!;
            assert.ok(g3l.status === "removed" && g3l.endedBy === "seller" && !("text" in g3l) && !("title" in g3l) && !("media" in g3l), "remove group scrubs");

            const g4 = await gl("g4", { nudgedAt: LT0 });
            const rr = await svc.refreshListing(lid(g4), sid("g4"), plusDays(8));
            const g4l = (await Listing.collection.findOne({ _id: g4._id }))!;
            assert.ok(rr.outcome === "ok" && g4l.refreshedAt.getTime() === plusDays(8).getTime() && !("nudgedAt" in g4l), "refresh restarts the clock");
            const g5 = await gl("g5", { status: "expired" });
            assert.strictEqual((await svc.refreshListing(lid(g5), sid("g5"), plusDays(1))).outcome, "ok");
            assert.strictEqual((await listingRepository.findById(lid(g5)))?.status, "live", "expired relisted");
            assert.strictEqual((await svc.refreshListing(lid(g1), sid("g1"), plusDays(1))).outcome, "ended", "sold is final");

            const ep = await seedPost(sid("e1"));
            const [e1, e2] = await Promise.all([svc.ensureBotListing(String(ep._id), LT0), svc.ensureBotListing(String(ep._id), LT0)]);
            assert.ok(e1 && e2 && lid(e1) === lid(e2), "ensureBotListing race returns one row");
            assert.strictEqual(await Listing.countDocuments({ source: "bot", postId: String(ep._id) }), 1);
            assert.strictEqual(await svc.ensureBotListing(String((await seedPost(sid("e2"), "pending"))._id), LT0), null, "pending post has no listing");

            const sp = await bl("s1");
            await PostModel.updateOne({ _id: sp.post._id }, { $set: { status: "sold" } });
            const rec = await reconcileBotListings(LT0);
            assert.ok(rec.sold >= 1, "reconcile marks the 2.0.1-sold listing");
            assert.strictEqual((await listingRepository.findById(lid(sp.listing)))?.status, "sold");

            // the sold_/bump_ entry points: the caller already handled the post
            const sy = await seedPost(sid("sy1"), "sold");
            await svc.syncSoldForPost(String(sy._id), LT0);
            assert.strictEqual((await Listing.findOne({ source: "bot", postId: String(sy._id) }))?.status, "sold", "syncSoldForPost creates on demand and sells");
            const sy2 = await bl("sy2");
            const soldBefore = ps.sold.length;
            await svc.syncSoldForPost(String(sy2.post._id), LT0);
            assert.strictEqual((await listingRepository.findById(lid(sy2.listing)))?.status, "sold");
            assert.strictEqual((await postRepository.findById(String(sy2.post._id)))?.status, "approved", "syncSoldForPost leaves the post alone");
            assert.strictEqual(ps.sold.length, soldBefore);
            const rf2 = await bl("rf2");
            await Listing.updateOne({ _id: rf2.listing._id }, { $set: { nudgedAt: LT0 } });
            await svc.refreshForPost(String(rf2.post._id), plusDays(3));
            const rf2l = (await Listing.collection.findOne({ _id: rf2.listing._id }))!;
            assert.ok(rf2l.refreshedAt.getTime() === plusDays(3).getTime() && !("nudgedAt" in rf2l), "refreshForPost moves the clock, clears nudgedAt");
            const rf3 = await bl("rf3");
            await Listing.updateOne({ _id: rf3.listing._id }, { $set: { status: "taken_down" } });
            await svc.refreshForPost(String(rf3.post._id), plusDays(3));
            const rf3l = (await listingRepository.findById(lid(rf3.listing)))!;
            assert.ok(rf3l.status === "taken_down" && rf3l.refreshedAt.getTime() === LT0.getTime(), "refreshForPost leaves taken_down alone");
            console.log("[OK] lifecycle refresh, sold, remove.");
        }

        // slice 3: day-7 nudge, day-30 expiry, held nudges (ticks are called directly, never timers)
        {
            const ps = stubPostService();
            const setup = async (nudges = true) => {
                await Listing.deleteMany({}); // throwaway DB: leftovers from other blocks must not be due in these ticks
                const f = fakeApi();
                const config = { nudges, approvedGroupId: CHAT, lang: "en" } as BotConfig;
                return { f, config, svc: new LifecycleService(f.api, config, asPostService(ps), () => "bot") };
            };
            type Fake = ReturnType<typeof fakeApi>;
            const dms = (f: Fake) => f.calls.filter(c => c.method === "sendMessage" && !c.params.ephemeral_message_parameters);
            const notes = (f: Fake) => f.calls.filter(c => c.method === "sendMessage" && c.params.ephemeral_message_parameters);
            const buttons = (call: { params: Record<string, unknown> }) =>
                (call.params.reply_markup as { inline_keyboard: { callback_data?: string; url?: string }[][] }).inline_keyboard.flat();
            const sid = (n: number) => String(100000 + n);
            const botL = async (seller: string) => {
                const post = await seedPost(seller);
                return { post, listing: await listingRepository.createForPost(post, "dm", false, LT0, LT0) };
            };
            const grpL = (seller: string, extra: Record<string, unknown> = {}) => Listing.create({
                source: "group", origin: "capture", sellerId: seller, chatId: CHAT, messageIds: [1], title: "gt", price: "5",
                text: "x", media: [], status: "live", createdAt: LT0, refreshedAt: LT0, ...extra,
            });
            const lid = (l: { _id: unknown }) => String(l._id);
            const raw = async (l: { _id: unknown }) => (await Listing.collection.findOne({ _id: l._id as never }))!;
            const DAY = 24 * 3600 * 1000;
            const ms = (n: number) => new Date(LT0.getTime() + n);
            const settledCapture = (seller: string, lastAt: Date) => Capture.collection.insertOne({
                chatId: CHAT, senderId: seller, senderName: "s", messageIds: [1], parts: [], text: "x", media: [], mediaGroupIds: [], firstAt: lastAt, state: "classified", lastAt,
            });

            // day 7 exactly once; a bot listing has no remove
            {
                const { f, svc } = await setup();
                const b = await botL(sid(1));
                assert.strictEqual((await svc.tick(ms(7 * DAY - 1))).nudged, 0);
                assert.strictEqual(dms(f).length, 0, "nothing before day 7");
                assert.strictEqual((await svc.tick(ms(7 * DAY))).nudged, 1);
                const sent = dms(f);
                assert.strictEqual(sent.length, 1);
                assert.strictEqual(String(sent[0].params.chat_id), sid(1));
                const cb = buttons(sent[0]).map(x => x.callback_data);
                assert.ok(cb.includes(`lc_r_${lid(b.listing)}`) && cb.includes(`lc_s_${lid(b.listing)}`) && !cb.some(x => x?.startsWith("lc_x_")), "bot nudge keyboard");
                assert.ok(!buttons(sent[0]).some(x => x.url), "DM has no manage link");
                await svc.tick(ms(7 * DAY + 600_000));
                assert.strictEqual(dms(f).length, 1, "nudged once");
            }
            // group nudge offers remove
            {
                const { f, svc } = await setup();
                const g = await grpL(sid(2));
                await svc.tick(ms(7 * DAY));
                assert.ok(buttons(dms(f)[0]).some(x => x.callback_data === `lc_x_${lid(g)}`), "group nudge has remove");
            }
            // refresh restarts the clock
            {
                const { f, svc } = await setup();
                const g = await grpL(sid(3));
                await svc.tick(ms(7 * DAY));
                await svc.refreshListing(lid(g), sid(3), ms(8 * DAY));
                await svc.tick(ms(14 * DAY));
                assert.strictEqual(dms(f).length, 1, "no new nudge at day 14");
                await svc.tick(ms(15 * DAY));
                assert.strictEqual(dms(f).length, 2, "second nudge at day 15");
            }
            // expiry at day 30 sends nothing and leaves the post alone
            {
                const { f, svc } = await setup();
                const b = await botL(sid(4));
                await svc.tick(ms(7 * DAY));
                assert.strictEqual((await svc.tick(ms(30 * DAY))).expired, 1);
                assert.strictEqual((await listingRepository.findById(lid(b.listing)))?.status, "expired");
                assert.strictEqual(dms(f).length, 1, "expiry sends no DM");
                assert.strictEqual((await postRepository.findById(String(b.post._id)))?.status, "approved", "post stays approved");
            }
            // catch-up tick
            {
                const { f, svc } = await setup();
                const b = await botL(sid(5));
                await svc.tick(ms(31 * DAY));
                assert.strictEqual((await listingRepository.findById(lid(b.listing)))?.status, "expired");
                assert.strictEqual(dms(f).length, 0, "catch-up sends nothing");
            }
            // nudges false still expires
            {
                const { f, svc } = await setup(false);
                const b = await botL(sid(6));
                await svc.tick(ms(8 * DAY));
                assert.strictEqual(dms(f).length, 0);
                await svc.tick(ms(30 * DAY));
                assert.strictEqual((await listingRepository.findById(lid(b.listing)))?.status, "expired");
            }
            // hold is untouched
            {
                const { f, svc } = await setup();
                const h = await grpL(sid(7), { hold: true });
                await svc.tick(ms(60 * DAY));
                assert.strictEqual((await listingRepository.findById(lid(h)))?.status, "live");
                assert.strictEqual(dms(f).length, 0);
            }
            // a post sold by 2.0.1
            {
                const { f, svc } = await setup();
                const b = await botL(sid(8));
                await PostModel.updateOne({ _id: b.post._id }, { $set: { status: "sold" } });
                await svc.tick(ms(7 * DAY));
                const l = await listingRepository.findById(lid(b.listing));
                assert.ok(dms(f).length === 0 && l?.status === "sold" && l.endedBy === "system", "sold post: no DM, listing sold by system");
            }
            // batch cap
            {
                const { f, svc } = await setup();
                for (let i = 0; i < 30; i++) await grpL(String(100100 + i));
                assert.strictEqual((await svc.tick(ms(7 * DAY))).nudged, 25);
                assert.strictEqual((await svc.tick(ms(7 * DAY))).nudged, 5);
                assert.strictEqual(dms(f).length, 30);
            }
            // transient error: claim released, the next tick sends
            {
                const { f, svc } = await setup();
                const g = await grpL(sid(9));
                f.failSend(Number(sid(9)));
                assert.strictEqual((await svc.tick(ms(7 * DAY))).nudged, 0);
                assert.ok(!("nudgedAt" in (await raw(g))), "claim released after a plain error");
                const healthy = fakeApi();
                await new LifecycleService(healthy.api, { nudges: true, approvedGroupId: CHAT, lang: "en" } as BotConfig, asPostService(ps), () => "bot").tick(ms(7 * DAY + 600_000));
                assert.strictEqual(dms(healthy).length, 1, "next tick sends");
            }
            // concurrent ticks
            {
                const { f, svc } = await setup();
                await grpL(sid(10));
                await Promise.all([svc.tick(ms(7 * DAY)), svc.tick(ms(7 * DAY))]);
                assert.strictEqual(dms(f).length, 1, "concurrent ticks send once");
            }
            // 403 and 400 chat not found hold the nudge; released after the member's next settled message
            for (const [code, desc, n] of [[403, "Forbidden: bot was blocked by the user", 11], [400, "Bad Request: chat not found", 12]] as const) {
                const { f, svc } = await setup();
                const g = await grpL(sid(n), { note: { ephemeralMessageId: 77, sentAt: LT0 } });
                f.failSend(Number(sid(n)), code, desc);
                const r = await svc.tick(ms(7 * DAY));
                const held = await raw(g);
                assert.ok(r.held === 1 && held.nudgeHeld === true && held.nudgedAt, `${code} holds the nudge`);
                assert.strictEqual(dms(f).length, 1, "attempted once");
                assert.strictEqual(await svc.releaseHeldNudges(ms(8 * DAY)), 0, "no capture yet");
                await settledCapture(sid(n), ms(8 * DAY));
                assert.strictEqual(await svc.releaseHeldNudges(ms(8 * DAY + 119_000)), 0, "too early");
                assert.strictEqual(await svc.releaseHeldNudges(ms(8 * DAY + 120_000)), 1, "released after 2 min");
                const note = notes(f)[0];
                assert.ok(String(note.params.text).includes("gt"), "note carries the title");
                assert.ok(buttons(note).some(x => x.url === `https://t.me/bot?start=l_${lid(g)}`), "manage link");
                assert.ok(!(await raw(g)).nudgeHeld, "held cleared");
                assert.strictEqual(await svc.releaseHeldNudges(ms(8 * DAY + 130_000)), 0, "once");
                const after = await listingRepository.findById(lid(g));
                assert.ok(after?.note && after.note.ephemeralMessageId !== 77, "new note id stored");
                assert.ok(f.calls.some(c => c.method === "deleteEphemeralMessage" && c.params.ephemeral_message_id === 77), "previous note deleted");
                await Capture.deleteMany({ chatId: CHAT });
            }
            // held nudge cancelled by a refresh
            {
                const { f, svc } = await setup();
                const g = await grpL(sid(13));
                f.failSend(Number(sid(13)), 403);
                await svc.tick(ms(7 * DAY));
                await listingRepository.refresh(lid(g), ms(8 * DAY));
                await settledCapture(sid(13), ms(8 * DAY));
                assert.strictEqual(await svc.releaseHeldNudges(ms(9 * DAY)), 0);
                assert.strictEqual(notes(f).length, 0);
                await Capture.deleteMany({ chatId: CHAT });
            }
            // a held nudge never released expires
            {
                const { f, svc } = await setup();
                const g = await grpL(sid(14));
                f.failSend(Number(sid(14)), 403);
                await svc.tick(ms(7 * DAY));
                await svc.tick(ms(30 * DAY));
                assert.strictEqual((await listingRepository.findById(lid(g)))?.status, "expired");
            }
            // held nudge off switch, and the registered jobs
            {
                const { svc } = await setup(false);
                const g = await grpL(sid(15), { nudgeHeld: true, nudgedAt: ms(7 * DAY) });
                await settledCapture(sid(15), ms(8 * DAY));
                assert.strictEqual(await svc.releaseHeldNudges(ms(9 * DAY)), 0, "off switch");
                assert.strictEqual((await raw(g)).nudgeHeld, true, "still held");
                assert.deepStrictEqual(svc.jobs().map(j => [j.name, j.everyMs]), [["lifecycle", 600_000], ["held-nudges", 10_000]]);
                await Capture.deleteMany({ chatId: CHAT });
            }
            await Listing.deleteMany({});
            await PostModel.deleteMany({ userId: /^1\d{5}$/ });
            console.log("[OK] nudge, expiry and held nudges.");
        }

        // slice 3: trust line
        {
            const DAYS = 24 * 3600 * 1000;
            const NOW = new Date("2027-01-15T12:00:00Z");
            const ago = (d: number) => new Date(NOW.getTime() - d * DAYS);
            const P = `${RUN}-tl`;
            const lst = (seller: string, extra: Record<string, unknown>) => Listing.create({
                source: "group", origin: "capture", sellerId: `${P}-${seller}`, chatId: CHAT, messageIds: [1],
                title: "t", text: "x", media: [{ fileId: "f", type: "photo" }], status: "live", createdAt: NOW, refreshedAt: NOW, ...extra,
            });
            await Member.create({ userId: `${P}-new`, firstSeenAt: ago(10), askMode: "ask" });
            assert.strictEqual(await trustLineFor(`${P}-new`, "en", NOW), null, "trust line hidden for a new seller");
            await Member.create({ userId: `${P}-vet`, firstSeenAt: ago(90), askMode: "ask" });
            assert.strictEqual(await trustLineFor(`${P}-vet`, "en", NOW), `🤝 0 sales · in the market since ${formatSince(ago(90), "en")}`, "trust line shown for a veteran with no sales");
            await lst("sold", { status: "sold" });
            await lst("sold", { status: "sold", source: "bot", origin: "legacy", chatId: undefined, messageIds: [], postId: `${P}-p` });
            await lst("sold", { status: "live" });
            const line = await trustLineFor(`${P}-sold`, "en", NOW);
            assert.ok(line !== null && line.startsWith("🤝 2 sales"), "trust line counts sold across sources");
            await Member.create({ userId: `${P}-ear`, firstSeenAt: ago(20), askMode: "ask" });
            await User.create({ userId: `${P}-ear`, authLevel: 0, createdAt: ago(200) });
            await PostModel.create({ userId: `${P}-ear`, title: "t", description: "d", price: "1", location: "l", media: [], status: "pending", createdAt: ago(100) });
            const earLine = await trustLineFor(`${P}-ear`, "en", NOW);
            assert.strictEqual(earLine, `🤝 0 sales · in the market since ${formatSince(ago(200), "en")}`, "since is the earliest");
            assert.strictEqual(formatSince(new Date("2026-11-15T00:00:00Z"), "en"), "November 2026");
            console.log("[OK] trust line.");
        }

        // slice 3: /stalecheck
        {
            const HOUR = 3600 * 1000;
            const DAYMS = 24 * HOUR;
            const T = new Date("2027-02-01T10:00:00Z");
            const at = (ms: number) => new Date(T.getTime() + ms);
            const S1 = "100001", S2 = "100002", S3 = "100003";
            const cfg = { nudges: false, approvedGroupId: CHAT, lang: "en" } as BotConfig;
            type Fake = ReturnType<typeof fakeApi>;
            const dms = (f: Fake) => f.calls.filter(c => c.method === "sendMessage");
            const rows = (f: Fake, uid: string) => dms(f).filter(c => String(c.params.chat_id) === uid);
            const created = new Date("2026-03-05T22:30:00Z");
            const raw1 = async (l: { _id: unknown }) => (await Listing.collection.findOne({ _id: l._id as never }))!;
            const seed = async (seller: string, title: string, legacy = true) => {
                const post = await PostModel.create({ userId: seller, title, description: "d", price: "100", location: "l", media: [], status: "approved", createdAt: created });
                const listing = await Listing.create({
                    source: "bot", origin: legacy ? "legacy" : "dm", hold: legacy, postId: String(post._id), sellerId: seller, title, price: "100",
                    messageIds: [], media: [], status: "live", createdAt: created, refreshedAt: created,
                });
                return { post, listing };
            };
            const mkSvc = (f: Fake, c: BotConfig = cfg) => {
                const lifecycle = new LifecycleService(f.api, c, asPostService(stubPostService()), () => "bot");
                return { lifecycle, svc: new StaleCheckService(f.api, c) };
            };
            const fresh = async () => {
                await Listing.deleteMany({});
                await PostModel.deleteMany({ userId: /^1\d{5}$/ });
                const f = fakeApi();
                return { f, ...mkSvc(f) };
            };
            const seedAll = async () => {
                const a1 = await seed(S1, "Glock 17 alpha"); const a2 = await seed(S1, "Hi-capa beta");
                const b1 = await seed(S2, "Scope gamma"); const c1 = await seed(S3, "Normal delta", false);
                return { a1, a2, b1, c1 };
            };

            assert.deepStrictEqual(parseSellerIds("100001 100002"), { ids: ["100001", "100002"], invalid: [] });
            assert.deepStrictEqual(parseSellerIds("abc 12"), { ids: [], invalid: ["abc", "12"] });
            assert.deepStrictEqual(parseSellerIds(""), { ids: [], invalid: [] });

            // render
            {
                const items = [
                    { listingId: "a".repeat(24), title: "Alpha", price: "100", postedAt: created },
                    { listingId: "b".repeat(24), title: "Beta", price: "5", postedAt: new Date("2026-12-25T00:00:00Z") },
                ];
                const r = renderStaleDm({ firstName: "Dana", items, locale: "en" });
                assert.ok(r.text.includes("Dana") && r.text.includes("Alpha") && r.text.includes("Beta"), "names and titles");
                assert.ok(r.text.includes("1.") && r.text.includes("2."), "numbered");
                assert.ok(r.text.includes("5.3.2026") && r.text.includes("25.12.2026"), "UTC D.M.YYYY");
                assert.deepStrictEqual(r.keyboard.map(row => row.map(b => b.callback_data)), [
                    [`lc_r_${"a".repeat(24)}`, `lc_s_${"a".repeat(24)}`], [`lc_r_${"b".repeat(24)}`, `lc_s_${"b".repeat(24)}`]]);
                assert.ok(!JSON.stringify(r.keyboard).includes("lc_x_"), "no remove button");
                assert.ok(!renderStaleDm({ firstName: "", items, locale: "en" }).text.includes("  "), "no double space without a name");
            }

            // plan counts
            {
                const { svc } = await fresh();
                await seedAll();
                const all = await svc.plan(null);
                assert.deepStrictEqual([all.sellers.length, all.sellers.reduce((n, s) => n + s.listings.length, 0)], [2, 3]);
                const one = await svc.plan([S1]);
                assert.deepStrictEqual([one.sellers.length, one.sellers[0].listings.length], [1, 2]);
                assert.deepStrictEqual((await svc.plan(["999999"])).unknownIds, ["999999"]);
            }

            // pilot sends only to listed; no resend
            {
                const { f, svc } = await fresh();
                const { a1, a2, b1 } = await seedAll();
                const r = await svc.run([S1], T);
                assert.deepStrictEqual([r.sellersSent, r.listingsSent, r.busy], [1, 2, false]);
                assert.strictEqual(dms(f).length, 1, "exactly one DM");
                const dm = dms(f)[0];
                assert.strictEqual(String(dm.params.chat_id), S1);
                assert.ok(String(dm.params.text).includes("Glock 17 alpha") && String(dm.params.text).includes("Hi-capa beta"), "both titles in one DM");
                for (const x of [a1, a2]) {
                    const raw = await raw1(x.listing);
                    assert.ok(raw.hold === false && +raw.nudgedAt === +T && +raw.staleSentAt === +T && +raw.refreshedAt === +T, "claimed clocks");
                }
                assert.strictEqual((await raw1(b1.listing)).hold, true, "unlisted seller untouched");
                await svc.run([S1], at(HOUR));
                assert.strictEqual(dms(f).length, 1, "second run does not resend");
                await svc.run(null, at(HOUR));
                assert.deepStrictEqual(dms(f).map(c => String(c.params.chat_id)), [S1, S2], "all-run reaches only S2");
                await svc.run(null, at(HOUR));
                assert.strictEqual(dms(f).length, 2, "third run sends nothing");
            }

            // 403 and 400 chat not found expire
            for (const [code, desc] of [[403, "Forbidden: bot was blocked by the user"], [400, "Bad Request: chat not found"]] as const) {
                const { f, svc } = await fresh();
                const { b1 } = await seedAll();
                f.failSend(Number(S2), code, desc);
                const r = await svc.run([S2], T);
                const raw = await raw1(b1.listing);
                assert.ok(raw.status === "expired" && raw.endedBy === "system" && r.blocked === 1, `${code} expires`);
            }

            // transient failure restores the hold
            {
                const { f, svc } = await fresh();
                const { a1, a2 } = await seedAll();
                f.failSend(Number(S1));
                const realErr = console.error; console.error = () => {};
                let r;
                try { r = await svc.run([S1], T); } finally { console.error = realErr; }
                assert.strictEqual(r.failed, 1);
                for (const x of [a1, a2]) {
                    const raw = await raw1(x.listing);
                    assert.ok(raw.hold === true && !("nudgedAt" in raw) && !("staleSentAt" in raw), "hold restored");
                }
                const ok = fakeApi();
                await mkSvc(ok).svc.run([S1], at(HOUR));
                assert.strictEqual(dms(ok).length, 1, "re-run sends");
            }

            // an error between claim and send unclaims every claimed row and counts as failed
            {
                const { f, svc } = await fresh();
                const { a1, a2 } = await seedAll();
                const real = postRepository.findByIds;
                postRepository.findByIds = async () => { throw new Error("db down"); };
                const realErr = console.error; console.error = () => {};
                let r;
                try { r = await svc.run([S1], T); } finally { postRepository.findByIds = real; console.error = realErr; }
                assert.strictEqual(r.failed, 1);
                assert.strictEqual(dms(f).length, 0, "no DM");
                for (const x of [a1, a2]) {
                    const raw = await raw1(x.listing);
                    assert.ok(raw.hold === true && !("nudgedAt" in raw) && !("staleSentAt" in raw), "unclaimed after the error");
                }
                const ok = fakeApi();
                await mkSvc(ok).svc.run([S1], at(HOUR));
                assert.strictEqual(dms(ok).length, 1, "re-run sends");
            }

            // a claimed listing whose post is missing is unclaimed (ledger)
            {
                const { f, svc } = await fresh();
                const { a1 } = await seedAll();
                await PostModel.deleteOne({ _id: a1.post._id });
                await svc.run([S1], T);
                assert.ok(!String(rows(f, S1)[0].params.text).includes("Glock 17 alpha"), "missing post dropped from the DM");
                const raw = await raw1(a1.listing);
                assert.ok(raw.hold === true && !("staleSentAt" in raw), "missing post: unclaimed");
            }

            // concurrent runs
            {
                const { f, svc } = await fresh();
                await seedAll();
                const [r1, r2] = await Promise.all([svc.run(null, T), svc.run(null, T)]);
                assert.strictEqual([r1, r2].filter(r => r.busy).length, 1, "one run is busy");
                assert.strictEqual(dms(f).length, 2, "one DM per seller");
            }

            // a post sold by 2.0.1 is dropped
            {
                const { f, svc } = await fresh();
                const { a1, b1 } = await seedAll();
                await PostModel.updateOne({ _id: a1.post._id }, { $set: { status: "sold" } });
                await svc.run([S1], T);
                const text = String(rows(f, S1)[0].params.text);
                assert.ok(!text.includes("Glock 17 alpha") && text.includes("Hi-capa beta"), "sold post dropped from the DM");
                const soldRaw = await raw1(a1.listing);
                assert.ok(soldRaw.status === "sold" && soldRaw.endedBy === "system", "its listing is sold by system");
                await PostModel.updateOne({ _id: b1.post._id }, { $set: { status: "sold" } });
                const n = dms(f).length;
                await svc.run([S2], T);
                assert.strictEqual(dms(f).length, n, "all sold: no DM");
                assert.strictEqual((await raw1(b1.listing)).status, "sold");
            }

            // 7-day answer window, relist and sell after expiry
            {
                const { f, lifecycle, svc } = await fresh();
                const { a1, a2, b1 } = await seedAll();
                await svc.run(null, T);
                assert.strictEqual(dms(f).length, 2);
                await lifecycle.refreshListing(String(a1.listing._id), S1, at(2 * DAYMS));
                await lifecycle.tick(at(7 * DAYMS - 1));
                assert.strictEqual((await raw1(a2.listing)).status, "live", "not yet");
                await lifecycle.tick(at(7 * DAYMS));
                const exp = await raw1(a2.listing);
                assert.ok(exp.status === "expired" && exp.endedBy === "system", "unanswered expires at 7d");
                assert.strictEqual((await raw1(a1.listing)).status, "live", "answered stays live");
                const nf = fakeApi();
                const nl = mkSvc(nf, { ...cfg, nudges: true } as BotConfig).lifecycle;
                await nl.tick(at(7 * DAYMS));
                assert.ok(!nf.calls.some(c => String(c.params.chat_id) === S1), "not nudged at day 7 (refreshed day 2)");
                await nl.tick(at(9 * DAYMS));
                assert.ok(nf.calls.some(c => String(c.params.chat_id) === S1), "nudged at day 9");
                const rl = await lifecycle.refreshListing(String(a2.listing._id), S1, at(10 * DAYMS));
                assert.strictEqual(rl.listing?.status, "live", "relist after expiry");
                const sl = await lifecycle.sellListing(String(b1.listing._id), S2, at(10 * DAYMS));
                assert.strictEqual(sl.listing?.status, "sold", "sell after expiry");
                assert.strictEqual((await PostModel.findById(b1.post._id))?.status, "sold", "post sold");
            }
            await Listing.deleteMany({});
            await PostModel.deleteMany({ userId: /^1\d{5}$/ });
            console.log("[OK] /stalecheck service.");
        }
    } finally {
        await Member.deleteMany({ userId: { $in: odIds } });
        const like = new RegExp(`^${RUN}`);
        await Promise.all([
            Capture.deleteMany({ chatId: CHAT }),
            Listing.deleteMany({ sellerId: like }),
            PostModel.deleteMany({ userId: like }),
            Member.deleteMany({ userId: like }),
            User.deleteMany({ userId: like }),
            Draft.deleteMany({ userId: like }),
            ShadowLog.deleteMany({ chatId: CHAT }),
        ]);
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkMarket failed:", err);
    process.exit(1);
});
