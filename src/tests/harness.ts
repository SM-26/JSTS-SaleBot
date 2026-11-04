import { Bot } from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api/types";

export interface RecordedCall {
    method: string;
    params: Record<string, unknown>;
    /** What the fake Telegram answered (e.g. the sent message, for its message_id). */
    result?: unknown;
}

type ResponseFn = (params: Record<string, unknown>) => unknown;

export interface HarnessOptions {
    /** Override the result for a method: a value or a function of the request params. */
    responses?: Record<string, unknown | ResponseFn>;
}

export interface SendTextOptions {
    chatId?: number;
    userId?: number;
    chatType?: "private" | "group" | "supergroup";
    /** Makes the message a reply to this message id (in the same chat). */
    replyToMessageId?: number;
    /** Telegram message entities (formatting) of the text. */
    entities?: Record<string, unknown>[];
    /** Forum topic id (`message_thread_id`); omitted by default, like General/topic 1. */
    messageThreadId?: number;
    /** Marks the sender as a bot. */
    isBot?: boolean;
    mediaGroupId?: string;
    caption?: string;
    senderChat?: Record<string, unknown>;
    forwardOrigin?: Record<string, unknown>;
    /** Fixed message id, so an edit can target a message sent earlier. */
    messageId?: number;
}

export interface PressButtonOptions {
    chatId?: number;
    userId?: number;
    messageId?: number;
    chatType?: "private" | "group" | "supergroup";
}

export const BOT_USERNAME = "JSTS_testing_bot";

/** v2 sends form-encoded bodies; nested values are JSON strings. */
async function decodeBody(body: RequestInit["body"]): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (body == null) return params;
    // the body may be a string, bytes or a stream depending on the payload
    const text = await new Response(body).text();
    for (const [key, value] of new URLSearchParams(text)) {
        try {
            params[key] = /^[[{]/.test(value) ? JSON.parse(value) : value;
        } catch {
            params[key] = value;
        }
    }
    return params;
}

/** Offline bot: a node-telegram-bot-api Bot whose fetch records every API call and never touches Telegram. */
export function createHarness(options: HarnessOptions = {}) {
    const calls: RecordedCall[] = [];
    let nextMessageId = 100;
    let nextUpdateId = 1;

    const fakeFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.split("/").pop()!.split("?")[0];
        const params = await decodeBody(init?.body);
        const call: RecordedCall = { method, params };
        calls.push(call);

        let result: unknown = true;
        const override = options.responses?.[method];
        if (override !== undefined) {
            result = typeof override === "function" ? (override as ResponseFn)(params) : override;
        } else if (method === "getMe") {
            result = { id: 1000, is_bot: true, first_name: "Test", username: BOT_USERNAME };
        } else if (["sendMessage", "sendRichMessage", "sendPhoto"].includes(method)) {
            result = {
                message_id: nextMessageId++,
                chat: { id: Number(params.chat_id), type: "private" },
                date: Math.floor(Date.now() / 1000)
            };
        }
        call.result = result;
        // an override shaped like { ok: false, ... } is returned as a Telegram error envelope
        const failure = typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
        return new Response(JSON.stringify(failure ? result : { ok: true, result }), {
            status: 200,
            headers: { "content-type": "application/json" }
        });
    };

    const bot = new Bot("123:TEST", { fetch: fakeFetch });

    const send = (update: Record<string, unknown>) =>
        bot.handleUpdate({ update_id: nextUpdateId++, ...update } as Update);

    const buildMessage = (content: Record<string, unknown>, o: SendTextOptions, id: number) => {
        const { chatId, userId = 42, chatType = "private", replyToMessageId } = o;
        const chat = chatId ?? userId;
        return {
            message_id: id,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chat, type: chatType },
            from: { id: userId, is_bot: o.isBot ?? false, first_name: "Tester" },
            ...(o.messageThreadId === undefined ? {} : { message_thread_id: o.messageThreadId }),
            ...(o.mediaGroupId === undefined ? {} : { media_group_id: o.mediaGroupId }),
            ...(o.caption === undefined ? {} : { caption: o.caption }),
            ...(o.senderChat === undefined ? {} : { sender_chat: o.senderChat }),
            ...(o.forwardOrigin === undefined ? {} : { forward_origin: o.forwardOrigin }),
            ...content,
            ...(replyToMessageId === undefined ? {} : {
                reply_to_message: { message_id: replyToMessageId, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: chatType } }
            })
        };
    };

    const message = (content: Record<string, unknown>, options: SendTextOptions = {}) =>
        send({ message: buildMessage(content, options, options.messageId ?? nextMessageId++) });

    /** An `edited_message` update for an earlier message id. */
    const sendEdit = (messageId: number, text: string, options: SendTextOptions = {}) =>
        send({ edited_message: { ...buildMessage({ text }, options, messageId), edit_date: Math.floor(Date.now() / 1000) } });

    const sendText = (text: string, options: SendTextOptions = {}) => message({ text, ...(options.entities ? { entities: options.entities } : {}) }, options);

    /** One photo update (a single size, like each item of an album). */
    const sendPhoto = (fileId: string, options: SendTextOptions = {}) =>
        message({ photo: [{ file_id: fileId, file_unique_id: fileId, width: 10, height: 10 }] }, options);

    const pressButton = (data: string, { chatId, userId = 42, messageId = 7, chatType = "private" }: PressButtonOptions = {}) => {
        const chat = chatId ?? userId;
        return send({
            callback_query: {
                id: `cb${nextUpdateId}`,
                chat_instance: "ci",
                from: { id: userId, is_bot: false, first_name: "Tester" },
                data,
                message: {
                    message_id: messageId,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: chat, type: chatType }
                }
            }
        });
    };

    return { bot, calls, send, message, sendText, sendPhoto, sendEdit, pressButton };
}
