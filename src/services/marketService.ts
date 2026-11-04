import listingRepository from "../repositories/listingRepository";
import postRepository from "../repositories/postRepository";

// Posts made before this are legacy: their listing is held out of matching
// until the owner decides what to do with old ads. Every prod post predates it
// (the newest is 2026-09-09); a post made after it is new, so it gets a normal
// listing.
export const LEGACY_CUTOFF = new Date("2026-11-04T00:00:00Z");

// Idempotent: creates the missing `bot` listing for every approved or sold post
// and marks listings sold once their post is. Safe to run on every startup.
export async function reconcileBotListings(now: Date): Promise<{ created: number; sold: number }> {
    let created = 0;
    let sold = 0;
    for (const post of await postRepository.findApprovedOrSold()) {
        const legacy = post.createdAt < LEGACY_CUTOFF;
        let listing = await listingRepository.findByPostId(String(post._id));
        if (!listing) {
            listing = await listingRepository.createForPost(post, legacy ? "legacy" : "dm", post.status === "approved" && legacy, now);
            created++;
        }
        if (post.status === "sold" && await listingRepository.markSold(String(listing._id), now)) sold++;
    }
    return { created, sold };
}
