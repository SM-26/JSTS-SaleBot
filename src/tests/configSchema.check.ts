import assert from "assert";
import { parseConfigValue } from "../services/configSchema";

/**
 * Asserts for the /config value parser.
 * Run: pnpm exec ts-node src/tests/configSchema.check.ts
 */

console.log("[INFO] Checking /config value parsing...");

// --- enums -----------------------------------------------------------------
assert.deepStrictEqual(parseConfigValue("mediaLayout", "slideshow"), { ok: true, value: "slideshow" });
assert.deepStrictEqual(parseConfigValue("mediaLayout", "collage"), { ok: true, value: "collage" });

const badLayout = parseConfigValue("mediaLayout", "banana");
assert.strictEqual(badLayout.ok, false);
assert.ok(!badLayout.ok && badLayout.expected.includes("slideshow"), "should list allowed layouts");
console.log("  [SUCCESS] mediaLayout accepts only slideshow/collage.");

// lang is validated against the discovered locales, so a number is rejected.
const badLang = parseConfigValue("lang", "123");
assert.strictEqual(badLang.ok, false);
assert.deepStrictEqual(parseConfigValue("lang", "en"), { ok: true, value: "en" });
console.log("  [SUCCESS] lang accepts only known locales.");

// Object.prototype names are unknown keys, not a crash.
assert.strictEqual(parseConfigValue("constructor", "x").ok, false);
assert.strictEqual(parseConfigValue("toString", "x").ok, false);

// --- booleans --------------------------------------------------------------
assert.deepStrictEqual(parseConfigValue("validatePrice", "true"), { ok: true, value: true });
assert.deepStrictEqual(parseConfigValue("validatePrice", "false"), { ok: true, value: false });
assert.strictEqual(parseConfigValue("validatePrice", "yes").ok, false);
assert.strictEqual(parseConfigValue("validatePrice", "1").ok, false);
console.log("  [SUCCESS] booleans accept only true/false.");

// --- numbers ---------------------------------------------------------------
assert.deepStrictEqual(parseConfigValue("minimumPhotos", "2"), { ok: true, value: 2 });
assert.strictEqual(parseConfigValue("minimumPhotos", "-1").ok, false, "min should be enforced");
assert.strictEqual(parseConfigValue("minimumPhotos", "abc").ok, false);
assert.strictEqual(parseConfigValue("minimumPhotos", "").ok, false);
// non-nullable number must not accept "null"
assert.strictEqual(parseConfigValue("minimumPhotos", "null").ok, false);
console.log("  [SUCCESS] numbers reject junk, enforce min, and reject null when not nullable.");

// --- nullable numbers ------------------------------------------------------
// This is the case that previously stored the *string* "null".
assert.deepStrictEqual(parseConfigValue("broadcastTopicId", "null"), { ok: true, value: null });
assert.deepStrictEqual(parseConfigValue("broadcastTopicId", "73"), { ok: true, value: 73 });
assert.strictEqual(parseConfigValue("broadcastTopicId", "abc").ok, false);
console.log("  [SUCCESS] nullable numbers coerce \"null\" to real null.");

// --- market switches and string kind --------------------------------------
assert.deepStrictEqual(parseConfigValue("captureMode", "shadow"), { ok: true, value: "shadow" });
assert.deepStrictEqual(parseConfigValue("captureMode", "optin"), { ok: true, value: "optin" });
assert.strictEqual(parseConfigValue("captureMode", "hybrid").ok, false, "hybrid is not allowed");
assert.deepStrictEqual(parseConfigValue("buyerMatches", "off"), { ok: true, value: "off" });
assert.strictEqual(parseConfigValue("buyerMatches", "on").ok, false, "on is not allowed yet");
assert.deepStrictEqual(parseConfigValue("nudges", "true"), { ok: true, value: true });
assert.deepStrictEqual(parseConfigValue("quickListing", "true"), { ok: true, value: true });
const rules = "https://t.me/airsoft_yad2/54833/115880";
assert.deepStrictEqual(parseConfigValue("rulesUrl", rules), { ok: true, value: rules });
assert.deepStrictEqual(parseConfigValue("rulesUrl", ""), { ok: true, value: "" });
assert.strictEqual(parseConfigValue("rulesUrl", "http://evil.example").ok, false);
console.log("  [SUCCESS] market switches and the string kind validate.");

// --- unknown key -----------------------------------------------------------
assert.strictEqual(parseConfigValue("notARealKey", "x").ok, false);
console.log("  [SUCCESS] unknown keys are rejected.");

console.log("[SUCCESS] All /config parsing checks passed.");
