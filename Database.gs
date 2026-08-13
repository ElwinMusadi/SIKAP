// ============================================================
// Database.gs — Spreadsheet Abstraction Layer
// ============================================================

// IMPORTANT: Replace this with your actual Google Spreadsheet ID
var SPREADSHEET_ID = "1invRr53Flh2RuAoac1QkGA02Hn1jKg45to7p-H2du14";

// Sheet names (must match the actual sheet tabs)
var SHEET_NAMES = {
  DATA_PEGAWAI: "Data_Pegawai",
  MASTER_DOKUMEN: "Master_Dokumen",
  ARSIP_DOKUMEN: "Arsip_Dokumen",
  SESI_LOGIN: "Sesi_Login",
  LOG_AKTIVITAS: "Log_Aktivitas",
};

// Column indices for Data_Pegawai (0-based)
var COL_PEGAWAI = {
  NIP: 0,
  PASSWORD_HASH: 1,
  ROLE: 2,
  STATUS_AKUN: 3,
  NAMA_LENGKAP: 4,
  STATUS_KEPEGAWAIAN: 5,
  PANGKAT_GOLONGAN: 6,
  JABATAN: 7,
  NO_HP: 8,
  ALAMAT: 9,
  FOLDER_DRIVE_ID: 10,
  EMAIL: 11,
  GOLONGAN_DARAH: 12
};

// Column indices for Sesi_Login (0-based)
var COL_SESI = {
  TOKEN_ID: 0,
  NIP: 1,
  WAKTU_DIBUAT: 2,
  WAKTU_EXPIRED: 3,
};

// Column indices for Log_Aktivitas (0-based)
var COL_LOG = {
  LOG_ID: 0,
  TIMESTAMP: 1,
  ACTOR_NIP: 2,
  ACTOR_ROLE: 3,
  ACTION: 4,
  TARGET_TYPE: 5,
  TARGET_ID: 6,
  DESCRIPTION: 7,
  RESULT: 8,
};

// Column indices for Master_Dokumen (0-based)
var COL_MASTER_DOKUMEN = {
  ID_DOKUMEN: 0,
  NAMA_DOKUMEN: 1,
  KATEGORI: 2,
  STATUS_WAJIB: 3,
};

/**
 * Gets the spreadsheet instance (cached per execution).
 */
var _spreadsheet = null;
function getSpreadsheet() {
  if (!_spreadsheet) {
    _spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return _spreadsheet;
}

/**
 * Gets a specific sheet by name.
 * @param {string} sheetName - The sheet tab name.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet(sheetName) {
  return getSpreadsheet().getSheetByName(sheetName);
}

/**
 * Gets all data from a sheet as a 2D array (excluding header row).
 * Uses batch read for performance.
 * @param {string} sheetName - The sheet tab name.
 * @returns {Array[]} 2D array of cell values.
 */
function getAllData(sheetName) {
  var sheet = getSheet(sheetName);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  // Remove header row
  if (data.length > 0) data.shift();
  return data;
}

/**
 * Finds a row by primary key (column A / index 0).
 * @param {string} sheetName - The sheet tab name.
 * @param {string} key - The primary key value to search for.
 * @returns {Object|null} { rowIndex (1-based), data (array) } or null.
 */
function findByPrimaryKey(sheetName, key) {
  var sheet = getSheet(sheetName);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    // skip header
    if (String(data[i][0]) === String(key)) {
      return { rowIndex: i + 1, data: data[i] };
    }
  }
  return null;
}

/**
 * Appends a row to a sheet.
 * @param {string} sheetName - The sheet tab name.
 * @param {Array} rowData - Array of values to append.
 */
function appendRow(sheetName, rowData) {
  var sheet = getSheet(sheetName);
  if (sheet) {
    sheet.appendRow(rowData);
    SpreadsheetApp.flush();
  }
}

/**
 * Updates a specific cell value.
 * @param {string} sheetName - The sheet tab name.
 * @param {number} row - 1-based row index.
 * @param {number} col - 1-based column index.
 * @param {*} value - The value to set.
 */
function updateCell(sheetName, row, col, value) {
  var sheet = getSheet(sheetName);
  if (sheet) {
    sheet.getRange(row, col).setValue(value);
    SpreadsheetApp.flush();
  }
}

/**
 * Deletes rows matching a primary key (column A).
 * Used primarily for session cleanup.
 * @param {string} sheetName - The sheet tab name.
 * @param {string} key - The primary key value.
 */
function deleteByPrimaryKey(sheetName, key) {
  var sheet = getSheet(sheetName);
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  // Delete from bottom to top to preserve row indices
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(key)) {
      sheet.deleteRow(i + 1);
    }
  }
  SpreadsheetApp.flush();
}

/**
 * Batch-updates multiple columns in a single row.
 * More efficient than calling updateCell() for each column.
 * @param {string} sheetName - The sheet tab name.
 * @param {number} rowIndex - 1-based row index.
 * @param {Object} fields - Map of { columnIndex (0-based): value }.
 */
function updateRowFields(sheetName, rowIndex, fields) {
  var sheet = getSheet(sheetName);
  if (!sheet) return;
  for (var colIndex in fields) {
    var col = parseInt(colIndex, 10) + 1; // Convert to 1-based
    sheet.getRange(rowIndex, col).setValue(fields[colIndex]);
  }
  SpreadsheetApp.flush();
}

/**
 * Finds rows matching a value in a given column.
 * @param {string} sheetName - The sheet tab name.
 * @param {number} colIndex - 0-based column index to search.
 * @param {string} value - The value to match.
 * @returns {Array} Array of { rowIndex (1-based), data (array) } matches.
 */
function findAllByColumnValue(sheetName, colIndex, value) {
  var sheet = getSheet(sheetName);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var results = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][colIndex]) === String(value)) {
      results.push({ rowIndex: i + 1, data: data[i] });
    }
  }
  return results;
}
