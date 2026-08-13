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
 * Prefixes with a single quote so Google Sheets treats it strictly as text.
 * @param {*} phone - Raw phone number input.
 * @returns {string} Formatted string with single quote prefix if non-empty.
 */
function formatPhoneForStorage(phone) {
  if (phone === null || phone === undefined) return '';
  var clean = String(phone).trim();
  if (!clean) return '';
  clean = clean.replace(/^'+/, '');
  if (/^8\d{8,12}$/.test(clean)) {
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
  if (/^8\d{8,12}$/.test(clean)) {
    clean = '0' + clean;
  }
  return clean;
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
