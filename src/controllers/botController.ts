import type { Api, Bot, Context, Middleware } from "node-telegram-bot-api";
import type { Message, CallbackQuery, InputRichMessage } from "node-telegram-bot-api/types";
import * as fs from "fs";
import * as path from "path";
import postRepository from "../repositories/postRepository";
import userRepository from "../repositories/userRepository";
import { BotConfig, UserSession, Post, User, LocaleService } from "../types";
import { InputService } from "../services/inputService";
import { PostService } from "../services/postService";
import { ModerationService } from "../services/moderationService";
import { UserService } from "../services/userService";
import { MyPostsService } from "../services/myPostsService";
import { AdminService } from "../services/adminService";
import { PendingService } from "../services/pendingService";
import { PaymentService } from "../services/paymentService";
import { FaqService } from "../services/faqService";
import { BroadcastUsersService, truncateFailures } from "../services/broadcastUsersService";
import { localeService } from "../services/localeService";
import { AuthLevel } from "../types";
import { routeCallback, CallbackAction } from "./callbackRoutes";
import { TemporaryListeners } from "./temporaryListeners";
import { command, ParsedCommand } from "./commands";
import { ensureUserMiddleware, staleButtonCatchAll } from "./middleware";
import { TEST_CASES } from "../tests/testCases"; // Comment out to disable tests

const configPath = path.join(__dirname, "../../config.json");
const config: BotConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

export class BotController {
    private api: Api;
    private temporaryListeners = new TemporaryListeners();
    private config: BotConfig;
    private sessions: Map<number, UserSession> = new Map();

    private inputService: InputService;
    private postService: PostService;
    private moderationService: ModerationService;
    private userService: UserService;
    private myPostsService: MyPostsService;
    private adminService: AdminService;
    private pendingService: PendingService;
    private paymentService: PaymentService;
    private faqService: FaqService;
    private broadcastUsersService: BroadcastUsersService;

    constructor(api: Api) {
        this.api = api;
        this.config = config;

        this.inputService = new InputService(api, this.config, this.temporaryListeners);
        this.postService = new PostService(api, this.config);
        this.moderationService = new ModerationService(api, this.config, this.postService, this.temporaryListeners);
        this.userService = new UserService();
        this.myPostsService = new MyPostsService(api, this.config, this.postService);
        this.adminService = new AdminService(api, this.config);
        this.pendingService = new PendingService(api, this.config, this.postService);
        this.paymentService = new PaymentService(api, this.config);
        this.faqService = new FaqService(api, this.config);
        this.broadcastUsersService = new BroadcastUsersService(api);
    }

    async syncSoldPosts(): Promise<void> {
        try {
            const soldPosts: Post[] = await postRepository.getSold();
            let synced = 0; //
            for (const post of soldPosts) {
                const user: User | null = await userRepository.findByUserId(post.userId);
                const richMessage = this.postService.formatPostRichMessage({
                    title: post.title,
                    description: post.description,
                    price: post.price,
                    location: post.location,
                    media: post.media,
                    userId: Number(post.userId),
                    username: user?.userName || undefined,
                    firstName: user?.firstName || "User",
                }, { sold: true });
                const success = await this.postService.markSoldInGroup(post.approvedMessageId!, richMessage);
                if (success) {
                    synced++;
                } else {
                    console.warn(`[WARN - syncSoldPosts] Failed to sync sold status for post ${post._id}. Clearing approvedMessageId.`);
                    await postRepository.setApprovedMessageId(String(post._id), null);
                }
            }
            console.log(`Synced ${synced}/${soldPosts.length} sold post(s) in approved group.`);
        } catch (err) {
            console.error("[ERROR - syncSoldPosts]", (err as Error).message);
        }
    }

    getSession(userId: number): UserSession {
        if (!this.sessions.has(userId)) {
            this.sessions.set(userId, { isIdle: true });
        }
        return this.sessions.get(userId)!;
    }

    async HandleStart(msg: Message): Promise<void> {
        const user = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);
        this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'greeting') });
    }

    async HandleNewPost(msg: Message): Promise<void> {
        console.info('[INFO - HandleNewPost] session active', { userId: msg.from?.id, chatId: msg.chat.id });
        const session: UserSession = this.getSession(msg.from!.id);

        try {
            session.isIdle = false;

                const user = await userRepository.findByUserId(String(msg.from!.id));
            console.debug(`[DEBUG - HandleNewPost] Resolving locale for user: ${msg.from!.id} (lang_code: ${msg.from!.language_code}, pref: ${user?.preferredLocale})`);
            const locale = localeService.resolveUserLocale(user);

            // Collect post details
            const totalSteps = 5;
            const title = await this.inputService.inputWithPrompt(msg, localeService.t(locale, 'welcome'), { locale, index: 1, total: totalSteps });
            const description = await this.inputService.inputWithPrompt(msg, localeService.t(locale, 'enterDescription'), { locale, index: 2, total: totalSteps });
            const price = await this.inputService.inputPrice(msg, { locale, index: 3, total: totalSteps });
            const location = await this.inputService.inputWithPrompt(msg, localeService.t(locale, 'enterLocation'), { locale, index: 4, total: totalSteps });
            const media = await this.inputService.promptMedia(msg, { locale, index: 5, total: totalSteps });

            if (media.length < (this.config.minimumPhotos ?? 0)) {
                this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'notEnoughMedia') });
                console.info('[INFO - HandleNewPost] session idle (insufficient media)', { userId: msg.from?.id });
                session.isIdle = true;
                return;
            }

            const postData = {
                title,
                description,
                price,
                location,
                media,
                userId: msg.from!.id,
                username: msg.from!.username,
                firstName: msg.from!.first_name,
            };

            // Preview & confirm as one message (buttons attached to the preview).
            const richPreview = this.postService.formatPostRichMessage(postData, {
                previewLabel: localeService.t(locale, 'preview'),
            });
            const confirmed = await this.inputService.confirmAction(msg, locale, richPreview);
            if (!confirmed) {
                this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'postCancelled') });
                console.info('[INFO - HandleNewPost] session idle (user cancelled)', { userId: msg.from?.id });
                session.isIdle = true;
                return;
            }

            // Save & send to moderation
            const post: Post = await postRepository.createPost({
                userId: String(msg.from!.id),
                title,
                description,
                price,
                media,
                location,
                createdAt: new Date(),
            });

            const modMsgId = await this.postService.sendToModeration(String(post._id), postData);
            if (modMsgId) {
                await postRepository.setModerationMessageId(String(post._id), modMsgId);
            }

            this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'postCreated') });
            console.info('[INFO - HandleNewPost] session idle (success)', { userId: msg.from?.id });
            session.isIdle = true;

        } catch (err) {
            console.error("[ERROR - HandleNewPost] ", (err as Error).message);
            this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'generalError') });
            console.info('[INFO - HandleNewPost] session idle (error)', { userId: msg.from?.id });
            session.isIdle = true;
        }
    }

    async showHelp(msg: Message): Promise<void> {
        const user: User | null = await userRepository.findByUserId(String(msg.from!.id));
        console.debug(`[DEBUG - showHelp] Resolving locale for user: ${msg.from!.id}`);
        const locale = localeService.resolveUserLocale(user);
        const t = (key: string) => localeService.t(locale, key);

        // Section titles carry <b> tags for the old HTML path; strip them since
        // rich headings style themselves. Command lines are "/cmd - desc" — bold
        // the command part so the list is scannable.
        const heading = (key: string, size: number) => ({ type: "heading", text: t(key).replace(/<\/?b>/g, ""), size });
        const cmd = (key: string) => {
            const line = t(key);
            const i = line.indexOf(" - ");
            const text = i === -1 ? line : [{ type: "bold", text: line.slice(0, i) }, line.slice(i)];
            return { blocks: [{ type: "paragraph", text }] };
        };

        const generalCmds = ['helpStart', 'helpNewPost', 'helpMyPosts', 'helpLang', 'helpHelp'];
        if (this.config.enableFaq !== false) generalCmds.push('helpFaq');
        if (this.config.donationsEnabled !== false) generalCmds.push('helpDonate');

        const blocks: unknown[] = [
            heading('helpTitle', 2),
            { type: "list", items: generalCmds.map(cmd) },
        ];

        const authLevel = user?.authLevel ?? AuthLevel.USER;

        if (authLevel >= AuthLevel.MOD) {
            blocks.push(
                { type: "divider" },
                heading('helpModSection', 3),
                { type: "list", items: ['helpPending', 'helpClearPending', 'helpAuth'].map(cmd) },
            );
        }

        if (authLevel >= AuthLevel.ADMIN) {
            blocks.push(
                { type: "divider" },
                heading('helpAdminSection', 3),
                { type: "list", items: ['helpConfig', 'helpActiveUsers', 'helpPromote', 'helpDemote', 'helpBroadcastTopic', 'helpBroadcastUsers', 'helpTest'].map(cmd) },
            );
        }

        await this.api.sendRichMessage({ chat_id: msg.chat.id, rich_message: { blocks } as unknown as InputRichMessage, message_thread_id: msg.message_thread_id });
    }

    async handleActiveUsers(msg: Message): Promise<void> {
        console.debug('[DEBUG - handleActiveUsers] Admin command triggered', { adminId: msg.from?.id });
        try {
            const user: User | null = await userRepository.findByUserId(String(msg.from!.id));
            const authLevel = user?.authLevel ?? AuthLevel.USER;
            if (authLevel < AuthLevel.ADMIN) {
                console.warn('[WARN - handleActiveUsers] Unauthorized access attempt detected', { userId: msg.from?.id });
                this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'notAdmin') });
                return;
            }

            const locale = localeService.resolveUserLocale(user);

            const activeIds = Array.from(this.sessions.entries())
                .filter(([, session]) => !session.isIdle)
                .map(([userId]) => String(userId));

            const activeUsers: string[] = [];
            const usersFromDb = await userRepository.findManyByIds(activeIds);
            for (const activeUser of usersFromDb) {
                const username = activeUser.userName ? `@${activeUser.userName}` : 'N/A';
                const firstName = activeUser.firstName || 'N/A';
                const lastName = activeUser.lastName || '';
                const fullName = `${firstName} ${lastName}`.trim();
                activeUsers.push(`• <code>${activeUser.userId}</code> | ${username} | ${fullName}`);
            }

            if (activeUsers.length === 0) {
                console.info('[INFO - handleActiveUsers] Command executed, but no active users found.');
                await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'adminActiveUsersEmpty') });
                return;
            }

            console.info(`[INFO - handleActiveUsers] Reporting ${activeUsers.length} active user(s) to admin ${msg.from?.id}`);
            const text = `${localeService.t(locale, 'adminActiveUsersTitle')}\n\n${activeUsers.join('\n')}`;
            await this.api.sendMessage({ chat_id: msg.chat.id, text, parse_mode: "HTML" });
        } catch (err) {
            console.error('[CRITICAL - handleActiveUsers] System failed to generate active users list', (err as Error).message);
            this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'generalError') });
        }
    }

    async handleBroadcastUsers(msg: Message, args: string): Promise<void> {
        const adminId = String(msg.from!.id);
        const user: User | null = await userRepository.findByUserId(adminId);
        const locale = localeService.resolveUserLocale(user);

        const isAuthorized = await this.userService.hasAuthLevel(adminId, AuthLevel.ADMIN);
        if (!isAuthorized) {
            console.warn('[WARN - handleBroadcastUsers] Unauthorized access attempt detected', { userId: msg.from?.id });
            this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'notAdmin') });
            return;
        }

        let htmlMessage: string | undefined;
        if (msg.reply_to_message) {
            if (!msg.reply_to_message.text) {
                this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'broadcastUsersTextOnly') });
                return;
            }
            htmlMessage = msg.reply_to_message.text;
        } else if (args.trim()) {
            htmlMessage = args.trim();
        }

        if (!htmlMessage) {
            this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'broadcastUsersUsage') });
            return;
        }

        const activeIds = Array.from(this.sessions.entries())
            .filter(([, session]) => !session.isIdle)
            .map(([userId]) => String(userId));

        const audience = await this.broadcastUsersService.resolveAudience(activeIds, adminId);
        if (audience.length === 0) {
            console.info('[INFO - handleBroadcastUsers] No recipients found', { adminId });
            this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(locale, 'broadcastUsersNoRecipients') });
            return;
        }

        const report = await this.broadcastUsersService.sendToMany(audience, htmlMessage);
        console.info('[INFO - handleBroadcastUsers] Broadcast complete', { adminId, total: report.total, sent: report.sent, failed: report.failures.length });
        if (report.failures.length > 0) {
            console.log('[INFO - handleBroadcastUsers] Failures:', report.failures);
        }

        const blocks: unknown[] = [
            { type: "heading", text: localeService.t(locale, 'broadcastUsersReportTitle'), size: 2 },
            { type: "paragraph", text: localeService.t(locale, 'broadcastUsersReport', { sent: report.sent, failed: report.failures.length, total: report.total }) },
        ];

        if (report.failures.length > 0) {
            const usersFromDb = await userRepository.findManyByIds(report.failures.map(f => f.userId));
            const mentionById = new Map(usersFromDb.map(u => [u.userId, u.userName ? `@${u.userName}` : 'N/A']));

            const { shown, remainder } = truncateFailures(report.failures);
            blocks.push(
                { type: "divider" },
                {
                    type: "list",
                    items: shown.map(f => ({
                        blocks: [{ type: "paragraph", text: `• ${mentionById.get(f.userId) ?? 'N/A'} (${f.userId}) — ${f.reason}` }],
                    })),
                },
            );

            if (remainder > 0) {
                blocks.push({ type: "paragraph", text: localeService.t(locale, 'broadcastUsersMore', { n: remainder }) });
            }
        }

        await this.api.sendRichMessage({ chat_id: msg.chat.id, rich_message: { blocks } as unknown as InputRichMessage, message_thread_id: msg.message_thread_id });
    }

    async handleLang(msg: Message): Promise<void> {
        const userIdentifier = msg.from?.username || msg.from?.id || 'unknown';
        console.info('[INFO - handleLang]', { user: userIdentifier });
        const user: User | null = await userRepository.findByUserId(String(msg.from!.id));
        const currentLocale = localeService.resolveUserLocale(user);
        const availableLocales = localeService.availableLocales;

        const buttons = availableLocales.map(lang => ({
            text: lang.toUpperCase(),
            callback_data: `lang_${lang}`
        }));

        const text = localeService.t(currentLocale, 'langMenu', { lang: currentLocale.toUpperCase() });

        await this.api.sendMessage({ chat_id: msg.chat.id, text, message_thread_id: msg.message_thread_id,
            reply_markup: { inline_keyboard: [buttons] } });
    }

    async handleDonate(msg: Message): Promise<void> {
        if (this.config.donationsEnabled === false) {
            await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'donationDisabled') });
            return;
        }

        const user: User | null = await userRepository.findByUserId(String(msg.from!.id));
        const locale = localeService.resolveUserLocale(user);
        const text = `${localeService.t(locale, 'donateTitle')}\n${localeService.t(locale, 'donateChooseAmount')}`;

        const buttons = [
            [
                { text: "⭐ 50", callback_data: "donate_50" },
                { text: "⭐ 150", callback_data: "donate_150" },
                { text: localeService.t(locale, 'donateOther'), callback_data: "donate_other" }
            ]
        ];

        await this.api.sendMessage({ chat_id: msg.chat.id, text, parse_mode: "HTML",
            message_thread_id: msg.message_thread_id,
            reply_markup: { inline_keyboard: buttons } });
    }

    private async dispatchCallback(query: CallbackQuery, route: { action: CallbackAction; arg: string }): Promise<void> {
        try {
            if (route.action === "test") {
                const key = route.arg;
                if (!query.message) return;
                this.api.answerCallbackQuery({ callback_query_id: query.id });
                this.api.editMessageReplyMarkup({
                    chat_id: query.message.chat.id,
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: [] },
                }).catch((err: Error) => console.warn("[WARN - botController.testMenu] editMessageReplyMarkup failed:", err.message));
                const fakeMsg = { ...query.message, from: query.from } as Message;

                if (key === "all") {
                    for (const tc of Object.values(TEST_CASES)) {
                        await tc.run(this.api, this.config, localeService, this.postService, this.userService, this.paymentService, this.inputService, fakeMsg);
                    }
                } else {
                    const tc = TEST_CASES[key];
                    if (!tc) return;
                    await tc.run(this.api, this.config, localeService as LocaleService, this.postService, this.userService, this.paymentService, this.inputService, fakeMsg);
                }
                return;
            }

            if (route.action === "faq") {
                await this.faqService.handleCallback(query);
                return;
            }

            if (route.action === "approve" || route.action === "reject") {
                await this.moderationService.handleCallback(query);
                return;
            }

            if (route.action === "clearRejected") {
                await this.myPostsService.handleClearStatus(query, "rejected");
                return;
            }

            if (route.action === "clearSold") {
                await this.myPostsService.handleClearStatus(query, "sold");
                return;
            }

            if (route.action === "sold") {
                await this.myPostsService.handleSoldCallback(query);
                return;
            }

            if (route.action === "bump") {
                await this.myPostsService.handleBumpCallback(query);
                return;
            }

            if (route.action === "lang") {
                const lang = route.arg;
                await userRepository.updateUser(String(query.from.id), { preferredLocale: lang });
                this.api.answerCallbackQuery({ callback_query_id: query.id });
                // Confirm in the language the user just picked.
                this.api.sendMessage({ chat_id: query.message!.chat.id, text: localeService.t(lang, 'langUpdated', { lang: lang.toUpperCase() }) });
                return;
            }

            // --- Donation Callbacks ---
            if (route.action === "donate") {
                const action = route.arg;
                const chatId = query.message?.chat.id;
                if (!chatId) return;

                // Clear buttons
                this.api.editMessageReplyMarkup({
                    chat_id: chatId,
                    message_id: query.message?.message_id,
                    reply_markup: { inline_keyboard: [] },
                }).catch((err: Error) => console.warn("[WARN - botController.donate] editMessageReplyMarkup failed:", err.message));
                this.api.answerCallbackQuery({ callback_query_id: query.id });

                if (action === "other") {
                    const session = this.getSession(query.from.id);
                    session.awaitingDonation = true;
                    this.api.sendMessage({ chat_id: chatId, text: localeService.t(this.config.lang, 'donateEnterAmount') });
                } else {
                    const amount = parseInt(action, 10);
                    if (!isNaN(amount)) {
                        await this.paymentService.sendDonationInvoice(chatId, amount);
                    }
                }
            }
        } catch (err) {
            console.error("[ERROR - callback_query]", (err as Error).message);
        }
    }

    /**
     * Handlers never wait for the flow they start: the polling loop handles one
     * update at a time, and /newPost, the reject-reason prompt and the /test
     * flows wait for the user's next message or button press (as in v1, where
     * the emitter did not await listeners either).
     */
    private detach(name: string, task: Promise<unknown>): void {
        task.catch((err) => console.error(`[ERROR - ${name}]`, err));
    }

    registerRoutes(bot: Bot, botUsername: string): void {
        const isPrivate = (msg: Message) => msg.chat.type === "private";
        const cmd = (names: string | string[], handler: (msg: Message, args: string) => unknown): Middleware<Context> =>
            command(names, () => botUsername, (ctx) => {
                const { name, args } = ctx.state.command as ParsedCommand;
                this.detach(`/${name}`, Promise.resolve().then(() => handler(ctx.message!, args)));
            });

        bot.use(ensureUserMiddleware(from => this.userService.ensureUser(from)));
        bot.use(this.temporaryListeners.middleware());

        // Global message handler for payments, group replies and the custom donation amount
        bot.use(async (ctx, next) => {
            const msg = ctx.message;
            if (!msg) return next();

            // 1. Handle Successful Payment
            if (msg.successful_payment) {
                await this.paymentService.handleSuccessfulPayment(msg);
                return;
            }

            // 2. Handle Replies in the Approved Group (Buyer to Seller communication)
            if (msg.chat.id === this.config.approvedGroupId && msg.reply_to_message) {
                await this.postService.handlePublicReply(msg);
                return;
            }

            // 3. Handle Custom Donation Amount
            if (msg.from) {
                const session = this.getSession(msg.from.id);
                if (session.awaitingDonation && msg.text) {
                    // Ignore commands so we don't block /cancel or /start
                    if (msg.text.startsWith("/")) {
                        session.awaitingDonation = false;
                        return next();
                    }
                    // Try to parse amount
                    const amount = parseInt(msg.text, 10);
                    if (!isNaN(amount) && amount > 0) {
                        session.awaitingDonation = false; // Reset state
                        await this.paymentService.sendDonationInvoice(msg.chat.id, amount);
                    } else {
                        await this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'donateInvalidAmount') });
                    }
                    return;
                }
            }

            return next();
        });

        bot.use(cmd("start", (msg) => {
            if (!isPrivate(msg)) return;
            return this.HandleStart(msg);
        }));
        bot.use(cmd("newpost", (msg) => {
            if (!isPrivate(msg)) return;
            return this.HandleNewPost(msg);
        }));
        bot.use(cmd("myposts", (msg) => {
            if (!isPrivate(msg)) return;
            return this.myPostsService.showPosts(msg);
        }));
        bot.use(cmd("help", (msg) => {
            if (!isPrivate(msg)) return;
            return this.showHelp(msg);
        }));
        bot.use(cmd("lang", (msg) => {
            if (!isPrivate(msg)) return;
            return this.handleLang(msg);
        }));
        if (this.config.enableFaq !== false) {
            bot.use(cmd("faq", (msg) => {
                if (!isPrivate(msg)) return;
                return this.faqService.handleFaq(msg);
            }));
        }
        bot.use(cmd("config", (msg, args) => {
            if (!isPrivate(msg)) return;
            return this.adminService.handleConfig(msg, args);
        }));
        bot.use(cmd("activeusers", (msg) => {
            if (!isPrivate(msg)) return;
            return this.handleActiveUsers(msg);
        }));
        bot.use(cmd("pending", async (msg) => {
            const isAuthorized = await this.userService.hasAuthLevel(String(msg.from!.id), AuthLevel.MOD);
            if (!isAuthorized) {
                this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'notAdmin') });
                return;
            }
            return this.pendingService.handlePending(msg);
        }));
        bot.use(cmd("clearpending", async (msg) => {
            if (!isPrivate(msg)) return;
            const isAuthorized = await this.userService.hasAuthLevel(String(msg.from!.id), AuthLevel.MOD);
            if (!isAuthorized) {
                this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'notAdmin') });
                return;
            }
            return this.pendingService.handleClearPending(msg);
        }));
        bot.use(cmd("broadcast", (msg, args) => {
            if (!isPrivate(msg)) return;
            return this.adminService.handleBroadcast(msg, args);
        }));
        bot.use(cmd("broadcastusers", (msg, args) => {
            if (!isPrivate(msg)) return;
            return this.handleBroadcastUsers(msg, args);
        }));
        bot.use(cmd("promote", (msg, args) => {
            if (!isPrivate(msg)) return;
            return this.adminService.handlePromote(msg, args);
        }));
        bot.use(cmd("demote", (msg, args) => {
            if (!isPrivate(msg)) return;
            return this.adminService.handleDemote(msg, args);
        }));
        bot.use(cmd("auth", (msg, args) => {
            if (!isPrivate(msg)) return;
            return this.adminService.handleAuth(msg, args);
        }));
        bot.use(cmd("test", async (msg) => {
            if (!isPrivate(msg)) return;
            const user: User | null = await userRepository.findByUserId(String(msg.from!.id));
            const authLevel = user?.authLevel ?? AuthLevel.USER;
            if (authLevel < AuthLevel.ADMIN) {
                this.api.sendMessage({ chat_id: msg.chat.id, text: localeService.t(this.config.lang, 'notAdmin') });
                return;
            }
            const buttons = Object.entries(TEST_CASES).map(([key, tc]) => ([
                { text: tc.label, callback_data: `test_${key}` },
            ]));
            buttons.push([{ text: "🚀 Run All", callback_data: "test_all" }]);
            this.api.sendMessage({
                chat_id: msg.chat.id,
                text: "Select a test case:",
                message_thread_id: msg.message_thread_id,
                reply_markup: { inline_keyboard: buttons },
            });
        }));
        bot.use(cmd("donate", (msg) => {
            if (!isPrivate(msg)) return;
            return this.handleDonate(msg);
        }));

        // --- Payment Events ---
        bot.on("pre_checkout_query", async (ctx) => {
            if ("pre_checkout_query" in ctx.update) {
                await this.paymentService.handlePreCheckout(ctx.update.pre_checkout_query);
            }
        });

        bot.on("callback_query", (ctx, next) => {
            const query = ctx.callbackQuery!;
            const route = query.data ? routeCallback(query.data) : null;
            if (!route) return next();
            this.detach("callback_query", this.dispatchCallback(query, route));
        });

        // Last: wizard/prompt buttons nobody handled belong to a flow that is gone.
        bot.use(staleButtonCatchAll(async (ctx) => {
            const user: User | null = ctx.from ? await userRepository.findByUserId(String(ctx.from.id)) : null;
            return localeService.t(localeService.resolveUserLocale(user), "staleButton");
        }));
    }
}
