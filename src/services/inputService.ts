import type { Api } from "node-telegram-bot-api";
import type { Message, InlineKeyboardMarkup } from "node-telegram-bot-api/types";
import { BotConfig } from "../types";
import { localeService } from "./localeService";

// Position within the /newPost wizard, appended to the prompt as plain text.
export interface WizardStep {
    locale: string;
    index: number;
    total: number;
}

// Accepts thousands separators: "2,000" and "2 000" mean the same as "2000". NaN when it is not a number.
export function priceNumber(priceInput: string): number {
    const trimmed = priceInput.replace(/[,\s]/g, "");
    return trimmed === "" ? NaN : Number(trimmed);
}

// The stateless half of the wizard: sending prompts and validating one answer.
// The step machine that decides what to ask next lives in WizardService.
export class InputService {
    constructor(
        private api: Api,
        private config: BotConfig
    ) { }

    stepText(step: WizardStep): string {
        return localeService.t(step.locale, 'wizardStep', { step: step.index, total: step.total });
    }

    sendPrompt(chatId: number, prompt: string, step?: WizardStep, replyMarkup?: InlineKeyboardMarkup): Promise<Message> {
        const text = step ? `${prompt}\n\n${this.stepText(step)}` : prompt;

        return this.api.sendMessage({
            chat_id: chatId,
            text,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
    }

    validatePriceValue(priceInput: string): boolean {
        if (!this.config.validatePrice) return true;
        const price = priceNumber(priceInput);
        return !isNaN(price) && price > 0;
    }
}
