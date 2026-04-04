import TelegramBot from "node-telegram-bot-api";
import { BotConfig, MediaItem } from "../types";
import { MediaService } from "./photoService";
import { localeService } from "./localeService";

export interface PostData {
    title: string;
    description: string;
    price: string;
    location: string;
    media: MediaItem[];
    userId: number;
    username?: string;
    firstName: string;
}

export class PostService {
    constructor(
        private bot: TelegramBot,
        private config: BotConfig,
        private mediaService: MediaService
    ) { }

    private get lang() {
        return this.config.lang;
    }

    formatUserMention(userId: number, username?: string, firstName?: string): string {
        return username
            ? `@${username}`
            : `<a href="tg://user?id=${userId}">${firstName || "User"}</a>`;
    }

    formatPostText(data: PostData): string {
        return [
            `<b>${data.title}</b>`,
            data.description,
            `💰 ${data.price}`,
            `📍 ${data.location}`,
            `👤 ${this.formatUserMention(data.userId, data.username, data.firstName)}`,
        ].join("\n");
    }

    async sendPreview(chatId: number, text: string, media: MediaItem[], locale: string): Promise<void> {
        const previewText = `${localeService.t(locale, 'preview')}\n${text}`;

        if (media.length > 0) {
            const group = this.mediaService.buildMediaGroup(media, previewText);
            await this.bot.sendMediaGroup(chatId, group);
        } else {
            await this.bot.sendMessage(chatId, previewText, { parse_mode: "HTML" });
        }
    }

    async sendToModeration(postId: string, text: string, media: MediaItem[]): Promise<number | null> {
        const moderationGroupId = this.config.moderationGroupId;
        const moderationTopicId = this.config.moderationTopicId;

        const approveRejectMarkup = {
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(this.config.lang, 'approveButton'), callback_data: `approve_${postId}` },
                    { text: localeService.t(this.config.lang, 'rejectButton'), callback_data: `reject_${postId}` },
                ]],
            },
        };

        if (media.length > 0) {
            const group = this.mediaService.buildMediaGroup(media, text);

            const sentMsgs = await this.bot.sendMediaGroup(moderationGroupId, group, {
                reply_to_message_id: moderationTopicId,
            } as any);

            await this.bot.sendMessage(moderationGroupId, localeService.t(this.config.lang, 'moderationPrompt'), {
                reply_to_message_id: moderationTopicId,
                ...approveRejectMarkup,
            } as any);

            return sentMsgs[0]?.message_id || null;
        } else {
            const sentMsg = await this.bot.sendMessage(moderationGroupId, text, {
                parse_mode: "HTML",
                reply_to_message_id: moderationTopicId,
                ...approveRejectMarkup,
            } as any);

            return sentMsg.message_id;
        }
    }

    async sendToApproved(text: string, media: MediaItem[]): Promise<number | null> {
        const approvedGroupId = this.config.approvedGroupId;
        const approvedTopicId = this.config.approvedTopicId;

        if (media.length > 0) {
            const group = this.mediaService.buildMediaGroup(media, text);

            const sent = await this.bot.sendMediaGroup(approvedGroupId, group, {
                reply_to_message_id: approvedTopicId,
            } as any);

            return sent[0]?.message_id ?? null;
        } else {
            const sent = await this.bot.sendMessage(approvedGroupId, text, {
                parse_mode: "HTML",
                reply_to_message_id: approvedTopicId,
            } as any);

            return sent.message_id;
        }
    }

    async markSoldInGroup(approvedMessageId: number, soldText: string, hasMedia: boolean): Promise<boolean> {
        const approvedGroupId = this.config.approvedGroupId;

        try {
            if (hasMedia) {
                await this.bot.editMessageCaption(soldText, {
                    chat_id: approvedGroupId,
                    message_id: approvedMessageId,
                    parse_mode: "HTML",
                });
            } else {
                await this.bot.editMessageText(soldText, {
                    chat_id: approvedGroupId,
                    message_id: approvedMessageId,
                    parse_mode: "HTML",
                });
            }
            return true;
        } catch (err) {
            console.error("[ERROR - markSoldInGroup]", (err as Error).message);
            return false;
        }
    }
}
