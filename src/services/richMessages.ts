import { RichMessageBuilder, RichTextBuilder, richListItem } from "node-telegram-bot-api";
import type { InputRichMessage, RichText } from "node-telegram-bot-api/types";
import { AuthLevel } from "../types";
import type { StoredEntity } from "../models/Post";
import { BroadcastReport, truncateFailures } from "./broadcastUsersService";

type Wrap = (inner: RichText) => RichText;

function wrapperFor(e: StoredEntity, text: string): Wrap | null {
    switch (e.type) {
        case "bold": case "italic": case "underline": case "strikethrough": case "spoiler": case "code":
            return inner => ({ type: e.type, text: inner });
        case "pre":
            return inner => ({ type: "code", text: inner });
        case "text_link":
            return e.url ? inner => ({ type: "url", text: inner, url: e.url! }) : null;
        case "text_mention":
            return e.user ? inner => ({ type: "text_mention", text: inner, user: e.user! }) : null;
        case "custom_emoji": {
            // A leaf node: the emoji text is its fallback.
            const alt = text.slice(e.offset, e.offset + e.length);
            return e.custom_emoji_id ? () => ({ type: "custom_emoji", custom_emoji_id: e.custom_emoji_id!, alternative_text: alt }) : null;
        }
        default:
            return null;
    }
}

/**
 * Telegram entities -> v2 RichText, for the post description.
 *
 * Offsets/lengths are UTF-16 code units, i.e. plain JS string indices (an emoji
 * is 2, a Hebrew letter 1). The text is cut at every entity boundary; each piece
 * is wrapped in the entities covering it, outermost first (earlier start, then
 * longer). Consecutive pieces under the same entity share one node, so nested
 * entities nest and a partial overlap is split: A[0,5) B[3,8) becomes
 * A{"012", B{"34"}} then B{"567"}.
 *
 * Mapped: bold, italic, underline, strikethrough, spoiler, code, pre (as code),
 * text_link (url), text_mention, custom_emoji. Everything else (url, email,
 * mention, hashtag, cashtag, bot_command, phone_number, blockquote, ...) stays
 * plain text: Telegram detects links and mentions in rich text on its own.
 * With no usable entity it returns `text` itself, so unformatted posts are unchanged.
 */
export function entitiesToRichText(text: string, entities?: StoredEntity[]): RichText {
    type Item = { e: StoredEntity; start: number; end: number; wrap: Wrap };
    const items: Item[] = [];
    // A cut inside a surrogate pair would emit a broken emoji.
    const splitsPair = (i: number) => i > 0 && i < text.length && /[\uD800-\uDBFF]/.test(text[i - 1]) && /[\uDC00-\uDFFF]/.test(text[i]);

    for (const e of entities ?? []) {
        const start = e.offset;
        const end = e.offset + e.length;
        if (!(start >= 0 && e.length > 0 && end <= text.length) || splitsPair(start) || splitsPair(end)) continue;
        const wrap = wrapperFor(e, text);
        if (wrap) items.push({ e, start, end, wrap });
    }
    if (items.length === 0) return text;

    // Stable sort: entities with the same range keep Telegram's order.
    items.sort((a, b) => a.start - b.start || b.end - a.end);
    const points = [...new Set([0, text.length, ...items.flatMap(i => [i.start, i.end])])].sort((a, b) => a - b);

    const stack: { item: Item | null; children: RichText[] }[] = [{ item: null, children: [] }];
    const close = () => {
        const done = stack.pop()!;
        stack[stack.length - 1].children.push(done.item!.wrap(done.children.length === 1 ? done.children[0] : done.children));
    };

    for (let i = 0; i + 1 < points.length; i++) {
        const [from, to] = [points[i], points[i + 1]];
        const active = items.filter(it => it.start <= from && it.end >= to);
        let common = 0;
        while (common < active.length && stack[common + 1]?.item === active[common]) common++;
        while (stack.length - 1 > common) close();
        for (const item of active.slice(common)) stack.push({ item, children: [] });
        stack[stack.length - 1].children.push(text.slice(from, to));
    }
    while (stack.length > 1) close();
    return stack[0].children;
}

type Translate = (key: string, params?: Record<string, string | number | boolean>) => string;

// Section titles carry <b> tags for the old HTML path; strip them since rich
// headings style themselves. Command lines are "/cmd - desc": bold the command
// part so the list is scannable.
function commandItem(line: string) {
    const i = line.indexOf(" - ");
    const text = i === -1 ? line : new RichTextBuilder().bold(line.slice(0, i)).plain(line.slice(i)).build();
    return richListItem(b => b.paragraph(text));
}

/** The /help message; MOD and ADMIN levels add their command sections. */
export function buildHelpMessage(
    t: Translate,
    authLevel: AuthLevel,
    opts: { enableFaq?: boolean; donationsEnabled?: boolean }
): InputRichMessage {
    const heading = (key: string) => t(key).replace(/<\/?b>/g, "");
    const items = (keys: string[]) => keys.map(key => commandItem(t(key)));

    const generalCmds = ["helpStart", "helpNewPost", "helpCancel", "helpMyPosts", "helpLang", "helpHelp"];
    if (opts.enableFaq !== false) generalCmds.push("helpFaq");
    if (opts.donationsEnabled !== false) generalCmds.push("helpDonate");

    const message = new RichMessageBuilder()
        .heading(heading("helpTitle"), 2)
        .list(items(generalCmds));

    if (authLevel >= AuthLevel.MOD) {
        message
            .divider()
            .heading(heading("helpModSection"), 3)
            .list(items(["helpPending", "helpClearPending", "helpAuth", "helpStats"]));
    }

    if (authLevel >= AuthLevel.ADMIN) {
        message
            .divider()
            .heading(heading("helpAdminSection"), 3)
            .list(items(["helpConfig", "helpActiveUsers", "helpPromote", "helpDemote", "helpBroadcastTopic", "helpBroadcastUsers", "helpTest", "helpLabel"]));
    }

    return message.build();
}

/** The admin-facing /broadcastusers result; `mentionById` maps failed user ids to "@name". */
export function buildBroadcastReportMessage(
    t: Translate,
    report: BroadcastReport,
    mentionById: Map<string, string>
): InputRichMessage {
    const message = new RichMessageBuilder()
        .heading(t("broadcastUsersReportTitle"), 2)
        .paragraph(t("broadcastUsersReport", { sent: report.sent, failed: report.failures.length, total: report.total }));

    if (report.failures.length > 0) {
        const { shown, remainder } = truncateFailures(report.failures);
        message
            .divider()
            .list(shown.map(f => richListItem(b => b.paragraph(`• ${mentionById.get(f.userId) ?? "N/A"} (${f.userId}) — ${f.reason}`))));

        if (remainder > 0) message.paragraph(t("broadcastUsersMore", { n: remainder }));
    }

    return message.build();
}
