const fs = require("node:fs/promises");
const path = require("node:path");

async function makeReport({ Document, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType }, {
  projectName,
  startDate,
  from,
  to,
  days,
  dataDir,
  sharp
}) {
  const children = [
    new Paragraph({
      text: projectName,
      heading: HeadingLevel.TITLE,
      spacing: { after: 120 }
    }),
    new Paragraph({
      children: [new TextRun({ text: "LAPORAN DOKUMENTASI LAPANGAN", bold: true, color: "315A4A" })],
      spacing: { after: 100 }
    }),
    new Paragraph({
      text: "Periode " + formatDate(from) + " sampai " + formatDate(to),
      spacing: { after: 220 }
    })
  ];

  for (const day of days) {
    const week = Math.floor(
      (Date.parse(day.entry_date + "T00:00:00+07:00") -
        Date.parse(startDate + "T00:00:00+07:00")) / 604800000
    ) + 1;
    children.push(new Paragraph({
      text: "Week " + week + " - " + formatDate(day.entry_date),
      heading: HeadingLevel.HEADING_1,
      keepNext: true,
      spacing: { before: 260, after: 90 }
    }));
    if (day.note && day.note.trim()) {
      children.push(new Paragraph({
        children: [new TextRun({ text: "Ringkasan", bold: true, color: "315A4A" })],
        spacing: { before: 60, after: 40 }
      }));
      for (const line of day.note.split(/\r?\n/)) {
        children.push(new Paragraph({ text: line || " ", spacing: { after: 70 } }));
      }
    }

    for (const photo of day.photos) {
      const imagePath = path.join(dataDir, "previews", photo.preview_name);
      const imageData = await fs.readFile(imagePath);
      let metadata = null;
      if (sharp) {
        metadata = await sharp(imageData).metadata();
      }
      const sourceWidth = Math.max(1, Number(metadata && metadata.width) || 1200);
      const sourceHeight = Math.max(1, Number(metadata && metadata.height) || 800);
      const scale = Math.min(1, 510 / sourceWidth, 310 / sourceHeight);
      children.push(new Paragraph({
        children: [new ImageRun({
          data: imageData,
          transformation: {
            width: Math.max(1, Math.round(sourceWidth * scale)),
            height: Math.max(1, Math.round(sourceHeight * scale))
          }
        })],
        alignment: AlignmentType.LEFT,
        spacing: { before: 90, after: 40 }
      }));
      if (photo.caption && photo.caption.trim()) {
        children.push(new Paragraph({
          children: [new TextRun({ text: photo.caption.trim(), italics: true, color: "49524D" })],
          spacing: { after: 120 }
        }));
      } else {
        children.push(new Paragraph({ text: " ", spacing: { after: 70 } }));
      }
    }
  }

  if (!days.length) {
    children.push(new Paragraph({
      text: "Belum ada ringkasan atau foto pada periode ini.",
      italics: true
    }));
  }

  const doc = new Document({
    creator: "Sitebook",
    title: "Laporan Dokumentasi Lapangan",
    description: "Catatan dan dokumentasi foto lapangan",
    sections: [{
      properties: {
        page: {
          margin: { top: 850, right: 900, bottom: 850, left: 900 }
        }
      },
      children
    }]
  });
  return doc;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta"
  }).format(new Date(value + "T12:00:00+07:00"));
}

module.exports = { makeReport };

