export interface BotConfig {
    lang: string;
    moderationGroupId: number;
    approvedGroupId: number;
    moderationTopicId: number;
    approvedTopicId: number;
    timeOut: number;
    validatePrice: boolean;
    minimumPhotos: number;
}

export interface LocaleStrings {
    welcome: string;
    enterDescription: string;
    enterPrice: string;
    enterPhotos: string;
    donePhotosButton: string;
    enterLocation: string;
    postCreated: string;
    postApproved: string;
    postRejected: string;
    invalidPrice: string;
    notEnoughPhotos: string;
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
    [key: string]: string;
}

export interface Locals {
    [lang: string]: LocaleStrings;
}

export interface UserSession {
    isIdle: boolean;
}
