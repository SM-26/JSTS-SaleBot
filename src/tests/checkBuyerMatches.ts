import assert from "assert";
import mongoose from "mongoose";
import { isSearchable, matchListings, parseQuery } from "../services/matchService";

// Buyer query parsing and matching (slice 4). The pure part always runs; the
// Mongo part (later tasks) prints [SKIP] without MONGO_URI.
const MONGO_URI = process.env.MONGO_URI;

const L = (id: string, text: string, extra: { location?: string; meetup?: boolean } = {}) =>
    ({ _id: id, title: undefined, text, priceValue: 100, refreshedAt: new Date(1_000_000_000_000), ...extra }) as unknown as Parameters<typeof matchListings>[1][number]; // string ids: only String(_id) is read

function checkPure() {
    const a = parseQuery("מחפש גלוק 17 עד 800");
    assert.ok(a.terms.includes("glock") && a.terms.includes("17"), "alias head and number are terms");
    assert.strictEqual(a.maxPrice, 800);
    assert.strictEqual(a.meetup, false);

    const b = parseQuery("מחפש כוונת, טלפון 050-1234567");
    assert.ok(!b.terms.includes("050") && !b.terms.includes("1234567"), "phone number is not a term");
    assert.ok(!isSearchable(b), "no strong term left");
    assert.ok(!isSearchable(parseQuery("מחפש וסט")), "'וסט' alone is not strong");

    const c = parseQuery("מחפש glock בבית דגן");
    assert.strictEqual(c.meetup, true);
    assert.ok(!c.terms.includes("בית") && !c.terms.includes("דגנ"), "the meeting point is not a term");
    assert.ok(c.terms.includes("glock"));
    assert.strictEqual(c.query, c.terms.join(" "));

    assert.strictEqual(parseQuery(Array.from({ length: 30 }, (_, i) => `m${i + 1}`).join(" ")).terms.length, 20, "terms capped at 20");

    const bd = L("bd", "glock 17", { location: "בית דגן" });
    const mu = L("mu", "glock 19", { meetup: true });
    const far = L("far", "glock 17", { location: "מרכז" });
    assert.deepStrictEqual(matchListings(parseQuery("מחפש glock בבית דגן"), [far, bd, mu]).sort(), ["bd", "mu"], "meetup query keeps only meeting-point listings");
    assert.deepStrictEqual(matchListings(parseQuery("מחפש glock"), [far, bd]).sort(), ["bd", "far"], "no meetup filter without the phrase");
    assert.deepStrictEqual(matchListings(parseQuery("מחפש כוונת 0501234567"), [L("p", "כוונת 050 במצב טוב")]), [], "a phone number is not matched on");
    console.log("[OK] buyer query parsing and matching.");
}

async function run() {
    checkPure();
    if (!MONGO_URI) {
        console.log("[SKIP] checkBuyerMatches (Mongo part): set MONGO_URI to run this test.");
        return;
    }
    await mongoose.connect(MONGO_URI);
    try {
        // Mongo checks arrive with the later slice 4 tasks.
    } finally {
        await mongoose.disconnect();
    }
}

run().catch((err) => {
    console.error("[ERROR] checkBuyerMatches failed:", err);
    process.exit(1);
});
