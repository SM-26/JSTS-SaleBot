export interface MediaItem {
    fileId: string;
    type: "photo" | "video";
}

export interface BotConfig {
    lang: string;
    moderationGroupId: number;
    approvedGroupId: number;
    moderationTopicId: number;
    approvedTopicId: number;
    timeOut: number;
    validatePrice: boolean;
    minimumMedia: number;
    dailyBumpLimit: number;
    donationsEnabled?: boolean;
    enableFaq?: boolean;
}

export interface LocaleStrings {
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
    helpMyPosts: string;
    helpHelp: string;
    helpAdminSection: string;
    helpConfig: string;
    helpPending: string;
    helpClearPending: string;
    helpTest: string;
    helpDonate: string;
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
    resolveUserLocale(user: any): string;
    getMessages(locale: string, namespace?: string): Record<string, string>;
    getFaqs(locale: string): Record<string, string>;
    t(locale: string, key: string, params?: Record<string, any>): string;
    availableLocales: string[];
}

export interface UserSession {
    isIdle: boolean;
    awaitingDonation?: boolean;
}
