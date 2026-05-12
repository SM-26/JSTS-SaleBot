import userRepository from "../repositories/userRepository";
import { AuthLevel, User } from "../types";

export class UserService {
    async ensureUser(from: { id: number; first_name: string; last_name?: string; username?: string; language_code?: string }): Promise<void> {
        const userId = String(from.id);

        const userData = {
            userId,
            firstName: from.first_name,
            lastName: from.last_name || null,
            userName: from.username || null,
            // authLevel will be set by upsertUserWithInsert or migration
        };

        const setData = { ...userData };
        const setOnInsert: Partial<User> = { authLevel: AuthLevel.USER };
        if (from.language_code) {
            setOnInsert.languageCode = from.language_code;
        }

        await userRepository.upsertUserWithInsert(userId, setData, setOnInsert);
    }

    async hasAuthLevel(userId: string, level: AuthLevel): Promise<boolean> {
        return userRepository.hasAuthLevel(userId, level);
    }

    async isUserAdmin(userId: string): Promise<boolean> {
        return this.hasAuthLevel(userId, AuthLevel.ADMIN);
    }
}

export const userService = new UserService();