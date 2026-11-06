import type { Api } from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api/types";
import shadowLogRepository, { ShadowStats } from "../repositories/shadowLogRepository";
import listingRepository from "../repositories/listingRepository";
import captureRepository from "../repositories/captureRepository";
import savedSearchRepository from "../repositories/savedSearchRepository";
import alertLogRepository from "../repositories/alertLogRepository";
import userRepository from "../repositories/userRepository";
import { AuthLevel, BotConfig } from "../types";
import { localeService } from "./localeService";

const DAY_MS = 24 * 3600 * 1000;
const GATE_MIN_LABELED = 100;
const GATE_MIN_PRECISION = 0.97;

const pct = (num: number, den: number, digits = 0) => den > 0 ? `${(100 * num / den).toFixed(digits)}%` : "—";
// Reposts merged out of the sale posts (strict + ask) that could have been one.
export const mergedPct = (s: ShadowStats) => pct(s.merges, s.byTier.strict + s.byTier.ask);

// Admin tools for the shadow classifier: /label (hand-label would-list rows)
// and /stats (the numbers behind the go/no-go on automatic capture).
export class ShadowAdminService {
    // The group's public @username (or "" when it has none), looked up once per process.
    private groupUsername?: string;

    constructor(private api: Api, private config: BotConfig) { }

    private async localeOf(userId: number): Promise<string> {
        return localeService.resolveUserLocale(await userRepository.findByUserId(String(userId)));
    }

    private async groupName(): Promise<string> {
        if (this.groupUsername === undefined) {
            try {
                const chat = await this.api.getChat({ chat_id: this.config.approvedGroupId });
                this.groupUsername = (chat as { username?: string }).username ?? "";
            } catch (err) {
                console.error("[ERROR - shadowAdmin.groupName]", (err as Error).message);
                return ""; // not cached: try again next time
            }
        }
        return this.groupUsername;
    }

    private async linkTo(row: { chatId: number; messageIds: number[] }): Promise<string> {
        // the public @username belongs to the approved group only
        const name = row.chatId === this.config.approvedGroupId ? await this.groupName() : "";
        const messageId = row.messageIds[0];
        return name
            ? `https://t.me/${name}/${messageId}`
            : `https://t.me/c/${String(Math.abs(row.chatId)).replace(/^100/, "")}/${messageId}`;
    }

    // The next row to label as message text plus buttons, or the "nothing left" text.
    private async nextRow(locale: string, excludeId?: string): Promise<{ text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }> {
        const row = await shadowLogRepository.sampleUnlabeled(excludeId);
        if (!row) return { text: localeService.t(locale, "labelEmpty"), reply_markup: { inline_keyboard: [] } };
        const id = String(row._id);
        return {
            text: `${await this.linkTo(row)}\n${row.tier} · ${row.parsedPriceValue ?? "—"}`,
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(locale, "labelSale"), callback_data: `lb_${id}_s` },
                    { text: localeService.t(locale, "labelNotSale"), callback_data: `lb_${id}_n` },
                    { text: localeService.t(locale, "labelSkip"), callback_data: `lb_${id}_k` },
                ]],
            },
        };
    }

    // The next wanted post with matches: its link, then one plain-text line per match.
    private async nextMatchRow(locale: string, excludeId?: string): Promise<{ text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }> {
        const row = await shadowLogRepository.sampleUnlabeledMatches(excludeId);
        if (!row) return { text: localeService.t(locale, "labelMatchEmpty"), reply_markup: { inline_keyboard: [] } };
        const id = String(row._id);
        const lines = (await listingRepository.findByIds(row.matches ?? [])).map(async l => {
            if (!l.title) return "—";
            return l.source === "group" && l.chatId !== undefined && l.messageIds.length
                ? `${l.title} · ${await this.linkTo({ chatId: l.chatId, messageIds: l.messageIds })}`
                : l.title;
        });
        return {
            text: [await this.linkTo(row), ...await Promise.all(lines)].join("\n"),
            reply_markup: {
                inline_keyboard: [[
                    { text: localeService.t(locale, "labelUseful"), callback_data: `lb_${id}_u` },
                    { text: localeService.t(locale, "labelNotUseful"), callback_data: `lb_${id}_d` },
                    { text: localeService.t(locale, "labelSkip"), callback_data: `lb_${id}_m` },
                ]],
            },
        };
    }

    // Callers have checked ADMIN and DM.
    async handleLabel(msg: Message, args = ""): Promise<void> {
        try {
            const locale = await this.localeOf(msg.from!.id);
            const next = args.trim().toLowerCase() === "matches" ? await this.nextMatchRow(locale) : await this.nextRow(locale);
            await this.api.sendMessage({ chat_id: msg.chat.id, ...next });
        } catch (err) {
            console.error("[ERROR - shadowAdmin.handleLabel]", (err as Error).message);
        }
    }

    async handleLabelCallback(query: CallbackQuery, arg: string): Promise<void> {
        try {
            const locale = await this.localeOf(query.from.id);
            if (!await userRepository.hasAuthLevel(String(query.from.id), AuthLevel.ADMIN)) {
                await this.api.answerCallbackQuery({ callback_query_id: query.id, text: localeService.t(locale, "notAdmin") });
                return;
            }
            const m = /^([0-9a-f]{24})_([snkudm])$/.exec(arg);
            if (!m) {
                await this.api.answerCallbackQuery({ callback_query_id: query.id });
                return;
            }
            // ponytail: Skip only avoids the row just shown; it can come back later. Add a skipped list if that gets annoying.
            if (m[2] === "u" || m[2] === "d") await shadowLogRepository.setMatchLabel(m[1], m[2] === "u" ? "useful" : "not_useful", String(query.from.id), new Date());
            else if (m[2] === "s" || m[2] === "n") await shadowLogRepository.setLabel(m[1], m[2] === "s" ? "sale" : "not_sale", String(query.from.id), new Date());
            await this.api.answerCallbackQuery({ callback_query_id: query.id });
            if (!query.message) return;
            const skipped = m[2] === "k" || m[2] === "m" ? m[1] : undefined;
            await this.api.editMessageText({
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                ...await ("udm".includes(m[2]) ? this.nextMatchRow(locale, skipped) : this.nextRow(locale, skipped)),
            });
        } catch (err) {
            console.error("[ERROR - shadowAdmin.handleLabelCallback]", (err as Error).message);
        }
    }

    // Callers have checked MOD and up, and DM.
    async handleStats(msg: Message): Promise<void> {
        try {
            const locale = await this.localeOf(msg.from!.id);
            const now = Date.now();
            const [s7, s30] = await Promise.all([7, 30].map(d => shadowLogRepository.stats(new Date(now - d * DAY_MS))));
            const [l7, l30] = await Promise.all([7, 30].map(d => listingRepository.countByStatus(new Date(now - d * DAY_MS))));
            const held = await listingRepository.countHeld();
            const sale = (s: ShadowStats) => s.byTier.strict + s.byTier.ask;
            const precision = (s: ShadowStats) => s.sale + s.notSale > 0 ? s.sale / (s.sale + s.notSale) : undefined;
            const gate = (s: ShadowStats) => s.labeled >= GATE_MIN_LABELED && (precision(s) ?? 0) >= GATE_MIN_PRECISION ? "yes" : "no";
            const statuses = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
            const text = localeService.t(locale, "statsBody", {
                title: localeService.t(locale, "statsTitle"),
                sale7: sale(s7), sale30: sale(s30),
                wtb7: s7.byTier.wtb, wtb30: s30.byTier.wtb,
                list7: s7.wouldList, list30: s30.wouldList,
                merge7: mergedPct(s7), merge30: mergedPct(s30),
                status7: statuses(l7), status30: statuses(l30),
                held,
                n7: s7.labeled, n30: s30.labeled,
                prec7: pct(s7.sale, s7.sale + s7.notSale, 1), prec30: pct(s30.sale, s30.sale + s30.notSale, 1),
                gate7: gate(s7), gate30: gate(s30),
            });
            // captures expire after 7 days, so there is no 30-day opt-in figure
            let optin = "";
            try {
                const o = await captureRepository.noteStats(new Date(now - 7 * DAY_MS));
                if (this.config.captureMode === "optin" || o.notes > 0) {
                    optin = `\n${localeService.t(locale, "statsOptin", { notes: o.notes, added: o.added, rate: pct(o.added, o.notes) })}`;
                }
            } catch (err) {
                console.error("[ERROR - stats.notes]", (err as Error).message);
            }
            let buyer = "";
            try {
                const since = new Date(now - 7 * DAY_MS);
                const b = await shadowLogRepository.buyerStats(since);
                if (this.config.buyerMatches !== "off" || b.wanted > 0) {
                    buyer = `\n${localeService.t(locale, "statsBuyer", {
                        ...b,
                        searches: await savedSearchRepository.countAllActive(new Date(now)),
                        alerts: await alertLogRepository.countSentSince(since),
                    })}`;
                }
            } catch (err) {
                console.error("[ERROR - stats.buyer]", (err as Error).message);
            }
            await this.api.sendMessage({ chat_id: msg.chat.id, text: text + optin + buyer });
        } catch (err) {
            console.error("[ERROR - shadowAdmin.handleStats]", (err as Error).message);
        }
    }
}
