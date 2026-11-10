import type { Api } from "node-telegram-bot-api";
import type { Message, CallbackQuery, InlineKeyboardButton } from "node-telegram-bot-api/types";
import { BotConfig } from "../types";
import { localeService } from "./localeService";
import userRepository from "../repositories/userRepository";
import { buildFaqWidget } from "./faqWidget";

// A button is as wide as its bubble: one line of invisible braille blanks (not whitespace, so Telegram keeps it) widens every FAQ message.
export const FAQ_PADDING = "\n" + "\u2800".repeat(30);

export class FaqService {
    constructor(
        private api: Api,
        private config: BotConfig
    ) { }

    async handleFaq(msg: Message): Promise<void> {
        try {
            const user = await userRepository.findByUserId(String(msg.from!.id));
            const locale = localeService.resolveUserLocale(user);
            await this.renderNode(msg.chat.id, locale, null);
        } catch (err) {
            console.error("[ERROR - FaqService.handleFaq]", (err as Error).message);
            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'generalError') });
        }
    }

    // One FAQ node as a new message (the start=faq_1 deep link from a meeting-point button).
    async showNode(msg: Message, nodeId: string): Promise<void> {
        try {
            const user = await userRepository.findByUserId(String(msg.from!.id));
            await this.renderNode(msg.chat.id, localeService.resolveUserLocale(user), nodeId);
        } catch (err) {
            console.error("[ERROR - FaqService.showNode]", (err as Error).message);
            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'generalError') });
        }
    }

    async handleCallback(query: CallbackQuery): Promise<void> {
        const nodeId = query.data?.replace("faq_", "");
        if (!nodeId || !query.message) return;

        const user = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user);

        const targetNode = nodeId === "root" ? null : nodeId;

        // A press under a widget (its "text version" button) can't edit the widget: send the text FAQ as a new message.
        if ("widget" in query.message && query.message.widget) await this.renderNode(query.message.chat.id, locale, targetNode, undefined, true);
        else await this.renderNode(query.message.chat.id, locale, targetNode, query.message.message_id);
        await this.api.answerCallbackQuery({ callback_query_id: query.id });
    }

    private async renderNode(chatId: number, locale: string, nodeId: string | null, messageId?: number, asText = false): Promise<void> {
        const faqs = localeService.getFaqs(locale);
        if (!faqs || Object.keys(faqs).length === 0) {
            await this.api.sendMessage({ chat_id: chatId, text: localeService.t(locale, 'faqNotAvailable') });
            return;
        }
        if (!messageId && !asText && chatId > 0 && await this.sendWidget(chatId, locale, faqs, nodeId)) return;

        const keys = Object.keys(faqs);
        const children = keys.filter(k => {
            if (!nodeId) return !k.includes('.'); // Top level
            return k.startsWith(nodeId + '.') && k.split('.').length === nodeId.split('.').length + 1;
        });

        const baseText = nodeId ? `<b>${faqs[nodeId]}</b>` : `<b>${localeService.t(locale, 'helpFaq')}</b>`;
        const bodyParts: string[] = [];
        const buttons: InlineKeyboardButton[][] = [];

        for (const childKey of children) {
            const isBranch = keys.some(k => k.startsWith(childKey + '.'));

            if (isBranch) {
                const label = faqs[childKey].length > 30
                    ? faqs[childKey].substring(0, 27) + "..."
                    : faqs[childKey];
                buttons.push([{ text: label, callback_data: `faq_${childKey}` }]);
            } else {
                bodyParts.push(faqs[childKey]);
            }
        }

        const text = [baseText, ...bodyParts].join('\n\n') + FAQ_PADDING;

        // Add Back button
        if (nodeId) {
            const parentId = nodeId.includes('.')
                ? nodeId.substring(0, nodeId.lastIndexOf('.'))
                : "root";
            buttons.push([{ text: localeService.t(locale, 'backButton'), callback_data: `faq_${parentId}` }]);
        }

        const options = {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons }
        };

        if (messageId) {
            await this.api.editMessageText({
                chat_id: chatId,
                message_id: messageId,
                text,
                ...options
            });
        } else {
            await this.api.sendMessage({ chat_id: chatId, text, ...options });
        }
    }

    // Widgets work only in private chats in production. Any failure falls back to the text FAQ.
    private async sendWidget(chatId: number, locale: string, faqs: Record<string, string>, nodeId: string | null): Promise<boolean> {
        try {
            const title = localeService.t(locale, 'helpFaq').replace(/^\/faq\s*-\s*/, "");
            await this.api.sendWidget({
                chat_id: chatId,
                html: buildFaqWidget(faqs, title, locale === "he", nodeId ?? undefined),
                reply_markup: { inline_keyboard: [[{ text: localeService.t(locale, 'faqTextVersion'), callback_data: "faq_root" }]] },
            });
            return true;
        } catch (err) {
            console.error("[ERROR - FaqService.sendWidget]", (err as Error).message);
            return false;
        }
    }
}
