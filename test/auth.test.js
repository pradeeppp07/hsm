const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { createServer, hashPassword } = require("../server");

class MemoryCollection {
  constructor() {
    this.documents = [];
    this.nextId = 1;
  }

  matches(document, query) {
    return Object.entries(query).every(([key, value]) => {
      if (value && typeof value === "object" && "$gt" in value) {
        return document[key] > value.$gt;
      }
      return document[key] === value;
    });
  }

  async findOne(query) {
    return this.documents.find(document => this.matches(document, query)) || null;
  }

  async insertOne(document) {
    if (document.email && this.documents.some(item => item.email === document.email)) {
      const error = new Error("Duplicate key");
      error.code = 11000;
      throw error;
    }
    const inserted = { ...document, _id: this.nextId++ };
    this.documents.push(inserted);
    return { insertedId: inserted._id };
  }

  async deleteOne(query) {
    const index = this.documents.findIndex(document => this.matches(document, query));
    if (index >= 0) this.documents.splice(index, 1);
  }
}

function createDatabase() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection());
      return collections.get(name);
    }
  };
}

async function listen(db) {
  const server = createServer(db);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`
  };
}

const activeServers = [];
afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server =>
    new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  ));
});

test("registration creates a patient account without an invitation code", async () => {
  const db = createDatabase();
  const app = await listen(db);
  activeServers.push(app.server);

  const response = await fetch(`${app.url}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test Patient",
      email: "patient@example.com",
      password: "a-strong-password"
    })
  });

  assert.equal(response.status, 201);
  const user = db.collection("users").documents[0];
  assert.equal(user.role, "patient");
  assert.notEqual(user.hash, "a-strong-password");
});

test("login creates a server-side session and logout invalidates it", async () => {
  const db = createDatabase();
  const credentials = hashPassword("a-strong-password");
  db.collection("users").documents.push({
    _id: 1,
    email: "doctor@example.com",
    name: "Test Doctor",
    role: "clinician",
    ...credentials
  });
  const app = await listen(db);
  activeServers.push(app.server);

  const login = await fetch(`${app.url}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "doctor@example.com", password: "a-strong-password" })
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";")[0];

  const session = await fetch(`${app.url}/api/auth/session`, {
    headers: { Cookie: cookie }
  });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).role, "clinician");

  const logout = await fetch(`${app.url}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie }
  });
  assert.equal(logout.status, 200);
  const expiredSession = await fetch(`${app.url}/api/auth/session`, {
    headers: { Cookie: cookie }
  });
  assert.equal(expiredSession.status, 401);
});

test("appointment requests are validated and stored", async () => {
  const db = createDatabase();
  const app = await listen(db);
  activeServers.push(app.server);

  const invalid = await fetch(`${app.url}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", email: "not-an-email", department: "" })
  });
  assert.equal(invalid.status, 400);

  const response = await fetch(`${app.url}/api/appointments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test Patient",
      phone: "555-0100",
      email: "patient@example.com",
      department: "Cardiology",
      date: "2026-12-10",
      time: "Morning (8 AM – 12 PM)",
      notes: "First visit"
    })
  });

  assert.equal(response.status, 201);
  assert.equal(db.collection("appointments").documents.length, 1);
  assert.equal(db.collection("appointments").documents[0].status, "requested");
  assert.equal(db.collection("appointments").documents[0].department, "Cardiology");
});

test("static server does not expose account data or source files", async () => {
  const app = await listen(createDatabase());
  activeServers.push(app.server);

  for (const pathname of ["/users.json", "/backend/server.js", "/package.json"]) {
    const response = await fetch(`${app.url}${pathname}`);
    assert.equal(response.status, 404, pathname);
  }
});

test("static server serves the React entry point and keeps API misses as JSON", async () => {
  const app = await listen(createDatabase());
  activeServers.push(app.server);

  const home = await fetch(app.url);
  assert.equal(home.status, 200);
  const hasReactBuild = fs.existsSync(path.join(__dirname, "..", "..", "frontend", "dist", "index.html"));
  if (hasReactBuild) {
    assert.match(await home.text(), /<div id="root"><\/div>/);
    const deepLink = await fetch(`${app.url}/departments/cardiology`);
    assert.equal(deepLink.status, 200);
    assert.match(await deepLink.text(), /<div id="root"><\/div>/);
  }

  const missingApi = await fetch(`${app.url}/api/not-a-route`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { message: "API route not found." });
});
