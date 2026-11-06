import { classify, normalize, textHash, tokenOverlap, tokens } from "./classifier";

export type CatchupItem = { messageId: number; date: string; title: string; price: string; location?: string; text: string; tier: "strict" | "ask" };
export type CatchupFile = { version: 1; generatedAt: string; sellers: { userId: string; name: string; items: CatchupItem[] }[] };
export type ScanSummary = {
    messages: number;
    windows: number;
    byTier: { strict: number; ask: number; wtb: number; none: number };
    noTitle: number;
    merged: number;
    items: number;
    sellers: number;
};

const MAX_AGE_MS = 30 * 86_400_000;
// same rule as the live capture windows
const QUIET_MS = 30_000;
const WINDOW_MS = 90_000;
const OVERLAP = 0.8;

type Msg = { id: number; at: number; userId: string; name: string; text: string; media: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function flatten(text: unknown): string {
    if (typeof text === "string") return text;
    if (!Array.isArray(text)) return "";
    return text.map(p => (typeof p === "string" ? p : isObj(p) && typeof p.text === "string" ? p.text : "")).join("");
}

function readMessage(m: unknown, now: Date, topicId?: number): Msg | null {
    if (!isObj(m) || m.type === "service" || typeof m.id !== "number") return null;
    const from = typeof m.from_id === "string" ? /^user(\d+)$/.exec(m.from_id) : null;
    if (!from || m.forwarded_from) return null;
    // General has no reply_to_message_id; any other topic carries its id
    if (m.reply_to_message_id !== topicId) return null;
    const unix = Number(m.date_unixtime);
    const at = m.date_unixtime !== undefined && Number.isFinite(unix) ? unix * 1000 : Date.parse(String(m.date));
    if (!Number.isFinite(at) || at < now.getTime() - MAX_AGE_MS) return null;
    const text = flatten(m.text);
    if (text.trimStart().startsWith("/")) return null;
    const media = m.photo !== undefined || (typeof m.mime_type === "string" && m.mime_type.startsWith("video/"));
    return { id: m.id, at, userId: from[1], name: typeof m.from === "string" ? m.from : "", text, media };
}

export function scanExport(raw: unknown, opts: { now: Date; topicId?: number; exclude?: string[] }): { file: CatchupFile; summary: ScanSummary } {
    const summary: ScanSummary = { messages: 0, windows: 0, byTier: { strict: 0, ask: 0, wtb: 0, none: 0 }, noTitle: 0, merged: 0, items: 0, sellers: 0 };
    const sellers = new Map<string, { userId: string; name: string; items: CatchupItem[] }>();
    const list = isObj(raw) && Array.isArray(raw.messages) ? raw.messages : [];
    const msgs = list.flatMap(m => readMessage(m, opts.now, opts.topicId) ?? []).filter(m => !opts.exclude?.includes(m.userId));
    msgs.sort((a, b) => a.at - b.at || a.id - b.id);
    summary.messages = msgs.length;

    // windows per sender, same join rule as live capture
    const open = new Map<string, { first: Msg; last: number; parts: Msg[] }>();
    const done: { first: Msg; parts: Msg[] }[] = [];
    for (const m of msgs) {
        const w = open.get(m.userId);
        if (w && m.at - w.last < QUIET_MS && m.at - w.first.at < WINDOW_MS) {
            w.parts.push(m);
            w.last = m.at;
        } else {
            if (w) done.push(w);
            open.set(m.userId, { first: m, last: m.at, parts: [m] });
        }
    }
    done.push(...open.values());
    done.sort((a, b) => a.first.at - b.first.at);

    for (const w of done) {
        summary.windows++;
        // the way captureRepository REBUILD joins: texts in message order, newline between, empty ones skipped
        const text = w.parts.map(p => p.text).filter(Boolean).join("\n");
        const r = classify(text, w.parts.some(p => p.media));
        summary.byTier[r.tier]++;
        if (r.tier !== "strict" && r.tier !== "ask") continue;
        const { title, price, location } = r.parsed;
        if (!title) {
            summary.noTitle++;
            continue;
        }
        if (!price) continue; // ponytail: a priced post is the contract; a tier without a price is dropped uncounted
        const item: CatchupItem = { messageId: w.first.id, date: new Date(w.first.at).toISOString(), title, price, text, tier: r.tier };
        if (location) item.location = location;
        let s = sellers.get(w.first.userId);
        if (!s) sellers.set(w.first.userId, (s = { userId: w.first.userId, name: w.first.name, items: [] }));
        const hash = textHash(text);
        const tk = tokens(text);
        // ponytail: linear scan per seller; fine for one group's last 30 days
        const dup = s.items.findIndex(i => textHash(i.text) === hash || (normalize(i.title) === normalize(title) && tokenOverlap(tokens(i.text), tk) >= OVERLAP));
        if (dup >= 0) {
            s.items[dup] = item; // windows run oldest to newest: the newer one wins
            summary.merged++;
        } else s.items.push(item);
    }

    const out = [...sellers.values()];
    summary.items = out.reduce((n, s) => n + s.items.length, 0);
    summary.sellers = out.length;
    return { file: { version: 1, generatedAt: opts.now.toISOString(), sellers: out }, summary };
}

export function formatSummary(s: ScanSummary): string {
    return [
        `messages ${s.messages}, windows ${s.windows}`,
        `tiers: strict ${s.byTier.strict}, ask ${s.byTier.ask}, wtb ${s.byTier.wtb}, none ${s.byTier.none}`,
        `dropped (no title) ${s.noTitle}, merged ${s.merged}`,
        `items ${s.items} from ${s.sellers} sellers`,
    ].join("\n");
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseCatchupFile(raw: unknown): CatchupFile | null {
    if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.sellers) || !nonEmpty(raw.generatedAt)) return null;
    for (const s of raw.sellers) {
        if (!isObj(s) || typeof s.userId !== "string" || !/^\d+$/.test(s.userId) || typeof s.name !== "string" || !Array.isArray(s.items)) return null;
        for (const i of s.items) {
            if (!isObj(i) || typeof i.messageId !== "number" || !Number.isInteger(i.messageId) || i.messageId <= 0) return null;
            if (!nonEmpty(i.date) || !Number.isFinite(Date.parse(i.date))) return null;
            if (!nonEmpty(i.title) || !nonEmpty(i.price) || !nonEmpty(i.text)) return null;
            if (i.tier !== "strict" && i.tier !== "ask") return null;
            if (i.location !== undefined && typeof i.location !== "string") return null;
        }
    }
    return raw as unknown as CatchupFile;
}
