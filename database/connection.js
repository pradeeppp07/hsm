const path = require("path");
const { MongoClient } = require("mongodb");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });

async function connectDB() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error("MONGODB_URI is required. Copy .env.example to .env.");
    }

    const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000
    });
    await client.connect();
    return {
        client,
        db: client.db(process.env.MONGODB_DB || "carespring_web")
    };
}

module.exports = connectDB;