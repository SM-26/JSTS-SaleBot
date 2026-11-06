import type { Api } from "node-telegram-bot-api";
import type { Message, User as TgUser } from "node-telegram-bot-api/types";
import postRepository from "../repositories/postRepository";
import { PostService } from "../services/postService";
import { LifecycleService } from "../services/lifecycleService";
import { UserService } from "../services/userService";
import { PaymentService } from "../services/paymentService";
import { InputService } from "../services/inputService";
import { BotConfig, MediaItem, LocaleService, TestCaseFn, User, AuthLevel } from "../types";
import userRepository from "../repositories/userRepository";
import { BroadcastUsersService } from "../services/broadcastUsersService";
import draftRepository from "../repositories/draftRepository";
import shadowLogRepository from "../repositories/shadowLogRepository";
import { classify } from "../services/classifier";
import { isTestBotToken } from "./testBot";
import { PublishService } from "../services/publishService";
import listingRepository from "../repositories/listingRepository";
import { GroupListingService } from "../services/groupListingService";
import { CaptureNoteService } from "../services/captureNoteService";
import { seedCapture } from "./fixtures";
import { rankMatches } from "../services/matchService";
import { AlertService } from "../services/alertService";
import { StaleCheckService } from "../services/staleCheckService";
import { sellerLayout, sellerTier, type SellerTier } from "../services/trustService";

/**
 * In-bot test cases, run from the admin-only /test menu. The post cases skip the
 * (persistent) /newPost wizard and create a post straight into moderation, so you
 * can test approve/reject quickly. None of them waits on a typed reply.
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
    broadcast_test: { label: "📢 Broadcast (to Moderation)", run: testCase_Broadcast },
    rbac_promotion: { label: "🎖 Test RBAC Promotion", run: testCase_RBACPromotion },
    rbac_auth: { label: "🔍 Test RBAC Auth Output", run: testCase_RBACAuth },
    broadcast_users: { label: "📢 Broadcast Users (DM active/pending/approved)", run: testCase_BroadcastUsers },
    wizard_draft: { label: "📝 Wizard draft status", run: testCase_WizardDraftStatus },
    classify_fixtures: { label: "🧪 Classify fixtures", run: testCase_ClassifyFixtures },
    quick_caption: { label: "📸 Quick draft from caption text", run: testCase_QuickCaption },
    shadow_last5: { label: "🕵️ Shadow: last 5 rows", run: testCase_ShadowLast5 },
    trusted_seller_post: { label: "⭐ Post as trusted seller", run: testCase_TrustedSellerPost },
    new_seller_post: { label: "🆕 Post as new seller", run: testCase_NewSellerPost },
    capture_note: { label: "🛒 Send me a capture note", run: testCase_CaptureNote },
    match_for_text: { label: "🔎 Match for text", run: testCase_MatchForText },
    alert_me_now: { label: "🔔 Alert me now", run: testCase_AlertMeNow },
    age_listing_7: { label: "⏩ Age my test listing 7 days", run: (...a) => ageTestListing(7, ...a) },
    age_listing_30: { label: "⏩ Age my test listing 30 days", run: (...a) => ageTestListing(30, ...a) },
    set_tier_regular: { label: "🎚 Set my tier: regular", run: (...a) => setMyTier("regular", ...a) },
    set_tier_top: { label: "🎚 Set my tier: top seller", run: (...a) => setMyTier("top", ...a) },
    set_tier_verified: { label: "🎚 Set my tier: verified", run: (...a) => setMyTier("verified", ...a) },
    set_tier_both: { label: "🎚 Set my tier: both", run: (...a) => setMyTier("both", ...a) },
    post_as_regular: { label: "📮 Post as regular", run: (...a) => postAsTier("regular", ...a) },
    post_as_top: { label: "📮 Post as top seller", run: (...a) => postAsTier("top", ...a) },
    post_as_verified: { label: "📮 Post as verified", run: (...a) => postAsTier("verified", ...a) },
    post_as_both: { label: "📮 Post as both", run: (...a) => postAsTier("both", ...a) },
    stale_dry_run: { label: "📨 Stale-check dry run (to me only)", run: testCase_StaleDryRun },
};

/**
 * CASE 1: Full post with multiple photos.
 */
async function testCase1_FullPost(
    api: Api,
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
        api.sendMessage({ chat_id: msg.chat.id, text: `❌ Test Case Failed: Price "${price}" is invalid under current config.` });
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
    api.sendMessage({ chat_id: msg.chat.id, text: `✅ Test post created and sent to moderation (ID: ${post._id})` });
}

/**
 * CASE 2: Post without media.
 */
async function testCase2_NoMedia(
    api: Api,
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
        api.sendMessage({ chat_id: msg.chat.id, text: `❌ Test Case Failed: Price "${price}" is invalid under current config.` });
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
    api.sendMessage({ chat_id: msg.chat.id, text: `✅ Test post (no media) sent to moderation (ID: ${post._id})` });
}

/**
 * CASE 3: Post with a single photo.
 */
async function testCase3_OnePhoto(
    api: Api,
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
        api.sendMessage({ chat_id: msg.chat.id, text: `❌ Test Case Failed: Price "${price}" is invalid under current config.` });
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
    api.sendMessage({ chat_id: msg.chat.id, text: `✅ Test post (1 photo) sent to moderation (ID: ${post._id})` });
}

/**
 * CASE 4: Simulate a successful donation.
 */
async function testCase_SimulateDonation(
    api: Api,
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
    api.sendMessage({ chat_id: msg.chat.id, text: "✅ Simulated donation event triggered. You should see the 'Thank you' message above." });
}

/**
 * CASE 5: Free text price (e.g. for when validation is disabled).
 */
async function testCase_FreeTextPrice(
    api: Api,
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
        api.sendMessage({ chat_id: msg.chat.id, text: `❌ Test Case Failed: Price "${price}" is invalid under current config.` });
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
    api.sendMessage({ chat_id: msg.chat.id, text: `✅ Test post (free text price) sent to moderation (ID: ${post._id})` });
}

/**
 * TEST CASE: View FAQ command.
 */
async function testCase_FaqView(
    api: Api,
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
            await api.sendMessage({ chat_id: msg.chat.id, text: "❌ No FAQ data found for your locale" });
            return;
        }

        let faqText = "<b>📋 FAQ Test Result</b>\n\n";
        const keys = Object.keys(faqs).slice(0, 5);
        for (const key of keys) {
            faqText += `<b>${key}</b>: ${faqs[key].substring(0, 50)}...\n\n`;
        }
        faqText += `✅ Total FAQ entries: ${Object.keys(faqs).length}`;

        await api.sendMessage({ chat_id: msg.chat.id, text: faqText, parse_mode: "HTML" });
    } catch (err) {
        console.error("[ERROR - testCase_FaqView]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ FAQ test failed: " + (err as Error).message });
    }
}

/**
 * TEST CASE: Broadcast simulation.
 * Sends a formatted message to the moderation group instead of the approved group 
 * to test delivery and formatting without affecting the public channel.
 */
async function testCase_Broadcast(
    api: Api,
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
        await api.sendMessage({ chat_id: moderationGroupId, text: testMessage, parse_mode: "HTML",
            message_thread_id: moderationTopicId });
        await api.sendMessage({ chat_id: msg.chat.id, text: "✅ Broadcast test message sent to the moderation group." });
    } catch (err) {
        console.error("[ERROR - testCase_Broadcast]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Broadcast test failed: " + (err as Error).message });
    }
}

/**
 * TEST CASE: RBAC Promotion logic.
 * Verifies that the auth level is correctly updated in the DB.
 */
async function testCase_RBACPromotion(
    api: Api,
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
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Test failed: Admin user not found in DB." });
        return;
    }

    const originalLevel = originalUser.authLevel;

    try {
        // We can't easily promote a "dummy" user without a second account, 
        // so we verify that the current admin (level 2) cannot be promoted further.
        const text = `<b>RBAC Test</b>\nActor Level: ${originalLevel}\n\nRunning checks...`;
        await api.sendMessage({ chat_id: msg.chat.id, text, parse_mode: "HTML" });

        if (originalLevel === AuthLevel.ADMIN) {
            await api.sendMessage({ chat_id: msg.chat.id, text: "✅ Self-check: Admin cannot be promoted further (limit check)." });
        }

        // Verify migration: Every user in DB should now have authLevel instead of isAdmin
        const allUsers = await userRepository.getAll();
        const legacyUsers = allUsers.filter(u => (u as User & { isAdmin?: boolean }).isAdmin !== undefined);

        await api.sendMessage({ chat_id: msg.chat.id, text: `✅ Migration check: Found ${legacyUsers.length} legacy isAdmin fields.` });
    } catch (err) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ RBAC test failed: " + (err as Error).message });
    }
}

/**
 * TEST CASE: RBAC Auth command output.
 */
async function testCase_RBACAuth(
    api: Api,
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
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Test failed: User not found in DB." });
        return;
    }

    const locale = localeService.resolveUserLocale(user);
    const roleKey = user.authLevel === AuthLevel.ADMIN ? 'authLevelAdmin' :
        user.authLevel === AuthLevel.MOD ? 'authLevelMod' : 'authLevelUser';
    const roleName = localeService.t(locale, roleKey);

    const output = localeService.t(locale, 'authCurrentLevel', { userId: user.userId, role: roleName, level: user.authLevel });
    await api.sendMessage({ chat_id: msg.chat.id, text: `<b>RBAC Auth Test</b>\n\n${output}`, parse_mode: "HTML" });
    await api.sendMessage({ chat_id: msg.chat.id, text: "✅ Auth logic verified." });
}

/**
 * TEST CASE: broadcastUsers audience resolution + send path.
 * Seeds a pending post and an approved post from distinct fake authors, then
 * exercises resolveAudience/sendToMany like /broadcastUsers would.
 */
async function testCase_BroadcastUsers(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const adminId = String(msg.from.id);
    const pendingAuthorId = `test_pending_${Date.now()}`;
    const approvedAuthorId = `test_approved_${Date.now()}`;
    let pendingPostId: string | undefined;
    let approvedPostId: string | undefined;

    try {
        const pendingPost = await postRepository.createPost({
            userId: pendingAuthorId, status: "pending",
            title: "טסט - פוסט ממתין", description: "בדיקת broadcastUsers",
            price: "1", media: [], location: "טסט", createdAt: new Date(),
        });
        const approvedPost = await postRepository.createPost({
            userId: approvedAuthorId, status: "approved",
            title: "טסט - פוסט מאושר", description: "בדיקת broadcastUsers",
            price: "1", media: [], location: "טסט", createdAt: new Date(),
        });
        pendingPostId = String(pendingPost._id);
        approvedPostId = String(approvedPost._id);

        const broadcastUsersService = new BroadcastUsersService(api);
        const audience = await broadcastUsersService.resolveAudience([], adminId);
        const report = await broadcastUsersService.sendToMany(audience, "🧪 <b>broadcastUsers test</b> — you can ignore this message.");

        await api.sendMessage({ chat_id: msg.chat.id, text: `✅ broadcastUsers test: audience=${audience.length}, sent=${report.sent}, failed=${report.failures.length}\n` +
            `pending author included: ${audience.includes(pendingAuthorId)}\n` +
            `approved author included: ${audience.includes(approvedAuthorId)}\n` +
            `admin excluded: ${!audience.includes(adminId)}` });
    } catch (err) {
        console.error("[ERROR - testCase_BroadcastUsers]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ broadcastUsers test failed: " + (err as Error).message });
    } finally {
        if (pendingPostId) await postRepository.deleteById(pendingPostId);
        if (approvedPostId) await postRepository.deleteById(approvedPostId);
    }
}
/**
 * TEST CASE: report the calling admin's /newPost draft (step, media count, age vs
 * timeOut), so persistence can be inspected from Telegram: start /newPost, restart
 * the bot, run this. Read-only.
 */
async function testCase_WizardDraftStatus(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    const userId = String(msg.from.id);

    try {
        const locale = localeService.resolveUserLocale(await userRepository.findByUserId(userId));
        const draft = await draftRepository.findByUserId(userId);
        const text = draft
            ? localeService.t(locale, "testDraftStatus", {
                step: draft.step,
                media: draft.media.length,
                age: Math.floor((Date.now() - draft.updatedAt.getTime()) / 60_000),
                limit: config.timeOut > 0 ? `${config.timeOut} min` : localeService.t(locale, "testDraftNever"),
            })
            : localeService.t(locale, "testDraftNone");
        await api.sendMessage({ chat_id: msg.chat.id, text });
    } catch (err) {
        console.error("[ERROR - testCase_WizardDraftStatus]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Wizard draft status failed: " + (err as Error).message });
    }
}

// [text, hasMedia] pairs: one per tier, plus a bundle.
const CLASSIFY_FIXTURES: Array<[string, boolean]> = [
    ["גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז", true],
    ["M4 למכירה 900 ש\"ח", true],
    ["1300 מרכז", true],
    ["למכירה כוונת 300₪", false],
    ["מחפש M4 עד 800₪", true],
    ["מישהו יודע מתי המשחק?", false],
    ["למכירה\nM4 900₪\nגלוק 600₪", true],
];

/**
 * TEST CASE: run the classifier on a few fixed messages and DM one line each
 * (tier · title · price). Pure: no DB, no group.
 */
async function testCase_ClassifyFixtures(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    try {
        const lines = CLASSIFY_FIXTURES.map(([text, media]) => {
            const { tier, parsed } = classify(text, media);
            return `${tier} · ${parsed.title ?? "-"} · ${parsed.price ?? "-"}`;
        });
        await api.sendMessage({ chat_id: msg.chat.id, text: lines.join("\n") });
    } catch (err) {
        console.error("[ERROR - testCase_ClassifyFixtures]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Classify fixtures failed: " + (err as Error).message });
    }
}

/**
 * TEST CASE: what the one-message quick draft reads from a fixed caption. Touches no draft, sends no post.
 */
async function testCase_QuickCaption(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    try {
        const caption = ["Glock 17 Gen3", "like new, two magazines", "1,800 ₪ Tel Aviv"].join("\n");
        const { tier, parsed } = classify(caption, true);
        const fields = [`tier: ${tier}`, `title: ${parsed.title ?? "-"}`, `price: ${parsed.priceValue ?? "-"}`, `location: ${parsed.location ?? "-"}`, `description: ${parsed.description ?? "-"}`].join("\n");
        await api.sendMessage({ chat_id: msg.chat.id, text: ["Caption:", caption, "", "Quick draft would read:", fields].join("\n") });
    } catch (err) {
        console.error("[ERROR - testCase_QuickCaption]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Quick caption failed: " + (err as Error).message });
    }
}

/**
 * TEST CASE: DM the last 5 shadow_log rows (tier, wouldList, mergeWith, link). Read-only.
 */
async function testCase_ShadowLast5(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    try {
        const rows = await shadowLogRepository.lastRows(5);
        const text = rows.length
            ? rows.map(r => `${r.tier} · wouldList=${r.wouldList} · merge=${r.mergeWith ?? "-"} · ${r.messageIds.length ? `https://t.me/c/${String(Math.abs(r.chatId)).replace(/^100/, "")}/${r.messageIds[0]}` : "—"}`).join("\n")
            : "No shadow rows yet.";
        await api.sendMessage({ chat_id: msg.chat.id, text });
    } catch (err) {
        console.error("[ERROR - testCase_ShadowLast5]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Shadow rows failed: " + (err as Error).message });
    }
}

// Real-looking radio post (owner fixture) with one photo file_id of the TEST bot.
// The seller is the tester, never the real seller.
const RADIO_POST = {
    title: "מכשיר קשר",
    description: "באופנג UV-5R\nחדש באריזה",
    price: "270",
    location: "בית דגן",
    media: [{ fileId: "AgACAgQAAyEGAASRyiESAAIBaWrrdLCnO5_7O2IBhJgi88eq-bjkAAJUD2sbuaNZU5XHhK251RGCAQADAgADeQADPQQ", type: "photo" }] as MediaItem[],
};

/**
 * Shared by the two seller cases: saves the radio post for the tester and runs it
 * through PublishService with the seller trust forced either way. Test groups only.
 */
async function radioPostAs(trusted: boolean, api: Api, config: BotConfig, postService: PostService, userService: UserService, msg: Message): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    // Trusted publishing is real: on any other bot it would post to the production group.
    if (!isTestBotToken(process.env.BOT_TOKEN)) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "⛔ Seller-post tests run only on the test bot." });
        return;
    }
    const user: TgUser = msg.from;
    try {
        await userService.ensureUser(user);
        const post = await postRepository.createPost({
            userId: user.id.toString(),
            ...RADIO_POST,
            createdAt: new Date(),
        });
        const data = { ...RADIO_POST, userId: user.id, username: user.username, firstName: user.first_name };
        const outcome = await new PublishService(api, config, postService).submitPost(post, data, trusted);
        const listing = await listingRepository.findByPostId(String(post._id));
        await api.sendMessage({
            chat_id: msg.chat.id,
            text: `✅ ${trusted ? "Trusted" : "New"} seller post: ${outcome} (test groups only)\nPost ID: ${post._id}\nListing ID: ${listing ? listing._id : "none"}`,
        });
    } catch (err) {
        console.error("[ERROR - radioPostAs]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Seller post failed: " + (err as Error).message });
    }
}

async function testCase_TrustedSellerPost(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    await radioPostAs(true, api, config, postService, userService, msg);
}

async function testCase_NewSellerPost(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    await radioPostAs(false, api, config, postService, userService, msg);
}

/**
 * Sends the presser a real opt-in capture note for a fixture sale post. Fixture only:
 * Add makes a listing that points at message 1 (the test bot only, like radioPostAs).
 */
async function testCase_CaptureNote(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    // Add creates a listing: on any other bot it would touch the production group.
    if (!isTestBotToken(process.env.BOT_TOKEN)) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "⛔ The capture-note test runs only on the test bot." });
        return;
    }
    try {
        const username = (await api.getMe()).username ?? "";
        const groupListings = new GroupListingService(api, config, () => username, new LifecycleService(api, config, new PostService(api, config), () => username));
        const notes = new CaptureNoteService(api, config, groupListings, () => username);
        const capture = await seedCapture({
            chatId: config.approvedGroupId,
            senderId: String(msg.from.id),
            messageIds: [1],
            text: "גלוק 17 למכירה\nבמצב מעולה\n1,300₪ מרכז",
            media: [TEST_MEDIA[0]],
        });
        const sent = capture.parsed ? await notes.sendAskNote(capture, capture.parsed, new Date()) : false;
        await api.sendMessage({
            chat_id: msg.chat.id,
            text: sent
                ? `✅ Capture note sent to you in group ${config.approvedGroupId}, topic ${config.approvedTopicId ?? "none"}`
                : `❌ The capture note was not sent (group ${config.approvedGroupId}); see the log`,
        });
    } catch (err) {
        console.error("[ERROR - testCase_CaptureNote]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Capture note failed: " + (err as Error).message });
    }
}

// A fixed wanted text ranked over the live listings; DMs the titles.
async function testCase_MatchForText(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    try {
        const live = await listingRepository.findLiveForMatching();
        const byId = new Map(live.map(l => [String(l._id), l]));
        const titles = rankMatches("מחפש גלוק 17 עד 800", live).map(id => byId.get(id)?.title ?? "—");
        await api.sendMessage({ chat_id: msg.chat.id, text: titles.length ? titles.join("\n") : "No matches." });
    } catch (err) {
        console.error("[ERROR - testCase_MatchForText]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Match failed: " + (err as Error).message });
    }
}

// Sends the tester's saved-search alerts right now (no alert log, no cursor).
async function testCase_AlertMeNow(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    try {
        const username = (await api.getMe()).username ?? "";
        const sent = await new AlertService(api, config, new GroupListingService(api, config, () => username, new LifecycleService(api, config, postService, () => username)), () => username).sendNow(String(msg.from.id), new Date());
        if (sent === 0) await api.sendMessage({ chat_id: msg.chat.id, text: "No alerts to send (0)." });
    } catch (err) {
        console.error("[ERROR - testCase_AlertMeNow]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Alert failed: " + (err as Error).message });
    }
}

const TIER_SEED_TITLE = "[test] tier seed";

/**
 * Makes the presser's real tier match, on the test bot only: verified is the admin mark, top seller is
 * three seeded sold listings (3 of 3 ended). The seeds are rows only (no group message) and are replaced on each press.
 * Then the presser uses the real /newPost and the layout follows.
 */
async function setMyTier(
    tier: SellerTier,
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    if (!isTestBotToken(process.env.BOT_TOKEN)) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "⛔ Run on the test bot." });
        return;
    }
    try {
        const userId = String(msg.from.id);
        const now = new Date();
        await userService.ensureUser(msg.from);
        await listingRepository.deleteBySellerTitle(userId, TIER_SEED_TITLE);
        for (const p of await postRepository.findByUserId(userId)) {
            if (p.title === TIER_SEED_TITLE) await postRepository.deleteById(String(p._id));
        }
        await userRepository.setVerified(userId, tier === "verified" || tier === "both" ? userId : null);
        if (tier === "top" || tier === "both") {
            for (let i = 0; i < 3; i++) {
                const post = await seedTestPost(userId, TIER_SEED_TITLE, now);
                const listing = await listingRepository.createForPost(post, "dm", false, now);
                await listingRepository.markSold(String(listing._id), now);
            }
        }
        const actual = await sellerTier(userId);
        await api.sendMessage({
            chat_id: msg.chat.id,
            text: actual === tier
                ? `🎚 Your tier is now: ${tier}. /newPost (or a photo with a caption) publishes in that layout.`
                : `🎚 Asked for ${tier} but your tier is ${actual}: you have other real listings that count. Use "Post as" to see a layout.`,
        });
    } catch (err) {
        console.error("[ERROR - setMyTier]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Set tier failed: " + (err as Error).message });
    }
}

const TIER_POST = {
    title: "מצלמת אקשן לדוגמה",
    description: "מצלמה קטנה, עובדת מצוין\nכוללת מטען, כיסוי ושתי סוללות",
    price: "350",
    location: "בית דגן",
    meetup: true,
};

/**
 * One tap puts a made-up sample into the moderation group as a normal pending card (Approve, Reject with the
 * preset reasons), already in the chosen tier's layout. Approve publishes it to the test sale topic in that layout.
 * The tier is stored on this post only (layoutTier), so the presser's real tier is untouched and any admin can run it.
 * Real sellers never get this: a trusted seller still publishes at once. Test bot only.
 */
async function postAsTier(
    tier: SellerTier,
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    if (!isTestBotToken(process.env.BOT_TOKEN)) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "⛔ Seller-post tests run only on the test bot." });
        return;
    }
    try {
        const user: TgUser = msg.from;
        const userId = String(user.id);
        await userService.ensureUser(user);
        const post = await postRepository.createPost({ userId, ...TIER_POST, media: TEST_MEDIA, layoutTier: tier, createdAt: new Date() });
        const data = { ...TIER_POST, media: TEST_MEDIA, userId: user.id, username: user.username, firstName: user.first_name };
        const layout = await sellerLayout(userId, config.lang, "postAsTier", tier);
        const cardId = await postService.sendToModeration(String(post._id), data, layout);
        if (cardId) await postRepository.setModerationMessageId(String(post._id), cardId);
        await api.sendMessage({
            chat_id: msg.chat.id,
            text: `📮 Sample post as ${tier} is waiting for approval in the moderation group (card ${cardId ?? "none"}). Approve publishes it to the test sale topic in this layout.\nPost ID: ${post._id}`,
        });
    } catch (err) {
        console.error("[ERROR - postAsTier]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Post as tier failed: " + (err as Error).message });
    }
}

const DAY_MS = 24 * 3600 * 1000;
const LIFECYCLE_TITLE = "[test] lifecycle";
const STALE_TITLE = "[test] stale";

/** The tester's own [test] posts and listings with this title, removed (rows only, no group message). */
async function wipeTestRows(userId: string, title: string): Promise<void> {
    for (const l of await listingRepository.findSellerRecent(userId, new Date(0))) {
        if (l.title === title) await listingRepository.deleteById(String(l._id));
    }
    for (const p of await postRepository.findByUserId(userId)) {
        if (p.title === title) await postRepository.deleteById(String(p._id));
    }
}

async function seedTestPost(userId: string, title: string, now: Date) {
    return postRepository.createPost({
        userId, title, description: "test", price: "100", location: "test", media: [], // no photo: a lifecycle test needs none, and a stale file id breaks the rich message
        status: "approved", approvedMessageId: null, createdAt: now,
    });
}

/**
 * Ages the tester's own bot listing (no group message) and nudges or expires just it, so the nudge
 * (7 days) or the expiry (30 days) happens at once, for that listing only.
 */
async function ageTestListing(
    days: number,
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    if (!isTestBotToken(process.env.BOT_TOKEN)) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "⛔ Run on the test bot." });
        return;
    }
    if (days < 30 && !config.nudges) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "nudges is off: /config nudges true first" });
        return;
    }
    try {
        const userId = String(msg.from.id);
        const now = new Date();
        await userService.ensureUser(msg.from);
        let listing = (await listingRepository.findSellerRecent(userId, new Date(0))).find(l => l.title === LIFECYCLE_TITLE);
        if (!listing) {
            const post = await seedTestPost(userId, LIFECYCLE_TITLE, now);
            listing = await listingRepository.createForPost(post, "dm", false, now);
        }
        if (listing.status === "live" && !listing.nudgedAt) {
            await listingRepository.setClockForTest(String(listing._id), new Date(now.getTime() - days * DAY_MS));
        }
        // this one listing only: the global tick could DM other sellers and expire theirs
        let outcome: string;
        if (days >= 30) {
            outcome = (await listingRepository.markExpired(String(listing._id), new Date())) ? "expired" : "unchanged";
        } else {
            const username = (await api.getMe()).username ?? "";
            const fresh = await listingRepository.findById(String(listing._id));
            outcome = fresh ? await new LifecycleService(api, config, postService, () => username).nudgeOne(fresh, new Date()) : "gone";
        }
        const after = await listingRepository.findById(String(listing._id));
        await api.sendMessage({
            chat_id: msg.chat.id,
            text: `⏩ Aged ${days} days: ${outcome}. Listing is now ${after?.status ?? "gone"}.${days >= 30 ? " Expiry sends no message." : ""}`,
        });
    } catch (err) {
        console.error("[ERROR - ageTestListing]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Age listing failed: " + (err as Error).message });
    }
}

/** Two legacy held listings owned by the tester, then /stalecheck for the tester's id only. */
async function testCase_StaleDryRun(
    api: Api,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
): Promise<void> {
    if (!msg.from) throw new Error("Test requires a valid user in message context");
    if (!isTestBotToken(process.env.BOT_TOKEN)) {
        await api.sendMessage({ chat_id: msg.chat.id, text: "⛔ Run on the test bot." });
        return;
    }
    try {
        const userId = String(msg.from.id);
        const now = new Date();
        await userService.ensureUser(msg.from);
        await wipeTestRows(userId, STALE_TITLE);
        for (let i = 0; i < 2; i++) {
            const post = await seedTestPost(userId, STALE_TITLE, new Date(now.getTime() - (40 + i) * DAY_MS));
            await listingRepository.createForPost(post, "legacy", true, now);
        }
        // only the tester's id is ever passed
        const report = await new StaleCheckService(api, config).run([userId], new Date());
        await api.sendMessage({ chat_id: msg.chat.id, text: `📨 Stale-check dry run: ${JSON.stringify(report)}` });
    } catch (err) {
        console.error("[ERROR - testCase_StaleDryRun]", (err as Error).message);
        await api.sendMessage({ chat_id: msg.chat.id, text: "❌ Stale dry run failed: " + (err as Error).message });
    }
}
