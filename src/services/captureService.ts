import type { Message, MessageEntity } from "node-telegram-bot-api/types";
import { BotConfig } from "../types";
import { storedEntity } from "../models/Post";
import type { IMediaItem, StoredEntity } from "../models/Post";
import captureRepository from "../repositories/captureRepository";
import memberRepository from "../repositories/memberRepository";

const storedEntities = (entities?: MessageEntity[]): StoredEntity[] | undefined =>
    entities?.length ? entities.map(storedEntity) : undefined;

// The one place that says when capture runs (unset or "off" = no capture).
export const isCaptureOn = (config: BotConfig): boolean => config.captureMode === "shadow" || config.captureMode === "optin";

// Records sale-topic messages into per-sender windows. Never sends anything.
export class CaptureService {
    constructor(private config: BotConfig) {}

    isSaleTopicMessage(msg: Message): boolean {
        if (msg.chat.id !== this.config.approvedGroupId) return false;
        const topic = Number(this.config.approvedTopicId);
        // outside a real forum topic message_thread_id is a reply-thread id, not a topic: treat it as General
        const thread = msg.is_topic_message ? msg.message_thread_id : undefined;
        // prod's topic 1 is the General topic: its messages carry no message_thread_id
        if (topic === 1 ? thread !== undefined && thread !== 1 : thread !== topic) return false;
        if (!msg.from || msg.from.is_bot || msg.sender_chat || msg.forward_origin) return false;
        // in a real forum topic Telegram sets reply_to_message to the topic's root message
        if (msg.reply_to_message && !(msg.is_topic_message && msg.reply_to_message.message_id === thread)) return false;
        if (msg.text?.startsWith("/")) return false;
        return Boolean(msg.text || msg.caption || msg.photo || msg.video);
    }

    async handleGroupMessage(msg: Message, now = new Date()): Promise<void> {
        try {
            const from = msg.from!;
            const senderId = String(from.id);
            const media: IMediaItem[] = msg.photo?.length
                ? [{ fileId: msg.photo[msg.photo.length - 1].file_id, type: "photo" }]
                : msg.video ? [{ fileId: msg.video.file_id, type: "video" }] : [];
            await memberRepository.touch(senderId, now);
            await captureRepository.appendMessage({
                chatId: msg.chat.id,
                senderId,
                senderName: [from.first_name, from.last_name].filter(Boolean).join(" "),
                messageId: msg.message_id,
                text: msg.text ?? msg.caption,
                entities: storedEntities(msg.text !== undefined ? msg.entities : msg.caption_entities),
                media,
                mediaGroupId: msg.media_group_id,
            }, now);
        } catch (err) {
            console.error("[ERROR - capture]", err);
        }
    }

    async handleEdit(msg: Message): Promise<void> {
        try {
            const text = msg.text ?? msg.caption ?? "";
            await captureRepository.reparseOpen(msg.chat.id, msg.message_id, text,
                storedEntities(msg.text !== undefined ? msg.entities : msg.caption_entities));
        } catch (err) {
            console.error("[ERROR - capture]", err);
        }
    }
}
