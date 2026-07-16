import { InputMediaPhoto, InputMediaVideo } from "node-telegram-bot-api";
import { MediaItem } from "../types";

export class MediaService {
    buildMediaGroup(media: MediaItem[], caption: string): (InputMediaPhoto | InputMediaVideo)[] {
        return media.map((item, i) => ({
            type: item.type,
            media: item.fileId,
            ...(i === 0 ? { caption, parse_mode: "HTML" as const } : {}),
        }));
    }
}
