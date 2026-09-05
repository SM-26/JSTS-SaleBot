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
    } finally {
        await Post.deleteOne({ _id: postId });
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkModerationClaim failed:", err);
    process.exit(1);
});
