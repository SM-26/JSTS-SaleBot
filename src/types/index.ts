import type { Api } from "node-telegram-bot-api";
import type { Message, SendMessageParams, EditMessageTextParams } from "node-telegram-bot-api/types";
import { PostService } from "../services/postService";
import { UserService } from "../services/userService";
import { PaymentService } from "../services/paymentService";
import { InputService } from "../services/inputService";
import type { StoredEntity } from "../models/Post";

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
    minimumPhotos: number;
    dailyBumpLimit: number;
    donationsEnabled?: boolean;
    enableFaq?: boolean;
    mediaLayout?: "slideshow" | "collage";
    // Market switches; a missing key means off / off / false / "".
    captureMode?: "off" | "shadow" | "optin";
    buyerMatches?: "off" | "shadow" | "on";
    nudges?: boolean;
    rulesUrl?: string;
    quickListing?: boolean;
}

export interface LocaleStrings {
    greeting: string;
    welcome: string;
    wizardStep: string;
    contactSellerCta: string;
    meetupPlace: string;
    quickSellHint: string;
    quickPhotoHint: string;
    dmAlertHint: string;
    dmSellHint: string;
    dmWantedOff: string;
    trustLine: string;
    enterDescription: string;
    enterPrice: string;
    expectedText: string;
    enterMedia: string;
    doneMediaButton: string;
    editTitleButton: string;
    editPriceButton: string;
    editLocationButton: string;
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
    staleButton: string;
    notYourButton: string;
    replyToPromptHint: string;
    draftExpired: string;
    draftInProgress: string;
    draftContinueButton: string;
    draftRestartButton: string;
    cancelDone: string;
    cancelNothing: string;
    statusApproved: string;
    statusRejected: string;
    rejectReasonPrompt: string;
    rejectPreset1: string;
    rejectPreset2: string;
    rejectPreset3: string;
    rejectPreset4: string;
    rejectFixButton: string;
    rejectRulesButton: string;
    authorNotNotified: string;
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
    configExpected: string;
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
    helpCancel: string;
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
    helpBroadcastUsers: string;
    broadcastUsersUsage: string;
    broadcastUsersTextOnly: string;
    broadcastUsersNoRecipients: string;
    broadcastUsersReport: string;
    broadcastUsersMore: string;
    broadcastUsersReportTitle: string;
    langUpdated: string;
    pendingMore: string;
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

// The `data` bag of the v2 session (one per chat+user, persisted in Mongo).
export interface UserSession {
    awaitingDonation?: boolean;
    // Mirror of the moderator's pending reject-reason prompts in this chat; the
    // reply-tracking table itself has no read-only peek. postId is absent on
    // entries written before 3.0.
    pendingRejects?: { promptId: number; skipMsgId: number; postId?: string }[];
    // The buyer's one-reply fix after a saved search (or a failed one): the row it edits, the prompt and when.
    pendingAlertFix?: { searchId?: string; promptId: number; at: number };
    // Admin's /stalecheck dry run waiting for sc_go; ignored after an hour.
    pendingStalecheck?: { sellerIds: string[]; at: number; promptMessageId?: number };
}

export interface Post {
    _id: string | unknown;
    userId: string;
    title: string;
    description: string;
    descriptionEntities?: StoredEntity[];
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
    rejectionNotifiedAt?: Date | null;
    meetup?: boolean;
    layoutTier?: "regular" | "top" | "verified" | "both";
    highlight?: string;
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
    api: Api,
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
