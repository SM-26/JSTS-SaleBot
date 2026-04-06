import fs from "fs";
import path from "path";

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
            console.warn(`  [WARN] FAQ Language '${lang}' is missing IDs: ${missing.join(", ")}`);
            hasError = true;
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

    if (hasError) process.exit(1);
}

runCheck();