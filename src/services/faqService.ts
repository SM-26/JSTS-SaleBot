import TelegramBot from "node-telegram-bot-api";
import { BotConfig } from "../types";
import { localeService } from "./localeService";
import userRepository from "../repositories/userRepository";
import { UserService } from "./userService";

export class FaqService {
    private userService: UserService;

    constructor(
        private bot: TelegramBot,
        private config: BotConfig
    ) {
        this.userService = new UserService();
    }

    async handleFaq(msg: TelegramBot.Message): Promise<void> {
        try {
            await this.userService.ensureUser(msg.from!);
            const user = await userRepository.findByUserId(String(msg.from!.id));
            const locale = localeService.resolveUserLocale(user);
            await this.renderNode(msg.chat.id, locale, null);
        } catch (err) {
            console.error("[ERROR - FaqService.handleFaq]", (err as Error).message);
            await this.bot.sendMessage(msg.chat.id, localeService.t(this.config.lang, 'generalError'));
        }
    }

    async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const nodeId = query.data?.replace("faq_", "");
        if (!nodeId || !query.message) return;

        const user = await userRepository.findByUserId(String(query.from.id));
        const locale = localeService.resolveUserLocale(user);

        const targetNode = nodeId === "root" ? null : nodeId;

        await this.renderNode(query.message.chat.id, locale, targetNode, query.message.message_id);
        await this.bot.answerCallbackQuery(query.id);
    }

    private async renderNode(chatId: number, locale: string, nodeId: string | null, messageId?: number): Promise<void> {
        const faqs = localeService.getFaqs(locale);
        if (!faqs || Object.keys(faqs).length === 0) {
            await this.bot.sendMessage(chatId, localeService.t(locale, 'faqNotAvailable'));
            return;
        }

        const keys = Object.keys(faqs);
        const children = keys.filter(k => {
            if (!nodeId) return !k.includes('.'); // Top level
            return k.startsWith(nodeId + '.') && k.split('.').length === nodeId.split('.').length + 1;
        });

        const baseText = nodeId ? `<b>${faqs[nodeId]}</b>` : `<b>${localeService.t(locale, 'helpFaq')}</b>`;
        const bodyParts: string[] = [];
        const buttons: TelegramBot.InlineKeyboardButton[][] = [];

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

        const text = [baseText, ...bodyParts].join('\n\n');

        // Add Back button
        if (nodeId) {
            const parentId = nodeId.includes('.')
                ? nodeId.substring(0, nodeId.lastIndexOf('.'))
                : "root";
            buttons.push([{ text: localeService.t(locale, 'backButton'), callback_data: `faq_${parentId}` }]);
        }

        const options: TelegramBot.SendMessageOptions & TelegramBot.EditMessageTextOptions = {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons }
        };

        if (messageId) {
            await this.bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...options
            } as TelegramBot.EditMessageTextOptions);
        } else {
            await this.bot.sendMessage(chatId, text, options);
        }
    }
}