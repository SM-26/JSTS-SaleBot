import Post, { IPost } from "../models/Post";

class PostRepository {
    createPost(postData: Partial<IPost>) {
        const post = new Post(postData);
        return post.save();
    }

    findByUserId(userId: string) {
        return Post.find({ userId }).sort({ createdAt: -1 });
    }

    findById(postId: string) {
        return Post.findById(postId);
    }

    async findByApprovedMessageId(approvedMessageId: number) {
        return Post.findOne({ approvedMessageId }).exec();
    }

    // ponytail: atomic claim - the status filter makes this the concurrency
    // guard. Returns null if another moderator already took the post, so two
    // admins clicking approve/reject cannot both proceed.
    claimPending(postId: string, status: IPost["status"]) {
        return Post.findOneAndUpdate(
            { _id: postId, status: "pending" },
            { $set: { status } },
            { returnDocument: 'after' }
        );
    }

    updateStatus(postId: string, status: IPost["status"]) {
        return Post.findByIdAndUpdate(postId, { status }, { returnDocument: 'after' });
    }

    setRejectionReason(postId: string, rejectionReason: string) {
        return Post.findByIdAndUpdate(postId, { rejectionReason }, { returnDocument: 'after' });
    }

    // Atomic: the author is told once. Presets and Skip race; the first wins.
    // A null reason (Skip) leaves rejectionReason as it was.
    claimRejectionNotice(postId: string, reason: string | null): Promise<IPost | null> {
        return Post.findOneAndUpdate(
            { _id: postId, status: "rejected", rejectionNotifiedAt: null },
            { $set: { rejectionNotifiedAt: new Date(), ...(reason !== null ? { rejectionReason: reason } : {}) } },
            { returnDocument: "after" }
        ).exec();
    }

    // Which of these posts already had their author told (a preset, reply or Skip won).
    async findNotifiedIds(postIds: string[]): Promise<string[]> {
        if (postIds.length === 0) return [];
        const rows = await Post.find({ _id: { $in: postIds }, rejectionNotifiedAt: { $ne: null } }).select("_id").lean().exec();
        return rows.map((r) => String(r._id));
    }

    async hasApprovedOrSold(userId: string): Promise<boolean> {
        return (await Post.exists({ userId, status: { $in: ["approved", "sold"] } })) !== null;
    }

    setApprovedMessageId(postId: string, approvedMessageId: number | null) {
        return Post.findByIdAndUpdate(postId, { approvedMessageId }, { returnDocument: 'after' });
    }

    setModerationMessageId(postId: string, moderationMessageId: number | null) {
        return Post.findByIdAndUpdate(postId, { moderationMessageId }, { returnDocument: 'after' });
    }

    updateBump(postId: string, dailyBumpCount: number) {
        return Post.findByIdAndUpdate(postId, { lastBumpAt: new Date(), dailyBumpCount }, { returnDocument: 'after' });
    }

    getAll() {
        return Post.find();
    }

    getPending() {
        return Post.find({ status: "pending" });
    }

    getPendingPosts() {
        return Post.find({ status: "pending" }).sort({ createdAt: 1 });
    }

    expireAllPendingPosts() {
        return Post.updateMany(
            { status: "pending" },
            { $set: { status: "rejected", rejectionReason: "Expired via /clearpending" } }
        );
    }

    getSold() {
        return Post.find({ status: "sold", approvedMessageId: { $ne: null } });
    }

    findApprovedOrSold(): Promise<IPost[]> {
        return Post.find({ status: { $in: ["approved", "sold"] } }).exec();
    }

    findByIds(ids: string[]): Promise<IPost[]> {
        return Post.find({ _id: { $in: ids } }).exec();
    }

    async firstCreatedAt(userId: string): Promise<Date | null> {
        const p = await Post.findOne({ userId }).sort({ createdAt: 1 }).select("createdAt").exec();
        return p?.createdAt ?? null;
    }

    distinctUserIdsByStatus(status: IPost["status"]): Promise<string[]> {
        return Post.distinct("userId", { status });
    }

    deleteById(postId: string) {
        return Post.findByIdAndDelete(postId);
    }
}

export default new PostRepository();
