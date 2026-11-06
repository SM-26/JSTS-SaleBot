import { readFileSync, writeFileSync } from "fs";
import { scanExport, formatSummary } from "../src/services/catchupScan";

const usage = "usage: pnpm run catchup -- <export.json> [--out catchup.json] [--topic N] [--exclude id]... [--now ISO]";
const args = process.argv.slice(2);
let input: string | undefined;
let out = "catchup.json";
let topicId: number | undefined;
let now = new Date();
const exclude: string[] = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") out = args[++i];
    else if (a === "--topic") topicId = Number(args[++i]);
    else if (a === "--exclude") exclude.push(args[++i]);
    else if (a === "--now") now = new Date(args[++i]);
    else if (!a.startsWith("--")) input = a;
}
if (!input || !out || Number.isNaN(now.getTime()) || (topicId !== undefined && !Number.isInteger(topicId))) {
    console.error(usage);
    process.exit(1);
}

let raw: unknown;
try {
    raw = JSON.parse(readFileSync(input, "utf8"));
} catch (err) {
    console.error(`[ERROR - catchup] cannot read ${input}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}
const { file, summary } = scanExport(raw, { now, topicId, exclude });
writeFileSync(out, JSON.stringify(file, null, 2));
console.log(formatSummary(summary));
console.log(`wrote ${out}. Delete both the export and ${out} after the import.`);
