import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import type { Message } from "node-telegram-bot-api/types";
import { AuthLevel, BotConfig } from "../types";
import { fakeApi, seedPost } from "./lifecycleFakes";
import { TEST_BOT_ID_PREFIX } from "./testBot";

// Seller tiers (#126): tier selection, /verify, test-only "Set my tier" / "Post as", and the layout
// a post gets at publish, bump and sold time. Needs a throwaway Mongo (database name must contain "test").
const MONGO_URI = process.env.MONGO_URI;

async function run() {
    if (!MONGO_URI) {
        console.log("[SKIP] checkTiers: set MONGO_URI to run this test.");
        return;
    }
    console.log("[INFO] Checking seller tiers...");
    await mongoose.connect(MONGO_URI);
    assert.ok(/test/i.test(mongoose.connection.name), `refusing to run on database "${mongoose.connection.name}"`);

    const config: BotConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "../../config.json"), "utf-8"));
    const { default: userRepository } = await import("../repositories/userRepository");
    const { default: postRepository } = await import("../repositories/postRepository");
    const { default: listingRepository } = await import("../repositories/listingRepository");
    const { default: Listing } = await import("../models/Listing");
    const { default: Post } = await import("../models/Post");
    const { default: User } = await import("../models/User");
    const { sellerTier, sellerLayout } = await import("../services/trustService");
    const { PostService } = await import("../services/postService");
    const { PublishService } = await import("../services/publishService");
    const { AdminService } = await import("../services/adminService");
    const { UserService } = await import("../services/userService");
    const { TEST_CASES } = await import("./testCases");

    const base = 8_000_000_000 + (Date.now() % 1_000_000_000);
    const ids = Array.from({ length: 12 }, (_, i) => String(base + i));
    const [, admin, plain, boundary, badRate, fresh, setter, adminB] = ids;
    const now = new Date();
    const cleanup = async () => {
        await Listing.deleteMany({ sellerId: { $in: ids } });
        await Post.deleteMany({ userId: { $in: ids } });
        await User.deleteMany({ userId: { $in: ids } });
    };
    const mkUser = (userId: string, authLevel = AuthLevel.USER, extra: Record<string, unknown> = {}) =>
        User.create({ userId, firstName: `U${userId.slice(-2)}`, userName: `u${userId}`, authLevel, ...extra });
    // n listings that ended with `status`
    const ended = async (userId: string, status: "sold" | "expired" | "removed", n: number) => {
        for (let i = 0; i < n; i++) {
            const post = await seedPost(userId);
            const l = await listingRepository.createForPost(post, "dm", false, now);
            await Listing.updateOne({ _id: l._id }, { $set: { status, endedAt: now } });
        }
    };
    const oldToken = process.env.BOT_TOKEN;

    try {
        await cleanup();
        for (const id of ids.slice(0, 8)) await mkUser(id, id === admin || id === adminB ? AuthLevel.ADMIN : AuthLevel.USER);

        // --- tier selection: 60% and 3 ended; verified outranks top; "both" is the two together
        assert.strictEqual(await sellerTier(plain), "regular");
        await ended(boundary, "sold", 2); await ended(boundary, "expired", 1); // 2 of 3 = 67%
        assert.strictEqual(await sellerTier(boundary), "top", "2 sold of 3 ended is a top seller");
        await ended(badRate, "sold", 1); await ended(badRate, "removed", 2); // 1 of 3
        assert.strictEqual(await sellerTier(badRate), "regular", "33% is not enough");
        await ended(fresh, "sold", 2);
        assert.strictEqual(await sellerTier(fresh), "regular", "fewer than 3 ended is not enough");
        await ended(fresh, "sold", 1);
        assert.strictEqual(await sellerTier(fresh), "top");
        await userRepository.setVerified(plain, admin);
        assert.strictEqual(await sellerTier(plain), "verified", "verified with no sales");
        await userRepository.setVerified(boundary, admin);
        assert.strictEqual(await sellerTier(boundary), "both");
        await userRepository.setVerified(boundary, null);
        assert.strictEqual(await sellerTier(boundary), "top", "unverify drops back to top");
        await userRepository.setVerified(plain, null);
        assert.strictEqual(await sellerTier(plain), "regular");
        assert.ok(!Object.hasOwn((await User.findOne({ userId: plain }).lean()) ?? {}, "verifiedAt"), "unverify removes the field");

        // --- stats come from real data
        const layout = await sellerLayout(boundary, "he", "check");
        assert.strictEqual(layout.tier, "top");
        assert.strictEqual(layout.stats?.sold, 2);
        assert.ok(layout.stats?.since, "time in the market is read from real data");
        // regular keeps the trust line, not a tier layout
        assert.strictEqual((await sellerLayout(plain, "he", "check")).stats, undefined);

        // --- /verify and /unverify: moderators and admins
        const sendCmd = async (from: string, text: string) => {
            const f = fakeApi();
            const svc = new AdminService(f.api, config);
            const msg = { message_id: 1, date: 0, chat: { id: Number(from), type: "private" }, from: { id: Number(from), is_bot: false, first_name: "x" }, text } as unknown as Message;
            await svc.handleVerify(msg, text.split(" ")[1] ?? "", text.startsWith("/verify"));
            return String(f.calls.find(c => c.method === "sendMessage")?.params.text);
        };
        await sendCmd(plain, `/verify ${fresh}`);
        assert.ok(!(await userRepository.findByUserId(fresh))?.verifiedAt, "a plain user cannot verify");
        await sendCmd(admin, `/verify ${fresh}`);
        assert.ok((await userRepository.findByUserId(fresh))?.verifiedAt, "an admin can verify");
        assert.strictEqual((await userRepository.findByUserId(fresh))?.verifiedBy, admin);
        await sendCmd(plain, `/unverify ${fresh}`);
        assert.ok((await userRepository.findByUserId(fresh))?.verifiedAt, "a plain user cannot unverify");
        await sendCmd(admin, `/unverify ${fresh}`);
        assert.ok(!(await userRepository.findByUserId(fresh))?.verifiedAt, "an admin can unverify");
        await User.updateOne({ userId: plain }, { $set: { authLevel: AuthLevel.MOD } }).exec();
        await sendCmd(plain, `/verify ${fresh}`);
        assert.ok((await userRepository.findByUserId(fresh))?.verifiedAt, "a moderator can verify");
        await sendCmd(plain, `/unverify ${fresh}`);
        assert.ok(!(await userRepository.findByUserId(fresh))?.verifiedAt, "a moderator can unverify");
        await User.updateOne({ userId: plain }, { $set: { authLevel: AuthLevel.USER } }).exec();
        assert.ok(/not found|לא נמצא|не найден/i.test(await sendCmd(admin, "/verify 1")), "unknown user");

        // --- publish uses the seller's current tier; an old post rebuilds in it on bump/sold
        const f = fakeApi();
        const postService = new PostService(f.api, config, () => "bot");
        const publish = new PublishService(f.api, config, postService);
        const author = (await userRepository.findByUserId(boundary))!;
        const old = await seedPost(boundary, "approved"); // made before any tier: no layoutTier
        const rich = () => JSON.stringify(f.calls.filter(c => c.method === "sendRichMessage").pop()?.params.rich_message);
        const listing = await publish.publishApproved((await postRepository.findById(String(old._id)))!, author);
        assert.ok(rich().includes("מוכר מוביל") || rich().includes("Top seller"), "published in the top layout");
        assert.ok(listing && listing.status === "live" && listing.source === "bot", "bot listing is created as before");
        assert.ok(rich().includes("\"details\""), "foldable description");
        await userRepository.setVerified(boundary, admin);
        const soldCard = JSON.stringify(await postService.setPostSold((await postRepository.findById(String(old._id)))!));
        assert.ok(soldCard.includes("strikethrough") && soldCard.includes("🔴") && soldCard.includes("🏅✅"), "sold edit rebuilds in the current layout (both)");
        await userRepository.setVerified(boundary, null);
        // a regular seller's sold post is today's layout (no tier markers)
        const regPost = await seedPost(plain, "approved");
        const regSold = JSON.stringify(await postService.setPostSold((await postRepository.findById(String(regPost._id)))!));
        assert.ok(regSold.includes("blockquote") || regSold.includes("divider"), "regular sold post keeps today's layout");
        assert.ok(!regSold.includes("details"));

        // --- /test cases refuse off the test bot and leave nothing behind
        delete process.env.BOT_TOKEN;
        const run = (key: string, from: string, api = fakeApi()) => {
            const msg = { message_id: 1, date: 0, chat: { id: Number(from), type: "private" }, from: { id: Number(from), is_bot: false, first_name: "Tester", username: `u${from}` }, text: "/test" } as unknown as Message;
            return TEST_CASES[key].run(api.api, config, {} as never, new PostService(api.api, config, () => "bot"), new UserService(), {} as never, {} as never, msg).then(() => api);
        };
        for (const key of ["post_as_regular", "post_as_top", "post_as_verified", "post_as_both", "set_tier_top", "set_tier_both", "set_tier_verified", "set_tier_regular"]) {
            const api = await run(key, setter);
            assert.ok(String(api.calls[0].params.text).startsWith("⛔"), `${key} refuses off the test bot`);
            assert.ok(!api.calls.some(c => c.method === "sendRichMessage"));
        }
        assert.strictEqual(await Post.countDocuments({ userId: setter }), 0, "refused cases create nothing");
        assert.strictEqual(await Listing.countDocuments({ sellerId: setter }), 0);

        // --- on the test bot: Set my tier
        process.env.BOT_TOKEN = `${TEST_BOT_ID_PREFIX}fake`;
        for (const tier of ["top", "both", "verified", "regular", "top"] as const) {
            await run(`set_tier_${tier}`, setter);
            assert.strictEqual(await sellerTier(setter), tier, `set my tier: ${tier}`);
        }
        await run("set_tier_regular", setter);
        assert.strictEqual(await Listing.countDocuments({ sellerId: setter }), 0, "regular removes the seeded sales");

        // --- on the test bot: Post as <tier> goes through moderation, with that tier's layout, for this post only
        const marks: Record<string, string> = { regular: "blockquote", top: "🏅 Seller:", verified: "✅ Verified by the group admins", both: "⭐" };
        for (const tier of ["regular", "top", "verified", "both"] as const) {
            const api = fakeApi();
            const [a, b] = await Promise.all([run(`post_as_${tier}`, admin, api), run(`post_as_${tier}`, adminB, fakeApi())]); // two admins at once
            const card = api.calls.find(c => c.method === "sendRichMessage")!;
            assert.strictEqual(card.params.chat_id, config.moderationGroupId, `${tier}: the card goes to the moderation group`);
            assert.ok(JSON.stringify(card.params.rich_message).includes(marks[tier]), `${tier}: the card shows the layout`);
            assert.strictEqual(JSON.stringify(card.params.rich_message).includes("מתנה לילדה"), tier === "both", `${tier}: only "both" shows the highlight`);
            const keys = (card.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat().map(k => k.callback_data);
            assert.ok(keys.some(k => k.startsWith("approve_")) && keys.some(k => k.startsWith("reject_")), `${tier}: approve and reject buttons`);
            assert.ok(!api.calls.some(c => c.method === "sendRichMessage" && c.params.chat_id === config.approvedGroupId), `${tier}: nothing is public before approval`);
            void a; void b;
            const posts = await Post.find({ userId: admin, layoutTier: tier });
            assert.strictEqual(posts.length, 1, `${tier}: stored on this post only`);
            assert.strictEqual(posts[0].status, "pending");
            assert.strictEqual(await sellerTier(admin), "regular", "the presser's real tier is untouched");
            // Approve publishes in that layout
            const pub = fakeApi();
            const authorDoc = (await userRepository.findByUserId(admin))!;
            await new PublishService(pub.api, config, new PostService(pub.api, config, () => "bot")).publishApproved(posts[0].toObject() as never, authorDoc);
            const pubCard = pub.calls.find(c => c.method === "sendRichMessage")!;
            assert.strictEqual(pubCard.params.chat_id, config.approvedGroupId);
            assert.ok(JSON.stringify(pubCard.params.rich_message).includes(marks[tier]), `${tier}: approve publishes in the layout`);
            await Post.deleteMany({ userId: admin });
            await Listing.deleteMany({ sellerId: admin });
        }
        assert.strictEqual(await Post.countDocuments({ userId: adminB }) > 0, true, "the second admin's posts were separate");

        // --- a real trusted seller still publishes at once with a review card (rule unchanged)
        const t = fakeApi();
        const pub2 = new PublishService(t.api, config, new PostService(t.api, config, () => "bot"));
        const tp = await Post.create({ userId: boundary, title: "t", description: "d", price: "10", location: "l", media: [], status: "pending", createdAt: now });
        const outcome = await pub2.submitPost(tp.toObject() as never, { title: "t", description: "d", price: "10", location: "l", media: [], userId: Number(boundary), firstName: "x" }, true);
        assert.strictEqual(outcome, "published");
        const groups = t.calls.filter(c => c.method === "sendRichMessage").map(c => c.params.chat_id);
        assert.deepStrictEqual(groups, [config.approvedGroupId, config.moderationGroupId], "published, then the review card");
    } finally {
        if (oldToken === undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN = oldToken;
        await cleanup().catch(() => undefined);
        await mongoose.disconnect();
    }
    console.log("[SUCCESS] Seller tier checks passed.");
}

run().catch((err) => {
    console.error("[FAIL]", err);
    process.exit(1);
});
