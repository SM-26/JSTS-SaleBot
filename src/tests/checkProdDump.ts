import assert from "assert";
import mongoose from "mongoose";
import User from "../models/User";
import Post from "../models/Post";
import Draft from "../models/Draft";
import { AuthLevel } from "../types";
import { createHarness, idle, BOT_USERNAME, RecordedCall } from "./harness";

// Schema compatibility of a restored PRODUCTION dump with the new code (issue
// #84, phase 8a). Gated on DUMP_MONGO_URI, so it never runs in CI or in
// `pnpm test`; run it with `pnpm run check-dump`.
//
// The dump holds real user data. This file therefore prints COUNTS, field names
// and types only, never a value or an id, and silences the app's own logging
// (which does print ids) while the real BotController runs. It MUTATES the
// target database (lazy isAdmin -> authLevel conversions, bot_sessions, seeded
// docs it removes again), so point it at a throwaway restore, never at prod.
const DUMP_MONGO_URI = process.env.DUMP_MONGO_URI;

type Raw = Record<string, unknown>;
const say = (line = "") => process.stdout.write(line + "\n");
const settle = () => idle(); // fire-and-forget API calls land a tick after the chain returns
const redact = (s: string) => s.replace(/\d{6,}/g, "<n>").slice(0, 160);

const problems: string[] = [];
const check = (ok: boolean, label: string) => { if (!ok) problems.push(label); };
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const fmt = (m: Map<string, number>) => [...m].sort().map(([k, n]) => `${k}=${n}`).join(", ") || "none";

/** hydrate every doc through the model and validate it (validateSync is deprecated in mongoose 9); report counts and failing paths only. */
async function validateModel<T extends mongoose.Document>(model: mongoose.Model<T>) {
    const paths = new Set(Object.keys(model.schema.paths));
    const docs = await model.find().exec();
    const failing = new Map<string, number>();
    let invalid = 0;
    for (const doc of docs) {
        const err = await doc.validate().then(() => null, (e: mongoose.Error.ValidationError) => e);
        if (err) {
            invalid++;
            for (const p of Object.keys(err.errors)) bump(failing, p);
        }
    }
    const extra = new Map<string, number>();
    for (const raw of await model.find().lean<Raw[]>().exec()) {
        for (const k of Object.keys(raw)) if (!paths.has(k)) bump(extra, k);
    }
    say(`  ${model.collection.name}: ${docs.length} docs, ${docs.length - invalid} valid, ${invalid} invalid; failing paths: ${fmt(failing)}; non-schema fields: ${fmt(extra)}`);
    check(invalid === 0, `${model.collection.name}: ${invalid} invalid documents`);
    return docs.length;
}

async function run() {
    if (!DUMP_MONGO_URI) {
        console.log("[SKIP] checkProdDump: set DUMP_MONGO_URI to run this test.");
        return;
    }

    // Safety: only a local throwaway Mongo, never the production database name.
    const url = new URL(DUMP_MONGO_URI);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "DUMP_MONGO_URI must point at a local Mongo");
    assert.notStrictEqual(url.pathname.replace(/^\//, ""), "SalesBotDB", "refusing to run against a database named SalesBotDB");

    // The app logs ids and names; keep the output to counts. Tags are tallied.
    const logged = { error: new Map<string, number>(), warn: new Map<string, number>(), other: 0 };
    const real = { ...console };
    const tag = (a: unknown[]) => (typeof a[0] === "string" ? /^\[[^\]]+\]/.exec(a[0])?.[0] ?? "untagged" : "untagged");
    const mute = () => {
        console.error = (...a: unknown[]) => { bump(logged.error, tag(a)); };
        console.warn = (...a: unknown[]) => { bump(logged.warn, tag(a)); };
        console.log = console.info = console.debug = () => { logged.other++; };
    };
    const unmute = () => Object.assign(console, real);

    say("[INFO] Checking the production dump against the new code...");
    await mongoose.connect(DUMP_MONGO_URI);
    const db = mongoose.connection.db!;
    const users = db.collection<Raw>("users");
    const posts = db.collection<Raw>("posts");

    // 1. schema validation through the new models ------------------------------
    say("[1] Model validation (find + validate):");
    // the validator must actually flag a bad doc, or "0 invalid" proves nothing
    check(await Post.hydrate({ userId: "1", title: "t", price: "1", status: "bogus" }).validate().then(() => false, () => true), "validate does not flag a bad status");
    await validateModel(User);
    await validateModel(Post);
    await validateModel(Draft);

    // 2. read paths on the real controller -------------------------------------
    say("[2] Read paths (real BotController, offline harness):");
    const { BotController } = await import("../controllers/botController");
    const { errorBoundary } = await import("../controllers/middleware");
    const { localeService } = await import("../services/localeService");
    const { default: userRepository } = await import("../repositories/userRepository");

    const MOD_GROUP = -1001000000001;
    const APPROVED_GROUP = -1001000000002;
    const h = createHarness();
    const ctrl = new BotController(h.bot.api);
    const cfg = ctrl.config;
    Object.assign(cfg, { moderationGroupId: MOD_GROUP, approvedGroupId: APPROVED_GROUP, moderationTopicId: null, approvedTopicId: null });
    ctrl.registerRoutes(h.bot, BOT_USERNAME);
    h.bot.catch(errorBoundary);
    const T = (key: string) => localeService.t(cfg.lang, key);

    const snapPosts = new Map((await posts.find().toArray()).map((p) => [String(p._id), JSON.stringify(p)]));
    const snapUsers = new Map((await users.find().toArray()).map((u) => [String(u.userId), u]));
    const dumpUsers = [...snapUsers.values()];
    const dumpStatuses = ((await posts.distinct("status")) as string[]).filter((s) => s !== "pending");
    const legacy = dumpUsers.filter((u) => typeof u.isAdmin === "boolean" && u.authLevel === undefined);

    const base = 7_300_000_000 + (Date.now() % 100_000_000) * 10;
    const adminId = base;
    const authorId = base + 1;
    const seededIds = [String(adminId), String(authorId)];
    assert.strictEqual(await users.countDocuments({ userId: { $in: seededIds } }), 0, "seed ids collide with the dump");
    const seededPostIds: string[] = [];
    const postsOf = (status: string) => posts.find({ status }).toArray();

    mute();
    try {
        // (a) legacy isAdmin users with no authLevel: USER until their next interaction
        let legacyAsUser = 0;
        for (const u of legacy) {
            const doc = await userRepository.findByUserId(String(u.userId));
            if (doc?.authLevel === AuthLevel.USER && !(await userRepository.hasAuthLevel(String(u.userId), AuthLevel.MOD))) legacyAsUser++;
        }

        // (b) /myposts and /help as every user, in a private chat
        const noReply = new Map<string, number>();
        for (const u of dumpUsers) {
            const id = Number(u.userId);
            const from = {
                id, is_bot: false,
                first_name: typeof u.firstName === "string" ? u.firstName : "",
                ...(typeof u.lastName === "string" ? { last_name: u.lastName } : {}),
                ...(typeof u.userName === "string" ? { username: u.userName } : {}),
                ...(typeof u.languageCode === "string" ? { language_code: u.languageCode } : {}),
            };
            for (const [cmd, method] of [["/myposts", "sendMessage"], ["/help", "sendRichMessage"]]) {
                h.calls.length = 0;
                await h.send({ message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id, type: "private" }, from, text: cmd } });
                await settle();
                if (!h.calls.some((c) => c.method === method && Number(c.params.chat_id) === id)) bump(noReply, cmd);
            }
        }

        // (c) moderation buttons per post status, from a seeded admin
        await User.create({ userId: String(adminId), firstName: "Admin", authLevel: AuthLevel.ADMIN });
        await User.create({ userId: String(authorId), firstName: "Author", authLevel: AuthLevel.USER });
        const seedPost = async (status: "pending" | "sold", extra: Raw = {}) => {
            const p = await Post.create({ userId: String(authorId), title: "t", description: "d", price: "1", location: "l", media: [], status, ...extra });
            seededPostIds.push(String(p._id));
            return String(p._id);
        };
        const pendApprove = await seedPost("pending");
        const pendReject = await seedPost("pending");
        await seedPost("sold", { approvedMessageId: 5555 });

        const press = async (data: string) => {
            h.calls.length = 0;
            await h.pressButton(data, { userId: adminId, chatId: MOD_GROUP, chatType: "supergroup", messageId: 300 });
            await settle();
            return [...h.calls];
        };
        const answer = (calls: RecordedCall[]) => String(calls.find((c) => c.method === "answerCallbackQuery")?.params.text);
        const pushedToGroup = (calls: RecordedCall[]) => calls.some((c) => Number(c.params.chat_id) === APPROVED_GROUP);

        h.calls.length = 0;
        await h.sendText("/pending", { userId: adminId });
        await settle();
        const pendingShown = h.calls.length; // title + the two seeded posts at least

        const statuses = dumpStatuses; // the dump's own statuses, taken before seeding
        const handledOk = new Map<string, number>();
        for (const status of statuses) {
            const sample = (await postsOf(status))[0];
            for (const verb of ["approve", "reject"]) {
                const calls = await press(`${verb}_${String(sample._id)}`);
                if (answer(calls) === T("adminPostHandled") && !pushedToGroup(calls)) bump(handledOk, `${status}/${verb}`);
            }
        }

        let calls = await press(`approve_${pendApprove}`);
        const approvedOk = answer(calls) === T("adminApproved") && pushedToGroup(calls) && calls.some((c) => c.method === "sendMessage" && Number(c.params.chat_id) === authorId);
        const approvedDoc = await posts.findOne({ _id: new mongoose.Types.ObjectId(pendApprove) });
        check(approvedDoc?.status === "approved" && typeof approvedDoc.approvedMessageId === "number", "approved post not stored as approved + approvedMessageId");
        calls = await press(`approve_${pendApprove}`);
        const secondClaim = answer(calls) === T("adminPostHandled");

        calls = await press(`reject_${pendReject}`);
        const rejectOk = answer(calls) === T("adminRejected") && calls.some((c) => c.method === "sendMessage" && Number(c.params.chat_id) === MOD_GROUP);
        const rejectedDoc = await posts.findOne({ _id: new mongoose.Types.ObjectId(pendReject) });
        check(rejectedDoc?.status === "rejected", "rejected post not stored as rejected");

        h.calls.length = 0;
        await h.sendText("/pending", { userId: adminId });
        await settle();
        const pendingEmpty = h.calls.some((c) => String(c.params.text) === T("adminPendingEmpty"));

        // (d) startup path: sold sweep (the dump's own sold posts have no approvedMessageId) and the draft sweep
        h.calls.length = 0;
        await ctrl.syncSoldPosts();
        const syncEdits = h.calls.filter((c) => c.method === "editMessageText" && c.params.message_id === "5555").length;
        const soldBefore = await posts.countDocuments({ status: "sold", approvedMessageId: { $ne: null } });
        await ctrl.deleteExpiredDrafts();

        // (e) legacy users converted by their interaction above, as v1 did
        const after = new Map((await users.find().toArray()).map((u) => [String(u.userId), u]));
        let converted = 0;
        for (const u of legacy) {
            const now = after.get(String(u.userId))!;
            if (now.authLevel === (u.isAdmin ? AuthLevel.ADMIN : AuthLevel.USER) && now.isAdmin === undefined) converted++;
        }
        // every other user field must survive untouched (updatedAt moves on any upsert)
        const drift = new Map<string, number>();
        for (const [id, before] of snapUsers) {
            const now = after.get(id)!;
            const isLegacy = legacy.includes(before);
            for (const k of new Set([...Object.keys(before), ...Object.keys(now)])) {
                if (k === "updatedAt" || (isLegacy && (k === "isAdmin" || k === "authLevel"))) continue;
                if (JSON.stringify(before[k]) !== JSON.stringify(now[k])) bump(drift, k);
            }
        }
        const nowPosts = new Map((await posts.find().toArray()).map((p) => [String(p._id), JSON.stringify(p)]));
        const postsChanged = [...snapPosts].filter(([id, snap]) => nowPosts.get(id) !== snap).length;

        unmute();
        say(`  users: ${dumpUsers.length}; /myposts + /help answered for all: ${noReply.size === 0 ? "yes" : "NO (" + fmt(noReply) + ")"}`);
        say(`  legacy isAdmin users without authLevel: ${legacy.length} (isAdmin true: ${legacy.filter((u) => u.isAdmin === true).length}); read as USER before interaction: ${legacyAsUser}; converted after: ${converted}`);
        say(`  other user-field drift after the run: ${fmt(drift)}; existing posts changed: ${postsChanged}`);
        say(`  distinct statuses: ${statuses.join(",")}; approve+reject answer "already handled" for non-pending: ${handledOk.size}/${statuses.length * 2}`);
        say(`  pending: /pending shown ${pendingShown} calls; approve ok: ${approvedOk}; second claim blocked: ${secondClaim}; reject ok: ${rejectOk}; queue empty after: ${pendingEmpty}`);
        say(`  startup: syncSoldPosts edits for seeded sold post: ${syncEdits}; dump sold posts with approvedMessageId: ${soldBefore - 1}`);
        say(`  app logging suppressed: errors ${[...logged.error.values()].reduce((a, b) => a + b, 0)} (${fmt(logged.error)}); warns ${[...logged.warn.values()].reduce((a, b) => a + b, 0)} (${fmt(logged.warn)})`);

        check(noReply.size === 0, "some users got no /myposts or /help reply");
        check(logged.error.size === 0, "console.error was called");
        check(legacyAsUser === legacy.length, "a legacy isAdmin user is not read as USER");
        check(converted === legacy.length, "a legacy isAdmin user was not converted");
        check(drift.size === 0, "user fields changed beyond isAdmin/authLevel/updatedAt");
        check(postsChanged === 0, "existing posts were modified");
        check(handledOk.size === statuses.length * 2, "non-pending moderation did not answer adminPostHandled");
        check(pendingShown >= 3 && approvedOk && secondClaim && rejectOk && pendingEmpty, "pending/approve/reject outcomes");
        check(syncEdits === 1, "syncSoldPosts did not edit the seeded sold post");
    } finally {
        unmute();
        await users.deleteMany({ userId: { $in: seededIds } });
        await posts.deleteMany({ _id: { $in: seededPostIds.map((i) => new mongoose.Types.ObjectId(i)) } });
        await db.collection("bot_sessions").deleteMany({ _id: { $regex: `:(${seededIds.join("|")})$` } as never });
        await mongoose.disconnect();
    }

    if (problems.length) {
        say(`[FAIL] ${problems.length} problem(s):`);
        for (const p of problems) say(`  - ${p}`);
        process.exit(1);
    }
    say("[OK] the production dump is compatible with the new code.");
}

run().catch((err) => {
    const e = err as Error;
    process.stderr.write(`[ERROR] checkProdDump failed: ${e.name}: ${redact(String(e.message))}\n`);
    process.exit(1);
});
