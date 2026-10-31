const { formatDate, weekNumber } = require("./discord.cjs");
const EquipmentHours = require("../public/equipment-hours.js");
const HOURS = EquipmentHours.HOURS;

function cleanText(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function escapeXml(value) {
  return cleanText(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function columnName(value) {
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function inlineCell(reference, value, style = 0) {
  return '<c r="' + reference + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
    escapeXml(value) + "</t></is></c>";
}

function numberCell(reference, value, style = 0) {
  if (value == null || value === "") return '<c r="' + reference + '" s="' + style + '"/>';
  return '<c r="' + reference + '" s="' + style + '"><v>' + Number(value) + "</v></c>";
}

function formulaCell(reference, formula, cachedValue, style = 0) {
  return '<c r="' + reference + '" s="' + style + '"><f>' + escapeXml(formula) + "</f><v>" +
    Number(cachedValue) + "</v></c>";
}

function rowXml(index, cells, height = 22) {
  return '<row r="' + index + '" ht="' + height + '" customHeight="1">' + cells.join("") + "</row>";
}

function worksheetXml({ rows, widths, freezeAt = 6, filterRange = "", tabColor = "FF315A4A", dimension }) {
  const cols = widths.map((width, index) => '<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + width + '" customWidth="1"/>').join("");
  const filterXml = filterRange ? '<autoFilter ref="' + filterRange + '"/>' : "";
  const pane = freezeAt
    ? '<pane ySplit="' + freezeAt + '" topLeftCell="A' + (freezeAt + 1) + '" activePane="bottomLeft" state="frozen"/>'
    : "";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetPr><tabColor rgb="' + tabColor + '"/><pageSetUpPr fitToPage="1"/></sheetPr>' +
    (dimension ? '<dimension ref="' + dimension + '"/>' : "") +
    '<sheetViews><sheetView showGridLines="0" workbookViewId="0">' + pane + '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="21"/><cols>' + cols + "</cols><sheetData>" + rows.join("") + "</sheetData>" +
    filterXml + '<pageMargins left="0.3" right="0.3" top="0.45" bottom="0.45" header="0.2" footer="0.2"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
}

function formatHourRanges(hours, offIntervals = []) {
  return EquipmentHours.formatOperationRanges(hours, offIntervals);
}

function createHourlyRows({ projectName, from, to, startDate, days }) {
  const rows = [
    rowXml(1, [] , 8),
    rowXml(2, [inlineCell("A2", "RINCIAN JAM ALAT", 1)], 28),
    rowXml(3, [inlineCell("A3", projectName + "  ·  " + formatDate(from) + " – " + formatDate(to), 2)], 21),
    rowXml(4, [inlineCell("A4", "Durasi kerja per slot dalam jam; kosong = off.", 2)], 20),
    rowXml(5, [], 8)
  ];
  const headers = ["Week", "Tanggal", "Alat", ...HOURS.map((hour) => hour.slice(0, 2) + ":00–" + String(Number(hour.slice(0, 2)) + 1).padStart(2, "0") + ":00"), "Total jam", "Catatan"];
  rows.push(rowXml(6, headers.map((header, index) => inlineCell(columnName(index + 1) + "6", header, 3)), 30));

  const logRows = [];
  for (const day of days) {
    for (const item of day.equipmentLog || []) {
      const selected = new Set(EquipmentHours.normalizeHours(item.hours));
      const offIntervals = Array.isArray(item.offIntervals) ? item.offIntervals : [];
      const stats = EquipmentHours.calculate(selected, offIntervals);
      const row = logRows.length + 7;
      const cells = [
        numberCell("A" + row, weekNumber(day.entry_date, startDate), 4),
        inlineCell("B" + row, formatDate(day.entry_date), 4),
        inlineCell("C" + row, item.equipment, 0)
      ];
      for (let index = 0; index < HOURS.length; index++) {
        const slotMinutes = stats.slotMinutes[HOURS[index]];
        const slotHours = slotMinutes / 60;
        const style = slotMinutes === 0 ? 4 : slotMinutes === 60 ? 5 : 15;
        cells.push(numberCell(columnName(index + 4) + row, slotMinutes ? slotHours : null, style));
      }
      const total = stats.totalMinutes / 60;
      cells.push(formulaCell("L" + row, "SUM(D" + row + ":K" + row + ")", total, 16));
      cells.push(inlineCell("M" + row, item.note || "", 6));
      const rowHeight = Math.min(56, Math.max(26, 14 * Math.ceil((item.note || "").length / 36)));
      logRows.push({
        row,
        date: day.entry_date,
        week: weekNumber(day.entry_date, startDate),
        equipment: item.equipment,
        total,
        totalMinutes: stats.totalMinutes,
        hours: selected,
        offIntervals,
        slotMinutes: stats.slotMinutes,
        note: item.note || "",
        xml: rowXml(row, cells, rowHeight)
      });
    }
  }
  rows.push(...logRows.map((item) => item.xml));
  if (!logRows.length) rows.push(rowXml(7, [inlineCell("A7", "Belum ada jam alat pada periode ini.", 8)], 26));
  else {
    const totalRow = logRows.length + 7;
    const totalHours = logRows.reduce((sum, item) => sum + item.totalMinutes, 0) / 60;
    const cells = [inlineCell("A" + totalRow, "TOTAL JAM", 7), numberCell("B" + totalRow, null, 7), numberCell("C" + totalRow, null, 7)];
    for (let index = 0; index < HOURS.length; index++) {
      const col = columnName(index + 4);
      const cachedMinutes = logRows.reduce((sum, item) => sum + item.slotMinutes[HOURS[index]], 0);
      const cached = cachedMinutes / 60;
      cells.push(formulaCell(col + totalRow, "SUM(" + col + "7:" + col + (totalRow - 1) + ")", cached, 16));
    }
    cells.push(formulaCell("L" + totalRow, "SUM(L7:L" + (totalRow - 1) + ")", totalHours, 16));
    cells.push(numberCell("M" + totalRow, null, 7));
    rows.push(rowXml(totalRow, cells, 25));
  }
  const lastRow = logRows.length ? logRows.length + 7 : 7;
  return {
    rows,
    logRows,
    lastRow,
    xml: worksheetXml({
      rows,
      widths: [9, 23, 24, 14, 14, 14, 14, 14, 14, 14, 14, 13, 38],
      filterRange: logRows.length ? "A6:M" + (lastRow - 1) : "",
      dimension: "A1:M" + lastRow,
      tabColor: "FF9BAA9F"
    })
  };
}

function createReportRows({ projectName, from, to, startDate, logRows }) {
  const rows = [
    rowXml(1, [], 8),
    rowXml(2, [inlineCell("A2", "LAPORAN JAM ALAT BERAT", 1)], 30),
    rowXml(3, [inlineCell("A3", projectName + "  ·  " + formatDate(from) + " – " + formatDate(to), 2)], 22)
  ];
  const equipmentNames = new Set(logRows.map((item) => item.equipment));
  const activeDates = new Set(logRows.map((item) => item.date));
  const totalHours = logRows.reduce((sum, item) => sum + item.totalMinutes, 0) / 60;
  rows.push(rowXml(4, [
    inlineCell("A4", "TOTAL JAM", 9), numberCell("B4", totalHours, 17),
    inlineCell("C4", "HARI ALAT", 9), numberCell("D4", activeDates.size, 10),
    inlineCell("E4", "JENIS ALAT", 9), numberCell("F4", equipmentNames.size, 10)
  ], 30));
  rows.push(rowXml(5, [], 9));
  const headers = ["Week", "Tanggal", "Alat", "Jam operasi", "Total jam", "Catatan"];
  rows.push(rowXml(6, headers.map((header, index) => inlineCell(columnName(index + 1) + "6", header, 3)), 28));

  if (!logRows.length) rows.push(rowXml(7, [inlineCell("A7", "Belum ada jam alat pada periode ini.", 8)], 27));
  else {
    for (const item of logRows) {
      const row = item.row;
      const hourText = formatHourRanges(item.hours, item.offIntervals);
      const cells = [
        numberCell("A" + row, item.week, 4),
        inlineCell("B" + row, formatDate(item.date), 4),
        inlineCell("C" + row, item.equipment, 0),
        inlineCell("D" + row, hourText || "Tidak bekerja", 11),
        formulaCell("E" + row, "'Per Jam'!L" + item.row, item.total, 18),
        inlineCell("F" + row, item.note || "", 6)
      ];
      const hourLines = Math.ceil(hourText.length / 39);
      const noteLines = Math.ceil((item.note || "").length / 30);
      const rowHeight = Math.min(70, Math.max(30, 15 * Math.max(hourLines, noteLines, 1) + 6));
      rows.push(rowXml(row, cells, rowHeight));
    }
    const totalRow = logRows.length + 7;
    rows.push(rowXml(totalRow, [
      numberCell("A" + totalRow, null, 7),
      numberCell("B" + totalRow, null, 7),
      numberCell("C" + totalRow, null, 7),
      inlineCell("D" + totalRow, "TOTAL JAM", 14),
      formulaCell("E" + totalRow, "SUM(E7:E" + (totalRow - 1) + ")", totalHours, 16),
      numberCell("F" + totalRow, null, 7)
    ], 26));
  }

  const lastRow = logRows.length ? logRows.length + 7 : 7;
  return {
    xml: worksheetXml({
      rows,
      widths: [9, 21, 21, 43, 13, 34],
      filterRange: logRows.length ? "A6:F" + (lastRow - 1) : "",
      dimension: "A1:F" + lastRow,
      tabColor: "FF315A4A"
    }),
    lastRow
  };
}

function createSummaryRows({ logRows }) {
  const totals = new Map();
  for (const item of logRows) totals.set(item.equipment, (totals.get(item.equipment) || 0) + item.totalMinutes);
  const rows = [
    rowXml(1, [], 8),
    rowXml(2, [inlineCell("A2", "REKAP TOTAL PER ALAT", 1)], 30),
    rowXml(3, [inlineCell("A3", "Jumlah jam berasal dari pilihan pada lembar Per Jam.", 2)], 22),
    rowXml(4, [], 8),
    rowXml(5, [], 8),
    rowXml(6, [inlineCell("A6", "Alat", 3), inlineCell("B6", "Total jam", 3)], 28)
  ];
  const equipment = [...totals.entries()].sort(([left], [right]) => left.localeCompare(right, "id"));
  if (!equipment.length) rows.push(rowXml(7, [inlineCell("A7", "Belum ada jam alat pada periode ini.", 8)], 27));
  equipment.forEach(([name, minutes], index) => {
    const row = index + 7;
    rows.push(rowXml(row, [inlineCell("A" + row, name, 0), formulaCell("B" + row,
      "SUMIF('Per Jam'!$C$7:$C$" + (logRows.length + 6) + ",A" + row + ",'Per Jam'!$L$7:$L$" + (logRows.length + 6) + ")", minutes / 60, 18)], 28));
  });
  if (equipment.length) {
    const row = equipment.length + 7;
    const total = equipment.reduce((sum, [, minutes]) => sum + minutes, 0) / 60;
    rows.push(rowXml(row, [inlineCell("A" + row, "TOTAL", 7), formulaCell("B" + row, "SUM(B7:B" + (row - 1) + ")", total, 16)], 26));
  }
  const lastRow = equipment.length ? equipment.length + 7 : 7;
  return {
    xml: worksheetXml({
      rows,
      widths: [34, 17],
      filterRange: equipment.length ? "A6:B" + (equipment.length + 6) : "",
      dimension: "A1:B" + lastRow,
      tabColor: "FFB7C4BA"
    }),
    lastRow
  };
}

function stylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.##"/></numFmts>' +
    '<fonts count="7">' +
    '<font><sz val="10"/><color rgb="FF29322F"/><name val="Aptos"/></font>' +
    '<font><b/><sz val="16"/><color rgb="FF234538"/><name val="Aptos Display"/></font>' +
    '<font><sz val="10"/><i/><color rgb="FF68746E"/><name val="Aptos"/></font>' +
    '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Aptos"/></font>' +
    '<font><sz val="10"/><color rgb="FF315A4A"/><name val="Aptos"/></font>' +
    '<font><b/><sz val="9"/><color rgb="FF68746E"/><name val="Aptos"/></font>' +
    '<font><b/><sz val="13"/><color rgb="FF234538"/><name val="Aptos"/></font>' +
    '</fonts>' +
    '<fills count="5">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF315A4A"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF1EC"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F6F3"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="4">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="hair"><color rgb="FFDCE4DE"/></bottom><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FF315A4A"/></bottom><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFFFFFFF"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="19">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="3" fillId="2" borderId="3" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="5" fillId="4" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="6" fillId="4" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="6" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="4" fillId="3" borderId="2" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>' +
    '<xf numFmtId="164" fontId="4" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="164" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="164" fontId="6" fillId="4" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="164" fontId="6" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

function definedNamesXml(reportLastRow, hourlyLastRow, summaryLastRow) {
  const entries = [
    '<definedName name="_xlnm.Print_Area" localSheetId="0">\'Laporan\'!$A$1:$F$' + reportLastRow + '</definedName>',
    '<definedName name="_xlnm.Print_Titles" localSheetId="0">\'Laporan\'!$1:$6</definedName>',
    '<definedName name="_xlnm.Print_Area" localSheetId="1">\'Per Jam\'!$A$1:$M$' + hourlyLastRow + '</definedName>',
    '<definedName name="_xlnm.Print_Titles" localSheetId="1">\'Per Jam\'!$1:$6</definedName>',
    '<definedName name="_xlnm.Print_Area" localSheetId="2">\'Rekap alat\'!$A$1:$B$' + summaryLastRow + '</definedName>',
    '<definedName name="_xlnm.Print_Titles" localSheetId="2">\'Rekap alat\'!$1:$6</definedName>'
  ];
  return '<definedNames>' + entries.join("") + '</definedNames>';
}

async function makeEquipmentWorkbook(JSZip, options) {
  const zip = new JSZip();
  const hourly = createHourlyRows(options);
  const report = createReportRows({ ...options, logRows: hourly.logRows });
  const summary = createSummaryRows({ logRows: hourly.logRows });
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  zip.file("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0" firstSheet="0"/></bookViews>' +
    '<sheets><sheet name="Laporan" sheetId="1" r:id="rId1"/><sheet name="Per Jam" sheetId="2" r:id="rId2"/><sheet name="Rekap alat" sheetId="3" r:id="rId3"/></sheets>' +
    definedNamesXml(report.lastRow, hourly.lastRow, summary.lastRow) + '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');
  zip.file("xl/styles.xml", stylesXml());
  zip.file("xl/worksheets/sheet1.xml", report.xml);
  zip.file("xl/worksheets/sheet2.xml", hourly.xml);
  zip.file("xl/worksheets/sheet3.xml", summary.xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

module.exports = { makeEquipmentWorkbook, formatHourRanges };

