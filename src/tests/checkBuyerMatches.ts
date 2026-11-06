import assert from "assert";
import mongoose from "mongoose";
import AlertLog from "../models/AlertLog";
import Listing from "../models/Listing";
import SavedSearch from "../models/SavedSearch";
import ShadowLog from "../models/ShadowLog";
import alertLogRepository from "../repositories/alertLogRepository";
import listingRepository from "../repositories/listingRepository";
import savedSearchRepository, { SEARCH_LIFE_MS } from "../repositories/savedSearchRepository";
import shadowLogRepository from "../repositories/shadowLogRepository";
import Capture from "../models/Capture";
import Member from "../models/Member";
import type { BotConfig } from "../types";
import { BuyerNoteService } from "../services/buyerNoteService";
import { classify } from "../services/classifier";
import type { GroupListingService } from "../services/groupListingService";
import { isSearchable, matchListings, parseQuery } from "../services/matchService";
import { processOneClosed, type ClassifiedEvent } from "../services/shadowService";
import { seedCapture } from "./fixtures";
import { createHarness } from "./harness";

// Buyer query parsing and matching (slice 4). The pure part always runs; the
// Mongo part (later tasks) prints [SKIP] without MONGO_URI.
const MONGO_URI = process.env.MONGO_URI;

const L = (id: string, text: string, extra: { location?: string; meetup?: boolean } = {}) =>
    ({ _id: id, title: undefined, text, priceValue: 100, refreshedAt: new Date(1_000_000_000_000), ...extra }) as unknown as Parameters<typeof matchListings>[1][number]; // string ids: only String(_id) is read

function checkPure() {
    const a = parseQuery("מחפש גלוק 17 עד 800");
    assert.ok(a.terms.includes("glock") && a.terms.includes("17"), "alias head and number are terms");
    assert.strictEqual(a.maxPrice, 800);
    assert.strictEqual(a.meetup, false);

    const b = parseQuery("מחפש כוונת, טלפון 050-1234567");
    assert.ok(!b.terms.includes("050") && !b.terms.includes("1234567"), "phone number is not a term");
    assert.ok(!isSearchable(b), "no strong term left");
    assert.ok(!isSearchable(parseQuery("מחפש וסט")), "'וסט' alone is not strong");

    const c = parseQuery("מחפש glock בבית דגן");
    assert.strictEqual(c.meetup, true);
    assert.ok(!c.terms.includes("בית") && !c.terms.includes("דגנ"), "the meeting point is not a term");
    assert.ok(c.terms.includes("glock"));
    assert.strictEqual(c.query, c.terms.join(" "));

    assert.strictEqual(parseQuery(Array.from({ length: 30 }, (_, i) => `m${i + 1}`).join(" ")).terms.length, 20, "terms capped at 20");

    const bd = L("bd", "glock 17", { location: "בית דגן" });
    const mu = L("mu", "glock 19", { meetup: true });
    const far = L("far", "glock 17", { location: "מרכז" });
    assert.deepStrictEqual(matchListings(parseQuery("מחפש glock בבית דגן"), [far, bd, mu]).sort(), ["bd", "mu"], "meetup query keeps only meeting-point listings");
    assert.deepStrictEqual(matchListings(parseQuery("מחפש glock"), [far, bd]).sort(), ["bd", "far"], "no meetup filter without the phrase");
    assert.deepStrictEqual(matchListings(parseQuery("מחפש כוונת 0501234567"), [L("p", "כוונת 050 במצב טוב")]), [], "a phone number is not matched on");
    console.log("[OK] buyer query parsing and matching.");
}

const U = `bm-${Date.now()}`;

async function checkCollections() {
    const now = new Date();
    await Promise.all([SavedSearch.syncIndexes(), AlertLog.syncIndexes()]);
    const id = (r: { _id: unknown } | null | undefined) => String(r?._id);
    try {
        const q = parseQuery("מחפש glock 17 עד 800");
        const a = await savedSearchRepository.upsert(U, q, now);
        const b = await savedSearchRepository.upsert(U, q, new Date(now.getTime() + 1000));
        assert.strictEqual(id(a), id(b), "upsert twice gives one row");
        assert.strictEqual(await SavedSearch.countDocuments({ userId: U }), 1);
        assert.strictEqual(a.expiresAt.getTime(), now.getTime() + SEARCH_LIFE_MS);
        assert.strictEqual(a.maxPrice, 800);

        const ttl = (await SavedSearch.collection.indexes()).find(i => i.key.expiresAt === 1);
        assert.strictEqual(ttl?.expireAfterSeconds, 0, "TTL index on expiresAt");

        await SavedSearch.create({ userId: U, query: "old", terms: ["old"], createdAt: now, scannedAt: now, expiresAt: new Date(now.getTime() - 1000) });
        assert.ok(!(await savedSearchRepository.findActive(now)).some(r => r.query === "old"), "findActive leaves out an expired row");
        assert.strictEqual(await savedSearchRepository.countActive(U, now), 1);

        const later = new Date(now.getTime() + 1000);
        const upd = await savedSearchRepository.update(id(a), parseQuery("מחפש glock 19"), later);
        assert.ok(upd);
        assert.strictEqual(upd.maxPrice, undefined, "a removed ceiling is unset");
        assert.strictEqual((await SavedSearch.collection.findOne({ _id: a._id }))?.maxPrice, undefined, "and gone from the stored row");
        assert.strictEqual((await savedSearchRepository.findById(id(a)))?.scannedAt.getTime(), later.getTime());

        // renewal offer: due, claimed once; renew clears it
        const until = new Date(now.getTime() + SEARCH_LIFE_MS + 1000);
        assert.ok((await savedSearchRepository.findDueRenewal(now, until, 10)).some(r => id(r) === id(a)), "due for renewal");
        assert.strictEqual(await savedSearchRepository.claimRenewOffer(id(a), now), true);
        assert.strictEqual(await savedSearchRepository.claimRenewOffer(id(a), now), false, "claims once");
        assert.ok(!(await savedSearchRepository.findDueRenewal(now, until, 10)).some(r => id(r) === id(a)), "offered rows are not due");
        const r = await savedSearchRepository.renew(id(a), U, later);
        assert.strictEqual(r?.expiresAt.getTime(), later.getTime() + SEARCH_LIFE_MS);
        assert.strictEqual(r?.renewOfferedAt, undefined, "renew clears the offer");

        await savedSearchRepository.setScanned(id(a), later, true);
        assert.strictEqual((await savedSearchRepository.findById(id(a)))?.lastAlertAt?.getTime(), later.getTime());
        assert.strictEqual(await savedSearchRepository.deleteOne(id(a), "someone-else"), false);
        assert.strictEqual(await savedSearchRepository.deleteOne(id(a), U), true);
        assert.strictEqual(await savedSearchRepository.deleteByUser(U), 1, "the expired leftover row goes too");
    } finally {
        await SavedSearch.deleteMany({ userId: U });
    }

    try {
        assert.strictEqual(await alertLogRepository.claim("s1", U, "l1", now), true);
        assert.strictEqual(await alertLogRepository.claim("s1", U, "l1", now), false, "claim twice: false");
        assert.strictEqual(await alertLogRepository.userHas(U, "l1"), true);
        const before = new Date(now.getTime() - 1000);
        const sent = await alertLogRepository.countSentSince(before);
        await alertLogRepository.markFailed("s1", "l1");
        assert.strictEqual(await alertLogRepository.countSentSince(before), sent - 1, "failed sends are not counted");
        await alertLogRepository.release("s1", "l1");
        assert.strictEqual(await alertLogRepository.claim("s1", U, "l1", now), true, "release frees the pair");
    } finally {
        await AlertLog.deleteMany({ userId: U });
    }

    const since = new Date(now.getTime() - 3600_000);
    const mk = (extra: object) => ({ source: "group", origin: "capture", messageIds: [1], sellerId: U, media: [], isBundle: false, createdAt: now, refreshedAt: now, status: "live", hold: false, ...extra });
    try {
        await Listing.collection.insertMany([
            mk({ text: "live" }),
            mk({ text: "held", hold: true }),
            mk({ text: "sold", status: "sold" }),
            mk({ text: "stale", refreshedAt: new Date(since.getTime() - 1000) }),
        ]);
        const got = (await listingRepository.findLiveRefreshedSince(since)).filter(l => l.sellerId === U);
        assert.deepStrictEqual(got.map(l => l.text), ["live"], "only live, unheld, fresh");
        assert.strictEqual((await listingRepository.findByIds([id(got[0])])).length, 1);
    } finally {
        await Listing.deleteMany({ sellerId: U });
    }

    const row = (extra: object) => ({ chatId: 1, messageIds: [1], senderId: U, at: now, tier: "wtb" as const, rules: [], wouldList: false, ...extra });
    try {
        await ShadowLog.deleteMany({}); // throwaway database only (name guard above): exact counts and a deterministic sample
        const r1 = await shadowLogRepository.insert(row({ matches: ["x"] }));
        const r2 = await shadowLogRepository.insert(row({ matches: ["x"] }));
        await shadowLogRepository.insert(row({}));
        assert.ok(await shadowLogRepository.setMatchLabel(id(r1), "useful", "m1", now));
        assert.strictEqual(await shadowLogRepository.setMatchLabel(id(r1), "not_useful", "m2", now), null, "first label wins");
        await shadowLogRepository.setMatchLabel(id(r2), "not_useful", "m1", now);
        await shadowLogRepository.setBuyerNote(id(r1), now);
        const r4 = await shadowLogRepository.insert(row({ matches: ["y"] }));
        assert.strictEqual(id(await shadowLogRepository.sampleUnlabeledMatches()), id(r4), "the one unlabeled row with matches comes back");
        assert.strictEqual(await shadowLogRepository.sampleUnlabeledMatches(id(r4)), null, "excludeId leaves nothing");
        assert.deepStrictEqual(await shadowLogRepository.buyerStats(new Date(now.getTime() - 1000)), { wanted: 4, withMatches: 3, noted: 1, useful: 1, notUseful: 1 });
    } finally {
        await ShadowLog.deleteMany({ senderId: U });
    }
    console.log("[OK] saved searches, alert log, listing and shadow log additions.");
}

const CHAT = -1009990044;

async function checkBuyerNote() {
    const now = new Date();
    const poster = String(900000000 + (Date.now() % 1000000)); // numeric: sendNote receivers are numbers
    const seller = `${U}-s`;
    const WANT = "מחפש glock 17";
    const sends = (h: ReturnType<typeof createHarness>) => h.calls.filter(c => c.method === "sendMessage");
    const groupListings = { groupLink: async (id: number) => `https://t.me/g/${id}` } as unknown as GroupListingService;
    const mkSvc = (buyerMatches: BotConfig["buyerMatches"], h = createHarness()) =>
        ({ h, svc: new BuyerNoteService(h.bot.api, { approvedGroupId: CHAT, lang: "en", buyerMatches } as BotConfig, groupListings, () => "testbot") });
    const mkListing = (sellerId: string, title: string) => Listing.create({
        source: "group", origin: "capture", chatId: CHAT, messageIds: [7], sellerId, title, text: `${title} למכירה`, priceValue: 100, price: "100",
        media: [], isBundle: false, status: "live", hold: false, createdAt: now, refreshedAt: now,
    });
    const event = async (shadowId: string, extra: { chatId?: number; text?: string } = {}, matches?: string[]): Promise<ClassifiedEvent> => {
        const text = extra.text ?? WANT;
        return { capture: await seedCapture({ senderId: poster, chatId: extra.chatId ?? CHAT, text }), result: classify(text, false), shadowId, matches };
    };
    const newRow = async () => String((await shadowLogRepository.insert({ chatId: CHAT, messageIds: [1], senderId: poster, at: now, tier: "wtb", rules: [], wouldList: false }))._id);
    const noted = async (id: string) => (await ShadowLog.findById(id))?.buyerNoteAt;
    const reset = () => Member.deleteMany({ userId: poster });
    // a closed, unclassified capture for the sweeper path
    const seedClosed = async (senderId: string) => {
        const c = await seedCapture({ senderId, chatId: CHAT, text: WANT, state: "closed" });
        await Capture.updateOne({ _id: c._id }, { $unset: { tier: 1, rules: 1, parsed: 1 } });
    };

    try {
        const mine = await mkListing(seller, "Glock 17");
        await mkListing(poster, "Glock 17 own");
        const lid = String(mine._id);

        // one match
        let { h, svc } = mkSvc("on");
        let row = await newRow();
        await svc.onClassified(await event(row, {}, [lid]), now);
        assert.strictEqual(sends(h).length, 1);
        const p = sends(h)[0].params;
        assert.strictEqual((p.ephemeral_message_parameters as { receiver_user_id: number }).receiver_user_id, Number(poster));
        assert.ok(String(p.text).includes("Glock 17"), "the title is in the note");
        const url = (p.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0][0].url;
        assert.ok(/start=s_[0-9a-f]{24}$/.test(url), "alert button deep link");
        assert.ok(await noted(row), "buyerNoteAt set");

        // zero matches
        await reset();
        ({ h, svc } = mkSvc("on"));
        await svc.onClassified(await event(await newRow(), {}, []), now);
        assert.strictEqual(sends(h).length, 1);
        assert.ok(String(sends(h)[0].params.text).startsWith("Nothing on the market"), "empty note text");

        // real matches through processOneClosed: the poster's own listing is left out
        await reset();
        ({ h, svc } = mkSvc("on"));
        await Capture.deleteMany({ chatId: CHAT });
        await seedClosed(poster);
        while (await processOneClosed({ approvedGroupId: CHAT, lang: "en", buyerMatches: "on" } as BotConfig, now, (e, n) => svc.onClassified(e, n))) { /* drain */ }
        assert.strictEqual(sends(h).length, 1);
        const text = String(sends(h)[0].params.text);
        assert.ok(text.includes("Glock 17") && !text.includes("Glock 17 own"), "own listing not in the note");

        // off and shadow: nothing sent; shadow still writes matches
        for (const mode of ["off", "shadow"] as const) {
            await reset();
            await Capture.deleteMany({ chatId: CHAT });
            ({ h, svc } = mkSvc(mode));
            await seedClosed(`${U}-q`);
            await processOneClosed({ approvedGroupId: CHAT, lang: "en", buyerMatches: mode } as BotConfig, now, (e, n) => svc.onClassified(e, n));
            assert.strictEqual(sends(h).length, 0, `${mode}: no send`);
            const logged = await ShadowLog.findOne({ senderId: `${U}-q` }).sort({ _id: -1 });
            assert.ok(mode === "shadow" ? logged?.matches?.includes(lid) : !logged?.matches?.length, `${mode}: matches`);
        }

        // never, 6 h gap
        await reset();
        await Member.create({ userId: poster, firstSeenAt: now, askMode: "never" });
        ({ h, svc } = mkSvc("on"));
        await svc.onClassified(await event(await newRow(), {}, [lid]), now);
        assert.strictEqual(sends(h).length, 0, "askMode never");

        await reset();
        ({ h, svc } = mkSvc("on"));
        await svc.onClassified(await event(await newRow(), {}, [lid]), now);
        await svc.onClassified(await event(await newRow(), {}, [lid]), new Date(now.getTime() + 6 * 3600_000 - 1000));
        assert.strictEqual(sends(h).length, 1, "second wanted post within 6 h: silent");
        await svc.onClassified(await event(await newRow(), {}, [lid]), new Date(now.getTime() + 6 * 3600_000 + 1000));
        assert.strictEqual(sends(h).length, 2, "after 6 h: sends");

        // failed send
        await reset();
        ({ h, svc } = mkSvc("on", createHarness({ responses: { sendMessage: { ok: false, error_code: 400, description: "x" } } })));
        row = await newRow();
        await svc.onClassified(await event(row, {}, [lid]), now);
        assert.strictEqual((await Member.findOne({ userId: poster }))?.lastBuyerNoteAt, undefined, "failed send leaves no gap");
        assert.strictEqual(await noted(row), undefined);

        // strict tier, other chat
        await reset();
        ({ h, svc } = mkSvc("on"));
        await svc.onClassified(await event(await newRow(), { text: "Glock 17 למכירה 900 ש\"ח" }, [lid]), now);
        await svc.onClassified(await event(await newRow(), { chatId: CHAT - 1 }, [lid]), now);
        assert.strictEqual(sends(h).length, 0, "strict tier and another chat");
    } finally {
        await Promise.all([Listing.deleteMany({ sellerId: { $in: [seller, poster] } }), Capture.deleteMany({ chatId: { $in: [CHAT, CHAT - 1] } }), ShadowLog.deleteMany({ chatId: CHAT }), reset()]);
    }
    console.log("[OK] buyer note.");
}

async function run() {
    checkPure();
    if (!MONGO_URI) {
        console.log("[SKIP] checkBuyerMatches (Mongo part): set MONGO_URI to run this test.");
        return;
    }
    await mongoose.connect(MONGO_URI);
    try {
        assert.ok(/test/i.test(mongoose.connection.name), `refusing to run on database "${mongoose.connection.name}" (name must contain "test")`);
        await checkCollections();
        await checkBuyerNote();
    } finally {
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkBuyerMatches failed:", err);
    process.exit(1);
});
