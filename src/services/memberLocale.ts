import userRepository from "../repositories/userRepository";
import memberRepository from "../repositories/memberRepository";
import { localeService } from "./localeService";

/**
 * The locale for a private note (or its button answers) to a group member: their own choice or app language
 * from the bot's user row, else the Telegram language of this update (`liveCode`), else the one their last
 * sale-topic message had, else the group's.
 */
export async function memberLocale(userId: string, liveCode?: string): Promise<string> {
    const user = await userRepository.findByUserId(userId);
    if (user?.preferredLocale || user?.languageCode) return localeService.resolveUserLocale(user, liveCode);
    const member = await memberRepository.findByUserId(userId);
    return localeService.resolveUserLocale(user, liveCode, member?.languageCode);
}
