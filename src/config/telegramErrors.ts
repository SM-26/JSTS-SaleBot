import { TelegramApiError } from "node-telegram-bot-api";

/**
 * True for a real Bot API error with `errorCode` whose description contains
 * `fragment` (case-insensitive). Telegram has no machine-readable reason for
 * most 400s, so the description check stays, but only on a typed API error.
 */
export function isApiError(err: unknown, errorCode: number, fragment: string): err is TelegramApiError {
    return err instanceof TelegramApiError
        && err.errorCode === errorCode
        && err.description.toLowerCase().includes(fragment.toLowerCase());
}

/** Permanent: the user blocked the bot (403) or never started it (400 chat not found). Retrying never helps. */
export function isUnreachable(err: unknown): boolean {
    return isApiError(err, 403, "") || isApiError(err, 400, "chat not found");
}
