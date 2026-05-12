import userRepository from "../repositories/userRepository";
import { AuthLevel, User } from "../types";

export class UserService {
    async ensureUser(from: { id: number; first_name: string; last_name?: string; username?: string; language_code?: string }): Promise<void> {
        const userId = String(from.id);

        // Fetch existing user to avoid overwriting with incomplete data
        const existingUser = await userRepository.findByUserId(userId);

        const setData: Partial<User> = { userId };
        // authLevel is the only field that should be set exclusively on insert if not already present.
        // Other fields (firstName, lastName, etc.) are handled by setData and Mongoose defaults.
        const setOnInsert: Partial<User> = {}; // authLevel will be handled by Mongoose default or migration

        // Conditionally set fields for $set operation (updates existing fields)
        // Only update if the incoming 'from' object explicitly provides a non-empty value.
        // Otherwise, preserve the existing value or leave it untouched.

        // firstName
        if (from.first_name !== undefined && from.first_name !== null && from.first_name.trim() !== '') {
            setData.firstName = from.first_name;
        }

        // lastName
        if (from.last_name !== undefined && from.last_name !== null && from.last_name.trim() !== '') {
            setData.lastName = from.last_name;
        }

        // userName
        if (from.username !== undefined && from.username !== null && from.username.trim() !== '') {
            setData.userName = from.username;
        }

        // languageCode
        if (from.language_code !== undefined && from.language_code !== null && from.language_code.trim() !== '') {
            setData.languageCode = from.language_code;
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