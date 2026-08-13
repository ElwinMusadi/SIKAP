// ============================================================
// Dokumen.gs — Document Management Engine
// Handles: Master docs, Arsip docs, Google Drive upload,
// auto-folder, auto-rename, re-upload overwrite, preview.
// All functions require valid session via authorize().
// Note: COL_ARSIP and DOC_STATUS are defined in Pegawai.gs
//       COL_MASTER_DOKUMEN is defined in Database.gs
// ============================================================

// Root folder name in Google Drive
var DRIVE_ROOT_FOLDER_NAME = 'SIKAP_Dokumen_Kepegawaian';

// Allowed MIME types mapped to their extension
var ALLOWED_MIME_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png'
};

// Max file size in bytes (5 MB)
var MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

// ============================================================
// DRIVE FOLDER MANAGEMENT
// ============================================================

/**
 * Gets or creates the root SIKAP folder in Google Drive.
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function _getSikapRootFolder() {
  var folders = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(DRIVE_ROOT_FOLDER_NAME);
}

/**
 * Gets or creates a subfolder inside a parent folder by name.
 * @param {GoogleAppsScript.Drive.Folder} parent
 * @param {string} name
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function _getOrCreateSubFolder(parent, name) {
  var sub = parent.getFoldersByName(name);
  if (sub.hasNext()) {
    return sub.next();
  }
  return parent.createFolder(name);
}

/**
 * Gets or creates the personal Drive folder for an employee.
 * Folder path: SIKAP_Dokumen_Kepegawaian / [StatusKepegawaian] / [NIP]_[NamaLengkap]
 * If the employee already has a Folder_Drive_ID stored, that folder is returned.
 * Otherwise, creates the folder hierarchy and persists the Folder_Drive_ID.
 *
 * @param {string} nip - Employee NIP.
 * @returns {GoogleAppsScript.Drive.Folder} The personal employee folder.
 */
function getOrCreateEmployeeFolder(nip) {
  var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nip);
  if (!user) throw new Error('Pegawai tidak ditemukan: ' + nip);

  var d = user.data;
  var existingFolderId = d[COL_PEGAWAI.FOLDER_DRIVE_ID];

  // Return existing folder if we already have the ID
  if (existingFolderId && String(existingFolderId).trim() !== '') {
    try {
      return DriveApp.getFolderById(existingFolderId);
    } catch (e) {
      // Folder deleted externally — recreate below
      Logger.log('Folder ID ' + existingFolderId + ' no longer exists. Recreating.');
    }
  }

  // Build path: root / status / NIP_Nama
  var nama   = d[COL_PEGAWAI.NAMA_LENGKAP];
  var status = d[COL_PEGAWAI.STATUS_KEPEGAWAIAN] || 'Lainnya';
  var folderName = nip + '_' + nama;

  var root       = _getSikapRootFolder();
  var statusFolder = _getOrCreateSubFolder(root, status);
  var empFolder  = _getOrCreateSubFolder(statusFolder, folderName);

  // Persist the Folder_Drive_ID back to the spreadsheet
  updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, {
    [COL_PEGAWAI.FOLDER_DRIVE_ID]: empFolder.getId()
  });

  return empFolder;
}

// ============================================================
// DOCUMENT QUERIES
// ============================================================

/**
 * Returns master documents + current archive status for the logged-in employee.
 * @param {string} token - Session token.
 * @returns {Object} { success, data: { pct, counts, tableRows } }
 */
function getArsipDokumenPegawai(token) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var nip = auth.session.nip;

    var masterDocs = getAllData(SHEET_NAMES.MASTER_DOKUMEN);
    var allArsip   = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);

    // Index latest archive per doc for this employee { ID_Dokumen: arsipRow }
    var myArsip = {};
    for (var a = 0; a < allArsip.length; a++) {
      var row = allArsip[a];
      if (String(row[COL_ARSIP.NIP]) !== String(nip)) continue;
      var docId = row[COL_ARSIP.ID_DOKUMEN];
      // Later rows overwrite earlier — last appended row is authoritative
      myArsip[docId] = row;
    }

    var counts = { terverifikasi: 0, menunggu: 0, ditolak: 0, belumUnggah: 0 };
    var wajibTotal    = 0;
    var wajibVerified = 0;
    var tableRows     = [];

    for (var m = 0; m < masterDocs.length; m++) {
      var doc      = masterDocs[m];
      var id       = doc[COL_MASTER_DOKUMEN.ID_DOKUMEN];
      var nama     = doc[COL_MASTER_DOKUMEN.NAMA_DOKUMEN];
      var kategori = doc[COL_MASTER_DOKUMEN.KATEGORI];
      var wajib    = doc[COL_MASTER_DOKUMEN.STATUS_WAJIB]; // 'Ya' | 'Tidak'

      var arsipRow = myArsip[id];
      var status, waktuUpload, catatan, idArsip, fileUrl, fileDriveId;

      if (arsipRow) {
        idArsip     = arsipRow[COL_ARSIP.ID_ARSIP];
        status      = arsipRow[COL_ARSIP.STATUS_VERIFIKASI];
        waktuUpload = arsipRow[COL_ARSIP.WAKTU_UPLOAD];
        catatan     = arsipRow[COL_ARSIP.CATATAN_ADMIN] || '';
        fileUrl     = arsipRow[COL_ARSIP.FILE_URL] || '';
        fileDriveId = arsipRow[COL_ARSIP.FILE_DRIVE_ID] || '';
      } else {
        idArsip     = '';
        status      = DOC_STATUS.BELUM_UNGGAH;
        waktuUpload = '';
        catatan     = '';
        fileUrl     = '';
        fileDriveId = '';
      }

      // Tally counts
      if (status === DOC_STATUS.TERVERIFIKASI)  counts.terverifikasi++;
      else if (status === DOC_STATUS.MENUNGGU)  counts.menunggu++;
      else if (status === DOC_STATUS.DITOLAK)   counts.ditolak++;
      else                                      counts.belumUnggah++;

      if (wajib === 'Ya') {
        wajibTotal++;
        if (status === DOC_STATUS.TERVERIFIKASI) wajibVerified++;
      }

      tableRows.push({
        idArsip:     idArsip,
        idDokumen:   id,
        nama:        nama,
        kategori:    kategori,
        wajib:       wajib,
        status:      status,
        waktuUpload: waktuUpload ? _formatDate(waktuUpload) : '-',
        catatan:     catatan,
        fileUrl:     fileUrl,
        fileDriveId: fileDriveId
      });
    }

    var pct = wajibTotal > 0 ? Math.round((wajibVerified / wajibTotal) * 100) : 0;

    return {
      success: true,
      data: {
        nip:           nip,
        nama:          auth.session.nama,
        pct:           pct,
        wajibTotal:    wajibTotal,
        wajibVerified: wajibVerified,
        counts:        counts,
        tableRows:     tableRows
      }
    };
  } catch (e) {
    Logger.log('getArsipDokumenPegawai error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Returns preview metadata for a single archive record.
 * Only the owning employee or an Admin may request this.
 * @param {string} token    - Session token.
 * @param {string} idArsip  - ID_Arsip primary key.
 * @returns {Object} { success, data }
 */
function getDokumenPreview(token, idArsip) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var arsipRecord = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsip);
    if (!arsipRecord) {
      return { success: false, message: 'Dokumen tidak ditemukan.' };
    }

    var ar       = arsipRecord.data;
    var ownerNip = String(ar[COL_ARSIP.NIP]);

    // Ownership / Admin check
    if (auth.session.role !== ROLES.ADMIN && String(auth.session.nip) !== ownerNip) {
      return { success: false, message: 'Anda tidak memiliki akses ke dokumen ini.' };
    }

    var fileDriveId = ar[COL_ARSIP.FILE_DRIVE_ID];
    if (!fileDriveId || String(fileDriveId).trim() === '') {
      return { success: false, message: 'File belum tersedia di Google Drive.' };
    }

    var previewUrl  = 'https://drive.google.com/file/d/' + fileDriveId + '/preview';
    var downloadUrl = 'https://drive.google.com/uc?export=download&id=' + fileDriveId;

    // Resolve master doc name
    var masterDoc   = findByPrimaryKey(SHEET_NAMES.MASTER_DOKUMEN, ar[COL_ARSIP.ID_DOKUMEN]);
    var namaDokumen = masterDoc
      ? masterDoc.data[COL_MASTER_DOKUMEN.NAMA_DOKUMEN]
      : ar[COL_ARSIP.ID_DOKUMEN];

    // Resolve verifier name
    var nipVerifier  = ar[COL_ARSIP.NIP_VERIFIER] || '';
    var namaVerifier = '';
    if (nipVerifier) {
      var verifierUser = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nipVerifier);
      if (verifierUser) namaVerifier = verifierUser.data[COL_PEGAWAI.NAMA_LENGKAP];
    }

    return {
      success: true,
      data: {
        idArsip:          idArsip,
        idDokumen:        ar[COL_ARSIP.ID_DOKUMEN],
        namaDokumen:      namaDokumen,
        ownerNip:         ownerNip,
        statusVerifikasi: ar[COL_ARSIP.STATUS_VERIFIKASI],
        catatanAdmin:     ar[COL_ARSIP.CATATAN_ADMIN] || '',
        waktuUpload:      ar[COL_ARSIP.WAKTU_UPLOAD]      ? _formatDate(ar[COL_ARSIP.WAKTU_UPLOAD])      : '-',
        waktuVerifikasi:  ar[COL_ARSIP.WAKTU_VERIFIKASI]  ? _formatDate(ar[COL_ARSIP.WAKTU_VERIFIKASI])  : '-',
        nipVerifier:      nipVerifier,
        namaVerifier:     namaVerifier,
        previewUrl:       previewUrl,
        downloadUrl:      downloadUrl,
        fileDriveId:      fileDriveId
      }
    };
  } catch (e) {
    Logger.log('getDokumenPreview error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

// ============================================================
// FILE UPLOAD
// ============================================================

/**
 * Uploads a document to Google Drive and records it in Arsip_Dokumen.
 * Handles first-time uploads and re-uploads (overwrites old file via trash).
 *
 * @param {string} token      - Session token.
 * @param {string} idDokumen  - Master_Dokumen ID (e.g. 'DOC-KTP').
 * @param {string} base64Data - Base64-encoded file content (without data URI prefix).
 * @param {string} mimeType   - MIME type (e.g. 'application/pdf').
 * @returns {Object} { success, message, data: { idArsip, status, fileUrl, fileName } }
 */
function uploadDokumen(token, idDokumen, base64Data, mimeType) {
  try {
    // ---- Auth ----
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var nip  = auth.session.nip;
    var nama = auth.session.nama;

    // ---- Validate idDokumen exists in Master_Dokumen ----
    var masterDoc = findByPrimaryKey(SHEET_NAMES.MASTER_DOKUMEN, idDokumen);
    if (!masterDoc) {
      return { success: false, message: 'Jenis dokumen tidak valid.' };
    }
    var namaDokumen = masterDoc.data[COL_MASTER_DOKUMEN.NAMA_DOKUMEN];

    // ---- Validate MIME type ----
    var cleanMime = String(mimeType).toLowerCase().trim();
    var ext = ALLOWED_MIME_TYPES[cleanMime];
    if (!ext) {
      return {
        success: false,
        message: 'Format file tidak diizinkan. Hanya PDF, JPG, dan PNG yang diterima.'
      };
    }

    // ---- Validate file size (decoded bytes ≈ base64.length × 0.75) ----
    var approxBytes = Math.ceil(base64Data.length * 0.75);
    if (approxBytes > MAX_FILE_SIZE_BYTES) {
      return {
        success: false,
        message: 'Ukuran file melebihi batas maksimal 5 MB.'
      };
    }

    // ---- Check for existing archive record for this doc ----
    var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
    var existingArsipRow   = null;
    var existingArsipIndex = -1; // 1-based row in sheet

    for (var i = 0; i < allArsip.length; i++) {
      if (String(allArsip[i][COL_ARSIP.NIP])        === String(nip) &&
          String(allArsip[i][COL_ARSIP.ID_DOKUMEN]) === String(idDokumen)) {
        existingArsipRow   = allArsip[i];
        existingArsipIndex = i + 2; // +1 header row, +1 to convert to 1-based
      }
    }

    // ---- Prevent duplicate submission if already Menunggu ----
    if (existingArsipRow &&
        existingArsipRow[COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.MENUNGGU) {
      return {
        success: false,
        message: 'Dokumen sudah dalam antrian verifikasi. Tunggu hasil verifikasi sebelum mengunggah ulang.'
      };
    }

    // ---- Trash old file from Drive if one exists ----
    if (existingArsipRow) {
      var oldFileDriveId = existingArsipRow[COL_ARSIP.FILE_DRIVE_ID];
      if (oldFileDriveId && String(oldFileDriveId).trim() !== '') {
        try {
          DriveApp.getFileById(oldFileDriveId).setTrashed(true);
          Logger.log('Old file trashed: ' + oldFileDriveId);
        } catch (trashErr) {
          Logger.log('Could not trash old file ' + oldFileDriveId + ': ' + trashErr);
          // Continue — do not block upload
        }
      }
    }

    // ---- Get or create employee folder ----
    var empFolder = getOrCreateEmployeeFolder(nip);

    // ---- Auto-rename: [NIP]_[NamaSafe]_[ID_Dokumen].[ext] ----
    var safeName     = nama.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
    var autoFileName = nip + '_' + safeName + '_' + idDokumen + '.' + ext;

    // ---- Decode Base64 and create file in Drive ----
    var decodedBytes = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType,
      autoFileName
    );

    var newFile = empFolder.createFile(decodedBytes);

    // Share so that the preview iframe works
    newFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    var newFileDriveId = newFile.getId();
    var newFileUrl     = newFile.getUrl();
    var now            = getTimestamp();

    // ---- Write to Arsip_Dokumen ----
    var idArsip;
    if (existingArsipRow && existingArsipIndex > 0) {
      // UPDATE existing row in-place
      idArsip = existingArsipRow[COL_ARSIP.ID_ARSIP];
      var fields = {};
      fields[COL_ARSIP.FILE_DRIVE_ID]     = newFileDriveId;
      fields[COL_ARSIP.FILE_URL]          = newFileUrl;
      fields[COL_ARSIP.STATUS_VERIFIKASI] = DOC_STATUS.MENUNGGU;
      fields[COL_ARSIP.CATATAN_ADMIN]     = '';
      fields[COL_ARSIP.WAKTU_UPLOAD]      = now;
      fields[COL_ARSIP.WAKTU_VERIFIKASI]  = '';
      fields[COL_ARSIP.NIP_VERIFIER]      = '';
      updateRowFields(SHEET_NAMES.ARSIP_DOKUMEN, existingArsipIndex, fields);
    } else {
      // INSERT new row
      idArsip = generateUUID();
      appendRow(SHEET_NAMES.ARSIP_DOKUMEN, [
        idArsip,
        nip,
        idDokumen,
        newFileDriveId,
        newFileUrl,
        DOC_STATUS.MENUNGGU,
        '',   // Catatan_Admin
        now,  // Waktu_Upload
        '',   // Waktu_Verifikasi
        ''    // NIP_Verifier
      ]);
    }

    // ---- Audit log ----
    logActivity(
      nip, auth.session.role, 'DOKUMEN_UPLOAD', 'DOCUMENT',
      idArsip,
      'Upload dokumen: ' + namaDokumen + ' (' + autoFileName + ')',
      'SUCCESS'
    );

    return {
      success: true,
      message: namaDokumen + ' berhasil diunggah dan sedang menunggu verifikasi.',
      data: {
        idArsip:  idArsip,
        status:   DOC_STATUS.MENUNGGU,
        fileUrl:  newFileUrl,
        fileName: autoFileName
      }
    };

  } catch (e) {
    Logger.log('uploadDokumen error: ' + e.toString());
    return { success: false, message: 'Gagal mengunggah dokumen. Silakan coba lagi.' };
  }
}

// ============================================================
// PRIVATE HELPER
// ============================================================

/**
 * Formats a date value from spreadsheet into a display string (WITA).
 * @param {*} val
 * @returns {string}
 */
function _formatDate(val) {
  try {
    if (!val || val === '-') return '-';
    var d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return Utilities.formatDate(d, 'Asia/Makassar', 'dd MMM yyyy, HH:mm');
  } catch (e) {
    return String(val);
  }
}

// ============================================================
// TESTS
// ============================================================

/**
 * TEST: Upload — invalid MIME type must be rejected.
 */
function test_upload_invalid_type() {
  Logger.log('=== TEST: Upload — invalid MIME type ===');
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (!sessions.length) { Logger.log('No sessions. Login first.'); return; }
  var token = sessions[0][COL_SESI.TOKEN_ID];

  var result = uploadDokumen(token, 'DOC-KTP', 'AABBCCDD==', 'application/msword');
  Logger.log('Invalid type rejected: ' + (result.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + result.message);
}

/**
 * TEST: Upload — oversized file (~7 MB) must be rejected.
 */
function test_upload_oversized() {
  Logger.log('=== TEST: Upload — oversized file ===');
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (!sessions.length) { Logger.log('No sessions. Login first.'); return; }
  var token = sessions[0][COL_SESI.TOKEN_ID];

  // Approximate 7 MB of base64 characters
  var bigBase64 = new Array(9600001).join('A');

  var result = uploadDokumen(token, 'DOC-KTP', bigBase64, 'image/jpeg');
  Logger.log('Oversized rejected: ' + (result.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + result.message);
}

/**
 * TEST: Duplicate submission — blocked when status is Menunggu.
 */
function test_upload_duplicate_menunggu() {
  Logger.log('=== TEST: Upload — duplicate Menunggu ===');
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (!sessions.length) { Logger.log('No sessions. Login first.'); return; }
  var token = sessions[0][COL_SESI.TOKEN_ID];

  var auth = authorize(token, null, false);
  if (!auth.authorized) { Logger.log('Auth failed: ' + auth.error); return; }
  var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
  var menungguDoc = null;
  for (var i = 0; i < allArsip.length; i++) {
    if (String(allArsip[i][COL_ARSIP.NIP]) === String(auth.session.nip) &&
        allArsip[i][COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.MENUNGGU) {
      menungguDoc = allArsip[i][COL_ARSIP.ID_DOKUMEN];
      break;
    }
  }
  if (!menungguDoc) { Logger.log('No Menunggu doc found — run seedData() first.'); return; }

  var result = uploadDokumen(token, menungguDoc, 'AABBCCDD==', 'application/pdf');
  Logger.log('Duplicate blocked: ' + (result.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + result.message);
}

/**
 * TEST: Preview — unauthorized access by different user must be rejected.
 */
function test_preview_unauthorized() {
  Logger.log('=== TEST: Preview — unauthorized access ===');
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (sessions.length < 2) { Logger.log('Need at least 2 active sessions.'); return; }

  var tokenA = sessions[0][COL_SESI.TOKEN_ID];
  var nipA   = sessions[0][COL_SESI.NIP];

  var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
  var foreignIdArsip = null;
  for (var i = 0; i < allArsip.length; i++) {
    if (String(allArsip[i][COL_ARSIP.NIP]) !== String(nipA) &&
        allArsip[i][COL_ARSIP.FILE_DRIVE_ID]) {
      foreignIdArsip = allArsip[i][COL_ARSIP.ID_ARSIP];
      break;
    }
  }
  if (!foreignIdArsip) { Logger.log('No cross-user archive with Drive ID found.'); return; }

  var result = getDokumenPreview(tokenA, foreignIdArsip);
  Logger.log('Cross-user blocked: ' + (result.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + result.message);
}

/**
 * TEST: Ownership — null and fake tokens must be rejected.
 */
function test_ownership_getArsip() {
  Logger.log('=== TEST: Ownership — getArsipDokumenPegawai ===');
  var r1 = getArsipDokumenPegawai(null);
  Logger.log('T1 (null token): '  + (r1.success === false ? 'PASS ✓' : 'FAIL ✗'));
  var r2 = getArsipDokumenPegawai('fake-token-xyz');
  Logger.log('T2 (fake token): ' + (r2.success === false ? 'PASS ✓' : 'FAIL ✗'));
}

/**
 * TEST: Re-upload — Ditolak doc should NOT be blocked by duplicate check.
 */
function test_reupload_not_blocked() {
  Logger.log('=== TEST: Re-upload — Ditolak not blocked ===');
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (!sessions.length) { Logger.log('No sessions. Login first.'); return; }
  var token = sessions[0][COL_SESI.TOKEN_ID];

  var auth = authorize(token, null, false);
  if (!auth.authorized) { Logger.log('Auth failed'); return; }

  var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
  var ditolakDoc = null;
  for (var i = 0; i < allArsip.length; i++) {
    if (String(allArsip[i][COL_ARSIP.NIP]) === String(auth.session.nip) &&
        allArsip[i][COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.DITOLAK) {
      ditolakDoc = allArsip[i][COL_ARSIP.ID_DOKUMEN];
      break;
    }
  }
  if (!ditolakDoc) {
    Logger.log('No Ditolak doc found — set one in sheet first.');
    return;
  }

  // Call with invalid base64 to avoid actual Drive API call;
  // failure should be from Drive API, NOT from duplicate-check.
  var result = uploadDokumen(token, ditolakDoc, 'AABBCCDD==', 'image/jpeg');
  var blockedByDuplicate = result.message && result.message.indexOf('antrian verifikasi') !== -1;
  Logger.log('Re-upload not blocked by duplicate: ' + (!blockedByDuplicate ? 'PASS ✓' : 'FAIL ✗'));
}

/**
 * TEST: Upload failure — missing required params.
 */
function test_upload_failure_missing_params() {
  Logger.log('=== TEST: Upload failure — missing params ===');
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (!sessions.length) { Logger.log('No sessions. Login first.'); return; }
  var token = sessions[0][COL_SESI.TOKEN_ID];

  // Missing idDokumen
  var r1 = uploadDokumen(token, 'DOC-NONEXISTENT', 'AABB==', 'application/pdf');
  Logger.log('T1 (invalid docId): ' + (r1.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r1.message);

  // No auth
  var r2 = uploadDokumen(null, 'DOC-KTP', 'AABB==', 'application/pdf');
  Logger.log('T2 (no token):      ' + (r2.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r2.message);
}
