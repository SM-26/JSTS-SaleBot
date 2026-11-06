import type { Api } from "node-telegram-bot-api";
import type { IListing } from "../models/Listing";
import listingRepository from "../repositories/listingRepository";
import memberRepository from "../repositories/memberRepository";
import postRepository from "../repositories/postRepository";
import shadowLogRepository from "../repositories/shadowLogRepository";
import userRepository from "../repositories/userRepository";
import type { BotConfig } from "../types";
import { isMeetupLocation } from "./meetup";
import { findBlockedWord } from "./blockedWords";
import { buildBuyerNote, type ListingLine } from "./buyerCards";
import { isSearchable, parseQuery } from "./matchService";
import { sendNote } from "./ephemeralNotes";
import type { GroupListingService } from "./groupListingService";
import { localeService } from "./localeService";
import type { ClassifiedEvent } from "./shadowService";

const NOTE_GAP_MS = 6 * 3600_000;

export async function listingLines(listings: IListing[], groupListings: GroupListingService): Promise<ListingLine[]> {
    return Promise.all(listings.map(async (l): Promise<ListingLine> => {
        let link: string | undefined;
        if (l.source === "group") link = await groupListings.groupLink(l.messageIds[0]);
        else {
            const post = l.postId ? await postRepository.findById(l.postId) : null;
            if (post?.approvedMessageId) link = await groupListings.groupLink(post.approvedMessageId);
        }
        return { title: l.title ?? "", price: l.price, location: l.location, date: l.refreshedAt.toISOString().slice(0, 10), link, meetup: l.meetup === true || isMeetupLocation(l.location) };
    }));
}

// Tells a member, privately, which live listings match their "wanted" post (buyerMatches "on").
// Best effort: a failure here never throws.
export class BuyerNoteService {
    constructor(
        private api: Api,
        private config: BotConfig,
        private groupListings: GroupListingService,
        private botUsername: () => string
    ) { }

    async onClassified({ capture, result, shadowId, matches }: ClassifiedEvent, now: Date): Promise<void> {
        try {
            if (this.config.buyerMatches !== "on" || result.tier !== "wtb" || capture.chatId !== this.config.approvedGroupId) return;
            if (!isSearchable(parseQuery(capture.text))) return; // nothing to search for, so nothing to say
            const member = await memberRepository.findByUserId(capture.senderId);
            if (member?.askMode === "never") return;
            if (member?.lastBuyerNoteAt && now.getTime() - member.lastBuyerNoteAt.getTime() < NOTE_GAP_MS) return;

            const byId = new Map((await listingRepository.findByIds(matches ?? [])).map(l => [String(l._id), l]));
            const listings = (matches ?? []).map(id => byId.get(id)).filter((l): l is IListing => !!l && !findBlockedWord(l.title ?? ""));

            const locale = localeService.resolveUserLocale(await userRepository.findByUserId(capture.senderId));
            const card = buildBuyerNote((key, params) => localeService.t(locale, key, params), await listingLines(listings, this.groupListings), String(capture._id), this.botUsername());
            if ((await sendNote(this.api, this.config, Number(capture.senderId), card)) === null) return;
            await memberRepository.setLastBuyerNote(capture.senderId, now);
            await shadowLogRepository.setBuyerNote(shadowId, now);
        } catch (err) {
            console.error("[ERROR - BuyerNoteService.onClassified]", (err as Error).message);
        }
    }
}
