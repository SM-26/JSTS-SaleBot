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
import { AlertService } from "../services/alertService";
import { sendNote } from "../services/ephemeralNotes";
import { BuyerNoteService } from "../services/buyerNoteService";
import { classify } from "../services/classifier";
import type { GroupListingService } from "../services/groupListingService";
import { isSearchable, matchListings, parseQuery } from "../services/matchService";
import { processOneClosed, type ClassifiedEvent } from "../services/shadowService";
import { seedCapture } from "./fixtures";
import { BOT_USERNAME, createHarness, type HarnessOptions } from "./harness";

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

    // a budget number is not a model name: a named term (glock, m4) decides, numbers only rank
    const budget = parseQuery("מחפש גלוק 17, תקציב 800 שח");
    assert.deepStrictEqual(matchListings(budget, [L("v", "וסט טקטי 800"), L("s", "כוונת 17")]), [], "800 and 17 alone do not match when a model is named");
    assert.deepStrictEqual(matchListings(budget, [L("g", "glock 19")]), ["g"]);
    assert.deepStrictEqual(matchListings(parseQuery("מחפש M4 בתקציב 1500"), [L("ak", "ak 1500")]), [], "a budget is not a model");
    assert.deepStrictEqual(matchListings(parseQuery("מחפש 1911"), [L("c", "1911 מצוין")]), ["c"], "a number alone is still strong");
    // a category head (gbb, aeg, hpa) must not silence a model number
    assert.deepStrictEqual(matchListings(parseQuery("מחפש gbb 1911"), [L("c", "1911 מצוין")]), ["c"], "gbb alone does not decide");
    assert.deepStrictEqual(matchListings(parseQuery("מחפש aeg 416"), [L("h", "hk 416 מצוין")]), ["h"], "aeg alone does not decide");
    assert.deepStrictEqual(matchListings(parseQuery("מחפש glock gbb 1911"), [L("g", "glock 19"), L("c", "1911 מצוין")]), ["g"], "glock still decides");
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
        assert.strictEqual(p.parse_mode, "HTML");
        assert.deepStrictEqual(p.link_preview_options, { is_disabled: true });
        const plain = createHarness();
        await sendNote(plain.bot.api, { approvedGroupId: CHAT } as BotConfig, Number(poster), { text: "x", keyboard: [] });
        assert.strictEqual(sends(plain)[0].params.parse_mode, undefined, "a plain card has no parse_mode");
        assert.strictEqual(sends(plain)[0].params.link_preview_options, undefined, "and no preview option");

        // zero matches
        await reset();
        ({ h, svc } = mkSvc("on"));
        await svc.onClassified(await event(await newRow(), {}, []), now);
        assert.strictEqual(sends(h).length, 1);
        assert.ok(String(sends(h)[0].params.text).startsWith("Nothing on the market"), "empty note text");

        // a wanted post the bot cannot search: no note, no gap started
        await reset();
        ({ h, svc } = mkSvc("on"));
        await svc.onClassified(await event(await newRow(), { text: "מחפש וסט" }, []), now);
        assert.strictEqual(sends(h).length, 0, "unsearchable: no note");
        assert.strictEqual((await Member.findOne({ userId: poster }))?.lastBuyerNoteAt, undefined, "and no lastBuyerNoteAt");

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

async function checkSavedSearchDm() {
    // config.json is read at import time, so load the controller only after the SKIP check.
    const { BotController } = await import("../controllers/botController");
    const { default: Draft } = await import("../models/Draft");
    const h = createHarness();
    const controller = new BotController(h.bot.api);
    controller.registerRoutes(h.bot, BOT_USERNAME);
    const original = controller.config.buyerMatches;
    const base = 7_100_000_000 + (Date.now() % 1_000_000_000);
    const [u1, u2, u3] = [base, base + 1, base + 2];
    const WANT = "מחפש glock 17";
    const rows = (u: number) => SavedSearch.find({ userId: String(u) }).sort({ createdAt: 1 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const sent = () => h.calls.filter((c) => c.method === "sendMessage");
    const lastText = () => String(sent().at(-1)?.params.text);
    const say = async (text: string, o: { userId: number; replyToMessageId?: number }) => {
        h.calls.length = 0;
        await h.sendText(text, o);
        await sleep(150);
    };
    const press = async (data: string, userId: number, messageId = 7) => {
        h.calls.length = 0;
        await h.pressButton(data, { userId, messageId });
        await sleep(150);
        return h.calls.filter((c) => c.method === "answerCallbackQuery");
    };
    const t = (key: string) => localeService.t("en", key);
    const cap = async (senderId: number, text: string) => String((await seedCapture({ senderId: String(senderId), text, state: "classified" }))._id);
    const promptId = () => Number((sent().at(-1)?.result as { message_id: number }).message_id);
    const { localeService } = await import("../services/localeService");

    try {
        controller.config.buyerMatches = "on";
        const c1 = await cap(u1, WANT);
        await say(`/start s_${c1}`, { userId: u1 });
        assert.strictEqual((await rows(u1)).length, 1, "the s_ link saves a search");
        assert.ok(lastText().includes("glock 17"), "the reply has the parsed query");
        await say(`/start s_${c1}`, { userId: u1 });
        assert.strictEqual((await rows(u1)).length, 1, "a second press leaves one row");

        await say(`/start s_${c1}`, { userId: u2 });
        assert.strictEqual((await rows(u2)).length, 0, "another user's link saves nothing");
        assert.ok(!lastText().includes("glock"), "and does not show the text");
        assert.strictEqual(lastText(), t("alertLinkExpired"));
        await say(`/start s_${"0".repeat(24)}`, { userId: u1 });
        assert.strictEqual(lastText(), t("alertLinkExpired"), "unknown id");

        controller.config.buyerMatches = "shadow";
        await say(`/start s_${await cap(u3, WANT)}`, { userId: u3 });
        assert.strictEqual((await rows(u3)).length, 0, "shadow: no row");
        assert.strictEqual(lastText(), t("greeting"), "shadow: the greeting");
        controller.config.buyerMatches = "on";

        // not searchable, then a plain text fixes it
        await say(`/start s_${await cap(u3, "מחפש וסט")}`, { userId: u3 });
        assert.strictEqual((await rows(u3)).length, 0);
        assert.strictEqual(lastText(), t("alertNotSearchable"));
        await say("glock 17", { userId: u3 });
        assert.strictEqual((await rows(u3)).length, 1, "plain text saves after a failed link");

        // saved, then plain text changes the same row, a third text goes the normal path
        await say("glock 19", { userId: u1 });
        const after = await rows(u1);
        assert.strictEqual(after.length, 1);
        assert.strictEqual(after[0].query, "glock 19", "same row, query changed");
        assert.strictEqual(lastText(), "Alert updated: glock 19.");
        await say("glock 26", { userId: u1 });
        assert.strictEqual((await rows(u1))[0].query, "glock 19", "pending was cleared");

        // an open wizard draft wins over a plain text, but not over a true reply
        await say(`/start s_${c1}`, { userId: u1 }); // saves glock 17 again (new row)
        const pid = promptId();
        await say("/newPost", { userId: u1 });
        assert.ok(await Draft.findOne({ userId: String(u1) }), "wizard draft open");
        await say("A bicycle", { userId: u1 });
        assert.strictEqual((await Draft.findOne({ userId: String(u1) }))?.title, "A bicycle", "the wizard saw it");
        assert.ok(!(await rows(u1)).some((r) => r.query === "a bicycle"), "search unchanged");
        await say("glock 43", { userId: u1, replyToMessageId: pid });
        assert.ok((await rows(u1)).some((r) => r.query === "glock 43"), "a true reply changes the search");

        // pending older than an hour is ignored
        await Draft.deleteMany({ userId: String(u1) });
        await say(`/start s_${await cap(u2, WANT)}`, { userId: u2 });
        const realNow = Date.now;
        Date.now = () => realNow() + 2 * 3600_000;
        try {
            await say("glock 99", { userId: u2 });
        } finally {
            Date.now = realNow;
        }
        assert.deepStrictEqual((await rows(u2)).map((r) => r.query), ["glock 17"], "an hour-old fix is ignored");

        // a new ceiling on an existing search is written
        await SavedSearch.deleteMany({ userId: String(u2) });
        await say("/alerts m4 עד 2000", { userId: u2 });
        await say("/alerts m4 עד 800", { userId: u2 });
        let m4 = await rows(u2);
        assert.strictEqual(m4.length, 1, "one row");
        assert.strictEqual(m4[0].maxPrice, 800, "the new ceiling replaced the old");
        await say("/alerts m4", { userId: u2 });
        m4 = await rows(u2);
        assert.strictEqual(m4.length, 1);
        assert.strictEqual(m4[0].maxPrice, undefined, "no ceiling: it is gone");

        // a stray text after saving clears the pending fix and says nothing
        await say("תודה", { userId: u2 });
        assert.ok(!sent().some((c) => String(c.params.text) === t("alertNotSearchable")), "no alertNotSearchable reply");
        await say("glock 77", { userId: u2 });
        assert.deepStrictEqual((await rows(u2)).map((r) => r.query), ["m4"], "the next searchable text changes nothing");

        // fix reply: a text that duplicates another row, and shadow mode clears the pending fix
        await say("/alerts cz 75", { userId: u2 });
        await say("/alerts mp5", { userId: u2 });
        await say("cz 75", { userId: u2 });
        assert.strictEqual(lastText(), t("alertDuplicate"));
        controller.config.buyerMatches = "shadow";
        await say("glock 98", { userId: u2 });
        controller.config.buyerMatches = "on";
        await say("glock 97", { userId: u2 });
        assert.deepStrictEqual((await rows(u2)).map((r) => r.query).sort(), ["cz 75", "m4", "mp5"], "shadow cleared the pending fix; nothing changed");

        // limit
        await SavedSearch.deleteMany({ userId: String(u2) });
        for (const m of ["glock 17", "cz 75", "sig 226", "beretta 92", "glock 34"]) await say(`/alerts ${m}`, { userId: u2 });
        assert.strictEqual((await rows(u2)).length, 5);
        await say("/alerts glock 45", { userId: u2 });
        assert.strictEqual(lastText(), t("alertLimit"));
        assert.strictEqual((await rows(u2)).length, 5, "still five");
        await say("/alerts glock 17", { userId: u2 });
        assert.notStrictEqual(lastText(), t("alertLimit"), "an existing query is a duplicate, not a sixth");
        const before = (await rows(u2)).map((r) => r.query);
        await say("/alerts ak", { userId: u2 });
        assert.strictEqual(lastText(), t("alertLimit"));
        await say("ak 47", { userId: u2 });
        assert.deepStrictEqual((await rows(u2)).map((r) => r.query), before, "the limit message cleared the older pending fix");

        // /alerts list: own rows only, a bin per row
        await say("/alerts", { userId: u2 });
        const kb = (sent().at(-1)?.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
        assert.strictEqual(kb.length, 5);
        assert.ok(kb.every((r) => r[0].text.startsWith("🗑")));
        const list3 = String((await (async () => { await say("/alerts", { userId: u3 }); return sent().at(-1)?.params.text; })()));
        assert.ok(!list3.includes("cz 75"), "another user's list is not shown");

        // buttons
        const mine = await rows(u2);
        const victim = String(mine[0]._id);
        let answers = await press(`al_${victim}_d`, u3);
        assert.strictEqual(await SavedSearch.countDocuments({ _id: victim }), 1, "someone else cannot delete");
        assert.strictEqual(answers[0].params.text, t("notYourButton"));
        const exp = (await SavedSearch.findById(victim))!.expiresAt.getTime();
        await SavedSearch.updateOne({ _id: victim }, { $set: { expiresAt: new Date(exp - 10 * 24 * 3600_000) } });
        answers = await press(`al_${victim}_r`, u2);
        assert.ok((await SavedSearch.findById(victim))!.expiresAt.getTime() > exp - 1000, "renew moves expiresAt");
        assert.strictEqual(answers.length, 1);
        answers = await press(`al_${victim}_d`, u2);
        assert.strictEqual(await SavedSearch.countDocuments({ _id: victim }), 0, "the owner deletes");
        assert.strictEqual(answers.length, 1, "answered once");
        answers = await press(`al_${victim}_d`, u2);
        assert.strictEqual(answers[0].params.text, t("staleButton"), "press on a deleted row");

        // off: /alerts with text is refused; the list still shows existing rows
        controller.config.buyerMatches = "off";
        await SavedSearch.deleteMany({ userId: String(u3) });
        await say("/alerts glock 17", { userId: u3 });
        assert.strictEqual(lastText(), t("alertsNotAvailable"));
        assert.strictEqual((await rows(u3)).length, 0);

        // help
        for (const [mode, expected] of [["on", true], ["shadow", false]] as const) {
            controller.config.buyerMatches = mode;
            await say("/help", { userId: u3 });
            const rich = JSON.stringify(h.calls.find((c) => c.method === "sendRichMessage")?.params);
            assert.strictEqual(rich.includes("/alerts"), expected, `help under ${mode}`);
        }
    } finally {
        controller.config.buyerMatches = original;
        const ids = [u1, u2, u3].map(String);
        await Promise.all([SavedSearch.deleteMany({ userId: { $in: ids } }), Draft.deleteMany({ userId: { $in: ids } }), Capture.deleteMany({ senderId: { $in: ids } })]);
    }
    console.log("[OK] saved searches in the DM.");
}

async function checkAlerts() {
    const base = 7_200_000_000 + (Date.now() % 1_000_000_000);
    const [u1, u2] = [String(base), String(base + 1)];
    const created = new Date(Date.now() - 3600_000);
    const fresh = new Date(Date.now() - 1800_000);
    const groupListings = { groupLink: async (id: number) => { if (id === 666) throw new Error("poison"); return `https://t.me/g/${id}`; } } as unknown as GroupListingService;
    const mkSvc = (buyerMatches: BotConfig["buyerMatches"], responses?: HarnessOptions["responses"]) => {
        const h = createHarness({ responses });
        return { h, svc: new AlertService(h.bot.api, { lang: "en", buyerMatches } as BotConfig, groupListings) };
    };
    const to = (h: ReturnType<typeof createHarness>, u: string, method = "sendMessage") =>
        h.calls.filter(c => c.method === method && String(c.params.chat_id) === u);
    const mkListing = (sellerId: string, title: string, extra: Record<string, unknown> = {}) => Listing.create({
        source: "group", origin: "capture", chatId: -1009990002, messageIds: [7], sellerId, title, text: `${title} למכירה`, priceValue: 100, price: "100",
        media: [], isBundle: false, status: "live", hold: false, createdAt: fresh, refreshedAt: fresh, ...extra,
    });
    const search = (u: string, text = "מחפש glock 17") => savedSearchRepository.upsert(u, parseQuery(text), created);
    const logs = (u: string) => AlertLog.countDocuments({ userId: u });
    const scanned = async (s: { _id: unknown }) => (await SavedSearch.findById(s._id))?.scannedAt.getTime();
    const sellers = new RegExp(`^al-${U}`);
    const reset = () => Promise.all([SavedSearch.deleteMany({ userId: { $in: [u1, u2] } }), Listing.deleteMany({ $or: [{ sellerId: sellers }, { sellerId: { $in: [u1, u2] } }] }), AlertLog.deleteMany({ userId: { $in: [u1, u2] } })]);
    const envelope = (code: number, description: string) => ({ ok: false, error_code: code, description });
    const dead = (...u: string[]) => (p: Record<string, unknown>) => (u.includes(String(p.chat_id)) ? envelope(403, "Forbidden: bot was blocked by the user") : undefined);

    await AlertLog.syncIndexes();
    try {
        // the basic path
        let { h, svc } = mkSvc("on");
        const s = await search(u1);
        await mkListing(`al-${U}-a`, "Glock 17 alpha");
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "one alert");
        assert.ok(String(to(h, u1)[0].params.text).includes("Glock 17 alpha"), "the title is in the alert");
        assert.strictEqual(to(h, u1)[0].params.parse_mode, "HTML");
        assert.strictEqual(await logs(u1), 1);
        assert.ok((await scanned(s))! > created.getTime(), "cursor moved");
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "second tick: nothing new");
        await Listing.updateMany({ sellerId: sellers }, { $set: { refreshedAt: new Date() } });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "a relisted listing is not alerted twice");

        // not alerted: before creation, own listing, hold, sold; two searches, one send
        await reset();
        ({ h, svc } = mkSvc("on"));
        await search(u1);
        await search(u1, "מחפש glock");
        await mkListing(`al-${U}-old`, "Glock 17 old", { refreshedAt: new Date(created.getTime() - 3600_000) });
        await mkListing(u1, "Glock 17 mine");
        await mkListing(`al-${U}-h`, "Glock 17 held", { hold: true });
        await mkListing(`al-${U}-s`, "Glock 17 sold", { status: "sold" });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 0, "old, own, held and sold listings are not alerted");
        await mkListing(`al-${U}-b`, "Glock 17 beta", { refreshedAt: new Date() });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "two overlapping searches send once");

        // a meetup listing: place in the text, faq_1 button; a bot-less service sends no row
        for (const [username, rows] of [["testbot", 1], ["", 0]] as const) {
            await reset();
            const h2 = createHarness();
            const svc2 = new AlertService(h2.bot.api, { lang: "en", buyerMatches: "on" } as BotConfig, groupListings, () => username);
            await search(u1);
            await mkListing(`al-${U}-mu`, "Glock 17 meet", { meetup: true, location: "Haifa" });
            await svc2.tick(new Date());
            const sentAlert = to(h2, u1)[0];
            assert.ok(String(sentAlert.params.text).includes("Haifa · Beit Dagan"), String(sentAlert.params.text));
            const kb = (sentAlert.params.reply_markup as { inline_keyboard: { url: string }[][] } | undefined)?.inline_keyboard ?? [];
            assert.strictEqual(kb.length, rows);
            if (rows) assert.ok(kb[0][0].url.endsWith("?start=faq_1"));
        }

        // off and shadow
        for (const mode of ["off", "shadow"] as const) {
            await reset();
            ({ h, svc } = mkSvc(mode));
            await search(u1);
            await mkListing(`al-${U}-m`, "Glock 17 mode");
            await svc.tick(new Date());
            assert.strictEqual(to(h, u1).length, 0, `${mode}: no send`);
            assert.strictEqual(await logs(u1), 0, `${mode}: no alert_log row`);
        }

        // media
        await reset();
        ({ h, svc } = mkSvc("on", { sendVideo: { message_id: 1, chat: { id: 1, type: "private" }, date: 1 } }));
        await search(u1);
        await mkListing(`al-${U}-p`, "Glock 17 photo", { media: [{ fileId: "F1", type: "photo" }] });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1, "sendPhoto").length, 1);
        assert.ok(String(to(h, u1, "sendPhoto")[0].params.caption).includes("Glock 17 photo"), "the text is the caption");
        assert.strictEqual(to(h, u1).length, 0, "no extra text message");
        await mkListing(`al-${U}-v`, "Glock 17 video", { media: [{ fileId: "F2", type: "video" }], refreshedAt: new Date() });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1, "sendVideo").length, 1, "a video goes as sendVideo");

        await reset();
        ({ h, svc } = mkSvc("on", { sendPhoto: envelope(400, "Bad Request: wrong file identifier") }));
        await search(u1);
        await mkListing(`al-${U}-p`, "Glock 17 photo", { media: [{ fileId: "F1", type: "photo" }] });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "a 400 on the photo falls back to a text message");
        assert.ok(String(to(h, u1)[0].params.text).includes("Glock 17 photo"));
        assert.strictEqual(await AlertLog.countDocuments({ userId: u1, ok: true }), 1);

        // 403: that user's searches go, the other user is still alerted
        await reset();
        ({ h, svc } = mkSvc("on", { sendMessage: dead(u1) }));
        await search(u1);
        await search(u1, "מחפש glock");
        const s2 = await search(u2);
        await mkListing(`al-${U}-a`, "Glock 17 alpha");
        await svc.tick(new Date());
        assert.strictEqual(await SavedSearch.countDocuments({ userId: u1 }), 0, "blocked user's searches deleted");
        assert.strictEqual(await SavedSearch.countDocuments({ userId: u2 }), 1);
        assert.strictEqual(to(h, u2).length, 1, "the other user is alerted");
        assert.strictEqual(await logs(u1), 0, "the blocked user's claim is released");
        assert.ok((await scanned(s2))! > created.getTime());

        // 429: nothing logged, cursor unmoved, the next tick delivers
        await reset();
        let limited = true;
        ({ h, svc } = mkSvc("on", { sendMessage: () => (limited ? envelope(429, "Too Many Requests: retry after 5") : undefined) }));
        const s3 = await search(u1);
        await mkListing(`al-${U}-a`, "Glock 17 alpha");
        await svc.tick(new Date());
        assert.strictEqual(await logs(u1), 0, "429: no alert_log row");
        assert.strictEqual(await scanned(s3), created.getTime(), "429: cursor unmoved");
        limited = false;
        await svc.tick(new Date());
        assert.strictEqual(await logs(u1), 1, "next tick delivers");
        assert.ok(to(h, u1).length >= 2, "the library may retry a 429 itself");

        // other 4xx: marked failed, no retry
        await reset();
        ({ h, svc } = mkSvc("on", { sendMessage: envelope(400, "Bad Request: chat not found") }));
        await search(u1);
        await mkListing(`al-${U}-a`, "Glock 17 alpha");
        await svc.tick(new Date());
        await svc.tick(new Date());
        assert.strictEqual(await AlertLog.countDocuments({ userId: u1, ok: false }), 1, "failed row kept");
        assert.strictEqual(to(h, u1).length, 1, "no retry");

        // the cap
        await reset();
        ({ h, svc } = mkSvc("on"));
        const s4 = await search(u1);
        for (let i = 0; i < 30; i++) await mkListing(`al-${U}-c${i}`, `Glock 17 item ${i}`);
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 25, "25 in the first tick");
        assert.strictEqual(await scanned(s4), created.getTime(), "cap: cursor unmoved");
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 30, "the other 5 in the second");
        assert.strictEqual(new Set(to(h, u1).map(c => c.params.text)).size, 30, "none repeated");

        // a card that cannot be built is skipped and does not block the others
        await reset();
        // /stalecheck lifts a hold with refreshedAt = staleSentAt: no alert until the seller confirms
        ({ h, svc } = mkSvc("on"));
        await search(u1);
        const askedAt = new Date(Date.now() - 600_000);
        const asked = await mkListing(`al-${U}-stale`, "Glock 17 stale", { origin: "legacy", staleSentAt: askedAt, nudgedAt: askedAt, refreshedAt: askedAt });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 0, "an unconfirmed stale listing does not alert");
        assert.strictEqual(await logs(u1), 0, "and is not claimed, so a confirm can still alert");
        await listingRepository.refresh(String(asked._id), new Date());
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "the seller's confirm alerts once");
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "and only once");

        await reset();
        ({ h, svc } = mkSvc("on"));
        await search(u1);
        await search(u2);
        await mkListing(`al-${U}-x`, "Glock 17 poison", { messageIds: [666] });
        await mkListing(`al-${U}-y`, "Glock 17 fine");
        await svc.tick(new Date());
        for (const u of [u1, u2]) {
            assert.strictEqual(to(h, u).length, 1, "the good listing is alerted");
            assert.ok(String(to(h, u)[0].params.text).includes("Glock 17 fine"));
            assert.strictEqual(await AlertLog.countDocuments({ userId: u, ok: false }), 1, "the poison pair is marked failed");
        }

        // the cap is shared with renew offers
        await reset();
        ({ h, svc } = mkSvc("on"));
        await search(u1);
        for (let i = 0; i < 25; i++) await mkListing(`al-${U}-c${i}`, `Glock 17 item ${i}`);
        await SavedSearch.create({ userId: u2, query: "cz 75", terms: ["cz", "75"], createdAt: created, scannedAt: new Date(), expiresAt: new Date(Date.now() + 2 * 86400_000) });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 25);
        assert.strictEqual(to(h, u2).length, 0, "no offer when the cap is used up");
        await svc.tick(new Date());
        assert.strictEqual(to(h, u2).length, 1, "the offer goes out next tick");

        // expired
        await reset();
        ({ h, svc } = mkSvc("on"));
        await SavedSearch.create({ userId: u1, query: "glock 17", terms: ["glock", "17"], createdAt: created, scannedAt: created, expiresAt: new Date(Date.now() - 1000) });
        await mkListing(`al-${U}-a`, "Glock 17 alpha");
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 0, "an expired search is not alerted");

        // renew offer
        await reset();
        ({ h, svc } = mkSvc("on"));
        const due = await SavedSearch.create({ userId: u1, query: "glock 17", terms: ["glock", "17"], createdAt: created, scannedAt: new Date(), expiresAt: new Date(Date.now() + 2 * 86400_000) });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "one offer");
        const kb = (to(h, u1)[0].params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
        assert.strictEqual(kb[0][0].callback_data, `al_${due._id}_r`);
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 1, "offered once");
        await savedSearchRepository.renew(String(due._id), u1, new Date());
        await mkListing(`al-${U}-a`, "Glock 17 alpha", { refreshedAt: new Date() });
        await svc.tick(new Date());
        assert.strictEqual(to(h, u1).length, 2, "a renewed search still alerts");

        await reset();
        ({ h, svc } = mkSvc("on", { sendMessage: dead(u1) }));
        await SavedSearch.create({ userId: u1, query: "glock 17", terms: ["glock", "17"], createdAt: created, scannedAt: new Date(), expiresAt: new Date(Date.now() + 2 * 86400_000) });
        await svc.tick(new Date());
        assert.strictEqual(await SavedSearch.countDocuments({ userId: u1 }), 0, "403 on the offer deletes the searches");

        // sendNow: ignores the mode, leaves no trace
        await reset();
        ({ h, svc } = mkSvc("off"));
        const s5 = await search(u1);
        await mkListing(`al-${U}-a`, "Glock 17 alpha");
        assert.strictEqual(await svc.sendNow(u1, new Date()), 1);
        assert.strictEqual(to(h, u1).length, 1);
        assert.strictEqual(await logs(u1), 0, "sendNow writes no alert_log row");
        assert.strictEqual(await scanned(s5), created.getTime(), "sendNow leaves the cursor");
    } finally {
        await reset();
    }
    console.log("[OK] alerts.");
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
        await checkSavedSearchDm();
        await checkAlerts();
    } finally {
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkBuyerMatches failed:", err);
    process.exit(1);
});
