import mongoose from "mongoose";
import User, { IUser } from "../models/User";
import { AuthLevel, User as UserType } from "../types";

class UserRepository {
    async findByUserId(userId: string): Promise<IUser | null> {
        return User.findOne({ userId }).exec();
    }

    async findByUsername(userName: string): Promise<IUser | null> {
        return User.findOne({ userName: { $regex: new RegExp(`^${userName}$`, "i") } }).exec();
    }

    async findManyByIds(userIds: string[]): Promise<IUser[]> {
        return User.find({ userId: { $in: userIds } }).exec();
    }

    async upsertUserWithInsert(userId: string, setData: Partial<IUser>, setOnInsert: Partial<IUser>): Promise<IUser | null> {
        // Check if the user exists to handle migration from isAdmin to authLevel
        const existingUser = await User.findOne({ userId }).exec();

        if (existingUser && typeof (existingUser as UserType & { isAdmin?: boolean }).isAdmin === 'boolean' && existingUser.authLevel === undefined) {
            // Migration logic: if isAdmin exists and authLevel doesn't, set authLevel
            const isAdmin = (existingUser as UserType & { isAdmin?: boolean }).isAdmin;
            existingUser.authLevel = isAdmin ? AuthLevel.ADMIN : AuthLevel.USER;
            // Remove isAdmin field
            await User.updateOne({ userId }, { $unset: { isAdmin: 1 }, $set: { authLevel: existingUser.authLevel } }).exec();
            // Update existingUser object to reflect changes
            existingUser.markModified('authLevel');
            delete (existingUser as UserType & { isAdmin?: boolean }).isAdmin;
        }

        return User.findOneAndUpdate(
            { userId },
            { $set: setData, $setOnInsert: setOnInsert },
            {
                new: true, // Return the updated document
                upsert: true,
                returnDocument: 'after',
                runValidators: true
            }
        ).exec();
    }

    async updateUser(userId: string, updateData: Partial<IUser>): Promise<IUser | null> {
        const update: mongoose.UpdateQuery<IUser> = { $set: updateData };

        // If we are updating authLevel, ensure the legacy isAdmin field is removed
        if (updateData.authLevel !== undefined) {
            update.$unset = { isAdmin: 1 };
        }

        return User.findOneAndUpdate(
            { userId },
            update,
            {
                new: true, // Return the updated document
                returnDocument: 'after'
            }
        ).exec();
    }

    async getAll(): Promise<IUser[]> {
        return User.find().exec();
    }

    async countByAuthLevel(level: AuthLevel): Promise<number> {
        return User.countDocuments({ authLevel: level }).exec();
    }

    async deleteByUserId(userId: string): Promise<boolean> {
        const result = await User.deleteOne({ userId }).exec();
        return result.deletedCount > 0;
    }

    async hasAuthLevel(userId: string, level: AuthLevel): Promise<boolean> {
        const user = await this.findByUserId(userId);
        return (user?.authLevel ?? AuthLevel.USER) >= level;
    }
}

export default new UserRepository();