// Shared safety gates for everything that sends real Telegram traffic from tests.
export const TEST_BOT_ID_PREFIX = "9299714864:";

export function isTestBotToken(token: string | undefined): boolean {
    return !!token && token.startsWith(TEST_BOT_ID_PREFIX);
}

// The database name is the path of the URI; it must say "test" (and a URI with no db path is refused).
export function isTestDbUri(uri: string | undefined): boolean {
    // Not `new URL`: it rejects multi-host replica-set URIs (h1:1,h2:2).
    const m = /^mongodb(?:\+srv)?:\/\/[^/?]*\/([^?]*)/.exec(uri ?? "");
    return !!m && /test/i.test(m[1]);
}
