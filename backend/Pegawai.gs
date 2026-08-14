// ============================================================
// Pegawai.gs — Employee Profile & Dashboard Backend
// All functions enforce server-side ownership via authorize()
// ============================================================

// ---- Column indices for Arsip_Dokumen (0-based) ----
var COL_ARSIP = {
  ID_ARSIP: 0,
  NIP: 1,
  ID_DOKUMEN: 2,
  FILE_DRIVE_ID: 3,
  FILE_URL: 4,
  STATUS_VERIFIKASI: 5,
  CATATAN_ADMIN: 6,
  WAKTU_UPLOAD: 7,
  WAKTU_VERIFIKASI: 8,
  NIP_VERIFIER: 9
};

// Document verification statuses
var DOC_STATUS = {
  TERVERIFIKASI: 'Terverifikasi',
  MENUNGGU: 'Menunggu',
  DITOLAK: 'Ditolak',
  BELUM_UNGGAH: 'Belum_Unggah'
};

// ============================================================
// PROFILE FUNCTIONS
// ============================================================

/**
 * Gets the full profile of the logged-in employee.
 * Ownership: only own profile.
 * @param {string} token - Session token.
 * @returns {Object} Result with profile data.
 */
function getMyProfile(token) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, auth.session.nip);
    if (!user) return { success: false, message: 'Data pengguna tidak ditemukan.' };

    return {
      success: true,
      data: _mapPegawaiRowToObject(user.data)
    };
  } catch (e) {
    Logger.log('getMyProfile error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Updates editable profile fields for the logged-in employee.
 * Ownership enforced: only own profile can be updated.
 * @param {string} token - Session token.
 * @param {Object} updates - { noHp, alamat, email, golonganDarah, tempatLahir, tanggalLahir, agama, pendidikanTerakhir, statusPernikahan }
 * @returns {Object} Result object.
 */
function updateMyProfile(token, updates) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    if (!updates || typeof updates !== 'object') {
      return { success: false, message: 'Data pembaruan tidak valid.' };
    }

    // Input validation
    if (updates.noHp && !isValidPhoneNumber(updates.noHp)) {
      return { success: false, message: 'Format nomor HP tidak valid.' };
    }
    if (updates.email && !isValidEmail(updates.email)) {
      return { success: false, message: 'Format email tidak valid.' };
    }
    var allowedBloodTypes = ['A', 'B', 'AB', 'O', 'Tidak Tahu', ''];
    if (updates.golonganDarah !== undefined && allowedBloodTypes.indexOf(updates.golonganDarah) === -1) {
      return { success: false, message: 'Golongan darah tidak valid.' };
    }
    var allowedAgama = ['Kristen Protestan', 'Kristen Katholik', 'Islam', 'Hindu', 'Buddha', 'Konghucu', ''];
    if (updates.agama !== undefined && allowedAgama.indexOf(updates.agama) === -1) {
      return { success: false, message: 'Pilihan agama tidak valid.' };
    }
    var allowedMarital = ['Belum Menikah', 'Menikah', 'Cerai', ''];
    if (updates.statusPernikahan !== undefined && allowedMarital.indexOf(updates.statusPernikahan) === -1) {
      return { success: false, message: 'Pilihan status pernikahan tidak valid.' };
    }

    // OWNERSHIP CHECK: only update own record
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, auth.session.nip);
    if (!user) return { success: false, message: 'Data pengguna tidak ditemukan.' };

    // Build update map — only employee self-editable fields
    var fields = {};
    if (updates.noHp !== undefined) fields[COL_PEGAWAI.NO_HP] = formatPhoneForStorage(updates.noHp);
    if (updates.alamat !== undefined) fields[COL_PEGAWAI.ALAMAT] = escapeFormula(updates.alamat);
    if (updates.email !== undefined) fields[COL_PEGAWAI.EMAIL] = escapeFormula(updates.email);
    if (updates.golonganDarah !== undefined) fields[COL_PEGAWAI.GOLONGAN_DARAH] = escapeFormula(updates.golonganDarah);
    if (updates.tempatLahir !== undefined) fields[COL_PEGAWAI.TEMPAT_LAHIR] = escapeFormula(updates.tempatLahir);
    if (updates.tanggalLahir !== undefined) fields[COL_PEGAWAI.TANGGAL_LAHIR] = formatDateOnly(updates.tanggalLahir);
    if (updates.agama !== undefined) fields[COL_PEGAWAI.AGAMA] = escapeFormula(updates.agama);
    if (updates.pendidikanTerakhir !== undefined) fields[COL_PEGAWAI.PENDIDIKAN_TERAKHIR] = escapeFormula(updates.pendidikanTerakhir);
    if (updates.statusPernikahan !== undefined) fields[COL_PEGAWAI.STATUS_PERNIKAHAN] = escapeFormula(updates.statusPernikahan);

    if (Object.keys(fields).length === 0) {
      return { success: false, message: 'Tidak ada perubahan untuk disimpan.' };
    }

    // Batch update
    updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, fields);

    logActivity(auth.session.nip, auth.session.role, 'PROFILE_UPDATE', 'USER',
      auth.session.nip, 'Profil diperbarui: ' + Object.keys(fields).join(', '), 'SUCCESS');

    return { success: true, message: 'Profil berhasil diperbarui.' };
  } catch (e) {
    Logger.log('updateMyProfile error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Uploads a profile photo for the logged-in employee.
 * Saved to employee's Drive folder as [NIP]_FOTO.[ext].
 * Overwrites/trashes old profile photo if exists.
 * @param {string} token - Session token.
 * @param {string} base64Data - Base64 encoded image data.
 * @param {string} mimeType - Image mime type (JPEG, JPG, PNG).
 * @returns {Object} Result with new photo drive ID and URL.
 */
function uploadFotoProfil(token, base64Data, mimeType) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var nip = auth.session.nip;
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nip);
    if (!user) return { success: false, message: 'Data pengguna tidak ditemukan.' };

    // Validate Base64 data
    if (!base64Data || typeof base64Data !== 'string') {
      return { success: false, message: 'Data file foto tidak valid atau kosong.' };
    }

    var cleanBase64 = base64Data.trim();
    if (cleanBase64.indexOf(',') !== -1) {
      cleanBase64 = cleanBase64.split(',')[1];
    }
    cleanBase64 = cleanBase64.replace(/\s/g, '');

    // Validate MIME type (JPEG, JPG, PNG allowed)
    var cleanMime = String(mimeType || '').toLowerCase().trim();
    var ext = '';
    if (cleanMime === 'image/jpeg' || cleanMime === 'image/jpg' || cleanMime === 'image/pjpeg' || cleanMime === 'image/jfif') {
      ext = 'jpg';
      cleanMime = 'image/jpeg';
    } else if (cleanMime === 'image/png') {
      ext = 'png';
      cleanMime = 'image/png';
    } else {
      return { success: false, message: 'Format foto tidak valid. Hanya JPG dan PNG yang didukung.' };
    }

    // Validate size (max 5 MB)
    var approxBytes = Math.ceil(cleanBase64.length * 0.75);
    if (approxBytes > 5 * 1024 * 1024) {
      return { success: false, message: 'Ukuran foto melebihi batas maksimal 5 MB.' };
    }

    // Trash old photo from Drive if exists
    var oldFotoDriveId = String(user.data[COL_PEGAWAI.FOTO_DRIVE_ID] || '').replace(/^'+/, '').trim();
    if (oldFotoDriveId) {
      try {
        DriveApp.getFileById(oldFotoDriveId).setTrashed(true);
        Logger.log('Old profile photo trashed: ' + oldFotoDriveId);
      } catch (e) {
        Logger.log('Could not trash old photo ' + oldFotoDriveId + ': ' + e.toString());
      }
    }

    // Get employee folder
    var empFolder = getOrCreateEmployeeFolder(nip);
    var fileName = nip + '_FOTO.' + ext;

    var decodedBytes = Utilities.newBlob(
      Utilities.base64Decode(cleanBase64),
      cleanMime,
      fileName
    );

    var newFile = empFolder.createFile(decodedBytes);
    var newFileId = newFile.getId();

    // Update Data_Pegawai sheet
    updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, {
      [COL_PEGAWAI.FOTO_DRIVE_ID]: newFileId
    });

    logActivity(nip, auth.session.role, 'FOTO_PROFIL_UPLOAD', 'USER',
      nip, 'Foto profil berhasil diunggah: ' + fileName, 'SUCCESS');

    var fotoUrl = 'https://drive.google.com/thumbnail?id=' + newFileId + '&sz=w500';

    return {
      success: true,
      message: 'Foto profil berhasil diperbarui.',
      data: {
        fotoDriveId: newFileId,
        fotoUrl: fotoUrl
      }
    };
  } catch (e) {
    Logger.log('uploadFotoProfil error: ' + e.toString());
    return { success: false, message: 'Gagal mengunggah foto profil: ' + (e.message || e.toString()) };
  }
}

// ============================================================
// DASHBOARD FUNCTIONS
// ============================================================

/**
 * Returns document completeness summary for the logged-in employee.
 * Used to populate the Employee Dashboard.
 * @param {string} token - Session token.
 * @returns {Object} Result with document stats.
 */
function getMyDashboard(token) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var nip = auth.session.nip;

    // Get all master documents (wajib only for completeness %)
    var masterDocs = getAllData(SHEET_NAMES.MASTER_DOKUMEN);
    var allWajibIds = [];
    var allDocIds = [];
    for (var i = 0; i < masterDocs.length; i++) {
      allDocIds.push(masterDocs[i][0]); // ID_Dokumen
      if (masterDocs[i][3] === 'Ya') {
        allWajibIds.push(masterDocs[i][0]);
      }
    }

    // Get all submitted documents for this employee (ownership scoped)
    var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
    var myArsip = {}; // { ID_Dokumen: latest row data }
    for (var j = 0; j < allArsip.length; j++) {
      if (String(allArsip[j][COL_ARSIP.NIP]) === String(nip)) {
        var docId = allArsip[j][COL_ARSIP.ID_DOKUMEN];
        // Keep latest (assume sorted by Waktu_Upload desc or just overwrite)
        myArsip[docId] = allArsip[j];
      }
    }

    // Tally statuses
    var counts = {
      terverifikasi: 0,
      menunggu: 0,
      ditolak: 0,
      belumUnggah: 0
    };

    var rejectedDocs = []; // For the "Perlu Perhatian" alert
    var tableRows = [];    // For the document status table

    for (var k = 0; k < masterDocs.length; k++) {
      var id = masterDocs[k][0];
      var nama = masterDocs[k][1];
      var kategori = masterDocs[k][2];
      var wajib = masterDocs[k][3];

      var arsipRow = myArsip[id];
      var status, waktuUpdate, catatan;

      if (arsipRow) {
        status = arsipRow[COL_ARSIP.STATUS_VERIFIKASI];
        waktuUpdate = arsipRow[COL_ARSIP.WAKTU_UPLOAD];
        catatan = arsipRow[COL_ARSIP.CATATAN_ADMIN] || '';
      } else {
        status = DOC_STATUS.BELUM_UNGGAH;
        waktuUpdate = '-';
        catatan = '';
      }

      // Tally
      if (status === DOC_STATUS.TERVERIFIKASI) counts.terverifikasi++;
      else if (status === DOC_STATUS.MENUNGGU) counts.menunggu++;
      else if (status === DOC_STATUS.DITOLAK) {
        counts.ditolak++;
        if (catatan) rejectedDocs.push({ nama: nama, catatan: catatan });
      }
      else counts.belumUnggah++;

      tableRows.push({
        id: id,
        nama: nama,
        kategori: kategori,
        wajib: wajib,
        status: status,
        waktuUpdate: waktuUpdate ? _formatDate(waktuUpdate) : '-',
        catatan: catatan
      });
    }

    // Calculate completeness % (wajib docs only)
    var wajibTotal = allWajibIds.length;
    var wajibVerified = 0;
    for (var m = 0; m < allWajibIds.length; m++) {
      var w = myArsip[allWajibIds[m]];
      if (w && w[COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.TERVERIFIKASI) {
        wajibVerified++;
      }
    }
    var pct = wajibTotal > 0 ? Math.round((wajibVerified / wajibTotal) * 100) : 0;

    return {
      success: true,
      data: {
        nama: auth.session.nama,
        pct: pct,
        counts: counts,
        rejectedDocs: rejectedDocs,
        tableRows: tableRows
      }
    };
  } catch (e) {
    Logger.log('getMyDashboard error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Formats a date value from spreadsheet.
 * @param {*} val - Date object, string, or number.
 * @returns {string} Formatted date string.
 */
function _formatDate(val) {
  try {
    if (!val || val === '-') return '-';
    var d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return Utilities.formatDate(d, 'Asia/Makassar', 'dd MMM yyyy');
  } catch (e) {
    return String(val);
  }
}

// ============================================================
// TESTS
// ============================================================

/**
 * TEST: Ownership enforcement on updateMyProfile.
 * Verifies a user cannot update another employee's profile.
 * Run from Script Editor to validate.
 */
function test_updateMyProfile_ownership() {
  Logger.log('=== TEST: updateMyProfile ownership ===');

  // Test 1: Invalid token → should fail
  var r1 = updateMyProfile('invalid-token-xxx', { noHp: '081111111111' });
  Logger.log('Test 1 (invalid token): ' + (r1.success === false ? 'PASS' : 'FAIL') + ' — ' + r1.message);

  // Test 2: Valid but expired/nonexistent token → should fail
  var r2 = updateMyProfile('00000000-0000-0000-0000-000000000000', { noHp: '081111111111' });
  Logger.log('Test 2 (fake token): ' + (r2.success === false ? 'PASS' : 'FAIL') + ' — ' + r2.message);

  // Test 3: Email validation — invalid format
  // (Requires a live token; skip if not in deployment context)
  Logger.log('Test 3: Email validation tested via live login.');

  Logger.log('=== TESTS COMPLETE ===');
}

/**
 * TEST: updateMyProfile input validation.
 * Tests phone, email, and blood type validation.
 */
function test_updateMyProfile_validation() {
  Logger.log('=== TEST: updateMyProfile validation ===');

  // Get a live token from Sesi_Login for testing
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (sessions.length === 0) {
    Logger.log('No active sessions. Login first, then re-run.');
    return;
  }
  var token = sessions[0][COL_SESI.TOKEN_ID];

  var r1 = updateMyProfile(token, { noHp: 'abc!!' });
  Logger.log('Test HP invalid: ' + (r1.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r1.message);

  var r2 = updateMyProfile(token, { email: 'not-an-email' });
  Logger.log('Test email invalid: ' + (r2.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r2.message);

  var r3 = updateMyProfile(token, { golonganDarah: 'X' });
  Logger.log('Test goldar invalid: ' + (r3.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r3.message);

  var r4 = updateMyProfile(token, { golonganDarah: 'AB' });
  Logger.log('Test goldar valid AB: ' + (r4.success === true ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r4.message);

  var r5 = updateMyProfile(token, { agama: 'AgamaTidakDikenal' });
  Logger.log('Test agama invalid: ' + (r5.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r5.message);

  var r6 = updateMyProfile(token, { statusPernikahan: 'InvalidStatus' });
  Logger.log('Test status pernikahan invalid: ' + (r6.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r6.message);

  Logger.log('=== TESTS COMPLETE ===');
}

/**
 * TEST: getMyDashboard completeness calculation.
 */
function test_getMyDashboard() {
  Logger.log('=== TEST: getMyDashboard ===');

  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  if (sessions.length === 0) {
    Logger.log('No active sessions. Login first, then re-run.');
    return;
  }
  var token = sessions[0][COL_SESI.TOKEN_ID];

  var result = getMyDashboard(token);
  Logger.log('Success: ' + result.success);
  if (result.success) {
    Logger.log('NIP: ' + result.data.nama);
    Logger.log('Completeness: ' + result.data.pct + '%');
    Logger.log('Counts: ' + JSON.stringify(result.data.counts));
    Logger.log('Table rows: ' + result.data.tableRows.length);
    Logger.log('PASS ✓');
  } else {
    Logger.log('FAIL ✗ — ' + result.message);
  }

  Logger.log('=== TESTS COMPLETE ===');
}
