const fs = require("node:fs/promises");
const path = require("node:path");
const EquipmentHours = require("../public/equipment-hours.js");

function formatDate(dateValue) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta"
  }).format(new Date(dateValue + "T12:00:00+07:00"));
}

function weekNumber(entryDate, startDate) {
  const entry = Date.parse(entryDate + "T00:00:00+07:00");
  const start = Date.parse(startDate + "T00:00:00+07:00");
  return Math.floor((entry - start) / 604800000) + 1;
}

function threadTitle(entryDate, startDate) {
  return "Week " + weekNumber(entryDate, startDate) + " - " + formatDate(entryDate);
}

function equipmentText(equipmentDowntime) {
  if (!Array.isArray(equipmentDowntime) || !equipmentDowntime.length) return "";
  const lines = equipmentDowntime.map((entry) => {
    if (Array.isArray(entry.hours)) {
      const intervals = Array.isArray(entry.offIntervals) ? entry.offIntervals : [];
      const hours = EquipmentHours.formatOperationRanges(entry.hours, intervals, "-");
      const total = EquipmentHours.formatHours(EquipmentHours.calculate(entry.hours, intervals).totalMinutes);
      const off = intervals.length ? " | OFF " + intervals.map((interval) => interval.startTime + "-" + interval.endTime).join(", ") : "";
      const note = entry.note ? " - " + entry.note : "";
      return "- " + entry.equipment + ": " + (hours ? hours + " (" + total + " jam)" : "OFF (0 jam)") + off + note;
    }
    const reason = entry.reason ? " - " + entry.reason : "";
    return "- " + entry.equipment + ": OFF " + entry.startTime + "-" + entry.endTime + reason;
  });
  return "Jam operasi alat berat\n" + lines.join("\n");
}

function rootText(note, caption, equipmentDowntime = []) {
  const parts = [];
  if (note && note.trim()) parts.push("Catatan hari ini\n" + note.trim());
  const equipment = equipmentText(equipmentDowntime);
  if (equipment) parts.push(equipment);
  if (caption && caption.trim()) parts.push("Foto pertama\n" + caption.trim());
  if (!parts.length) parts.push("Dokumentasi lapangan");
  return parts.join("\n\n").slice(0, 1900);
}

function photoText(caption) {
  return (caption && caption.trim() ? caption.trim() : "Dokumentasi lapangan").slice(0, 1900);
}

function withQuery(urlValue, entries) {
  const url = new URL(urlValue);
  for (const [key, value] of Object.entries(entries)) url.searchParams.set(key, value);
  return url.toString();
}

async function discordRequest(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  } catch (error) {
    const wrapped = new Error("Koneksi Discord terputus sebelum hasil kirim bisa dipastikan.");
    wrapped.uncertain = options.method === "POST";
    wrapped.cause = error;
    throw wrapped;
  }

  const bodyText = await response.text();
  let body = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = { message: bodyText };
    }
  }
  if (!response.ok) {
    const error = new Error(
      "Discord menolak kiriman (" + response.status + "). " +
      String(body.message || "Periksa webhook dan izin forum.")
    );
    error.uncertain = response.status >= 500 && options.method === "POST";
    error.status = response.status;
    error.discordCode = body.code;
    throw error;
  }
  return body;
}

async function makeUploadPayload(photo, dataDir, content, threadName) {
  const previewPath = path.join(dataDir, "previews", photo.preview_name);
  const bytes = await fs.readFile(previewPath);
  const form = new FormData();
  const payload = {
    content,
    allowed_mentions: { parse: [] }
  };
  if (threadName) payload.thread_name = threadName;
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", new Blob([bytes], { type: "image/jpeg" }), "foto-lapangan.jpg");
  return form;
}

async function editWebhookMessage(webhookUrl, threadId, messageId, content) {
  const url = withQuery(webhookUrl + "/messages/" + encodeURIComponent(messageId), {
    thread_id: threadId,
    wait: "true"
  });
  return discordRequest(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] }
    })
  });
}

async function clearWebhookMessage(webhookUrl, threadId, messageId, content) {
  return discordRequest(withQuery(webhookUrl.replace(/\/$/, "") + "/messages/" + encodeURIComponent(messageId), { thread_id: threadId }), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, attachments: [], embeds: [], allowed_mentions: { parse: [] } })
  });
}

async function deleteWebhookMessage(webhookUrl, threadId, messageId) {
  try {
    await discordRequest(withQuery(webhookUrl.replace(/\/$/, "") + "/messages/" + encodeURIComponent(messageId), { thread_id: threadId }), { method: "DELETE" });
  } catch (error) {
    if (error.status !== 404 || (error.discordCode && error.discordCode !== 10008)) throw error;
  }
}

async function postPhoto(webhookUrl, threadId, photo, dataDir, caption, title) {
  const target = threadId
    ? withQuery(webhookUrl, { thread_id: threadId, wait: "true" })
    : withQuery(webhookUrl, { wait: "true" });
  const form = await makeUploadPayload(photo, dataDir, caption, threadId ? null : title);
  return discordRequest(target, { method: "POST", body: form });
}

async function postTextThread(webhookUrl, threadId, content, title) {
  const target = threadId
    ? withQuery(webhookUrl, { thread_id: threadId, wait: "true" })
    : withQuery(webhookUrl, { wait: "true" });
  const payload = { content, allowed_mentions: { parse: [] } };
  if (!threadId) payload.thread_name = title;
  return discordRequest(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function verifyWebhook(webhookUrl) {
  const details = await discordRequest(webhookUrl, { method: "GET" });
  if (!details.id || !details.channel_id) {
    throw new Error("Webhook tidak mengembalikan kanal tujuan yang valid.");
  }
  return { channelId: details.channel_id, name: details.name || "Webhook Discord" };
}

async function syncDay({ db, dayId, dataDir, webhookUrl, startDate }) {
  let resetInvalidThread = false;
  while (true) {
    const day = db.prepare("SELECT * FROM days WHERE id = ?").get(dayId);
    if (!day) return;
    const photos = db.prepare(
      "SELECT * FROM photos WHERE day_id = ? ORDER BY sort_order, created_at, id"
    ).all(dayId);
    const activePhotos = photos.filter((photo) => !photo.deleted_at);
    let equipmentLog = [];
    try {
      const parsed = JSON.parse(day.equipment_json || "[]");
      if (Array.isArray(parsed)) equipmentLog = parsed;
    } catch {}
    if (!photos.length && !day.discord_thread_id && !day.note.trim() && !equipmentLog.length) {
      db.prepare("UPDATE days SET sync_status = 'sent', sync_error = NULL WHERE id = ?").run(dayId);
      return;
    }
    if (!activePhotos.length && !day.discord_thread_id && !equipmentLog.length) {
      db.prepare("UPDATE days SET sync_status = 'sent', sync_error = NULL WHERE id = ?").run(dayId);
      return;
    }
    if (!webhookUrl) {
      db.prepare("UPDATE days SET sync_status = 'waiting_config', sync_error = NULL WHERE id = ?").run(dayId);
      return;
    }

    db.prepare("UPDATE days SET sync_status = 'syncing', sync_error = NULL WHERE id = ?").run(dayId);
    try {
      let threadId = day.discord_thread_id;
      let rootMessageId = day.discord_root_message_id;
      const first = activePhotos[0];
      const activeRoot = activePhotos.find((photo) => photo.discord_message_id === rootMessageId);
      const desiredRoot = activePhotos.length
        ? rootText(day.note, (!rootMessageId || activeRoot) ? (activeRoot || first).caption : "", equipmentLog)
        : photos.length
          ? "Dokumentasi tanggal ini dihapus dari arsip web."
          : rootText(day.note, "", equipmentLog);
      const title = threadTitle(day.entry_date, startDate);

      for (const photo of photos.filter((item) => item.deleted_at && item.discord_message_id)) {
        if (photo.discord_message_id === rootMessageId) {
          await clearWebhookMessage(webhookUrl, threadId, rootMessageId, desiredRoot);
          db.prepare("UPDATE days SET synced_root_text = ? WHERE id = ?").run(desiredRoot, dayId);
          day.synced_root_text = desiredRoot;
        } else {
          await deleteWebhookMessage(webhookUrl, threadId, photo.discord_message_id);
        }
        db.prepare("UPDATE photos SET discord_message_id = NULL, synced_caption = NULL WHERE id = ?").run(photo.id);
        photo.discord_message_id = null;
      }

      if (!threadId || !rootMessageId) {
        const created = first
          ? await postPhoto(webhookUrl, null, first, dataDir, desiredRoot, title)
          : await postTextThread(webhookUrl, threadId, desiredRoot, title);
        if (!created.id || !created.channel_id) {
          const error = new Error("Discord tidak mengembalikan ID posting forum.");
          error.uncertain = true;
          throw error;
        }
        threadId = String(created.channel_id);
        rootMessageId = String(created.id);
        db.prepare(
          "UPDATE days SET discord_thread_id = ?, discord_root_message_id = ?, synced_root_text = ? WHERE id = ?"
        ).run(threadId, rootMessageId, desiredRoot, dayId);
        if (first) {
          db.prepare(
            "UPDATE photos SET discord_message_id = ?, synced_caption = ? WHERE id = ?"
          ).run(rootMessageId, first.caption || "", first.id);
          first.discord_message_id = rootMessageId;
        }
      } else if (day.synced_root_text !== desiredRoot) {
        await editWebhookMessage(webhookUrl, threadId, rootMessageId, desiredRoot);
        db.prepare("UPDATE days SET synced_root_text = ? WHERE id = ?").run(desiredRoot, dayId);
        if (activeRoot) db.prepare("UPDATE photos SET synced_caption = ? WHERE id = ?").run(activeRoot.caption || "", activeRoot.id);
      }

      for (const photo of activePhotos.filter((item) => item.discord_message_id !== rootMessageId)) {
        if (!photo.discord_message_id) {
          const sent = await postPhoto(
            webhookUrl,
            threadId,
            photo,
            dataDir,
            photoText(photo.caption),
            null
          );
          if (!sent.id) {
            const error = new Error("Discord tidak mengembalikan ID pesan foto.");
            error.uncertain = true;
            throw error;
          }
          db.prepare(
            "UPDATE photos SET discord_message_id = ?, synced_caption = ? WHERE id = ?"
          ).run(String(sent.id), photo.caption || "", photo.id);
        } else if ((photo.synced_caption || "") !== (photo.caption || "")) {
          await editWebhookMessage(
            webhookUrl,
            threadId,
            photo.discord_message_id,
            photoText(photo.caption)
          );
          db.prepare("UPDATE photos SET synced_caption = ? WHERE id = ?").run(photo.caption || "", photo.id);
        }
      }

      db.prepare(
        "UPDATE days SET sync_status = 'sent', sync_error = NULL, synced_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(dayId);
      return;
    } catch (error) {
      if (error.discordCode === 10003 && day.discord_thread_id && !resetInvalidThread) {
        db.prepare(
          "UPDATE days SET discord_thread_id = NULL, discord_root_message_id = NULL, synced_root_text = NULL WHERE id = ?"
        ).run(dayId);
        db.prepare(
          "UPDATE photos SET discord_message_id = NULL, synced_caption = NULL WHERE day_id = ?"
        ).run(dayId);
        resetInvalidThread = true;
        continue;
      }
      const status = error.uncertain ? "uncertain" : "failed";
      db.prepare("UPDATE days SET sync_status = ?, sync_error = ? WHERE id = ?")
        .run(status, String(error.message || "Pengiriman Discord gagal.").slice(0, 500), dayId);
      return;
    }
  }
}

module.exports = {
  clearWebhookMessage,
  equipmentText,
  deleteWebhookMessage,
  editWebhookMessage,
  formatDate,
  photoText,
  postTextThread,
  rootText,
  syncDay,
  threadTitle,
  verifyWebhook,
  weekNumber
};

