const SHARED_TOKEN = "replace-with-a-private-token";
const DEFAULT_SHEET_NAME = "Sheet1";

const HEADERS = [
  "Customer Name",
  "Mobile",
  "Date",
  "Vehicle Reg. No.",
  "Make-Model",
  "Variant",
  "Avg. km/mo",
  "Odo Reading",
  "Type of Service",
  "Tyre Position",
  "Brand",
  "Platform",
  "Size",
  "NSD",
  "Fitment Year"
];

function doPost(e) {
  try {
    if (SHARED_TOKEN && (!e.parameter || e.parameter.token !== SHARED_TOKEN)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    const body = JSON.parse(e.postData.contents || "{}");
    const rows = normalizeRows(body.rows);
    if (!rows.length) {
      return jsonResponse({ ok: false, error: "No rows provided" }, 400);
    }

    const sheet = getTargetSheet(body.sheetName || DEFAULT_SHEET_NAME);
    ensureHeaders(sheet);
    const duplicateCount = countDuplicateRows(sheet, rows);
    if (duplicateCount > 0) {
      return jsonResponse({
        ok: false,
        duplicate: true,
        error: "Warning: this data has already been entered.",
        duplicateRows: duplicateCount,
        sheetName: sheet.getName(),
        lastRow: sheet.getLastRow()
      }, 409);
    }

    const appendRange = sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length);
    appendRange
      .setValues(rows)
      .setFontSize(11);

    return jsonResponse({
      ok: true,
      appendedRows: rows.length,
      sheetName: sheet.getName(),
      lastRow: sheet.getLastRow()
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error && error.message ? error.message : error) }, 500);
  }
}

function doGet() {
  return jsonResponse({
    ok: true,
    message: "Screenshot Sheet Updater webhook is running",
    sheetName: DEFAULT_SHEET_NAME,
    columns: HEADERS
  });
}

function getTargetSheet(sheetName) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
}

function ensureHeaders(sheet) {
  const current = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const hasHeaders = current.some(function (value) {
    return String(value || "").trim() !== "";
  });
  if (!hasHeaders) {
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setValues([HEADERS])
      .setFontSize(11);
    sheet.setFrozenRows(1);
  }
}

function countDuplicateRows(sheet, rows) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return 0;
  }

  const existingRows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const existingKeys = {};
  existingRows.forEach(function (row) {
    existingKeys[rowKey(row)] = true;
  });

  return rows.filter(function (row) {
    return existingKeys[rowKey(row)];
  }).length;
}

function rowKey(row) {
  return row.slice(0, HEADERS.length).map(function (value) {
    return String(value === null || value === undefined ? "" : value)
      .trim()
      .toLowerCase();
  }).join("||");
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .filter(function (row) {
      return Array.isArray(row);
    })
    .map(function (row) {
      const normalized = row.slice(0, HEADERS.length);
      while (normalized.length < HEADERS.length) {
        normalized.push("");
      }
      return normalized.map(function (value) {
        return value === null || value === undefined ? "" : value;
      });
    });
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
