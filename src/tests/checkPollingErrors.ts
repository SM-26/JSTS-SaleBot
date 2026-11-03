import assert from "assert";
import { EventEmitter } from "events";
import { NetworkError, TelegramApiError } from "tgv2";
import { registerPollingErrorHandler, isTransient, createPollErrorLogger } from "../config/pollingErrors";

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

        // v2: onError only sees transient errors, so everything is a warning.
        warns.length = 0;
        errors.length = 0;
        const onError = createPollErrorLogger();

        for (let i = 0; i < 19; i++) onError(new NetworkError("fetch failed"));
        assert.strictEqual(warns.length, 1, `v2: 19 identical errors should log once, got ${warns.length}`);
        assert.ok(warns[0].includes("transient") && warns[0].includes("fetch failed"), `v2: unexpected line: ${warns[0]}`);

        onError(new TelegramApiError(502, "Bad Gateway"));
        assert.ok(warns[1].includes("18 more"), `v2: expected collapsed count, got: ${warns[1]}`);
        assert.strictEqual(warns.length, 3, "v2: the different error must be logged after the count");
        assert.ok(warns[2].includes("502"), "v2: the 502 must not be swallowed by deduplication");

        // Same message, different class: still a distinct error.
        onError(new NetworkError("same text"));
        onError(new Error("same text"));
        assert.strictEqual(warns.length, 3 + 2, "v2: same message with a different class must still log");
        assert.strictEqual(errors.length, 0, "v2: transient errors must never use console.error");
    } finally {
        console.warn = realWarn;
        console.error = realError;
    }

    console.log("[OK] transient errors warn, repeats collapse, distinct errors still surface (v1 + v2).");
}

run();
