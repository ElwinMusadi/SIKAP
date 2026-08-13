// ============================================================
// Admin.gs — Admin Master Data Pegawai CRUD
// All functions require Role = 'Admin' via authorize()
// Note: COL_ARSIP and DOC_STATUS are defined in Pegawai.gs
// ============================================================

// ============================================================
// LIST / READ
// ============================================================

/**
 * Returns all employee records for the admin table.
 * Includes document completeness % per employee.
 * @param {string} token - Session token.
 * @returns {Object} Result with array of employee rows + summary counts.
 */
function adminGetAllPegawai(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var allPegawai = getAllData(SHEET_NAMES.DATA_PEGAWAI);
    var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
    var masterDoks = getAllData(SHEET_NAMES.MASTER_DOKUMEN);

    // Build wajib doc set
    var wajibIds = [];
    for (var w = 0; w < masterDoks.length; w++) {
      if (masterDoks[w][3] === 'Ya') wajibIds.push(masterDoks[w][0]);
    }

    // Index arsip by NIP -> { docId: status }
    var arsipByNip = {};
    for (var a = 0; a < allArsip.length; a++) {
      var nip = String(allArsip[a][COL_ARSIP.NIP]);
      var docId = allArsip[a][COL_ARSIP.ID_DOKUMEN];
      var status = allArsip[a][COL_ARSIP.STATUS_VERIFIKASI];
      if (!arsipByNip[nip]) arsipByNip[nip] = {};
      arsipByNip[nip][docId] = status;
    }

    // Build result rows
    var rows = [];
    var summaryTotal = 0;
    var summaryAktif = 0;
    var summaryNonaktif = 0;

    for (var i = 0; i < allPegawai.length; i++) {
      var d = allPegawai[i];
      var empNip = String(d[COL_PEGAWAI.NIP]);
      summaryTotal++;
      if (d[COL_PEGAWAI.STATUS_AKUN] === 'Aktif') summaryAktif++;
      else if (d[COL_PEGAWAI.STATUS_AKUN] === 'Nonaktif') summaryNonaktif++;

      // Calculate doc completeness
      var empArsip = arsipByNip[empNip] || {};
      var wajibVerified = 0;
      var hasRejected = false;
      for (var w2 = 0; w2 < wajibIds.length; w2++) {
        var docStatus = empArsip[wajibIds[w2]];
        if (docStatus === DOC_STATUS.TERVERIFIKASI) wajibVerified++;
        if (docStatus === DOC_STATUS.DITOLAK) hasRejected = true;
      }
      var pct = wajibIds.length > 0 ? Math.round((wajibVerified / wajibIds.length) * 100) : 0;
      var completenessLabel = hasRejected ? 'Perlu Revisi' : (pct === 100 ? 'Lengkap' : 'Belum Lengkap');

      rows.push({
        nip: empNip,
        nama: d[COL_PEGAWAI.NAMA_LENGKAP],
        role: d[COL_PEGAWAI.ROLE],
        statusAkun: d[COL_PEGAWAI.STATUS_AKUN],
        statusKepegawaian: d[COL_PEGAWAI.STATUS_KEPEGAWAIAN],
        pangkatGolongan: d[COL_PEGAWAI.PANGKAT_GOLONGAN],
        jabatan: d[COL_PEGAWAI.JABATAN],
        noHp: d[COL_PEGAWAI.NO_HP] || '',
        alamat: d[COL_PEGAWAI.ALAMAT] || '',
        email: d[COL_PEGAWAI.EMAIL] || '',
        golonganDarah: d[COL_PEGAWAI.GOLONGAN_DARAH] || '',
        docPct: pct,
        docLabel: completenessLabel
      });
    }

    return {
      success: true,
      data: {
        rows: rows,
        summary: { total: summaryTotal, aktif: summaryAktif, nonaktif: summaryNonaktif }
      }
    };
  } catch (e) {
    Logger.log('adminGetAllPegawai error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Returns full detail of a single employee for the edit form.
 * @param {string} token - Session token.
 * @param {string} targetNip - NIP of employee to fetch.
 * @returns {Object} Result with employee data.
 */
function adminGetPegawaiDetail(token, targetNip) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    var d = user.data;
    return {
      success: true,
      data: {
        nip: String(d[COL_PEGAWAI.NIP]),
        nama: d[COL_PEGAWAI.NAMA_LENGKAP],
        role: d[COL_PEGAWAI.ROLE],
        statusAkun: d[COL_PEGAWAI.STATUS_AKUN],
        statusKepegawaian: d[COL_PEGAWAI.STATUS_KEPEGAWAIAN],
        pangkatGolongan: d[COL_PEGAWAI.PANGKAT_GOLONGAN],
        jabatan: d[COL_PEGAWAI.JABATAN],
        noHp: d[COL_PEGAWAI.NO_HP] || '',
        alamat: d[COL_PEGAWAI.ALAMAT] || '',
        email: d[COL_PEGAWAI.EMAIL] || '',
        golonganDarah: d[COL_PEGAWAI.GOLONGAN_DARAH] || ''
      }
    };
  } catch (e) {
    Logger.log('adminGetPegawaiDetail error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

// ============================================================
// CREATE
// ============================================================

/**
 * Creates a new employee record.
 * Default password = last 6 digits of NIP.
 * @param {string} token - Session token.
 * @param {Object} data - Employee data.
 * @returns {Object} Result object.
 */
function adminTambahPegawai(token, data) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    // Validate required fields
    if (!data.nip || !data.nama || !data.statusKepegawaian || !data.role) {
      return { success: false, message: 'NIP, Nama, Status Kepegawaian, dan Role wajib diisi.' };
    }

    // NIP: 18-digit numeric
    var nipStr = String(data.nip).trim();
    if (!/^\d{18}$/.test(nipStr)) {
      return { success: false, message: 'NIP harus terdiri dari 18 digit angka.' };
    }

    // Check for duplicate NIP
    var existing = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nipStr);
    if (existing) {
      return { success: false, message: 'NIP ' + nipStr + ' sudah terdaftar dalam sistem.' };
    }

    // Validate role
    if ([ROLES.ADMIN, ROLES.PEGAWAI].indexOf(data.role) === -1) {
      return { success: false, message: 'Role tidak valid.' };
    }

    // Default password = last 6 digits of NIP
    var defaultPw = getDefaultPassword(nipStr);
    var passwordHash = hashPassword(defaultPw);

    // Build row
    var newRow = [
      nipStr,
      passwordHash,
      data.role,
      'Aktif',
      String(data.nama).trim(),
      String(data.statusKepegawaian).trim(),
      String(data.pangkatGolongan || '').trim(),
      String(data.jabatan || '').trim(),
      String(data.noHp || '').trim(),
      String(data.alamat || '').trim(),
      '', // Folder_Drive_ID — set later
      String(data.email || '').trim(),
      String(data.golonganDarah || '').trim()
    ];

    appendRow(SHEET_NAMES.DATA_PEGAWAI, newRow);

    logActivity(auth.session.nip, auth.session.role, 'PEGAWAI_CREATE', 'USER',
      nipStr, 'Pegawai baru ditambahkan: ' + data.nama, 'SUCCESS');

    return {
      success: true,
      message: 'Pegawai berhasil ditambahkan. Password default: ' + defaultPw
    };
  } catch (e) {
    Logger.log('adminTambahPegawai error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

// ============================================================
// UPDATE
// ============================================================

/**
 * Updates an employee's editable fields (Admin can edit more fields than self).
 * Admin-editable: jabatan, noHp, alamat, email, golonganDarah, role, statusAkun.
 * Read-only (system): nip, nama, statusKepegawaian, pangkatGolongan.
 * @param {string} token - Session token.
 * @param {string} targetNip - NIP of employee to update.
 * @param {Object} updates - Field updates.
 * @returns {Object} Result object.
 */
function adminUpdatePegawai(token, targetNip, updates) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    // Validate role if being changed
    if (updates.role !== undefined && [ROLES.ADMIN, ROLES.PEGAWAI].indexOf(updates.role) === -1) {
      return { success: false, message: 'Role tidak valid.' };
    }

    // Validate statusAkun if being changed
    var validStatuses = ['Aktif', 'Nonaktif', 'Ganti_Password'];
    if (updates.statusAkun !== undefined && validStatuses.indexOf(updates.statusAkun) === -1) {
      return { success: false, message: 'Status akun tidak valid.' };
    }

    // Validate noHp if provided
    if (updates.noHp && !/^[0-9+\-\s]{6,20}$/.test(updates.noHp)) {
      return { success: false, message: 'Nomor HP tidak valid.' };
    }

    // Validate email if provided
    if (updates.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(updates.email)) {
      return { success: false, message: 'Format email tidak valid.' };
    }

    // Build update map — only admin-editable columns
    var fields = {};
    if (updates.jabatan !== undefined)        fields[COL_PEGAWAI.JABATAN] = updates.jabatan;
    if (updates.noHp !== undefined)           fields[COL_PEGAWAI.NO_HP] = updates.noHp;
    if (updates.alamat !== undefined)         fields[COL_PEGAWAI.ALAMAT] = updates.alamat;
    if (updates.email !== undefined)          fields[COL_PEGAWAI.EMAIL] = updates.email;
    if (updates.golonganDarah !== undefined)  fields[COL_PEGAWAI.GOLONGAN_DARAH] = updates.golonganDarah;
    if (updates.role !== undefined)           fields[COL_PEGAWAI.ROLE] = updates.role;
    if (updates.statusAkun !== undefined)     fields[COL_PEGAWAI.STATUS_AKUN] = updates.statusAkun;

    if (Object.keys(fields).length === 0) {
      return { success: false, message: 'Tidak ada perubahan untuk disimpan.' };
    }

    updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, fields);

    logActivity(auth.session.nip, auth.session.role, 'PEGAWAI_UPDATE', 'USER',
      targetNip, 'Data pegawai diperbarui: ' + Object.keys(fields).join(', '), 'SUCCESS');

    return { success: true, message: 'Data pegawai berhasil diperbarui.' };
  } catch (e) {
    Logger.log('adminUpdatePegawai error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

// ============================================================
// DEACTIVATE / REACTIVATE
// ============================================================

/**
 * Toggles employee account status between Aktif and Nonaktif.
 * Admin cannot deactivate their own account.
 * @param {string} token - Session token.
 * @param {string} targetNip - NIP of employee.
 * @param {string} newStatus - 'Aktif' or 'Nonaktif'.
 * @returns {Object} Result object.
 */
function adminSetStatusAkun(token, targetNip, newStatus) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    // Prevent admin from deactivating their own account
    if (String(targetNip) === String(auth.session.nip)) {
      return { success: false, message: 'Anda tidak dapat menonaktifkan akun Anda sendiri.' };
    }

    if (['Aktif', 'Nonaktif'].indexOf(newStatus) === -1) {
      return { success: false, message: 'Status tidak valid.' };
    }

    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, {
      [COL_PEGAWAI.STATUS_AKUN]: newStatus
    });

    var action = newStatus === 'Nonaktif' ? 'PEGAWAI_DEACTIVATE' : 'PEGAWAI_REACTIVATE';
    logActivity(auth.session.nip, auth.session.role, action, 'USER',
      targetNip, 'Status akun diubah ke: ' + newStatus, 'SUCCESS');

    return {
      success: true,
      message: 'Status akun berhasil diubah menjadi ' + newStatus + '.'
    };
  } catch (e) {
    Logger.log('adminSetStatusAkun error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Resets an employee's password to the default (last 6 digits of NIP).
 * Forces next login to change password.
 * @param {string} token - Session token.
 * @param {string} targetNip - NIP of employee.
 * @returns {Object} Result object.
 */
function adminResetPassword(token, targetNip) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, targetNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    var defaultPw = getDefaultPassword(String(targetNip));
    var defaultHash = hashPassword(defaultPw);

    updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, {
      [COL_PEGAWAI.PASSWORD_HASH]: defaultHash
    });

    logActivity(auth.session.nip, auth.session.role, 'PASSWORD_RESET', 'USER',
      targetNip, 'Password direset ke default oleh Admin', 'SUCCESS');

    return {
      success: true,
      message: 'Password berhasil direset. Password baru: ' + defaultPw
    };
  } catch (e) {
    Logger.log('adminResetPassword error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

// ============================================================
// TESTS
// ============================================================

/**
 * TEST: RBAC enforcement — non-admin token is rejected.
 */
function test_admin_rbac() {
  Logger.log('=== TEST: Admin RBAC ===');

  // Test 1: No token
  var r1 = adminGetAllPegawai(null);
  Logger.log('T1 (null token): ' + (r1.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r1.message);

  // Test 2: Fake token
  var r2 = adminGetAllPegawai('fake-token-000');
  Logger.log('T2 (fake token): ' + (r2.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r2.message);

  // Test 3: Try a valid Pegawai session token — should fail role check
  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  var pegawaiToken = null;
  for (var i = 0; i < sessions.length; i++) {
    var nip = sessions[i][COL_SESI.NIP];
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nip);
    if (user && user.data[COL_PEGAWAI.ROLE] === ROLES.PEGAWAI) {
      pegawaiToken = sessions[i][COL_SESI.TOKEN_ID];
      break;
    }
  }
  if (pegawaiToken) {
    var r3 = adminGetAllPegawai(pegawaiToken);
    Logger.log('T3 (pegawai token): ' + (r3.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r3.message);
  } else {
    Logger.log('T3: No Pegawai session found — login as Pegawai first.');
  }

  Logger.log('=== TESTS COMPLETE ===');
}

/**
 * TEST: Duplicate NIP detection on tambah.
 */
function test_admin_tambah_duplicate_nip() {
  Logger.log('=== TEST: Duplicate NIP ===');

  var sessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  var adminToken = null;
  for (var i = 0; i < sessions.length; i++) {
    var nip = sessions[i][COL_SESI.NIP];
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nip);
    if (user && user.data[COL_PEGAWAI.ROLE] === ROLES.ADMIN) {
      adminToken = sessions[i][COL_SESI.TOKEN_ID];
      break;
    }
  }
  if (!adminToken) { Logger.log('No Admin session found — login as Admin first.'); return; }

  // Try to add duplicate NIP
  var r1 = adminTambahPegawai(adminToken, {
    nip: '198506122010011002', // Existing admin NIP
    nama: 'Test Duplikat',
    statusKepegawaian: 'PNS',
    pangkatGolongan: 'III/a',
    jabatan: 'Staf',
    role: ROLES.PEGAWAI
  });
  Logger.log('T1 (duplicate NIP): ' + (r1.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r1.message);

  // Try invalid NIP (< 18 digits)
  var r2 = adminTambahPegawai(adminToken, {
    nip: '12345', nama: 'Test', statusKepegawaian: 'PNS', role: ROLES.PEGAWAI
  });
  Logger.log('T2 (short NIP): ' + (r2.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r2.message);

  // Self-deactivation
  var r3 = adminSetStatusAkun(adminToken, '198506122010011002', 'Nonaktif');
  Logger.log('T3 (self-deactivate): ' + (r3.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r3.message);

  Logger.log('=== TESTS COMPLETE ===');
}
