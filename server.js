const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const connectDatabase = require("./database/connection");
const createDatabaseIndexes = require("./database/indexes");

const port = Number(process.env.PORT) || 3000;
const root = path.resolve(__dirname, "..");
const databaseName = process.env.MONGODB_DB || "carespring_web";
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};
const clientBuildDirectory = path.join(root, "frontend", "dist");
const legacyPages = new Map([
  ["/carespring-hospital-website.html", "carespring-hospital-website.html"],
  ["/carespring-website-fixed (1).html", "CareSpring-Website-Fixed (1).html"]
]);
const sessionCookie = "carespring_session";
const sessionDurationMs = 8 * 60 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", chunk => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 100000) {
        tooLarge = true;
        reject(new Error("Request too large"));
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function getCookie(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  const cookie = cookies.map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return cookie ? cookie.slice(name.length + 1) : "";
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDurationMs / 1000}${secure}`);
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

async function findSession(request, db) {
  const token = getCookie(request, sessionCookie);
  if (!token) return null;

  const session = await db.collection("sessions").findOne({
    tokenHash: hashToken(token),
    expiresAt: { $gt: new Date() }
  });
  if (!session) return null;

  const user = await db.collection("users").findOne(
    { _id: session.userId },
    { projection: { name: 1, email: 1, role: 1 } }
  );
  return user ? { session, user } : null;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function serveLegacyPage(pathname, response) {
  const legacyFile = legacyPages.get(pathname.toLowerCase());
  const fileName = legacyFile || "CareSpring-Website-Fixed (1).html";
  fs.readFile(path.join(root, fileName), (error, data) => {
    if (error) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[".html"],
      "X-Content-Type-Options": "nosniff"
    });
    response.end(data);
  });
}

function serveClient(pathname, response) {
  const entryPoint = path.join(clientBuildDirectory, "index.html");
  if (!fs.existsSync(entryPoint)) {
    if (pathname === "/" || legacyPages.has(pathname.toLowerCase())) {
      serveLegacyPage(pathname, response);
      return;
    }
    response.writeHead(404).end("React client has not been built. Run npm run build:client.");
    return;
  }

  const legacyPath = legacyPages.has(pathname.toLowerCase());
  const relativePath = pathname === "/" || legacyPath ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(clientBuildDirectory, relativePath);
  const relativeToBuild = path.relative(clientBuildDirectory, filePath);
  if (relativeToBuild.startsWith("..") || path.isAbsolute(relativeToBuild)) {
    response.writeHead(404).end("Not found");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (path.extname(pathname)) {
        response.writeHead(404).end("Not found");
        return;
      }
      fs.readFile(entryPoint, (entryError, entryData) => {
        if (entryError) {
          response.writeHead(404).end("Not found");
          return;
        }
        response.writeHead(200, {
          "Content-Type": types[".html"],
          "X-Content-Type-Options": "nosniff"
        });
        response.end(entryData);
      });
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": types[extension] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(data);
  });
}

function createServer(db) {
  return http.createServer(async (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }

    try {
      if (pathname === "/api/auth/session" && request.method === "GET") {
        const auth = await findSession(request, db);
        if (!auth) {
          sendJson(response, 401, { message: "Sign in required." });
          return;
        }
        sendJson(response, 200, {
          name: auth.user.name,
          email: auth.user.email,
          role: auth.user.role
        });
        return;
      }

      if (pathname.startsWith("/api/auth/")) {
        if (pathname === "/api/auth/logout" && request.method === "POST") {
          const token = getCookie(request, sessionCookie);
          if (token) {
            await db.collection("sessions").deleteOne({ tokenHash: hashToken(token) });
          }
          clearSessionCookie(response);
          sendJson(response, 200, { message: "Signed out." });
          return;
        }

        if (request.method !== "POST") {
          sendJson(response, 405, { message: "Authentication endpoints require POST." });
          return;
        }

        const data = await readJson(request);
        const email = String(data.email || "").trim().toLowerCase();
        const password = String(data.password || "");

        if (pathname === "/api/auth/register") {
          const name = String(data.name || "").trim();
          if (!name || name.length > 120 || !validEmail(email) || password.length < 12 || password.length > 128) {
            sendJson(response, 400, { message: "Enter your name, valid email, and a password of at least 12 characters." });
            return;
          }
          if (await db.collection("users").findOne({ email }, { projection: { _id: 1 } })) {
            sendJson(response, 409, { message: "An account with this email already exists." });
            return;
          }

          const credentials = hashPassword(password);
          try {
            await db.collection("users").insertOne({
              name,
              email,
              role: "patient",
              ...credentials,
              createdAt: new Date()
            });
          } catch (error) {
            if (error.code === 11000) {
              sendJson(response, 409, { message: "An account with this email already exists." });
              return;
            }
            throw error;
          }
          sendJson(response, 201, { message: "Account created. You can now sign in." });
          return;
        }

        if (pathname === "/api/auth/login") {
          const user = await db.collection("users").findOne({ email });
          if (!user || !password || password.length > 128) {
            sendJson(response, 401, { message: "Email or password is incorrect." });
            return;
          }
          const candidate = crypto.scryptSync(password, user.salt, 64);
          const expected = Buffer.from(user.hash, "hex");
          if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
            sendJson(response, 401, { message: "Email or password is incorrect." });
            return;
          }

          const token = crypto.randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + sessionDurationMs);
          await db.collection("sessions").insertOne({
            userId: user._id,
            tokenHash: hashToken(token),
            createdAt: new Date(),
            expiresAt
          });
          setSessionCookie(response, token);
          sendJson(response, 200, { message: "Signed in successfully.", name: user.name });
          return;
        }

        sendJson(response, 404, { message: "Unknown authentication service." });
        return;
      }

      if (pathname === "/api/appointments" && request.method === "POST") {
        const data = await readJson(request);
        const name = String(data.name || "").trim();
        const phone = String(data.phone || "").trim();
        const email = String(data.email || "").trim().toLowerCase();
        const department = String(data.department || "").trim();
        const date = String(data.date || "").trim();
        const time = String(data.time || "").trim();
        const notes = String(data.notes || "").trim();

        if (
          !name || name.length > 120 ||
          !phone || phone.length > 32 ||
          !validEmail(email) ||
          !department || department.length > 120 ||
          date && !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          time.length > 80 ||
          notes.length > 500
        ) {
          sendJson(response, 400, { message: "Enter a valid name, phone number, email, and department." });
          return;
        }

        const auth = await findSession(request, db);
        const appointment = await db.collection("appointments").insertOne({
          name,
          phone,
          email,
          department,
          date: date || null,
          time: time || null,
          notes: notes || null,
          status: "requested",
          userId: auth ? auth.user._id : null,
          createdAt: new Date()
        });

        sendJson(response, 201, {
          message: "Appointment request submitted.",
          appointmentId: String(appointment.insertedId)
        });
        return;
      }

      if (pathname === "/api" || pathname.startsWith("/api/")) {
        sendJson(response, 404, { message: "API route not found." });
        return;
      }

      serveClient(pathname, response);
    } catch (error) {
      if (error.message === "Request too large") {
        sendJson(response, 413, { message: "Request is too large." });
        return;
      }
      if (error.message === "Invalid JSON") {
        sendJson(response, 400, { message: "Request body must be valid JSON." });
        return;
      }
      console.error("Request failed:", error);
      if (!response.headersSent) {
        sendJson(response, 500, { message: "The request could not be completed." });
      }
    }
  });
}

async function start() {
  const { client, db } = await connectDatabase();
  await createDatabaseIndexes(db);

  const server = createServer(db);
  server.on("error", error => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the other server or set PORT to a free port.`);
      process.exitCode = 1;
      return;
    }
    console.error("Server failed:", error);
    process.exitCode = 1;
  });
  server.listen(port, () => {
    console.log(`MongoDB connected to "${databaseName}".`);
    console.log(`Hospital website running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createServer, hashPassword, hashToken };
