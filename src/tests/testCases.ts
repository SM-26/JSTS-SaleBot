import TelegramBot from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";
import { PostService } from "../services/postService";
import { UserService } from "../services/userService";
import { BotConfig, Locals, MediaItem } from "../types";

/**
 * Test cases for HandleStart flow.
 * Uncomment a case in runTests() to auto-create a post and send it to moderation.
 * This skips the interactive input so you can test admin approve/reject quickly.
 */

// Telegram file_ids from previously uploaded photos (reusable within the same bot)
const TEST_MEDIA: MediaItem[] = [
    { fileId: "AgACAgQAAxkBAAINXGm-_OK_AAH4GQnBW-0HVvslh49hbgACsg1rGy28-FEImRX00Ng_2AEAAwIAA3kAAzoE", type: "photo" },
    { fileId: "AgACAgQAAxkBAAINW2m-_OKCg3jnCq9lJ83ir9wv2VEvAAKxDWsbLbz4UTzQXIYguRLzAQADAgADeQADOgQ", type: "photo" },
    { fileId: "AgACAgQAAxkBAAINXWm-_OkLEuv9Tex5FGbcr9AzGJZiAAKzDWsbLbz4UfeDwqmcdSY1AQADAgADeAADOgQ", type: "photo" },
];

export const TEST_CASES: Record<string, { label: string; run: TestCaseFn }> = {
    full_post: { label: "📦 Full post (3 photos)", run: testCase1_FullPost },
    no_media:  { label: "📝 No media",             run: testCase2_NoMedia },
    one_photo: { label: "🖼 One photo",             run: testCase3_OnePhoto },
};

type TestCaseFn = (
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    msg: TelegramBot.Message
) => Promise<void>;

/**
 * CASE 1: Full post with multiple photos.
 */
async function testCase1_FullPost(
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    msg: TelegramBot.Message
): Promise<void> {
    await userService.ensureUser(msg.from!);

    const title = "🧪 טסט - אייפון 15 פרו";
    const description = "מכשיר במצב מעולה, שנה שימוש, עם כיסוי וזכוכית.";
    const price = 3500;
    const location = "תל אביב";
    const media = TEST_MEDIA;

    const postText = postService.formatPostText({
        title, description, price, location, media,
        userId: msg.from!.id,
        username: msg.from!.username,
        firstName: msg.from!.first_name,
    });

    const post = await postRepository.createPost({
        userId: String(msg.from!.id),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), postText, media);
    bot.sendMessage(msg.chat.id, `✅ Test post created and sent to moderation (ID: ${post._id})`);
}

/**
 * CASE 2: Post without media.
 */
async function testCase2_NoMedia(
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    msg: TelegramBot.Message
): Promise<void> {
    await userService.ensureUser(msg.from!);

    const title = "🧪 טסט - שולחן כתיבה";
    const description = "שולחן עץ, 120x60, במצב טוב.";
    const price = 200;
    const location = "חיפה";
    const media: MediaItem[] = [];

    const postText = postService.formatPostText({
        title, description, price, location, media,
        userId: msg.from!.id,
        username: msg.from!.username,
        firstName: msg.from!.first_name,
    });

    const post = await postRepository.createPost({
        userId: String(msg.from!.id),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), postText, media);
    bot.sendMessage(msg.chat.id, `✅ Test post (no media) sent to moderation (ID: ${post._id})`);
}

/**
 * CASE 3: Post with a single photo.
 */
async function testCase3_OnePhoto(
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    msg: TelegramBot.Message
): Promise<void> {
    await userService.ensureUser(msg.from!);

    const title = "🧪 טסט - אוזניות אלחוטיות";
    const description = "Sony WH-1000XM5, כמו חדש עם קופסה.";
    const price = 900;
    const location = "ירושלים";
    const media = [TEST_MEDIA[0]];

    const postText = postService.formatPostText({
        title, description, price, location, media,
        userId: msg.from!.id,
        username: msg.from!.username,
        firstName: msg.from!.first_name,
    });

    const post = await postRepository.createPost({
        userId: String(msg.from!.id),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), postText, media);
    bot.sendMessage(msg.chat.id, `✅ Test post (1 photo) sent to moderation (ID: ${post._id})`);
}
