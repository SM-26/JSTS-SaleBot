import Capture, { ICapture, ICapturePart } from "../models/Capture";
import type { IMediaItem, StoredEntity } from "../models/Post";
import type { Parsed, Tier } from "../services/classifier";

export type CaptureMessageInput = {
    chatId: number;
    senderId: string;
    senderName: string;
    messageId: number;
    text?: string;
    entities?: StoredEntity[];
    media: IMediaItem[];
    mediaGroupId?: string;
};

const WINDOW_MS = 90_000;
const QUIET_MS = 30_000;
const CLASSIFY_STALE_MS = 5 * 60_000; // a sweeper that died mid-classify releases its claim after this

// Pipeline-update stage that derives `text` (message-id order, joined by \n, so
// the first text is the head) and `entities` (the head's only) from `parts`.
// User values must go through $literal: a text starting with "$" would
// otherwise be read as a field path.
const REBUILD = {
    $set: {
        text: {
            $reduce: {
                input: "$parts",
                initialValue: "",
                in: { $cond: [{ $eq: ["$$value", ""] }, "$$this.text", { $concat: ["$$value", "\n", "$$this.text"] }] },
            },
        },
        entities: { $let: { vars: { head: { $arrayElemAt: ["$parts", 0] } }, in: "$$head.entities" } },
    },
};

const sortedParts = (parts: unknown) => ({ $sortArray: { input: parts, sortBy: { messageId: 1 } } });

const isDuplicateKey = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;

class CaptureRepository {
    // Adds a message to the sender's open window, or starts a new one. Album
    // items arrive concurrently: the unique open-window index makes the losers
    // of the insert race retry into the winner's capture.
    async appendMessage(input: CaptureMessageInput, now: Date): Promise<ICapture> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const open = await Capture.findOne({ chatId: input.chatId, senderId: input.senderId, state: "open" }).exec();
            if (open) {
                const inWindow = now.getTime() - open.firstAt.getTime() <= WINDOW_MS
                    || (input.mediaGroupId !== undefined && open.mediaGroupIds.includes(input.mediaGroupId));
                if (inWindow) {
                    const updated = await this.pushInto(String(open._id), input, now);
                    if (updated) return updated;
                    continue; // claimed by the sweeper between read and write: re-read
                }
                await Capture.updateOne({ _id: open._id, state: "open" }, { $set: { state: "closed" } }).exec();
            }
            try {
                return await Capture.create({
                    chatId: input.chatId,
                    senderId: input.senderId,
                    senderName: input.senderName,
                    messageIds: [input.messageId],
                    mediaGroupIds: input.mediaGroupId ? [input.mediaGroupId] : [],
                    parts: input.text ? [{ messageId: input.messageId, text: input.text, entities: input.entities?.length ? input.entities : undefined }] : [],
                    text: input.text ?? "",
                    entities: input.text && input.entities?.length ? input.entities : undefined,
                    media: input.media,
                    firstAt: now,
                    lastAt: now,
                    state: "open",
                });
            } catch (err) {
                if (!isDuplicateKey(err)) throw err; // else a concurrent item opened the window: retry
            }
        }
        throw new Error("captureRepository.appendMessage: could not settle after retry");
    }

    private pushInto(id: string, input: CaptureMessageInput, now: Date) {
        const part: ICapturePart[] = input.text
            ? [{ messageId: input.messageId, text: input.text, ...(input.entities?.length ? { entities: input.entities } : {}) }]
            : [];
        return Capture.findOneAndUpdate({ _id: id, state: "open" }, [
            {
                $set: {
                    messageIds: { $concatArrays: ["$messageIds", [input.messageId]] },
                    media: { $concatArrays: ["$media", { $literal: input.media }] },
                    mediaGroupIds: input.mediaGroupId ? { $setUnion: ["$mediaGroupIds", [input.mediaGroupId]] } : "$mediaGroupIds",
                    parts: sortedParts({ $concatArrays: ["$parts", { $literal: part }] }),
                    senderName: input.senderName,
                    lastAt: now,
                },
            },
            REBUILD,
        ], { returnDocument: "after", updatePipeline: true }).exec();
    }

    // Sweeper step 1: close one window that went quiet (30 s) or hit the cap (90 s).
    claimDue(now: Date): Promise<ICapture | null> {
        return Capture.findOneAndUpdate(
            {
                state: "open",
                $or: [{ lastAt: { $lte: new Date(now.getTime() - QUIET_MS) } }, { firstAt: { $lte: new Date(now.getTime() - WINDOW_MS) } }],
            },
            { $set: { state: "closed" } },
            { sort: { lastAt: 1 }, returnDocument: "after" }
        ).exec();
    }

    // Sweeper step 2: one closed capture nobody has classified. `classifyingAt` keeps two sweepers apart.
    claimClosed(): Promise<ICapture | null> {
        const now = Date.now();
        return Capture.findOneAndUpdate(
            {
                state: "closed",
                tier: { $exists: false },
                $or: [{ classifyingAt: { $exists: false } }, { classifyingAt: { $lt: new Date(now - CLASSIFY_STALE_MS) } }],
            },
            { $set: { classifyingAt: new Date(now) } },
            { sort: { lastAt: 1 }, returnDocument: "after" }
        ).exec();
    }

    async saveClassification(id: string, tier: Tier, rules: string[], parsed: Parsed): Promise<void> {
        await Capture.updateOne({ _id: id }, { $set: { state: "classified", tier, rules, parsed }, $unset: { classifyingAt: 1 } }).exec();
    }

    // An edit replaces that message's text in the still-open window; an empty text removes it.
    reparseOpen(chatId: number, messageId: number, text: string, entities?: StoredEntity[]): Promise<ICapture | null> {
        const part: ICapturePart[] = text ? [{ messageId, text, ...(entities?.length ? { entities } : {}) }] : [];
        return Capture.findOneAndUpdate({ chatId, state: "open", messageIds: messageId }, [
            {
                $set: {
                    parts: sortedParts({
                        $concatArrays: [{ $filter: { input: "$parts", cond: { $ne: ["$$this.messageId", messageId] } } }, { $literal: part }],
                    }),
                },
            },
            REBUILD,
        ], { returnDocument: "after", updatePipeline: true }).exec();
    }
}

export default new CaptureRepository();
