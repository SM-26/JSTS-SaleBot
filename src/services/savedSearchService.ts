import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api/types";
import captureRepository from "../repositories/captureRepository";
import draftRepository from "../repositories/draftRepository";
import savedSearchRepository from "../repositories/savedSearchRepository";
import userRepository from "../repositories/userRepository";
import type { BotConfig, UserSession } from "../types";
import { buildAlertsList, describeSearch, parseAlertArg } from "./buyerCards";
import type { Translate } from "./listingCards";
import { localeService } from "./localeService";
import { isSearchable, parseQuery } from "./matchService";

const MAX_SEARCHES = 5;
const FIX_WINDOW_MS = 3600_000;

const listCard = (t: Translate, rows: { _id: unknown; query: string; maxPrice?: number; meetup?: boolean; expiresAt: Date }[]) =>
    buildAlertsList(t, rows.map((s) => ({ id: String(s._id), query: s.query, maxPrice: s.maxPrice, meetup: s.meetup, expiresAt: s.expiresAt })));

// A buyer's saved searches in the DM: the s_ link, /alerts, the one-reply fix and the al_ buttons.
// `session` is the UserSession data of the chat; it is mutated inside the middleware chain only.
export class SavedSearchService {
    constructor(private api: Api, private config: BotConfig) { }

    private on(): boolean {
        return this.config.buyerMatches === "on";
    }

    private async translatorFor(userId: string): Promise<Translate> {
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        return (key, params) => localeService.t(locale, key, params);
    }

    async handleStartLink(msg: Message, captureId: string, session?: UserSession): Promise<void> {
        const from = String(msg.from!.id);
        const t = await this.translatorFor(from);
        const capture = /^[0-9a-f]{24}$/.test(captureId) ? await captureRepository.findById(captureId) : null;
        if (!capture || capture.senderId !== from) {
            await this.api.sendMessage({ chat_id: msg.chat.id, text: t("alertLinkExpired") });
            return;
        }
        await this.saveFromText(msg, capture.text, t, session);
    }

    async handleAlerts(msg: Message, args: string, session?: UserSession): Promise<void> {
        const from = String(msg.from!.id);
        const t = await this.translatorFor(from);
        const text = args.trim();
        if (text) {
            if (!this.on()) await this.api.sendMessage({ chat_id: msg.chat.id, text: t("alertsNotAvailable") });
            else await this.saveFromText(msg, text, t, session);
            return;
        }
        const searches = await savedSearchRepository.findByUser(from, new Date());
        if (!this.on() && searches.length === 0) {
            await this.api.sendMessage({ chat_id: msg.chat.id, text: t("alertsNotAvailable") });
            return;
        }
        const card = listCard(t, searches);
        await this.api.sendMessage({ chat_id: msg.chat.id, text: card.text, reply_markup: { inline_keyboard: card.keyboard } });
    }

    // Parses, checks the limit, upserts and answers; leaves the one-reply fix in the session.
    private async saveFromText(msg: Message, text: string, t: Translate, session?: UserSession): Promise<void> {
        const from = String(msg.from!.id);
        const q = parseQuery(text);
        const send = async (key: string): Promise<number> =>
            (await this.api.sendMessage({ chat_id: msg.chat.id, text: t(key, { query: describeSearch(t, q) }) })).message_id;
        if (!isSearchable(q)) {
            const promptId = await send("alertNotSearchable");
            if (session) session.pendingAlertFix = { promptId, at: Date.now() };
            return;
        }
        const now = new Date();
        const mine = await savedSearchRepository.findByUser(from, now);
        if (mine.length >= MAX_SEARCHES && !mine.some((s) => s.query === q.query)) {
            if (session) delete session.pendingAlertFix;
            await send("alertLimit");
            return;
        }
        const existing = mine.find((s) => s.query === q.query);
        // the same query again carries a possibly new ceiling or meeting point; an identical press must not move the scan cursor
        const changed = existing && (existing.maxPrice !== q.maxPrice || existing.meetup !== q.meetup);
        const row = (changed && await savedSearchRepository.update(String(existing._id), q, now)) || existing || await savedSearchRepository.upsert(from, q, now);
        const promptId = await send("alertSaved");
        if (session) session.pendingAlertFix = { searchId: String(row._id), promptId, at: Date.now() };
    }

    // True when the message was the answer to the pending fix (a reply to the prompt, or no wizard is running).
    async handleFixReply(msg: Message, session?: UserSession): Promise<boolean> {
        const pending = session?.pendingAlertFix;
        if (!session || !pending || !msg.from) return false;
        if (Date.now() - pending.at >= FIX_WINDOW_MS || !msg.text || msg.text.startsWith("/")) return false;
        const from = String(msg.from.id);
        if (msg.reply_to_message?.message_id !== pending.promptId && await draftRepository.findByUserId(from)) return false;
        if (!this.on()) {
            delete session.pendingAlertFix;
            return false;
        }

        const t = await this.translatorFor(from);
        const q = parseQuery(msg.text);
        const reply = (key: string) => this.api.sendMessage({ chat_id: msg.chat.id, text: t(key, { query: describeSearch(t, q) }) });
        if (!isSearchable(q)) {
            if (pending.searchId) { // a thanks after saving, not a failed attempt
                delete session.pendingAlertFix;
                return false;
            }
            await reply("alertNotSearchable");
            return true;
        }
        const now = new Date();
        const mine = await savedSearchRepository.findByUser(from, now);
        const own = pending.searchId ? mine.find((s) => String(s._id) === pending.searchId) : undefined;
        if (mine.some((s) => s.query === q.query && s !== own)) {
            await reply("alertDuplicate");
            return true;
        }
        if (own) {
            await savedSearchRepository.update(String(own._id), q, now);
            await reply("alertUpdated");
        } else if (mine.length >= MAX_SEARCHES) {
            await reply("alertLimit");
            return true;
        } else {
            await savedSearchRepository.upsert(from, q, now);
            await reply("alertSaved");
        }
        delete session.pendingAlertFix;
        return true;
    }

    // al_<searchId>_<d|r>: delete or renew. Works in every mode, so a member can always clean up.
    async handleCallback(query: CallbackQuery, arg: string, now = new Date()): Promise<void> {
        let answered = false;
        let t: Translate = (key) => key;
        const answer = async (key?: string): Promise<void> => {
            if (answered) return;
            answered = true;
            try {
                await this.api.answerCallbackQuery({ callback_query_id: query.id, ...(key ? { text: t(key) } : {}) });
            } catch (err) {
                console.error("[ERROR - SavedSearchService.handleCallback]", "answerCallbackQuery failed:", (err as Error).message);
            }
        };

        try {
            const from = String(query.from.id);
            t = await this.translatorFor(from);
            const parsed = parseAlertArg(arg);
            const search = parsed ? await savedSearchRepository.findById(parsed.searchId) : null;
            if (!parsed || !search) return await answer("staleButton");
            if (from !== search.userId) return await answer("notYourButton");
            const msg = query.message && query.message.message_id ? query.message : undefined;

            if (parsed.action === "d") {
                if (!(await savedSearchRepository.deleteOne(parsed.searchId, from))) return await answer("staleButton");
                await answer("alertDeletedToast");
                if (msg) {
                    const card = listCard(t, await savedSearchRepository.findByUser(from, now));
                    await this.api.editMessageText({ chat_id: msg.chat.id, message_id: msg.message_id, text: card.text, reply_markup: { inline_keyboard: card.keyboard } });
                }
                return;
            }
            if (!(await savedSearchRepository.renew(parsed.searchId, from, now))) return await answer("staleButton");
            await answer("alertRenewedToast");
            if (msg) await this.api.editMessageReplyMarkup({ chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
        } catch (err) {
            console.error("[ERROR - SavedSearchService.handleCallback]", (err as Error).message);
            await answer("staleButton");
        }
    }
}
