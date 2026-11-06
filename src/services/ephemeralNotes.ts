import type { Api } from "node-telegram-bot-api";
import { TelegramApiError } from "node-telegram-bot-api";
import { isApiError } from "../config/telegramErrors";
import type { BotConfig } from "../types";
import type { Card } from "./listingCards";

// The only module that calls the ephemeral Bot API methods. Notes are private to the
// receiver inside the sale group; a failure here never throws into the caller.

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** sent: the note id. rejected: a definite API refusal, nothing went out. unknown: timeout or odd result, it may have gone out. public: it came out public (and was deleted). */
export type SendNoteResult = { kind: "sent"; id: number } | { kind: "rejected" | "unknown" | "public" };

export async function sendNote(api: Api, config: BotConfig, receiverUserId: number, card: Card): Promise<number | null> {
    const r = await sendNoteResult(api, config, receiverUserId, card);
    return r.kind === "sent" ? r.id : null;
}

export async function sendNoteResult(api: Api, config: BotConfig, receiverUserId: number, card: Card): Promise<SendNoteResult> {
    try {
        const sent = await api.sendMessage({
            chat_id: config.approvedGroupId,
            text: card.text,
            ...(card.html ? { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } } : {}),
            reply_markup: { inline_keyboard: card.keyboard },
            ephemeral_message_parameters: { receiver_user_id: receiverUserId },
            ...(config.approvedTopicId && Number(config.approvedTopicId) !== 1 ? { message_thread_id: Number(config.approvedTopicId) } : {}),
        });
        if (typeof sent.ephemeral_message_id === "number") return { kind: "sent", id: sent.ephemeral_message_id };
        console.error("[ERROR - ephemeralNotes.send]", "no ephemeral_message_id in the response");
        if (typeof sent.message_id === "number") { // it came out as a public message: take it down at once
            console.error("[ERROR - ephemeralNotes.public]", "deleting the public message", sent.message_id);
            await api.deleteMessage({ chat_id: config.approvedGroupId, message_id: sent.message_id })
                .catch((err: unknown) => console.error("[ERROR - ephemeralNotes.public]", "delete failed:", describe(err)));
        }
        return { kind: typeof sent.message_id === "number" ? "public" : "unknown" };
    } catch (err) {
        console.error("[ERROR - ephemeralNotes.send]", describe(err));
        return { kind: err instanceof TelegramApiError ? "rejected" : "unknown" };
    }
}

export async function editNote(api: Api, chatId: number, receiverUserId: number, ephemeralMessageId: number, card: Card): Promise<boolean> {
    try {
        await api.editEphemeralMessageText({
            chat_id: chatId,
            receiver_user_id: receiverUserId,
            ephemeral_message_id: ephemeralMessageId,
            text: card.text,
            reply_markup: { inline_keyboard: card.keyboard },
        });
        return true;
    } catch (err) {
        if (isApiError(err, 400, "message is not modified")) return true;
        console.warn("[WARN - ephemeralNotes.edit]", describe(err));
        return false;
    }
}

export async function deleteNote(api: Api, chatId: number, receiverUserId: number, ephemeralMessageId: number): Promise<boolean> {
    try {
        await api.deleteEphemeralMessage({ chat_id: chatId, receiver_user_id: receiverUserId, ephemeral_message_id: ephemeralMessageId });
        return true;
    } catch (err) {
        console.warn("[WARN - ephemeralNotes.delete]", describe(err));
        return false;
    }
}
