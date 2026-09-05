import assert from "assert";
import { EventEmitter } from "events";
import { registerPollingErrorHandler, isTransient } from "../config/pollingErrors";

// Guards the polling-noise handling from issue #48: outages must log as
// warnings, repeats must collapse, and -- the dangerous failure mode -- the
// deduplication must never swallow a *different* error.
function run() {
    console.log("[INFO] Checking polling error handling...");

    const err = (message: string, code?: string) => Object.assign(new Error(message), { code });

    assert.ok(isTransient(err("ETELEGRAM: 502 Bad Gateway")), "502 is transient");
    assert.ok(isTransient(err("ETELEGRAM: 504 Gateway Timeout")), "504 is transient");
    assert.ok(isTransient(err("EFATAL: fetch failed", "EFATAL")), "EFATAL is transient");
    assert.ok(!isTransient(err("ETELEGRAM: 401 Unauthorized")), "401 is not transient");
    assert.ok(!isTransient(err("ETELEGRAM: 409 Conflict")), "409 is not transient");

    const warns: string[] = [];
    const errors: string[] = [];
    const realWarn = console.warn;
    const realError = console.error;
    console.warn = (...args) => warns.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
        const bot = new EventEmitter();
        registerPollingErrorHandler(bot);

        // One outage, many identical errors: one line, then a collapsed count.
        for (let i = 0; i < 19; i++) bot.emit("polling_error", err("ETELEGRAM: 502 Bad Gateway"));
        assert.strictEqual(warns.length, 1, `19 identical errors should log once, got ${warns.length}`);

        // A different error must still get through, and flush the count.
        bot.emit("polling_error", err("ETELEGRAM: 401 Unauthorized"));
        assert.ok(warns[1].includes("18 more"), `expected collapsed count, got: ${warns[1]}`);
        assert.strictEqual(errors.length, 1, "a non-transient error must be logged at error level");
        assert.ok(errors[0].includes("401"), "the 401 must not be swallowed by deduplication");
    } finally {
        console.warn = realWarn;
        console.error = realError;
    }

    console.log("[OK] transient errors warn, repeats collapse, distinct errors still surface.");
}

run();
