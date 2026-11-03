import { TelegramBotError } from "node-telegram-bot-api";

// Telegram outages (5xx) and network blips are routine for a long-running
// poller: the library retries by itself and recovers, so these are warnings,
// not errors. Without collapsing, a single Telegram outage on 2026-08-24
// produced 19 identical lines in 7 seconds, which is why issue #48 reads as
// if something is badly broken.

// Remembers the previous error key and turns consecutive repeats into one
// "...and N more" line. Returns true when the caller should log this error
// (it differs from the previous one).
function createCollapser(): (key: string) => boolean {
    let lastKey = "";
    let repeats = 0;

    return (key) => {
        if (key === lastKey) {
            repeats++;
            return false;
        }

        if (repeats > 0) {
            console.warn(`[polling_error] ...and ${repeats} more like the previous line`);
        }
        lastKey = key;
        repeats = 0;
        return true;
    };
}

/**
 * `LongPollOptions.onError`. The library only calls it for transient errors
 * (network / timeout / 5xx / 429 / 409 retries); fatal ones stop the loop and
 * are logged by `run()`, so everything here is a warning.
 */
export function createPollErrorLogger(): (err: unknown) => void {
    const shouldLog = createCollapser();

    return (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const name = err instanceof Error ? err.constructor.name : typeof err;
        const code = err instanceof TelegramBotError ? err.code : "unknown";

        if (!shouldLog(`${name}|${code}|${message}`)) return;
        console.warn(`[polling_error] transient, polling will retry: ${message}`);
    };
}
