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

    updateStatus(postId: string, status: IPost["status"]) {
        return Post.findByIdAndUpdate(postId, { status }, { returnDocument: 'after' });
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

    deleteById(postId: string) {
        return Post.findByIdAndDelete(postId);
    }
}

export default new PostRepository();
