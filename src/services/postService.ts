import TelegramBot, { Message, InputRichMessage } from "node-telegram-bot-api";
import { BotConfig, MediaItem, SendMessageOptions } from "../types";
import { MediaService } from "./photoService";
import { localeService } from "./localeService";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";

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

    // The `text_mention` rich-text object links a display name to a user id.
    formatUserMentionRich(userId: number, username?: string, firstName?: string): unknown {
        return username
            ? `@${username}`
            : { type: "text_mention", text: firstName || "User", user: { id: userId, is_bot: false, first_name: firstName || "User" } };
    }

    // Approved-group post as a Rich Message (Bot API 10.1+). The shipped RichText
    // types omit the plain-string/array forms the API accepts, so we assemble the
    // blocks loosely and cast once at the boundary. Block/text "type"
    // discriminators verified against https://core.telegram.org/bots/api.
    formatPostRichMessage(data: PostData, opts: { sold?: boolean; showCta?: boolean } = {}): InputRichMessage {
        const bold = (text: unknown) => ({ type: "bold", text });
        const para = (text: unknown) => ({ type: "paragraph", text });
        const item = (text: unknown) => ({ blocks: [para(text)] });

        const titleText = opts.sold ? { type: "strikethrough", text: data.title } : data.title;

        const blocks: unknown[] = [
            { type: "heading", text: titleText, size: 2 },
            { type: "blockquote", blocks: [para(data.description)] },
            { type: "divider" },
            {
                type: "list",
                items: [
                    item(["💰 ", bold(data.price)]),
                    item(`📍 ${data.location}`),
                    item(["👤 ", this.formatUserMentionRich(data.userId, data.username, data.firstName)]),
                ],
            },
        ];

        const mediaBlocks = data.media.map((m) =>
            m.type === "video"
                ? { type: "video", video: { type: "video", media: m.fileId } }
                : { type: "photo", photo: { type: "photo", media: m.fileId } }
        );

        if (mediaBlocks.length === 1) {
            blocks.push(mediaBlocks[0]);
        } else if (mediaBlocks.length > 1) {
            // slideshow (swipeable) vs collage (grid) — chosen in config.json.
            const layout = this.config.mediaLayout ?? "slideshow";
            blocks.push({ type: layout, blocks: mediaBlocks });
        }

        // Sold posts show the sold marker; only the public post gets a contact CTA.
        const footer = opts.sold
            ? localeService.t(this.lang, 'soldTag')
            : opts.showCta ? localeService.t(this.lang, 'contactSellerCta') : null;
        if (footer) {
            blocks.push({ type: "footer", text: footer });
        }

        return { blocks } as unknown as InputRichMessage;
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

    // One Rich Message carrying the post AND the approve/reject buttons. A media
    // group can't hold buttons, which is why the old media path sent a second
    // message — the source of the noticeable button delay.
    async sendToModeration(postId: string, data: PostData): Promise<number | null> {
        const moderationGroupId = this.config.moderationGroupId;
        const moderationTopicId = this.config.moderationTopicId;

        const options: Parameters<TelegramBot['sendRichMessage']>[2] = {
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(this.lang, 'approveButton'), callback_data: `approve_${postId}` },
                    { text: localeService.t(this.lang, 'rejectButton'), callback_data: `reject_${postId}` },
                ]],
            },
        };

        if (moderationTopicId && Number(moderationTopicId) !== 1) {
            options.message_thread_id = Number(moderationTopicId);
        }

        const sent = await this.bot.sendRichMessage(moderationGroupId, this.formatPostRichMessage(data), options);

        return sent.message_id;
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
