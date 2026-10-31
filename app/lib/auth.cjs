const { DatabaseSync } = require("node:sqlite");
const { createHash, randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const deriveKey = promisify(scrypt);
const lifetime = 7 * 24 * 60 * 60 * 1000;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function problem(message, status = 400, code = "invalid_account") {
  return Object.assign(new Error(message), { status, code });
}

function validateUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    throw problem("Username 3 sampai 32 karakter, gunakan huruf kecil, angka, titik, atau garis bawah.");
  }
  return username;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 6 || value.length > 128) {
    throw problem("Password harus berisi 6 sampai 128 karakter.");
  }
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(24).toString("hex");
  const key = await deriveKey(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return salt + ":" + key.toString("hex");
}

async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 128 || !encoded) return false;
  const [salt, hash] = encoded.split(":");
  if (!salt || !/^[a-f0-9]{128}$/.test(hash || "")) return false;
  const key = await deriveKey(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(key, Buffer.from(hash, "hex"));
}

function openAuth(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;" +
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, " +
    "password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), disabled INTEGER NOT NULL DEFAULT 0, " +
    "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
    "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
    "csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL);"
  );
  const failures = new Map();
  const safeUser = (row) => row ? { id: row.id, username: row.username, role: row.role, disabled: Boolean(row.disabled) } : null;
  const initialized = () => Boolean(db.prepare("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get());

  function checkLimit(key) {
    const entry = failures.get(key);
    if (entry && entry.until > Date.now() && entry.count >= 8) {
      throw problem("Terlalu banyak percobaan. Coba lagi dalam 15 menit.", 429, "rate_limited");
    }
    if (failures.size > 4000) {
      for (const [saved, value] of failures) if (value.until < Date.now()) failures.delete(saved);
    }
  }
  function failed(key) {
    const entry = failures.get(key);
    failures.set(key, entry && entry.until > Date.now()
      ? { ...entry, count: entry.count + 1 }
      : { count: 1, until: Date.now() + 15 * 60 * 1000 });
  }

  function session(req) {
    const match = String(req.headers.cookie || "").match(/(?:^|;\s*)sitebook_session=([A-Za-z0-9_-]{43})(?:;|$)/);
    if (!match) return null;
    const tokenHash = digest(match[1]);
    const row = db.prepare("SELECT u.*, s.csrf_token, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id " +
      "WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0").get(tokenHash, Date.now());
    return row ? { user: safeUser(row), csrfToken: row.csrf_token, tokenHash } : null;
  }
  function makeSession(req, res, user) {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    db.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)")
      .run(digest(token), user.id, csrfToken, Date.now() + lifetime);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("set-cookie", "sitebook_session=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800" + secure);
    return { user: safeUser(user), csrfToken, initialized: true };
  }
  function checkOrigin(req) {
    if (req.headers["sec-fetch-site"] === "cross-site") throw problem("Permintaan dari situs lain ditolak.", 403, "invalid_origin");
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { throw problem("Asal permintaan tidak valid.", 403); }
      if (origin.host !== req.headers.host) throw problem("Asal permintaan tidak valid.", 403, "invalid_origin");
    }
  }
  function checkCsrf(req, activeSession) {
    checkOrigin(req);
    if (req.headers["x-csrf-token"] !== activeSession.csrfToken) throw problem("Sesi formulir kedaluwarsa. Muat ulang halaman.", 403, "invalid_csrf");
  }
  function requireAdmin(activeSession) {
    if (!activeSession || activeSession.user.role !== "admin") throw problem("Tindakan ini hanya untuk admin.", 403, "admin_required");
  }
  async function confirmPassword(activeSession, password) {
    const key = "confirm:" + activeSession.user.id;
    checkLimit(key);
    const row = db.prepare("SELECT password_hash FROM users WHERE id=? AND disabled=0").get(activeSession.user.id);
    if (!row || !await verifyPassword(password, row.password_hash)) {
      failed(key);
      throw problem("Password konfirmasi salah.", 403, "wrong_password");
    }
    failures.delete(key);
  }

  return {
    db, initialized, session, makeSession, checkOrigin, checkCsrf, requireAdmin, confirmPassword,
    listUsers: () => db.prepare("SELECT id,username,role,disabled FROM users ORDER BY role,username").all().map(safeUser),
    async setup(req, res, body) {
      checkOrigin(req);
      const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(req.headers.host || "") &&
        !req.headers["cf-connecting-ip"] && !req.headers["x-forwarded-for"];
      if (!local) throw problem("Buat akun admin pertama lewat localhost di komputer proyek.", 403, "local_setup_only");
      if (initialized()) throw problem("Akun admin sudah dibuat.", 409, "already_initialized");
      const username = validateUsername(body.username);
      const passwordHash = await hashPassword(body.password);
      db.exec("BEGIN IMMEDIATE");
      let id;
      try {
        if (initialized()) throw problem("Akun admin sudah dibuat.", 409);
        id = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,'admin')").run(username, passwordHash).lastInsertRowid);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return makeSession(req, res, db.prepare("SELECT * FROM users WHERE id=?").get(id));
    },
    async login(req, res, body) {
      checkOrigin(req);
      const username = String(body.username || "").trim().toLowerCase().slice(0, 64);
      const userKey = "login:" + username;
      const ipKey = "ip:" + (req.headers["cf-connecting-ip"] || req.socket.remoteAddress);
      checkLimit(userKey);
      checkLimit(ipKey);
      const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
      const fallback = "0".repeat(48) + ":" + "0".repeat(128);
      const valid = await verifyPassword(body.password, user ? user.password_hash : fallback);
      if (!valid || !user || user.disabled) {
        failed(userKey); failed(ipKey);
        throw problem("Username atau password salah.", 401, "invalid_credentials");
      }
      failures.delete(userKey);
      return makeSession(req, res, user);
    },
    logout(res, activeSession) {
      if (activeSession) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(activeSession.tokenHash);
      res.setHeader("set-cookie", "sitebook_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    },
    async createMember(body) {
      const username = validateUsername(body.username);
      const passwordHash = await hashPassword(body.password);
      if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) throw problem("Username sudah dipakai.", 409);
      const id = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,'member')").run(username, passwordHash).lastInsertRowid);
      return safeUser(db.prepare("SELECT * FROM users WHERE id=?").get(id));
    },
    async updateMember(id, body) {
      const user = db.prepare("SELECT * FROM users WHERE id=? AND role='member'").get(id);
      if (!user) throw problem("Akun anggota tidak ditemukan.", 404);
      if (typeof body.disabled === "boolean") db.prepare("UPDATE users SET disabled=? WHERE id=?").run(body.disabled ? 1 : 0, id);
      if (body.newPassword) {
        const passwordHash = await hashPassword(body.newPassword);
        db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(passwordHash, id);
      }
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
      return safeUser(db.prepare("SELECT * FROM users WHERE id=?").get(id));
    },
    async changePassword(activeSession, body) {
      await confirmPassword(activeSession, body.currentPassword);
      const passwordHash = await hashPassword(body.newPassword);
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(passwordHash, activeSession.user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(activeSession.user.id);
    }
  };
}

module.exports = { openAuth, hashPassword, verifyPassword };

