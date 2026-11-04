import fs from "fs";
import path from "path";

// Read from disk at runtime, like src/locales, so the owner can edit the list on the server with no rebuild.
// process.cwd() is the repo root under ts-node and /app in the production image.
const DEFAULT_PATH = path.join(process.cwd(), "src", "config", "blockedWords.json");
export const BLOCKED_WORDS_PATH = process.env.BLOCKED_WORDS_PATH || DEFAULT_PATH;
const CHECK_EVERY_MS = 60_000;

interface Matcher { entry: string; regex: RegExp }

// ponytail: matches Rose's blocklist semantics on purpose (owner): whole word or phrase, case-insensitive, `*` = run of non-space
function compile(entry: string): Matcher {
    return {
        entry,
        regex: new RegExp(
            "(?<![\\p{L}\\p{N}])" +
                entry.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\S*") +
                "(?![\\p{L}\\p{N}])",
            "iu"
        ),
    };
}

let filePath = BLOCKED_WORDS_PATH;
let matchers: Matcher[] = [];
let seenKey = "";   // mtime of the file as last looked at (good or bad), so a bad file is logged once per change
let lastCheck = 0;

function fileKey(): string {
    try {
        return String(fs.statSync(filePath).mtimeMs);
    } catch {
        return "missing";
    }
}

/** Forces a reload from disk. A bad file keeps the last good list. Returns the entry count. */
export function reloadBlockedWords(): number {
    lastCheck = Date.now();
    seenKey = fileKey();
    try {
        const list: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (!Array.isArray(list) || !list.every(e => typeof e === "string" && e.trim() !== "")) {
            throw new Error("expected an array of non-empty strings");
        }
        matchers = list.map(compile);
    } catch (error) {
        console.error(`[ERROR - blockedWords] keeping ${matchers.length} entries, cannot load ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return matchers.length;
}

/** Test hook: point at another file (undefined = the real one) and reload. */
export function setBlockedWordsPathForTest(p: string | undefined): void {
    filePath = p ?? BLOCKED_WORDS_PATH;
    seenKey = "";
    matchers = [];
    if (p === undefined) reloadBlockedWords();
}

function refreshIfStale(): void {
    if (Date.now() - lastCheck < CHECK_EVERY_MS) return;
    lastCheck = Date.now();
    if (fileKey() !== seenKey) reloadBlockedWords();
}

reloadBlockedWords();

/** First blocked entry contained in `text`, or null. */
export function findBlockedWord(text: string | undefined | null): string | null {
    if (!text) return null;
    refreshIfStale();
    return matchers.find(m => m.regex.test(text))?.entry ?? null;
}
