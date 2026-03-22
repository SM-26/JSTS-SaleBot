import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";
import postRepository from "../repositories/postRepository";
import { BotConfig, Locals, UserSession } from "../types";
import { InputService } from "../services/inputService";
import { MediaService } from "../services/photoService";
import { PostService } from "../services/postService";
import { ModerationService } from "../services/moderationService";
import { UserService } from "../services/userService";
import { MyPostsService } from "../services/myPostsService";
import userRepository from "../repositories/userRepository";
import { TEST_CASES } from "../tests/testCases"; // Comment out to disable tests

const configPath = path.join(__dirname, "../../config.json");
const config: BotConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

export class BotController {
    private bot: TelegramBot;
    private locals: Locals;
    private config: BotConfig;
    private sessions: Map<number, UserSession> = new Map();

    private inputService: InputService;
    private mediaService: MediaService;
    private postService: PostService;
    private moderationService: ModerationService;
    private userService: UserService;
    private myPostsService: MyPostsService;

    constructor(bot: TelegramBot) {
        this.bot = bot;
        this.locals = this.loadLocals();
        this.config = config;

        this.inputService = new InputService(bot, this.config, this.locals);
        this.mediaService = new MediaService();
        this.postService = new PostService(bot, this.config, this.locals, this.mediaService);
        this.moderationService = new ModerationService(bot, this.config, this.locals, this.postService);
        this.userService = new UserService();
        this.myPostsService = new MyPostsService(bot, this.config, this.locals, this.postService);
    }

    getSession(userId: number): UserSession {
        if (!this.sessions.has(userId)) {
            this.sessions.set(userId, { isIdle: true });
        }
        return this.sessions.get(userId)!;
    }

    private loadLocals(): Locals {
        const localsPath = path.join(__dirname, "../../locals.json");
        return JSON.parse(fs.readFileSync(localsPath, "utf-8"));
    }

    async HandleStart(msg: TelegramBot.Message): Promise<void> {
        const lang = this.config.lang;
        const session = this.getSession(msg.from!.id);

        try {
            session.isIdle = false;

            await this.userService.ensureUser(msg.from!);

            // Collect post details
            const title = await this.inputService.inputWithPrompt(msg, this.locals[lang].welcome);
            const description = await this.inputService.inputWithPrompt(msg, this.locals[lang].enterDescription);
            const price = await this.inputService.inputPrice(msg);
            const location = await this.inputService.inputWithPrompt(msg, this.locals[lang].enterLocation);
            const media = await this.inputService.promptMedia(msg);

            if (media.length < this.config.minimumMedia) {
                this.bot.sendMessage(msg.chat.id, this.locals[lang].notEnoughMedia);
                session.isIdle = true;
                return;
            }

            // Build post text
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
            const postText = this.postService.formatPostText(postData);

            // Preview & confirm
            await this.postService.sendPreview(msg.chat.id, postText, media);

            const confirmed = await this.inputService.confirmAction(msg);
            if (!confirmed) {
                this.bot.sendMessage(msg.chat.id, this.locals[lang].postCancelled);
                session.isIdle = true;
                return;
            }

            // Save & send to moderation
            const post = await postRepository.createPost({
                userId: String(msg.from!.id),
                title,
                description,
                price,
                media,
                location,
                createdAt: new Date(),
            });

            await this.postService.sendToModeration(String(post._id), postText, media);

            this.bot.sendMessage(msg.chat.id, this.locals[lang].postCreated);
            session.isIdle = true;

        } catch (err) {
            console.error("[ERROR - HandleStart] ", (err as Error).message);
            this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].generalError);
            session.isIdle = true;
        }
    }

    registerRoutes(): void {
        this.bot.onText(/\/start/, (msg) => this.HandleStart(msg));
        this.bot.onText(/\/myposts/, (msg) => this.myPostsService.showPosts(msg));

        // --- /test command: comment out to disable ---
        this.bot.onText(/\/test/, async (msg) => {
            const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
            if (!isAdmin) {
                this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].notAdmin);
                return;
            }
            const buttons = Object.entries(TEST_CASES).map(([key, tc]) => ([
                { text: tc.label, callback_data: `test_${key}` },
            ]));
            buttons.push([{ text: "🚀 Run All", callback_data: "test_all" }]);
            this.bot.sendMessage(msg.chat.id, "Select a test case:", {
                reply_markup: { inline_keyboard: buttons },
            });
        });

        this.bot.on("callback_query", async (query) => {
            if (!query.data) return;

            try {
                if (query.data.startsWith("test_")) {
                    const key = query.data.replace("test_", "");
                    if (!query.message) return;
                    this.bot.answerCallbackQuery(query.id);
                    this.bot.editMessageReplyMarkup(
                        { inline_keyboard: [] },
                        { chat_id: query.message.chat.id, message_id: query.message.message_id }
                    );
                    const fakeMsg = { ...query.message, from: query.from } as TelegramBot.Message;

                    if (key === "all") {
                        for (const tc of Object.values(TEST_CASES)) {
                            await tc.run(this.bot, this.config, this.locals, this.postService, this.userService, fakeMsg);
                        }
                    } else {
                        const tc = TEST_CASES[key];
                        if (!tc) return;
                        tc.run(this.bot, this.config, this.locals, this.postService, this.userService, fakeMsg);
                    }
                    return;
                }

                if (query.data.startsWith("approve_") || query.data.startsWith("reject_")) {
                    await this.moderationService.handleCallback(query);
                    return;
                }

                if (query.data.startsWith("sold_")) {
                    await this.myPostsService.handleSoldCallback(query);
                    return;
                }

                if (query.data.startsWith("bump_")) {
                    await this.myPostsService.handleBumpCallback(query);
                }
            } catch (err) {
                console.error("[ERROR - callback_query]", (err as Error).message);
            }
        });
    }
}
