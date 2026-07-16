import TelegramBot, { Message, InputRichMessage, InputRichBlock, InputRichBlockListItem, RichText } from "node-telegram-bot-api";
import { BotConfig, MediaItem, SendMessageOptions } from "../types";
import { MediaService } from "./photoService";
import { localeService } from "./localeService";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";

type RichTextInput = RichText | string | RichTextInput[];

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
        public mediaService: MediaService
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

    // node-telegram-bot-api's RichText type only covers the tagged formatting
    // objects (bold, italic, ...); the Bot API also accepts a plain string or
    // an array of RichText for concatenation, which the shipped types omit.
    // Widen locally instead of casting at every call site.
    formatUserMentionRich(userId: number, username?: string, firstName?: string): RichTextInput {
        return username
            ? `@${username}`
            : {
                type: "text_mention",
                text: (firstName || "User") as unknown as RichText,
                user: { id: userId, is_bot: false, first_name: firstName || "User" },
            };
    }

    // Approved-group post as a Rich Message (Bot API 10.1+). See
    // https://core.telegram.org/bots/api for the block/text "type" discriminators.
    formatPostRichMessage(data: PostData, soldTag?: string): InputRichMessage {
        const detailItem = (text: RichTextInput): InputRichBlockListItem => ({
            blocks: [{ type: "paragraph", text } as InputRichBlock],
        });

        const blocks: InputRichBlock[] = [
            { type: "heading", text: data.title, size: 2 } as InputRichBlock,
            { type: "blockquote", blocks: [{ type: "paragraph", text: data.description } as InputRichBlock] } as InputRichBlock,
            { type: "divider" } as InputRichBlock,
            {
                type: "list",
                items: [
                    detailItem(`💰 ${data.price}`),
                    detailItem(`📍 ${data.location}`),
                    detailItem(["👤 ", this.formatUserMentionRich(data.userId, data.username, data.firstName)]),
                ],
            } as InputRichBlock,
        ];

        const mediaBlocks: InputRichBlock[] = data.media.map((item) =>
            item.type === "video"
                ? { type: "video", video: { type: "video", media: item.fileId } } as InputRichBlock
                : { type: "photo", photo: { type: "photo", media: item.fileId } } as InputRichBlock
        );

        if (mediaBlocks.length === 1) {
            blocks.push(mediaBlocks[0]);
        } else if (mediaBlocks.length > 1) {
            // slideshow = swipeable gallery; nicer than a fixed collage grid.
            blocks.push({ type: "slideshow", blocks: mediaBlocks } as InputRichBlock);
        }

        // A sold post shouldn't invite contact, so swap the CTA for the sold tag.
        const footerText = soldTag ? soldTag.trim() : localeService.t(this.lang, 'contactSellerCta');
        blocks.push({ type: "footer", text: footerText } as InputRichBlock);

        return { blocks };
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

        const options: SendMessageOptions = {
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(this.config.lang, 'approveButton'), callback_data: `approve_${postId}` },
                    { text: localeService.t(this.config.lang, 'rejectButton'), callback_data: `reject_${postId}` },
                ]],
            },
        };

        if (moderationTopicId && Number(moderationTopicId) !== 1) {
            options.message_thread_id = Number(moderationTopicId);
        }

        if (media.length > 0) {
            const mediaGroupOptions: SendMessageOptions = {};
            if (moderationTopicId && Number(moderationTopicId) !== 1) {
                mediaGroupOptions.message_thread_id = Number(moderationTopicId);
            }
            const group = this.mediaService.buildMediaGroup(media, text);
            const sentMsgs = await this.bot.sendMediaGroup(moderationGroupId, group, mediaGroupOptions);
            await this.bot.sendMessage(moderationGroupId, localeService.t(this.config.lang, 'moderationPrompt'), options);

            return sentMsgs[0]?.message_id || null;
        } else {
            const sentMsg = await this.bot.sendMessage(moderationGroupId, text, options);

            return sentMsg.message_id;
        }
    }

    async sendToApproved(richMessage: InputRichMessage): Promise<number | null> {
        const approvedGroupId = this.config.approvedGroupId;
        const approvedTopicId = this.config.approvedTopicId;

        const options: Parameters<TelegramBot['sendRichMessage']>[2] = {};
        if (approvedTopicId && Number(approvedTopicId) !== 1) {
            options.message_thread_id = Number(approvedTopicId);
        }

        const sent = await this.bot.sendRichMessage(approvedGroupId, richMessage, options);

        return sent.message_id;
    }

    async sendToApprovedText(text: string): Promise<number | null> {
        const approvedGroupId = this.config.approvedGroupId;
        const approvedTopicId = this.config.approvedTopicId;

        const options: SendMessageOptions = { parse_mode: "HTML" };
        if (approvedTopicId && Number(approvedTopicId) !== 1) {
            options.message_thread_id = Number(approvedTopicId);
        }

        const sent = await this.bot.sendMessage(approvedGroupId, text, options);

        return sent.message_id;
    }

    async markSoldInGroup(approvedMessageId: number, richMessage: InputRichMessage): Promise<boolean> {
        const approvedGroupId = this.config.approvedGroupId;

        try {
            await this.bot.editMessageText({
                chat_id: approvedGroupId,
                message_id: approvedMessageId,
                rich_message: richMessage,
            });
            return true;
        } catch (err) {
            const errorMessage = (err as Error).message;
            if (errorMessage.includes("message to edit not found")) {
                console.warn("[WARN - markSoldInGroup]", `Message with ID ${approvedMessageId} not found in group ${approvedGroupId}. Clearing approvedMessageId reference.`);
                return false;
            }
            if (errorMessage.includes("message is not modified")) {
                return true;
            }

            console.error("[ERROR - markSoldInGroup]", errorMessage);
            return false;
        }
    }

    async handlePublicReply(msg: Message): Promise<void> {
        if (!msg.reply_to_message || msg.chat.id !== this.config.approvedGroupId) return;

        const post = await postRepository.findByApprovedMessageId(msg.reply_to_message.message_id);

        if (post) {
            const author = await userRepository.findByUserId(post.userId);
            const locale = localeService.resolveUserLocale(author);

            // 1. Send the text notification
            await this.bot.sendMessage(Number(post.userId),
                `💬 <b>${localeService.t(locale, 'newReplyNotification')}</b>\n` +
                `Post: <i>${post.title}</i>\n` +
                `From: ${this.formatUserMention(msg.from!.id, msg.from!.username, msg.from!.first_name)}`,
                { parse_mode: "HTML" }
            );

            // 2. Attempt Forward with Copy fallback
            try {
                await this.bot.forwardMessage(Number(post.userId), msg.chat.id, msg.message_id);
            } catch (err) {
                console.warn('[WARN - PostService.handlePublicReply] Forward failed, attempting copy...', (err as Error).message);

                try {
                    // copyMessage is much more likely to succeed in protected groups
                    await this.bot.copyMessage(Number(post.userId), msg.chat.id, msg.message_id);
                } catch (copyErr) {
                    console.error('[ERROR - PostService.handlePublicReply] Both forward and copy failed.', (copyErr as Error).message);
                }
            }

            console.info('[INFO - PostService.handlePublicReply]', { postId: post._id, authorId: post.userId, buyerId: msg.from?.id });
        }
    }

}
