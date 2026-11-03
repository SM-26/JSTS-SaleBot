import { RichMessageBuilder, RichTextBuilder, richListItem } from "node-telegram-bot-api";
import type { Api } from "node-telegram-bot-api";
import type { Message, InputRichMessage, SendRichMessageParams } from "node-telegram-bot-api/types";
import { BotConfig, MediaItem, SendMessageOptions } from "../types";
import { isApiError } from "../config/telegramErrors";
import { localeService } from "./localeService";
import { entitiesToRichText } from "./richMessages";
import type { StoredEntity } from "../models/Post";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";

export interface PostData {
    title: string;
    description: string;
    descriptionEntities?: StoredEntity[];
    price: string;
    location: string;
    media: MediaItem[];
    userId: number;
    username?: string;
    firstName: string;
}

export class PostService {
    constructor(
        private api: Api,
        private config: BotConfig
    ) { }

    private get lang() {
        return this.config.lang;
    }

    formatUserMention(userId: number, username?: string, firstName?: string): string {
        return username
            ? `@${username}`
            : `<a href="tg://user?id=${userId}">${firstName || "User"}</a>`;
    }

    // The `text_mention` rich-text object links a display name to a user id.
    private appendUserMentionRich(text: RichTextBuilder, userId: number, username?: string, firstName?: string): RichTextBuilder {
        if (username) return text.plain(`@${username}`);
        const name = firstName || "User";
        return text.textMention(name, { id: userId, is_bot: false, first_name: name });
    }

    // Approved-group post as a Rich Message (Bot API 10.1+). Block/text "type"
    // discriminators verified against https://core.telegram.org/bots/api.
    // checkRichMessages.ts pins the exact wire JSON: posts already published
    // must keep looking identical. Single-node rich texts (title, link) stay
    // plain objects because RichTextBuilder.build() always wraps in an array.
    formatPostRichMessage(
        data: PostData,
        opts: { sold?: boolean; showCta?: boolean; previewLabel?: string; link?: { label: string; url: string } } = {}
    ): InputRichMessage {
        const message = new RichMessageBuilder();
        if (opts.previewLabel) message.paragraph(opts.previewLabel);

        message
            .heading(opts.sold ? { type: "strikethrough", text: data.title } : data.title, 2)
            .blockquote(b => b.paragraph(entitiesToRichText(data.description, data.descriptionEntities)))
            .divider()
            .list([
                richListItem(b => b.paragraph(new RichTextBuilder().plain("💰 ").bold(data.price))),
                richListItem(b => b.paragraph(`📍 ${data.location}`)),
                richListItem(b => b.paragraph(this.appendUserMentionRich(new RichTextBuilder().plain("👤 "), data.userId, data.username, data.firstName))),
            ]);

        const addMedia = (b: RichMessageBuilder, m: MediaItem) =>
            m.type === "video" ? b.video({ type: "video", media: m.fileId }) : b.photo({ type: "photo", media: m.fileId });

        if (data.media.length === 1) {
            addMedia(message, data.media[0]);
        } else if (data.media.length > 1) {
            // slideshow (swipeable) vs collage (grid) — chosen in config.json.
            const addAll = (b: RichMessageBuilder) => data.media.forEach(m => addMedia(b, m));
            if (this.config.mediaLayout === "collage") message.collage(addAll);
            else message.slideshow(addAll);
        }

        // e.g. the /pending "Review" deep-link to the moderation message.
        if (opts.link) {
            message.footer({ type: "url", text: opts.link.label, url: opts.link.url });
        }

        // Sold posts show the sold marker; only the public post gets a contact CTA.
        const footer = opts.sold
            ? localeService.t(this.lang, 'soldTag')
            : opts.showCta ? localeService.t(this.lang, 'contactSellerCta') : null;
        if (footer) message.footer(footer);

        return message.build();
    }

    // One Rich Message carrying the post AND the approve/reject buttons. A media
    // group can't hold buttons, which is why the old media path sent a second
    // message — the source of the noticeable button delay.
    async sendToModeration(postId: string, data: PostData): Promise<number | null> {
        const moderationGroupId = this.config.moderationGroupId;
        const moderationTopicId = this.config.moderationTopicId;

        const options: Pick<SendRichMessageParams, "message_thread_id" | "reply_markup"> = {
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

        const sent = await this.api.sendRichMessage({ chat_id: moderationGroupId, rich_message: this.formatPostRichMessage(data), ...options });

        return sent.message_id;
    }

    async sendToApproved(richMessage: InputRichMessage): Promise<number | null> {
        const approvedGroupId = this.config.approvedGroupId;
        const approvedTopicId = this.config.approvedTopicId;

        const options: Pick<SendRichMessageParams, "message_thread_id"> = {};
        if (approvedTopicId && Number(approvedTopicId) !== 1) {
            options.message_thread_id = Number(approvedTopicId);
        }

        const sent = await this.api.sendRichMessage({ chat_id: approvedGroupId, rich_message: richMessage, ...options });

        return sent.message_id;
    }

    async sendToApprovedText(text: string): Promise<number | null> {
        const approvedGroupId = this.config.approvedGroupId;
        const approvedTopicId = this.config.approvedTopicId;

        const options: SendMessageOptions = { parse_mode: "HTML" };
        if (approvedTopicId && Number(approvedTopicId) !== 1) {
            options.message_thread_id = Number(approvedTopicId);
        }

        const sent = await this.api.sendMessage({ chat_id: approvedGroupId, text, ...options });

        return sent.message_id;
    }

    async markSoldInGroup(approvedMessageId: number, richMessage: InputRichMessage): Promise<boolean> {
        const approvedGroupId = this.config.approvedGroupId;

        try {
            await this.api.editMessageText({
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
            if (isApiError(err, 400, "message is not modified")) {
                return true;
            }

            console.error("[ERROR - markSoldInGroup]", (err as Error).message);
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
            await this.api.sendMessage({
                chat_id: Number(post.userId),
                text: `💬 <b>${localeService.t(locale, 'newReplyNotification')}</b>\n` +
                `Post: <i>${post.title}</i>\n` +
                `From: ${this.formatUserMention(msg.from!.id, msg.from!.username, msg.from!.first_name)}`,
                parse_mode: "HTML"
            });

            // 2. Attempt Forward with Copy fallback
            try {
                await this.api.forwardMessage({ chat_id: Number(post.userId), from_chat_id: msg.chat.id, message_id: msg.message_id });
            } catch (err) {
                console.warn('[WARN - PostService.handlePublicReply] Forward failed, attempting copy...', (err as Error).message);

                try {
                    // copyMessage is much more likely to succeed in protected groups
                    await this.api.copyMessage({ chat_id: Number(post.userId), from_chat_id: msg.chat.id, message_id: msg.message_id });
                } catch (copyErr) {
                    console.error('[ERROR - PostService.handlePublicReply] Both forward and copy failed.', (copyErr as Error).message);
                }
            }

            console.info('[INFO - PostService.handlePublicReply]', { postId: post._id, authorId: post.userId, buyerId: msg.from?.id });
        }
    }

}
