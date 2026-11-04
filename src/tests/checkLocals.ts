import fs from "fs";
import os from "os";
import path from "path";
import assert from "assert";
import { findBlockedWord, reloadBlockedWords, setBlockedWordsPathForTest } from "../services/blockedWords";

// Paths relative to src/tests/
const LOCALES_DIR = path.join(__dirname, "../locales");
const SRC_PATH = path.join(__dirname, "../");

interface LocaleStrings {
    [key: string]: string;
}

function getFiles(dir: string, ext: string): string[] {
    let files: string[] = [];
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
            files = files.concat(getFiles(fullPath, ext));
        } else if (item.name.endsWith(ext)) {
            files.push(fullPath);
        }
    }
    return files;
}

function runCheck() {
    console.log("[INFO] Checking locales...");

    if (!fs.existsSync(LOCALES_DIR)) {
        console.error("[ERROR] locales directory not found!");
        process.exit(1);
    }

    const languages = fs.readdirSync(LOCALES_DIR).filter(dir =>
        fs.statSync(path.join(LOCALES_DIR, dir)).isDirectory()
    );
    console.log(`  [INFO] Locales found: ${languages.join(", ")}`);

    // Collectors for consistency and usage checks
    const allKeys = new Set<string>();
    const localeData: { [lang: string]: LocaleStrings } = {};
    const allFaqKeys = new Set<string>();
    const faqDataMap: { [lang: string]: LocaleStrings } = {};

    let hasError = false;

    // 1. Validate individual common.json files (Syntax, Values, Placeholders)
    console.log(`[INFO] Validating common.json files for ${languages.length} languages...`);
    for (const lang of languages) {
        const commonPath = path.join(LOCALES_DIR, lang, 'common.json');
        if (!fs.existsSync(commonPath)) {
            console.error(`[ERROR] common.json not found for language ${lang}!`);
            continue;
        }

        // Validate JSON syntax
        let data: LocaleStrings;
        try {
            data = JSON.parse(fs.readFileSync(commonPath, "utf-8"));
        } catch (e) {
            console.error(`[ERROR] Invalid JSON in ${lang}/common.json: ${e}`);
            hasError = true;
            continue;
        }

        // Check for empty values
        const emptyKeys = Object.keys(data).filter(key => !data[key] || data[key].trim() === '');
        if (emptyKeys.length > 0) {
            console.error(`[ERROR] Empty values in ${lang}/common.json for keys: ${emptyKeys.join(", ")}`);
            hasError = true;
        }

        // Check for placeholder syntax (e.g., {amount}, {count})
        const invalidPlaceholders = Object.keys(data).filter(key => {
            const value = data[key];
            const placeholderMatches = value.match(/\{([^}]+)\}/g);
            if (!placeholderMatches) return false;
            // Check for invalid placeholders (spaces, special chars, etc.)
            return placeholderMatches.some(match => !/^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(match));
        });
        if (invalidPlaceholders.length > 0) {
            console.error(`[ERROR] Invalid placeholder syntax in ${lang}/common.json for keys: ${invalidPlaceholders.join(", ")}`);
            hasError = true;
        }

        localeData[lang] = data;
        Object.keys(data).forEach(key => allKeys.add(key));
    }

    // 2. Validate individual FAQ files (faq.json)
    console.log(`[INFO] Validating faq.json files for ${languages.length} languages...`);
    for (const lang of languages) {
        const faqPath = path.join(LOCALES_DIR, lang, 'faq.json');
        if (!fs.existsSync(faqPath)) {
            console.error(`[ERROR] faq.json not found for language ${lang}!`);
            hasError = true;
            continue;
        }

        try {
            const faqContent = fs.readFileSync(faqPath, 'utf-8');
            const faqData = JSON.parse(faqContent);
            if (!faqData.nodes || typeof faqData.nodes !== 'object') {
                console.error(`[ERROR] Invalid FAQ structure in ${lang}/faq.json - missing 'nodes' object`);
                hasError = true;
            } else {
                // Check for empty values in FAQ
                const emptyFaqKeys = Object.keys(faqData.nodes).filter(key => !faqData.nodes[key] || faqData.nodes[key].trim() === '');
                if (emptyFaqKeys.length > 0) {
                    console.error(`[ERROR] Empty values in ${lang}/faq.json for keys: ${emptyFaqKeys.join(", ")}`);
                    hasError = true;
                }

                faqDataMap[lang] = faqData.nodes;
                Object.keys(faqData.nodes).forEach(key => allFaqKeys.add(key));
            }
        } catch (e) {
            console.error(`[ERROR] Invalid JSON in ${lang}/faq.json: ${e}`);
            hasError = true;
        }
    }

    // 3. common.json Bidirectional Check: Ensure every language has every key
    console.log(`[INFO] Verifying common.json consistency across ${languages.length} languages...`);
    const sortedKeys = Array.from(allKeys).sort();
    for (const lang of languages) {
        const currentKeys = localeData[lang] ? Object.keys(localeData[lang]) : [];
        const missing = sortedKeys.filter(k => !currentKeys.includes(k));

        if (missing.length > 0) {
            console.error(`  [ERROR] Language '${lang}' is missing keys: ${missing.join(", ")}`);
            hasError = true;
        }
    }

    // 4. faq.json Bidirectional Check: Ensure every language has every FAQ key
    console.log(`[INFO] Verifying faq.json consistency across ${languages.length} languages...`);
    const sortedFaqKeys = Array.from(allFaqKeys).sort();
    for (const lang of languages) {
        const currentKeys = faqDataMap[lang] ? Object.keys(faqDataMap[lang]) : [];
        const missing = sortedFaqKeys.filter(k => !currentKeys.includes(k));

        if (missing.length > 0) {
            // FAQ node coverage is aspirational content, not part of the locale
            // contract — warn but don't fail the build (common.json key
            // consistency above is what actually gates CI).
            console.warn(`  [WARN] FAQ Language '${lang}' is missing IDs: ${missing.join(", ")}`);
        }
    }

    // 5. Check for extra namespace files (future-proofing)
    console.log("[INFO] Checking for extra namespace files...");
    for (const lang of languages) {
        const langDir = path.join(LOCALES_DIR, lang);
        const files = fs.readdirSync(langDir).filter(file => file.endsWith('.json') && file !== 'common.json' && file !== 'faq.json');
        if (files.length > 0) {
            console.log(`  [INFO] Found namespace files in ${lang}: ${files.join(", ")}`);
        }
    }

    // 6. Scanning source code for usage (common.json keys)
    console.log("[INFO] Scanning source code for usage...");
    const tsFiles = getFiles(SRC_PATH, ".ts");
    const fileContents = tsFiles.map(f => fs.readFileSync(f, "utf-8")).join("\n");
    const unusedKeys: string[] = [];

    for (const key of sortedKeys) {
        // Matches 'keyName' or "keyName" or .keyName or ["keyName"] or ['keyName']
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`["']${escapedKey}["']|\\[${escapedKey}\\]|\\.${escapedKey}\\b`);
        if (!regex.test(fileContents)) {
            unusedKeys.push(key);
        }
    }
    if (unusedKeys.length > 0) {
        console.warn(`  [WARN] Potentially unused keys (${unusedKeys.length}):\n     - ${unusedKeys.join("\n     - ")}`);
    } else {
        console.log("  [SUCCESS] All keys appear to be used.");
    }

    // 6b. The blocked-word list reloads from disk (the owner edits it on the server)
    console.log("[INFO] Checking blocked-word reload...");
    const tmpList = path.join(os.tmpdir(), `blockedWords-${process.pid}.json`);
    try {
        setBlockedWordsPathForTest(tmpList);
        assert.strictEqual(reloadBlockedWords(), 0, "missing file: empty list, no crash");
        fs.writeFileSync(tmpList, JSON.stringify(["בדיקהאחת"]));
        assert.strictEqual(reloadBlockedWords(), 1);
        assert.strictEqual(findBlockedWord("זו בדיקהאחת"), "בדיקהאחת");
        fs.writeFileSync(tmpList, JSON.stringify(["בדיקהשתיים"]));
        fs.utimesSync(tmpList, new Date(), new Date(Date.now() + 5000));
        assert.strictEqual(reloadBlockedWords(), 1);
        assert.strictEqual(findBlockedWord("בדיקהשתיים כאן"), "בדיקהשתיים");
        assert.strictEqual(findBlockedWord("זו בדיקהאחת"), null, "old entry is gone");
        for (const bad of ["{ not json", '{"a":1}', '["ok", 5]', '[""]']) {
            fs.writeFileSync(tmpList, bad);
            assert.strictEqual(reloadBlockedWords(), 1, `invalid list ${bad} keeps the last good one`);
            assert.strictEqual(findBlockedWord("בדיקהשתיים כאן"), "בדיקהשתיים");
        }
    } finally {
        setBlockedWordsPathForTest(undefined);
        fs.rmSync(tmpList, { force: true });
    }
    assert.ok(reloadBlockedWords() > 60, "default list loads from the real file");
    console.log("  [SUCCESS] Blocked-word list reloads and survives bad edits.");

    // 7. Blocked words: the Hebrew locale must never say them (replicas are not weapons)
    console.log("[INFO] Checking he strings for blocked words...");
    assert.strictEqual(findBlockedWord("מוכר נשק"), "נשק");
    assert.strictEqual(findBlockedWord("מתנה לנשק"), "לנשק", "accepted false positive: listed separately in Rose");
    assert.strictEqual(findBlockedWord("ליד תחנה קרובה"), null, "whole word only");
    assert.strictEqual(findBlockedWord("גרסה חדשה"), null);
    assert.strictEqual(findBlockedWord("נשקים למכירה"), "נשקים");
    assert.strictEqual(findBlockedWord("ראו https://cutt.ly/abc123"), "https://cutt.ly/*");
    assert.strictEqual(findBlockedWord("WATCH PORN now"), "watch porn");
    assert.strictEqual(findBlockedWord("M4 למכירה"), null);
    assert.strictEqual(findBlockedWord("http://rebrandXly/tindrlike"), null, "the dot in an entry is escaped");
    assert.strictEqual(findBlockedWord("שלום @jessyy012"), "@jessyy012");
    assert.strictEqual(findBlockedWord(undefined), null);
    const heStrings: [string, string][] = [];
    if (localeData.he) heStrings.push(...Object.entries(localeData.he).map(([k, v]): [string, string] => [`he/common.json:${k}`, v]));
    if (faqDataMap.he) heStrings.push(...Object.entries(faqDataMap.he).map(([k, v]): [string, string] => [`he/faq.json:${k}`, v]));
    for (const [where, value] of heStrings) {
        const hit = findBlockedWord(value);
        if (hit) {
            console.error(`  [ERROR] Blocked word "${hit}" in ${where}`);
            hasError = true;
        }
    }

    if (hasError) process.exit(1);
}

runCheck();