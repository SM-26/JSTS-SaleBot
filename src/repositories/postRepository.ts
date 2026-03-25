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

    updateStatus(postId: string, status: IPost["status"]) {
        return Post.findByIdAndUpdate(postId, { status }, { new: true });
    }

    setApprovedMessageId(postId: string, approvedMessageId: number | null) {
        return Post.findByIdAndUpdate(postId, { approvedMessageId }, { new: true });
    }

    setModerationMessageId(postId: string, moderationMessageId: number | null) {
        return Post.findByIdAndUpdate(postId, { moderationMessageId }, { new: true });
    }

    updateBump(postId: string, dailyBumpCount: number) {
        return Post.findByIdAndUpdate(postId, { lastBumpAt: new Date(), dailyBumpCount }, { new: true });
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
