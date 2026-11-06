import assert from "assert";
import fs from "fs";
import path from "path";
import { routeCallback } from "../controllers/callbackRoutes";
import { deepLink, groupMessageLink, parseStartPayload } from "../services/deepLinks";

/**
 * Golden test for callback_data routing.
 * The table below is literal on purpose: never edit an existing row to make a
 * refactor pass, because these strings live in old Telegram messages forever.
 * Run: pnpm exec ts-node src/tests/checkCallbackData.ts
 */

console.log("[INFO] Checking callback_data routing...");

const ID = "65f1c2a9e4b0c3d2a1f09876";

const GOLDEN: Array<[string, { action: string; arg: string } | null]> = [
    [`approve_${ID}`, { action: "approve", arg: ID }],
    [`reject_${ID}`, { action: "reject", arg: ID }],
    [`sold_${ID}`, { action: "sold", arg: ID }],
    [`bump_${ID}`, { action: "bump", arg: ID }],
    ["clear_rejected", { action: "clearRejected", arg: "" }],
    ["clear_sold", { action: "clearSold", arg: "" }],
    ["lang_en", { action: "lang", arg: "en" }],
    ["lang_he", { action: "lang", arg: "he" }],
    ["lang_ru", { action: "lang", arg: "ru" }],
    ["faq_root", { action: "faq", arg: "root" }],
    ["faq_1", { action: "faq", arg: "1" }],
    ["faq_1.2.1", { action: "faq", arg: "1.2.1" }],
    ["donate_50", { action: "donate", arg: "50" }],
    ["donate_150", { action: "donate", arg: "150" }],
    ["donate_other", { action: "donate", arg: "other" }],
    ["test_all", { action: "test", arg: "all" }],
    [`lb_${ID}_s`, { action: "label", arg: `${ID}_s` }],
    [`lb_${ID}_n`, { action: "label", arg: `${ID}_n` }],
    [`lb_${ID}_k`, { action: "label", arg: `${ID}_k` }],
    ["td_65f1c2a9e4b0c3d2a1f09876", { action: "takeDown", arg: "65f1c2a9e4b0c3d2a1f09876" }],
    [`tx_${ID}_d`, { action: "takeDownDelete", arg: `${ID}_d` }],
    [`tx_${ID}_y`, { action: "takeDownDelete", arg: `${ID}_y` }],
    [`tx_${ID}_n`, { action: "takeDownDelete", arg: `${ID}_n` }],
    [`rr_${ID}_1`, { action: "rejectReason", arg: `${ID}_1` }],
    [`rr_${ID}_4`, { action: "rejectReason", arg: `${ID}_4` }],
    [`mk_${ID}_a`, { action: "capture", arg: `${ID}_a` }],
    [`mk_${ID}_n`, { action: "capture", arg: `${ID}_n` }],
    [`mk_${ID}_x`, { action: "capture", arg: `${ID}_x` }],
    ["mk_set_ask", { action: "capture", arg: "set_ask" }],
    ["mk_set_never", { action: "capture", arg: "set_never" }],
    [`ls_${ID}_s_n`, { action: "listing", arg: `${ID}_s_n` }],
    [`ls_${ID}_f_c`, { action: "listing", arg: `${ID}_f_c` }],
    [`ls_${ID}_r_l`, { action: "listing", arg: `${ID}_r_l` }],
    // Unknown or ephemeral (handled by temporary listeners): must not route.
    ["confirm_123", null],
    ["done_media_123", null],
    ["skip_reason_abc", null],
    ["clear_other", null],
    ["garbage", null],
    ["", null],
];

for (const [data, expected] of GOLDEN) {
    assert.deepStrictEqual(routeCallback(data), expected, `golden row failed: "${data}"`);
}
console.log(`  [SUCCESS] ${GOLDEN.length} golden rows route as expected.`);

// --- strings the bot generates from data on disk ---------------------------------
const localesDir = path.join(__dirname, "..", "locales");
const localeDirs = fs.readdirSync(localesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
assert.ok(localeDirs.length > 0, "no locale directories found");

const generated: string[] = [];
for (const dir of localeDirs) {
    assert.deepStrictEqual(routeCallback(`lang_${dir}`), { action: "lang", arg: dir });
    generated.push(`lang_${dir}`);

    const faq = JSON.parse(fs.readFileSync(path.join(localesDir, dir, "faq.json"), "utf8")) as { nodes: Record<string, string> };
    for (const nodeId of Object.keys(faq.nodes)) {
        assert.deepStrictEqual(routeCallback(`faq_${nodeId}`), { action: "faq", arg: nodeId });
        generated.push(`faq_${nodeId}`);
    }
}
for (const s of [`approve_${ID}`, `reject_${ID}`, `sold_${ID}`, `bump_${ID}`, `lb_${ID}_s`, `lb_${ID}_n`, `lb_${ID}_k`, "td_65f1c2a9e4b0c3d2a1f09876", `tx_${ID}_d`, `tx_${ID}_y`, `tx_${ID}_n`, `rr_${ID}_1`, `rr_${ID}_4`,
    `mk_${ID}_a`, `mk_${ID}_n`, `mk_${ID}_x`,
    ...["s", "f", "r"].flatMap(a => ["n", "c", "l"].map(surface => `ls_${ID}_${a}_${surface}`)),
]) generated.push(s);

for (const s of generated) {
    assert.ok(Buffer.byteLength(s) <= 64, `callback_data over 64 bytes: "${s}"`);
}
console.log(`  [SUCCESS] ${generated.length} generated strings route correctly and fit Telegram's 64-byte limit.`);

// --- start payloads and links ----------------------------------------------------
const PAYLOADS: Array<[string, { kind: string; id: string } | null]> = [
    [`c_${ID}`, { kind: "c", id: ID }],
    [`l_${ID}`, { kind: "l", id: ID }],
    ["c_", null], ["c_xyz", null], [`x_${ID}`, null], ["sell", null], ["garbage", null], ["", null],
];
for (const [args, expected] of PAYLOADS) {
    assert.deepStrictEqual(parseStartPayload(args), expected, `start payload failed: "${args}"`);
}
assert.strictEqual(deepLink("JSTS_testing_bot", `c_${ID}`), `https://t.me/JSTS_testing_bot?start=c_${ID}`);
assert.strictEqual(groupMessageLink({ id: -1002445943058 }, 9), "https://t.me/c/2445943058/9");
assert.strictEqual(groupMessageLink({ id: -1001, username: "airsoft_yad2" }, 5), "https://t.me/airsoft_yad2/5");
console.log("  [SUCCESS] start payloads and links.");

console.log("[SUCCESS] All callback_data checks passed.");
