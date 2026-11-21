async function createDatabaseIndexes(db) {
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("sessions").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("invitations").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("invitations").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("appointments").createIndex({ email: 1, createdAt: -1 }),
    db.collection("appointments").createIndex({ status: 1, createdAt: -1 })
  ]);
}

module.exports = createDatabaseIndexes;
