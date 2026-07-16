import TelegramBot, { Message, CallbackQuery } from "node-telegram-bot-api";
import { BotConfig, MediaItem } from "../types";
import { localeService } from "./localeService";

export class InputService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig
    ) { }

    input(msg: Message): Promise<string> {
        return new Promise((resolve) => {
            const listener = (reply: Message) => {
                if (reply.chat.id !== msg.chat.id || reply.from!.id !== msg.from!.id) return;
                if (reply.text && reply.text.startsWith("/")) return;

                this.bot.removeListener("message", listener);
                resolve(reply.text || "");
            };

            this.bot.on("message", listener);
        });
    }

    async inputWithPrompt(msg: Message, prompt: string): Promise<string> {
        await this.bot.sendMessage(msg.chat.id, prompt, { message_thread_id: msg.message_thread_id });
        return this.input(msg);
    }

    validatePriceValue(priceInput: string): boolean {
        if (!this.config.validatePrice) return true;
        const price = Number(priceInput);
        return !isNaN(price) && price > 0;
    }

    async inputPrice(msg: Message, locale: string): Promise<string> {
        await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'enterPrice'), { message_thread_id: msg.message_thread_id });

        while (true) {
            const priceInput = await this.input(msg); if (this.validatePriceValue(priceInput)) return priceInput;
            this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'invalidPrice'), { message_thread_id: msg.message_thread_id });
        }
    }

    inputMedia(msg: Message): Promise<MediaItem[]> {
        const items: MediaItem[] = [];
        const doneCallbackData = `done_media_${msg.from!.id}`;

        return new Promise((resolve) => {
            const cbListener = (query: CallbackQuery) => {
                if (query.data !== doneCallbackData) return;
                if (query.from.id !== msg.from!.id) return;

                this.bot.removeListener("message", msgListener);
                this.bot.removeListener("callback_query", cbListener);
                this.bot.answerCallbackQuery(query.id);

                if (query.message) {
                    this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                }

                resolve(items);
            };

            const msgListener = (reply: Message) => {
                if (reply.chat.id !== msg.chat.id || reply.from!.id !== msg.from!.id) return;

                if (reply.photo && reply.photo.length > 0) {
                    const fileId = reply.photo[reply.photo.length - 1].file_id;
                    items.push({ fileId, type: "photo" });
                } else if (reply.video) {
                    items.push({ fileId: reply.video.file_id, type: "video" });
                }
            };

            this.bot.on("callback_query", cbListener);
            this.bot.on("message", msgListener);
        });
    }

    async promptMedia(msg: Message, locale: string): Promise<MediaItem[]> {
        const mediaPromise = this.inputMedia(msg);

        await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'enterMedia'), {
            message_thread_id: msg.message_thread_id,
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(locale, 'doneMediaButton'), callback_data: `done_media_${msg.from!.id}` },
                ]],
            },
        });

        return mediaPromise;
    }

    async confirmAction(msg: Message, locale: string): Promise<boolean> {
        const callbackId = `confirm_${msg.from!.id}_${Date.now()}`;
        const cancelId = `cancel_${msg.from!.id}_${Date.now()}`;

        const sentMsg = await this.bot.sendMessage(msg.chat.id, "👆", {
            message_thread_id: msg.message_thread_id,
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(locale, 'confirmButton'), callback_data: callbackId },
                    { text: localeService.t(locale, 'cancelButton'), callback_data: cancelId },
                ]],
            },
        });

        return new Promise((resolve) => {
            const listener = (query: CallbackQuery) => {
                if (query.from.id !== msg.from!.id) return;
                if (query.data !== callbackId && query.data !== cancelId) return;

                this.bot.removeListener("callback_query", listener);
                this.bot.answerCallbackQuery(query.id);
                this.bot.editMessageReplyMarkup(
                    { inline_keyboard: [] },
                    { chat_id: msg.chat.id, message_id: sentMsg.message_id }
                );

                resolve(query.data === callbackId);
            };

            this.bot.on("callback_query", listener);
        });
    }
}
