import type { ICapture } from "../models/Capture";
import captureRepository from "../repositories/captureRepository";
import listingRepository from "../repositories/listingRepository";
import shadowLogRepository from "../repositories/shadowLogRepository";
import type { BotConfig } from "../types";
import { classify, textHash, tokenOverlap, tokens, type ClassifyResult } from "./classifier";
import { rankMatches } from "./matchService";

const REPOST_MS = 30 * 24 * 3600_000;
const REPOST_OVERLAP = 0.8;

// What the sweeper just decided about one capture (`capture` is the claimed document, as it was before the classification was saved).
export interface ClassifiedEvent { capture: ICapture; result: ClassifyResult; mergeWith?: string }
export type OnClassified = (event: ClassifiedEvent, now: Date) => Promise<void>;

// Claims one closed capture, records what automatic capture would have done
// (no member text: ids, tier and, for would-list rows, the price number) and marks it classified.
// False when nothing was claimed.
export async function processOneClosed(config: BotConfig, now: Date, onClassified?: OnClassified): Promise<boolean> {
    const cap = await captureRepository.claimClosed();
    if (!cap) return false;

    const result = classify(cap.text, cap.media.length > 0);
    const { tier, rules, parsed } = result;

    // only a sale post (strict or ask) can repeat the seller's listing
    let mergeWith: string | undefined;
    if (tier === "strict" || tier === "ask") {
        const hash = textHash(cap.text);
        const capTokens = tokens(cap.text);
        const recent = await listingRepository.findSellerRecent(cap.senderId, new Date(now.getTime() - REPOST_MS));
        const repost = recent.find(l => l.textHash === hash || tokenOverlap(capTokens, tokens(l.text ?? "")) >= REPOST_OVERLAP);
        mergeWith = repost ? String(repost._id) : undefined;
    }

    const matches = tier === "wtb" && config.buyerMatches === "shadow"
        ? rankMatches(cap.text, await listingRepository.findLiveForMatching())
        : undefined;

    const wouldList = tier === "strict" && !mergeWith;
    await shadowLogRepository.insert({
        chatId: cap.chatId,
        messageIds: cap.messageIds,
        senderId: cap.senderId,
        at: now,
        tier,
        rules,
        wouldList,
        mergeWith,
        parsedPriceValue: wouldList ? parsed.priceValue : undefined,
        matches,
    });
    await captureRepository.saveClassification(String(cap._id), tier, rules, parsed);
    if (onClassified) {
        try {
            await onClassified({ capture: cap, result, mergeWith }, now);
        } catch (err) {
            console.error("[ERROR - shadow:onClassified]", (err as Error).message);
        }
    }
    return true;
}

export async function closeDueWindows(now: Date): Promise<number> {
    let n = 0;
    while (await captureRepository.claimDue(now)) n++;
    return n;
}

export async function tick(config: BotConfig, now: Date, onClassified?: OnClassified): Promise<void> {
    await closeDueWindows(now);
    while (await processOneClosed(config, now, onClassified)) { /* drain */ }
}
