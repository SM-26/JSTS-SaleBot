import blockedWords from "../config/blockedWords.json";

// ponytail: matches Rose's blocklist semantics on purpose (owner): whole word or phrase, case-insensitive, `*` = run of non-space
const matchers = blockedWords.map(entry => ({
    entry,
    regex: new RegExp(
        "(?<![\\p{L}\\p{N}])" +
            entry.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\S*") +
            "(?![\\p{L}\\p{N}])",
        "iu"
    ),
}));

/** First blocked entry contained in `text`, or null. */
export function findBlockedWord(text: string | undefined | null): string | null {
    if (!text) return null;
    return matchers.find(m => m.regex.test(text))?.entry ?? null;
}
