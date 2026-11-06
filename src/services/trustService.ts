import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { localeService } from "./localeService";
import type { BotConfig } from "../types";

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
    return localeService.t(locale, n === 1 ? "trustLineOne" : "trustLine", { n, since: since ? formatSince(since, locale) : "" });
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

// Seller tiers (spec 17.1). Verified outranks top seller; "both" is the two together.
export type SellerTier = "regular" | "top" | "verified" | "both";
export const TOP_SELLER_PERCENT = 60;
export const TOP_SELLER_MIN_ENDED = 3;

// The live config object (/config updates it in place). BotController hands it over on start.
type TierSettings = Pick<BotConfig, "tierLayouts" | "topSellerPercent" | "topSellerMinEnded">;
let tierSettings: TierSettings = {};
export function configureTiers(settings: TierSettings): void {
    tierSettings = settings;
}

export async function isTopSeller(sellerId: string): Promise<boolean> {
    const { sold, ended } = await listingRepository.countEnded(sellerId);
    const minEnded = tierSettings.topSellerMinEnded ?? TOP_SELLER_MIN_ENDED;
    const percent = tierSettings.topSellerPercent ?? TOP_SELLER_PERCENT;
    return ended > 0 && ended >= minEnded && (sold / ended) * 100 >= percent;
}

export async function sellerTier(sellerId: string): Promise<SellerTier> {
    const [user, top] = await Promise.all([userRepository.findByUserId(sellerId), isTopSeller(sellerId)]);
    const verified = Boolean(user?.verifiedAt);
    return verified ? (top ? "both" : "verified") : top ? "top" : "regular";
}

export interface SellerLayout {
    tier: SellerTier;
    trustLine?: string;
    stats?: { sold: number; since: string };
}

// What formatPostRichMessage needs to pick a layout for this seller right now. Like the trust line, a
// failure here must never break a publish or a button: it falls back to today's layout, logged.
// `forced` is a post's own layoutTier (test posts only); the stats stay the seller's real ones.
export async function sellerLayout(sellerId: string, locale: string, ctx: string, forced?: SellerTier): Promise<SellerLayout> {
    try {
        // tierLayouts off: everyone gets the regular post. A /test sample still shows its own tier (forced).
        const tier = forced ?? (tierSettings.tierLayouts === true ? await sellerTier(sellerId) : "regular");
        if (tier === "regular") return { tier, trustLine: (await trustLineFor(sellerId, locale, new Date())) ?? undefined };
        const [sold, since] = await Promise.all([listingRepository.countSold(sellerId), marketSince(sellerId)]);
        return { tier, stats: { sold, since: since ? formatSince(since, locale) : "" } };
    } catch (err) {
        console.error(`[ERROR - ${ctx}] seller layout for ${sellerId}:`, (err as Error).message);
        return { tier: "regular" };
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
