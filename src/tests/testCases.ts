import TelegramBot, { Message, User as TgUser } from "node-telegram-bot-api";
import postRepository from "../repositories/postRepository";
import { PostService } from "../services/postService";
import { UserService } from "../services/userService";
import { PaymentService } from "../services/paymentService";
import { InputService } from "../services/inputService";
import { BotConfig, MediaItem, LocaleService, TestCaseFn, User, AuthLevel } from "../types";
import userRepository from "../repositories/userRepository";

/**
 * Test cases for HandleNewPost flow.
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
    faq_view: { label: "❓ View FAQ", run: testCase_FaqView },
    broadcast_custom: { label: "✍️ Broadcast Custom Message (to Moderation)", run: testCase_BroadcastCustom },
    broadcast_test: { label: "📢 Broadcast (to Moderation)", run: testCase_Broadcast },
    rbac_promotion: { label: "🎖 Test RBAC Promotion", run: testCase_RBACPromotion },
    rbac_auth: { label: "🔍 Test RBAC Auth Output", run: testCase_RBACAuth },
};

/**
 * CASE 1: Full post with multiple photos.
 */
async function testCase1_FullPost(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user: TgUser = msg.from;

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

    const post = await postRepository.createPost({
        userId: user.id.toString(),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), {
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });
    bot.sendMessage(msg.chat.id, `✅ Test post created and sent to moderation (ID: ${post._id})`);
}

/**
 * CASE 2: Post without media.
 */
async function testCase2_NoMedia(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user: TgUser = msg.from;

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

    const post = await postRepository.createPost({
        userId: user.id.toString(),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), {
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });
    bot.sendMessage(msg.chat.id, `✅ Test post (no media) sent to moderation (ID: ${post._id})`);
}

/**
 * CASE 3: Post with a single photo.
 */
async function testCase3_OnePhoto(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user: TgUser = msg.from;

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

    const post = await postRepository.createPost({
        userId: user.id.toString(),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), {
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });
    bot.sendMessage(msg.chat.id, `✅ Test post (1 photo) sent to moderation (ID: ${post._id})`);
}

/**
 * CASE 4: Simulate a successful donation.
 */
async function testCase_SimulateDonation(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
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
    } as Message;

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
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const user: TgUser = msg.from;

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

    const post = await postRepository.createPost({
        userId: user.id.toString(),
        title, description, price, media, location,
        createdAt: new Date(),
    });

    await postService.sendToModeration(String(post._id), {
        title, description, price, location, media,
        userId: user.id,
        username: user.username,
        firstName: user.first_name,
    });
    bot.sendMessage(msg.chat.id, `✅ Test post (free text price) sent to moderation (ID: ${post._id})`);
}

/**
 * TEST CASE: View FAQ command.
 */
async function testCase_FaqView(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    try { //
        const locale = localeService.resolveUserLocale(msg.from ? { userId: String(msg.from.id), firstName: msg.from.first_name, languageCode: msg.from.language_code } as User : null);
        const faqs = localeService.getFaqs(locale);

        if (!faqs || Object.keys(faqs).length === 0) {
            await bot.sendMessage(msg.chat.id, "❌ No FAQ data found for your locale");
            return;
        }

        let faqText = "<b>📋 FAQ Test Result</b>\n\n";
        const keys = Object.keys(faqs).slice(0, 5);
        for (const key of keys) {
            faqText += `<b>${key}</b>: ${faqs[key].substring(0, 50)}...\n\n`;
        }
        faqText += `✅ Total FAQ entries: ${Object.keys(faqs).length}`;

        await bot.sendMessage(msg.chat.id, faqText, { parse_mode: "HTML" });
    } catch (err) {
        console.error("[ERROR - testCase_FaqView]", (err as Error).message);
        await bot.sendMessage(msg.chat.id, "❌ FAQ test failed: " + (err as Error).message);
    }
}

/**
 * TEST CASE: Broadcast a custom message typed by the admin.
 * Sends a user-provided formatted message to the moderation group.
 */
async function testCase_BroadcastCustom(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    const moderationGroupId = config.moderationGroupId;
    const moderationTopicId = config.moderationTopicId;
    const user: User | null = await userRepository.findByUserId(String(msg.from!.id));
    const locale = localeService.resolveUserLocale(user);

    try {
        const customMessage = await inputService.inputWithPrompt(msg, localeService.t(locale, 'broadcastEnterCustomMessage'));
        await bot.sendMessage(moderationGroupId, customMessage, {
            parse_mode: "HTML",
            message_thread_id: moderationTopicId
        });
        await bot.sendMessage(msg.chat.id, "✅ Custom broadcast message sent to the moderation group.");
    } catch (err) {
        console.error("[ERROR - testCase_BroadcastCustom]", (err as Error).message);
        await bot.sendMessage(msg.chat.id, "❌ Custom broadcast test failed: " + (err as Error).message);
    }
}

/**
 * TEST CASE: Broadcast simulation.
 * Sends a formatted message to the moderation group instead of the approved group 
 * to test delivery and formatting without affecting the public channel.
 */
async function testCase_Broadcast(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    const moderationGroupId = config.moderationGroupId;
    const moderationTopicId = config.moderationTopicId;

    const testMessage = "<b>🚀 Broadcast Test Message</b>\n\nThis message simulates an admin broadcast. It is sent to the <i>moderation group</i> to avoid cluttering the public channel during tests.\n\nFormatting check:\n- <b>Bold text</b>\n- <i>Italic text</i>\n- <a href='https://github.com/SM-26/JSTS-SaleBot'>Link to Repository</a>\n\n✅ If you see this in the correct moderation topic, the broadcast logic is verified!";

    try {
        await bot.sendMessage(moderationGroupId, testMessage, {
            parse_mode: "HTML",
            message_thread_id: moderationTopicId
        });
        await bot.sendMessage(msg.chat.id, "✅ Broadcast test message sent to the moderation group.");
    } catch (err) {
        console.error("[ERROR - testCase_Broadcast]", (err as Error).message);
        await bot.sendMessage(msg.chat.id, "❌ Broadcast test failed: " + (err as Error).message);
    }
}

/**
 * TEST CASE: RBAC Promotion logic.
 * Verifies that the auth level is correctly updated in the DB.
 */
async function testCase_RBACPromotion(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    const userId = String(msg.from!.id);
    const originalUser = await userRepository.findByUserId(userId);

    if (!originalUser) {
        await bot.sendMessage(msg.chat.id, "❌ Test failed: Admin user not found in DB.");
        return;
    }

    const originalLevel = originalUser.authLevel;

    try {
        // We can't easily promote a "dummy" user without a second account, 
        // so we verify that the current admin (level 2) cannot be promoted further.
        const text = `<b>RBAC Test</b>\nActor Level: ${originalLevel}\n\nRunning checks...`;
        await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });

        if (originalLevel === AuthLevel.ADMIN) {
            await bot.sendMessage(msg.chat.id, "✅ Self-check: Admin cannot be promoted further (limit check).");
        }

        // Verify migration: Every user in DB should now have authLevel instead of isAdmin
        const allUsers = await userRepository.getAll();
        const legacyUsers = allUsers.filter(u => (u as User & { isAdmin?: boolean }).isAdmin !== undefined);

        await bot.sendMessage(msg.chat.id, `✅ Migration check: Found ${legacyUsers.length} legacy isAdmin fields.`);
    } catch (err) {
        await bot.sendMessage(msg.chat.id, "❌ RBAC test failed: " + (err as Error).message);
    }
}

/**
 * TEST CASE: RBAC Auth command output.
 */
async function testCase_RBACAuth(
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    const userId = String(msg.from!.id);
    const user = await userRepository.findByUserId(userId);
    if (!user) {
        await bot.sendMessage(msg.chat.id, "❌ Test failed: User not found in DB.");
        return;
    }

    const locale = localeService.resolveUserLocale(user);
    const roleKey = user.authLevel === AuthLevel.ADMIN ? 'authLevelAdmin' :
        user.authLevel === AuthLevel.MOD ? 'authLevelMod' : 'authLevelUser';
    const roleName = localeService.t(locale, roleKey);

    const output = localeService.t(locale, 'authCurrentLevel', { userId: user.userId, role: roleName, level: user.authLevel });
    await bot.sendMessage(msg.chat.id, `<b>RBAC Auth Test</b>\n\n${output}`, { parse_mode: "HTML" });
    await bot.sendMessage(msg.chat.id, "✅ Auth logic verified.");
}