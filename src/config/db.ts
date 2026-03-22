import mongoose from "mongoose";

// Use the service name 'mongodb' from your docker-compose.yaml
const MONGO_URI = process.env.MONGO_URI || "mongodb://mongodb:27017/SalesBotDB";

export async function connectDB(): Promise<void> {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("✅ Connected to MongoDB");
    } catch (err) {
        console.error("❌ MongoDB connection error:", (err as Error).message);

        // Instead of process.exit(1), we wait and retry
        console.log("Retrying connection in 5 seconds...");
        setTimeout(connectDB, 5000);
    }
}

// Log connection issues after the initial connection
mongoose.connection.on('error', (err) => {
    console.error("⚠️ MongoDB runtime error:", err);
});

mongoose.connection.on('disconnected', () => {
    console.warn("⚠️ MongoDB disconnected. Attempting to reconnect...");
});