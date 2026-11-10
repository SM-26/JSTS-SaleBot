// /faq as an HTML widget (Bot API 10.4): a header, one tab per top-level topic, a card per question.
// Static HTML, no widget queries: tabs and the accordion run in the widget's own script.
// Widgets work only in private chats in production, and the HTML must stay under 4096 bytes compressed.

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Widgets get two right-to-left cases wrong (Desktop 7.4.1, Android 13.2.1, 2026-11-10): brackets aren't mirrored
// ("(x)" came out as ")x("), and punctuation right after a number sticks to the number's side ("13." drawn as ".13").
// A right-to-left mark around each bracket, and after such punctuation (not inside 14.5 or 1,400), fixes both there
// and changes nothing where the text is drawn right.
export const markRtl = (s: string): string => s
    .replace(/[()[\]{}]/g, "\u200F$&\u200F")
    .replace(/(\d)([.,:;!?])(?!\d)/g, "$1$2\u200F");

// A link answer is drawn as a pill named after its site (brand names, not translated); any other site shows its host.
const SITES: [RegExp, string][] = [[/(^|\.)waze\.com$/, "Waze"], [/^maps\.app\.goo\.gl$|^(www\.)?google\.[a-z.]+$/, "Google Maps"], [/(^|\.)whatsapp\.com$/, "WhatsApp"]];
const linkLabel = (url: string): string => {
    const host = new URL(url).hostname;
    return SITES.find(([re]) => re.test(host))?.[1] ?? host.replace(/^www\./, "");
};

// Widgets can't dial: tel: links are ignored and openLink("tel:") throws (Desktop 7.4.1, Android 13.2.1, 2026-11-10).
// So an Israeli phone number becomes a copy-on-tap button, plus a WhatsApp link for a mobile number.
const PHONE = /(?:\+972[-\s]?|\b0)(\d{1,2})[-\s]?(\d{3})[-\s]?(\d{4})\b/g;
const phoneControls = (html: string): string => html.replace(PHONE, (shown, a: string, b: string, c: string) =>
    `<button class="l" dir="ltr" data-n="${shown}">📋 ${shown}</button>`
    + (a.startsWith("5") ? `<a class="l" href="https://wa.me/972${a}${b}${c}">WhatsApp ↗</a>` : ""));

const CSS = `<style>
body{margin:0;padding:12px 10px max(10px,env(safe-area-inset-bottom));font:15px/1.35 system-ui}
.h{display:flex;align-items:center;gap:10px;margin:0 2px 10px}
.i{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#ff9f43,#ee5253);display:flex;align-items:center;justify-content:center;font-size:22px}
.t{font-size:18px;font-weight:600}.s{color:var(--tg-theme-hint-color);font-size:13px}
.tb{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:12px;background:var(--tg-theme-secondary-bg-color);margin-bottom:8px}
.tb button{flex:1 1 auto;margin:0;padding:7px 8px;border:0;border-radius:9px;background:transparent;color:var(--tg-theme-hint-color);font-weight:600;font-size:13px}
.tb button.on{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}
details{background:var(--tg-theme-secondary-bg-color);border-radius:12px;padding:10px 12px;margin-bottom:6px}
summary{font-weight:600;cursor:pointer}
p{margin:6px 0 0;color:var(--tg-theme-hint-color)}
.l{display:inline-block;margin:8px 3px 0;padding:5px 12px;border:0;border-radius:14px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);text-decoration:none;font-size:13px;font-weight:600}
</style>`;

// Tabs switch panels; a phone button copies its number; opening a question closes its siblings, so the bubble stays under Telegram's 600 px cap (nothing scrolls).
const JS = `<script>
const B=document.querySelectorAll(".tb button"),P=document.querySelectorAll(".p");
B.forEach(b=>b.addEventListener("click",()=>{B.forEach(x=>x.classList.toggle("on",x===b));P.forEach((p,i)=>p.hidden=i!=b.dataset.i);}));
document.querySelectorAll("[data-n]").forEach(b=>b.addEventListener("click",()=>TelegramWidget.copyText(b.dataset.n)));
document.querySelectorAll("details").forEach(d=>d.addEventListener("toggle",()=>{if(!d.open)return;for(const s of d.parentNode.children)if(s!==d&&s.tagName==="DETAILS")s.open=false;}));
</script>`;

/** faqs: the locale's FAQ nodes ("1", "1.1", "1.1.1", ...). openTopic: a node id whose top-level topic starts selected. */
export function buildFaqWidget(faqs: Record<string, string>, title: string, rtl: boolean, openTopic?: string): string {
    const txt = (s: string): string => esc(rtl ? markRtl(s) : s);
    const keys = Object.keys(faqs);
    const kids = (id: string | null): string[] => keys.filter(k => id
        ? k.startsWith(id + ".") && k.split(".").length === id.split(".").length + 1
        : !k.includes("."));
    const answer = (s: string): string => /^https:\/\/\S+$/.test(s)
        ? `<a class="l" href="${esc(s)}">${esc(linkLabel(s))} ↗</a>`
        : `<p>${phoneControls(txt(s)).replace(/\n/g, "<br>")}</p>`;
    const card = (id: string): string =>
        `<details><summary>${txt(faqs[id])}</summary>${kids(id).map(c => kids(c).length ? card(c) : answer(faqs[c])).join("")}</details>`;

    const topics = kids(null);
    const open = Math.max(0, topics.indexOf(openTopic?.split(".")[0] ?? ""));
    const tabs = topics.map((t, i) => `<button data-i="${i}"${i === open ? ` class="on"` : ""}>${txt(faqs[t])}</button>`).join("");
    const panels = topics.map((t, i) => `<div class="p"${i === open ? "" : " hidden"}>${kids(t).map(card).join("")}</div>`).join("");
    return `<html><body dir="${rtl ? "rtl" : "ltr"}">${CSS}<div class="h"><div class="i">❓</div><div><div class="t">${txt(title)}</div><div class="s">/faq</div></div></div>`
        + `<div class="tb">${tabs}</div>${panels}${JS}</body></html>`;
}
