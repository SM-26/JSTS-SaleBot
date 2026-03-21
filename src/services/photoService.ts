import TelegramBot from "node-telegram-bot-api";
import { MediaItem } from "../types";

export class MediaService {
    buildMediaGroup(media: MediaItem[], caption: string): (TelegramBot.InputMediaPhoto | TelegramBot.InputMediaVideo)[] {
        return media.map((item, i) => ({
            type: item.type as any,
            media: item.fileId,
            ...(i === 0 ? { caption, parse_mode: "HTML" as const } : {}),
        }));
    }
}
