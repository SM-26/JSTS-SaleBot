import type { Context, Middleware } from "node-telegram-bot-api";

export interface ParsedCommand {
    name: string;
    args: string;
}

const COMMAND_RE = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/;

/**
 * Anchored, case-insensitive command parser. The `@botname` suffix must be absent
 * or equal to our own username, so commands aimed at another bot in a group are ignored.
 */
export function parseCommand(text: string, botUsername: string): ParsedCommand | null {
    const m = COMMAND_RE.exec(text);
    if (!m) return null;
    if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
    return { name: m[1].toLowerCase(), args: (m[3] ?? "").trim() };
}

/**
 * Middleware that runs `handler` when the message text is one of `names` (exact name,
 * case-insensitive, so `/broadcast` never matches `/broadcastUsers`). The parsed
 * command is stored on `ctx.state.command`. `botUsername` is a getter because it is
 * resolved with getMe at startup.
 */
export function command(
    names: string | string[],
    botUsername: () => string,
    handler: Middleware<Context>
): Middleware<Context> {
    const wanted = (Array.isArray(names) ? names : [names]).map(n => n.toLowerCase());
    return (ctx, next) => {
        const text = ctx.message?.text;
        const parsed = text ? parseCommand(text, botUsername()) : null;
        if (!parsed || !wanted.includes(parsed.name)) return next();
        ctx.state.command = parsed;
        return handler(ctx, next);
    };
}
