// ============================================================
// Admin.gs — Admin Master Data Pegawai CRUD
// All functions require Role = 'Admin' via authorize()
// Note: COL_ARSIP and DOC_STATUS are defined in Pegawai.gs
// ============================================================

// ============================================================
// LIST / READ
// ============================================================

/**
 * Returns dashboard summary statistics and recent activities for Admin Dashboard.
 * @param {string} token - Session token.
 * @returns {Object} { success, data: { totalPegawai, pns, cpns, p3k, pendingVerifikasi, docPct, recentActivities } }
 */
function adminGetDashboardStats(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var allPegawai = getAllData(SHEET_NAMES.DATA_PEGAWAI);
    var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
    var masterDoks = getAllData(SHEET_NAMES.MASTER_DOKUMEN);
    var logs = getAllData(SHEET_NAMES.LOG_AKTIVITAS);

    // Tally employee status
    var totalPegawai = allPegawai.length;
    var pns = 0;
    var cpns = 0;
    var p3k = 0;

    for (var i = 0; i < allPegawai.length; i++) {
      var st = String(allPegawai[i][COL_PEGAWAI.STATUS_KEPEGAWAIAN] || '').toUpperCase();
      if (st.indexOf('PNS') !== -1 && st.indexOf('CPNS') === -1) {
        pns++;
      } else if (st.indexOf('CPNS') !== -1) {
        cpns++;
      } else {
        p3k++;
      }
    }

    // Tally pending verification
    var pendingVerifikasi = 0;
    for (var j = 0; j < allArsip.length; j++) {
      if (allArsip[j][COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.MENUNGGU) {
        pendingVerifikasi++;
      }
    }

    // Calculate overall document completeness %
    var wajibIds = [];
    for (var w = 0; w < masterDoks.length; w++) {
      if (masterDoks[w][3] === 'Ya') wajibIds.push(masterDoks[w][0]);
    }

    var arsipByNip = {};
    for (var a = 0; a < allArsip.length; a++) {
      var nip = String(allArsip[a][COL_ARSIP.NIP]);
      var docId = allArsip[a][COL_ARSIP.ID_DOKUMEN];
      var status = allArsip[a][COL_ARSIP.STATUS_VERIFIKASI];
      if (!arsipByNip[nip]) arsipByNip[nip] = {};
      arsipByNip[nip][docId] = status;
    }

    var totalWajibPossible = allPegawai.length * wajibIds.length;
    var totalWajibVerified = 0;

    for (var p = 0; p < allPegawai.length; p++) {
      var empNip = String(allPegawai[p][COL_PEGAWAI.NIP]);
      var empArsip = arsipByNip[empNip] || {};
      for (var w2 = 0; w2 < wajibIds.length; w2++) {
        if (empArsip[wajibIds[w2]] === DOC_STATUS.TERVERIFIKASI) {
          totalWajibVerified++;
        }
      }
    }

    var docPct = totalWajibPossible > 0 ? Math.round((totalWajibVerified / totalWajibPossible) * 100) : 0;

    // Recent Activity (last 10 logs)
    var recentActivities = [];
    var maxLogs = Math.min(logs.length, 10);
    for (var k = logs.length - 1; k >= logs.length - maxLogs; k--) {
      if (k < 0) break;
      var log = logs[k];
      var timestamp = log[COL_LOG.TIMESTAMP];
      var actorNip = log[COL_LOG.ACTOR_NIP];
      var description = log[COL_LOG.DESCRIPTION];
      var action = log[COL_LOG.ACTION];

      recentActivities.push({
        id: log[COL_LOG.LOG_ID],
        time: _formatDate(timestamp),
        actorNip: actorNip,
        action: action,
        description: description
      });
    }

    return {
      success: true,
      data: {
        totalPegawai: totalPegawai,
        pns: pns,
        cpns: cpns,
        p3k: p3k,
        pendingVerifikasi: pendingVerifikasi,
        docPct: docPct,
        recentActivities: recentActivities
      }
    };

  } catch (e) {
    Logger.log('adminGetDashboardStats error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

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
        noHp: formatPhoneForDisplay(d[COL_PEGAWAI.NO_HP]),
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
        noHp: formatPhoneForDisplay(d[COL_PEGAWAI.NO_HP]),
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
      formatPhoneForStorage(data.noHp),
      String(data.alamat || '').trim(),
      '', // Folder_Drive_ID — set later
      String(data.email || '').trim(),
      String(data.golonganDarah || '').trim()
    ];

    appendRow(SHEET_NAMES.DATA_PEGAWAI, newRow);

    // Trigger Google Drive folder creation for new employee
    try {
      getOrCreateEmployeeFolder(nipStr);
    } catch (driveErr) {
      Logger.log('Google Drive folder creation warning: ' + driveErr.toString());
    }

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

    // Build update map — admin-editable columns
    var fields = {};
    if (updates.nama !== undefined && String(updates.nama).trim()) {
      fields[COL_PEGAWAI.NAMA_LENGKAP] = String(updates.nama).trim();
    }
    if (updates.statusKepegawaian !== undefined) fields[COL_PEGAWAI.STATUS_KEPEGAWAIAN] = String(updates.statusKepegawaian).trim();
    if (updates.pangkatGolongan !== undefined)   fields[COL_PEGAWAI.PANGKAT_GOLONGAN] = String(updates.pangkatGolongan).trim();
    if (updates.jabatan !== undefined)           fields[COL_PEGAWAI.JABATAN] = String(updates.jabatan).trim();
    if (updates.noHp !== undefined)              fields[COL_PEGAWAI.NO_HP] = formatPhoneForStorage(updates.noHp);
    if (updates.alamat !== undefined)            fields[COL_PEGAWAI.ALAMAT] = String(updates.alamat).trim();
    if (updates.email !== undefined)             fields[COL_PEGAWAI.EMAIL] = String(updates.email).trim();
    if (updates.golonganDarah !== undefined)     fields[COL_PEGAWAI.GOLONGAN_DARAH] = String(updates.golonganDarah).trim();
    if (updates.role !== undefined)              fields[COL_PEGAWAI.ROLE] = updates.role;
    if (updates.statusAkun !== undefined)        fields[COL_PEGAWAI.STATUS_AKUN] = updates.statusAkun;

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
// PHASE 07 — DOCUMENT VERIFICATION ENGINE
// ============================================================

/**
 * Retrieves queue of documents with status 'Menunggu Verifikasi' or 'Menunggu', ordered Oldest First.
 * Joined with employee profile and master document metadata.
 * @param {string} token - Session token (Admin only).
 * @returns {Object} Result object { success: true, data: queueArray }.
 */
function _getColIdx(headerRow, colName, defaultIdx) {
  if (!headerRow || !headerRow.length) return defaultIdx;
  var target = String(colName).toLowerCase().replace(/[^a-z0-9]/g, '');
  for (var i = 0; i < headerRow.length; i++) {
    var h = String(headerRow[i]).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (h === target) return i;
  }
  return defaultIdx;
}

/**
 * Retrieves queue of documents with status 'Menunggu Verifikasi' or 'Menunggu', ordered Oldest First.
 * Joined with employee profile and master document metadata.
 * @param {string} token - Session token (Admin only).
 * @returns {Object} Result object { success: true, data: queueArray }.
 */
function adminGetVerificationQueue(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var archiveSheet = getSheet(SHEET_NAMES.ARSIP_DOKUMEN);
    if (!archiveSheet) {
      return { success: true, data: [] };
    }
    var archiveData = archiveSheet.getDataRange().getValues();
    if (archiveData.length <= 1) {
      return { success: true, data: [] };
    }

    var header = archiveData[0];
    var idArsipCol     = _getColIdx(header, 'ID_Arsip', COL_ARSIP.ID_ARSIP);
    var nipCol         = _getColIdx(header, 'NIP', COL_ARSIP.NIP);
    var idDokCol       = _getColIdx(header, 'ID_Dokumen', COL_ARSIP.ID_DOKUMEN);
    var fileDriveIdCol = _getColIdx(header, 'File_Drive_ID', COL_ARSIP.FILE_DRIVE_ID);
    var fileUrlCol     = _getColIdx(header, 'File_URL', COL_ARSIP.FILE_URL);
    var statusCol      = _getColIdx(header, 'Status_Verifikasi', COL_ARSIP.STATUS_VERIFIKASI);
    var catatanCol     = _getColIdx(header, 'Catatan_Admin', COL_ARSIP.CATATAN_ADMIN);
    var waktuUploadCol = _getColIdx(header, 'Waktu_Upload', COL_ARSIP.WAKTU_UPLOAD);

    // Build Lookup Maps for Pegawai & Master_Dokumen
    var employeesMap = {};
    var empData = getAllData(SHEET_NAMES.DATA_PEGAWAI);
    for (var i = 0; i < empData.length; i++) {
      var empNip = String(empData[i][COL_PEGAWAI.NIP]).replace(/^'+/, '').trim();
      employeesMap[empNip] = {
        nip: empNip,
        nama: empData[i][COL_PEGAWAI.NAMA_LENGKAP],
        statusKepegawaian: empData[i][COL_PEGAWAI.STATUS_KEPEGAWAIAN],
        pangkatGolongan: empData[i][COL_PEGAWAI.PANGKAT_GOLONGAN],
        jabatan: empData[i][COL_PEGAWAI.JABATAN],
        noHp: formatPhoneForDisplay(empData[i][COL_PEGAWAI.NO_HP]),
        email: empData[i][COL_PEGAWAI.EMAIL] || ''
      };
    }

    var masterDocsMap = {};
    var masterData = getAllData(SHEET_NAMES.MASTER_DOKUMEN);
    for (var j = 0; j < masterData.length; j++) {
      var docId = String(masterData[j][COL_MASTER_DOKUMEN.ID_DOKUMEN]).trim();
      masterDocsMap[docId] = {
        idDokumen: docId,
        namaDokumen: masterData[j][COL_MASTER_DOKUMEN.NAMA_DOKUMEN],
        kategori: masterData[j][COL_MASTER_DOKUMEN.KATEGORI],
        wajib: masterData[j][COL_MASTER_DOKUMEN.STATUS_WAJIB]
      };
    }

    var queue = [];
    for (var k = 1; k < archiveData.length; k++) {
      var row = archiveData[k];
      var status = String(row[statusCol] || '').trim();
      if (status.toLowerCase().indexOf('menunggu') !== -1) {
        var empNipStr = String(row[nipCol] || '').replace(/^'+/, '').trim();
        var docIdStr = String(row[idDokCol] || '').trim();
        var empInfo = employeesMap[empNipStr] || { nip: empNipStr, nama: 'Pegawai (NIP ' + empNipStr + ')', statusKepegawaian: '—', pangkatGolongan: '—' };
        var docInfo = masterDocsMap[docIdStr] || { namaDokumen: docIdStr || 'Dokumen', kategori: 'Utama' };

        var rawDriveId = String(row[fileDriveIdCol] || '').replace(/^'+/, '').trim();
        var rawUrl = String(row[fileUrlCol] || '').trim();

        // Check if file physically exists in Google Drive
        var isDriveValid = false;
        if (rawDriveId) {
          try {
            var df = DriveApp.getFileById(rawDriveId);
            if (df && !df.isTrashed()) isDriveValid = true;
          } catch (e) {
            isDriveValid = false;
          }
        }

        if (!isDriveValid) {
          var idArsipVal = String(row[idArsipCol] || '').trim();
          if (idArsipVal) {
            var matchRecord = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsipVal);
            if (matchRecord) {
              updateRowFields(SHEET_NAMES.ARSIP_DOKUMEN, matchRecord.rowIndex, {
                [COL_ARSIP.STATUS_VERIFIKASI]: DOC_STATUS.BELUM_UNGGAH,
                [COL_ARSIP.FILE_DRIVE_ID]: '',
                [COL_ARSIP.FILE_URL]: '',
                [COL_ARSIP.CATATAN_ADMIN]: 'File di Google Drive tidak ditemukan saat pemeriksaan antrean.'
              });
            }
          }
          continue; // Skip missing file from verification queue
        }

        var previewUrl = rawDriveId ? 'https://drive.google.com/file/d/' + rawDriveId + '/preview' : rawUrl;

        var rawTime = 0;
        if (row[waktuUploadCol]) {
          var dt = new Date(row[waktuUploadCol]);
          if (!isNaN(dt.getTime())) rawTime = dt.getTime();
        }

        queue.push({
          idArsip: String(row[idArsipCol] || '').trim(),
          nip: empNipStr,
          idDokumen: docIdStr,
          fileDriveId: rawDriveId,
          fileUrl: rawUrl,
          previewUrl: previewUrl,
          statusVerifikasi: status,
          catatanAdmin: String(row[catatanCol] || ''),
          waktuUpload: row[waktuUploadCol] ? formatDateForDisplay(row[waktuUploadCol]) : '—',
          rawWaktuUpload: rawTime,
          employee: empInfo,
          masterDoc: docInfo
        });
      }
    }

    // Sort queue OLDEST FIRST by Waktu_Upload
    queue.sort(function(a, b) {
      return a.rawWaktuUpload - b.rawWaktuUpload;
    });

    return {
      success: true,
      data: queue
    };
  } catch (e) {
    Logger.log('adminGetVerificationQueue error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem: ' + (e.message || e.toString()) };
  }
}

/**
 * Approves a document verification request.
 * Sets Status_Verifikasi to 'Terverifikasi', updates Waktu_Verifikasi & NIP_Verifier, logs audit trail.
 * @param {string} token - Session token (Admin only).
 * @param {string} idArsip - ID of document archive entry.
 * @returns {Object} Result object.
 */
function adminApproveDokumen(token, idArsip) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    if (!idArsip) {
      return { success: false, message: 'ID Dokumen tidak valid.' };
    }

    var record = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsip);
    if (!record) {
      return { success: false, message: 'Dokumen tidak ditemukan.' };
    }

    var currentStatus = String(record.data[COL_ARSIP.STATUS_VERIFIKASI]).trim();
    if (currentStatus === 'Terverifikasi') {
      return { success: false, message: 'Dokumen ini sudah terverifikasi sebelumnya.' };
    }

    var nowStr = getTimestamp();
    var verifierNip = auth.session.nip;

    updateRowFields(SHEET_NAMES.ARSIP_DOKUMEN, record.rowIndex, {
      [COL_ARSIP.STATUS_VERIFIKASI]: 'Terverifikasi',
      [COL_ARSIP.WAKTU_VERIFIKASI]: nowStr,
      [COL_ARSIP.NIP_VERIFIER]: verifierNip
    });

    var targetNip = record.data[COL_ARSIP.NIP];
    var docId = record.data[COL_ARSIP.ID_DOKUMEN];
    logActivity(verifierNip, auth.session.role, 'DOKUMEN_APPROVE', 'DOCUMENT',
      idArsip, 'Verifikasi dokumen disetujui: ID ' + docId + ' (NIP ' + targetNip + ')', 'SUCCESS');

    return {
      success: true,
      message: 'Dokumen berhasil disetujui.'
    };
  } catch (e) {
    Logger.log('adminApproveDokumen error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem: ' + (e.message || e.toString()) };
  }
}

/**
 * Rejects a document verification request with mandatory rejection reason.
 * Sets Status_Verifikasi to 'Ditolak', Catatan_Admin, Waktu_Verifikasi & NIP_Verifier, logs audit trail.
 * @param {string} token - Session token (Admin only).
 * @param {string} idArsip - ID of document archive entry.
 * @param {string} alasanPenolakan - Rejection reason (Mandatory).
 * @returns {Object} Result object.
 */
function adminRejectDokumen(token, idArsip, alasanPenolakan) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    if (!idArsip) {
      return { success: false, message: 'ID Dokumen tidak valid.' };
    }

    var reasonStr = String(alasanPenolakan || '').trim();
    if (!reasonStr) {
      return { success: false, message: 'Alasan penolakan wajib diisi.' };
    }

    var record = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsip);
    if (!record) {
      return { success: false, message: 'Dokumen tidak ditemukan.' };
    }

    var currentStatus = String(record.data[COL_ARSIP.STATUS_VERIFIKASI]).trim();
    if (currentStatus === 'Ditolak') {
      return { success: false, message: 'Dokumen ini sudah ditolak sebelumnya.' };
    }

    var nowStr = getTimestamp();
    var verifierNip = auth.session.nip;

    updateRowFields(SHEET_NAMES.ARSIP_DOKUMEN, record.rowIndex, {
      [COL_ARSIP.STATUS_VERIFIKASI]: 'Ditolak',
      [COL_ARSIP.CATATAN_ADMIN]: reasonStr,
      [COL_ARSIP.WAKTU_VERIFIKASI]: nowStr,
      [COL_ARSIP.NIP_VERIFIER]: verifierNip
    });

    var targetNip = record.data[COL_ARSIP.NIP];
    var docId = record.data[COL_ARSIP.ID_DOKUMEN];
    logActivity(verifierNip, auth.session.role, 'DOKUMEN_REJECT', 'DOCUMENT',
      idArsip, 'Verifikasi dokumen ditolak: ID ' + docId + ' (NIP ' + targetNip + '). Alasan: ' + reasonStr, 'SUCCESS');

    return {
      success: true,
      message: 'Dokumen berhasil ditolak.'
    };
  } catch (e) {
    Logger.log('adminRejectDokumen error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem: ' + (e.message || e.toString()) };
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

/**
 * TEST: Document verification engine (Queue, Approve, Reject, Authorization).
 */
function test_admin_verification() {
  Logger.log('=== TEST: Admin Verification Engine ===');

  // Test 1: Unauthorized access with null token
  var r1 = adminGetVerificationQueue(null);
  Logger.log('T1 (null token queue): ' + (r1.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r1.message);

  var r2 = adminApproveDokumen(null, 'DOC-001');
  Logger.log('T2 (null token approve): ' + (r2.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r2.message);

  var r3 = adminRejectDokumen(null, 'DOC-001', 'Reason');
  Logger.log('T3 (null token reject): ' + (r3.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r3.message);

  // Test 2: Mandatory rejection reason validation
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

  if (adminToken) {
    var r4 = adminRejectDokumen(adminToken, 'DOC-NONEXISTENT', '');
    Logger.log('T4 (empty reject reason): ' + (r4.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r4.message);

    var r5 = adminApproveDokumen(adminToken, 'DOC-NONEXISTENT');
    Logger.log('T5 (nonexistent doc approve): ' + (r5.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r5.message);
  } else {
    Logger.log('T4-T5: Login as Admin first to test with active session token.');
  }

  Logger.log('=== TESTS COMPLETE ===');
}

