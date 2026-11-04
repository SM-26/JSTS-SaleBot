import blockedWords from "../config/blockedWords.json";

/** First blocked word contained in `text`, or null. */
export function findBlockedWord(text: string | undefined | null): string | null {
    if (!text) return null;
    // ponytail: substring match on purpose (owner): letters, not meaning
    return blockedWords.find(word => text.includes(word)) ?? null;
}
