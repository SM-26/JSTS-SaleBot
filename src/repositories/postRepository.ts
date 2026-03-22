import Post, { IPost } from "../models/Post";

class PostRepository {
    createPost(postData: Partial<IPost>) {
        const post = new Post(postData);
        return post.save();
    }

    findByUserId(userId: string) {
        return Post.find({ userId });
    }

    findById(postId: string) {
        return Post.findById(postId);
    }

    updateStatus(postId: string, status: IPost["status"]) {
        return Post.findByIdAndUpdate(postId, { status }, { new: true });
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

    deleteById(postId: string) {
        return Post.findByIdAndDelete(postId);
    }
}

export default new PostRepository();
