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
import type { GroupListingService } from "./groupListingService";
import type { Parsed } from "./classifier";
import { buildManagementCard } from "./listingCards";
import captureRepository from "../repositories/captureRepository";
import { isApiError } from "../config/telegramErrors";
import { isMeetupLocation } from "./meetup";
import { findBlockedField, findBlockedWord, withLinkUrls, BlockedFieldName } from "./blockedWords";
import { classify } from "./classifier";
import { isSearchable, matchListings, parseQuery } from "./matchService";
import { buildDmMatches, displayQuery } from "./buyerCards";
import { listingLines } from "./buyerNoteService";
import listingRepository from "../repositories/listingRepository";

type TextStep = "title" | "description" | "price" | "location";
type WizardAction = "done" | "confirm" | "cancel" | "continue" | "restart" | "editTitle" | "editPrice" | "editLocation" | "meetup";
type EditAction = "editTitle" | "editPrice" | "editLocation";
const EDIT_FIELD: Record<EditAction, TextStep> = { editTitle: "title", editPrice: "price", editLocation: "location" };

const TOTAL_STEPS = 5;
/** How long after the last album item the quick draft is finished (an album arrives as separate updates). */
export const QUICK_ALBUM_DELAY_MS = 1500;
const PROMPTS: Record<TextStep | "media", { key: string; index: number }> = {
    title: { key: "welcome", index: 1 },
    description: { key: "enterDescription", index: 2 },
    price: { key: "enterPrice", index: 3 },
    location: { key: "enterLocation", index: 4 },
    media: { key: "enterMedia", index: 5 },
};
const FIELD_LABEL: Record<BlockedFieldName, string> = { title: "fieldTitle", description: "fieldDescription", price: "fieldPrice", location: "fieldLocation" };
const NEXT_STEP: Record<TextStep, DraftStep> = { title: "description", description: "price", price: "location", location: "media" };

// Buttons already sent to Telegram keep their callback_data forever: these
// formats are v1's (draft_* are new). A press is only valid against the draft.
const CALLBACKS: { prefix: string; action: WizardAction }[] = [
    { prefix: "done_media_", action: "done" },
    { prefix: "confirm_", action: "confirm" },
    { prefix: "cancel_", action: "cancel" },
    { prefix: "draft_continue_", action: "continue" },
    { prefix: "draft_restart_", action: "restart" },
    { prefix: "draft_edit_title_", action: "editTitle" },
    { prefix: "draft_edit_price_", action: "editPrice" },
    { prefix: "draft_edit_location_", action: "editLocation" },
    { prefix: "draft_meetup_", action: "meetup" },
];
// The step a press must find the draft in; continue/restart work on any step.
const REQUIRED_STEP: Partial<Record<WizardAction, DraftStep>> = { done: "media", confirm: "confirm", cancel: "confirm", editTitle: "confirm", editPrice: "confirm", editLocation: "confirm" };

export function parseWizardCallback(data: string): { action: WizardAction; userId: string } | null {
    for (const { prefix, action } of CALLBACKS) {
        if (data.startsWith(prefix)) return { action, userId: data.slice(prefix.length).split("_")[0] };
    }
    return null;
}

type PromptTarget = Pick<IDraft, "userId" | "chatId" | "locale" | "step"> & Partial<Pick<IDraft, "meetup">>;

// The /newPost wizard as a step machine over the `drafts` collection: every
// update reads the user's draft, so a restart loses nothing.
export class WizardService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private inputService: InputService,
        private postService: PostService,
        private publishService: PublishService,
        private groupListings: GroupListingService
    ) { }

    // ponytail: in-memory timer holding only the user id (spec 8.1): a restart only loses the send,
    // /newpost then Continue resends. The draft itself is in Mongo; claimCollecting is the guard.
    private timers = new Map<string, NodeJS.Timeout>();

    private t(locale: string, key: string, params?: Record<string, string | number | boolean>): string {
        return localeService.t(locale, key, params);
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

    // quickListing: field-edit buttons and the Beit Dagan toggle. Off, the wizard is exactly the old one.
    private quickOn(): boolean {
        return this.config.quickListing === true;
    }

    private meetupButton(locale: string, userId: string, on: boolean | undefined) {
        const label = `📍 ${this.t(locale, "meetupPlace")}`;
        return { text: on ? `✅ ${label}` : label, callback_data: `draft_meetup_${userId}` };
    }

    private previewParts(draft: IDraft, from: TelegramUser) {
        const stamp = Date.now();
        const inline_keyboard: InlineKeyboardMarkup["inline_keyboard"] = [[
            { text: this.t(draft.locale, "confirmButton"), callback_data: `confirm_${draft.userId}_${stamp}` },
            { text: this.t(draft.locale, "cancelButton"), callback_data: `cancel_${draft.userId}_${stamp}` },
        ]];
        if (this.quickOn()) {
            inline_keyboard.push(
                [
                    { text: this.t(draft.locale, "editTitleButton"), callback_data: `draft_edit_title_${draft.userId}` },
                    { text: this.t(draft.locale, "editPriceButton"), callback_data: `draft_edit_price_${draft.userId}` },
                ],
                [
                    { text: this.t(draft.locale, "editLocationButton"), callback_data: `draft_edit_location_${draft.userId}` },
                    this.meetupButton(draft.locale, draft.userId, draft.meetup),
                ]
            );
        }
        return {
            rich_message: this.postService.formatPostRichMessage(this.postData(draft, from), { previewLabel: this.t(draft.locale, "preview") }),
            reply_markup: { inline_keyboard } as InlineKeyboardMarkup,
        };
    }

    private async sendPreview(draft: IDraft, from: TelegramUser): Promise<number> {
        // Preview & confirm as one message (buttons attached to the preview).
        const sent = await this.api.sendRichMessage({ chat_id: draft.chatId, ...this.previewParts(draft, from) });
        return sent.message_id;
    }

    // Redraws the live preview in place (after the meetup toggle). "Not modified" is fine.
    private async refreshPreview(draft: IDraft, from: TelegramUser): Promise<void> {
        try {
            await this.api.editMessageText({ chat_id: draft.chatId, message_id: draft.promptMessageId, ...this.previewParts(draft, from) });
        } catch (err) {
            if (!isApiError(err, 400, "message is not modified")) throw err;
        }
    }

    // Sends the prompt for `draft.step` (the preview for "confirm") and returns its message id.
    private async sendStep(draft: PromptTarget & Partial<IDraft>, from: TelegramUser, opts: { indicator?: boolean } = {}): Promise<number> {
        if (draft.step === "confirm") return this.sendPreview(draft as IDraft, from);

        const { key, index } = PROMPTS[draft.step];
        const markup: InlineKeyboardMarkup | undefined = draft.step === "media"
            ? { inline_keyboard: [[{ text: this.t(draft.locale, "doneMediaButton"), callback_data: `done_media_${draft.userId}` }]] }
            : draft.step === "location" && this.quickOn()
                ? { inline_keyboard: [[this.meetupButton(draft.locale, draft.userId, draft.meetup)]] }
                : undefined;
        // A capture draft skips most steps, and a field edit is one step: a "n of 5" indicator would lie.
        const indicator = draft.captureId || draft.quick || opts.indicator === false ? undefined : { locale: draft.locale, index, total: TOTAL_STEPS };
        const sent = await this.inputService.sendPrompt(draft.chatId, this.t(draft.locale, key), indicator, markup);
        return sent.message_id;
    }

    // The gate before the preview: a field with a blocked word is asked for again (the notice names the
    // word), and the answer comes straight back here. Trusted sellers are no exception.
    private async previewOrFix(draft: IDraft, from: TelegramUser): Promise<void> {
        const hit = findBlockedField({ title: draft.title, description: withLinkUrls(draft.description, draft.descriptionEntities), price: draft.price, location: draft.location });
        if (hit) {
            await this.api.sendMessage({
                chat_id: draft.chatId,
                text: localeService.t(draft.locale, "blockedWordNotice", { field: this.t(draft.locale, FIELD_LABEL[hit.field]), word: hit.word }),
            });
            const messageId = await this.sendStep({ userId: draft.userId, chatId: draft.chatId, locale: draft.locale, step: hit.field, captureId: draft.captureId, quick: draft.quick, meetup: draft.meetup }, from);
            await draftRepository.update(draft.userId, { step: hit.field, promptMessageId: messageId, fixing: true });
            return;
        }
        const messageId = await this.sendPreview(draft, from);
        await draftRepository.update(draft.userId, { step: "confirm", promptMessageId: messageId, fixing: undefined });
    }

    private postData(draft: IDraft, from: TelegramUser): PostData {
        return {
            title: draft.title ?? "",
            description: draft.description ?? "",
            descriptionEntities: draft.descriptionEntities?.length ? draft.descriptionEntities.map(storedEntity) : undefined,
            price: draft.price ?? "",
            location: draft.location ?? "",
            media: draft.media.map((m): MediaItem => ({ fileId: m.fileId, type: m.type })),
            meetup: draft.meetup || (this.quickOn() && isMeetupLocation(draft.location)) || undefined,
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

    /**
     * /start c_<captureId> (private): the wizard prefilled from the member's own group post, asking only
     * for what the note could not read. Never overwrites a live draft.
     */
    startFromCapture(msg: Message, captureId: string): Promise<boolean> {
        return this.safe("startFromCapture", msg.chat.id, async () => {
            const from = msg.from!;
            const userId = String(from.id);
            const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
            const say = async (key: string): Promise<boolean> => {
                await this.api.sendMessage({ chat_id: msg.chat.id, text: this.t(locale, key) });
                return true;
            };

            const capture = await captureRepository.findById(captureId);
            // A foreign id answers like an expired one.
            if (!capture || capture.senderId !== userId) return say("captureExpired");
            if (capture.state === "added") return say("captureAlreadyAdded");
            if (capture.state !== "classified" && capture.state !== "asked") return say("captureExpired");
            const existing = await draftRepository.findByUserId(userId);
            if (existing && !isDraftExpired(existing, this.config.timeOut)) return say("captureDraftBusy");

            const parsed: Partial<Parsed> = capture.parsed ?? {};
            const step: DraftStep = !parsed.title ? "title" : !parsed.price ? "price" : "confirm";
            const input = {
                userId, chatId: msg.chat.id, locale, captureId, step,
                // `parsed` is Mixed: a missing field may come back as null.
                title: parsed.title || undefined, description: parsed.description || undefined,
                price: parsed.price || undefined, location: parsed.location || undefined,
                media: capture.media.map(m => ({ fileId: m.fileId, type: m.type })),
            };
            if (step === "confirm") {
                const draft = await draftRepository.startFromCapture({ ...input, promptMessageId: 0 });
                try {
                    await this.previewOrFix(draft, from);
                } catch (err) {
                    await draftRepository.delete(userId); // no half-started draft
                    throw err;
                }
                return true;
            }
            const promptMessageId = await this.sendStep({ userId, chatId: msg.chat.id, locale, step, captureId }, from);
            await draftRepository.startFromCapture({ ...input, promptMessageId });
            return true;
        });
    }

    private mediaItem(msg: Message): { fileId: string; type: "photo" | "video" } | null {
        if (msg.photo?.length) return { fileId: msg.photo[msg.photo.length - 1].file_id, type: "photo" };
        if (msg.video) return { fileId: msg.video.file_id, type: "video" };
        return null;
    }

    private isQuickMessage(msg: Message): boolean {
        return this.mediaItem(msg) !== null && !!(msg.caption || msg.media_group_id);
    }

    // No draft yet: a photo/video with a caption, or any album item, starts a quick draft (quickListing only).
    private async quickStart(msg: Message): Promise<boolean> {
        const item = this.mediaItem(msg);
        if (!this.quickOn() || !item || !this.isQuickMessage(msg) || !msg.from) return false;
        const userId = String(msg.from.id);
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        const draft = await draftRepository.collectQuick({ userId, chatId: msg.chat.id, locale, item, caption: msg.caption, mediaGroupId: msg.media_group_id });
        if (!draft) return false;
        if (msg.media_group_id) this.scheduleFinish(userId, msg.from);
        else await this.finishQuick(userId, msg.from);
        return true;
    }

    private scheduleFinish(userId: string, from: TelegramUser): void {
        const old = this.timers.get(userId);
        if (old) clearTimeout(old);
        const timer = setTimeout(() => {
            this.timers.delete(userId);
            void this.safe("finishQuick", from.id, async () => { await this.finishQuick(userId, from); return true; });
        }, QUICK_ALBUM_DELAY_MS);
        timer.unref();
        this.timers.set(userId, timer);
    }

    // The album is complete (or a single photo arrived): read the caption and ask only for what is missing.
    private async finishQuick(userId: string, from: TelegramUser): Promise<void> {
        const draft = await draftRepository.claimCollecting(userId);
        if (!draft) return;
        const { tier, parsed } = classify(draft.caption ?? "", draft.media.length > 0);
        if (tier === "wtb" && draft.caption) {
            await draftRepository.delete(userId);
            await this.replyAsBuyer(draft, draft.caption);
            return;
        }
        const updated = await draftRepository.update(userId, {
            title: parsed.title, description: parsed.description, location: parsed.location,
            price: parsed.priceValue ? String(parsed.priceValue) : undefined, caption: undefined,
        });
        if (updated) await this.advance(updated, from);
    }

    // The first missing of title, price, (quick) media minimum; nothing missing is the preview.
    private async advance(draft: IDraft, from: TelegramUser): Promise<void> {
        const step: DraftStep | null = !draft.title ? "title" : !draft.price ? "price"
            : draft.quick && draft.media.length < (this.config.minimumPhotos ?? 0) ? "media" : null;
        if (!step) return this.previewOrFix(draft, from);
        const promptMessageId = await this.sendStep({ userId: draft.userId, chatId: draft.chatId, locale: draft.locale, step, captureId: draft.captureId, quick: draft.quick }, from, { indicator: false });
        await draftRepository.update(draft.userId, { step, promptMessageId });
    }

    // A wanted caption sent with photos: answer with the live matches (not their own), never a draft.
    private async replyAsBuyer(draft: IDraft, caption: string): Promise<void> {
        const q = parseQuery(caption);
        const live = (await listingRepository.findLiveForMatching()).filter(l => l.sellerId !== draft.userId);
        const byId = new Map(live.map(l => [String(l._id), l]));
        const listings = matchListings(q, live).flatMap(id => byId.get(id) ?? []).filter(l => !findBlockedWord(l.title ?? ""));
        const lines = await listingLines(listings, this.groupListings);
        const alertQuery = this.config.buyerMatches === "on" && isSearchable(q) ? displayQuery(q.query) : undefined;
        const card = buildDmMatches((key, params) => this.t(draft.locale, key, params), lines, alertQuery);
        await this.api.sendMessage({ chat_id: draft.chatId, text: card.text, parse_mode: "HTML" });
    }

    /** /start sell: with quickListing on and no live draft, say how to post in one message. */
    handleSell(msg: Message): Promise<boolean> {
        return this.safe("handleSell", msg.chat.id, async () => {
            const draft = await draftRepository.findByUserId(String(msg.from!.id));
            if (!this.quickOn() || (draft && !isDraftExpired(draft, this.config.timeOut))) return this.handleNewPost(msg);
            const locale = localeService.resolveUserLocale(await userRepository.findByUserId(String(msg.from!.id)));
            await this.api.sendMessage({ chat_id: msg.chat.id, text: this.t(locale, "quickSellHint") });
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
            if (!draft) return this.quickStart(msg);

            if (isDraftExpired(draft, this.config.timeOut)) {
                if (this.quickOn() && this.isQuickMessage(msg)) {
                    await draftRepository.deleteIfUnchanged(draft);
                    return this.quickStart(msg);
                }
                await this.expire(draft);
                return true;
            }

            const item = this.mediaItem(msg);
            if (draft.collecting && item) {
                await draftRepository.collectQuick({ userId: draft.userId, chatId: draft.chatId, locale: draft.locale, item, caption: msg.caption, mediaGroupId: msg.media_group_id });
                this.scheduleFinish(draft.userId, msg.from);
                return true;
            }
            if (item && msg.media_group_id && draft.mediaGroupId === msg.media_group_id && draft.step !== "media") {
                const updated = await draftRepository.pushLateMedia(draft.userId, msg.media_group_id, item);
                if (updated?.step === "confirm") await this.refreshPreview(updated, msg.from);
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

            if (draft.fixing) {
                const fields: DraftFields = { [draft.step]: msg.text };
                if (draft.step === "description") fields.descriptionEntities = msg.entities?.length ? msg.entities.map(storedEntity) : undefined;
                const updated = await draftRepository.update(draft.userId, fields);
                if (updated) await this.previewOrFix(updated, msg.from);
                return true;
            }

            // A capture or quick draft only asks for what is missing (title, price, and for a quick
            // draft the media minimum); the rest came with the post or the caption.
            if (draft.captureId || draft.quick) {
                const updated = await draftRepository.update(draft.userId, { [draft.step]: msg.text });
                if (updated) await this.advance(updated, msg.from);
                return true;
            }

            const next = NEXT_STEP[draft.step];
            const messageId = await this.sendStep({ userId: draft.userId, chatId: draft.chatId, locale: draft.locale, step: next, meetup: draft.meetup }, msg.from);
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
            if (this.isQuickAction(parsed.action) && !this.quickOn()) return false;
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
                    if (draft.quick) await this.advance(draft, query.from);
                    else await this.previewOrFix(draft, query.from);
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
                case "editTitle":
                case "editPrice":
                case "editLocation": {
                    await this.ack(query);
                    await this.removeKeyboard(message.chat.id, message.message_id);
                    const step = EDIT_FIELD[parsed.action];
                    const messageId = await this.sendStep({ userId: draft.userId, chatId: draft.chatId, locale: draft.locale, step, captureId: draft.captureId, meetup: draft.meetup }, query.from, { indicator: false });
                    await draftRepository.update(draft.userId, { step, promptMessageId: messageId, fixing: true });
                    return true;
                }
                case "meetup": {
                    if (draft.step !== "location" && draft.step !== "confirm") return false;
                    await this.ack(query);
                    const updated = await draftRepository.update(draft.userId, { meetup: draft.meetup ? undefined : true });
                    if (!updated) return true;
                    if (updated.step === "confirm") {
                        await this.refreshPreview(updated, query.from);
                    } else {
                        await this.api.editMessageReplyMarkup({ chat_id: draft.chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [[this.meetupButton(draft.locale, draft.userId, updated.meetup)]] } })
                            .catch((err: unknown) => { if (!isApiError(err, 400, "message is not modified")) throw err; });
                    }
                    return true;
                }
                case "continue": {
                    await this.ack(query);
                    await this.removeKeyboard(message.chat.id, message.message_id);
                    if (draft.collecting) {
                        await this.finishQuick(draft.userId, query.from);
                        return true;
                    }
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

    private isQuickAction(action: WizardAction): boolean {
        return action === "editTitle" || action === "editPrice" || action === "editLocation" || action === "meetup";
    }

    // Save & send to moderation (the draft was already taken atomically).
    private async createPost(draft: IDraft, from: TelegramUser): Promise<void> {
        if (draft.captureId) return this.finishCapture(draft, draft.captureId);
        const postData = this.postData(draft, from);
        const post: Post = await postRepository.createPost({
            userId: draft.userId,
            title: postData.title,
            description: postData.description,
            descriptionEntities: postData.descriptionEntities,
            price: postData.price,
            media: postData.media,
            location: postData.location,
            meetup: postData.meetup,
            createdAt: new Date(),
        });

        // A published post already got its postApproved DM from PublishService.
        const outcome = await this.publishService.submitPost(post, postData);
        if (outcome === "moderation") {
            await this.api.sendMessage({ chat_id: draft.chatId, text: this.t(draft.locale, "postCreated") });
        }
        console.info("[INFO - WizardService.createPost] post created", { userId: from.id, postId: String(post._id), outcome });
    }

    // A completed capture draft becomes a group listing (the member's own message stays where it is):
    // no posts row, no moderation message.
    private async finishCapture(draft: IDraft, captureId: string): Promise<void> {
        const t = (key: string, params?: Record<string, string | number | boolean>) => this.t(draft.locale, key, params);
        const say = (text: string, keyboard?: InlineKeyboardMarkup["inline_keyboard"]) =>
            this.api.sendMessage({ chat_id: draft.chatId, text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
        if (!draft.price) { // the wizard always asks for it: only a hand-edited draft gets here
            await say(t("generalError"));
            return;
        }
        try {
            const result = await this.groupListings.addToMarket(captureId, { title: draft.title ?? "", price: draft.price, location: draft.location || undefined, meetup: draft.meetup });
            if (result.kind === "gone") await say(t("captureExpired"));
            else if (result.kind === "already") await say(t("captureAlreadyAdded"));
            else {
                await say(t("capturePublished"));
                const card = buildManagementCard(t, result.listing, { surface: "c" });
                await say(card.text, card.keyboard);
                await this.groupListings.syncNote(result.listing);
            }
            console.info("[INFO - WizardService.finishCapture]", { userId: draft.userId, captureId, outcome: result.kind });
        } catch (err) {
            console.error("[ERROR - WizardService.finishCapture]", { userId: draft.userId, captureId }, (err as Error).message);
            throw err; // safe() tells the user; the capture was rolled back, so the button still works
        }
    }
}
