import TelegramBot from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";
import { PostService } from "../services/postService";
import { UserService } from "../services/userService";
import { PaymentService } from "../services/paymentService";
import { InputService } from "../services/inputService";
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
    no_media: { label: "📝 No media", run: testCase2_NoMedia },
    one_photo: { label: "🖼 One photo", run: testCase3_OnePhoto },
    simulate_donation: { label: "💰 Simulate Donation (50 Stars)", run: testCase_SimulateDonation },
    free_text_price: { label: "🏷 Free text price", run: testCase_FreeTextPrice },
};

type TestCaseFn = (
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
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
    paymentService: PaymentService,
    inputService: InputService,
    msg: TelegramBot.Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user = msg.from;

    await userService.ensureUser(user);

    const title = "טסט - אייפון 15 פרו";
    const description = "מכשיר במצב מעולה, שנה שימוש, עם כיסוי וזכוכית.";
    const price = "3500";
    const location = "תל אביב";
    const media = TEST_MEDIA;

    if (!inputService.validatePriceValue(price)) {
        bot.sendMessage(msg.chat.id, `❌ Test Case Failed: Price "${price}" is invalid under current config.`);
        return;
    }

    const postText = postService.formatPostText({
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });

    const post = await postRepository.createPost({
        userId: user.id.toString(),
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
    paymentService: PaymentService,
    inputService: InputService,
    msg: TelegramBot.Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user = msg.from;

    await userService.ensureUser(user);

    const title = "טסט - שולחן כתיבה";
    const description = "שולחן עץ, 120x60, במצב טוב.";
    const price = "200";
    const location = "חיפה";
    const media: MediaItem[] = [];

    if (!inputService.validatePriceValue(price)) {
        bot.sendMessage(msg.chat.id, `❌ Test Case Failed: Price "${price}" is invalid under current config.`);
        return;
    }

    const postText = postService.formatPostText({
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });

    const post = await postRepository.createPost({
        userId: user.id.toString(),
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
    paymentService: PaymentService,
    inputService: InputService,
    msg: TelegramBot.Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user = msg.from;

    await userService.ensureUser(user);

    const title = "טסט - אוזניות אלחוטיות";
    const description = "Sony WH-1000XM5, כמו חדש עם קופסה.";
    const price = "900";
    const location = "ירושלים";
    const media = [TEST_MEDIA[0]];

    if (!inputService.validatePriceValue(price)) {
        bot.sendMessage(msg.chat.id, `❌ Test Case Failed: Price "${price}" is invalid under current config.`);
        return;
    }

    const postText = postService.formatPostText({
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });

    const post = await postRepository.createPost({
        userId: user.id.toString(),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), postText, media);
    bot.sendMessage(msg.chat.id, `✅ Test post (1 photo) sent to moderation (ID: ${post._id})`);
}

/**
 * CASE 4: Simulate a successful donation.
 */
async function testCase_SimulateDonation(
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: TelegramBot.Message
): Promise<void> {
    // Create a fake successful payment message
    const fakePaymentMessage = {
        ...msg,
        successful_payment: {
            currency: "XTR",
            total_amount: 50,
            invoice_payload: JSON.stringify({ type: "donation", amount: 50 }),
            telegram_payment_charge_id: "test_charge_id",
            provider_payment_charge_id: "test_provider_id"
        }
    } as TelegramBot.Message;

    console.log("Simulating donation payment...");

    // Trigger the actual handler in payment service
    await paymentService.handleSuccessfulPayment(fakePaymentMessage);

    // Send confirmation of test
    bot.sendMessage(msg.chat.id, "✅ Simulated donation event triggered. You should see the 'Thank you' message above.");
}

/**
 * CASE 5: Free text price (e.g. for when validation is disabled).
 */
async function testCase_FreeTextPrice(
    bot: TelegramBot,
    config: BotConfig,
    locals: Locals,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: TelegramBot.Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user = msg.from;

    await userService.ensureUser(user);

    const title = "טסט - מחיר טקסט חופשי";
    const description = "בדיקה של מחיר שאינו מספר (למשל 'בחינם' או 'צור קשר').";
    const price = "צור קשר בפרטי"; // "Contact privately"
    const location = "פתח תקווה";
    const media: MediaItem[] = [];

    if (!inputService.validatePriceValue(price)) {
        bot.sendMessage(msg.chat.id, `❌ Test Case Failed: Price "${price}" is invalid under current config.`);
        return;
    }

    const postText = postService.formatPostText({
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });

    const post = await postRepository.createPost({
        userId: user.id.toString(),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), postText, media);
    bot.sendMessage(msg.chat.id, `✅ Test post (free text price) sent to moderation (ID: ${post._id})`);
}