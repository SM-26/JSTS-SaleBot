// Buttons already sent to Telegram chats keep their callback_data forever, so
// these prefixes and formats must never change (see src/tests/checkCallbackData.ts).
export type CallbackAction =
    | "test" | "faq" | "approve" | "reject" | "clearRejected" | "clearSold"
    | "sold" | "bump" | "lowerPrice" | "lang" | "donate" | "label" | "takeDown" | "takeDownDelete" | "rejectReason" | "capture" | "listing" | "lifecycle" | "stalecheck" | "alerts" | "catchup";

export function routeCallback(data: string): { action: CallbackAction; arg: string } | null {
    if (data.startsWith("test_")) return { action: "test", arg: data.slice("test_".length) };
    if (data.startsWith("faq_")) return { action: "faq", arg: data.slice("faq_".length) };
    if (data.startsWith("approve_")) return { action: "approve", arg: data.slice("approve_".length) };
    if (data.startsWith("reject_")) return { action: "reject", arg: data.slice("reject_".length) };
    if (data === "clear_rejected") return { action: "clearRejected", arg: "" };
    if (data === "clear_sold") return { action: "clearSold", arg: "" };
    if (data.startsWith("sold_")) return { action: "sold", arg: data.slice("sold_".length) };
    if (data.startsWith("bump_")) return { action: "bump", arg: data.slice("bump_".length) };
    if (data.startsWith("lp_")) return { action: "lowerPrice", arg: data.slice("lp_".length) };
    if (data.startsWith("lang_")) return { action: "lang", arg: data.slice("lang_".length) };
    if (data.startsWith("donate_")) return { action: "donate", arg: data.slice("donate_".length) };
    if (data.startsWith("lb_")) return { action: "label", arg: data.slice("lb_".length) };
    if (data.startsWith("td_")) return { action: "takeDown", arg: data.slice("td_".length) };
    if (data.startsWith("tx_")) return { action: "takeDownDelete", arg: data.slice("tx_".length) };
    if (data.startsWith("rr_")) return { action: "rejectReason", arg: data.slice("rr_".length) };
    if (data.startsWith("mk_")) return { action: "capture", arg: data.slice("mk_".length) };
    if (data.startsWith("ls_")) return { action: "listing", arg: data.slice("ls_".length) };
    if (data.startsWith("al_")) return { action: "alerts", arg: data.slice("al_".length) };
    if (data.startsWith("lc_")) return { action: "lifecycle", arg: data.slice("lc_".length) };
    if (data.startsWith("sc_")) return { action: "stalecheck", arg: data.slice("sc_".length) };
    if (data.startsWith("ck_")) return { action: "catchup", arg: data.slice("ck_".length) };
    return null;
}
