import { Bot } from "tgv2";
import type { Update } from "tgv2/types";

export interface RecordedCall {
    method: string;
    params: Record<string, unknown>;
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
}

export interface PressButtonOptions {
    chatId?: number;
    userId?: number;
    messageId?: number;
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

/** Offline bot: a tgv2 Bot whose fetch records every API call and never touches Telegram. */
export function createHarness(options: HarnessOptions = {}) {
    const calls: RecordedCall[] = [];
    let nextMessageId = 100;
    let nextUpdateId = 1;

    const fakeFetch: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = url.split("/").pop()!.split("?")[0];
        const params = await decodeBody(init?.body);
        calls.push({ method, params });

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

    const sendText = (text: string, { chatId, userId = 42, chatType = "private" }: SendTextOptions = {}) => {
        const chat = chatId ?? userId;
        return send({
            message: {
                message_id: nextMessageId++,
                date: Math.floor(Date.now() / 1000),
                chat: { id: chat, type: chatType },
                from: { id: userId, is_bot: false, first_name: "Tester" },
                text
            }
        });
    };

    const pressButton = (data: string, { chatId, userId = 42, messageId = 7 }: PressButtonOptions = {}) => {
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
                    chat: { id: chat, type: "private" }
                }
            }
        });
    };

    return { bot, calls, send, sendText, pressButton };
}
