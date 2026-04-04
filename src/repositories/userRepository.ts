import User, { IUser } from "../models/User";

class UserRepository {
    async findByUserId(userId: string): Promise<IUser | null> {
        return User.findOne({ userId }).exec();
    }

    async upsertUserWithInsert(userId: string, setData: Partial<IUser>, setOnInsert: Partial<IUser>): Promise<IUser | null> {
        return User.findOneAndUpdate(
            { userId },
            { $set: setData, $setOnInsert: setOnInsert },
            {
                upsert: true,
                returnDocument: 'after',
                runValidators: true
            }
        ).exec();
    }

    async updateUser(userId: string, updateData: Partial<IUser>): Promise<IUser | null> {
        return User.findOneAndUpdate(
            { userId },
            { $set: updateData },
            {
                returnDocument: 'after'
            }
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