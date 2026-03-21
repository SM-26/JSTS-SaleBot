import TelegramBot from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";
import { PostService } from "../services/postService";
import { UserService } from "../services/userService";
import { BotConfig, Locals } from "../types";

/**
 * Test cases for HandleStart flow.
 * Uncomment a case in runTests() to auto-create a post and send it to moderation.
 * This skips the interactive input so you can test admin approve/reject quickly.
 */

const TEST_PHOTOS = [
    "public/images/1774124245510_AgACAgQAAxkBAAINXGm-_OK_AAH4GQnBW-0HVvslh49hbgACsg1rGy28-FEImRX00Ng_2AEAAwIAA3kAAzoE.jpg",
    "public/images/1774124245515_AgACAgQAAxkBAAINW2m-_OKCg3jnCq9lJ83ir9wv2VEvAAKxDWsbLbz4UTzQXIYguRLzAQADAgADeQADOgQ.jpg",
    "public/images/1774124252032_AgACAgQAAxkBAAINXWm-_OkLEuv9Tex5FGbcr9AzGJZiAAKzDWsbLbz4UfeDwqmcdSY1AQADAgADeAADOgQ.jpg",
];

export async function runTests(
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    msg: TelegramBot.Message
): Promise<void> {

    // =============================================
    // Uncomment ONE test case to run it:
    // =============================================

    // --- CASE 1: Full post with photos → sent to moderation ---
    await testCase1_FullPost(bot, config, locals, postService, userService, msg);

    // --- CASE 2: Post without photos ---
    // await testCase2_NoPhotos(bot, config, locals, postService, userService, msg);

    // --- CASE 3: Post with one photo ---
    // await testCase3_OnePhoto(bot, config, locals, postService, userService, msg);
}

/**
 * CASE 1: Full post with multiple photos.
 * Creates a test post and sends it to moderation with approve/reject buttons.
 */
async function testCase1_FullPost(
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    msg: TelegramBot.Message
): Promise<void> {
    const lang = config.lang;

    await userService.ensureUser(msg.from!);

    const title = "🧪 טסט - אייפון 15 פרו";
    const description = "מכשיר במצב מעולה, שנה שימוש, עם כיסוי וזכוכית.";
    const price = 3500;
    const location = "תל אביב";
    const photos = TEST_PHOTOS;

    const postText = postService.formatPostText({
        title,
        description,
        price,
        location,
        photos,
        userId: msg.from!.id,
        username: msg.from!.username,
        firstName: msg.from!.first_name,
    });

    // Save to DB
    const post = await postRepository.createPost({
        userId: String(msg.from!.id),
        title,
        description,
        price,
        photos,
        location,
        createdAt: new Date(),
    });

    // Send to moderation
    await postService.sendToModeration(String(post._id), postText, photos);

    bot.sendMessage(msg.chat.id, `✅ Test post created and sent to moderation (ID: ${post._id})`);
}

/**
 * CASE 2: Post without photos.
 */
async function testCase2_NoPhotos(
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
    const photos: string[] = [];

    const postText = postService.formatPostText({
        title,
        description,
        price,
        location,
        photos,
        userId: msg.from!.id,
        username: msg.from!.username,
        firstName: msg.from!.first_name,
    });

    const post = await postRepository.createPost({
        userId: String(msg.from!.id),
        title,
        description,
        price,
        photos,
        location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), postText, photos);

    bot.sendMessage(msg.chat.id, `✅ Test post (no photos) sent to moderation (ID: ${post._id})`);
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
    const photos = [TEST_PHOTOS[0]];

    const postText = postService.formatPostText({
        title,
        description,
        price,
        location,
        photos,
        userId: msg.from!.id,
        username: msg.from!.username,
        firstName: msg.from!.first_name,
    });

    const post = await postRepository.createPost({
        userId: String(msg.from!.id),
        title,
        description,
        price,
        photos,
        location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), postText, photos);

    bot.sendMessage(msg.chat.id, `✅ Test post (1 photo) sent to moderation (ID: ${post._id})`);
}
