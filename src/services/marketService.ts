import listingRepository from "../repositories/listingRepository";
import postRepository from "../repositories/postRepository";

// Posts made before this are legacy: their listing is held out of matching
// until the owner decides what to do with old ads. Every prod post predates it
// (the newest is 2026-09-09); a post made after it is new, so it gets a normal
// listing.
export const LEGACY_CUTOFF = new Date("2026-11-04T00:00:00Z");

// Idempotent: creates the missing `bot` listing for every approved or sold post
// and marks listings sold once their post is. Safe to run on every startup.
// One bad post is logged and skipped; it never aborts the run.
export async function reconcileBotListings(now: Date): Promise<{ created: number; sold: number }> {
    let created = 0;
    let sold = 0;
    for (const post of await postRepository.findApprovedOrSold()) {
        try {
            // Fail closed: a missing date (mongoose fills it with "now" on read) or an invalid one is legacy.
            const legacy = post.$isDefault("createdAt") || !(post.createdAt instanceof Date && post.createdAt >= LEGACY_CUTOFF);
            let listing = await listingRepository.findByPostId(String(post._id));
            if (!listing) {
                listing = await listingRepository.createForPost(post, legacy ? "legacy" : "dm", post.status === "approved" && legacy, now);
                created++;
            }
            if (post.status === "sold" && await listingRepository.markSold(String(listing._id), now)) sold++;
        } catch (err) {
            console.error(`[ERROR - reconcileBotListings] post ${String(post._id)}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { created, sold };
}
