const { formatDate, weekNumber } = require("./discord.cjs");
const { formatHourRanges } = require("./equipment-report.cjs");
const EquipmentHours = require("../public/equipment-hours.js");

const COLORS = {
  ink: "#29322F",
  green: "#315A4A",
  greenDark: "#234538",
  greenPale: "#EAF1EC",
  greenFaint: "#F2F6F3",
  muted: "#68746E",
  line: "#DCE4DE",
  white: "#FFFFFF"
};

const COLUMNS = [
  { title: "Week", width: 44, align: "center" },
  { title: "Tanggal", width: 106 },
  { title: "Alat", width: 99 },
  { title: "Jam operasi", width: 215 },
  { title: "Total jam", width: 73, align: "right" },
  { title: "Catatan", width: 241 }
];

function pdfText(value) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/[–—−]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/[\u007F-\u009F]/g, " ")
    .replace(/[^\u0020-\u00FF\r\n\t]/g, "?");
}

function makeEquipmentPdf(PDFDocument, { projectName, from, to, startDate, days }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: 32, right: 32, bottom: 34, left: 32 },
      autoFirstPage: false,
      compress: true,
      info: { Title: "Laporan Jam Alat Berat", Author: "Sitebook" }
    });
    const chunks = [];
    let pageNumber = 0;
    let y = 0;
    const margin = 32;
    const pageBottom = () => doc.page.height - 62;

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));

    const entries = [];
    for (const day of days) {
      for (const item of day.equipmentLog || []) {
        const hours = [...new Set(Array.isArray(item.hours) ? item.hours : [])];
        const offIntervals = Array.isArray(item.offIntervals) ? item.offIntervals : [];
        const stats = EquipmentHours.calculate(hours, offIntervals);
        entries.push({
          date: day.entry_date,
          week: weekNumber(day.entry_date, startDate),
          equipment: pdfText(item.equipment),
          hours,
          offIntervals,
          hourText: formatHourRanges(hours, offIntervals).replace(/[–—−]/g, "-"),
          totalMinutes: stats.totalMinutes,
          total: stats.totalMinutes / 60,
          note: pdfText(item.note || "")
        });
      }
    }

    const activeDates = new Set(entries.map((entry) => entry.date)).size;
    const equipmentCount = new Set(entries.map((entry) => entry.equipment)).size;
    const totalMinutes = entries.reduce((sum, entry) => sum + entry.totalMinutes, 0);
    const usableWidth = COLUMNS.reduce((sum, column) => sum + column.width, 0);
    const tableX = margin;
    let page = 0;

    function drawFooter() {
      doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted)
        .text("Sitebook  |  " + pdfText(formatDate(to)) + "  |  " + pageNumber, margin, doc.page.height - 47, {
          width: usableWidth,
          align: "right",
          lineBreak: false
        });
    }

    function drawTableHeader() {
      const headerHeight = 25;
      doc.rect(tableX, y, usableWidth, headerHeight).fill(COLORS.green);
      let x = tableX;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(COLORS.white);
      for (const column of COLUMNS) {
        doc.text(column.title, x + 6, y + 8, {
          width: column.width - 12,
          align: column.align || "left",
          lineBreak: false
        });
        x += column.width;
      }
      y += headerHeight;
    }

    function beginPage() {
      if (pageNumber) drawFooter();
      doc.addPage();
      pageNumber += 1;
      page = pageNumber;
      doc.font("Helvetica-Bold").fontSize(17).fillColor(COLORS.greenDark)
        .text("LAPORAN JAM ALAT BERAT", margin, 30, { width: usableWidth, lineBreak: false });
      doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted)
        .text(pdfText(projectName) + "  |  " + pdfText(formatDate(from)) + " - " + pdfText(formatDate(to)),
          margin, 55, { width: usableWidth, lineBreak: false });

      const summaryY = 77;
      const summaryHeight = 31;
      doc.rect(margin, summaryY, usableWidth, summaryHeight).fill(COLORS.greenFaint);
      const summary = [
        ["TOTAL JAM", EquipmentHours.formatHours(totalMinutes)],
        ["HARI ALAT", String(activeDates)],
        ["JENIS ALAT", String(equipmentCount)]
      ];
      const metricWidth = usableWidth / summary.length;
      summary.forEach(([label, value], index) => {
        const x = margin + index * metricWidth;
        if (index) doc.moveTo(x, summaryY + 6).lineTo(x, summaryY + summaryHeight - 6).lineWidth(0.5).stroke(COLORS.line);
        doc.font("Helvetica-Bold").fontSize(7).fillColor(COLORS.muted)
          .text(label, x + 10, summaryY + 5, { width: metricWidth - 20, lineBreak: false });
        doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.greenDark)
          .text(value, x + 10, summaryY + 15, { width: metricWidth - 20, lineBreak: false });
      });

      y = 121;
      drawTableHeader();
    }

    function rowHeightFor(values) {
      doc.font("Helvetica").fontSize(8);
      const heights = values.map((value, index) => doc.heightOfString(value, {
        width: COLUMNS[index].width - 12,
        lineGap: 1
      }));
      return Math.max(27, Math.max(...heights) + 12);
    }

    function drawRow(values) {
      const rowHeight = rowHeightFor(values);
      const bottom = y + rowHeight;
      if (bottom > pageBottom() && y > 145) beginPage();
      const currentY = y;
      doc.rect(tableX, currentY, usableWidth, rowHeight)
        .fill(page % 2 === 0 ? COLORS.greenFaint : COLORS.white);
      doc.moveTo(tableX, currentY + rowHeight).lineTo(tableX + usableWidth, currentY + rowHeight)
        .lineWidth(0.45).stroke(COLORS.line);
      let x = tableX;
      values.forEach((value, index) => {
        doc.font(index === 4 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(8)
          .fillColor(COLORS.ink)
          .text(value, x + 6, currentY + 6, {
            width: COLUMNS[index].width - 12,
            align: COLUMNS[index].align || "left",
            lineGap: 1
          });
        x += COLUMNS[index].width;
      });
      y += rowHeight;
    }

    function drawTotalRow() {
      const rowHeight = 27;
      if (y + rowHeight > pageBottom() && y > 145) beginPage();
      const currentY = y;
      doc.rect(tableX, currentY, usableWidth, rowHeight).fill(COLORS.greenPale);
      doc.moveTo(tableX, currentY + rowHeight).lineTo(tableX + usableWidth, currentY + rowHeight)
        .lineWidth(0.45).stroke(COLORS.line);
      const totalX = tableX + COLUMNS.slice(0, 4).reduce((sum, column) => sum + column.width, 0);
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(COLORS.greenDark)
        .text("TOTAL JAM " + EquipmentHours.formatHours(totalMinutes), totalX + 4, currentY + 8, {
          width: COLUMNS[4].width - 8,
          align: "right",
          lineBreak: false
        });
      y += rowHeight;
    }

    function drawEmptyRow() {
      const rowHeight = 31;
      doc.rect(tableX, y, usableWidth, rowHeight).fill(COLORS.white);
      doc.moveTo(tableX, y + rowHeight).lineTo(tableX + usableWidth, y + rowHeight)
        .lineWidth(0.45).stroke(COLORS.line);
      doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted)
        .text("Belum ada jam alat pada periode ini.", tableX + 6, y + 10, {
          width: usableWidth - 12,
          lineBreak: false
        });
      y += rowHeight;
    }

    beginPage();
    if (!entries.length) {
      drawEmptyRow();
    } else {
      for (const entry of entries) {
        const values = [
          String(entry.week),
          pdfText(formatDate(entry.date)),
          entry.equipment,
          entry.hourText || "Tidak bekerja",
          EquipmentHours.formatHours(entry.totalMinutes),
          entry.note
        ];
        if (y + rowHeightFor(values) + 27 > pageBottom() && y > 145) beginPage();
        drawRow(values);
      }
      drawTotalRow();
    }
    drawFooter();
    doc.end();
  });
}

module.exports = { makeEquipmentPdf };

