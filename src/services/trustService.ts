import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { localeService } from "./localeService";

export const TRUST_REVOKE_MS = 90 * 24 * 60 * 60 * 1000;
export const NEW_SELLER_DAYS = 30;

export function formatSince(date: Date, locale: string): string {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

// Earliest sign of the seller in the market: first seen in the group, first /start, first post.
export async function marketSince(sellerId: string): Promise<Date | null> {
    const [member, user, post] = await Promise.all([
        memberRepository.findByUserId(sellerId),
        userRepository.findByUserId(sellerId),
        postRepository.firstCreatedAt(sellerId),
    ]);
    const dates = [member?.firstSeenAt, user?.createdAt, post].filter((d): d is Date => d instanceof Date);
    return dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))) : null;
}

// null = show nothing (a new seller with no sales).
export async function trustLineFor(sellerId: string, locale: string, now: Date): Promise<string | null> {
    const n = await listingRepository.countSold(sellerId);
    const since = await marketSince(sellerId);
    if (n === 0 && (!since || now.getTime() - since.getTime() < NEW_SELLER_DAYS * 24 * 3600 * 1000)) return null;
    return localeService.t(locale, "trustLine", { n, since: since ? formatSince(since, locale) : "" });
}

// A trust line must never break a publish or a button: failure = no line, logged.
export async function safeTrustLine(sellerId: string, locale: string, ctx: string): Promise<string | undefined> {
    try {
        return (await trustLineFor(sellerId, locale, new Date())) ?? undefined;
    } catch (err) {
        console.error(`[ERROR - ${ctx}] trust line for ${sellerId}:`, (err as Error).message);
        return undefined;
    }
}

// Trusted = has a published (approved or sold) bot post and no moderator
// take-down of any of their listings in the last 90 days. Captured group
// listings never grant trust (only `posts` are consulted) but a take-down of
// one does revoke it.
export async function isTrustedSeller(sellerId: string, now: Date): Promise<boolean> {
    if (!(await postRepository.hasApprovedOrSold(sellerId))) return false;
    return !(await listingRepository.hasModeratorTakedownSince(sellerId, new Date(now.getTime() - TRUST_REVOKE_MS)));
}
