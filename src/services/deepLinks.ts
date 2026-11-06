export type StartPayload = { kind: "c" | "l" | "k" | "s"; id: string } | { kind: "faq"; id: "1" };

// /start c_<captureId>, l_<listingId>, k_<memberId> (catch-up) or s_<captureId>; anything else is not ours.
export function parseStartPayload(args: string): StartPayload | null {
    if (args.trim() === "faq_1") return { kind: "faq", id: "1" }; // the meeting-point button on a group post
    const m = /^([clks])_([0-9a-f]{24})$/.exec(args.trim());
    return m ? { kind: m[1] as "c" | "l" | "k" | "s", id: m[2] } : null;
}

export const deepLink = (botUsername: string, payload: string): string => `https://t.me/${botUsername}?start=${payload}`;

// Same shapes as ShadowAdminService.linkTo: public @username, else the /c/ form.
export function groupMessageLink(chat: { id: number; username?: string }, messageId: number): string {
    return chat.username
        ? `https://t.me/${chat.username}/${messageId}`
        : `https://t.me/c/${String(Math.abs(chat.id)).replace(/^100/, "")}/${messageId}`;
}
