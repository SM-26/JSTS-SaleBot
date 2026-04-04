import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";
import { BotConfig } from "../types";
import userRepository from "../repositories/userRepository";
import { localeService } from "./localeService";

const configPath = path.join(__dirname, "../../config.json");

export class AdminService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig
    ) { }

    private get lang() {
        return this.config.lang;
    }

    async handleConfig(msg: TelegramBot.Message, args: string): Promise<void> {
        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);

        const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
        if (!isAdmin) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
            return;
        }

        const parts = args.trim().split(/\s+/);

        // /config — show all settings
        if (!args.trim()) {
            await this.showConfig(msg.chat.id, locale);
            return;
        }

        // /config key value — update a setting
        if (parts.length >= 2) {
            const key = parts[0];
            const rawValue = parts.slice(1).join(" ");
            await this.updateConfig(msg.chat.id, key, rawValue, locale);
            return;
        }

        await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'configUsage'), { parse_mode: "HTML" });
    }

    private async showConfig(chatId: number, locale: string): Promise<void> {
        const lines = Object.entries(this.config).map(
            ([key, value]) => `<b>${key}</b>: <code>${value}</code>`
        );
        const text = `${localeService.t(locale, 'configTitle')}\n\n${lines.join("\n")}`;
        await this.bot.sendMessage(chatId, text, { parse_mode: "HTML" });
    }

    private async updateConfig(chatId: number, key: string, rawValue: string, locale: string): Promise<void> {
        if (!(key in this.config)) {
            await this.bot.sendMessage(chatId, localeService.t(locale, 'configKeyNotFound'));
            return;
        }

        const currentValue = this.config[key as keyof BotConfig];
        let parsed: string | number | boolean;

        if (typeof currentValue === "boolean") {
            if (rawValue === "true") parsed = true;
            else if (rawValue === "false") parsed = false;
            else {
                await this.bot.sendMessage(chatId, localeService.t(locale, 'configInvalidValue'));
                return;
            }
        } else if (typeof currentValue === "number") {
            parsed = Number(rawValue);
            if (isNaN(parsed)) {
                await this.bot.sendMessage(chatId, localeService.t(locale, 'configInvalidValue'));
                return;
            }
        } else {
            parsed = rawValue;
        }

        (this.config as any)[key] = parsed;

        // Persist to config.json
        fs.writeFileSync(configPath, JSON.stringify(this.config, null, 4), "utf-8");

        await this.bot.sendMessage(
            chatId,
            `${localeService.t(locale, 'configUpdated')}\n<b>${key}</b>: <code>${parsed}</code>`,
            { parse_mode: "HTML" }
        );
    }
}
