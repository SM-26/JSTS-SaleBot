import { RichMessageBuilder, RichTextBuilder, richListItem } from "node-telegram-bot-api";
import type { InputRichMessage } from "node-telegram-bot-api/types";
import { AuthLevel } from "../types";
import { BroadcastReport, truncateFailures } from "./broadcastUsersService";

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
            .list(items(["helpPending", "helpClearPending", "helpAuth"]));
    }

    if (authLevel >= AuthLevel.ADMIN) {
        message
            .divider()
            .heading(heading("helpAdminSection"), 3)
            .list(items(["helpConfig", "helpActiveUsers", "helpPromote", "helpDemote", "helpBroadcastTopic", "helpBroadcastUsers", "helpTest"]));
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
