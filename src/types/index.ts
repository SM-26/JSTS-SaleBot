import TelegramBot, { Message, SendMessageParams, EditMessageTextParams } from "node-telegram-bot-api";
import { PostService } from "../services/postService";
import { UserService } from "../services/userService";
import { PaymentService } from "../services/paymentService";
import { InputService } from "../services/inputService";

export interface MediaItem {
    fileId: string;
    type: "photo" | "video";
}

export enum AuthLevel {
    USER = 0,
    MOD = 1,
    ADMIN = 2
}

export interface BotConfig {
    lang: string;
    moderationGroupId: number;
    approvedGroupId: number;
    moderationTopicId: number;
    approvedTopicId: number;
    broadcastTopicId?: number | null;
    timeOut: number;
    validatePrice: boolean;
    minimumMedia: number;
    dailyBumpLimit: number;
    donationsEnabled?: boolean;
    enableFaq?: boolean;
}

export interface LocaleStrings {
    greeting: string;
    welcome: string;
    enterDescription: string;
    enterPrice: string;
    enterMedia: string;
    doneMediaButton: string;
    enterLocation: string;
    postCreated: string;
    postApproved: string;
    postRejected: string;
    invalidPrice: string;
    notEnoughMedia: string;
    generalError: string;
    preview: string;
    confirmButton: string;
    cancelButton: string;
    postCancelled: string;
    approveButton: string;
    rejectButton: string;
    moderationPrompt: string;
    statusApproved: string;
    statusRejected: string;
    rejectReasonPrompt: string;
    skipReasonButton: string;
    postRejectedWithReason: string;
    notAdmin: string;
    myPostsTitle: string;
    myPostsEmpty: string;
    myPostsStatusPending: string;
    myPostsStatusApproved: string;
    myPostsStatusRejected: string;
    myPostsStatusSold: string;
    markSoldButton: string;
    postMarkedSold: string;
    postNotFound: string;
    bumpButton: string;
    bumpSuccess: string;
    bumpLimitReached: string;
    bumpNotApproved: string;
    bumpsUsed: string;
    configTitle: string;
    configUsage: string;
    configKeyNotFound: string;
    configInvalidValue: string;
    configUpdated: string;
    adminPostNotFound: string;
    adminPostHandled: string;
    adminUserNotFound: string;
    adminError: string;
    adminApproved: string;
    adminRejected: string;
    helpTitle: string;
    helpStart: string;
    helpNewPost: string;
    helpMyPosts: string;
    helpHelp: string;
    helpAdminSection: string;
    helpConfig: string;
    helpPending: string;
    helpClearPending: string;
    helpTest: string;
    helpDonate: string;
    helpPromote: string;
    promoteSuccess: string;
    promoteAlreadyAtLevel: string;
    promoteLimitReached: string;
    userNotFound: string;
    donateTitle: string;
    donateChooseAmount: string;
    donateOther: string;
    donateEnterAmount: string;
    donateInvalidAmount: string;
    donateInvoiceTitle: string;
    donateInvoiceDesc: string;
    donationDisabled: string;
    donationSuccess: string;
    soldTag: string;
    latestPostTag: string;
    adminPendingTitle: string;
    adminPendingEmpty: string;
    adminPendingLink: string;
    adminClearPendingSuccess: string;
    [key: string]: string;
}

export interface Locals {
    [lang: string]: LocaleStrings;
}

export interface LocaleService {
    resolveUserLocale(user: User | null): string;
    getMessages(locale: string, namespace?: string): Record<string, string>;
    getFaqs(locale: string): Record<string, string>;
    t(locale: string, key: string, params?: Record<string, string | number | boolean>): string;
    availableLocales: string[];
}

export interface UserSession {
    isIdle: boolean;
    awaitingDonation?: boolean;
}

export interface Post {
    _id: string | unknown;
    userId: string;
    title: string;
    description: string;
    price: string;
    media: MediaItem[];
    location: string;
    createdAt: Date;
    status: "pending" | "approved" | "rejected" | "sold";
    moderationMessageId?: number | null;
    approvedMessageId?: number | null;
    dailyBumpCount?: number | null;
    lastBumpAt?: Date | null;
    rejectionReason?: string | null;
}

export interface User {
    userId: string;
    userName?: string | null;
    firstName: string | null;
    lastName?: string | null;
    preferredLocale?: string | null;
    languageCode?: string | null;
    authLevel: AuthLevel;
}

export type TestCaseFn = (
    bot: TelegramBot,
    config: BotConfig,
    localeService: LocaleService,
    postService: PostService,
    userService: UserService,
    paymentService: PaymentService,
    inputService: InputService,
    msg: Message
) => Promise<void>;

export type SendMessageOptions = Omit<SendMessageParams, "chat_id" | "text">;
export type EditMessageTextOptions = Omit<EditMessageTextParams, "text">;
