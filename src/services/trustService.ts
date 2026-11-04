import listingRepository from "../repositories/listingRepository";
import postRepository from "../repositories/postRepository";

export const TRUST_REVOKE_MS = 90 * 24 * 60 * 60 * 1000;

// Trusted = has a published (approved or sold) bot post and no moderator
// take-down of any of their listings in the last 90 days. Captured group
// listings never grant trust (only `posts` are consulted) but a take-down of
// one does revoke it.
export async function isTrustedSeller(sellerId: string, now: Date): Promise<boolean> {
    if (!(await postRepository.hasApprovedOrSold(sellerId))) return false;
    return !(await listingRepository.hasModeratorTakedownSince(sellerId, new Date(now.getTime() - TRUST_REVOKE_MS)));
}
