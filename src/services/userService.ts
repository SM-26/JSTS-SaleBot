import userRepository from "../repositories/userRepository";

export class UserService {
    async ensureUser(from: { id: number; first_name: string; last_name?: string; username?: string }): Promise<void> {
        const userId = String(from.id);

        const userData = {
            userId,
            firstName: from.first_name,
            lastName: from.last_name || null,
            userName: from.username || null,
        };

        // By using the upsert logic here, we save an extra 'find' call.
        // It creates the user if missing, or updates them if they already exist.
        await userRepository.upsertUser(userId, userData);
    }

    async isUserAdmin(userId: number): Promise<boolean> {
        return userRepository.isAdmin(String(userId));
    }
}
export default new UserService();