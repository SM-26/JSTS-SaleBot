import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, Message, InlineKeyboardMarkup, User as TelegramUser } from "node-telegram-bot-api/types";
import { storedEntity } from "../models/Post";
import type { IDraft, DraftStep } from "../models/Draft";
import draftRepository, { DraftFields, isDraftExpired } from "../repositories/draftRepository";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { BotConfig, MediaItem, Post } from "../types";
import { InputService } from "./inputService";
import { PostService, PostData } from "./postService";
import { localeService } from "./localeService";
import type { PublishService } from "./publishService";

type TextStep = "title" | "description" | "price" | "location";
type WizardAction = "done" | "confirm" | "cancel" | "continue" | "restart";

const TOTAL_STEPS = 5;
const PROMPTS: Record<TextStep | "media", { key: string; index: number }> = {
    title: { key: "welcome", index: 1 },
    description: { key: "enterDescription", index: 2 },
    price: { key: "enterPrice", index: 3 },
    location: { key: "enterLocation", index: 4 },
    media: { key: "enterMedia", index: 5 },
};
const NEXT_STEP: Record<TextStep, DraftStep> = { title: "description", description: "price", price: "location", location: "media" };

// Buttons already sent to Telegram keep their callback_data forever: these
// formats are v1's (draft_* are new). A press is only valid against the draft.
const CALLBACKS: { prefix: string; action: WizardAction }[] = [
    { prefix: "done_media_", action: "done" },
    { prefix: "confirm_", action: "confirm" },
    { prefix: "cancel_", action: "cancel" },
    { prefix: "draft_continue_", action: "continue" },
    { prefix: "draft_restart_", action: "restart" },
];
// The step a press must find the draft in; continue/restart work on any step.
const REQUIRED_STEP: Partial<Record<WizardAction, DraftStep>> = { done: "media", confirm: "confirm", cancel: "confirm" };

export function parseWizardCallback(data: string): { action: WizardAction; userId: string } | null {
    for (const { prefix, action } of CALLBACKS) {
        if (data.startsWith(prefix)) return { action, userId: data.slice(prefix.length).split("_")[0] };
    }
    return null;
}

type PromptTarget = Pick<IDraft, "userId" | "chatId" | "locale" | "step">;

// The /newPost wizard as a step machine over the `drafts` collection: every
// update reads the user's draft, so a restart loses nothing.
export class WizardService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private inputService: InputService,
        private postService: PostService,
        private publishService: PublishService
    ) { }

    private t(locale: string, key: string): string {
        return localeService.t(locale, key);
    }

    private async safe(context: string, chatId: number, run: () => Promise<boolean>): Promise<boolean> {
        try {
            return await run();
        } catch (err) {
            console.error(`[ERROR - WizardService.${context}]`, (err as Error).message);
            await this.api.sendMessage({ chat_id: chatId, text: this.t(this.config.lang, "generalError") }).catch(() => undefined);
            return true;
        }
    }

    private async removeKeyboard(chatId: number, messageId: number): Promise<void> {
        await this.api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
            .catch((err: Error) => console.warn("[WARN - WizardService.removeKeyboard] editMessageReplyMarkup failed:", err.message));
    }

    private async ack(query: CallbackQuery): Promise<void> {
        await this.api.answerCallbackQuery({ callback_query_id: query.id })
            .catch((err: Error) => console.warn("[WARN - WizardService.ack] answerCallbackQuery failed:", err.message));
    }

    private async expire(draft: IDraft): Promise<void> {
        await draftRepository.delete(draft.userId);
        await this.api.sendMessage({ chat_id: draft.chatId, text: this.t(draft.locale, "draftExpired") });
    }

    private async sendPreview(draft: IDraft, from: TelegramUser): Promise<number> {
        const stamp = Date.now();
        const replyMarkup: InlineKeyboardMarkup = {
            inline_keyboard: [[
                { text: this.t(draft.locale, "confirmButton"), callback_data: `confirm_${draft.userId}_${stamp}` },
                { text: this.t(draft.locale, "cancelButton"), callback_data: `cancel_${draft.userId}_${stamp}` },
            ]],
        };
        // Preview & confirm as one message (buttons attached to the preview).
        const sent = await this.api.sendRichMessage({
            chat_id: draft.chatId,
            rich_message: this.postService.formatPostRichMessage(this.postData(draft, from), { previewLabel: this.t(draft.locale, "preview") }),
            reply_markup: replyMarkup,
        });
        return sent.message_id;
    }

    // Sends the prompt for `draft.step` (the preview for "confirm") and returns its message id.
    private async sendStep(draft: PromptTarget & Partial<IDraft>, from: TelegramUser): Promise<number> {
        if (draft.step === "confirm") return this.sendPreview(draft as IDraft, from);

        const { key, index } = PROMPTS[draft.step];
        const markup: InlineKeyboardMarkup | undefined = draft.step === "media"
            ? { inline_keyboard: [[{ text: this.t(draft.locale, "doneMediaButton"), callback_data: `done_media_${draft.userId}` }]] }
            : undefined;
        const sent = await this.inputService.sendPrompt(draft.chatId, this.t(draft.locale, key), { locale: draft.locale, index, total: TOTAL_STEPS }, markup);
        return sent.message_id;
    }

    private postData(draft: IDraft, from: TelegramUser): PostData {
        return {
            title: draft.title ?? "",
            description: draft.description ?? "",
            descriptionEntities: draft.descriptionEntities?.length ? draft.descriptionEntities.map(storedEntity) : undefined,
            price: draft.price ?? "",
            location: draft.location ?? "",
            media: draft.media.map((m): MediaItem => ({ fileId: m.fileId, type: m.type })),
            userId: from.id,
            username: from.username,
            firstName: from.first_name,
        };
    }

    private async begin(from: TelegramUser, chatId: number): Promise<void> {
        const userId = String(from.id);
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        const messageId = await this.sendStep({ userId, chatId, locale, step: "title" }, from);
        await draftRepository.start(userId, chatId, locale, messageId);
    }

    /** /newpost (private chats only; the caller checks). */
    handleNewPost(msg: Message): Promise<boolean> {
        return this.safe("handleNewPost", msg.chat.id, async () => {
            const from = msg.from!;
            console.info("[INFO - WizardService.handleNewPost]", { userId: from.id, chatId: msg.chat.id });
            const draft = await draftRepository.findByUserId(String(from.id));
            if (draft && !isDraftExpired(draft, this.config.timeOut)) {
                const sent = await this.api.sendMessage({
                    chat_id: msg.chat.id,
                    text: this.t(draft.locale, "draftInProgress"),
                    reply_markup: {
                        inline_keyboard: [[
                            { text: this.t(draft.locale, "draftContinueButton"), callback_data: `draft_continue_${draft.userId}` },
                            { text: this.t(draft.locale, "draftRestartButton"), callback_data: `draft_restart_${draft.userId}` },
                        ]],
                    },
                });
                // The buttons are validated against promptMessageId, so it follows the question.
                await draftRepository.update(draft.userId, { promptMessageId: sent.message_id });
                return true;
            }
            await this.begin(from, msg.chat.id);
            return true;
        });
    }

    /** /cancel in a private chat: drop the user's draft. */
    async cancel(msg: Message): Promise<void> {
        const deleted = await draftRepository.delete(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(String(msg.from!.id)));
        await this.api.sendMessage({ chat_id: msg.chat.id, text: this.t(locale, deleted ? "cancelDone" : "cancelNothing") });
    }

    /**
     * A private non-command message. Returns true when it was an answer for the
     * user's draft (or a draft-expired notice), false when it is not ours.
     */
    handleMessage(msg: Message): Promise<boolean> {
        return this.safe("handleMessage", msg.chat.id, async () => {
            if (!msg.from || msg.text?.startsWith("/")) return false;
            const draft = await draftRepository.findByUserId(String(msg.from.id));
            if (!draft) return false;

            if (isDraftExpired(draft, this.config.timeOut)) {
                await this.expire(draft);
                return true;
            }

            if (draft.step === "media") {
                if (msg.photo && msg.photo.length > 0) {
                    await draftRepository.pushMedia(draft.userId, { fileId: msg.photo[msg.photo.length - 1].file_id, type: "photo" });
                } else if (msg.video) {
                    await draftRepository.pushMedia(draft.userId, { fileId: msg.video.file_id, type: "video" });
                }
                return true;
            }
            if (draft.step === "confirm") return true;

            // Text steps: a photo/video/sticker carries no .text and would otherwise
            // silently advance the wizard.
            if (!msg.text?.trim()) {
                await this.api.sendMessage({ chat_id: draft.chatId, text: this.t(draft.locale, "expectedText") });
                return true;
            }
            if (draft.step === "price" && !this.inputService.validatePriceValue(msg.text)) {
                await this.api.sendMessage({ chat_id: draft.chatId, text: this.t(draft.locale, "invalidPrice") });
                return true;
            }

            const next = NEXT_STEP[draft.step];
            const messageId = await this.sendStep({ userId: draft.userId, chatId: draft.chatId, locale: draft.locale, step: next }, msg.from);
            const fields: DraftFields = { step: next, promptMessageId: messageId };
            fields[draft.step] = msg.text;
            if (draft.step === "description") fields.descriptionEntities = msg.entities?.length ? msg.entities.map(storedEntity) : undefined;
            await draftRepository.update(draft.userId, fields);
            return true;
        });
    }

    /**
     * A wizard button (done / confirm / cancel / draft_continue / draft_restart).
     * Valid only against the presser's live draft: right step and the draft's
     * current prompt message. Returns false for anything else, so it falls
     * through to the stale-button catch-all.
     */
    handleCallback(query: CallbackQuery): Promise<boolean> {
        const chatId = query.message?.chat.id ?? query.from.id;
        return this.safe("handleCallback", chatId, async () => {
            const parsed = query.data ? parseWizardCallback(query.data) : null;
            const message = query.message;
            if (!parsed || !message || parsed.userId !== String(query.from.id)) return false;

            const draft = await draftRepository.findByUserId(parsed.userId);
            if (!draft || message.chat.id !== draft.chatId || message.message_id !== draft.promptMessageId) return false;
            const requiredStep = REQUIRED_STEP[parsed.action];
            if (requiredStep && draft.step !== requiredStep) return false;

            if (isDraftExpired(draft, this.config.timeOut)) {
                await this.ack(query);
                await this.removeKeyboard(message.chat.id, message.message_id);
                await this.expire(draft);
                return true;
            }

            switch (parsed.action) {
                case "done": {
                    await this.ack(query);
                    await this.removeKeyboard(message.chat.id, message.message_id);
                    if (draft.media.length < (this.config.minimumPhotos ?? 0)) {
                        await draftRepository.delete(draft.userId);
                        await this.api.sendMessage({ chat_id: draft.chatId, text: this.t(draft.locale, "notEnoughMedia") });
                        return true;
                    }
                    const messageId = await this.sendPreview(draft, query.from);
                    await draftRepository.update(draft.userId, { step: "confirm", promptMessageId: messageId });
                    return true;
                }
                case "confirm": {
                    const taken = await draftRepository.claim(draft.userId, "confirm", message.message_id);
                    if (!taken) return false;
                    await this.ack(query);
                    await this.removeKeyboard(message.chat.id, message.message_id);
                    await this.createPost(taken, query.from);
                    return true;
                }
                case "cancel": {
                    const taken = await draftRepository.claim(draft.userId, "confirm", message.message_id);
                    if (!taken) return false;
                    await this.ack(query);
                    await this.removeKeyboard(message.chat.id, message.message_id);
                    await this.api.sendMessage({ chat_id: draft.chatId, text: this.t(draft.locale, "postCancelled") });
                    return true;
                }
                case "continue": {
                    await this.ack(query);
                    await this.removeKeyboard(message.chat.id, message.message_id);
                    const messageId = await this.sendStep(draft, query.from);
                    await draftRepository.update(draft.userId, { promptMessageId: messageId });
                    return true;
                }
                case "restart": {
                    await this.ack(query);
                    await this.removeKeyboard(message.chat.id, message.message_id);
                    await draftRepository.delete(draft.userId);
                    await this.begin(query.from, draft.chatId);
                    return true;
                }
            }
        });
    }

    // Save & send to moderation (the draft was already taken atomically).
    private async createPost(draft: IDraft, from: TelegramUser): Promise<void> {
        const postData = this.postData(draft, from);
        const post: Post = await postRepository.createPost({
            userId: draft.userId,
            title: postData.title,
            description: postData.description,
            descriptionEntities: postData.descriptionEntities,
            price: postData.price,
            media: postData.media,
            location: postData.location,
            createdAt: new Date(),
        });

        // A published post already got its postApproved DM from PublishService.
        const outcome = await this.publishService.submitPost(post, postData);
        if (outcome === "moderation") {
            await this.api.sendMessage({ chat_id: draft.chatId, text: this.t(draft.locale, "postCreated") });
        }
        console.info("[INFO - WizardService.createPost] post created", { userId: from.id, postId: String(post._id), outcome });
    }
}
