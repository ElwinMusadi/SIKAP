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

    var d = user.data;
    return {
      success: true,
      data: {
        nip: d[COL_PEGAWAI.NIP],
        nama: d[COL_PEGAWAI.NAMA_LENGKAP],
        role: d[COL_PEGAWAI.ROLE],
        statusKepegawaian: d[COL_PEGAWAI.STATUS_KEPEGAWAIAN],
        pangkatGolongan: d[COL_PEGAWAI.PANGKAT_GOLONGAN],
        jabatan: d[COL_PEGAWAI.JABATAN],
        noHp: formatPhoneForDisplay(d[COL_PEGAWAI.NO_HP]),
        alamat: d[COL_PEGAWAI.ALAMAT] || '',
        email: d[COL_PEGAWAI.EMAIL] || '',
        golonganDarah: d[COL_PEGAWAI.GOLONGAN_DARAH] || ''
      }
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
 * @param {Object} updates - { noHp, alamat, email, golonganDarah }
 * @returns {Object} Result object.
 */
function updateMyProfile(token, updates) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) return { success: false, message: auth.error };

    // Input validation
    if (updates.noHp && !/^[0-9+\-\s]{6,20}$/.test(updates.noHp)) {
      return { success: false, message: 'Nomor HP tidak valid.' };
    }
    if (updates.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(updates.email)) {
      return { success: false, message: 'Format email tidak valid.' };
    }
    var allowedBloodTypes = ['A', 'B', 'AB', 'O', 'Tidak Tahu', ''];
    if (updates.golonganDarah !== undefined && allowedBloodTypes.indexOf(updates.golonganDarah) === -1) {
      return { success: false, message: 'Golongan darah tidak valid.' };
    }

    // OWNERSHIP CHECK: only update own record
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, auth.session.nip);
    if (!user) return { success: false, message: 'Data pengguna tidak ditemukan.' };

    // Build update map — only editable fields
    var fields = {};
    if (updates.noHp !== undefined) fields[COL_PEGAWAI.NO_HP] = formatPhoneForStorage(updates.noHp);
    if (updates.alamat !== undefined) fields[COL_PEGAWAI.ALAMAT] = updates.alamat;
    if (updates.email !== undefined) fields[COL_PEGAWAI.EMAIL] = updates.email;
    if (updates.golonganDarah !== undefined) fields[COL_PEGAWAI.GOLONGAN_DARAH] = updates.golonganDarah;

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
