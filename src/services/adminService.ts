import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";
import { BotConfig } from "../types";
import userRepository from "../repositories/userRepository";
import { AuthLevel, User } from "../types";
import { userService } from "./userService";
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

    /**
     * Handle /config command.
     * Access: ADMIN (Level 2)
     */
    async handleConfig(msg: TelegramBot.Message, args: string): Promise<void> {
        const user = await this._getUser(msg.from!.id);
        const locale = localeService.resolveUserLocale(user);

        const isAuthorized = await userService.hasAuthLevel(String(msg.from!.id), AuthLevel.ADMIN);
        if (!isAuthorized) {
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

        (this.config as unknown as Record<string, unknown>)[key] = parsed;

        // Persist to config.json
        fs.writeFileSync(configPath, JSON.stringify(this.config, null, 4), "utf-8");

        await this.bot.sendMessage(
            chatId,
            `${localeService.t(locale, 'configUpdated')}\n<b>${key}</b>: <code>${parsed}</code>`,
            { parse_mode: "HTML" }
        );
    }

    /**
     * Handle /broadcast command.
     * Access: ADMIN (Level 2)
     */
    async handleBroadcast(msg: TelegramBot.Message, args: string): Promise<void> {
        const user = await this._getUser(msg.from!.id);
        const locale = localeService.resolveUserLocale(user);

        const isAuthorized = await userService.hasAuthLevel(String(msg.from!.id), AuthLevel.ADMIN);
        if (!isAuthorized) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
            return;
        }

        const approvedGroupId = this.config.approvedGroupId;
        const broadcastTopicId = this.config.broadcastTopicId;

        const options: TelegramBot.SendMessageOptions = {
            parse_mode: "HTML"
        };

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
                    optionsThreadId: `${options.message_thread_id} (${typeof options.message_thread_id})`
                }
            });
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'generalError'));
        }
    }

    /**
     * Handle /promote command.
     * Access: ADMIN (Level 2)
     */
    async handlePromote(msg: TelegramBot.Message, args: string): Promise<void> {
        const actorId = String(msg.from!.id);
        const actor = await this._getUser(msg.from!.id);
        const locale = localeService.resolveUserLocale(actor);

        const isAuthorized = await userService.hasAuthLevel(actorId, AuthLevel.ADMIN);
        if (!isAuthorized) {
            console.warn(`[WARN - AdminService.handlePromote] Unauthorized attempt by user ${actorId}`);
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
            return;
        }

        const targetUser = await this._resolveTargetUser(msg, args);

        if (!targetUser) {
            console.warn(`[WARN - AdminService.handlePromote] Target user not found for actor ${actorId} with args: ${args}`);
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'userNotFound'));
            return;
        }

        const targetId = String(targetUser.userId);

        if (targetId === actorId) {
            console.warn(`[WARN - AdminService.handlePromote] Admin ${actorId} attempted to promote themselves.`);
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'promoteAlreadyAtLevel'));
            return;
        }

        const currentAuthLevel = targetUser.authLevel;
        if (currentAuthLevel >= AuthLevel.ADMIN) {
            console.warn(`[WARN - handlePromote] Target user ${targetId} is already ADMIN. Actor: ${actorId}`);
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'promoteLimitReached'));
            return;
        }

        const newAuthLevel = currentAuthLevel + 1;
        await userRepository.updateUser(targetId, { authLevel: newAuthLevel });

        const timestamp = new Date().toISOString();
        console.info(`[INFO - handlePromote] Action: PROMOTE | Actor: ${actorId} | Target: ${targetId} | Old Level: ${currentAuthLevel} | New Level: ${newAuthLevel} | Time: ${timestamp}`);

        await this.bot.sendMessage(
            msg.chat.id,
            localeService.t(locale, 'promoteSuccess', { userId: targetId, level: newAuthLevel }),
            { parse_mode: "HTML" }
        );
    }

    /**
     * Handle /demote command.
     * Access: ADMIN (Level 2)
     */
    async handleDemote(msg: TelegramBot.Message, args: string): Promise<void> {
        const actorId = String(msg.from!.id);
        const actor = await this._getUser(msg.from!.id);
        const locale = localeService.resolveUserLocale(actor);

        const isAuthorized = await userService.hasAuthLevel(actorId, AuthLevel.ADMIN);
        if (!isAuthorized) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
            return;
        }

        const targetUser = await this._resolveTargetUser(msg, args);
        if (!targetUser) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'userNotFound'));
            return;
        }

        const targetId = String(targetUser.userId);
        if (targetUser.authLevel <= AuthLevel.USER) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'demoteAlreadyAtLevel'));
            return;
        }

        const oldLevel = targetUser.authLevel;
        const newLevel = oldLevel - 1;
        await userRepository.updateUser(targetId, { authLevel: newLevel });

        const timestamp = new Date().toISOString();
        console.info(`[INFO - handleDemote] Action: DEMOTE | Actor: ${actorId} | Target: ${targetId} | Old Level: ${oldLevel} | New Level: ${newLevel} | Time: ${timestamp}`);

        await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'demoteSuccess', { userId: targetId, level: newLevel }), { parse_mode: "HTML" });

        if (oldLevel === AuthLevel.ADMIN) {
            const adminCount = await userRepository.countByAuthLevel(AuthLevel.ADMIN);
            if (adminCount === 0) {
                await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'demoteAdminWarning'), { parse_mode: "HTML" });
            }
        }
    }

    /**
     * Handle /auth command.
     * Access: MOD (Level 1) or ADMIN (Level 2)
     */
    async handleAuth(msg: TelegramBot.Message, args: string): Promise<void> {
        const actorId = String(msg.from!.id);
        const actor = await this._getUser(msg.from!.id);
        const locale = localeService.resolveUserLocale(actor);

        // Auth command available to MOD and ADMIN
        const isAuthorized = await userService.hasAuthLevel(actorId, AuthLevel.MOD);
        if (!isAuthorized) {
            console.warn(`[WARN - handleAuth] Unauthorized attempt by user ${actorId}`);
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'notAdmin'));
            return;
        }

        const targetUser: User | null = (!args.trim() && !msg.reply_to_message && !msg.forward_from)
            ? actor
            : await this._resolveTargetUser(msg, args);

        if (!targetUser) {
            await this.bot.sendMessage(msg.chat.id, localeService.t(locale, 'userNotFound'));
            return;
        }

        const roleLabelKey = targetUser.authLevel === AuthLevel.ADMIN ? 'authLevelAdmin' :
            targetUser.authLevel === AuthLevel.MOD ? 'authLevelMod' : 'authLevelUser';
        const roleLabel = localeService.t(locale, roleLabelKey);

        await this.bot.sendMessage(
            msg.chat.id,
            localeService.t(locale, 'authCurrentLevel', { userId: targetUser.userId, role: roleLabel, level: targetUser.authLevel }),
            { parse_mode: "HTML" }
        );
    }

    private async _resolveTargetUser(msg: TelegramBot.Message, args: string): Promise<User | null> {
        let targetUserId: string | undefined;

        // 1. Check for replied-to message
        if (msg.reply_to_message) {
            if (msg.reply_to_message.forward_from?.id) {
                targetUserId = String(msg.reply_to_message.forward_from.id);
            } else if (msg.reply_to_message.from?.id) {
                targetUserId = String(msg.reply_to_message.from.id);
            }
        }
        // 2. Check for forwarded message (if Telegram provides sender metadata)
        else if (msg.forward_from?.id) {
            targetUserId = String(msg.forward_from.id);
        }
        // 3. Check for arguments (numeric ID or @username)
        else if (args.trim()) {
            const arg = args.trim();
            // Numeric ID
            if (!isNaN(Number(arg))) {
                targetUserId = arg;
            }
            // @username
            else if (arg.startsWith('@')) {
                const username = arg.substring(1);
                const userByUsername = await userRepository.findByUsername(username);
                if (userByUsername) {
                    return userByUsername;
                }
                console.warn(`[WARN - _resolveTargetUser] User not found by username: ${username}`);
                return null;
            }
        }

        if (targetUserId) {
            return userRepository.findByUserId(targetUserId);
        }

        return null;
    }

    /**
     * Helper to get user data, ensuring it exists in DB.
     * @param userId
     * @returns
     */
    private async _getUser(userId: number): Promise<User | null> {
        const existing = await userRepository.findByUserId(String(userId));
        if (!existing) {
            await userService.ensureUser({ id: userId, first_name: 'Unknown', username: 'unknown' });
            return userRepository.findByUserId(String(userId));
        }
        return existing;
    }
}
