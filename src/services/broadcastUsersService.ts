import type { Api } from "node-telegram-bot-api";
import { TelegramApiError } from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";

export interface BroadcastFailure { userId: string; reason: string; }
export interface BroadcastReport { total: number; sent: number; failures: BroadcastFailure[]; }

const SEND_THROTTLE_MS = 50;

// Pure function: maps a failed sendMessage error to a short admin-facing
// reason. A TelegramApiError carries `.errorCode` and `.description`; anything
// else falls back to `.message` (mirrors postService.markSoldInGroup's error handling).
export function mapSendError(err: unknown): string {
    const apiError = err instanceof TelegramApiError ? err : undefined;
    const code = apiError?.errorCode;
    const description = apiError?.description ?? (err as Error)?.message ?? "unknown error";

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
    constructor(private api: Api) { }

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
                await this.api.sendMessage({ chat_id: Number(userId), text: htmlMessage, parse_mode: "HTML" });
                sent++;
            } catch (err) {
                failures.push({ userId, reason: mapSendError(err) });
            }
            await new Promise(resolve => setTimeout(resolve, SEND_THROTTLE_MS));
        }

        return { total: userIds.length, sent, failures };
    }
}
