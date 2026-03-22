import TelegramBot from "node-telegram-bot-api";
import { BotConfig, Locals, MediaItem } from "../types";
import { MediaService } from "./photoService";

export interface PostData {
    title: string;
    description: string;
    price: number;
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
        private locals: Locals,
        private mediaService: MediaService
    ) {}

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

    async sendPreview(chatId: number, text: string, media: MediaItem[]): Promise<void> {
        const previewText = `${this.locals[this.lang].preview}\n${text}`;

        if (media.length > 0) {
            const group = this.mediaService.buildMediaGroup(media, previewText);
            await this.bot.sendMediaGroup(chatId, group);
        } else {
            await this.bot.sendMessage(chatId, previewText, { parse_mode: "HTML" });
        }
    }

    async sendToModeration(postId: string, text: string, media: MediaItem[]): Promise<void> {
        const moderationGroupId = this.config.moderationGroupId;
        const moderationTopicId = this.config.moderationTopicId;

        const approveRejectMarkup = {
            reply_markup: {
                inline_keyboard: [[
                    { text: this.locals[this.lang].approveButton, callback_data: `approve_${postId}` },
                    { text: this.locals[this.lang].rejectButton, callback_data: `reject_${postId}` },
                ]],
            },
        };

        if (media.length > 0) {
            const group = this.mediaService.buildMediaGroup(media, text);

            await this.bot.sendMediaGroup(moderationGroupId, group, {
                reply_to_message_id: moderationTopicId,
            } as any);

            await this.bot.sendMessage(moderationGroupId, this.locals[this.lang].moderationPrompt, {
                reply_to_message_id: moderationTopicId,
                ...approveRejectMarkup,
            } as any);
        } else {
            await this.bot.sendMessage(moderationGroupId, text, {
                parse_mode: "HTML",
                reply_to_message_id: moderationTopicId,
                ...approveRejectMarkup,
            } as any);
        }
    }

    async sendToApproved(text: string, media: MediaItem[]): Promise<void> {
        const approvedGroupId = this.config.approvedGroupId;
        const approvedTopicId = this.config.approvedTopicId;

        if (media.length > 0) {
            const group = this.mediaService.buildMediaGroup(media, text);

            await this.bot.sendMediaGroup(approvedGroupId, group, {
                reply_to_message_id: approvedTopicId,
            } as any);
        } else {
            await this.bot.sendMessage(approvedGroupId, text, {
                parse_mode: "HTML",
                reply_to_message_id: approvedTopicId,
            } as any);
        }
    }
}
