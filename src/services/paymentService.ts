import type { Api } from "node-telegram-bot-api";
import type { PreCheckoutQuery, Message } from "node-telegram-bot-api/types";
import { BotConfig } from "../types";
import { localeService } from "./localeService";
import userRepository from "../repositories/userRepository";

export class PaymentService {
    constructor(
        private api: Api,
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
            await this.api.sendInvoice({
                chat_id: chatId,
                title,
                description,
                payload,
                provider_token: providerToken,
                currency,
                prices
            });
        } catch (err) {
            console.error("[PaymentService] Error sending invoice:", err);
        }
    }

    async handlePreCheckout(query: PreCheckoutQuery) {
        // Always approve pre-checkout for donations
        await this.api.answerPreCheckoutQuery({ pre_checkout_query_id: query.id, ok: true });
    }

    async handleSuccessfulPayment(msg: Message) {
        const payment = msg.successful_payment;

        if (!payment) return;

        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);

        const text = localeService.t(locale, 'donationSuccess').replace("{amount}", String(payment.total_amount));
        await this.api.sendMessage({ chat_id: msg.chat.id, text });
    }
}
