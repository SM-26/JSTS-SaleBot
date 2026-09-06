import mongoose from "mongoose";

// Default to localhost for safety, Docker should always provide env variable
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/SalesBotDB";
const MAX_ATTEMPTS = Number(process.env.MONGO_MAX_ATTEMPTS ?? 5);
const RETRY_DELAY_MS = 5000;

// Never log credentials if the URI carries them.
const safeUri = MONGO_URI.replace(/\/\/[^@/]*@/, "//***@");

export async function connectDB(): Promise<void> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await mongoose.connect(MONGO_URI);
            console.log("✅ Connected to MongoDB");
            return;
        } catch (err) {
            console.error(`❌ MongoDB connection error (attempt ${attempt}/${MAX_ATTEMPTS}):`, (err as Error).message);
            if (attempt < MAX_ATTEMPTS) {
                console.log(`Retrying connection in ${RETRY_DELAY_MS / 1000} seconds...`);
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }
    }

    // Give up loudly rather than returning "successfully" with no database: the
    // caller would start polling and greet users with a bot whose every query
    // times out in mongoose's command buffer. Exiting lets Docker restart us.
    throw new Error(`Could not reach MongoDB at ${safeUri} after ${MAX_ATTEMPTS} attempts`);
}

// Log connection issues after the initial connection
mongoose.connection.on('error', (err) => {
    console.error("⚠️ MongoDB runtime error:", err);
});

mongoose.connection.on('disconnected', () => {
    console.warn("⚠️ MongoDB disconnected. Attempting to reconnect...");
});
