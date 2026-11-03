import assert from "assert";
import { NetworkError, TelegramApiError } from "node-telegram-bot-api";
import { createPollErrorLogger } from "../config/pollingErrors";

// Guards the polling-noise handling from issue #48: outages must log as
// warnings, repeats must collapse, and -- the dangerous failure mode -- the
// deduplication must never swallow a *different* error.
function run() {
    console.log("[INFO] Checking polling error handling...");

    const warns: string[] = [];
    const errors: string[] = [];
    const realWarn = console.warn;
    const realError = console.error;
    console.warn = (...args) => warns.push(args.join(" "));
    console.error = (...args) => errors.push(args.join(" "));

    try {
        // onError only sees transient errors, so everything is a warning.
        const onError = createPollErrorLogger();

        for (let i = 0; i < 19; i++) onError(new NetworkError("fetch failed"));
        assert.strictEqual(warns.length, 1, `19 identical errors should log once, got ${warns.length}`);
        assert.ok(warns[0].includes("transient") && warns[0].includes("fetch failed"), `unexpected line: ${warns[0]}`);

        onError(new TelegramApiError(502, "Bad Gateway"));
        assert.ok(warns[1].includes("18 more"), `expected collapsed count, got: ${warns[1]}`);
        assert.strictEqual(warns.length, 3, "the different error must be logged after the count");
        assert.ok(warns[2].includes("502"), "the 502 must not be swallowed by deduplication");

        // Same message, different class: still a distinct error.
        onError(new NetworkError("same text"));
        onError(new Error("same text"));
        assert.strictEqual(warns.length, 3 + 2, "same message with a different class must still log");
        assert.strictEqual(errors.length, 0, "transient errors must never use console.error");
    } finally {
        console.warn = realWarn;
        console.error = realError;
    }

    console.log("[OK] transient errors warn, repeats collapse, distinct errors still surface.");
}

run();
