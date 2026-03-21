import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";
import { BotConfig, Locals } from "../types";
import userRepository from "../repositories/userRepository";

const configPath = path.join(__dirname, "../../config.json");

export class AdminService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private locals: Locals
    ) {}

    private get lang() {
        return this.config.lang;
    }

    async handleConfig(msg: TelegramBot.Message, args: string): Promise<void> {
        const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
        if (!isAdmin) {
            await this.bot.sendMessage(msg.chat.id, this.locals[this.lang].notAdmin);
            return;
        }

        const parts = args.trim().split(/\s+/);

        // /config — show all settings
        if (!args.trim()) {
            await this.showConfig(msg.chat.id);
            return;
        }

        // /config key value — update a setting
        if (parts.length >= 2) {
            const key = parts[0];
            const rawValue = parts.slice(1).join(" ");
            await this.updateConfig(msg.chat.id, key, rawValue);
            return;
        }

        await this.bot.sendMessage(msg.chat.id, this.locals[this.lang].configUsage, { parse_mode: "HTML" });
    }

    private async showConfig(chatId: number): Promise<void> {
        const lines = Object.entries(this.config).map(
            ([key, value]) => `<b>${key}</b>: <code>${value}</code>`
        );
        const text = `<b>Config</b>\n\n${lines.join("\n")}`;
        await this.bot.sendMessage(chatId, text, { parse_mode: "HTML" });
    }

    private async updateConfig(chatId: number, key: string, rawValue: string): Promise<void> {
        if (!(key in this.config)) {
            await this.bot.sendMessage(chatId, this.locals[this.lang].configKeyNotFound);
            return;
        }

        const currentValue = this.config[key as keyof BotConfig];
        let parsed: string | number | boolean;

        if (typeof currentValue === "boolean") {
            if (rawValue === "true") parsed = true;
            else if (rawValue === "false") parsed = false;
            else {
                await this.bot.sendMessage(chatId, this.locals[this.lang].configInvalidValue);
                return;
            }
        } else if (typeof currentValue === "number") {
            parsed = Number(rawValue);
            if (isNaN(parsed)) {
                await this.bot.sendMessage(chatId, this.locals[this.lang].configInvalidValue);
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
            `${this.locals[this.lang].configUpdated}\n<b>${key}</b>: <code>${parsed}</code>`,
            { parse_mode: "HTML" }
        );
    }
}
