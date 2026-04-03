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

            const faqs = localeService.getFaqs(locale);
            if (!faqs || Object.keys(faqs).length === 0) {
                console.warn('[WARN - FaqService.handleFaq] No FAQs found for locale', { locale });
                await this.bot.sendMessage(msg.chat.id, "FAQ information not available for your language.");
                return;
            }

            let faqText = "<b>Airsoft FAQ</b>\n\n";
            for (const [key, value] of Object.entries(faqs)) {
                faqText += `<b>${key}</b>: ${value}\n\n`;
            }

            await this.bot.sendMessage(msg.chat.id, faqText, { parse_mode: "HTML" });
        } catch (err) {
            console.error("[ERROR - FaqService.handleFaq]", (err as Error).message);
            await this.bot.sendMessage(msg.chat.id, "Error loading FAQ. Please try again later.");
        }
    }
}
