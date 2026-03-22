import User, { IUser } from "../models/User";

class UserRepository {
    async findByUserId(userId: string): Promise<IUser | null> {
        return User.findOne({ userId }).exec();
    }

    async upsertUser(userId: string, userData: Partial<IUser>): Promise<IUser | null> {
        return User.findOneAndUpdate(
            { userId },
            { $set: userData },
            {
                upsert: true,
                new: true,
                runValidators: true
            }
        ).exec();
    }

    async updateUser(userId: string, updateData: Partial<IUser>): Promise<IUser | null> {
        return User.findOneAndUpdate(
            { userId },
            { $set: updateData },
            { new: true }
        ).exec();
    }

    async getAll(): Promise<IUser[]> {
        return User.find().exec();
    }

    async deleteByUserId(userId: string): Promise<boolean> {
        const result = await User.deleteOne({ userId }).exec();
        return result.deletedCount > 0;
    }

    async isAdmin(userId: string): Promise<boolean> {
        const user = await this.findByUserId(userId);
        return user?.isAdmin ?? false;
    }
}

export default new UserRepository();