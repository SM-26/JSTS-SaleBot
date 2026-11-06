import Capture, { ICapture, CaptureState } from "../models/Capture";
import type { IMediaItem, StoredEntity } from "../models/Post";
import { classify } from "../services/classifier";

export const FIXTURE_CHAT_ID = -1009990001;

export type SeedCaptureOptions = {
    senderId: string;
    chatId?: number;
    messageIds?: number[];
    text: string;
    media?: IMediaItem[];
    state?: CaptureState;
    note?: ICapture["note"];
    entities?: StoredEntity[];
    now?: Date;
};

// A classified capture straight through the model, for tests that start after the sweeper.
export function seedCapture(o: SeedCaptureOptions): Promise<ICapture> {
    const now = o.now ?? new Date();
    const media = o.media ?? [];
    const messageIds = o.messageIds ?? [1];
    const { tier, rules, parsed } = classify(o.text, media.length > 0);
    return Capture.create({
        chatId: o.chatId ?? FIXTURE_CHAT_ID,
        senderId: o.senderId,
        senderName: o.senderId,
        messageIds,
        parts: [{ messageId: messageIds[0], text: o.text, ...(o.entities ? { entities: o.entities } : {}) }],
        text: o.text,
        entities: o.entities,
        media,
        firstAt: now,
        lastAt: now,
        state: o.state ?? "classified",
        tier,
        rules,
        parsed,
        note: o.note,
    });
}
