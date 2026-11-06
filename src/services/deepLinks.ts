export type StartPayload = { kind: "c" | "l"; id: string };

// /start c_<captureId> or l_<listingId>; anything else is not ours.
export function parseStartPayload(args: string): StartPayload | null {
    const m = /^([cl])_([0-9a-f]{24})$/.exec(args.trim());
    return m ? { kind: m[1] as "c" | "l", id: m[2] } : null;
}

export const deepLink = (botUsername: string, payload: string): string => `https://t.me/${botUsername}?start=${payload}`;

// Same shapes as ShadowAdminService.linkTo: public @username, else the /c/ form.
export function groupMessageLink(chat: { id: number; username?: string }, messageId: number): string {
    return chat.username
        ? `https://t.me/${chat.username}/${messageId}`
        : `https://t.me/c/${String(Math.abs(chat.id)).replace(/^100/, "")}/${messageId}`;
}
