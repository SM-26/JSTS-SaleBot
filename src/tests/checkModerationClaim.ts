import assert from "assert";
import mongoose from "mongoose";
import Post from "../models/Post";
import postRepository from "../repositories/postRepository";

// Guards the fix for the double-moderation bug: two admins clicking
// approve/reject on the same post must not both proceed. Needs a real Mongo,
// because the guarantee under test is the atomicity of findOneAndUpdate --
// a mock would only test the mock.
const MONGO_URI = process.env.MONGO_URI;

async function run() {
    if (!MONGO_URI) {
        console.log("[SKIP] checkModerationClaim: set MONGO_URI to run this test.");
        return;
    }

    console.log("[INFO] Checking moderation claim...");
    await mongoose.connect(MONGO_URI);

    const post = await postRepository.createPost({
        userId: "claim-test-user",
        title: "claim test",
        price: "1",
    });
    const postId = String(post._id);
    const extraIds: string[] = [];

    try {
        assert.strictEqual(post.status, "pending", "new post should start pending");

        // Two moderators, same post, same instant.
        const [a, b] = await Promise.all([
            postRepository.claimPending(postId, "approved"),
            postRepository.claimPending(postId, "rejected"),
        ]);

        const winners = [a, b].filter(Boolean);
        assert.strictEqual(winners.length, 1, `exactly one claim should win, got ${winners.length}`);

        // A third click on a settled post loses too.
        const late = await postRepository.claimPending(postId, "approved");
        assert.strictEqual(late, null, "claiming an already-moderated post must return null");

        const stored = await postRepository.findById(postId);
        assert.strictEqual(stored!.status, winners[0]!.status, "stored status should match the winning claim");

        console.log(`[OK] one moderator won (${winners[0]!.status}), the other was rejected.`);

        // The schema carried rejectionReason for a long time with nothing writing it.
        await postRepository.setRejectionReason(postId, "no price listed");
        const withReason = await postRepository.findById(postId);
        assert.strictEqual(withReason!.rejectionReason, "no price listed", "rejection reason must be persisted");

        console.log("[OK] rejection reason is stored on the post.");

        // The reject notice is claimed once: presets and Skip race, one wins.
        const mk = async (userId = "claim-test-user") => {
            const p = await postRepository.createPost({ userId, title: "notice test", price: "1" });
            extraIds.push(String(p._id));
            return String(p._id);
        };
        const pendingId = await mk();
        assert.strictEqual(await postRepository.claimRejectionNotice(pendingId, "x"), null, "claim notice needs rejected");

        const presetId = await mk();
        await postRepository.claimPending(presetId, "rejected");
        const claims = await Promise.all([1, 2, 3, 4].map(n => postRepository.claimRejectionNotice(presetId, `reason ${n}`)));
        const won = claims.filter(Boolean);
        assert.strictEqual(won.length, 1, `exactly one notice claim should win, got ${won.length}`);
        const afterPreset = await postRepository.findById(presetId);
        assert.strictEqual(afterPreset!.rejectionReason, won[0]!.rejectionReason, "stored reason is the winner's");
        assert.ok(afterPreset!.rejectionNotifiedAt instanceof Date, "rejectionNotifiedAt is set");
        assert.strictEqual(await postRepository.claimRejectionNotice(presetId, null), null, "skip after preset loses");
        assert.strictEqual((await postRepository.findById(presetId))!.rejectionReason, won[0]!.rejectionReason, "skip leaves the reason unchanged");

        const skipId = await mk();
        await postRepository.claimPending(skipId, "rejected");
        const skipped = await postRepository.claimRejectionNotice(skipId, null);
        assert.ok(skipped, "skip alone claims");
        assert.strictEqual(skipped!.rejectionReason ?? null, null, "skip stores no reason");
        assert.strictEqual(await postRepository.claimRejectionNotice(skipId, null), null, "second skip loses");
        console.log("[OK] reject notice is claimed exactly once.");

        // hasApprovedOrSold: trust needs a published post, not a pending/rejected one.
        const u = `claim-trust-${Date.now()}`;
        const t1 = await mk(u);
        const t2 = await mk(u);
        await postRepository.claimPending(t2, "rejected");
        assert.strictEqual(await postRepository.hasApprovedOrSold(u), false, "pending and rejected only");
        await postRepository.claimPending(t1, "approved");
        assert.strictEqual(await postRepository.hasApprovedOrSold(u), true, "approved counts");
        const u2 = `claim-trust2-${Date.now()}`;
        const s1 = await mk(u2);
        await postRepository.updateStatus(s1, "sold");
        assert.strictEqual(await postRepository.hasApprovedOrSold(u2), true, "sold alone counts");
        console.log("[OK] hasApprovedOrSold.");
    } finally {
        await Post.deleteMany({ _id: { $in: [postId, ...extraIds] } });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkModerationClaim failed:", err);
    process.exit(1);
});
