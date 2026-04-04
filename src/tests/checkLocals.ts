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

    // 1. Collect all unique keys from ALL languages
    const allKeys = new Set<string>();
    const localeData: { [lang: string]: LocaleStrings } = {};

    let hasError = false;

    for (const lang of languages) {
        const commonPath = path.join(LOCALES_DIR, lang, 'common.json');
        if (!fs.existsSync(commonPath)) {
            console.error(`[ERROR] common.json not found for language ${lang}!`);
            continue;
        }

        // 1. Validate JSON syntax
        let data: LocaleStrings;
        try {
            data = JSON.parse(fs.readFileSync(commonPath, "utf-8"));
        } catch (e) {
            console.error(`[ERROR] Invalid JSON in ${lang}/common.json: ${e}`);
            hasError = true;
            continue;
        }

        // 2. Check for empty values
        const emptyKeys = Object.keys(data).filter(key => !data[key] || data[key].trim() === '');
        if (emptyKeys.length > 0) {
            console.error(`[ERROR] Empty values in ${lang}/common.json for keys: ${emptyKeys.join(", ")}`);
            hasError = true;
        }

        // 3. Check for placeholder syntax (e.g., {amount}, {count})
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

    const sortedKeys = Array.from(allKeys).sort();

    // 2. Bidirectional Check: Ensure every language has every key
    console.log(`[INFO] verifying consistency across ${languages.length} languages: ${languages.join(", ")}`);

    for (const lang of languages) {
        const currentKeys = Object.keys(localeData[lang]);
        const missing = sortedKeys.filter(k => !currentKeys.includes(k));

        if (missing.length > 0) {
            console.error(`  [ERROR] Language '${lang}' is missing keys: ${missing.join(", ")}`);
            hasError = true;
        }
    }
    // 4. Check for namespace files (future-proofing)
    console.log("[INFO] Checking for namespace files...");
    for (const lang of languages) {
        const langDir = path.join(LOCALES_DIR, lang);
        const files = fs.readdirSync(langDir).filter(file => file.endsWith('.json') && file !== 'common.json');
        if (files.length > 0) {
            console.log(`  [INFO] Found namespace files in ${lang}: ${files.join(", ")}`);
        }
    }
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
        console.log("\n[SUCCESS] All keys appear to be used.");
    }

    if (hasError) process.exit(1);
}

runCheck();