type PollingError = Error & { code?: string };

// Telegram outages (5xx) and network blips are routine for a long-running
// poller: the library retries by itself and recovers, so these are warnings,
// not errors. Without a listener the library logs each one at error level --
// a single Telegram outage on 2026-08-24 produced 19 identical lines in 7
// seconds, which is why issue #48 reads as if something is badly broken.
const TRANSIENT_CODES = ["EFATAL", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"];

// Matches the library's "ETELEGRAM: 502 Bad Gateway" shape.
const SERVER_ERROR = /: 5[0-9][0-9]/;

export function isTransient(err: PollingError): boolean {
    return TRANSIENT_CODES.includes(err.code ?? "") || SERVER_ERROR.test(err.message ?? "");
}

// Minimal emitter shape, so this can be exercised without a live bot.
interface PollingEmitter {
    on(event: "polling_error", listener: (err: PollingError) => void): unknown;
}

/**
 * Logs polling failures, collapsing consecutive repeats of the same failure
 * into a single count so one outage is a couple of lines instead of dozens.
 */
export function registerPollingErrorHandler(bot: PollingEmitter): void {
    let lastKey = "";
    let repeats = 0;

    bot.on("polling_error", (err) => {
        const message = err.message ?? String(err);
        const key = `${err.code ?? "unknown"}|${message}`;

        if (key === lastKey) {
            repeats++;
            return;
        }

        if (repeats > 0) {
            console.warn(`[polling_error] ...and ${repeats} more like the previous line`);
        }
        lastKey = key;
        repeats = 0;

        if (isTransient(err)) {
            console.warn(`[polling_error] transient, polling will retry: ${message}`);
        } else {
            console.error(`[polling_error] ${message}`);
        }
    });
}
