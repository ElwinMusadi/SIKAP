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
