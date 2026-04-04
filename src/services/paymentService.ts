import TelegramBot from "node-telegram-bot-api";
import { BotConfig } from "../types";
import { localeService } from "./localeService";
import userRepository from "../repositories/userRepository";

export class PaymentService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig
    ) { }

    async sendDonationInvoice(chatId: number, amount: number) {
        const user = await userRepository.findByUserId(String(chatId));
        const locale = localeService.resolveUserLocale(user);
        const title = localeService.t(locale, 'donateInvoiceTitle');
        const description = localeService.t(locale, 'donateInvoiceDesc');
        const payload = JSON.stringify({ type: "donation", amount });
        const providerToken = ""; // Empty for Telegram Stars
        const currency = "XTR";
        const prices = [{ label: "Donation", amount: amount }]; // Amount in Stars

        try {
            await this.bot.sendInvoice(
                chatId,
                title,
                description,
                payload,
                providerToken,
                currency,
                prices
            );
        } catch (err) {
            console.error("[PaymentService] Error sending invoice:", err);
        }
    }

    async handlePreCheckout(query: TelegramBot.PreCheckoutQuery) {
        // Always approve pre-checkout for donations
        await this.bot.answerPreCheckoutQuery(query.id, true);
    }

    async handleSuccessfulPayment(msg: TelegramBot.Message) {
        const payment = msg.successful_payment;

        if (!payment) return;

        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);

        const text = localeService.t(locale, 'donationSuccess').replace("{amount}", String(payment.total_amount));
        await this.bot.sendMessage(msg.chat.id, text);
    }
}
