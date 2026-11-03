import type { Context, Middleware } from "node-telegram-bot-api";
import type { User } from "node-telegram-bot-api/types";
import { AuthLevel } from "../types";

/** Per-user-per-chat session key; undefined when the update has no chat or no user. */
export function sessionKey(ctx: Context): string | undefined {
    const chat = ctx.chat;
    const from = ctx.from;
    return chat && from ? `${chat.id}:${from.id}` : undefined;
}

/**
 * Ensures a user record exists for private-chat messages and callback queries
 * (never for group messages). A failure is logged and never blocks the update.
 */
export function ensureUserMiddleware(ensureUser: (from: User) => Promise<void>): Middleware<Context> {
    return async (ctx, next) => {
        const isPrivateMessage = ctx.message?.chat.type === "private";
        if (ctx.from && (isPrivateMessage || ctx.callbackQuery)) {
            try {
                await ensureUser(ctx.from);
            } catch (error) {
                console.error("[ERROR - ensureUser]", error);
            }
        }
        await next();
    };
}

/** Wraps a handler so it only runs for users at `level` or above; otherwise calls `onDenied`. */
export function requireAuthLevel(
    level: AuthLevel,
    getLevel: (userId: string) => Promise<AuthLevel>,
    onDenied: (ctx: Context) => Promise<unknown>
): (handler: Middleware<Context>) => Middleware<Context> {
    return handler => async (ctx, next) => {
        const userId = ctx.from?.id;
        if (userId === undefined || (await getLevel(String(userId))) < level) {
            await onDenied(ctx);
            return;
        }
        return handler(ctx, next);
    };
}

/** For `bot.catch`: log, stop a callback spinner, never rethrow (that would stop polling). */
export async function errorBoundary(err: unknown, ctx: Context): Promise<void> {
    console.error(`[ERROR - update ${ctx.update.update_id}]`, err);
    if (ctx.callbackQuery) {
        try {
            await ctx.answerCallbackQuery();
        } catch {
            // best effort: the query may be too old or already answered
        }
    }
}

const STALE_PREFIXES = ["confirm_", "cancel_", "done_media_", "skip_reason_", "draft_"];

/**
 * Register LAST: wizard/prompt buttons nobody handled belong to a flow that is gone.
 * `toastText` returns the presser's localized "staleButton" string; the caller does
 * the locale lookup, so this module (and its tests) don't need config.json.
 */
export function staleButtonCatchAll(toastText: (ctx: Context) => Promise<string>): Middleware<Context> {
    return async (ctx, next) => {
        const query = ctx.callbackQuery;
        if (!query?.data || !STALE_PREFIXES.some(p => query.data!.startsWith(p))) return next();

        await ctx.answerCallbackQuery({ text: await toastText(ctx) });
        const msg = query.message;
        if (!msg) return;
        try {
            await ctx.api.editMessageReplyMarkup({
                chat_id: msg.chat.id,
                message_id: msg.message_id,
                reply_markup: { inline_keyboard: [] }
            });
        } catch (error) {
            if (!String(error).includes("message is not modified")) {
                console.error("[ERROR - staleButtonCatchAll]", error);
            }
        }
    };
}
