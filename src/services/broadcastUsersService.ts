import TelegramBot from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";

export interface BroadcastFailure { userId: string; reason: string; }
export interface BroadcastReport { total: number; sent: number; failures: BroadcastFailure[]; }

const SEND_THROTTLE_MS = 50;

// Pure function: maps a failed sendMessage error to a short admin-facing
// reason. node-telegram-bot-api's TelegramError carries `.response.body`
// ({ error_code, description }); anything without that shape falls back to
// `.message` (mirrors postService.markSoldInGroup's error handling).
export function mapSendError(err: unknown): string {
    const response = (err as { response?: { body?: { error_code?: number; description?: string } } })?.response;
    const body = response?.body;
    const code = body?.error_code;
    const description = body?.description ?? (err as Error)?.message ?? "unknown error";

    if (code === 403) return "blocked the bot";
    if (code === 400 && /chat not found/i.test(description)) return "hasn't started the bot";
    if (code === 429) return "rate limited";
    return description;
}

// Pure function: splits a failure list into the itemized head and a remainder
// count, for the report's "…and N more" truncation.
export function truncateFailures(failures: BroadcastFailure[], limit = 30): { shown: BroadcastFailure[]; remainder: number } {
    return { shown: failures.slice(0, limit), remainder: Math.max(0, failures.length - limit) };
}

export class BroadcastUsersService {
    constructor(private bot: TelegramBot) { }

    // Merge active-session ids with pending/approved post authors, de-dupe,
    // drop excludeId (the initiating admin).
    async resolveAudience(activeIds: string[], excludeId: string): Promise<string[]> {
        const [pendingIds, approvedIds] = await Promise.all([
            postRepository.distinctUserIdsByStatus("pending"),
            postRepository.distinctUserIdsByStatus("approved"),
        ]);

        const ids = new Set([...activeIds, ...pendingIds, ...approvedIds]);
        ids.delete(excludeId);
        return Array.from(ids);
    }

    // Throttled sequential fan-out. Never aborts on a single failure.
    // ponytail: fixed 50ms throttle; batch/parallelize only if audience grows large
    async sendToMany(userIds: string[], htmlMessage: string): Promise<BroadcastReport> {
        const failures: BroadcastFailure[] = [];
        let sent = 0;

        for (const userId of userIds) {
            try {
                await this.bot.sendMessage(Number(userId), htmlMessage, { parse_mode: "HTML" });
                sent++;
            } catch (err) {
                failures.push({ userId, reason: mapSendError(err) });
            }
            await new Promise(resolve => setTimeout(resolve, SEND_THROTTLE_MS));
        }

        return { total: userIds.length, sent, failures };
    }
}
