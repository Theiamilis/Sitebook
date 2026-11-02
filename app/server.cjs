const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { makeReport } = require("./lib/documents.cjs");
const { makeEquipmentWorkbook } = require("./lib/equipment-report.cjs");
const { makeEquipmentPdf } = require("./lib/equipment-report-pdf.cjs");
const { makeBackup, stageRestore } = require("./lib/backups.cjs");
const { syncDay, threadTitle, verifyWebhook, weekNumber } = require("./lib/discord.cjs");
const { openAuth } = require("./lib/auth.cjs");
const stampFont = require("./lib/stamp-font.cjs");
const EquipmentHours = require("./public/equipment-hours.js");

const docx = require("docx");
const sharp = require("sharp");
const JSZip = require("jszip");
const PDFDocument = require("pdfkit");
const { Document, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Packer } = docx;
const appDir = __dirname;
const publicDir = path.join(appDir, "public");
const dataDir = path.resolve(process.env.SITEBOOK_DATA_DIR || path.join(appDir, "data"));
const photosDir = path.join(dataDir, "photos");
const previewsDir = path.join(dataDir, "previews");
const videosDir = path.join(dataDir, "videos");
const videoUploadsDir = path.join(dataDir, "video-uploads");
const databasePath = path.join(dataDir, "sitebook.sqlite");
const secretPath = process.env.SITEBOOK_SECRET_PATH ||
  (process.env.SITEBOOK_DATA_DIR ? path.join(dataDir, ".env.local") : path.join(appDir, ".env.local"));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const maxPhotoBytes = 32 * 1024 * 1024;
const maxVideoBytes = 1024 * 1024 * 1024;
const maxVideoChunkBytes = 8 * 1024 * 1024;
const maxSingleRequestVideoBytes = 80 * 1024 * 1024;
const maxJsonBytes = 2 * 1024 * 1024;
const maxRestoreBytes = 512 * 1024 * 1024;

let db;
let auth;
let maintenance = false;
let webhookUrl = "";
const runningSyncs = new Set();
const rerunSyncs = new Set();
const pendingVideoUploads = new Map();
let uploadCleanupTimer = null;

function openDatabase() {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = DELETE");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(
    "CREATE TABLE IF NOT EXISTS settings (" +
    "id INTEGER PRIMARY KEY CHECK (id = 1), " +
    "project_name TEXT NOT NULL DEFAULT 'Sitebook ', " +
    "week_start_date TEXT, discord_webhook_fingerprint TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
    "INSERT OR IGNORE INTO settings (id, project_name) VALUES (1, 'Sitebook ');" +
    "CREATE TABLE IF NOT EXISTS days (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, entry_date TEXT NOT NULL UNIQUE, " +
    "note TEXT NOT NULL DEFAULT '', equipment_json TEXT NOT NULL DEFAULT '[]', discord_thread_id TEXT, discord_root_message_id TEXT, " +
    "synced_root_text TEXT, sync_status TEXT NOT NULL DEFAULT 'pending', sync_error TEXT, " +
    "synced_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
    "CREATE TABLE IF NOT EXISTS photos (" +
    "id TEXT PRIMARY KEY, day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE, " +
    "original_name TEXT NOT NULL, stored_name TEXT NOT NULL, preview_name TEXT NOT NULL, " +
    "image_format TEXT NOT NULL, size_bytes INTEGER NOT NULL, caption TEXT NOT NULL DEFAULT '', " +
    "sort_order INTEGER NOT NULL DEFAULT 0, discord_message_id TEXT, synced_caption TEXT, " +
    "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
    "CREATE INDEX IF NOT EXISTS photos_by_day ON photos(day_id, sort_order);" +
    "CREATE TABLE IF NOT EXISTS videos (" +
    "id TEXT PRIMARY KEY, day_id INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE, " +
    "original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT NOT NULL, " +
    "size_bytes INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, " +
    "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);" +
    "CREATE INDEX IF NOT EXISTS videos_by_day ON videos(day_id, sort_order);"
  );
  const settingsColumns = database.prepare("PRAGMA table_info(settings)").all();
  if (!settingsColumns.some((column) => column.name === "discord_webhook_fingerprint")) {
    database.exec("ALTER TABLE settings ADD COLUMN discord_webhook_fingerprint TEXT");
  }
  if (!database.prepare("PRAGMA table_info(photos)").all().some((column) => column.name === "deleted_at")) {
    database.exec("ALTER TABLE photos ADD COLUMN deleted_at TEXT");
  }
  if (!database.prepare("PRAGMA table_info(days)").all().some((column) => column.name === "equipment_json")) {
    database.exec("ALTER TABLE days ADD COLUMN equipment_json TEXT NOT NULL DEFAULT '[]'");
  }
  return database;
}

function runInTransaction(work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

async function loadWebhook() {
  try {
    const contents = await fs.readFile(secretPath, "utf8");
    const match = contents.match(/^DISCORD_WEBHOOK_URL=(.*)$/m);
    if (!match) return "";
    try { return JSON.parse(match[1]); } catch { return match[1].trim(); }
  } catch {
    return "";
  }
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function currentWibDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type).value;
  return value("year") + "-" + value("month") + "-" + value("day");
}

function currentSettings() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

function listDayPhotos(dayId) {
  return db.prepare(
    "SELECT id, original_name, image_format, size_bytes, caption, sort_order, " +
    "discord_message_id, preview_name, created_at FROM photos WHERE day_id = ? AND deleted_at IS NULL " +
    "ORDER BY sort_order, created_at, id"
  ).all(dayId);
}

function listDayVideos(dayId) {
  return db.prepare(
    "SELECT id, original_name, stored_name, mime_type, size_bytes, sort_order, created_at " +
    "FROM videos WHERE day_id = ? ORDER BY sort_order, created_at, id"
  ).all(dayId);
}

const EQUIPMENT_HOURS = EquipmentHours.HOURS;

function readEquipmentLog(day) {
  if (!day) return [];
  try {
    const value = JSON.parse(day.equipment_json || "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const equipment = String(item.equipment || "").trim();
      if (!equipment) return [];
      const note = String(item.note || item.reason || "").trim();
      if (Array.isArray(item.hours)) {
        const hours = EquipmentHours.normalizeHours(item.hours);
        const intervalResult = EquipmentHours.normalizeOffIntervals(item.offIntervals === undefined ? [] : item.offIntervals);
        const entry = { equipment, hours, note };
        if (intervalResult.intervals && intervalResult.intervals.length) entry.offIntervals = intervalResult.intervals;
        return [entry];
      }
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.startTime || "")) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.endTime || ""))) return [];
      const start = Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3));
      const end = Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3));
      if (end <= start) return [];
      const hours = EQUIPMENT_HOURS.filter((hour) => {
        const hourStart = Number(hour.slice(0, 2)) * 60;
        return !(start < hourStart + 60 && end > hourStart);
      });
      const legacyNote = note
        ? "OFF " + item.startTime + "-" + item.endTime + ": " + note
        : "OFF " + item.startTime + "-" + item.endTime;
      return [{ equipment, hours, note: legacyNote }];
    });
  } catch { return []; }
}

function normalizeEquipmentLog(value) {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result = [];
  const names = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const equipment = String(item.equipment || "").trim();
    if (!equipment || equipment.length > 80) return null;
    const key = equipment.toLocaleLowerCase("id-ID");
    if (names.has(key)) return null;
    names.add(key);
    let hours;
    let note = String(item.note || item.reason || "").trim();
    let offIntervals = [];
    if (Array.isArray(item.hours)) {
      if (item.hours.length > EQUIPMENT_HOURS.length || item.hours.some((hour) => !EQUIPMENT_HOURS.includes(hour))) return null;
      hours = [...new Set(item.hours)].sort((left, right) => EQUIPMENT_HOURS.indexOf(left) - EQUIPMENT_HOURS.indexOf(right));
      const intervalResult = EquipmentHours.normalizeOffIntervals(item.offIntervals === undefined ? [] : item.offIntervals);
      if (intervalResult.error) return null;
      offIntervals = intervalResult.intervals;
    } else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.startTime || "")) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(String(item.endTime || ""))) {
      const start = Number(item.startTime.slice(0, 2)) * 60 + Number(item.startTime.slice(3));
      const end = Number(item.endTime.slice(0, 2)) * 60 + Number(item.endTime.slice(3));
      if (end <= start) return null;
      hours = EQUIPMENT_HOURS.filter((hour) => {
        const hourStart = Number(hour.slice(0, 2)) * 60;
        return !(start < hourStart + 60 && end > hourStart);
      });
      note = (note ? note + " | " : "") + "OFF " + item.startTime + "-" + item.endTime;
    } else {
      return null;
    }
    if (note.length > 180) return null;
    const entry = { equipment, hours, note };
    if (offIntervals.length) entry.offIntervals = offIntervals;
    result.push(entry);
  }
  return result;
}

function dayView(day, entryDate) {
  if (!day && !entryDate) return null;
  const settings = currentSettings();
  const date = day ? day.entry_date : entryDate;
  const photos = day ? listDayPhotos(day.id) : [];
  const videos = day ? listDayVideos(day.id) : [];
  const deletedPhotos = day
    ? Boolean(db.prepare("SELECT 1 FROM photos WHERE day_id = ? AND deleted_at IS NOT NULL LIMIT 1").get(day.id))
    : false;
  const visibleRecord = photos.length > 0 || videos.length > 0 || !deletedPhotos;
  const equipmentLog = visibleRecord ? readEquipmentLog(day) : [];
  return {
    id: day ? day.id : null,
    date,
    note: visibleRecord ? day && day.note || "" : "",
    equipmentLog,
    deleted: photos.length === 0 && videos.length === 0 && deletedPhotos,
    title: settings.week_start_date ? threadTitle(date, settings.week_start_date) : date,
    week: settings.week_start_date ? weekNumber(date, settings.week_start_date) : null,
    syncStatus: day ? day.sync_status : "sent",
    syncError: day ? day.sync_error : null,
    photos: photos.map((photo) => ({
      id: photo.id,
      originalName: photo.original_name,
      format: photo.image_format,
      sizeBytes: photo.size_bytes,
      caption: photo.caption,
      sortOrder: photo.sort_order,
      discordSent: Boolean(photo.discord_message_id),
      previewUrl: "/api/photos/" + encodeURIComponent(photo.id) + "/preview",
      originalUrl: "/api/photos/" + encodeURIComponent(photo.id) + "/original"
    })),
    videos: videos.map((video) => ({
      id: video.id,
      originalName: video.original_name,
      mimeType: video.mime_type,
      sizeBytes: video.size_bytes,
      sortOrder: video.sort_order,
      available: fsSync.existsSync(path.join(videosDir, video.stored_name)),
      streamUrl: "/api/videos/" + encodeURIComponent(video.id) + "/stream"
    }))
  };
}

function photoDateLabel(entryDate) {
  const [year, month, day] = entryDate.split("-");
  return day + "/" + month + "/" + year;
}

function parseDateStampLayout(searchParams) {
  const keys = ["x", "y", "size"];
  const supplied = keys.map((key) => searchParams.has(key));
  if (!supplied.some(Boolean) && !searchParams.has("opacity") && !searchParams.has("color")) return { x: 78, y: 82, size: 4, opacity: 100, color: "#ffffff" };
  if (!supplied.every(Boolean)) return null;
  const values = keys.map((key) => searchParams.get(key));
  if (values.some((value) => value === null || !value.trim())) return null;
  const layout = Object.fromEntries(keys.map((key, index) => [key, Number(values[index])]));
  layout.opacity = searchParams.has("opacity") ? Number(searchParams.get("opacity")) : 100;
  layout.color = searchParams.get("color") || "#ffffff";
  if (!Number.isFinite(layout.x) || layout.x < 0 || layout.x > 100 ||
      !Number.isFinite(layout.y) || layout.y < 0 || layout.y > 100 ||
      !Number.isFinite(layout.size) || layout.size < 1.5 || layout.size > 10 ||
      !Number.isInteger(layout.opacity) || layout.opacity < 0 || layout.opacity > 100 ||
      !/^#[0-9a-f]{6}$/i.test(layout.color)) return null;
  layout.color = layout.color.toLowerCase();
  return layout;
}

function dateStampSvg(entryDate, metadata, layout = { x: 78, y: 82, size: 4, opacity: 100, color: "#ffffff" }) {
  const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
  const width = swapped ? metadata.height : metadata.width;
  const height = swapped ? metadata.width : metadata.height;
  const label = photoDateLabel(entryDate);
  const glyphs = Array.from(label, (character) => stampFont.glyphs[character]);
  const labelUnits = glyphs.reduce((total, glyph) => total + glyph.advance, 0);
  const labelEm = labelUnits / stampFont.unitsPerEm;
  const margin = Math.max(10, Math.round(Math.min(width, height) * 0.04));
  const fontSize = Math.max(8, Math.round(Math.min(Math.min(width, height) * layout.size / 100, (width - margin * 2) / labelEm)));
  const labelWidth = fontSize * labelEm;
  const centerX = Math.max(labelWidth / 2 + margin, Math.min(width - labelWidth / 2 - margin, width * layout.x / 100));
  const centerY = Math.max(fontSize / 2 + margin, Math.min(height - fontSize / 2 - margin, height * layout.y / 100));
  const baseline = centerY + fontSize * 0.34;
  const scale = fontSize / stampFont.unitsPerEm;
  let offset = 0;
  const paths = glyphs.map((glyph) => {
    const path = '<path d="' + glyph.path + '" transform="translate(' + offset + ' 0)"/>';
    offset += glyph.advance;
    return path;
  }).join("");
  const shadowOffset = fontSize * 0.02;
  const shadowBlur = fontSize * 0.012;
  const svg = '<svg width="' + width + '" height="' + height + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><filter id="stamp-shadow" x="-25%" y="-25%" width="150%" height="150%"><feDropShadow dx="' + shadowOffset + '" dy="' + shadowOffset + '" stdDeviation="' + shadowBlur + '" flood-color="#202322" flood-opacity="0.72"/></filter></defs>' +
    '<g opacity="' + (layout.opacity / 100) + '" filter="url(#stamp-shadow)"><g transform="translate(' + (centerX - labelWidth / 2) + ' ' + baseline + ') scale(' + scale + ' -' + scale + ')" fill="' + layout.color + '">' + paths + '</g></g></svg>';
  return Buffer.from(svg);
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    "content-type": contentType || "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  });
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(JSON.stringify(body));
}

function fail(res, status, message, code) {
  send(res, status, { error: message, code: code || "request_failed" });
}

async function readBody(req, limit, tooLargeMessage = "Ukuran kiriman melebihi batas.") {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error(tooLargeMessage);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, maxJsonBytes);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    const error = new Error("Isi formulir tidak terbaca.");
    error.status = 400;
    throw error;
  }
}

function parseRouteDate(raw) {
  const decoded = decodeURIComponent(raw);
  return validDate(decoded) ? decoded : null;
}

function isWebhookUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "discord.com" || url.hostname === "discordapp.com") &&
      /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function saveWebhook(value) {
  if (!value) {
    webhookUrl = "";
    await fs.rm(secretPath, { force: true });
    return;
  }
  if (!isWebhookUrl(value)) {
    const error = new Error("URL webhook Discord tidak sesuai format.");
    error.status = 400;
    throw error;
  }
  const next = "DISCORD_WEBHOOK_URL=" + JSON.stringify(value) + "\n";
  await fs.writeFile(secretPath, next, { encoding: "utf8", mode: 0o600 });
  webhookUrl = value;
}

function queueDaySync(dayId) {
  if (runningSyncs.has(dayId)) {
    rerunSyncs.add(dayId);
    return;
  }
  runningSyncs.add(dayId);
  setImmediate(async () => {
    try {
      const settings = currentSettings();
      await syncDay({ db, dayId, dataDir, webhookUrl, startDate: settings.week_start_date });
    } catch (error) {
      console.error("Discord sync gagal untuk catatan " + dayId + ": " + String(error.message || error));
    } finally {
      runningSyncs.delete(dayId);
      const rerun = rerunSyncs.delete(dayId);
      const latest = db.prepare("SELECT sync_status FROM days WHERE id = ?").get(dayId);
      if (rerun && latest && latest.sync_status !== "uncertain") queueDaySync(dayId);
    }
  });
}

function assertEntryDate(entryDate) {
  const settings = currentSettings();
  if (!settings.week_start_date) {
    const error = new Error("Atur tanggal awal Week 1 sebelum menyimpan catatan.");
    error.status = 409;
    error.code = "week_start_required";
    throw error;
  }
  if (entryDate < settings.week_start_date) {
    const error = new Error("Tanggal kegiatan harus sama atau sesudah tanggal awal Week 1.");
    error.status = 400;
    error.code = "before_week_start";
    throw error;
  }
}

function getDayByDate(entryDate) {
  return db.prepare("SELECT * FROM days WHERE entry_date = ?").get(entryDate);
}

function errorResponse(res, error) {
  if (error && error.status) return fail(res, error.status, error.message, error.code);
  console.error(error);
  return fail(res, 500, "Ada gangguan saat memproses permintaan.", "server_error");
}

async function route(req, res) {
  if (maintenance && req.url !== "/api/backup/restore") {
    return fail(res, 503, "Arsip sedang dipulihkan. Coba lagi sebentar.", "maintenance");
  }
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/") {
    return send(res, 200, await fs.readFile(path.join(publicDir, "index.html")), "text/html; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/styles.css") {
    return send(res, 200, await fs.readFile(path.join(publicDir, "styles.css")), "text/css; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/app.js") {
    return send(res, 200, await fs.readFile(path.join(publicDir, "app.js")), "text/javascript; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/i18n.js") {
    return send(res, 200, await fs.readFile(path.join(publicDir, "i18n.js")), "text/javascript; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/equipment-hours.js") {
    return send(res, 200, await fs.readFile(path.join(publicDir, "equipment-hours.js")), "text/javascript; charset=utf-8");
  }
  if (req.method === "GET" && pathname === "/fonts/noto-sans-sc-stamp.ttf") {
    return send(res, 200, await fs.readFile(path.join(publicDir, "fonts", "noto-sans-sc-stamp.ttf")), "font/ttf");
  }
  if (req.method === "GET" && pathname === "/fonts/OFL.txt") {
    return send(res, 200, await fs.readFile(path.join(publicDir, "fonts", "OFL.txt")), "text/plain; charset=utf-8");
  }

  if (req.method === "GET" && pathname === "/api/auth/state") {
    const active = auth.session(req);
    return send(res, 200, { initialized: auth.initialized(), user: active ? active.user : null, csrfToken: active ? active.csrfToken : null });
  }
  if (req.method === "POST" && ["/api/auth/setup", "/api/auth/login"].includes(pathname)) {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) return fail(res, 415, "Gunakan formulir login aplikasi.");
    const body = await readJson(req);
    return send(res, 200, pathname.endsWith("setup") ? await auth.setup(req, res, body) : await auth.login(req, res, body));
  }
  const activeSession = auth.session(req);
  if (!activeSession) return fail(res, 401, "Masuk ke akun terlebih dahulu.", "login_required");
  if (!["GET", "HEAD"].includes(req.method)) auth.checkCsrf(req, activeSession);
  if (req.method === "POST" && pathname === "/api/auth/logout") {
    auth.logout(res, activeSession);
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && pathname === "/api/auth/password") {
    await auth.changePassword(activeSession, await readJson(req));
    auth.logout(res, activeSession);
    return send(res, 200, { ok: true });
  }
  if (pathname === "/api/users" || /^\/api\/users\/\d+$/.test(pathname) ||
      pathname === "/api/settings" || pathname === "/api/discord/test" || pathname === "/api/discord/webhook" ||
      pathname.startsWith("/api/backup") || pathname.startsWith("/api/trash") || req.method === "DELETE") {
    auth.requireAdmin(activeSession);
  }
  if (req.method === "GET" && pathname === "/api/discord/webhook") {
    return send(res, 200, webhookUrl ? { configured: true, webhookUrl } : { configured: false });
  }
  if (pathname === "/api/users" && req.method === "GET") return send(res, 200, { users: auth.listUsers() });
  if (pathname === "/api/users" && req.method === "POST") return send(res, 201, { user: await auth.createMember(await readJson(req)) });
  const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
  if (userMatch && req.method === "PATCH") {
    const body = await readJson(req);
    await auth.confirmPassword(activeSession, body.password);
    return send(res, 200, { user: await auth.updateMember(Number(userMatch[1]), body) });
  }
  if (pathname === "/api/trash" && req.method === "GET") {
    const photos = db.prepare("SELECT p.id,p.original_name,p.deleted_at,d.entry_date,d.sync_status,d.sync_error " +
      "FROM photos p JOIN days d ON d.id=p.day_id WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC,p.sort_order").all();
    return send(res, 200, { photos });
  }
  const restorePhoto = pathname.match(/^\/api\/trash\/([a-f0-9-]+)\/restore$/);
  if (restorePhoto && req.method === "POST") {
    const photo = db.prepare("SELECT * FROM photos WHERE id=? AND deleted_at IS NOT NULL").get(restorePhoto[1]);
    if (!photo) return fail(res, 404, "Foto di sampah tidak ditemukan.");
    if (runningSyncs.has(photo.day_id)) return fail(res, 409, "Tunggu sinkronisasi Discord selesai, lalu coba lagi.");
    db.prepare("UPDATE photos SET deleted_at=NULL WHERE id=?").run(photo.id);
    db.prepare("UPDATE days SET sync_status='pending',sync_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(photo.day_id);
    queueDaySync(photo.day_id);
    return send(res, 200, dayView(db.prepare("SELECT * FROM days WHERE id=?").get(photo.day_id)));
  }

  if (req.method === "GET" && pathname === "/api/state") {
    const settings = currentSettings();
    const totalDays = db.prepare("SELECT COUNT(*) AS count FROM days").get().count;
    const hasDiscordPosts = Boolean(db.prepare("SELECT 1 FROM days WHERE discord_thread_id IS NOT NULL LIMIT 1").get());
    return send(res, 200, {
      projectName: settings.project_name,
      weekStartDate: settings.week_start_date,
      hasEntries: totalDays > 0,
      hasDiscordPosts,
      discordConfigured: Boolean(webhookUrl),
      today: currentWibDate(),
      timeZone: "Asia/Jakarta"
    });
  }

  if (req.method === "PUT" && pathname === "/api/settings") {
    const body = await readJson(req);
    const projectName = String(body.projectName || "").trim();
    const weekStartDate = String(body.weekStartDate || "").trim();
    if (!projectName || projectName.length > 80) return fail(res, 400, "Nama proyek wajib diisi dan maksimal 80 karakter.");
    if (weekStartDate && !validDate(weekStartDate)) return fail(res, 400, "Tanggal awal Week 1 tidak valid.");
    const count = db.prepare("SELECT COUNT(*) AS count FROM days").get().count;
    const before = currentSettings();
    if (count > 0 && weekStartDate !== before.week_start_date) {
      return fail(res, 409, "Tanggal awal Week 1 terkunci setelah catatan pertama dibuat.");
    }
    if (body.clearWebhook !== true && typeof body.webhookUrl === "string" && body.webhookUrl.trim()) {
      const candidateWebhook = body.webhookUrl.trim();
      if (!isWebhookUrl(candidateWebhook)) return fail(res, 400, "URL webhook Discord tidak sesuai format.");
      const fingerprint = createHash("sha256").update(candidateWebhook).digest("hex");
      if (before.discord_webhook_fingerprint && before.discord_webhook_fingerprint !== fingerprint) {
        return fail(res, 409, "Webhook tidak bisa diganti setelah dikunci. Gunakan webhook asal agar thread lama tetap bisa diedit.", "webhook_locked");
      }
      if (webhookUrl && candidateWebhook !== webhookUrl &&
          db.prepare("SELECT 1 FROM days WHERE discord_thread_id IS NOT NULL LIMIT 1").get()) {
        return fail(res, 409, "Webhook tidak bisa diganti setelah ada posting. Thread lama hanya bisa diedit lewat webhook asal.", "webhook_locked");
      }
    }
    if (body.clearWebhook === true) await saveWebhook("");
    else if (typeof body.webhookUrl === "string" && body.webhookUrl.trim()) {
      await saveWebhook(body.webhookUrl.trim());
      const fingerprint = createHash("sha256").update(body.webhookUrl.trim()).digest("hex");
      db.prepare("UPDATE settings SET discord_webhook_fingerprint = ? WHERE id = 1").run(fingerprint);
    }
    db.prepare("UPDATE settings SET project_name = ?, week_start_date = ? WHERE id = 1")
      .run(projectName, weekStartDate || null);
    for (const day of db.prepare("SELECT id FROM days WHERE sync_status IN ('pending', 'waiting_config')").all()) {
      queueDaySync(day.id);
    }
    const updated = currentSettings();
    return send(res, 200, {
      projectName: updated.project_name,
      weekStartDate: updated.week_start_date,
      hasEntries: count > 0,
      hasDiscordPosts: Boolean(db.prepare("SELECT 1 FROM days WHERE discord_thread_id IS NOT NULL LIMIT 1").get()),
      discordConfigured: Boolean(webhookUrl)
    });
  }

  if (req.method === "POST" && pathname === "/api/discord/test") {
    const body = await readJson(req);
    const providedWebhook = typeof body.webhookUrl === "string" ? body.webhookUrl.trim() : "";
    const candidate = providedWebhook || webhookUrl;
    if (!isWebhookUrl(candidate)) return fail(res, 400, "Masukkan URL webhook Discord yang valid.");
    try {
      const result = await verifyWebhook(candidate);
      return send(res, 200, { ok: true, message: "Webhook aktif: " + result.name + ". Pastikan webhook ini dibuat di forum dokumentasi." });
    } catch (error) {
      return fail(res, 502, String(error.message || "Webhook tidak dapat dihubungi."));
    }
  }

  if (req.method === "GET" && pathname === "/api/days") {
    const month = url.searchParams.get("month");
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return fail(res, 400, "Pilih bulan arsip yang valid.");
    const rows = db.prepare(
      "SELECT * FROM days WHERE entry_date >= ? AND entry_date < ? " +
      "AND (EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id AND photos.deleted_at IS NULL) " +
      "OR EXISTS (SELECT 1 FROM videos WHERE videos.day_id=days.id) " +
      "OR (note <> '' AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id)) " +
      "OR (equipment_json <> '[]' AND (EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id AND photos.deleted_at IS NULL) " +
      "OR NOT EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id)))) ORDER BY entry_date DESC"
    ).all(month + "-01", nextMonth(month) + "-01");
    return send(res, 200, { days: rows.map(dayView) });
  }

  const equipmentDayMatch = pathname.match(/^\/api\/days\/([^/]+)\/equipment$/);
  if (req.method === "PUT" && equipmentDayMatch) {
    const entryDate = parseRouteDate(equipmentDayMatch[1]);
    if (!entryDate) return fail(res, 400, "Tanggal tidak valid.");
    assertEntryDate(entryDate);
    const body = await readJson(req);
    const equipmentLog = normalizeEquipmentLog(body.entries || body.downtime);
    if (!equipmentLog) {
      return fail(res, 400, "Periksa nama alat dan pilihan jam kerja. Setiap alat hanya boleh dicatat sekali per tanggal.");
    }
    let day = getDayByDate(entryDate);
    if (!day && !equipmentLog.length) return send(res, 200, dayView(null, entryDate));
    if (day) {
      const hasActivePhotos = Boolean(db.prepare(
        "SELECT 1 FROM photos WHERE day_id = ? AND deleted_at IS NULL LIMIT 1"
      ).get(day.id));
      const hasDeletedPhotos = Boolean(db.prepare(
        "SELECT 1 FROM photos WHERE day_id = ? AND deleted_at IS NOT NULL LIMIT 1"
      ).get(day.id));
      const hasActiveVideos = Boolean(db.prepare("SELECT 1 FROM videos WHERE day_id = ? LIMIT 1").get(day.id));
      if (!hasActivePhotos && hasDeletedPhotos && !hasActiveVideos) {
        return fail(res, 404, "Pulihkan dokumentasi dari sampah sebelum mengedit jadwal tanggal ini.");
      }
      db.prepare("UPDATE days SET equipment_json = ?, sync_status = 'pending', sync_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(JSON.stringify(equipmentLog), day.id);
    } else {
      db.prepare("INSERT INTO days (entry_date, equipment_json, sync_status) VALUES (?, ?, 'pending')")
        .run(entryDate, JSON.stringify(equipmentLog));
      day = getDayByDate(entryDate);
    }
    queueDaySync(day.id);
    return send(res, 200, dayView(getDayByDate(entryDate)));
  }

  const dayMatch = pathname.match(/^\/api\/days\/([^/]+)$/);
  if (req.method === "GET" && dayMatch) {
    const entryDate = parseRouteDate(dayMatch[1]);
    if (!entryDate) return fail(res, 400, "Tanggal tidak valid.");
    const view = dayView(getDayByDate(entryDate), entryDate);
    return send(res, 200, view);
  }
  if (req.method === "PATCH" && dayMatch) {
    const entryDate = parseRouteDate(dayMatch[1]);
    if (!entryDate) return fail(res, 400, "Tanggal tidak valid.");
    assertEntryDate(entryDate);
    const body = await readJson(req);
    const note = String(body.note || "").trim();
    if (note.length > 1800) return fail(res, 400, "Catatan maksimal 1800 karakter.");
    let day = getDayByDate(entryDate);
    if (!day) {
      if (!note) return send(res, 200, dayView(null, entryDate));
      db.prepare("INSERT INTO days (entry_date, note, sync_status) VALUES (?, ?, 'sent')").run(entryDate, note);
      day = getDayByDate(entryDate);
    } else {
      const hasActivePhotos = Boolean(db.prepare(
        "SELECT 1 FROM photos WHERE day_id = ? AND deleted_at IS NULL LIMIT 1"
      ).get(day.id));
      const hasDeletedPhotos = Boolean(db.prepare(
        "SELECT 1 FROM photos WHERE day_id = ? AND deleted_at IS NOT NULL LIMIT 1"
      ).get(day.id));
      const hasActiveVideos = Boolean(db.prepare("SELECT 1 FROM videos WHERE day_id = ? LIMIT 1").get(day.id));
      if (!hasActivePhotos && hasDeletedPhotos && !hasActiveVideos) {
        return fail(res, 404, "Pulihkan dokumentasi dari sampah sebelum mengedit catatan tanggal ini.");
      }
      const hasSyncContent = hasActivePhotos || Boolean(day.discord_thread_id) || readEquipmentLog(day).length > 0;
      db.prepare("UPDATE days SET note = ?, sync_status = CASE WHEN ? THEN 'pending' ELSE sync_status END, " +
        "sync_error = CASE WHEN ? THEN NULL ELSE sync_error END, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(note, hasSyncContent ? 1 : 0, hasSyncContent ? 1 : 0, day.id);
      if (hasSyncContent) queueDaySync(day.id);
    }
    return send(res, 200, dayView(getDayByDate(entryDate)));
  }
  if (req.method === "DELETE" && dayMatch) {
    const entryDate = parseRouteDate(dayMatch[1]);
    const day = entryDate ? getDayByDate(entryDate) : null;
    if (!day || !listDayPhotos(day.id).length) return fail(res, 404, "Dokumentasi tanggal ini tidak ditemukan.");
    await auth.confirmPassword(activeSession, (await readJson(req)).password);
    if (runningSyncs.has(day.id)) return fail(res, 409, "Tunggu sinkronisasi Discord selesai, lalu coba lagi.");
    db.prepare("UPDATE photos SET deleted_at=CURRENT_TIMESTAMP WHERE day_id=? AND deleted_at IS NULL").run(day.id);
    db.prepare("UPDATE days SET sync_status='pending',sync_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(day.id);
    queueDaySync(day.id);
    return send(res, 200, dayView(getDayByDate(entryDate)));
  }

  const videoUploadStartMatch = pathname.match(/^\/api\/days\/([^/]+)\/video-uploads$/);
  if (req.method === "POST" && videoUploadStartMatch) {
    const entryDate = parseRouteDate(videoUploadStartMatch[1]);
    if (!entryDate) return fail(res, 400, "Tanggal tidak valid.");
    assertEntryDate(entryDate);
    const body = await readJson(req);
    const originalName = cleanFilename(body.name || "video-lapangan");
    const extension = path.extname(originalName).toLowerCase();
    const mimeType = videoMimeType(extension);
    const sizeBytes = Number(body.size);
    if (!mimeType) return fail(res, 415, "Gunakan video MP4, MOV, 3GP, atau WebM yang valid.", "unsupported_video");
    const minimumHeaderBytes = extension === ".webm" ? 4 : 12;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < minimumHeaderBytes) return fail(res, 400, "Ukuran video tidak valid.");
    if (sizeBytes > maxVideoBytes) return fail(res, 413, "Ukuran video maksimal 1 GB per berkas.", "video_too_large");
    await cleanupExpiredVideoUploads();
    const userUploads = Array.from(pendingVideoUploads.values()).filter((upload) => upload.userId === activeSession.user.id);
    if (userUploads.length >= 2) return fail(res, 429, "Selesaikan atau batalkan unggahan video yang sedang berjalan.", "too_many_uploads");
    await fs.mkdir(videoUploadsDir, { recursive: true });
    const id = randomUUID();
    const filePath = path.join(videoUploadsDir, id + ".part");
    await fs.writeFile(filePath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    pendingVideoUploads.set(id, {
      id,
      userId: activeSession.user.id,
      entryDate,
      originalName,
      extension,
      mimeType,
      sizeBytes,
      uploadedBytes: 0,
      nextChunk: 0,
      filePath,
      lastActivityAt: Date.now(),
      writing: false,
      finishing: false
    });
    return send(res, 201, { id, chunkBytes: maxVideoChunkBytes });
  }

  const videoChunkMatch = pathname.match(/^\/api\/video-uploads\/([a-f0-9-]+)\/chunks\/(\d+)$/);
  if (req.method === "POST" && videoChunkMatch) {
    const upload = pendingVideoUpload(videoChunkMatch[1], activeSession);
    if (!upload) return fail(res, 404, "Unggahan video tidak ditemukan atau sudah kedaluwarsa.");
    if (upload.writing) return fail(res, 409, "Tunggu bagian video yang sedang dikirim.", "video_chunk_busy");
    const chunkIndex = Number(videoChunkMatch[2]);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex !== upload.nextChunk) {
      return fail(res, 409, "Urutan bagian video tidak sesuai. Mulai unggah kembali.", "video_chunk_order");
    }
    const expectedBytes = Math.min(maxVideoChunkBytes, upload.sizeBytes - upload.uploadedBytes);
    if (expectedBytes <= 0) return fail(res, 409, "Video sudah lengkap. Selesaikan unggahan.");
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > expectedBytes) {
      return fail(res, 413, "Bagian video melebihi ukuran yang diizinkan.", "video_chunk_too_large");
    }
    upload.writing = true;
    try {
      const chunk = await readBody(req, expectedBytes, "Bagian video melebihi ukuran yang diizinkan.");
      if (chunk.length !== expectedBytes) return fail(res, 400, "Bagian video tidak lengkap. Coba unggah kembali.", "video_chunk_incomplete");
      await fs.appendFile(upload.filePath, chunk);
      upload.uploadedBytes += chunk.length;
      upload.nextChunk += 1;
      upload.lastActivityAt = Date.now();
      return send(res, 200, { uploadedBytes: upload.uploadedBytes, totalBytes: upload.sizeBytes });
    } finally {
      upload.writing = false;
    }
  }

  const videoUploadCompleteMatch = pathname.match(/^\/api\/video-uploads\/([a-f0-9-]+)\/complete$/);
  if (req.method === "POST" && videoUploadCompleteMatch) {
    const upload = pendingVideoUpload(videoUploadCompleteMatch[1], activeSession);
    if (!upload) return fail(res, 404, "Unggahan video tidak ditemukan atau sudah kedaluwarsa.");
    if (upload.uploadedBytes !== upload.sizeBytes) return fail(res, 409, "Video belum terunggah sepenuhnya.", "video_incomplete");
    upload.finishing = true;
    const file = await fs.stat(upload.filePath);
    if (file.size !== upload.sizeBytes || !(await hasValidVideoContainer(upload.filePath, upload.extension))) {
      await discardPendingVideoUpload(upload.id);
      return fail(res, 415, "Berkas ini bukan video yang valid. Coba pilih MP4, MOV, 3GP, atau WebM.", "unsupported_video");
    }

    await fs.mkdir(videosDir, { recursive: true });
    const id = randomUUID();
    const storedName = id + upload.extension;
    const finalPath = path.join(videosDir, storedName);
    await fs.rename(upload.filePath, finalPath);
    try {
      runInTransaction(() => {
        let day = getDayByDate(upload.entryDate);
        if (!day) {
          const inserted = db.prepare("INSERT INTO days (entry_date, sync_status) VALUES (?, 'sent')").run(upload.entryDate);
          day = db.prepare("SELECT * FROM days WHERE id = ?").get(Number(inserted.lastInsertRowid));
        }
        const order = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM videos WHERE day_id = ?")
          .get(day.id).next;
        db.prepare(
          "INSERT INTO videos (id, day_id, original_name, stored_name, mime_type, size_bytes, sort_order) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(id, day.id, upload.originalName, storedName, upload.mimeType, upload.sizeBytes, order);
        db.prepare("UPDATE days SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(day.id);
      })();
      pendingVideoUploads.delete(upload.id);
      return send(res, 201, dayView(getDayByDate(upload.entryDate)));
    } catch (error) {
      pendingVideoUploads.delete(upload.id);
      await fs.rm(finalPath, { force: true });
      throw error;
    }
  }

  const videoUploadCancelMatch = pathname.match(/^\/api\/video-uploads\/([a-f0-9-]+)\/cancel$/);
  if (req.method === "POST" && videoUploadCancelMatch) {
    const upload = pendingVideoUploads.get(videoUploadCancelMatch[1]);
    if (upload && upload.userId !== activeSession.user.id) return fail(res, 404, "Unggahan video tidak ditemukan.");
    if (upload && (upload.writing || upload.finishing)) return fail(res, 409, "Tunggu bagian video yang sedang diproses.");
    if (upload) await discardPendingVideoUpload(upload.id);
    return send(res, 200, { ok: true });
  }

  const videoUploadMatch = pathname.match(/^\/api\/days\/([^/]+)\/videos$/);
  if (req.method === "POST" && videoUploadMatch) {
    const entryDate = parseRouteDate(videoUploadMatch[1]);
    if (!entryDate) return fail(res, 400, "Tanggal tidak valid.");
    assertEntryDate(entryDate);
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxSingleRequestVideoBytes) {
      return fail(res, 413, "Unggah video lewat bagian dokumentasi video agar dapat dikirim bertahap.", "video_chunked_upload_required");
    }
    const source = await readBody(req, maxSingleRequestVideoBytes, "Unggah video lewat bagian dokumentasi video agar dapat dikirim bertahap.");
    if (!source.length) return fail(res, 400, "Pilih video sebelum mengunggah.");
    const uploadedName = cleanFilename(req.headers["x-file-name"] || "video-lapangan");
    const extension = path.extname(uploadedName).toLowerCase();
    const isMp4Container = source.length >= 12 && source.toString("ascii", 4, 8) === "ftyp";
    const isWebmContainer = source.length >= 4 && source[0] === 0x1a && source[1] === 0x45 &&
      source[2] === 0xdf && source[3] === 0xa3;
    const mimeByExtension = {
      ".mp4": "video/mp4",
      ".m4v": "video/mp4",
      ".mov": "video/quicktime",
      ".3gp": "video/3gpp",
      ".webm": "video/webm"
    };
    const mimeType = mimeByExtension[extension];
    const validContainer = extension === ".webm" ? isWebmContainer
      : [".mp4", ".m4v", ".mov", ".3gp"].includes(extension) && isMp4Container;
    if (!mimeType || !validContainer) {
      return fail(res, 415, "Gunakan video MP4, MOV, 3GP, atau WebM yang valid.", "unsupported_video");
    }

    await fs.mkdir(videosDir, { recursive: true });
    const id = randomUUID();
    const storedName = id + extension;
    const originalName = uploadedName.slice(-120);
    const filePath = path.join(videosDir, storedName);
    await fs.writeFile(filePath, source, { flag: "wx" });
    try {
      runInTransaction(() => {
        let day = getDayByDate(entryDate);
        if (!day) {
          const inserted = db.prepare("INSERT INTO days (entry_date, sync_status) VALUES (?, 'sent')").run(entryDate);
          day = db.prepare("SELECT * FROM days WHERE id = ?").get(Number(inserted.lastInsertRowid));
        }
        const order = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM videos WHERE day_id = ?")
          .get(day.id).next;
        db.prepare(
          "INSERT INTO videos (id, day_id, original_name, stored_name, mime_type, size_bytes, sort_order) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(id, day.id, originalName, storedName, mimeType, source.length, order);
        db.prepare("UPDATE days SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(day.id);
      })();
      return send(res, 201, dayView(getDayByDate(entryDate)));
    } catch (error) {
      await fs.rm(filePath, { force: true });
      throw error;
    }
  }

  const videoDeleteMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)$/);
  if (req.method === "DELETE" && videoDeleteMatch) {
    const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(videoDeleteMatch[1]);
    if (!video) return fail(res, 404, "Video tidak ditemukan.");
    await auth.confirmPassword(activeSession, (await readJson(req)).password);
    db.prepare("DELETE FROM videos WHERE id = ?").run(video.id);
    await fs.rm(path.join(videosDir, video.stored_name), { force: true });
    db.prepare("UPDATE days SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(video.day_id);
    return send(res, 200, dayView(db.prepare("SELECT * FROM days WHERE id = ?").get(video.day_id)));
  }

  const videoStreamMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/stream$/);
  if (req.method === "GET" && videoStreamMatch) {
    const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(videoStreamMatch[1]);
    if (!video) return fail(res, 404, "Video tidak ditemukan.");
    const filePath = path.join(videosDir, video.stored_name);
    let file;
    try {
      file = await fs.stat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return fail(res, 410, "Berkas video tidak ada di arsip. Unggah ulang berkas aslinya.", "video_file_missing");
      }
      throw error;
    }
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { "content-range": "bytes */" + file.size, "accept-ranges": "bytes" });
        return res.end();
      }
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!suffixLength) {
          res.writeHead(416, { "content-range": "bytes */" + file.size, "accept-ranges": "bytes" });
          return res.end();
        }
        start = Math.max(0, file.size - suffixLength);
      } else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(file.size - 1, Number(match[2]));
      }
      if (start >= file.size || end < start) {
        res.writeHead(416, { "content-range": "bytes */" + file.size, "accept-ranges": "bytes" });
        return res.end();
      }
      status = 206;
    }
    const headers = {
      "content-type": video.mime_type,
      "content-length": end - start + 1,
      "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(video.original_name),
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY"
    };
    if (status === 206) headers["content-range"] = "bytes " + start + "-" + end + "/" + file.size;
    res.writeHead(status, headers);
    const stream = fsSync.createReadStream(filePath, { start, end });
    stream.once("error", (error) => {
      console.error(error);
      if (res.headersSent) res.destroy(error);
      else fail(res, 500, "Video tidak dapat diputar.");
    });
    res.once("close", () => { if (!res.writableFinished) stream.destroy(); });
    return stream.pipe(res);
  }

  const photoUploadMatch = pathname.match(/^\/api\/days\/([^/]+)\/photos$/);
  if (req.method === "POST" && photoUploadMatch) {
    const entryDate = parseRouteDate(photoUploadMatch[1]);
    if (!entryDate) return fail(res, 400, "Tanggal tidak valid.");
    assertEntryDate(entryDate);
    const source = await readBody(req, maxPhotoBytes);
    if (!source.length) return fail(res, 400, "Pilih foto sebelum mengunggah.");
    let metadata;
    let converted;
    try {
      const image = sharp(source, { failOn: "error" }).rotate();
      metadata = await image.metadata();
      if (!metadata.width || !metadata.height || !["jpeg", "png", "webp", "avif", "heif"].includes(metadata.format)) {
        return fail(res, 415, "Gunakan foto JPG, PNG, WebP, AVIF, atau HEIC yang didukung.");
      }
      converted = await sharp(source, { failOn: "error" }).rotate()
        .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 75, mozjpeg: true }).toBuffer();
    } catch {
      return fail(res, 415, "Foto ini tidak bisa dibaca. Coba simpan sebagai JPG lalu unggah lagi.", "unsupported_image");
    }
    await fs.mkdir(photosDir, { recursive: true });
    await fs.mkdir(previewsDir, { recursive: true });
    const id = randomUUID();
    const uploadedName = cleanFilename(req.headers["x-file-name"] || "foto-lapangan");
    const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
    const originalName = uploadedName.replace(/\.(?:jpe?g|png|webp|avif|heic|heif)$/i, "") + "." + extension;
    const storedName = id + ".original";
    const previewName = id + ".jpg";
    await fs.writeFile(path.join(photosDir, storedName), source, { flag: "wx" });
    await fs.writeFile(path.join(previewsDir, previewName), converted, { flag: "wx" });

    let day = getDayByDate(entryDate);
    if (!day) {
      const inserted = db.prepare("INSERT INTO days (entry_date, sync_status) VALUES (?, 'pending')").run(entryDate);
      day = db.prepare("SELECT * FROM days WHERE id = ?").get(Number(inserted.lastInsertRowid));
    }
    const order = db.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM photos WHERE day_id = ?"
    ).get(day.id).next;
    db.prepare(
      "INSERT INTO photos (id, day_id, original_name, stored_name, preview_name, image_format, size_bytes, sort_order) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, day.id, originalName, storedName, previewName, metadata.format, source.length, order);
    db.prepare("UPDATE days SET sync_status = 'pending', sync_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(day.id);
    queueDaySync(day.id);
    return send(res, 201, dayView(getDayByDate(entryDate)));
  }

  const photoEditMatch = pathname.match(/^\/api\/photos\/([a-f0-9-]+)$/);
  if (req.method === "PATCH" && photoEditMatch) {
    const body = await readJson(req);
    const caption = String(body.caption || "").trim();
    if (caption.length > 240) return fail(res, 400, "Keterangan foto maksimal 240 karakter.");
    const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND deleted_at IS NULL").get(photoEditMatch[1]);
    if (!photo) return fail(res, 404, "Foto tidak ditemukan.");
    db.prepare("UPDATE photos SET caption = ? WHERE id = ?").run(caption, photo.id);
    db.prepare("UPDATE days SET sync_status = 'pending', sync_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(photo.day_id);
    queueDaySync(photo.day_id);
    return send(res, 200, dayView(db.prepare("SELECT * FROM days WHERE id = ?").get(photo.day_id)));
  }
  if (req.method === "DELETE" && photoEditMatch) {
    const photo = db.prepare("SELECT * FROM photos WHERE id=? AND deleted_at IS NULL").get(photoEditMatch[1]);
    if (!photo) return fail(res, 404, "Foto tidak ditemukan.");
    await auth.confirmPassword(activeSession, (await readJson(req)).password);
    if (runningSyncs.has(photo.day_id)) return fail(res, 409, "Tunggu sinkronisasi Discord selesai, lalu coba lagi.");
    db.prepare("UPDATE photos SET deleted_at=CURRENT_TIMESTAMP WHERE id=?").run(photo.id);
    db.prepare("UPDATE days SET sync_status='pending',sync_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(photo.day_id);
    queueDaySync(photo.day_id);
    return send(res, 200, dayView(db.prepare("SELECT * FROM days WHERE id=?").get(photo.day_id)));
  }

  const stampMetadataMatch = pathname.match(/^\/api\/photos\/([a-f0-9-]+)\/stamp-metadata$/);
  if (req.method === "GET" && stampMetadataMatch) {
    auth.requireAdmin(activeSession);
    const photo = db.prepare("SELECT stored_name FROM photos WHERE id = ? AND deleted_at IS NULL")
      .get(stampMetadataMatch[1]);
    if (!photo) return fail(res, 404, "Foto tidak ditemukan.");
    const metadata = await sharp(path.join(photosDir, photo.stored_name)).metadata();
    const swapped = metadata.orientation >= 5 && metadata.orientation <= 8;
    return send(res, 200, {
      width: swapped ? metadata.height : metadata.width,
      height: swapped ? metadata.width : metadata.height
    });
  }

  const stampPreviewMatch = pathname.match(/^\/api\/photos\/([a-f0-9-]+)\/stamp-preview$/);
  if (req.method === "GET" && stampPreviewMatch) {
    auth.requireAdmin(activeSession);
    const photo = db.prepare("SELECT stored_name FROM photos WHERE id = ? AND deleted_at IS NULL")
      .get(stampPreviewMatch[1]);
    if (!photo) return fail(res, 404, "Foto tidak ditemukan.");
    const stampDate = url.searchParams.get("date");
    if (!validDate(stampDate)) return fail(res, 400, "Pilih tanggal salinan foto yang valid.");
    const stampLayout = parseDateStampLayout(url.searchParams);
    if (!stampLayout) return fail(res, 400, "Atur posisi dan ukuran cap tanggal dengan benar.");
    const metadata = await sharp(path.join(photosDir, photo.stored_name)).metadata();
    return send(res, 200, dateStampSvg(stampDate, metadata, stampLayout), "image/svg+xml; charset=utf-8");
  }

  const datedPhotoMatch = pathname.match(/^\/api\/photos\/([a-f0-9-]+)\/dated$/);
  if (req.method === "GET" && datedPhotoMatch) {
    auth.requireAdmin(activeSession);
    const photo = db.prepare(
      "SELECT photos.*, days.entry_date FROM photos JOIN days ON days.id = photos.day_id " +
      "WHERE photos.id = ? AND photos.deleted_at IS NULL"
    ).get(datedPhotoMatch[1]);
    if (!photo) return fail(res, 404, "Foto tidak ditemukan.");
    const stampDate = url.searchParams.get("date");
    if (!validDate(stampDate)) return fail(res, 400, "Pilih tanggal salinan foto yang valid.");
    const stampLayout = parseDateStampLayout(url.searchParams);
    if (!stampLayout) return fail(res, 400, "Atur posisi dan ukuran cap tanggal dengan benar.");
    const sourcePath = path.join(photosDir, photo.stored_name);
    const metadata = await sharp(sourcePath).metadata();
    const sourceName = cleanFilename(photo.original_name);
    const extension = path.extname(sourceName);
    const base = path.basename(sourceName, extension).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "foto";
    const filename = "Sitebook-" + stampDate + "-" + base + "-dated.jpg";
    const output = sharp(sourcePath, { failOn: "error" })
      .rotate()
      .composite([{ input: dateStampSvg(stampDate, metadata, stampLayout), left: 0, top: 0 }])
      .jpeg({ quality: 90, mozjpeg: true });
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-disposition": 'attachment; filename="' + filename + '"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    output.once("error", (error) => {
      console.error(error);
      if (res.headersSent) res.destroy(error);
      else fail(res, 500, "Salinan foto bertanggal tidak dapat dibuat.");
    });
    res.once("close", () => { if (!res.writableFinished) output.destroy(); });
    return output.pipe(res);
  }

  const mediaMatch = pathname.match(/^\/api\/photos\/([a-f0-9-]+)\/(preview|original)$/);
  if (req.method === "GET" && mediaMatch) {
    const photo = db.prepare("SELECT * FROM photos WHERE id = ? AND deleted_at IS NULL").get(mediaMatch[1]);
    if (!photo) return fail(res, 404, "Foto tidak ditemukan.");
    const isPreview = mediaMatch[2] === "preview";
    const filePath = path.join(isPreview ? previewsDir : photosDir, isPreview ? photo.preview_name : photo.stored_name);
    let bytes = await fs.readFile(filePath);
    let etag = null;
    if (isPreview) {
      const metadata = await sharp(bytes).metadata();
      if (Math.max(metadata.width || 0, metadata.height || 0) > 1200) {
        bytes = await sharp(bytes).resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 75, mozjpeg: true }).toBuffer();
        const tempPath = filePath + "." + randomUUID() + ".tmp";
        await fs.writeFile(tempPath, bytes, { flag: "wx" });
        try {
          await fs.rename(tempPath, filePath);
        } catch (error) {
          await fs.copyFile(tempPath, filePath);
        } finally {
          await fs.rm(tempPath, { force: true });
        }
      }
      etag = '"' + createHash("sha256").update(bytes).digest("hex") + '"';
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { "cache-control": "private, no-cache", etag });
        return res.end();
      }
    }
    res.writeHead(200, {
      "content-type": isPreview ? "image/jpeg" : imageMime(photo.image_format),
      "content-length": bytes.length,
      "cache-control": isPreview ? "private, no-cache" : "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      ...(etag ? { etag } : {})
    });
    return res.end(bytes);
  }

  if (req.method === "GET" && pathname === "/api/photos.zip") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const stamped = url.searchParams.get("stamped") === "1";
    if (stamped) auth.requireAdmin(activeSession);
    const stampLayout = stamped ? parseDateStampLayout(url.searchParams) : null;
    if (stamped && !stampLayout) return fail(res, 400, "Atur posisi dan ukuran cap tanggal dengan benar.");
    if (!validDate(from) || !validDate(to) || from > to) return fail(res, 400, "Pilih rentang tanggal foto yang valid.");
    const settings = currentSettings();
    if (!settings.week_start_date) return fail(res, 409, "Atur tanggal awal Week 1 terlebih dahulu.");
    if (from < settings.week_start_date) return fail(res, 400, "Rentang foto harus sama atau sesudah tanggal awal Week 1.");
    const photos = db.prepare(
      "SELECT days.entry_date, photos.original_name, photos.stored_name, photos.size_bytes, photos.sort_order " +
      "FROM photos JOIN days ON days.id = photos.day_id WHERE days.entry_date >= ? AND days.entry_date <= ? " +
      "AND photos.deleted_at IS NULL ORDER BY days.entry_date, photos.sort_order, photos.created_at"
    ).all(from, to);
    if (url.searchParams.get("estimate") === "1") {
      return send(res, 200, {
        photoCount: photos.length,
        totalBytes: photos.reduce((total, photo) => total + photo.size_bytes, 0),
        ...(stamped ? { approximate: true } : {})
      });
    }
    if (!photos.length) return fail(res, 404, "Tidak ada foto pada periode ini.");
    const archive = new JSZip();
    for (const photo of photos) {
      const sourcePath = path.join(photosDir, photo.stored_name);
      let filename = String(photo.sort_order).padStart(3, "0") + "-" + cleanFilename(photo.original_name);
      let source = fsSync.createReadStream(sourcePath);
      if (stamped) {
        const metadata = await sharp(sourcePath).metadata();
        const dot = filename.lastIndexOf(".");
        filename = (dot > 0 ? filename.slice(0, dot) : filename) + "-dated.jpg";
        source = sharp(sourcePath, { failOn: "error" })
          .rotate()
          .composite([{ input: dateStampSvg(photo.entry_date, metadata, stampLayout), left: 0, top: 0 }])
          .jpeg({ quality: 90, mozjpeg: true });
      }
      archive.file(photo.entry_date + "/" + filename, source, { binary: true });
    }
    const archiveStream = archive.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "STORE" });
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="Sitebook-' + (stamped ? "dated-photos" : "photos") + "-" + from + "-to-" + to + '.zip"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    archiveStream.once("error", (error) => {
      console.error(error);
      if (res.headersSent) res.destroy(error);
      else fail(res, 500, "ZIP foto tidak dapat dibuat.");
    });
    res.once("close", () => { if (!res.writableFinished) archiveStream.destroy(); });
    return archiveStream.pipe(res);
  }

  if (req.method === "POST" && pathname === "/api/discord/retry") {
    const body = await readJson(req);
    const day = db.prepare("SELECT * FROM days WHERE entry_date = ?").get(String(body.date || ""));
    if (!day) return fail(res, 404, "Catatan tanggal tersebut tidak ditemukan.");
    if (day.sync_status === "uncertain" && body.confirmUncertain !== true) {
      return fail(res, 409, "Periksa forum Discord dulu sebelum mencoba ulang kiriman yang hasilnya belum pasti.", "confirm_required");
    }
    if (!webhookUrl) return fail(res, 409, "Hubungkan webhook Discord di Pengaturan dulu.", "webhook_required");
    db.prepare("UPDATE days SET sync_status = 'pending', sync_error = NULL WHERE id = ?").run(day.id);
    queueDaySync(day.id);
    return send(res, 202, { ok: true, message: "Kiriman masuk antrean." });
  }

  if (req.method === "GET" && pathname === "/api/reports.docx") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!validDate(from) || !validDate(to) || from > to) return fail(res, 400, "Pilih rentang tanggal laporan yang valid.");
    const settings = currentSettings();
    if (!settings.week_start_date) return fail(res, 409, "Atur tanggal awal Week 1 terlebih dahulu.");
    if (from < settings.week_start_date) return fail(res, 400, "Rentang laporan harus sama atau sesudah tanggal awal Week 1.");
    const rows = db.prepare("SELECT * FROM days WHERE entry_date >= ? AND entry_date <= ? " +
      "AND (EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id AND photos.deleted_at IS NULL) " +
      "OR (note <> '' AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id)) " +
      "OR (equipment_json <> '[]' AND (EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id AND photos.deleted_at IS NULL) " +
      "OR NOT EXISTS (SELECT 1 FROM photos WHERE photos.day_id=days.id)))) ORDER BY entry_date").all(from, to);
    const days = rows.map((row) => ({
      ...row,
      equipmentLog: readEquipmentLog(row),
      photos: db.prepare(
        "SELECT id, caption, preview_name FROM photos WHERE day_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at"
      ).all(row.id)
    }));
    const document = await makeReport(docx, {
      projectName: settings.project_name,
      startDate: settings.week_start_date,
      from,
      to,
      days,
      dataDir,
      sharp
    });
    const buffer = await Packer.toBuffer(document);
    const filename = "Sitebook-" + from + "-sampai-" + to + ".docx";
    res.writeHead(200, {
      "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": "attachment; filename=\"" + filename + "\"",
      "content-length": buffer.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    return res.end(buffer);
  }

  if (req.method === "GET" && ["/api/equipment-hours.xlsx", "/api/equipment-hours.pdf"].includes(pathname)) {
    const isPdf = pathname.endsWith(".pdf");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!validDate(from) || !validDate(to) || from > to) return fail(res, 400, "Pilih rentang tanggal laporan yang valid.");
    const settings = currentSettings();
    if (!settings.week_start_date) return fail(res, 409, "Atur tanggal awal Week 1 terlebih dahulu.");
    if (from < settings.week_start_date) return fail(res, 400, "Rentang laporan harus sama atau sesudah tanggal awal Week 1.");
    const rows = db.prepare("SELECT * FROM days WHERE entry_date >= ? AND entry_date <= ? AND equipment_json <> '[]' ORDER BY entry_date").all(from, to);
    const days = rows.map((row) => ({ ...row, equipmentLog: readEquipmentLog(row) }));
    const reportOptions = {
      projectName: settings.project_name,
      startDate: settings.week_start_date,
      from,
      to,
      days
    };
    const buffer = isPdf
      ? await makeEquipmentPdf(PDFDocument, reportOptions)
      : await makeEquipmentWorkbook(JSZip, reportOptions);
    const extension = isPdf ? "pdf" : "xlsx";
    const filename = "Sitebook-jam-alat-" + from + "-sampai-" + to + "." + extension;
    res.writeHead(200, {
      "content-type": isPdf ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": "attachment; filename=\"" + filename + "\"",
      "content-length": buffer.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    return res.end(buffer);
  }

  if (req.method === "GET" && pathname === "/api/backup.zip") {
    const settings = currentSettings();
    const archive = await makeBackup(JSZip, { dataDir, databasePath, projectName: settings.project_name });
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": "attachment; filename=\"sitebook-backup-" + currentWibDate() + ".zip\"",
      "content-length": archive.length,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    return res.end(archive);
  }

  if (req.method === "POST" && pathname === "/api/backup/restore") {
    if (runningSyncs.size) return fail(res, 409, "Tunggu sinkronisasi Discord selesai sebelum memulihkan cadangan.");
    const archive = await readBody(req, maxRestoreBytes);
    if (!archive.length) return fail(res, 400, "Pilih berkas ZIP cadangan.");
    const staging = path.join(appDir, ".restore-" + randomUUID());
    let rollbackDir = null;
    await fs.mkdir(staging, { recursive: true });
    try {
      const staged = await stageRestore(JSZip, archive, staging);
      const check = new DatabaseSync(staged.databasePath, { readOnly: true });
      const integrity = check.prepare("PRAGMA integrity_check").get();
      const tables = check.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'days', 'photos')"
      ).all().map((row) => row.name);
      check.close();
      if (!integrity || integrity.integrity_check !== "ok" ||
          !["settings", "days", "photos"].every((table) => tables.includes(table))) {
        throw new Error("Database cadangan tidak lengkap atau rusak.");
      }

      maintenance = true;
      rollbackDir = path.join(appDir, "recovery", "pre-restore-" + Date.now());
      await fs.mkdir(rollbackDir, { recursive: true });
      db.close();
      try {
        await fs.copyFile(databasePath, path.join(rollbackDir, "sitebook.sqlite"));
        if (await pathExists(photosDir)) await fs.cp(photosDir, path.join(rollbackDir, "photos"), { recursive: true });
        if (await pathExists(previewsDir)) await fs.cp(previewsDir, path.join(rollbackDir, "previews"), { recursive: true });
        if (await pathExists(videosDir)) await fs.cp(videosDir, path.join(rollbackDir, "videos"), { recursive: true });
        const replacement = path.join(dataDir, "sitebook.restore.sqlite");
        await fs.copyFile(staged.databasePath, replacement);
        await fs.rm(databasePath, { force: true });
        await fs.rename(replacement, databasePath);
        await fs.rm(photosDir, { recursive: true, force: true });
        await fs.rm(previewsDir, { recursive: true, force: true });
        await fs.rm(videosDir, { recursive: true, force: true });
        await copyStagedFolder(path.join(staging, "photos"), photosDir);
        await copyStagedFolder(path.join(staging, "previews"), previewsDir);
        await copyStagedFolder(path.join(staging, "videos"), videosDir);
        db = openDatabase();
      } catch (restoreError) {
        await fs.rm(databasePath, { force: true });
        await fs.copyFile(path.join(rollbackDir, "sitebook.sqlite"), databasePath).catch(() => {});
        await fs.rm(photosDir, { recursive: true, force: true });
        await fs.rm(previewsDir, { recursive: true, force: true });
        await fs.rm(videosDir, { recursive: true, force: true });
        await copyStagedFolder(path.join(rollbackDir, "photos"), photosDir).catch(() => {});
        await copyStagedFolder(path.join(rollbackDir, "previews"), previewsDir).catch(() => {});
        await copyStagedFolder(path.join(rollbackDir, "videos"), videosDir).catch(() => {});
        db = openDatabase();
        throw restoreError;
      }
      maintenance = false;
      for (const day of db.prepare("SELECT id FROM days WHERE sync_status IN ('pending', 'waiting_config')").all()) {
        queueDaySync(day.id);
      }
      return send(res, 200, { ok: true, projectName: currentSettings().project_name });
    } finally {
      maintenance = false;
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  return fail(res, 404, "Halaman atau data tidak ditemukan.", "not_found");
}

function nextMonth(value) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

function cleanFilename(value) {
  let decoded = String(value || "foto-lapangan");
  try { decoded = decodeURIComponent(decoded); } catch {}
  const name = path.basename(decoded.replace(/[\\/]/g, path.sep))
    .replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.slice(0, 120) || "foto-lapangan";
}

function videoMimeType(extension) {
  return ({
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".3gp": "video/3gpp",
    ".webm": "video/webm"
  })[extension] || "";
}

async function hasValidVideoContainer(filePath, extension) {
  const handle = await fs.open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (extension === ".webm") {
      return bytesRead >= 4 && header[0] === 0x1a && header[1] === 0x45 &&
        header[2] === 0xdf && header[3] === 0xa3;
    }
    return bytesRead >= 12 && header.toString("ascii", 4, 8) === "ftyp";
  } finally {
    await handle.close();
  }
}

async function discardPendingVideoUpload(uploadId) {
  const upload = pendingVideoUploads.get(uploadId);
  if (!upload) return false;
  pendingVideoUploads.delete(uploadId);
  await fs.rm(upload.filePath, { force: true });
  return true;
}

async function cleanupExpiredVideoUploads() {
  const expiredAt = Date.now() - 6 * 60 * 60 * 1000;
  for (const [uploadId, upload] of pendingVideoUploads) {
    if (upload.lastActivityAt < expiredAt && !upload.finishing) {
      await discardPendingVideoUpload(uploadId).catch((error) => console.error("Gagal membersihkan unggahan video sementara:", error));
    }
  }
}

function pendingVideoUpload(uploadId, activeSession) {
  const upload = pendingVideoUploads.get(uploadId);
  if (!upload || upload.userId !== activeSession.user.id || upload.finishing) return null;
  upload.lastActivityAt = Date.now();
  return upload;
}

function imageMime(format) {
  const values = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif", heif: "image/heic" };
  return values[format] || "application/octet-stream";
}

async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function copyStagedFolder(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  if (await pathExists(source)) await fs.cp(source, destination, { recursive: true, force: true });
}

async function start() {
  await fs.mkdir(photosDir, { recursive: true });
  await fs.mkdir(previewsDir, { recursive: true });
  await fs.mkdir(videosDir, { recursive: true });
  await fs.rm(videoUploadsDir, { recursive: true, force: true });
  await fs.mkdir(videoUploadsDir, { recursive: true });
  webhookUrl = await loadWebhook();
  db = openDatabase();
  auth = openAuth(path.join(dataDir, "accounts.sqlite"));
  db.prepare(
    "UPDATE days SET sync_status = 'uncertain', sync_error = 'Aplikasi berhenti saat status kiriman Discord belum tersimpan. Periksa forum sebelum mencoba ulang.' WHERE sync_status = 'syncing'"
  ).run();
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => errorResponse(res, error));
  });
  server.listen(port, host, () => {
    console.log("Sitebook Field Log berjalan di http://" + host + ":" + port);
    if (!webhookUrl) console.log("Discord belum terhubung. Tambahkan webhook lewat Pengaturan.");
    uploadCleanupTimer = setInterval(() => {
      cleanupExpiredVideoUploads().catch((error) => console.error("Gagal membersihkan unggahan video sementara:", error));
    }, 30 * 60 * 1000);
    uploadCleanupTimer.unref();
    for (const day of db.prepare("SELECT id FROM days WHERE sync_status IN ('pending', 'waiting_config')").all()) {
      queueDaySync(day.id);
    }
  });
  const stop = () => {
    if (uploadCleanupTimer) clearInterval(uploadCleanupTimer);
    server.close(() => {
      try { db.close(); } catch {}
      try { auth.db.close(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

start().catch((error) => {
  console.error("Aplikasi gagal dijalankan:", error);
  process.exitCode = 1;
});

