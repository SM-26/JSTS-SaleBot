import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api/types";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import userRepository from "../repositories/userRepository";
import type { BotConfig } from "../types";
import { findBlockedWord } from "./blockedWords";
import { parseCatchupFile, type CatchupFile, type CatchupItem } from "./catchupScan";
import { classify, textHash, tokenOverlap, tokens } from "./classifier";
import { deleteNote, sendNote } from "./ephemeralNotes";
import { isSameItem, type GroupListingService } from "./groupListingService";
import { buildCatchupList, buildCatchupNote, parseCatchupArg, type Translate } from "./listingCards";
import { localeService } from "./localeService";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
// R5: same window as REPOST_MS in shadowService; older posts would expire the moment they were listed
const FRESH_MS = 30 * 24 * 3600_000;

const isFresh = (item: CatchupItem, now: Date): boolean => now.getTime() - Date.parse(item.date) <= FRESH_MS;

// Catch-up offers: the admin imports a scan file and arms it; each seller gets one private note
// on their next sale-topic message, then picks items in a DM. Best effort: nothing here throws
// into the update loop.
export class CatchupService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private groupListings: GroupListingService,
        private botUsername: () => string
    ) { }

    private async translatorFor(userId: string): Promise<Translate> {
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        return (key, params) => localeService.t(locale, key, params);
    }

    private async reply(msg: Message, key: string, params?: Record<string, string | number>): Promise<void> {
        const t = await this.translatorFor(String(msg.from!.id));
        await this.api.sendMessage({ chat_id: msg.chat.id, text: t(key, params) });
    }

    // Admin-only; the caller has checked the role. `import` itself arrives as a document.
    async handleCommand(msg: Message, args: string): Promise<void> {
        const sub = args.trim().toLowerCase();
        if (sub === "send") {
            const n = await memberRepository.armCatchup(new Date());
            await this.reply(msg, "catchupArmed", { n });
            if (this.config.captureMode !== "optin") await this.reply(msg, "catchupNotOptin");
        } else if (sub === "import") {
            await this.reply(msg, "catchupNoFile");
        } else {
            await this.reply(msg, "catchupStatus", await memberRepository.catchupCounts());
            await this.reply(msg, "catchupUsage");
        }
    }

    async handleImportDocument(msg: Message): Promise<void> {
        const doc = msg.document!;
        let file: CatchupFile | null = null;
        if (!doc.file_size || doc.file_size <= MAX_FILE_BYTES) {
            try {
                const path = (await this.api.getFile({ file_id: doc.file_id })).file_path;
                const res = path ? await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${path}`) : null;
                if (res && !res.ok) console.error("[ERROR - CatchupService.import]", "download failed, status", res.status);
                const bytes = res?.ok ? await res.arrayBuffer() : null;
                if (bytes && bytes.byteLength <= MAX_FILE_BYTES) file = parseCatchupFile(JSON.parse(new TextDecoder().decode(bytes)));
            } catch (err) { // never the message: a fetch error can carry the URL, which holds the token
                console.error("[ERROR - CatchupService.import]", (err as Error).name);
            }
        }
        try {
            if (!file) return await this.reply(msg, "catchupBadFile");
            try {
                await this.reply(msg, "catchupImported", await this.importFile(file, new Date()));
            } catch (err) {
                console.error("[ERROR - CatchupService.import]", (err as Error).name);
                await this.reply(msg, "catchupBadFile");
            }
        } finally {
            // the file may hold member data: on every outcome take it out of the chat (the admin keeps a copy)
            await this.api.deleteMessage({ chat_id: msg.chat.id, message_id: msg.message_id })
                .catch((err: unknown) => console.warn("[WARN - CatchupService.import]", "delete failed:", (err as Error).message));
        }
    }

    // `skipped` counts sellers: already offered, "don't ask again", or nothing to offer.
    async importFile(file: CatchupFile, now: Date): Promise<{ sellers: number; items: number; skipped: number }> {
        const out = { sellers: 0, items: 0, skipped: 0 };
        for (const s of file.sellers) {
            if (s.items.length && await memberRepository.importCatchup(s.userId, s.items, now)) {
                out.sellers++;
                out.items += s.items.length;
            } else out.skipped++;
        }
        return out;
    }

    // Kill switch: only `optin` delivers (R3). Held offers wait. Never throws.
    async onSaleTopicMessage(senderId: string, now: Date): Promise<void> {
        if (this.config.captureMode !== "optin") return;
        try {
            await this.deliver(senderId, now);
        } catch (err) {
            console.error("[ERROR - CatchupService.onSaleTopicMessage]", (err as Error).message);
        }
    }

    // No mode check (the /test command uses it). True when the note went out.
    async deliver(userId: string, now: Date): Promise<boolean> {
        const member = await memberRepository.claimCatchupDelivery(userId, now);
        if (!member) return false;
        const memberId = String(member._id);
        let sent = false;
        try {
            const fresh = (member.pendingCatchup ?? []).filter(i => isFresh(i, now));
            if (!fresh.length) {
                await memberRepository.dropCatchup(memberId); // R5: nothing fresh, no note; the claim is released below
                return false;
            }
            const card = buildCatchupNote(await this.translatorFor(userId), { memberId, count: fresh.length }, this.botUsername());
            const ephemeralMessageId = await sendNote(this.api, this.config, Number(userId), card);
            if (ephemeralMessageId === null) return false;
            sent = true;
            await memberRepository.setCatchupNote(userId, ephemeralMessageId);
            return true;
        } catch (err) {
            console.error("[ERROR - CatchupService.deliver]", (err as Error).message);
            return sent;
        } finally {
            if (!sent) await memberRepository.releaseCatchupDelivery(userId).catch(() => undefined); // R8
        }
    }

    // /start k_<memberId>. False: not ours to answer, the caller sends the greeting.
    async handleStart(msg: Message, memberId: string, now: Date): Promise<boolean> {
        if (msg.chat.type !== "private" || !msg.from) return false;
        const member = await memberRepository.findById(memberId);
        if (!member || member.userId !== String(msg.from.id) || !member.catchup?.sentAt) return false;
        const t = await this.translatorFor(member.userId);
        const items = (member.pendingCatchup ?? []).filter(i => isFresh(i, now));
        const card = items.length ? buildCatchupList(t, { memberId, items }) : { text: t("catchupNothingLeft"), keyboard: [] };
        await this.api.sendMessage({ chat_id: msg.chat.id, text: card.text, ...(card.keyboard.length ? { reply_markup: { inline_keyboard: card.keyboard } } : {}) });
        return true;
    }

    // ck_<memberId>_<x|messageId>. One answer per press; the note id always comes from the member.
    async handleCallback(query: CallbackQuery, arg: string, now = new Date()): Promise<void> {
        let locale = this.config.lang;
        let answered = false;
        const answer = async (key?: string): Promise<void> => {
            if (answered) return;
            answered = true;
            try {
                await this.api.answerCallbackQuery({ callback_query_id: query.id, ...(key ? { text: localeService.t(locale, key) } : {}) });
            } catch (err) {
                console.error("[ERROR - CatchupService.handleCallback]", "answerCallbackQuery failed:", (err as Error).message);
            }
        };

        try {
            const from = String(query.from.id);
            locale = localeService.resolveUserLocale(await userRepository.findByUserId(from));
            const parsed = parseCatchupArg(arg);
            const member = parsed ? await memberRepository.findById(parsed.memberId) : null;
            if (!parsed || !member) return await answer("staleButton");
            if (member.userId !== from) return await answer("notYourButton");
            if (!member.catchup?.sentAt) return await answer("staleButton"); // not delivered: a forged button

            if (parsed.action === "x") {
                await memberRepository.dropCatchup(parsed.memberId);
                const noteId = member.catchup.note?.ephemeralMessageId;
                if (noteId !== undefined) await deleteNote(this.api, this.config.approvedGroupId, Number(from), noteId);
                return await answer();
            }

            // atomic: a double press has one winner; the item stays gone on every refusal below
            const item = await memberRepository.takeCatchupItem(parsed.memberId, parsed.messageId);
            if (!item) return await answer("captureAlreadyAdded");
            // the item was taken: every ending below re-renders the DM list, so no dead button stays
            const rerender = async (): Promise<void> => {
                if (query.message?.chat.type !== "private") return;
                const remaining = ((await memberRepository.findById(parsed.memberId))?.pendingCatchup ?? []).filter(i => isFresh(i, now));
                const card = buildCatchupList(await this.translatorFor(from), { memberId: parsed.memberId, items: remaining });
                await this.api.editMessageText({ chat_id: query.message.chat.id, message_id: query.message.message_id, text: card.text, reply_markup: { inline_keyboard: card.keyboard } });
            };
            if (findBlockedWord([item.title, item.price, item.location, item.text].filter(Boolean).join("\n")) || !isFresh(item, now)) {
                await answer("staleButton");
                return await rerender();
            }
            // the item is gone from the offer: any failure up to the listing puts it back
            try {
                const parsedItem = classify(item.text, false).parsed;
                const hash = textHash(item.text);
                const tk = tokens(item.text);
                const recent = await listingRepository.findSellerRecent(from, new Date(now.getTime() - FRESH_MS));
                // isSameItem alone is title equality: it needs the texts to overlap first (as in shadowService)
                if (recent.some(l => (l.textHash === hash || tokenOverlap(tk, tokens(l.text ?? "")) >= 0.8) && isSameItem(l, item.text, parsedItem))) {
                    await answer("captureAlreadyAdded");
                } else {
                    await this.groupListings.addCatchupItem({ userId: from, name: [query.from.first_name, query.from.last_name].filter(Boolean).join(" ") }, item, now);
                    await answer("captureAddedToast");
                }
            } catch (err) {
                console.error("[ERROR - CatchupService.handleCallback]", { memberId: parsed.memberId }, (err as Error).message);
                await memberRepository.restoreCatchupItem(parsed.memberId, item);
                return await answer("staleButton");
            }
            await rerender();
        } catch (err) {
            console.error("[ERROR - CatchupService.handleCallback]", (err as Error).message);
            await answer("staleButton");
        }
    }
}
