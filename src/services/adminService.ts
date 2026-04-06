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
    ) {
    }

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

    async handleBroadcast(msg: TelegramBot.Message, args: string): Promise<void> {
        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);

        const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
        if (!isAdmin) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
            return;
        }

        const approvedGroupId = this.config.approvedGroupId;
        const broadcastTopicId = this.config.broadcastTopicId;

        // Setup options once for both scenarios. 
        // We use 'any' for options to safely handle the dynamic addition of message_thread_id
        const options: TelegramBot.CopyMessageOptions & TelegramBot.SendMessageOptions = {
            parse_mode: "HTML"
        } as any;

        // If broadcastTopicId is null or undefined, it will go to the General topic
        if (broadcastTopicId !== null && broadcastTopicId !== undefined) {
            options.message_thread_id = Number(broadcastTopicId);
        }

        try {
            // Scenario 1: Admin replied to a message
            if (msg.reply_to_message) {
                if (msg.reply_to_message.text) {
                    // For text messages, sendMessage ensures the text is parsed as HTML
                    await this.bot.sendMessage(approvedGroupId, msg.reply_to_message.text, options);
                } else {
                    // For media, copyMessage supports parse_mode for the caption
                    await this.bot.copyMessage(
                        approvedGroupId,
                        msg.chat.id,
                        msg.reply_to_message.message_id,
                        options
                    );
                }
            }
            // Scenario 2: Admin typed a message after /broadcast
            else if (args.trim()) {
                await this.bot.sendMessage(approvedGroupId, args.trim(), options);
            }
            // Scenario 3: No message to broadcast
            else {
                await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'broadcastUsage'));
                return;
            }

            // Common success handling
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'broadcastSuccess'));
            console.info('[INFO - AdminService.handleBroadcast] Broadcast successful', {
                adminId: msg.from?.id,
                type: msg.reply_to_message ? 'copy' : 'text'
            });
        } catch (err) {
            console.error("[ERROR - AdminService.handleBroadcast]", {
                error: (err as Error).message,
                stack: (err as Error).stack,
                sentParams: {
                    approvedGroupId: `${approvedGroupId} (${typeof approvedGroupId})`,
                    broadcastTopicId: `${broadcastTopicId} (${typeof broadcastTopicId})`,
                    optionsThreadId: `${(options as any).message_thread_id} (${typeof (options as any).message_thread_id})`
                }
            });
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'generalError'));
        }
    }
}
