import assert from "assert";
import fs from "fs";
import path from "path";
import { CONFIG_SCHEMA } from "../services/configSchema";

/**
 * Keeps docs/ in step with the code: commands, config keys, page links, source paths.
 * What it enforces is described in docs/Testing.md.
 * Run: pnpm run check-docs
 */

console.log("[INFO] Checking docs...");

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf-8");
const page = (name: string) => read(`docs/${name}`);
// Code blocks hold examples, not references.
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, "");
// The first column of the tables on a page.
const rows = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);
const missing = (wanted: Iterable<string>, have: Iterable<string>) => {
    const known = new Set([...have].map((s) => s.toLowerCase()));
    return [...wanted].filter((s) => !known.has(s.toLowerCase()));
};

const pages = fs.readdirSync(DOCS).filter((f) => f.endsWith(".md"));
const errors: string[] = [];

const registered = rows(read("src/controllers/botController.ts"), /cmd\("(\w+)"/g);
assert.ok(registered.length > 0, "found no cmd() registrations; did botController change shape?");
const documented = rows(page("Commands.md"), /^\| `\/(\w+)/gm);
for (const c of missing(registered, documented)) errors.push(`Commands.md: /${c} is registered but not documented`);
for (const c of missing(documented, registered)) errors.push(`Commands.md: /${c} is documented but not registered`);

const keys = [...Object.keys(CONFIG_SCHEMA), ...Object.keys(JSON.parse(read("config.json.example")))];
const documentedKeys = rows(page("Config.md"), /^\| `(\w+)`/gm);
for (const k of new Set(missing(keys, documentedKeys))) errors.push(`Config.md: ${k} is not documented`);
for (const k of missing(documentedKeys, keys)) errors.push(`Config.md: ${k} is documented but is not a config key`);

for (const name of pages) {
    const text = prose(page(name));
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const wikiPage = target!.match(/^https:\/\/github\.com\/SM-26\/JSTS-SaleBot\/wiki\/([^/#?]+)/)?.[1];
        if (wikiPage && wikiPage !== "Home" && !pages.includes(`${wikiPage}.md`)) errors.push(`${name}: wiki link ${target} is not a page in docs/`);
        if (/^([a-z]+:|#)/i.test(target!)) continue;
        const file = target!.split("#")[0]!;
        if (file.includes("/") || !pages.includes(file)) errors.push(`${name}: link ${target} is not a page in docs/`);
    }
    // ponytail: the changelog describes history, so old paths are fine there.
    if (name === "CHANGELOG.md") continue;
    for (const [, ref] of text.matchAll(/`((?:src|scripts)\/[^`\s*<]*)`/g)) {
        if (!fs.existsSync(path.join(ROOT, ref!))) errors.push(`${name}: ${ref} does not exist`);
    }
}

if (errors.length > 0) {
    errors.forEach((e) => console.error(`[ERROR - checkDocs] ${e}`));
    process.exit(1);
}
console.log(`[OK] Docs: ${registered.length} commands, ${new Set(keys).size} config keys, ${pages.length} pages.`);
