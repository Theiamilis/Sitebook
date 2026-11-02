const $ = (selector) => document.querySelector(selector);
const t = (key, vars) => I18n.t(key, vars);
const equipmentHours = ["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"];
const videoUploadChunkBytes = 8 * 1024 * 1024;
const videoUploadMaxBytes = 1024 * 1024 * 1024;

const elements = {
  projectTitle: $("#project-title"),
  entryDate: $("#entry-date"),
  weekLabel: $("#week-label"),
  setupNotice: $("#setup-notice"),
  photoInput: $("#photo-input"),
  photoGrid: $("#photo-grid"),
  videoInput: $("#video-input"),
  videoGrid: $("#video-grid"),
  videoUploadProgress: $("#video-upload-progress"),
  photoCount: $("#photo-count"),
  syncState: $("#sync-state"),
  dayNote: $("#day-note"),
  noteStatus: $("#note-status"),
  saveNote: $("#save-note"),
  equipmentList: $("#equipment-list"),
  equipmentStatus: $("#equipment-status"),
  addEquipmentDowntime: $("#add-equipment-downtime"),
  saveEquipmentDowntime: $("#save-equipment-downtime"),
  archiveMonth: $("#archive-month"),
  archiveList: $("#archive-list"),
  discordSummary: $("#discord-summary"),
  retrySync: $("#retry-sync"),
  connection: $("#connection-label"),
  settingsDialog: $("#settings-dialog"),
  settingsForm: $("#settings-form"),
  projectName: $("#project-name"),
  weekStart: $("#week-start"),
  weekStartHelp: $("#week-start-help"),
  webhookUrl: $("#webhook-url"),
  webhookStatus: $("#webhook-status"),
  settingsFeedback: $("#settings-feedback"),
  reportDialog: $("#report-dialog"),
  reportForm: $("#report-form"),
  reportMode: $("#report-mode"),
  reportWeek: $("#report-week"),
  reportWeekFields: $("#report-week-fields"),
  reportRangeFields: $("#report-range-fields"),
  reportFrom: $("#report-from"),
  reportTo: $("#report-to"),
  reportFeedback: $("#report-feedback"),
  dateStampDialog: $("#date-stamp-dialog"),
  dateStampForm: $("#date-stamp-form"),
  dateStampDate: $("#date-stamp-date"),
  dateStampPhoto: $("#date-stamp-photo"),
  dateStampFeedback: $("#date-stamp-feedback"),
  stampX: $("#stamp-x"),
  stampY: $("#stamp-y"),
  stampSize: $("#stamp-size"),
  stampOpacity: $("#stamp-opacity"),
  stampColor: $("#stamp-color"),
  stampPickColor: $("#stamp-pick-color"),
  stampColorHelp: $("#stamp-color-help"),
  stampXPx: $("#stamp-x-px"),
  stampYPx: $("#stamp-y-px"),
  stampZoom: $("#stamp-zoom"),
  stampXValue: $("#stamp-x-value"),
  stampYValue: $("#stamp-y-value"),
  stampSizeValue: $("#stamp-size-value"),
  stampOpacityValue: $("#stamp-opacity-value"),
  stampColorValue: $("#stamp-color-value"),
  stampZoomValue: $("#stamp-zoom-value"),
  stampSourceSize: $("#stamp-source-size"),
  stampPreviewViewport: $("#stamp-preview-viewport"),
  stampPreviewFrame: $("#stamp-preview-frame"),
  stampPreviewImage: $("#stamp-preview-image"),
  stampPreviewOverlay: $("#stamp-preview-overlay"),
  stampPreviewLabel: $("#stamp-preview-label"),
  toast: $("#toast"),
  confirmDialog: $("#confirm-dialog"),
  confirmMessage: $("#confirm-message"),
  confirmAction: $("#confirm-action"),
  uploadProgress: $("#upload-progress")
};

let state = null;
let authState = { initialized: true, user: null, csrfToken: null };
let pendingPasswordAction = null;
let currentDay = null;
let noteDirty = false;
let captionDirty = false;
let equipmentDirty = false;
let equipmentSaving = false;
let equipmentDraft = [];
const captionDrafts = new Map();
let uploading = false;
let uploadingVideos = false;
let dayRequest = 0;
let activeDate = "";
let toastTimer = null;
let resolveConfirmation = null;
let archiveDays = [];
let dateStampPhoto = null;
let stampDimensions = null;
let pickingStampColor = false;
let stampSampleCanvas = null;
let stampSampleSource = "";
let stampOverlayTimer = null;
let stampOverlayKey = "";
let stampOverlayPendingKey = "";
const stampLayoutStorageKey = "sitebook.dateStampLayout";
let stampLayout = readStampLayout();

function askConfirmation(message, title, actionLabel) {
  if (elements.confirmDialog.open) return Promise.resolve(false);
  $("#confirm-title").textContent = title || t("Lanjutkan perubahan?");
  elements.confirmMessage.textContent = message;
  elements.confirmAction.textContent = actionLabel || t("Lanjutkan");
  elements.confirmDialog.showModal();
  return new Promise((resolve) => { resolveConfirmation = resolve; });
}

function equipmentTotalLabel(item) {
  const stats = EquipmentHours.calculate(item.hours, item.offIntervals || []);
  return t("{hours} jam", { hours: EquipmentHours.formatHours(stats.totalMinutes, I18n.locale) });
}

function offIntervalErrorText(error) {
  const messages = {
    invalid: "Isi jam mulai dan selesai untuk setiap waktu OFF.",
    time: "Isi jam mulai dan selesai untuk setiap waktu OFF.",
    duration: "Jam selesai harus setelah jam mulai.",
    overlap: "Rentang OFF tidak boleh bertumpuk.",
    tooMany: "Maksimum 20 rentang OFF per alat."
  };
  return error ? t(messages[error] || messages.invalid) : "";
}

function dateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return part("year") + "-" + part("month") + "-" + part("day");
}

function readStampLayout() {
  const defaults = { x: 78, y: 82, size: 4, opacity: 100, color: "#ffffff" };
  try {
    const saved = JSON.parse(localStorage.getItem("sitebook.dateStampLayout") || "null");
    if (!saved) return defaults;
    return {
      x: Number.isFinite(Number(saved.x)) ? Math.min(100, Math.max(0, Number(saved.x))) : defaults.x,
      y: Number.isFinite(Number(saved.y)) ? Math.min(100, Math.max(0, Number(saved.y))) : defaults.y,
      size: Number.isFinite(Number(saved.size)) ? Math.min(10, Math.max(1.5, Number(saved.size))) : defaults.size,
      opacity: Number.isFinite(Number(saved.opacity)) ? Math.min(100, Math.max(0, Number(saved.opacity))) : defaults.opacity,
      color: typeof saved.color === "string" && /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color.toLowerCase() : defaults.color
    };
  } catch { return defaults; }
}

function stampDateText(value) {
  const [year, month, day] = value.split("-");
  return day + "/" + month + "/" + year;
}

function saveStampLayout() {
  stampLayout = {
    x: Number(stampLayout.x),
    y: Number(stampLayout.y),
    size: Number(elements.stampSize.value),
    opacity: Number(elements.stampOpacity.value),
    color: elements.stampColor.value.toLowerCase()
  };
  try { localStorage.setItem(stampLayoutStorageKey, JSON.stringify(stampLayout)); } catch {}
}

function clearStampOverlayPreview() {
  clearTimeout(stampOverlayTimer);
  stampOverlayTimer = null;
  stampOverlayKey = "";
  stampOverlayPendingKey = "";
  elements.stampPreviewOverlay.onload = null;
  elements.stampPreviewOverlay.onerror = null;
  elements.stampPreviewOverlay.removeAttribute("src");
  elements.stampPreviewOverlay.dataset.requestKey = "";
  elements.stampPreviewFrame.classList.remove("is-refreshing", "is-dragging");
}

function scheduleStampOverlayPreview() {
  if (!dateStampPhoto || !elements.dateStampDialog.open || draggingStamp) return;
  const options = new URLSearchParams({
    date: elements.dateStampDate.value || elements.entryDate.value,
    x: stampLayout.x,
    y: stampLayout.y,
    size: elements.stampSize.value,
    opacity: elements.stampOpacity.value,
    color: stampLayout.color
  });
  const url = "/api/photos/" + encodeURIComponent(dateStampPhoto.id) + "/stamp-preview?" + options.toString();
  const requestKey = url;
  if (requestKey === stampOverlayKey && elements.stampPreviewOverlay.dataset.requestKey === requestKey) {
    clearTimeout(stampOverlayTimer);
    stampOverlayTimer = null;
    stampOverlayPendingKey = "";
    elements.stampPreviewFrame.classList.remove("is-refreshing");
    return;
  }
  if (requestKey === stampOverlayPendingKey) return;
  clearTimeout(stampOverlayTimer);
  stampOverlayPendingKey = requestKey;
  elements.stampPreviewFrame.classList.add("is-refreshing");
  stampOverlayTimer = window.setTimeout(() => {
    stampOverlayTimer = null;
    if (stampOverlayPendingKey !== requestKey) return;
    elements.stampPreviewOverlay.onload = () => {
      if (stampOverlayPendingKey !== requestKey) return;
      stampOverlayKey = requestKey;
      stampOverlayPendingKey = "";
      elements.stampPreviewFrame.classList.remove("is-refreshing");
    };
    elements.stampPreviewOverlay.onerror = () => {
      if (stampOverlayPendingKey !== requestKey) return;
      stampOverlayPendingKey = "";
      elements.stampPreviewFrame.classList.add("is-refreshing");
    };
    elements.stampPreviewOverlay.dataset.requestKey = requestKey;
    elements.stampPreviewOverlay.src = url;
  }, 100);
}

function updateStampPreview() {
  const formatPosition = (value) => {
    const position = Number(value);
    return (Number.isInteger(position) ? String(position) : position.toFixed(1)) + "%";
  };
  elements.stampXValue.textContent = formatPosition(stampLayout.x);
  elements.stampYValue.textContent = formatPosition(stampLayout.y);
  elements.stampSizeValue.textContent = elements.stampSize.value + "%";
  elements.stampOpacityValue.textContent = elements.stampOpacity.value + "%";
  elements.stampColorValue.textContent = stampLayout.color.toUpperCase();
  const zoom = Number(elements.stampZoom.value);
  elements.stampZoomValue.textContent = (zoom === 100 ? t("Pas layar") + " · " : "") + zoom + "%";
  syncStampPixelFields();
  elements.stampPreviewLabel.textContent = stampDateText(elements.dateStampDate.value || elements.entryDate.value);
  elements.stampPreviewLabel.style.opacity = String(stampLayout.opacity / 100);
  elements.stampPreviewLabel.style.color = stampLayout.color;
  const frame = elements.stampPreviewFrame.getBoundingClientRect();
  const image = elements.stampPreviewImage.getBoundingClientRect();
  if (!image.width || !image.height) return;
  const fontSize = Math.max(8, Math.min(image.width, image.height) * stampLayout.size / 100);
  elements.stampPreviewLabel.style.fontSize = fontSize + "px";
  const label = elements.stampPreviewLabel.getBoundingClientRect();
  const margin = Math.max(3, fontSize * 0.18);
  const centerX = Math.max(label.width / 2 + margin, Math.min(frame.width - label.width / 2 - margin, frame.width * stampLayout.x / 100));
  const centerY = Math.max(label.height / 2 + margin, Math.min(frame.height - label.height / 2 - margin, frame.height * stampLayout.y / 100));
  elements.stampPreviewLabel.style.left = centerX + "px";
  elements.stampPreviewLabel.style.top = centerY + "px";
  scheduleStampOverlayPreview();
}

function syncStampPixelFields() {
  if (!stampDimensions) return;
  for (const [axis, input, dimension] of [
    ["x", elements.stampXPx, stampDimensions.width],
    ["y", elements.stampYPx, stampDimensions.height]
  ]) {
    input.max = String(dimension);
    if (document.activeElement !== input) input.value = String(Math.round(stampLayout[axis] * dimension / 100));
  }
}

function fitStampPreview() {
  const image = elements.stampPreviewImage;
  const viewport = elements.stampPreviewViewport;
  if (!image.naturalWidth || !image.naturalHeight || !viewport.clientWidth || !viewport.clientHeight) return;
  const fit = Math.min(viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight, 1);
  const scale = fit * Number(elements.stampZoom.value) / 100;
  image.style.width = Math.max(1, image.naturalWidth * scale) + "px";
  image.style.height = Math.max(1, image.naturalHeight * scale) + "px";
  updateStampPreview();
}

function setStampPositionAtPointer(event, persist = true) {
  const image = elements.stampPreviewImage.getBoundingClientRect();
  if (!image.width || !image.height) return;
  const x = Math.min(100, Math.max(0, (event.clientX - image.left) / image.width * 100));
  const y = Math.min(100, Math.max(0, (event.clientY - image.top) / image.height * 100));
  stampLayout.x = x;
  stampLayout.y = y;
  elements.stampX.value = String(x);
  elements.stampY.value = String(y);
  if (persist) saveStampLayout();
  updateStampPreview();
}

function setStampPositionFromPixels(axis, input) {
  if (!stampDimensions || input.value === "") return;
  const dimension = axis === "x" ? stampDimensions.width : stampDimensions.height;
  const pixels = Number(input.value);
  if (!Number.isFinite(pixels)) return;
  const percentage = Math.min(100, Math.max(0, pixels / dimension * 100));
  stampLayout[axis] = percentage;
  elements[axis === "x" ? "stampX" : "stampY"].value = String(percentage);
  saveStampLayout();
  updateStampPreview();
}

function setStampColorPicking(active) {
  const wasPicking = pickingStampColor;
  pickingStampColor = Boolean(active);
  if (wasPicking && !pickingStampColor) saveStampLayout();
  elements.stampPickColor.setAttribute("aria-pressed", String(pickingStampColor));
  elements.stampPreviewFrame.classList.toggle("is-picking", pickingStampColor);
  elements.stampColorHelp.textContent = t(pickingStampColor
    ? "Pipet aktif. Tahan lalu geser di foto; stamp dan warna mengikuti."
    : "Pilih warna di atas atau aktifkan pipet untuk menggeser stamp sambil mencuplik warna.");
}

function setStampColor(color, persist = true) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  stampLayout.color = color.toLowerCase();
  elements.stampColor.value = stampLayout.color;
  if (persist) saveStampLayout();
  updateStampPreview();
}

function sampleStampColor(event, persist = false) {
  const image = elements.stampPreviewImage;
  const rect = image.getBoundingClientRect();
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) return;
  try {
    const source = image.currentSrc || image.src;
    if (!stampSampleCanvas || stampSampleSource !== source || stampSampleCanvas.width !== image.naturalWidth || stampSampleCanvas.height !== image.naturalHeight) {
      stampSampleCanvas = document.createElement("canvas");
      stampSampleCanvas.width = image.naturalWidth;
      stampSampleCanvas.height = image.naturalHeight;
      stampSampleCanvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
      stampSampleSource = source;
    }
    const context = stampSampleCanvas.getContext("2d", { willReadFrequently: true });
    const x = Math.max(0, Math.min(stampSampleCanvas.width - 1, Math.floor((event.clientX - rect.left) / rect.width * stampSampleCanvas.width)));
    const y = Math.max(0, Math.min(stampSampleCanvas.height - 1, Math.floor((event.clientY - rect.top) / rect.height * stampSampleCanvas.height)));
    const [red, green, blue] = context.getImageData(x, y, 1, 1).data;
    const hex = "#" + [red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("");
    if (hex !== stampLayout.color) setStampColor(hex, persist);
  } catch {
    elements.stampColorHelp.textContent = t("Warna tidak bisa diambil dari titik ini. Pilih warna manual.");
  }
}

let draggingStamp = false;
function setStampPositionFromPointer(event) {
  if (!draggingStamp) return;
  setStampPositionAtPointer(event, false);
  if (pickingStampColor) sampleStampColor(event);
}

function finishStampPointerDrag() {
  if (!draggingStamp) return;
  draggingStamp = false;
  saveStampLayout();
  elements.stampPreviewFrame.classList.remove("is-dragging");
  updateStampPreview();
}

function addDays(dateValue, amount) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

function weekNumber(dateValue) {
  if (!state || !state.weekStartDate) return null;
  const date = Date.parse(dateValue + "T00:00:00Z");
  const start = Date.parse(state.weekStartDate + "T00:00:00Z");
  return Math.floor((date - start) / 604800000) + 1;
}

function formatDate(dateValue, options = { day: "numeric", month: "long", year: "numeric" }) {
  const [year, month, day] = dateValue.split("-").map(Number);
  return new Intl.DateTimeFormat(I18n.locale, { ...options, timeZone: "Asia/Jakarta" })
    .format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function weekTitle(dateValue) {
  const week = weekNumber(dateValue);
  return week ? "Week " + week + " - " + formatDate(dateValue) : t("Atur tanggal awal Week 1");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      ...(authState.csrfToken && options.method && options.method !== "GET" ? { "x-csrf-token": authState.csrfToken } : {}),
      ...(options.body && typeof options.body === "string" ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) {
    if (body && body.code === "login_required") showLogin();
    const error = new Error(t(body && body.error ? body.error : "Permintaan tidak berhasil."));
    error.code = body && body.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function showToast(message, kind = "success") {
  elements.toast.textContent = t(message);
  elements.toast.dataset.kind = kind;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3800);
}

function safeText(element, value) {
  element.textContent = value == null ? "" : String(value);
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.textContent = label || t("Memproses…");
    button.disabled = true;
  } else {
    button.textContent = t(button.dataset.originalLabel || button.textContent);
    button.disabled = false;
    delete button.dataset.originalLabel;
  }
}

async function setDate(dateValue) {
  if (uploading) return;
  if ((noteDirty || captionDirty || equipmentDirty) && !await askConfirmation(
    t("Perubahan catatan, keterangan foto, atau jam alat belum disimpan. Pindah tanggal akan meninggalkan perubahan ini."),
    t("Pindah tanggal?"), t("Pindah tanggal")
  )) return;
  if (state && state.weekStartDate && dateValue < state.weekStartDate) dateValue = state.weekStartDate;
  elements.entryDate.value = dateValue;
  renderWeekLabel();
  loadDay().catch((error) => showToast(error.message, "error"));
}

function renderWeekLabel() {
  safeText(elements.weekLabel, state && state.weekStartDate ? weekTitle(elements.entryDate.value) : t("Atur tanggal awal Week 1"));
  const date = elements.entryDate.value || dateParts();
  $("#date-number").textContent = date.slice(8);
  $("#date-month").textContent = formatDate(date, { month: "long", year: "numeric" });
  $("#date-weekday").textContent = formatDate(date, { weekday: "long" }) + " · WIB";
}

async function loadState() {
  state = await api("/api/state");
  safeText(elements.projectTitle, state.projectName || "Sitebook");
  safeText($("#project-short-title"), state.projectName || "Sitebook");
  elements.entryDate.value = state.weekStartDate && state.today < state.weekStartDate ? state.weekStartDate : state.today;
  elements.entryDate.disabled = !state.weekStartDate;
  elements.entryDate.min = state.weekStartDate || "";
  elements.setupNotice.hidden = Boolean(state.weekStartDate);
  renderProjectLabels();
  elements.weekStart.disabled = state.hasEntries;
  $("#discord-dot").dataset.connected = String(state.discordConfigured);
  elements.archiveMonth.value = state.today.slice(0, 7);
  renderWeekLabel();
  updateEntryControls();
  await loadDay();
  if (!state.weekStartDate) await loadArchive(state.today.slice(0, 7));
}

function renderProjectLabels() {
  if (!state) return;
  elements.weekStartHelp.textContent = state.hasEntries
    ? t("Tanggal awal sudah terkunci karena arsip harian telah dibuat.")
    : t("Tanggal ini wajib diatur sebelum catatan pertama disimpan. Week berjalan tujuh hari kalender dari tanggal tersebut.");
  elements.discordSummary.textContent = state.discordConfigured
    ? t("Webhook tersimpan. Foto baru akan masuk otomatis ke forum.")
    : t("Hubungkan webhook forum untuk mengirim foto otomatis.");
  elements.webhookStatus.textContent = state.discordConfigured ? t("Webhook tersimpan (URL disamarkan)") : t("Belum terhubung");
  elements.connection.textContent = t("Arsip lokal terhubung");
}

function updateEntryControls() {
  const ready = Boolean(state && state.weekStartDate);
  const mediaUploading = uploading || uploadingVideos;
  document.querySelectorAll("[data-language]").forEach((button) => { button.disabled = mediaUploading; });
  $("#logout").disabled = mediaUploading;
  $("#previous-day").disabled = mediaUploading || !ready || elements.entryDate.value <= state.weekStartDate;
  $("#next-day").disabled = mediaUploading || !ready;
  elements.entryDate.disabled = mediaUploading || !ready;
  elements.photoInput.disabled = mediaUploading || !ready;
  elements.videoInput.disabled = mediaUploading || !ready;
  $("#choose-photos").disabled = mediaUploading || (!ready && authState.user && authState.user.role !== "admin");
  $("#choose-photos").textContent = !ready ? t("Atur tanggal awal") : uploading ? t("Mengunggah…") : t("+ Tambah foto");
  $("#choose-videos").disabled = mediaUploading || (!ready && authState.user && authState.user.role !== "admin");
  $("#choose-videos").textContent = !ready ? t("Atur tanggal awal") : uploadingVideos ? t("Mengunggah video…") : t("+ Tambah video");
  elements.saveNote.disabled = !ready || !currentDay || currentDay.deleted || !noteDirty;
  elements.dayNote.disabled = !ready || !currentDay || currentDay.deleted;
  elements.addEquipmentDowntime.disabled = !ready || !currentDay || currentDay.deleted || equipmentSaving;
  elements.saveEquipmentDowntime.disabled = !ready || !currentDay || currentDay.deleted || !equipmentDirty || equipmentSaving;
  const admin = Boolean(authState.user && authState.user.role === "admin");
  $("#download-day-photos").hidden = !currentDay || currentDay.photos.length === 0;
  $("#download-day-dated-photos").hidden = !admin || !currentDay || currentDay.photos.length === 0;
  $("#download-period-dated-photos").hidden = !admin;
  $("#delete-day").hidden = !authState.user || authState.user.role !== "admin" || !currentDay || !currentDay.photos.length;
  if (!ready) {
    elements.photoCount.textContent = t("Atur tanggal awal sebelum mengunggah foto.");
  }
}

async function loadDay() {
  const entryDate = elements.entryDate.value;
  activeDate = entryDate;
  const request = ++dayRequest;
  if (!entryDate || !state || !state.weekStartDate) {
    currentDay = null;
    equipmentDraft = [];
    equipmentDirty = false;
    renderDay();
    return;
  }
  try {
    elements.photoGrid.setAttribute("aria-busy", "true");
    elements.photoGrid.replaceChildren(galleryState(t("Memuat dokumentasi…"), t("Menyiapkan foto untuk tanggal yang dipilih.")));
    elements.videoGrid.setAttribute("aria-busy", "true");
    elements.videoGrid.replaceChildren();
    const day = await api("/api/days/" + encodeURIComponent(entryDate));
    if (request !== dayRequest) return;
    currentDay = day;
    noteDirty = false;
    captionDirty = false;
    equipmentDirty = false;
    equipmentDraft = Array.isArray(day.equipmentLog) ? day.equipmentLog.map((item) => ({
      equipment: item.equipment,
      hours: Array.isArray(item.hours) ? [...item.hours] : [],
      offIntervals: Array.isArray(item.offIntervals) ? item.offIntervals.map((interval) => ({ ...interval })) : [],
      note: item.note || ""
    })) : [];
    captionDrafts.clear();
    renderWeekLabel();
    renderDay();
    await loadArchive(entryDate.slice(0, 7));
    updateEntryControls();
  } catch (error) {
    if (request !== dayRequest) return;
    currentDay = null;
    renderDay();
    elements.photoGrid.replaceChildren(galleryState(t("Dokumentasi belum bisa dimuat"), error.message, true));
    elements.videoGrid.replaceChildren();
    showToast(error.message, "error");
  } finally {
    if (request === dayRequest) {
      elements.photoGrid.setAttribute("aria-busy", "false");
      elements.videoGrid.setAttribute("aria-busy", "false");
    }
  }
}

function statusLabel(day) {
  if (!state || !state.discordConfigured) return ["waiting_config", t("Menunggu pengaturan Discord")];
  const labels = {
    pending: ["pending", t("Menunggu kirim")],
    waiting_config: ["waiting_config", t("Menunggu pengaturan Discord")],
    syncing: ["syncing", t("Mengirim ke Discord…")],
    sent: ["sent", t("Tersalin ke Discord")],
    failed: ["failed", t("Perlu dicoba lagi")],
    uncertain: ["uncertain", t("Periksa Discord sebelum mengulang")]
  };
  return labels[day.syncStatus] || ["pending", t("Menunggu kirim")];
}

function renderDay() {
  elements.photoGrid.replaceChildren();
  const photos = currentDay && currentDay.photos ? currentDay.photos : [];
  const videos = currentDay && currentDay.videos ? currentDay.videos : [];
  if (currentDay && currentDay.deleted) {
    noteDirty = false;
    equipmentDirty = false;
    equipmentDraft = [];
  }
  $("#photo-total").textContent = String(photos.length);
  $("#upload-title").textContent = photos.length ? t("Ada dokumentasi tambahan?") : t("Dokumentasikan hari ini");
  elements.photoCount.textContent = photos.length
    ? I18n.count("{count} foto tersimpan untuk {date}.", photos.length, { date: formatDate(elements.entryDate.value, { day: "numeric", month: "long" }) })
    : t("Setiap foto jadi bagian dari cerita pekerjaan hari ini.");
  if (currentDay) {
    if (!noteDirty) elements.dayNote.value = currentDay.note || "";
    if (photos.length || currentDay.deleted || (currentDay.equipmentLog && currentDay.equipmentLog.length)) {
      const [status, label] = statusLabel(currentDay);
      elements.syncState.dataset.state = status;
      elements.syncState.textContent = label;
      elements.syncState.hidden = false;
      elements.discordSummary.textContent = t(currentDay.syncError || label);
      elements.retrySync.hidden = !["failed", "uncertain"].includes(currentDay.syncStatus);
      if (currentDay.syncStatus === "uncertain") elements.retrySync.textContent = t("Periksa lalu coba kirim");
      else elements.retrySync.textContent = t("Coba kirim lagi");
    } else {
      elements.syncState.hidden = true;
      elements.retrySync.hidden = true;
      elements.discordSummary.textContent = state && state.discordConfigured
        ? t("Forum terhubung. Foto baru akan disalin otomatis.")
        : t("Hubungkan forum untuk menyalin dokumentasi otomatis.");
    }
  } else {
    elements.dayNote.value = "";
    noteDirty = false;
    elements.syncState.hidden = true;
    elements.retrySync.hidden = true;
    elements.discordSummary.textContent = state && state.discordConfigured
      ? t("Forum terhubung. Foto baru akan disalin otomatis.")
      : t("Hubungkan forum untuk menyalin dokumentasi otomatis.");
  }
  renderNoteCounter();
  renderEquipmentLog();
  if (!noteDirty) elements.noteStatus.textContent = currentDay && currentDay.deleted
    ? t("Dokumentasi tanggal ini dipindahkan ke sampah.")
    : currentDay && currentDay.note ? t("Ringkasan tersimpan.") : t("Tulis ringkasan untuk tanggal ini. Foto bisa ditambahkan nanti.");
  for (const [index, photo] of photos.entries()) elements.photoGrid.append(makePhotoCard(photo, index));
  renderVideoLog(videos);
  if (!photos.length) {
    elements.photoGrid.append(galleryState(
      currentDay && currentDay.deleted ? t("Dokumentasi ada di sampah") : state && state.weekStartDate ? t("Belum ada foto hari ini") : t("Dokumentasi pertama dimulai di sini"),
      currentDay && currentDay.deleted ? t("Admin bisa memulihkannya lewat Sampah, atau tambahkan foto baru untuk tanggal ini.") : state && state.weekStartDate ? t("Foto bisa ditambahkan kapan saja untuk tanggal ini.") : t("Tentukan awal Week 1, lalu unggah foto pertama proyek.")
    ));
  }
  updateEntryControls();
}

function renderEquipmentLog() {
  elements.equipmentList.replaceChildren();
  if (!equipmentDraft.length) {
    const empty = document.createElement("p");
    empty.className = "equipment-empty";
    empty.textContent = t("Belum ada jam alat yang dicatat.");
    elements.equipmentList.append(empty);
  }
  equipmentDraft.forEach((item, index) => {
    if (!Array.isArray(item.offIntervals)) item.offIntervals = [];
    const row = document.createElement("div");
    row.className = "equipment-row";
    const head = document.createElement("div");
    head.className = "equipment-row-head";
    const name = document.createElement("label");
    name.className = "equipment-field equipment-name";
    const nameLabel = document.createElement("span");
    nameLabel.textContent = t("Nama alat");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.equipment || "";
    nameInput.placeholder = t("Contoh: Excavator");
    nameInput.maxLength = 80;
    nameInput.disabled = Boolean(!state || !state.weekStartDate || !currentDay || currentDay.deleted || equipmentSaving);
    nameInput.addEventListener("input", () => {
      equipmentDraft[index].equipment = nameInput.value;
      equipmentDirty = true;
      updateEquipmentStatus();
      updateEntryControls();
    });
    name.append(nameLabel, nameInput);
    head.append(name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-quiet equipment-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", t("Hapus alat"));
    remove.disabled = Boolean(equipmentSaving || !currentDay || currentDay.deleted);
    remove.addEventListener("click", () => {
      equipmentDraft.splice(index, 1);
      equipmentDirty = true;
      renderEquipmentLog();
    });
    head.append(remove);
    row.append(head);

    const hoursLabel = document.createElement("span");
    hoursLabel.className = "equipment-hours-label";
    hoursLabel.textContent = t("Jam kerja");
    row.append(hoursLabel);
    const hours = document.createElement("div");
    hours.className = "equipment-hours";
    for (const hour of equipmentHours) {
      const start = hour.slice(0, 2);
      const end = String(Number(start) + 1).padStart(2, "0");
      const selected = item.hours.includes(hour);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "equipment-hour" + (selected ? " is-selected" : "");
      button.textContent = start + "-" + end;
      button.setAttribute("aria-pressed", String(selected));
      button.setAttribute("aria-label", t(selected ? "Hapus pilihan jam {start} sampai {end}" : "Tandai jam {start} sampai {end} sebagai jam kerja", { start, end }));
      button.disabled = Boolean(!state || !state.weekStartDate || !currentDay || currentDay.deleted || equipmentSaving);
      button.addEventListener("click", () => {
        const currentHours = equipmentDraft[index].hours;
        const nextSelected = !currentHours.includes(hour);
        equipmentDraft[index].hours = nextSelected
          ? [...currentHours, hour].sort((left, right) => equipmentHours.indexOf(left) - equipmentHours.indexOf(right))
          : currentHours.filter((value) => value !== hour);
        button.classList.toggle("is-selected", nextSelected);
        button.setAttribute("aria-pressed", String(nextSelected));
        button.setAttribute("aria-label", t(nextSelected ? "Hapus pilihan jam {start} sampai {end}" : "Tandai jam {start} sampai {end} sebagai jam kerja", { start, end }));
        row.querySelector(".equipment-row-total").textContent = equipmentTotalLabel(equipmentDraft[index]);
        equipmentDirty = true;
        updateEquipmentStatus();
        updateEntryControls();
      });
      hours.append(button);
    }
    row.append(hours);

    const offSection = document.createElement("div");
    offSection.className = "equipment-off-section";
    const offHeading = document.createElement("div");
    offHeading.className = "equipment-off-heading";
    const offLabel = document.createElement("span");
    offLabel.className = "equipment-hours-label";
    offLabel.textContent = t("Jam OFF");
    const offHelp = document.createElement("p");
    offHelp.className = "equipment-off-help";
    offHelp.textContent = t("Masukkan waktu 24 jam, misalnya 10:40.");
    const addOff = document.createElement("button");
    addOff.type = "button";
    addOff.className = "button button-quiet equipment-add-off";
    addOff.textContent = t("Tambah waktu OFF");
    addOff.disabled = Boolean(!state || !state.weekStartDate || !currentDay || currentDay.deleted || equipmentSaving ||
      (item.offIntervals || []).length >= EquipmentHours.MAX_OFF_INTERVALS);
    addOff.setAttribute("aria-label", t("Tambah waktu OFF untuk {equipment}", { equipment: item.equipment || t("alat ini") }));
    addOff.addEventListener("click", () => {
      equipmentDraft[index].offIntervals = Array.isArray(equipmentDraft[index].offIntervals)
        ? equipmentDraft[index].offIntervals : [];
      equipmentDraft[index].offIntervals.push({ startTime: "", endTime: "" });
      equipmentDirty = true;
      renderEquipmentLog();
      elements.equipmentList.querySelector('[data-off-start="' + index + '-' + (equipmentDraft[index].offIntervals.length - 1) + '"]')?.focus();
    });
    offHeading.append(offLabel, addOff);
    offSection.append(offHeading, offHelp);
    const offList = document.createElement("div");
    offList.className = "equipment-off-list";
    const offError = document.createElement("p");
    offError.className = "equipment-off-error";
    offError.setAttribute("role", "alert");
    (item.offIntervals || []).forEach((interval, intervalIndex) => {
      const intervalRow = document.createElement("div");
      intervalRow.className = "equipment-off-row";
      const startLabel = document.createElement("label");
      startLabel.className = "equipment-field";
      const startCaption = document.createElement("span");
      startCaption.textContent = t("Mulai OFF");
      const startInput = document.createElement("input");
      startInput.type = "text";
      startInput.inputMode = "text";
      startInput.autocomplete = "off";
      startInput.maxLength = 5;
      startInput.pattern = "(?:[01]\\d|2[0-3]):[0-5]\\d";
      startInput.placeholder = "HH:MM";
      startInput.className = "equipment-off-time";
      startInput.value = interval.startTime || "";
      startInput.dataset.offStart = index + "-" + intervalIndex;
      startInput.disabled = Boolean(!state || !state.weekStartDate || !currentDay || currentDay.deleted || equipmentSaving);
      startLabel.append(startCaption, startInput);
      const endLabel = document.createElement("label");
      endLabel.className = "equipment-field";
      const endCaption = document.createElement("span");
      endCaption.textContent = t("Selesai OFF");
      const endInput = document.createElement("input");
      endInput.type = "text";
      endInput.inputMode = "text";
      endInput.autocomplete = "off";
      endInput.maxLength = 5;
      endInput.pattern = "(?:[01]\\d|2[0-3]):[0-5]\\d";
      endInput.placeholder = "HH:MM";
      endInput.className = "equipment-off-time";
      endInput.value = interval.endTime || "";
      endInput.dataset.offEnd = index + "-" + intervalIndex;
      endInput.disabled = Boolean(!state || !state.weekStartDate || !currentDay || currentDay.deleted || equipmentSaving);
      endLabel.append(endCaption, endInput);
      const removeOff = document.createElement("button");
      removeOff.type = "button";
      removeOff.className = "button button-quiet equipment-remove equipment-off-remove";
      removeOff.textContent = "×";
      removeOff.setAttribute("aria-label", t("Hapus rentang OFF"));
      removeOff.disabled = Boolean(equipmentSaving || !currentDay || currentDay.deleted);
      removeOff.addEventListener("click", () => {
        equipmentDraft[index].offIntervals.splice(intervalIndex, 1);
        equipmentDirty = true;
        renderEquipmentLog();
      });
      const updateOff = (field, input) => {
        equipmentDraft[index].offIntervals[intervalIndex][field] = input.value;
        equipmentDirty = true;
        const validation = EquipmentHours.normalizeOffIntervals(equipmentDraft[index].offIntervals);
        offError.textContent = offIntervalErrorText(validation.error);
        const invalid = Boolean(validation.error);
        for (const fieldInput of intervalRow.querySelectorAll("input.equipment-off-time")) {
          if (invalid) fieldInput.setAttribute("aria-invalid", "true");
          else fieldInput.removeAttribute("aria-invalid");
        }
        row.querySelector(".equipment-row-total").textContent = equipmentTotalLabel(equipmentDraft[index]);
        updateEquipmentStatus();
        updateEntryControls();
      };
      startInput.addEventListener("input", () => updateOff("startTime", startInput));
      startInput.addEventListener("change", () => updateOff("startTime", startInput));
      endInput.addEventListener("input", () => updateOff("endTime", endInput));
      endInput.addEventListener("change", () => updateOff("endTime", endInput));
      intervalRow.append(startLabel, endLabel, removeOff);
      offList.append(intervalRow);
    });
    offSection.append(offList, offError);
    row.append(offSection);

    const footer = document.createElement("div");
    footer.className = "equipment-row-footer";
    const note = document.createElement("label");
    note.className = "equipment-field equipment-note";
    const noteLabel = document.createElement("span");
    noteLabel.textContent = t("Catatan alat (opsional)");
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.value = item.note || "";
    noteInput.placeholder = t("Contoh: perbaikan hidrolik");
    noteInput.maxLength = 180;
    noteInput.disabled = Boolean(!state || !state.weekStartDate || !currentDay || currentDay.deleted || equipmentSaving);
    noteInput.addEventListener("input", () => {
      equipmentDraft[index].note = noteInput.value;
      equipmentDirty = true;
      updateEquipmentStatus();
      updateEntryControls();
    });
    note.append(noteLabel, noteInput);
    const total = document.createElement("span");
    total.className = "equipment-row-total";
    total.textContent = equipmentTotalLabel(item);
    footer.append(note, total);
    row.append(footer);
    elements.equipmentList.append(row);
  });
  updateEquipmentStatus();
  updateEntryControls();
}

function updateEquipmentStatus() {
  elements.equipmentStatus.textContent = equipmentDirty
    ? t("Perubahan jadwal belum disimpan.")
    : equipmentDraft.length ? t("Jadwal tersimpan.") : t("Belum ada jam alat yang dicatat.");
}

async function saveEquipmentLog() {
  if (!equipmentDirty || !currentDay || currentDay.deleted || equipmentSaving) return;
  for (const item of equipmentDraft) {
    const validation = EquipmentHours.normalizeOffIntervals(item.offIntervals || []);
    if (validation.error) {
      showToast(offIntervalErrorText(validation.error), "error");
      return;
    }
  }
  equipmentSaving = true;
  updateEntryControls();
  try {
    currentDay = await api("/api/days/" + encodeURIComponent(elements.entryDate.value) + "/equipment", {
      method: "PUT",
      body: JSON.stringify({ entries: equipmentDraft })
    });
    equipmentDraft = Array.isArray(currentDay.equipmentLog) ? currentDay.equipmentLog.map((item) => ({
      equipment: item.equipment,
      hours: Array.isArray(item.hours) ? [...item.hours] : [],
      offIntervals: Array.isArray(item.offIntervals) ? item.offIntervals.map((interval) => ({ ...interval })) : [],
      note: item.note || ""
    })) : [];
    equipmentDirty = false;
    if (state) state.hasEntries = true;
    renderDay();
    loadArchive(elements.entryDate.value.slice(0, 7)).catch(() => {});
    showToast(t("Jadwal tersimpan."));
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    equipmentSaving = false;
    renderEquipmentLog();
    updateEntryControls();
  }
}

function galleryState(title, description, error = false) {
  const empty = document.createElement("div");
  empty.className = "gallery-empty" + (error ? " is-error" : "");
  empty.setAttribute("role", error ? "alert" : "status");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 60 60");
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add("empty-frame");
  const frame = document.createElementNS("http://www.w3.org/2000/svg", "path");
  frame.setAttribute("d", "M9 11h42v38H9z M9 37l13-13 12 12 7-7 10 11 M37 19a3 3 0 1 0 6 0a3 3 0 1 0-6 0");
  icon.append(frame);
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  empty.append(icon, heading, copy);
  return empty;
}

function makePhotoCard(photo, index) {
  const card = document.createElement("article");
  card.className = "photo-card";
  const image = document.createElement("img");
  image.src = photo.previewUrl;
  image.alt = photo.caption ? t("Dokumentasi lapangan: {caption}", { caption: photo.caption }) : t("Foto dokumentasi lapangan");
  image.loading = "lazy";
  const open = document.createElement("a");
  open.className = "photo-open";
  open.href = photo.originalUrl;
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.setAttribute("aria-label", t("Buka foto asli {index}: {name}", { index: index + 1, name: photo.originalName }));
  const number = document.createElement("span");
  number.className = "photo-index";
  number.textContent = String(index + 1).padStart(2, "0");
  open.append(image, number);

  const details = document.createElement("div");
  details.className = "photo-details";
  const filename = document.createElement("p");
  filename.className = "photo-file";
  filename.textContent = photo.originalName + " · " + formatBytes(photo.sizeBytes);
  const label = document.createElement("label");
  label.className = "caption-label";
  label.textContent = t("Keterangan foto");
  label.htmlFor = "caption-" + photo.id;
  const caption = document.createElement("input");
  caption.type = "text";
  caption.id = label.htmlFor;
  caption.maxLength = 240;
  caption.value = captionDrafts.has(photo.id) ? captionDrafts.get(photo.id) : photo.caption || "";
  caption.placeholder = t("Keterangan foto (opsional)");
  const actions = document.createElement("div");
  actions.className = "photo-caption-actions";
  const sync = document.createElement("span");
  sync.className = "photo-sync";
  sync.textContent = photo.discordSent ? t("Tersalin ke Discord") : t("Menunggu sinkronisasi");
  const save = document.createElement("button");
  save.type = "button";
  save.className = "button button-outline";
  save.textContent = t("Simpan");
  save.disabled = caption.value === (photo.caption || "");
  caption.addEventListener("input", () => {
    if (caption.value.trim() === (photo.caption || "")) captionDrafts.delete(photo.id);
    else captionDrafts.set(photo.id, caption.value);
    captionDirty = captionDrafts.size > 0;
    save.disabled = caption.value.trim() === (photo.caption || "");
  });
  save.addEventListener("click", async () => {
    setBusy(save, true, t("Menyimpan…"));
    try {
      currentDay = await api("/api/photos/" + encodeURIComponent(photo.id), {
        method: "PATCH",
        body: JSON.stringify({ caption: caption.value })
      });
      captionDrafts.delete(photo.id);
      captionDirty = captionDrafts.size > 0;
      renderDay();
      showToast(t("Keterangan foto tersimpan."));
    } catch (error) {
      setBusy(save, false);
      showToast(error.message, "error");
    }
  });
  const stamp = document.createElement("button");
  stamp.type = "button";
  stamp.className = "button button-outline";
  stamp.textContent = t("Tambah tanggal");
  stamp.setAttribute("aria-label", t("Tambah tanggal ke salinan foto {index}", { index: index + 1 }));
  stamp.addEventListener("click", () => openDateStamp(photo));
  const buttons = document.createElement("div");
  buttons.className = "photo-action-buttons";
  buttons.append(save);
  if (authState.user && authState.user.role === "admin") {
    buttons.append(stamp);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-danger-quiet";
    remove.textContent = t("Hapus");
    remove.setAttribute("aria-label", t("Hapus foto {index}", { index: index + 1 }));
    remove.addEventListener("click", () => requestDelete(photo));
    buttons.append(remove);
  }
  actions.append(sync, buttons);
  details.append(filename, label, caption, actions);
  card.append(open, details);
  return card;
}

function renderVideoLog(videos) {
  elements.videoGrid.replaceChildren();
  $("#video-total").textContent = String(videos.length);
  if (!videos.length) {
    const empty = document.createElement("p");
    empty.className = "video-empty";
    empty.textContent = t("Belum ada video untuk tanggal ini.");
    elements.videoGrid.append(empty);
    return;
  }
  videos.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "video-card";
    const player = document.createElement("video");
    player.controls = true;
    player.preload = "metadata";
    player.playsInline = true;
    player.setAttribute("aria-label", t("Video dokumentasi {index}: {name}", { index: index + 1, name: item.originalName }));
    const playbackError = document.createElement("p");
    playbackError.className = "video-playback-error";
    playbackError.hidden = true;
    player.addEventListener("error", () => {
      playbackError.hidden = false;
      playbackError.textContent = t("Browser tidak bisa memutar format video ini. Ekspor sebagai MP4 H.264, lalu unggah ulang.");
    });
    if (item.available === false) {
      player.hidden = true;
      playbackError.hidden = false;
      playbackError.textContent = t("Berkas video tidak ada di arsip. Unggah ulang berkas aslinya, lalu hapus entri ini.");
    } else {
      player.src = item.streamUrl;
    }
    const details = document.createElement("div");
    details.className = "video-details";
    const filename = document.createElement("p");
    filename.className = "photo-file";
    filename.textContent = item.originalName;
    const size = document.createElement("span");
    size.textContent = formatBytes(item.sizeBytes);
    details.append(filename, size);
    if (authState.user && authState.user.role === "admin") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-danger-quiet";
      remove.textContent = t("Hapus");
      remove.setAttribute("aria-label", t("Hapus video {name}", { name: item.originalName }));
      remove.addEventListener("click", () => requestDeleteVideo(item));
      details.append(remove);
    }
    card.append(player, playbackError, details);
    elements.videoGrid.append(card);
  });
}

function openDateStamp(photo) {
  clearStampOverlayPreview();
  dateStampPhoto = photo;
  stampDimensions = null;
  setStampColorPicking(false);
  elements.dateStampDate.value = currentDay && currentDay.date ? currentDay.date : elements.entryDate.value;
  elements.stampX.value = String(stampLayout.x);
  elements.stampY.value = String(stampLayout.y);
  elements.stampSize.value = String(stampLayout.size);
  elements.stampOpacity.value = String(stampLayout.opacity);
  elements.stampColor.value = stampLayout.color;
  elements.stampZoom.value = "100";
  elements.stampXPx.disabled = true;
  elements.stampYPx.disabled = true;
  elements.stampXPx.value = "";
  elements.stampYPx.value = "";
  elements.stampSourceSize.textContent = t("Memuat ukuran foto asli…");
  elements.dateStampPhoto.textContent = t("Foto: {name}", { name: photo.originalName });
  elements.dateStampFeedback.textContent = "";
  elements.stampPreviewImage.onload = fitStampPreview;
  elements.stampPreviewImage.src = photo.previewUrl;
  elements.dateStampDialog.showModal();
  requestAnimationFrame(fitStampPreview);
  elements.dateStampDate.focus();
  api("/api/photos/" + encodeURIComponent(photo.id) + "/stamp-metadata").then((dimensions) => {
    if (dateStampPhoto?.id !== photo.id) return;
    stampDimensions = dimensions;
    elements.stampXPx.disabled = false;
    elements.stampYPx.disabled = false;
    elements.stampSourceSize.textContent = t("Ukuran foto asli {width} × {height} piksel.", dimensions);
    syncStampPixelFields();
  }).catch(() => {
    if (dateStampPhoto?.id !== photo.id) return;
    elements.stampSourceSize.textContent = t("Ukuran foto tidak tersedia. Geser slider untuk mengatur posisi.");
  });
}

async function downloadDatedPhoto(event) {
  event.preventDefault();
  if (!dateStampPhoto || !elements.dateStampDate.value) return;
  const button = $("#download-dated-photo");
  setBusy(button, true, t("Membuat salinan…"));
  elements.dateStampFeedback.textContent = "";
  try {
    const date = elements.dateStampDate.value;
    const photo = dateStampPhoto;
    saveStampLayout();
    const options = new URLSearchParams({ date, x: stampLayout.x, y: stampLayout.y, size: stampLayout.size, opacity: stampLayout.opacity, color: stampLayout.color });
    const blob = await api("/api/photos/" + encodeURIComponent(photo.id) + "/dated?" + options.toString());
    const stem = photo.originalName.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "foto";
    downloadBlob(blob, "Sitebook-" + date + "-" + stem + "-dated.jpg");
    elements.dateStampDialog.close();
    showToast(t("Unduhan salinan foto dimulai."));
  } catch (error) {
    elements.dateStampFeedback.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

function formatBytes(value) {
  if (!Number(value)) return "";
  if (value < 1024 * 1024) return Math.round(value / 1024) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

async function loadArchive(month) {
  elements.archiveMonth.value = month;
  const loading = document.createElement("p");
  loading.className = "empty-copy";
  loading.textContent = t("Memuat arsip…");
  elements.archiveList.replaceChildren(loading);
  let result;
  try {
    result = await api("/api/days?month=" + encodeURIComponent(month));
  } catch (error) {
    loading.textContent = t("Arsip belum bisa dimuat. Pilih bulan untuk mencoba lagi.");
    throw error;
  }
  archiveDays = result.days;
  renderArchive();
}

function renderArchive() {
  const days = archiveDays;
  $("#archive-total").textContent = days.length ? I18n.count("{count} hari", days.length) : "";
  elements.archiveList.replaceChildren();
  if (!days.length) {
    const empty = document.createElement("p");
    empty.className = "empty-copy";
    empty.textContent = t("Belum ada dokumentasi pada bulan ini.");
    elements.archiveList.append(empty);
    return;
  }
  for (const day of days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "archive-item";
    button.setAttribute("aria-current", day.date === elements.entryDate.value ? "date" : "false");
    const dateLabel = document.createElement("span");
    dateLabel.className = "archive-date";
    dateLabel.textContent = formatDate(day.date, { weekday: "short", day: "numeric", month: "short" });
    const meta = document.createElement("span");
    meta.className = "archive-meta";
    meta.textContent = weekTitle(day.date);
    const count = document.createElement("span");
    count.className = "archive-count";
    const mediaCounts = [];
    if (day.photos.length) mediaCounts.push(I18n.count("{count} foto", day.photos.length));
    if (day.videos && day.videos.length) mediaCounts.push(I18n.count("{count} video", day.videos.length));
    count.textContent = mediaCounts.join(" · ") ||
      (day.equipmentLog && day.equipmentLog.length ? t("Jadwal alat") : t("Ringkasan"));
    button.append(dateLabel, count, meta);
    if (day.note) {
      const summary = document.createElement("span");
      summary.className = "archive-summary";
      summary.textContent = day.note.split(/\r?\n/, 1)[0];
      summary.title = day.note;
      button.append(summary);
    }
    if (day.equipmentLog && day.equipmentLog.length) {
      const equipment = document.createElement("span");
      equipment.className = "archive-summary";
      equipment.textContent = day.equipmentLog.map((entry) => entry.equipment + " " + equipmentTotalLabel(entry)).join(", ");
      equipment.title = equipment.textContent;
      button.append(equipment);
    }
    button.addEventListener("click", () => {
      setDate(day.date);
      if (window.matchMedia("(max-width: 900px)").matches) $("#daily-log").scrollIntoView({ behavior: "smooth" });
    });
    elements.archiveList.append(button);
  }
}

async function openSettings() {
  if (!authState.user || authState.user.role !== "admin") return;
  elements.projectName.value = state ? state.projectName : "Sitebook";
  elements.weekStart.value = state && state.weekStartDate ? state.weekStartDate : "";
  elements.weekStart.disabled = Boolean(state && state.hasEntries);
  elements.webhookUrl.disabled = false;
  elements.webhookUrl.readOnly = false;
  elements.webhookUrl.type = "password";
  elements.webhookUrl.value = "";
  $("#copy-webhook").hidden = true;
  elements.webhookUrl.title = state && state.hasDiscordPosts
    ? t("Thread Discord yang sudah dibuat hanya bisa diedit memakai webhook asal.")
    : "";
  elements.webhookUrl.placeholder = state && state.hasDiscordPosts
    ? t("Webhook asal dikunci agar thread lama tetap bisa diedit")
    : state && state.discordConfigured
      ? t("Webhook tersimpan; kosongkan untuk tetap memakai")
      : t("URL webhook disimpan privat di komputer ini");
  elements.webhookStatus.textContent = state && state.discordConfigured ? t("Webhook tersimpan (URL disamarkan)") : t("Belum terhubung");
  elements.settingsFeedback.textContent = "";
  elements.settingsDialog.showModal();
  if (!state || !state.discordConfigured) return;
  try {
    const savedWebhook = await api("/api/discord/webhook");
    if (!elements.settingsDialog.open || !authState.user || authState.user.role !== "admin") return;
    elements.webhookUrl.type = "text";
    elements.webhookUrl.value = savedWebhook.configured ? savedWebhook.webhookUrl : "";
    elements.webhookUrl.readOnly = Boolean(state.hasDiscordPosts && savedWebhook.configured);
    $("#copy-webhook").hidden = !savedWebhook.configured;
    elements.webhookStatus.textContent = savedWebhook.configured ? t("Webhook tersimpan (URL tampil untuk admin)") : t("Belum terhubung");
  } catch (error) {
    elements.settingsFeedback.textContent = error.message;
    elements.settingsFeedback.style.color = "#a3342c";
  }
}

function clearWebhookField() {
  elements.webhookUrl.value = "";
  elements.webhookUrl.type = "password";
  elements.webhookUrl.readOnly = false;
  elements.webhookUrl.title = "";
  $("#copy-webhook").hidden = true;
}

async function copyWebhook() {
  const value = elements.webhookUrl.value;
  if (!value || !authState.user || authState.user.role !== "admin") return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      elements.webhookUrl.focus();
      elements.webhookUrl.select();
      if (!document.execCommand("copy")) throw new Error("copy_failed");
      elements.webhookUrl.setSelectionRange(0, 0);
    }
    elements.settingsFeedback.textContent = t("URL webhook disalin.");
    elements.settingsFeedback.style.color = "#315a4a";
  } catch {
    elements.settingsFeedback.textContent = t("Pilih dan salin URL webhook secara manual.");
    elements.settingsFeedback.style.color = "#a3342c";
  }
}

function daysToWeek(week) {
  const start = addDays(state.weekStartDate, (week - 1) * 7);
  return [start, addDays(start, 6)];
}

function buildReportWeeks() {
  if (!state || !state.weekStartDate) return;
  const todayWeek = Math.max(1, weekNumber(state.today));
  const selectedWeek = Math.max(1, weekNumber(elements.entryDate.value));
  const maxWeek = Math.max(todayWeek, selectedWeek);
  elements.reportWeek.replaceChildren();
  for (let week = 1; week <= Math.min(maxWeek, 520); week++) {
    const [from, to] = daysToWeek(week);
    const option = document.createElement("option");
    option.value = String(week);
    option.textContent = t("Week {week} · {from} sampai {to}", { week, from: formatDate(from, { day: "numeric", month: "short" }), to: formatDate(to, { day: "numeric", month: "long", year: "numeric" }) });
    elements.reportWeek.append(option);
  }
  elements.reportWeek.value = String(selectedWeek);
}

function openReport() {
  if (!state || !state.weekStartDate) {
    showToast(t("Atur tanggal awal Week 1 dulu."), "error");
    openSettings();
    return;
  }
  buildReportWeeks();
  const selected = daysToWeek(Number(elements.reportWeek.value || 1));
  elements.reportFrom.value = selected[0];
  elements.reportTo.value = selected[1];
  elements.reportFrom.min = state.weekStartDate;
  elements.reportTo.min = state.weekStartDate;
  elements.reportFeedback.textContent = "";
  updateReportMode();
  elements.reportDialog.showModal();
}

function updateReportMode() {
  const isWeek = elements.reportMode.value === "week";
  elements.reportWeekFields.hidden = !isWeek;
  elements.reportRangeFields.hidden = isWeek;
  const photoButton = $("#download-period-photos");
  photoButton.dataset.i18n = isWeek ? "Unduh foto Week (ZIP)" : "Unduh foto rentang (ZIP)";
  photoButton.textContent = t(photoButton.dataset.i18n);
  if (isWeek) {
    const [from, to] = daysToWeek(Number(elements.reportWeek.value || 1));
    elements.reportFrom.value = from;
    elements.reportTo.value = to;
  }
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1200);
}

async function uploadFiles(files) {
  if (!state || !state.weekStartDate) {
    openSettings();
    return;
  }
  if (elements.entryDate.value < state.weekStartDate) {
    showToast(t("Pilih tanggal yang sama atau sesudah awal Week 1."), "error");
    return;
  }
  const photos = Array.from(files || []);
  if (!photos.length || uploading) return;
  uploading = true;
  const uploadDate = elements.entryDate.value;
  $("#upload-area").dataset.uploading = "true";
  updateEntryControls();
  for (let index = 0; index < photos.length; index++) {
    const file = photos[index];
    elements.uploadProgress.textContent = t("Mengunggah {index} dari {count}: {name}", { index: index + 1, count: photos.length, name: file.name });
    try {
      currentDay = await api("/api/days/" + encodeURIComponent(uploadDate) + "/photos", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name)
        },
        body: file
      });
      state.hasEntries = state.hasEntries || Boolean(elements.dayNote.value.trim());
      renderDay();
    } catch (error) {
      showToast(file.name + ": " + error.message, "error");
    }
  }
  elements.uploadProgress.textContent = "";
  elements.photoInput.value = "";
  uploading = false;
  $("#upload-area").dataset.uploading = "false";
  updateEntryControls();
  if (currentDay) {
    showToast(t("Foto tersimpan di arsip lokal. Status Discord terlihat di catatan hari ini."));
    await refreshCurrentDay();
    await loadArchive(elements.entryDate.value.slice(0, 7));
  }
}

async function uploadVideos(files) {
  if (!state || !state.weekStartDate) {
    openSettings();
    return;
  }
  if (elements.entryDate.value < state.weekStartDate) {
    showToast(t("Pilih tanggal yang sama atau sesudah awal Week 1."), "error");
    return;
  }
  const videos = Array.from(files || []);
  if (!videos.length || uploading || uploadingVideos) return;
  uploadingVideos = true;
  const uploadDate = elements.entryDate.value;
  $("#video-upload-area").dataset.uploading = "true";
  updateEntryControls();
  let savedAny = false;
  for (let index = 0; index < videos.length; index++) {
    const file = videos[index];
    if (!file.size || file.size > videoUploadMaxBytes) {
      showToast(t("Video melebihi batas 1 GB: {name}", { name: file.name }), "error");
      continue;
    }
    let uploadId = "";
    try {
      const upload = await api("/api/days/" + encodeURIComponent(uploadDate) + "/video-uploads", {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, mimeType: file.type })
      });
      uploadId = upload.id;
      const chunkBytes = Number(upload.chunkBytes) || videoUploadChunkBytes;
      const chunkCount = Math.ceil(file.size / chunkBytes);
      let uploadedBytes = 0;
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const start = chunkIndex * chunkBytes;
        const chunk = file.slice(start, Math.min(start + chunkBytes, file.size));
        const progress = Math.floor(uploadedBytes / file.size * 100);
        elements.videoUploadProgress.textContent = t("Mengunggah video {index} dari {count}: {name} ({percent}%)", {
          index: index + 1, count: videos.length, name: file.name, percent: progress
        });
        const response = await api("/api/video-uploads/" + encodeURIComponent(uploadId) + "/chunks/" + chunkIndex, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: chunk
        });
        uploadedBytes = Number(response.uploadedBytes) || uploadedBytes + chunk.size;
      }
      elements.videoUploadProgress.textContent = t("Mengunggah video {index} dari {count}: {name} ({percent}%)", {
        index: index + 1, count: videos.length, name: file.name, percent: 100
      });
      currentDay = await api("/api/video-uploads/" + encodeURIComponent(uploadId) + "/complete", { method: "POST" });
      uploadId = "";
      state.hasEntries = true;
      savedAny = true;
      renderDay();
    } catch (error) {
      showToast(file.name + ": " + error.message, "error");
      if (uploadId) {
        await api("/api/video-uploads/" + encodeURIComponent(uploadId) + "/cancel", { method: "POST" }).catch(() => {});
      }
    }
  }
  elements.videoUploadProgress.textContent = "";
  elements.videoInput.value = "";
  uploadingVideos = false;
  $("#video-upload-area").dataset.uploading = "false";
  updateEntryControls();
  if (savedAny) {
    showToast(t("Video tersimpan terpisah dari foto di arsip lokal."));
    await refreshCurrentDay();
    await loadArchive(uploadDate.slice(0, 7));
  }
}

async function refreshCurrentDay() {
  if (!elements.entryDate.value || !state.weekStartDate) return;
  const date = elements.entryDate.value;
  const day = await api("/api/days/" + encodeURIComponent(date));
  if (date !== elements.entryDate.value || noteDirty || captionDirty || equipmentDirty) return;
  if (JSON.stringify(day) === JSON.stringify(currentDay)) return;
  currentDay = day;
  renderDay();
}

async function handleRetry() {
  if (!currentDay) return;
  const uncertain = currentDay.syncStatus === "uncertain";
  if (uncertain) {
    const accepted = await askConfirmation(
      t("Hasil kirim sebelumnya belum pasti. Periksa forum Discord. Jika posting atau foto yang tertinggal sudah ada, batalkan agar tidak terkirim dua kali."),
      t("Kirim ulang ke Discord?"), t("Sudah diperiksa, kirim")
    );
    if (!accepted) return;
  }
  await retryDateSync(currentDay.date, uncertain);
}

async function retryDateSync(dateValue, confirmUncertain) {
  try {
    await api("/api/discord/retry", {
      method: "POST",
      body: JSON.stringify({ date: dateValue, confirmUncertain })
    });
    showToast(t("Pengiriman Discord dimulai."));
    await refreshCurrentDay();
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function submitSettings(event) {
  event.preventDefault();
  const button = $("#save-settings");
  setBusy(button, true, t("Menyimpan…"));
  elements.settingsFeedback.textContent = "";
  try {
    const updated = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        projectName: elements.projectName.value,
        weekStartDate: elements.weekStart.value,
        webhookUrl: elements.webhookUrl.value
      })
    });
    state = { ...state, ...updated };
    elements.webhookUrl.value = "";
    elements.settingsDialog.close();
    await loadState();
    showToast(t("Pengaturan tersimpan."));
  } catch (error) {
    elements.settingsFeedback.textContent = error.message;
    elements.settingsFeedback.style.color = "#a3342c";
  } finally {
    setBusy(button, false);
  }
}

async function testWebhook() {
  const button = $("#test-webhook");
  setBusy(button, true, t("Menguji…"));
  elements.settingsFeedback.textContent = "";
  try {
    const result = await api("/api/discord/test", {
      method: "POST",
      body: JSON.stringify({ webhookUrl: elements.webhookUrl.value })
    });
    elements.settingsFeedback.textContent = t(result.message);
    elements.settingsFeedback.style.color = "#315a4a";
  } catch (error) {
    elements.settingsFeedback.textContent = error.message;
    elements.settingsFeedback.style.color = "#a3342c";
  } finally {
    setBusy(button, false);
  }
}

async function clearWebhook() {
  if (!await askConfirmation(t("Foto baru tetap masuk arsip lokal. Pengiriman ke Discord berhenti sampai webhook disambungkan kembali."), t("Putuskan koneksi Discord?"), t("Putuskan koneksi"))) return;
  try {
    state = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        projectName: elements.projectName.value || state.projectName,
        weekStartDate: elements.weekStart.value || state.weekStartDate || "",
        clearWebhook: true
      })
    });
    clearWebhookField();
    await loadState();
    elements.settingsFeedback.textContent = t("Webhook diputuskan.");
    elements.settingsFeedback.style.color = "#315a4a";
  } catch (error) {
    elements.settingsFeedback.textContent = error.message;
    elements.settingsFeedback.style.color = "#a3342c";
  }
}

async function submitReport(event) {
  event.preventDefault();
  const button = $("#download-report");
  setBusy(button, true, t("Menyusun…"));
  elements.reportFeedback.textContent = "";
  try {
    let from = elements.reportFrom.value;
    let to = elements.reportTo.value;
    if (elements.reportMode.value === "week") [from, to] = daysToWeek(Number(elements.reportWeek.value));
    if (!from || !to || from > to) throw new Error(t("Rentang tanggal laporan belum benar."));
    const response = await fetch("/api/reports.docx?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to), { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(t(body.error || "Dokumen tidak bisa dibuat."));
    }
    downloadBlob(await response.blob(), "Sitebook-Week-" + weekNumber(from) + "-" + from + ".docx");
    elements.reportDialog.close();
    showToast(t("Laporan Word siap diunduh."));
  } catch (error) {
    elements.reportFeedback.textContent = error.message;
    elements.reportFeedback.style.color = "#a3342c";
  } finally {
    setBusy(button, false);
  }
}

async function downloadEquipmentReport(format = "xlsx") {
  const button = format === "pdf" ? $("#download-equipment-pdf") : $("#download-equipment-report");
  setBusy(button, true, t("Menyusun…"));
  elements.reportFeedback.textContent = "";
  try {
    let from = elements.reportFrom.value;
    let to = elements.reportTo.value;
    if (elements.reportMode.value === "week") [from, to] = daysToWeek(Number(elements.reportWeek.value));
    if (!from || !to || from > to) throw new Error(t("Rentang tanggal laporan belum benar."));
    const query = "from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
    const response = await fetch("/api/equipment-hours." + format + "?" + query, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(t(body.error || "Dokumen tidak bisa dibuat."));
    }
    const filename = elements.reportMode.value === "week"
      ? "Sitebook-jam-alat-Week-" + weekNumber(from) + "-" + from + "." + format
      : "Sitebook-jam-alat-" + from + "-sampai-" + to + "." + format;
    downloadBlob(await response.blob(), filename);
    elements.reportDialog.close();
    showToast(t(format === "pdf" ? "File PDF jam alat siap diunduh." : "File jam alat siap diunduh."));
  } catch (error) {
    elements.reportFeedback.textContent = error.message;
    elements.reportFeedback.style.color = "#a3342c";
  } finally {
    setBusy(button, false);
  }
}

async function downloadPhotoArchive(from, to, button, stamped = false) {
  if (!from || !to || from > to) {
    showToast(t("Rentang tanggal laporan belum benar."), "error");
    return;
  }
  setBusy(button, true, t("Menghitung ukuran…"));
  try {
    const query = "from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
    const stampQuery = stamped ? "&" + new URLSearchParams({ stamped: "1", x: stampLayout.x, y: stampLayout.y, size: stampLayout.size, opacity: stampLayout.opacity, color: stampLayout.color }).toString() : "";
    const estimate = await api("/api/photos.zip?" + query + stampQuery + "&estimate=1");
    if (!estimate.photoCount) throw new Error(t("Tidak ada foto pada periode ini."));
    const size = (estimate.approximate ? "≈ " : "") + formatBytes(estimate.totalBytes);
    const message = t(stamped
      ? "ZIP berisi {count} salinan foto bertanggal, ukuran kira-kira {size}. Lanjutkan?"
      : "ZIP berisi {count} foto asli ({size}). Lanjutkan unduhan?", {
      count: estimate.photoCount,
      size
    });
    if (!await askConfirmation(
      message,
      t(stamped ? "Unduh salinan bertanggal?" : "Unduh foto proyek?"),
      t(stamped ? "Unduh salinan" : "Unduh ZIP")
    )) return;
    const link = document.createElement("a");
    link.href = "/api/photos.zip?" + query + stampQuery;
    link.download = "Sitebook-" + (stamped ? "dated-photos" : "photos") + "-" + from + "-to-" + to + ".zip";
    document.body.append(link);
    link.click();
    link.remove();
    showToast(t(stamped ? "Unduhan salinan bertanggal dimulai." : "Unduhan ZIP foto dimulai."));
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
    updateEntryControls();
  }
}

async function downloadBackup() {
  const button = $("#download-backup");
  setBusy(button, true, t("Menyiapkan ZIP…"));
  try {
    const response = await fetch("/api/backup.zip", { cache: "no-store" });
    if (!response.ok) throw new Error(t("Cadangan tidak dapat dibuat."));
    downloadBlob(await response.blob(), "sitebook-backup-" + dateParts() + ".zip");
    showToast(t("Cadangan ZIP berhasil dibuat."));
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function restoreBackup(file) {
  if (!file) return;
  const accepted = await askConfirmation(
    t("Cadangan ini akan mengganti arsip saat ini. Aplikasi membuat salinan pengaman sebelum mengganti data."),
    t("Pulihkan arsip?"), t("Pulihkan cadangan")
  );
  if (!accepted) {
    $("#restore-input").value = "";
    return;
  }
  const input = $("#restore-input");
  input.disabled = true;
  try {
    await api("/api/backup/restore", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file
    });
    state = await api("/api/state");
    await loadState();
    elements.settingsDialog.close();
    showToast(t("Cadangan berhasil dipulihkan."));
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    input.disabled = false;
    input.value = "";
  }
}

function onDrop(event) {
  event.preventDefault();
  $("#upload-area").classList.remove("drag-over");
  const dropped = Array.from(event.dataTransfer.files || []);
  const photos = dropped.filter((file) => file.type.startsWith("image/"));
  const videoCount = dropped.length - photos.length;
  if (videoCount) showToast(t("Video tidak masuk ke bagian foto. Unggah melalui bagian dokumentasi video."), "error");
  if (photos.length) uploadFiles(photos);
}

function showLogin() {
  authState.user = null;
  authState.csrfToken = null;
  state = null;
  clearWebhookField();
  currentDay = null;
  noteDirty = false;
  captionDirty = false;
  captionDrafts.clear();
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  $(".app-shell").hidden = true;
  $(".skip-link").hidden = true;
  $("#auth-screen").hidden = false;
  elements.photoGrid.replaceChildren();
  elements.dayNote.value = "";
  $("#trash-list").replaceChildren();
  $("#users-list").replaceChildren();
  elements.archiveList.replaceChildren();
  elements.toast.classList.remove("visible");
  elements.toast.textContent = "";
  clearTimeout(toastTimer);
  archiveDays = [];
  renderAuthLabels();
  $("#auth-username").value = "";
  $("#auth-password").value = "";
  $("#auth-confirm").value = "";
  $("#auth-loading").textContent = "";
}

function renderAuthLabels() {
  const setup = !authState.initialized;
  $("#auth-title").textContent = setup ? t("Buat akun admin pertama") : t("Masuk ke buku lapangan");
  $("#auth-description").textContent = setup
    ? t("Pilih username dan password minimal 6 karakter. Akun teman bisa dibuat setelah masuk. Pendaftaran awal hanya lewat komputer proyek.")
    : t("Gunakan akun admin atau akun anggota dari admin proyek.");
  const label = setup ? t("Buat akun admin") : t("Masuk");
  if ($("#auth-submit").disabled) $("#auth-submit").dataset.originalLabel = label;
  else $("#auth-submit").textContent = label;
  $("#auth-confirm-wrap").hidden = !setup;
  $("#auth-confirm").required = setup;
  $("#auth-password").autocomplete = setup ? "new-password" : "current-password";
  $("#auth-password").minLength = setup ? 6 : 1;
}

function renderNoteCounter() {
  $("#note-counter").textContent = elements.dayNote.value.length.toLocaleString(I18n.locale) + " / " + (1800).toLocaleString(I18n.locale);
}

function renderAccountLabels() {
  if (!authState.user) return;
  const admin = authState.user.role === "admin";
  $("#open-account").title = authState.user.username + " · " + (admin ? t("Admin") : t("Anggota"));
  $("#account-identity").textContent = $("#open-account").title;
  $("#account-permissions").textContent = admin
    ? t("Lo mengelola akun, pengaturan proyek, cadangan, dan penghapusan dokumentasi.")
    : t("Lo bisa lihat, unggah, edit dokumentasi, dan unduh laporan.");
  $("#setup-notice p").textContent = admin ? t("Atur awal Week 1 sebelum menyimpan dokumentasi.") : t("Minta admin mengatur awal Week 1 sebelum dokumentasi pertama disimpan.");
}

function changeLanguage(language) {
  I18n.setLanguage(language);
  I18n.apply(document);
  renderAuthLabels();
  renderAccountLabels();
  if (state) {
    renderProjectLabels();
    renderWeekLabel();
    renderDay();
    renderArchive();
    if (noteDirty) elements.noteStatus.textContent = t("Perubahan belum disimpan.");
  }
  document.querySelectorAll(".inline-feedback, #auth-loading, .toast").forEach((element) => {
    element.textContent = t(element.textContent);
  });
}

async function initializeAuth() {
  authState = await api("/api/auth/state");
  if (authState.user) await showApp();
  else showLogin();
}

async function showApp() {
  $("#auth-screen").hidden = true;
  $(".app-shell").hidden = false;
  $(".skip-link").hidden = false;
  const admin = authState.user.role === "admin";
  document.querySelectorAll("[data-admin]").forEach((element) => { element.hidden = !admin; });
  renderAccountLabels();
  $("#configure-first").hidden = !admin;
  $("#setup-notice p").textContent = admin ? t("Atur awal Week 1 sebelum menyimpan dokumentasi.") : t("Minta admin mengatur awal Week 1 sebelum dokumentasi pertama disimpan.");
  await loadState();
}

async function submitLogin(event) {
  event.preventDefault();
  const button = $("#auth-submit");
  $("#auth-feedback").textContent = "";
  if (!authState.initialized && $("#auth-password").value !== $("#auth-confirm").value) {
    $("#auth-feedback").textContent = t("Ulangi password yang sama.");
    return;
  }
  setBusy(button, true, t("Memproses…"));
  try {
    authState = await api(authState.initialized ? "/api/auth/login" : "/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ username: $("#auth-username").value, password: $("#auth-password").value })
    });
    $("#auth-password").value = "";
    $("#auth-confirm").value = "";
    await showApp();
  } catch (error) { $("#auth-feedback").textContent = error.message; }
  finally { setBusy(button, false); }
}

function openPasswordAction(title, description, action, options = {}) {
  $("#password-action-title").textContent = title;
  $("#password-action-description").textContent = description;
  $("#password-action-submit").textContent = options.label || t("Konfirmasi hapus");
  $("#action-new-password-wrap").hidden = !options.newPassword;
  $("#action-new-password").required = Boolean(options.newPassword);
  $("#action-new-password").value = "";
  $("#action-password").value = "";
  $("#action-feedback").textContent = "";
  pendingPasswordAction = action;
  $("#password-action-dialog").showModal();
  $("#action-password").focus();
}

function requestDelete(photo = null) {
  if (!currentDay || uploading || !authState.user || authState.user.role !== "admin") return;
  const date = currentDay.date;
  const description = photo
    ? t('Foto "{name}" akan dipindahkan ke sampah. Foto di pesan Discord ikut dibersihkan saat sinkronisasi.', { name: photo.originalName })
    : t("{count} foto tanggal {date} akan dipindahkan ke sampah. Video terpisah tidak ikut dihapus.", { count: currentDay.photos.length, date: formatDate(date) }) + " " +
      t("Foto di Discord ikut dibersihkan; thread hariannya tetap tersedia.");
  openPasswordAction(photo ? t("Hapus foto ini?") : t("Hapus foto tanggal ini?"), description + " " + t("Foto bisa dipulihkan lewat Sampah. Perubahan yang belum disimpan akan ditinggalkan."), async (password) => {
    currentDay = await api(photo ? "/api/photos/" + photo.id : "/api/days/" + date, { method: "DELETE", body: JSON.stringify({ password }) });
    noteDirty = false;
    captionDirty = false;
    captionDrafts.clear();
    renderDay();
    await loadArchive(date.slice(0, 7));
    showToast(t("Dipindahkan ke sampah. Status pembersihan Discord terlihat pada tanggal ini."));
  });
}

function requestDeleteVideo(video) {
  if (!currentDay || uploadingVideos || !authState.user || authState.user.role !== "admin") return;
  const date = currentDay.date;
  openPasswordAction(t("Hapus video ini?"), t("Video ini akan dihapus permanen dan tidak masuk ke Sampah."), async (password) => {
    currentDay = await api("/api/videos/" + encodeURIComponent(video.id), {
      method: "DELETE",
      body: JSON.stringify({ password })
    });
    renderDay();
    await loadArchive(date.slice(0, 7));
    showToast(t("Video dihapus dari arsip."));
  });
}

async function loadTrash() {
  const list = $("#trash-list");
  list.textContent = t("Memuat sampah…");
  try {
    const result = await api("/api/trash");
    list.replaceChildren();
    if (!result.photos.length) { list.textContent = t("Sampah kosong."); return; }
    for (const photo of result.photos) {
      const row = document.createElement("div");
      row.className = "user-row";
      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = photo.original_name;
      const date = document.createElement("p");
      date.textContent = formatDate(photo.entry_date);
      const status = document.createElement("span");
      status.className = "trash-status";
      status.dataset.error = String(["failed", "uncertain"].includes(photo.sync_status));
      const statuses = { sent: t("Pembersihan tersinkron"), pending: t("Menunggu pembersihan Discord"), syncing: t("Membersihkan pesan Discord…"), waiting_config: t("Hubungkan webhook untuk membersihkan salinan Discord") };
      status.textContent = t(photo.sync_error || statuses[photo.sync_status] || "Pembersihan Discord perlu diperiksa");
      text.append(name, date, status);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "button button-outline";
      restore.textContent = t("Pulihkan");
      restore.addEventListener("click", async () => {
        setBusy(restore, true, t("Memulihkan…"));
        try {
          await api("/api/trash/" + photo.id + "/restore", { method: "POST", body: "{}" });
          await loadTrash();
          await loadDay();
          showToast(t("Foto dipulihkan ke tanggal semula."));
        } catch (error) { showToast(error.message, "error"); setBusy(restore, false); }
      });
      const actions = document.createElement("div");
      actions.className = "row-actions";
      actions.append(restore);
      if (["failed", "uncertain", "waiting_config"].includes(photo.sync_status)) {
        const inspect = document.createElement("button");
        inspect.type = "button";
        inspect.className = "button button-quiet";
        inspect.textContent = t("Lihat status");
        inspect.addEventListener("click", () => { $("#trash-dialog").close(); setDate(photo.entry_date); });
        actions.append(inspect);
      }
      row.append(text, actions);
      list.append(row);
    }
  } catch (error) { list.textContent = error.message; }
}

async function loadUsers() {
  const list = $("#users-list");
  list.textContent = t("Memuat akun…");
  try {
    const result = await api("/api/users");
    list.replaceChildren();
    for (const user of result.users) {
      const row = document.createElement("div");
      row.className = "user-row";
      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = user.username;
      const role = document.createElement("p");
      role.textContent = user.role === "admin" ? t("Admin") : user.disabled ? t("Anggota · dinonaktifkan") : t("Anggota · aktif");
      text.append(name, role);
      row.append(text);
      if (user.role === "member") {
        const actions = document.createElement("div");
        actions.className = "row-actions";
        for (const reset of [true, false]) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "button button-outline";
          button.textContent = reset ? t("Reset password") : user.disabled ? t("Aktifkan") : t("Nonaktifkan");
          button.addEventListener("click", () => openPasswordAction(
            reset ? t("Reset password anggota?") : (user.disabled ? t("Aktifkan akun?") : t("Nonaktifkan akun?")),
            t("Akun: {username}. Semua sesi akun ini akan keluar setelah perubahan.", { username: user.username }),
            async (password) => {
              await api("/api/users/" + user.id, { method: "PATCH", body: JSON.stringify({
                password, ...(reset ? { newPassword: $("#action-new-password").value } : { disabled: !user.disabled })
              }) });
              await loadUsers();
              showToast(t("Akun anggota diperbarui."));
            },
            { newPassword: reset, label: reset ? t("Reset password") : user.disabled ? t("Aktifkan akun") : t("Nonaktifkan akun") }
          ));
          actions.append(button);
        }
        row.append(actions);
      }
      list.append(row);
    }
  } catch (error) { list.textContent = error.message; }
}

function wireEvents() {
  document.querySelectorAll("[data-language]").forEach((button) => {
    button.addEventListener("click", () => changeLanguage(button.dataset.language));
  });
  $("#auth-form").addEventListener("submit", submitLogin);
  $("#open-account").addEventListener("click", () => {
    if (!authState.user) return;
    renderAccountLabels();
    $("#change-password-form").reset();
    $("#password-feedback").textContent = "";
    $("#account-dialog").showModal();
  });
  $("#open-users").addEventListener("click", () => { $("#account-dialog").close(); $("#users-dialog").showModal(); loadUsers(); });
  $("#delete-day").addEventListener("click", () => requestDelete());
  $("#download-day-photos").addEventListener("click", () => {
    const date = elements.entryDate.value;
    downloadPhotoArchive(date, date, $("#download-day-photos"));
  });
  $("#download-day-dated-photos").addEventListener("click", () => {
    const date = elements.entryDate.value;
    downloadPhotoArchive(date, date, $("#download-day-dated-photos"), true);
  });
  $("#open-trash").addEventListener("click", () => { $("#trash-dialog").showModal(); loadTrash(); });
  $("#password-action-dialog").addEventListener("close", () => {
    pendingPasswordAction = null;
    $("#action-password").value = "";
    $("#action-new-password").value = "";
  });
  $("#password-action-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!pendingPasswordAction) return;
    const button = $("#password-action-submit");
    setBusy(button, true, t("Memproses…"));
    $("#action-feedback").textContent = "";
    try {
      await pendingPasswordAction($("#action-password").value);
      $("#password-action-dialog").close();
    } catch (error) {
      $("#action-feedback").textContent = error.message;
      $("#action-password").value = "";
      $("#action-password").focus();
    } finally { setBusy(button, false); }
  });
  $("#create-user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#create-user");
    setBusy(button, true, t("Membuat akun…"));
    $("#users-feedback").textContent = "";
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify({ username: $("#member-username").value, password: $("#member-password").value }) });
      $("#create-user-form").reset();
      await loadUsers();
      showToast(t("Akun anggota dibuat."));
    } catch (error) { $("#users-feedback").textContent = error.message; }
    finally { setBusy(button, false); }
  });
  $("#change-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#change-password");
    setBusy(button, true, t("Mengganti…"));
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: $("#current-password").value, newPassword: $("#new-password").value }) });
      showLogin();
      $("#auth-feedback").textContent = t("Password diganti. Masuk lagi dengan password baru.");
    } catch (error) { $("#password-feedback").textContent = error.message; }
    finally { setBusy(button, false); }
  });
  $("#logout").addEventListener("click", async () => {
    if ((noteDirty || captionDirty || equipmentDirty) && !await askConfirmation(t("Perubahan dokumentasi belum disimpan."), t("Keluar dari akun?"), t("Keluar"))) return;
    try { await api("/api/auth/logout", { method: "POST", body: "{}" }); showLogin(); }
    catch (error) { showToast(error.message, "error"); }
  });
  const mobileLayout = window.matchMedia("(max-width: 900px)");
  const shell = $(".app-shell");
  const archive = $("#archive-panel");
  const positionArchive = () => {
    if (mobileLayout.matches) shell.append(archive);
    else shell.prepend(archive);
  };
  positionArchive();
  mobileLayout.addEventListener("change", positionArchive);
  $("#open-settings").addEventListener("click", openSettings);
  $("#open-discord-settings").addEventListener("click", openSettings);
  $("#configure-first").addEventListener("click", openSettings);
  $("#choose-photos").addEventListener("click", () => {
    if (!state || !state.weekStartDate) openSettings();
    else elements.photoInput.click();
  });
  $("#choose-videos").addEventListener("click", () => {
    if (!state || !state.weekStartDate) openSettings();
    else elements.videoInput.click();
  });
  $("#open-report").addEventListener("click", openReport);
  $("#previous-day").addEventListener("click", () => {
    if (elements.entryDate.value) setDate(addDays(elements.entryDate.value, -1));
  });
  $("#next-day").addEventListener("click", () => {
    if (elements.entryDate.value) setDate(addDays(elements.entryDate.value, 1));
  });
  elements.entryDate.addEventListener("change", async () => {
    if (noteDirty || captionDirty || equipmentDirty) {
      const requestedDate = elements.entryDate.value;
      elements.entryDate.value = activeDate;
      if (!await askConfirmation(t("Perubahan catatan, keterangan foto, atau jam alat belum disimpan. Pindah tanggal akan meninggalkan perubahan ini."), t("Pindah tanggal?"), t("Pindah tanggal"))) return;
      elements.entryDate.value = requestedDate;
    }
    renderWeekLabel();
    loadDay().catch((error) => showToast(error.message, "error"));
  });
  elements.photoInput.addEventListener("change", () => uploadFiles(elements.photoInput.files));
  elements.videoInput.addEventListener("change", () => uploadVideos(elements.videoInput.files));
  const dropArea = $("#upload-area");
  dropArea.addEventListener("dragover", (event) => { event.preventDefault(); dropArea.classList.add("drag-over"); });
  dropArea.addEventListener("dragleave", () => dropArea.classList.remove("drag-over"));
  dropArea.addEventListener("drop", onDrop);
  elements.dayNote.addEventListener("input", () => {
    noteDirty = true;
    renderNoteCounter();
    elements.noteStatus.textContent = t("Perubahan belum disimpan.");
    elements.saveNote.disabled = !currentDay || currentDay.deleted || elements.dayNote.value.length > 1800;
  });
  elements.addEquipmentDowntime.addEventListener("click", () => {
      equipmentDraft.push({ equipment: "", hours: [], offIntervals: [], note: "" });
    equipmentDirty = true;
    renderEquipmentLog();
    elements.equipmentList.querySelector(".equipment-name input:last-child")?.focus();
  });
  elements.saveEquipmentDowntime.addEventListener("click", saveEquipmentLog);
  elements.saveNote.addEventListener("click", async () => {
    setBusy(elements.saveNote, true, t("Menyimpan…"));
    try {
      currentDay = await api("/api/days/" + encodeURIComponent(elements.entryDate.value), {
        method: "PATCH",
        body: JSON.stringify({ note: elements.dayNote.value })
      });
      state.hasEntries = true;
      noteDirty = false;
      renderDay();
      loadArchive(elements.entryDate.value.slice(0, 7)).catch(() => {});
      showToast(t("Ringkasan tersimpan."));
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setBusy(elements.saveNote, false);
      updateEntryControls();
    }
  });
  elements.archiveMonth.addEventListener("change", () => {
    if (elements.archiveMonth.value) loadArchive(elements.archiveMonth.value).catch((error) => showToast(error.message, "error"));
  });
  elements.retrySync.addEventListener("click", handleRetry);
  elements.settingsForm.addEventListener("submit", submitSettings);
  elements.dateStampForm.addEventListener("submit", downloadDatedPhoto);
  [elements.stampX, elements.stampY, elements.stampSize, elements.stampOpacity].forEach((input) => {
    input.addEventListener("input", () => {
      if (input === elements.stampX) stampLayout.x = Number(input.value);
      if (input === elements.stampY) stampLayout.y = Number(input.value);
      if (input === elements.stampOpacity) stampLayout.opacity = Number(input.value);
      saveStampLayout();
      updateStampPreview();
    });
  });
  elements.stampXPx.addEventListener("input", () => setStampPositionFromPixels("x", elements.stampXPx));
  elements.stampYPx.addEventListener("input", () => setStampPositionFromPixels("y", elements.stampYPx));
  elements.stampZoom.addEventListener("input", fitStampPreview);
  elements.stampColor.addEventListener("input", () => {
    setStampColor(elements.stampColor.value);
    setStampColorPicking(false);
  });
  elements.stampPickColor.addEventListener("click", () => setStampColorPicking(!pickingStampColor));
  elements.stampPreviewLabel.addEventListener("pointerdown", (event) => {
    if (pickingStampColor || event.button !== 0 || !elements.stampPreviewImage.getBoundingClientRect().width) return;
    draggingStamp = true;
    elements.stampPreviewFrame.classList.add("is-dragging");
    elements.stampPreviewLabel.setPointerCapture(event.pointerId);
    setStampPositionAtPointer(event, false);
    event.preventDefault();
  });
  elements.stampPreviewFrame.addEventListener("pointerdown", (event) => {
    if (!pickingStampColor || event.button !== 0 || event.target !== elements.stampPreviewImage) return;
    draggingStamp = true;
    elements.stampPreviewFrame.classList.add("is-dragging");
    elements.stampPreviewFrame.setPointerCapture(event.pointerId);
    setStampPositionAtPointer(event, false);
    sampleStampColor(event);
    event.preventDefault();
  });
  elements.stampPreviewFrame.addEventListener("pointermove", setStampPositionFromPointer);
  elements.stampPreviewFrame.addEventListener("pointerup", finishStampPointerDrag);
  elements.stampPreviewFrame.addEventListener("pointercancel", finishStampPointerDrag);
  elements.stampPreviewFrame.addEventListener("click", (event) => {
    if (event.target !== elements.stampPreviewImage) return;
    if (pickingStampColor) sampleStampColor(event, true);
    else setStampPositionAtPointer(event);
  });
  elements.dateStampDate.addEventListener("input", updateStampPreview);
  window.addEventListener("resize", fitStampPreview);
  $("#test-webhook").addEventListener("click", testWebhook);
  $("#copy-webhook").addEventListener("click", copyWebhook);
  $("#clear-webhook").addEventListener("click", clearWebhook);
  elements.settingsDialog.addEventListener("close", clearWebhookField);
  elements.dateStampDialog.addEventListener("close", () => {
    setStampColorPicking(false);
    stampSampleCanvas = null;
    stampSampleSource = "";
    draggingStamp = false;
    clearStampOverlayPreview();
    dateStampPhoto = null;
  });
  elements.reportForm.addEventListener("submit", submitReport);
  $("#download-equipment-report").addEventListener("click", () => downloadEquipmentReport("xlsx"));
  $("#download-equipment-pdf").addEventListener("click", () => downloadEquipmentReport("pdf"));
  elements.reportMode.addEventListener("change", updateReportMode);
  elements.reportWeek.addEventListener("change", updateReportMode);
  $("#download-period-photos").addEventListener("click", () => {
    const range = elements.reportMode.value === "week"
      ? daysToWeek(Number(elements.reportWeek.value))
      : [elements.reportFrom.value, elements.reportTo.value];
    downloadPhotoArchive(range[0], range[1], $("#download-period-photos"));
  });
  $("#download-period-dated-photos").addEventListener("click", () => {
    const range = elements.reportMode.value === "week"
      ? daysToWeek(Number(elements.reportWeek.value))
      : [elements.reportFrom.value, elements.reportTo.value];
    downloadPhotoArchive(range[0], range[1], $("#download-period-dated-photos"), true);
  });
  $("#download-backup").addEventListener("click", downloadBackup);
  $("#restore-input").addEventListener("change", (event) => restoreBackup(event.target.files[0]));
  elements.confirmAction.addEventListener("click", async (event) => {
    event.preventDefault();
    const resolve = resolveConfirmation;
    resolveConfirmation = null;
    elements.confirmDialog.close();
    if (resolve) resolve(true);
  });
  elements.confirmDialog.addEventListener("close", () => {
    const resolve = resolveConfirmation;
    resolveConfirmation = null;
    if (resolve) resolve(false);
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
}

if (location.protocol === "file:") {
  location.replace("http://127.0.0.1:4173/");
} else {
  I18n.apply(document);
  wireEvents();
  initializeAuth().catch((error) => {
    $("#auth-loading").textContent = t("Koneksi ke arsip gagal. Muat ulang halaman untuk mencoba lagi.");
    $("#auth-feedback").textContent = error.message;
    elements.connection.textContent = t("Arsip lokal belum terhubung");
    elements.photoGrid.replaceChildren(galleryState(t("Koneksi ke arsip terputus"), t("Jalankan aplikasi Sitebook, lalu muat ulang halaman ini."), true));
    showToast(error.message, "error");
  });
  setInterval(() => {
    const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
    if (document.visibilityState === "visible" && currentDay && ["pending", "syncing"].includes(currentDay.syncStatus) &&
        !noteDirty && !captionDirty && !equipmentDirty && !uploading && !editing && !document.querySelector("dialog[open]")) {
      refreshCurrentDay().catch(() => {});
    }
  }, 5000);
}

