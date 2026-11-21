const crypto = require("crypto");
const connectDatabase = require("../database/connection");
const createDatabaseIndexes = require("../database/indexes");

async function main() {
  const [role, emailInput] = process.argv.slice(2);
  const email = String(emailInput || "").trim().toLowerCase();
  if (!["patient", "clinician"].includes(role) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Usage: npm run invite -- <patient|clinician> <email>");
  }

  const { client, db } = await connectDatabase();
  try {
    await createDatabaseIndexes(db);
    const token = crypto.randomBytes(32).toString("hex");
    const now = new Date();
    await db.collection("invitations").insertOne({
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      email,
      role,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
    });

    console.log(`Invitation created for ${email} (${role}); it expires in 24 hours.`);
    console.log(`Send this code privately: ${token}`);
  } finally {
    await client.close();
  }
}

main().catch(error => {
  console.error(`Invitation failed: ${error.message}`);
  process.exitCode = 1;
});
