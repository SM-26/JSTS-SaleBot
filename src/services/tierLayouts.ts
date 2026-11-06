import { RichMessageBuilder, RichTextBuilder, richMessageButton, richTableCell } from "node-telegram-bot-api";
import type { RichTextContent } from "node-telegram-bot-api";
import type { InputRichMessage } from "node-telegram-bot-api/types";
import type { MediaItem } from "../types";
import type { PostData } from "./postService";
import type { SellerTier } from "./trustService";
import { localeService } from "./localeService";
import { entitiesToRichText } from "./richMessages";
import { MEETUP_FAQ_PAYLOAD, meetupLocationParts } from "./meetup";
import { deepLink } from "./deepLinks";

// The layouts the owner approved from the mockups (scripts/mockRichPosts.ts on experiment/rich-posts):
//   top      -> V   price first, compact, slideshow, foldable description, trust footer
//   verified -> G4  big title, marked price and seller line, slideshow, table, foldable description, trust footer
//   both     -> X2  banner, G4 plus seller stats in the table, colored contact button (no map)
// Regular sellers keep PostService's own layout; this file never builds that one.
export type TierLayoutOpts = { tier: Exclude<SellerTier, "regular">; sold?: boolean; stats?: { sold: number; since: string } };

const t = () => new RichTextBuilder();

// The location as rich text; the words of the meeting point link to its FAQ node (a button would not survive a Sold edit).
function locationText(data: PostData, lang: string, botUsername: string, prefix = ""): RichTextBuilder | null {
    if (!data.meetup) return data.location ? t().plain(prefix + data.location) : null;
    const { before, place } = meetupLocationParts(data.location, localeService.t(lang, "meetupPlace"));
    const text = t().plain(prefix + before);
    return botUsername ? text.url(place, deepLink(botUsername, MEETUP_FAQ_PAYLOAD)) : text.plain(place);
}

const MARKS: Record<Exclude<SellerTier, "regular">, string> = { top: "🏅", verified: "✅", both: "🏅✅" };

// "🏅 Top seller · 12 sales · in the market since November 2026"
function trustFooter(lang: string, tier: TierLayoutOpts["tier"], stats?: TierLayoutOpts["stats"]): string {
    const label = localeService.t(lang, tier === "top" ? "tierTopLabel" : tier === "verified" ? "tierVerifiedLabel" : "tierBothLabel");
    return [
        label,
        stats && stats.sold > 0 ? localeService.t(lang, "tierSales", { n: stats.sold }) : "",
        stats?.since ? localeService.t(lang, "tierSince", { since: stats.since }) : "",
    ].filter(Boolean).join(" · ");
}

export function buildTierMessage(data: PostData, o: TierLayoutOpts, lang: string, botUsername: string): InputRichMessage {
    const tr = (key: string) => localeService.t(lang, key);
    const mark = MARKS[o.tier];
    const sold = Boolean(o.sold);
    const b = new RichMessageBuilder();

    const priceText = sold ? t().strikethrough(data.price) : t().marked(t().bold(data.price));
    const nameBold = data.username ? `@${data.username}` : data.firstName || "User";
    // The seller as a link (@username mention, or a text mention of the first name).
    const sellerLink = (prefix: string): RichTextBuilder => {
        const builder = t().plain(prefix);
        if (data.username) return builder.mention(`@${data.username}`, data.username);
        const name = data.firstName || "User";
        return builder.textMention(name, { id: data.userId, is_bot: false, first_name: name });
    };

    if (o.tier === "both") b.paragraph(t().marked(t().bold(tr("tierBannerBoth"))));
    b.heading(sold ? t().strikethrough(data.title) : data.title, o.tier === "top" ? 2 : 1);
    b.paragraph(priceText);
    if (o.tier !== "top") b.paragraph(t().marked(t().plain(`${tr("tierSellerLabel")} ${mark} `).bold(nameBold)));
    if (sold) b.paragraph(t().marked(t().bold(tr("soldTag"))));

    const addMedia = (x: RichMessageBuilder, m: MediaItem) =>
        m.type === "video" ? x.video({ type: "video", media: m.fileId }) : x.photo({ type: "photo", media: m.fileId });
    if (data.media.length === 1) addMedia(b, data.media[0]);
    else if (data.media.length > 1) b.slideshow(x => data.media.forEach(m => addMedia(x, m)));

    if (o.tier === "top") {
        const line = locationText(data, lang, botUsername, "📍 ");
        if (line) b.paragraph(line);
    } else {
        const location = locationText(data, lang, botUsername);
        const row = (k: string, v: RichTextContent) => [richTableCell(k, { is_header: true, align: "right", valign: "middle" }), richTableCell(v, { align: "right", valign: "middle" })];
        const rows = [
            ...(location ? [row(tr("tierLocationRow"), location)] : []),
            row(tr("tierSellerRow"), sellerLink(`${mark} `)),
            ...(o.tier === "both" && o.stats ? [
                ...(o.stats.sold > 0 ? [row(tr("tierSalesRow"), String(o.stats.sold))] : []),
                ...(o.stats.since ? [row(tr("tierSinceRow"), o.stats.since)] : []),
            ] : []),
        ];
        b.table(rows, { is_compact: true, is_striped: true });
    }

    if (data.description) b.details(tr("tierDescription"), x => x.paragraph(entitiesToRichText(data.description, data.descriptionEntities)));
    if (o.tier === "top") b.paragraph(sellerLink(`${mark} ${tr("tierSellerLabel")} `));

    // A real link to the seller; nobody without a username has one, and a closed listing needs none.
    if (o.tier !== "top" && !sold && data.username) {
        b.buttons([richMessageButton(tr("tierContactButton"), { url: `https://t.me/${data.username}`, style: o.tier === "both" ? "success" : "primary" })]);
    }

    const footer = trustFooter(lang, o.tier, o.stats);
    b.footer(sold ? `${tr("soldClosed")} · ${footer}` : o.tier === "both" ? t().bold(footer) : footer);

    return b.build(lang === "he" ? { is_rtl: true } : undefined);
}
