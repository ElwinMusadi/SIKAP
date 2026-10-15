// ============================================================
// Utils.gs — Utility Functions
// ============================================================

/**
 * Generates a UUID v4 token.
 * @returns {string} A UUID string.
 */
function generateUUID() {
  return Utilities.getUuid();
}

/**
 * Hashes a password using SHA-256.
 * SECURITY REVIEW ITEM: SHA-256 is the strongest native option in GAS.
 * Consider salt + multiple iterations before production.
 * @param {string} password - The plain text password.
 * @returns {string} The hex-encoded SHA-256 hash.
 */
function hashPassword(password) {
  var rawHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password,
    Utilities.Charset.UTF_8
  );
  var hexHash = rawHash.map(function(byte) {
    // Convert signed byte to unsigned
    var v = (byte < 0) ? byte + 256 : byte;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
  return hexHash;
}

/**
 * Gets the current timestamp in WITA timezone.
 * @returns {string} ISO-formatted timestamp.
 */
function getTimestamp() {
  return Utilities.formatDate(
    new Date(),
    'Asia/Makassar',
    "yyyy-MM-dd'T'HH:mm:ss"
  );
}

/**
 * Generates a default password from the last 6 digits of a NIP.
 * @param {string} nip - The NIP.
 * @returns {string} The default password (last 6 digits).
 */
function getDefaultPassword(nip) {
  if (!nip || nip.length < 6) return nip || '';
  return nip.slice(-6);
}

/**
 * Formats a phone number for storage in Google Sheets to preserve leading zero.
 * Normalizes +62/62 prefixes to standard 08xx representation.
 * Prefixes with a single quote so Google Sheets treats it strictly as text.
 * @param {*} phone - Raw phone number input.
 * @returns {string} Formatted string with single quote prefix if non-empty.
 */
function formatPhoneForStorage(phone) {
  if (phone === null || phone === undefined) return '';
  var clean = String(phone).trim();
  if (!clean) return '';
  clean = clean.replace(/^'+/, '').replace(/[\s\-]/g, '');
  if (clean.indexOf('+62') === 0) {
    clean = '0' + clean.slice(3);
  } else if (clean.indexOf('62') === 0 && clean.length > 9) {
    clean = '0' + clean.slice(2);
  } else if (/^8\d{8,12}$/.test(clean)) {
    clean = '0' + clean;
  }
  return "'" + clean;
}

/**
 * Formats a phone number for display/API response, stripping leading single quote
 * and restoring leading zero if missing.
 * @param {*} phone - Raw value from spreadsheet.
 * @returns {string} Cleaned phone number string with leading zero.
 */
function formatPhoneForDisplay(phone) {
  if (phone === null || phone === undefined) return '';
  var clean = String(phone).replace(/^'+/, '').trim();
  if (!clean) return '';
  var unformatted = clean.replace(/[\s\-]/g, '');
  if (unformatted.indexOf('+62') === 0) {
    clean = '0' + unformatted.slice(3);
  } else if (unformatted.indexOf('62') === 0 && unformatted.length > 9) {
    clean = '0' + unformatted.slice(2);
  } else if (/^8\d{8,12}$/.test(unformatted)) {
    clean = '0' + unformatted;
  }
  return clean;
}

/**
 * Validates phone number format.
 * Accepts standard Indonesian mobile numbers (08xx, +628xx, 628xx, 10-15 digits) or landlines.
 * @param {*} phone - Phone input to test.
 * @returns {boolean} True if valid or empty.
 */
function isValidPhoneNumber(phone) {
  if (phone === null || phone === undefined) return true;
  var str = String(phone).replace(/^'+/, '').trim();
  if (!str) return true; // Optional field
  var clean = str.replace(/[\s\-]/g, '');
  return /^(\+62|62|0)8[1-9][0-9]{6,11}$/.test(clean) || /^(0[2-9][0-9]{1,3})[0-9]{5,8}$/.test(clean);
}

/**
 * Validates email format strictly without altering case.
 * @param {*} email - Email input to test.
 * @returns {boolean} True if valid or empty.
 */
function isValidEmail(email) {
  if (email === null || email === undefined) return true;
  var str = String(email).trim();
  if (!str) return true; // Optional field
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(str);
}

/**
 * Formats a date value from spreadsheet into a display string in WITA.
 * @param {*} val - Date object, ISO string, or number.
 * @returns {string} Formatted date string (e.g. "13 Aug 2026, 22:30").
 */
function formatDateForDisplay(val) {
  try {
    if (!val || val === '-') return '-';
    var d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return Utilities.formatDate(d, 'Asia/Makassar', 'dd MMM yyyy, HH:mm');
  } catch (e) {
    return String(val);
  }
}

/**
 * Formats a date value (Date object, string, timestamp) into YYYY-MM-DD string.
 * @param {*} val - Date input.
 * @returns {string} Formatted date (YYYY-MM-DD) or empty string.
 */
function formatDateOnly(val) {
  try {
    if (!val || val === '-') return '';
    var d = new Date(val);
    if (isNaN(d.getTime())) {
      var str = String(val).trim();
      return str === '-' ? '' : str;
    }
    return Utilities.formatDate(d, 'Asia/Makassar', 'yyyy-MM-dd');
  } catch (e) {
    return String(val || '').trim();
  }
}

/**
 * Formats NIK for storage with a leading quote to prevent spreadsheet numeric scientific notation/overflow.
 * @param {*} nik - Raw NIK input.
 * @returns {string} Formatted NIK with leading single quote.
 */
function formatNikForStorage(nik) {
  if (nik === null || nik === undefined) return '';
  var clean = String(nik).replace(/^'+/, '').trim();
  return clean ? "'" + clean : '';
}

/**
 * Formats NIK for display/API response, stripping leading single quote.
 * @param {*} nik - Raw NIK value from sheet.
 * @returns {string} Cleaned NIK string.
 */
function formatNikForDisplay(nik) {
  if (nik === null || nik === undefined) return '';
  return String(nik).replace(/^'+/, '').trim();
}

/**
 * Checks if a NIK is already registered to another employee in Data_Pegawai.
 * @param {string} nik - The 16-digit NIK to check.
 * @param {string} [excludeNip] - Optional NIP to exclude (for update operations).
 * @returns {boolean} True if duplicate NIK is found.
 */
function isNikDuplicate(nik, excludeNip) {
  if (!nik) return false;
  var cleanNik = String(nik).replace(/^'+/, '').trim();
  if (!cleanNik) return false;

  var allData = getAllData(SHEET_NAMES.DATA_PEGAWAI);
  for (var i = 0; i < allData.length; i++) {
    var rowNip = String(allData[i][COL_PEGAWAI.NIP] || '').replace(/^'+/, '').trim();
    if (excludeNip && rowNip === String(excludeNip).replace(/^'+/, '').trim()) {
      continue;
    }
    var rowNik = String(allData[i][COL_PEGAWAI.NIK] || '').replace(/^'+/, '').trim();
    if (rowNik === cleanNik) {
      return true;
    }
  }
  return false;
}

/**
 * Escapes a string to prevent Spreadsheet Formula Injection (CSV/Formula Injection).
 * If a string begins with '=', '+', '-', '@', '\t', or '\r', it prefixes with a single quote.
 * @param {*} val - Input string.
 * @returns {string} Sanitized string safe for Google Sheets.
 */
function escapeFormula(val) {
  if (val === null || val === undefined) return '';
  var str = String(val).trim();
  if (!str) return '';
  if (/^[=+\-@\t\r]/.test(str)) {
    return "'" + str;
  }
  return str;
}

/**
 * Unescapes a string retrieved from Google Sheets that might have been escaped for formula prevention.
 * @param {*} val - Value from sheet.
 * @returns {string} Clean string.
 */
function unescapeFormula(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/^'+/, '').trim();
}

/**
 * Helper to map a raw Data_Pegawai row array into a structured employee object.
 * @param {Array} d - Array of column values from Data_Pegawai.
 * @returns {Object|null} Structured employee data object or null.
 */
function _mapPegawaiRowToObject(d) {
  if (!d || !d.length) return null;
  var fotoDriveId = String(d[COL_PEGAWAI.FOTO_DRIVE_ID] || '').replace(/^'+/, '').trim();
  var fotoUrl = fotoDriveId ? 'https://drive.google.com/thumbnail?id=' + fotoDriveId + '&sz=w500' : '';

  return {
    // IDENTITAS
    fotoDriveId: fotoDriveId,
    fotoUrl: fotoUrl,
    nip: String(d[COL_PEGAWAI.NIP] || '').replace(/^'+/, '').trim(),
    nik: formatNikForDisplay(d[COL_PEGAWAI.NIK]),
    nama: unescapeFormula(d[COL_PEGAWAI.NAMA_LENGKAP]),
    tempatLahir: unescapeFormula(d[COL_PEGAWAI.TEMPAT_LAHIR]),
    tanggalLahir: formatDateOnly(d[COL_PEGAWAI.TANGGAL_LAHIR]),
    jenisKelamin: unescapeFormula(d[COL_PEGAWAI.JENIS_KELAMIN]),
    agama: unescapeFormula(d[COL_PEGAWAI.AGAMA]),
    pendidikanTerakhir: unescapeFormula(d[COL_PEGAWAI.PENDIDIKAN_TERAKHIR]),
    statusPernikahan: unescapeFormula(d[COL_PEGAWAI.STATUS_PERNIKAHAN]),
    golonganDarah: unescapeFormula(d[COL_PEGAWAI.GOLONGAN_DARAH]),

    // KEPEGAWAIAN
    statusKepegawaian: unescapeFormula(d[COL_PEGAWAI.STATUS_KEPEGAWAIAN]),
    pangkatGolongan: unescapeFormula(d[COL_PEGAWAI.PANGKAT_GOLONGAN]),
    tmtPangkat: formatDateOnly(d[COL_PEGAWAI.TMT_PANGKAT]),
    jabatan: unescapeFormula(d[COL_PEGAWAI.JABATAN]),
    jenisJabatan: unescapeFormula(d[COL_PEGAWAI.JENIS_JABATAN]),
    tmtJabatan: formatDateOnly(d[COL_PEGAWAI.TMT_JABATAN]),
    unitOrganisasi: unescapeFormula(d[COL_PEGAWAI.UNIT_ORGANISASI]),

    // KONTAK
    noHp: formatPhoneForDisplay(d[COL_PEGAWAI.NO_HP]),
    email: unescapeFormula(d[COL_PEGAWAI.EMAIL]),
    alamat: unescapeFormula(d[COL_PEGAWAI.ALAMAT]),

    // SYSTEM
    role: unescapeFormula(d[COL_PEGAWAI.ROLE] || 'Pegawai'),
    statusAkun: unescapeFormula(d[COL_PEGAWAI.STATUS_AKUN] || 'Aktif'),
    folderDriveId: String(d[COL_PEGAWAI.FOLDER_DRIVE_ID] || '').replace(/^'+/, '').trim()
  };
}

