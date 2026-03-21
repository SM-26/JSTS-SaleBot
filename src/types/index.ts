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
    configUsage: string;
    configKeyNotFound: string;
    configInvalidValue: string;
    configUpdated: string;
    helpTitle: string;
    helpStart: string;
    helpMyPosts: string;
    helpHelp: string;
    helpAdminSection: string;
    helpConfig: string;
    helpTest: string;
    soldTag: string;
    latestPostTag: string;
    [key: string]: string;
}

export interface Locals {
    [lang: string]: LocaleStrings;
}

export interface UserSession {
    isIdle: boolean;
}
