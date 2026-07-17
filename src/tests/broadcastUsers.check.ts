import assert from "assert";
import { mapSendError, truncateFailures, BroadcastFailure } from "../services/broadcastUsersService";

console.log("[INFO] Checking broadcastUsers pure functions...");

function fakeTelegramError(errorCode: number, description: string) {
    return {
        message: `${errorCode} ${description}`,
        response: { body: { error_code: errorCode, description } },
    };
}

// mapSendError
assert.strictEqual(mapSendError(fakeTelegramError(403, "Forbidden: bot was blocked by the user")), "blocked the bot");
assert.strictEqual(mapSendError(fakeTelegramError(400, "Bad Request: chat not found")), "hasn't started the bot");
assert.strictEqual(mapSendError(fakeTelegramError(429, "Too Many Requests: retry after 5")), "rate limited");
assert.strictEqual(mapSendError(fakeTelegramError(400, "Bad Request: message text is empty")), "Bad Request: message text is empty");
assert.strictEqual(mapSendError(new Error("Something else broke")), "Something else broke");
console.log("  [SUCCESS] mapSendError mapped all cases correctly.");

// truncateFailures
const fakeFailures: BroadcastFailure[] = Array.from({ length: 80 }, (_, i) => ({ userId: String(i), reason: "blocked the bot" }));
const { shown, remainder } = truncateFailures(fakeFailures);
assert.strictEqual(shown.length, 30);
assert.strictEqual(remainder, 50);
console.log("  [SUCCESS] truncateFailures itemizes 30 and reports 50 more.");

// truncateFailures with fewer failures than the limit
const small = truncateFailures(fakeFailures.slice(0, 5));
assert.strictEqual(small.shown.length, 5);
assert.strictEqual(small.remainder, 0);
console.log("  [SUCCESS] truncateFailures leaves no remainder under the limit.");

console.log("[SUCCESS] All broadcastUsers checks passed.");
