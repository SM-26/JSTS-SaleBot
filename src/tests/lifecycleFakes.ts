import type { Api } from "node-telegram-bot-api";
import { TelegramApiError } from "node-telegram-bot-api";
import type { InputRichMessage } from "node-telegram-bot-api/types";
import PostModel from "../models/Post";
import type { PostService } from "../services/postService";
import type { Post } from "../types";

export const T0 = new Date("2026-12-01T10:00:00Z");
/** T0 plus n days. */
export const plusDays = (n: number) => new Date(T0.getTime() + n * 24 * 3600 * 1000);

export interface FakeApi {
    api: Api;
    calls: { method: string; params: Record<string, unknown> }[];
    /** Make sendMessage to this chat reject: a real TelegramApiError (code given) or a plain Error (code omitted). */
    failSend(chatId: number, code?: number, description?: string): void;
}

/** Recording Api; any method resolves to a message-ish object unless failSend says otherwise. */
export function fakeApi(): FakeApi {
    const calls: FakeApi["calls"] = [];
    const failures = new Map<number, Error>();
    const api = new Proxy({}, {
        get: (_t, method: string) => async (params: Record<string, unknown> = {}) => {
            calls.push({ method, params });
            const failure = method === "sendMessage" ? failures.get(Number(params.chat_id)) : undefined;
            if (failure) throw failure;
            return { message_id: 1000 + calls.length };
        },
    }) as unknown as Api;
    return {
        api, calls,
        failSend: (chatId, code, description = "Forbidden: bot was blocked by the user") =>
            void failures.set(chatId, code === undefined ? new Error("network down") : new TelegramApiError(code, description)),
    };
}

/** Stub PostService: records markPostSold; set groupEdited:false to simulate a deleted group message. */
export function stubPostService() {
    const sold: Post[] = [];
    const stub = {
        groupEdited: true,
        sold,
        async markPostSold(post: Post): Promise<{ richMessage: InputRichMessage; groupEdited: boolean }> {
            sold.push(post);
            await PostModel.updateOne({ _id: String(post._id) }, { $set: { status: "sold" } });
            return { richMessage: {} as InputRichMessage, groupEdited: stub.groupEdited };
        },
    };
    return stub;
}
export const asPostService = (s: ReturnType<typeof stubPostService>) => s as unknown as PostService;

export function seedPost(userId: string, status: "approved" | "sold" | "pending" = "approved", createdAt: Date = T0) {
    return PostModel.create({
        userId, status, price: "10", title: "t", description: "d", location: "l", media: [], createdAt, approvedMessageId: 5,
    });
}
