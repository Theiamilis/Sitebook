const fs = require("node:fs/promises");
const path = require("node:path");

async function makeBackup(JSZip, { dataDir, databasePath, projectName }) {
  const zip = new JSZip();
  const database = await fs.readFile(databasePath);
  zip.file("database.sqlite", database);
  zip.file("manifest.json", JSON.stringify({
    application: "Sitebook Field Log",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    projectName
  }, null, 2));

  for (const folderName of ["photos", "previews", "videos"]) {
    const folderPath = path.join(dataDir, folderName);
    let entries = [];
    try {
      entries = await fs.readdir(folderPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const allowedName = folderName === "videos"
        ? /^[a-f0-9-]+\.(?:mp4|m4v|mov|3gp|webm)$/i.test(entry.name)
        : /^[a-f0-9-]+\.(?:original|jpg)$/.test(entry.name);
      if (!allowedName) continue;
      zip.file(folderName + "/" + entry.name, await fs.readFile(path.join(folderPath, entry.name)), {
        compression: folderName === "videos" ? "STORE" : "DEFLATE",
        compressionOptions: { level: 4 }
      });
    }
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 4 }
  });
}

async function stageRestore(JSZip, buffer, stageDir) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > 10000) throw new Error("Cadangan berisi terlalu banyak berkas.");
  let totalBytes = 0;
  const allowedFile = /^(?:database\.sqlite|manifest\.json|photos\/[a-f0-9-]+\.original|previews\/[a-f0-9-]+\.jpg|videos\/[a-f0-9-]+\.(?:mp4|m4v|mov|3gp|webm))$/i;
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name;
    if (!allowedFile.test(name) || name.includes("..")) {
      throw new Error("Nama berkas di dalam cadangan tidak valid.");
    }
    const data = await entry.async("nodebuffer");
    totalBytes += data.length;
    if (totalBytes > 1024 * 1024 * 1024) throw new Error("Ukuran cadangan melebihi 1 GB.");
    const target = path.join(stageDir, ...name.split("/"));
    if (!target.startsWith(path.resolve(stageDir) + path.sep)) {
      throw new Error("Lokasi berkas cadangan tidak valid.");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: "wx" });
  }

  const manifestPath = path.join(stageDir, "manifest.json");
  const databasePath = path.join(stageDir, "database.sqlite");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.application !== "Sitebook Field Log" || manifest.formatVersion !== 1) {
    throw new Error("Format cadangan ini tidak didukung.");
  }
  await fs.access(databasePath);
  return { manifest, databasePath, stageDir };
}

module.exports = { makeBackup, stageRestore };

