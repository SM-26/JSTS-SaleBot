import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery } from "node-telegram-bot-api/types";
import type { IListing } from "../models/Listing";
import type { ICapture } from "../models/Capture";
import captureRepository from "../repositories/captureRepository";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import userRepository from "../repositories/userRepository";
import type { BotConfig } from "../types";
import { findBlockedWord, withLinkUrls } from "./blockedWords";
import { textHash, type Parsed } from "./classifier";
import { deleteNote, editNote, sendNote } from "./ephemeralNotes";
import { isSameItem, type GroupListingService } from "./groupListingService";
import { buildAskNote, buildManagementCard, buildNeverNote, parseCaptureArg, type Translate } from "./listingCards";
import { localeService } from "./localeService";
import type { ClassifiedEvent } from "./shadowService";

const DAY_MS = 24 * 3600_000;
const NOTES_PER_DAY = 3;

// Tells a member, privately, what the bot saw in their sale post: asks once whether to
// add it, or says a repost renewed the listing. Best effort: a failure here never throws.
export class CaptureNoteService {
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

    private async underDailyCap(senderId: string, now: Date): Promise<boolean> {
        return (await captureRepository.countNotesSince(senderId, new Date(now.getTime() - DAY_MS))) < NOTES_PER_DAY;
    }

    async onClassified({ capture, result, mergeWith }: ClassifiedEvent, now: Date): Promise<void> {
        try {
            if (this.config.captureMode !== "optin" || capture.chatId !== this.config.approvedGroupId) return;
            if (result.tier !== "strict" && result.tier !== "ask") return;
            const id = String(capture._id);
            const ignore = () => captureRepository.transition(id, ["classified"], "ignored");

            if (findBlockedWord(withLinkUrls(capture.text, capture.parts.flatMap(p => p.entities ?? [])))) {
                await ignore();
                return;
            }

            const never = (await memberRepository.findByUserId(capture.senderId))?.askMode === "never";

            if (mergeWith) {
                const listing = await listingRepository.findById(mergeWith);
                if (!listing) {
                    await ignore();
                    return;
                }
                if (isSameItem(listing, capture.text, result.parsed)) {
                    const refreshed = listing.source === "group" ? await this.groupListings.refreshFromRepost(listing, capture, result.parsed, now) : null;
                    await ignore(); // a bot listing, or a lost race, stays silent
                    if (!refreshed) return;
                    await captureRepository.setListing(id, String(refreshed._id));
                    if (!never && await this.underDailyCap(capture.senderId, now)) await this.sendRefreshNote(refreshed, capture, now);
                    return;
                }
                // another item that merely reads alike: it gets its own note below
            }

            if (never) {
                await ignore();
                return;
            }
            // R1: every text a note was sent for is remembered for 30 days, answered or not
            if (await memberRepository.wasAskedRecently(capture.senderId, textHash(capture.text), now)) {
                await ignore();
                return;
            }
            if (!(await this.underDailyCap(capture.senderId, now))) return; // stays classified
            await this.sendAskNote(capture, result.parsed, now);
        } catch (err) {
            console.error("[ERROR - CaptureNoteService.onClassified]", (err as Error).message);
        }
    }

    // No mode check (the /test command uses it). False when the capture is no longer
    // `classified` or the note could not be sent (the capture is back to `classified`).
    async sendAskNote(capture: ICapture, parsed: Parsed, now: Date): Promise<boolean> {
        const id = String(capture._id);
        if (!(await captureRepository.transition(id, ["classified"], "asked"))) return false;
        try {
            const card = buildAskNote(await this.translatorFor(capture.senderId), { id, parsed }, this.botUsername());
            const ephemeralMessageId = await sendNote(this.api, this.config, Number(capture.senderId), card);
            if (ephemeralMessageId === null) {
                await captureRepository.transition(id, ["asked"], "classified");
                return false;
            }
            // The note is out: from here the capture stays `asked` whatever the bookkeeping does.
            try {
                await captureRepository.setNote(id, { ephemeralMessageId, sentAt: now, kind: "ask" });
            } catch (err) {
                console.error("[ERROR - captureNote.record]", { captureId: id }, "setNote:", (err as Error).message);
            }
            try {
                await memberRepository.rememberAsked(capture.senderId, textHash(capture.text), now);
            } catch (err) {
                console.error("[ERROR - captureNote.record]", { captureId: id }, "rememberAsked:", (err as Error).message);
            }
            return true;
        } catch (err) { // the note was never sent
            console.error("[ERROR - CaptureNoteService.sendAskNote]", (err as Error).message);
            await captureRepository.transition(id, ["asked"], "classified");
            return false;
        }
    }

    // `listing` is the refreshed one; its `note` is still the previous card.
    async sendRefreshNote(listing: IListing, capture: ICapture, now: Date): Promise<boolean> {
        try {
            const card = buildManagementCard(await this.translatorFor(listing.sellerId), listing, { surface: "n", botUsername: this.botUsername(), refreshed: true });
            const ephemeralMessageId = await sendNote(this.api, this.config, Number(listing.sellerId), card);
            if (ephemeralMessageId === null) return false;
            const previous = listing.note?.ephemeralMessageId;
            await captureRepository.setNote(String(capture._id), { ephemeralMessageId, sentAt: now, kind: "refresh" });
            await listingRepository.setNote(String(listing._id), { ephemeralMessageId, sentAt: now });
            if (previous !== undefined) await deleteNote(this.api, capture.chatId, Number(listing.sellerId), previous);
            return true;
        } catch (err) {
            console.error("[ERROR - CaptureNoteService.sendRefreshNote]", (err as Error).message);
            return false;
        }
    }

    // mk_<captureId>_<a|n|x>: Add, Not now, Don't ask again. One answer per press; the note id
    // and chat always come from the capture, never from query.message.
    async handleCallback(query: CallbackQuery, arg: string, now = new Date()): Promise<void> {
        let locale = this.config.lang;
        let answered = false;
        const answer = async (key?: string): Promise<void> => {
            if (answered) return;
            answered = true;
            try {
                await this.api.answerCallbackQuery({ callback_query_id: query.id, ...(key ? { text: localeService.t(locale, key) } : {}) });
            } catch (err) {
                console.error("[ERROR - CaptureNoteService.handleCallback]", "answerCallbackQuery failed:", (err as Error).message);
            }
        };

        try {
            const from = String(query.from.id);
            locale = localeService.resolveUserLocale(await userRepository.findByUserId(from));
            const parsed = parseCaptureArg(arg);
            if (!parsed) return await answer("staleButton");
            const capture = await captureRepository.findById(parsed.captureId); // null: the capture row expired
            if (!capture) return await answer("staleButton");
            if (from !== capture.senderId) return await answer("notYourButton");

            if (parsed.action === "a") {
                const { title, price, location } = capture.parsed ?? {};
                if (!title || !price) return await answer("staleButton"); // only a forged button gets here
                const result = await this.groupListings.addToMarket(parsed.captureId, { title, price, location }, now);
                if (result.kind === "gone") return await answer("staleButton");
                if (result.listing) await this.groupListings.syncNote(result.listing); // the note becomes the management card
                return await answer(result.kind === "added" ? "captureAddedToast" : "captureAlreadyAdded");
            }

            // Only an unanswered note can be declined: a stale press never overwrites a management card.
            if (!(await captureRepository.transition(parsed.captureId, ["asked"], "declined"))) return await answer("staleButton");
            if (parsed.action === "x") await memberRepository.setAskMode(from, "never", now); // first: the choice must stick even if the rest fails
            const hash = textHash(capture.text);
            // R1: the text was remembered when the note went out; this only covers a memory that lapsed since.
            if (!(await memberRepository.wasAskedRecently(from, hash, now))) await memberRepository.rememberAsked(from, hash, now);
            const noteId = capture.note?.ephemeralMessageId;
            if (parsed.action === "n") {
                if (noteId !== undefined) await deleteNote(this.api, capture.chatId, Number(from), noteId);
            } else {
                const t: Translate = (key, params) => localeService.t(locale, key, params);
                if (noteId !== undefined) await editNote(this.api, capture.chatId, Number(from), noteId, buildNeverNote(t, this.botUsername()));
            }
            await answer();
        } catch (err) {
            console.error("[ERROR - CaptureNoteService.handleCallback]", (err as Error).message);
            await answer("staleButton");
        }
    }
}
