import TelegramBot from "node-telegram-bot-api";
import * as fs from "fs";
import * as path from "path";
import postRepository from "../repositories/postRepository";
import { BotConfig, Locals, UserSession } from "../types";
import { InputService } from "../services/inputService";
import { PhotoService } from "../services/photoService";
import { PostService } from "../services/postService";
import { ModerationService } from "../services/moderationService";
import { UserService } from "../services/userService";
import userRepository from "../repositories/userRepository";
import { runTests } from "../tests/testCases"; // Comment out to disable tests

const configPath = path.join(__dirname, "../../config.json");
const config: BotConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

export class BotController {
    private bot: TelegramBot;
    private locals: Locals;
    private config: BotConfig;
    private sessions: Map<number, UserSession> = new Map();

    private inputService: InputService;
    private photoService: PhotoService;
    private postService: PostService;
    private moderationService: ModerationService;
    private userService: UserService;

    constructor(bot: TelegramBot) {
        this.bot = bot;
        this.locals = this.loadLocals();
        this.config = config;

        this.inputService = new InputService(bot, this.config, this.locals);
        this.photoService = new PhotoService(bot);
        this.postService = new PostService(bot, this.config, this.locals, this.photoService);
        this.moderationService = new ModerationService(bot, this.config, this.locals, this.postService);
        this.userService = new UserService();
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
            const photos = await this.inputService.promptPhotos(msg, (fileId) => this.photoService.downloadPhoto(fileId));

            if (photos.length < this.config.minimumPhotos) {
                this.bot.sendMessage(msg.chat.id, this.locals[lang].notEnoughPhotos);
                session.isIdle = true;
                return;
            }

            // Build post text
            const postData = {
                title,
                description,
                price,
                location,
                photos,
                userId: msg.from!.id,
                username: msg.from!.username,
                firstName: msg.from!.first_name,
            };
            const postText = this.postService.formatPostText(postData);

            // Preview & confirm
            await this.postService.sendPreview(msg.chat.id, postText, photos);

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
                photos,
                location,
                createdAt: new Date(),
            });

            await this.postService.sendToModeration(String(post._id), postText, photos);

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

        // --- /test command: comment out to disable ---
        this.bot.onText(/\/test/, async (msg) => {
            const isAdmin = await userRepository.isAdmin(String(msg.from!.id));
            if (!isAdmin) {
                this.bot.sendMessage(msg.chat.id, this.locals[this.config.lang].notAdmin);
                return;
            }
            runTests(this.bot, this.config, this.locals, this.postService, this.userService, msg);
        });

        this.bot.on("callback_query", (query) => {
            if (!query.data) return;

            if (query.data.startsWith("approve_") || query.data.startsWith("reject_")) {
                this.moderationService.handleCallback(query);
            }
        });
    }
}
