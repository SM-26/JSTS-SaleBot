import { spawn } from "child_process";
import * as os from "os";

// `pnpm test`: runs every check-* script, in parallel, and prints each script's output as one block when it
// finishes (never interleaved). Exits non-zero if any script fails. Each Mongo-gated script gets its own
// database ("<name>_<script>"), so the scripts that wipe collections only ever wipe their own; MONGO_URI
// unset means each of them prints [SKIP] and passes, exactly as when run alone.
//
// checkRoutes is the one script that writes config.json (the /config command persists it, and the script
// restores the file at the end) while every other script reads that file at import. It therefore runs alone,
// after the others have finished.
const PARALLEL = ["flows", "buyer", "market", "tiers", "rich", "callbacks", "store", "claim", "locals", "config", "classifier", "catchup", "polling", "cards", "platform", "docs"];
const ALONE = ["routes"];

/** The URI with its database name replaced by "<db>_<suffix>" (query string kept). */
export function dbUriFor(uri: string, suffix: string): string {
    const match = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(\?.*)?$/.exec(uri);
    if (!match) throw new Error("MONGO_URI is not a mongodb:// URI");
    return `${match[1]}/${match[2] || "SalesBotTestDB"}_${suffix}${match[3] ?? ""}`;
}

interface Outcome { name: string; code: number; ms: number; output: string }

function runScript(name: string, mongoUri: string | undefined): Promise<Outcome> {
    return new Promise((resolve) => {
        const started = Date.now();
        const env = { ...process.env };
        if (mongoUri) env.MONGO_URI = dbUriFor(mongoUri, name); else delete env.MONGO_URI;
        const child = spawn(`pnpm run check-${name}`, { shell: true, env, cwd: process.cwd() });
        let output = "";
        child.stdout.on("data", (d) => { output += d; });
        child.stderr.on("data", (d) => { output += d; });
        child.on("close", (code) => {
            const outcome = { name, code: code ?? 1, ms: Date.now() - started, output };
            console.log(`\n===== check-${name}: ${outcome.code === 0 ? "ok" : "FAILED (exit " + outcome.code + ")"} in ${(outcome.ms / 1000).toFixed(1)} s =====\n${output.trimEnd()}`);
            resolve(outcome);
        });
    });
}

/** Runs `names` with at most `limit` at a time, in the given order. */
async function pool(names: string[], limit: number, mongoUri: string | undefined): Promise<Outcome[]> {
    const queue = [...names];
    const done: Outcome[] = [];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (let name = queue.shift(); name; name = queue.shift()) done.push(await runScript(name, mongoUri));
    }));
    return done;
}

async function main() {
    const mongoUri = process.env.MONGO_URI || undefined;
    const started = Date.now();
    const limit = Math.max(4, os.cpus().length);
    const results = [...await pool(PARALLEL, limit, mongoUri), ...await pool(ALONE, 1, mongoUri)];

    const skipped = results.filter((r) => r.output.includes("[SKIP]")).map((r) => r.name);
    console.log("\n===== summary =====");
    for (const r of results) console.log(`${r.code === 0 ? "ok    " : "FAILED"} check-${r.name} (${(r.ms / 1000).toFixed(1)} s)`);
    if (skipped.length) console.log(`[SKIP] ${skipped.length} script(s) skipped, MONGO_URI is not set or not used: ${skipped.join(", ")}`);
    const failed = results.filter((r) => r.code !== 0);
    console.log(`${failed.length ? "FAILED: " + failed.map((r) => r.name).join(", ") : "Tests passed"} (${((Date.now() - started) / 1000).toFixed(1)} s wall)`);
    process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
