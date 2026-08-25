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
        time: _formatDateTime(timestamp),
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
 * Retrieves the complete activity log for the Admin.
 * @param {string} token - Session token (Admin only).
 * @returns {Object} Result object.
 */
function adminGetLogAktivitas(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    var logs = getAllData(SHEET_NAMES.LOG_AKTIVITAS);
    var result = [];
    
    // Process from newest to oldest
    for (var k = logs.length - 1; k >= 0; k--) {
      var log = logs[k];
      result.push({
        id: log[COL_LOG.LOG_ID],
        time: _formatDateTime(log[COL_LOG.TIMESTAMP]),
        actorNip: log[COL_LOG.ACTOR_NIP],
        actorRole: log[COL_LOG.ACTOR_ROLE],
        action: log[COL_LOG.ACTION],
        targetType: log[COL_LOG.TARGET_TYPE],
        targetId: log[COL_LOG.TARGET_ID],
        description: log[COL_LOG.DESCRIPTION],
        result: log[COL_LOG.RESULT]
      });
    }

    return { success: true, data: result };
  } catch (e) {
    Logger.log('adminGetLogAktivitas error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Returns all employee records for the admin table.
 * Includes document completeness % per employee.
 * @param {string} token - Session token.
 * @returns {Object} Result with array of employee rows + summary counts.
 */
/**
 * Returns all employee records for the admin table.
 * Includes full employee data and document completeness % per employee.
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
      var nip = String(allArsip[a][COL_ARSIP.NIP]).replace(/^'+/, '').trim();
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
      var empObj = _mapPegawaiRowToObject(d);
      if (!empObj) continue;

      var empNip = empObj.nip;
      summaryTotal++;
      if (empObj.statusAkun === 'Aktif') summaryAktif++;
      else if (empObj.statusAkun === 'Nonaktif') summaryNonaktif++;

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

      empObj.docPct = pct;
      empObj.docLabel = completenessLabel;

      rows.push(empObj);
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
 * Returns full detail of a single employee for the edit form or detail view.
 * @param {string} token - Session token.
 * @param {string} targetNip - NIP of employee to fetch.
 * @returns {Object} Result with complete employee data.
 */
function adminGetPegawaiDetail(token, targetNip) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    if (!targetNip) {
      return { success: false, message: 'NIP target harus diisi.' };
    }

    var cleanNip = String(targetNip).replace(/^'+/, '').trim();
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, cleanNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    return {
      success: true,
      data: _mapPegawaiRowToObject(user.data)
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
 * Creates a new employee record with complete Identitas, Kepegawaian, and Kontak fields.
 * Default password = last 6 digits of NIP.
 * @param {string} token - Session token (Admin only).
 * @param {Object} data - Employee data payload.
 * @returns {Object} Result object.
 */
function adminTambahPegawai(token, data) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    if (!data || typeof data !== 'object') {
      return { success: false, message: 'Data pegawai tidak valid.' };
    }

    // 1. Mandatory Validations
    if (!data.nip) {
      return { success: false, message: 'NIP wajib diisi.' };
    }
    var nipStr = String(data.nip).replace(/^'+/, '').trim();
    if (!/^\d{18}$/.test(nipStr)) {
      return { success: false, message: 'NIP harus terdiri dari 18 digit angka.' };
    }

    if (!data.nama || !String(data.nama).trim()) {
      return { success: false, message: 'Nama Lengkap wajib diisi.' };
    }
    
    // Optional: NIK
    var nikStr = '';
    if (data.nik && String(data.nik).trim() !== '') {
      nikStr = String(data.nik).replace(/^'+/, '').trim();
      if (!/^\d{16}$/.test(nikStr)) {
        return { success: false, message: 'NIK harus terdiri dari 16 digit angka jika diisi.' };
      }
    }

    // Optional: Status Kepegawaian
    var statusKepegawaianStr = '';
    if (data.statusKepegawaian && String(data.statusKepegawaian).trim() !== '') {
      statusKepegawaianStr = String(data.statusKepegawaian).trim();
      if (statusKepegawaianStr === 'P3K') statusKepegawaianStr = 'PPPK';
      if (['PNS', 'CPNS', 'PPPK'].indexOf(statusKepegawaianStr) === -1) {
        return { success: false, message: 'Status Kepegawaian harus salah satu dari: PNS, CPNS, atau PPPK.' };
      }
    }

    var roleStr = data.role ? String(data.role).trim() : ROLES.PEGAWAI;
    if ([ROLES.ADMIN, ROLES.PEGAWAI].indexOf(roleStr) === -1) {
      return { success: false, message: 'Role tidak valid (harus Admin atau Pegawai).' };
    }

    // 2. Uniqueness Checks
    // Check NIP uniqueness
    var existingNip = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nipStr);
    if (existingNip) {
      return { success: false, message: 'NIP ' + nipStr + ' sudah terdaftar dalam sistem.' };
    }

    // Check NIK uniqueness
    if (isNikDuplicate(nikStr)) {
      return { success: false, message: 'NIK ' + nikStr + ' sudah terdaftar pada pegawai lain.' };
    }

    // 3. Optional Field Format Validations
    if (data.noHp && !isValidPhoneNumber(data.noHp)) {
      return { success: false, message: 'Format nomor HP tidak valid.' };
    }
    if (data.email && !isValidEmail(data.email)) {
      return { success: false, message: 'Format email tidak valid.' };
    }

    var allowedJenisKelamin = ['Laki-laki', 'Perempuan', ''];
    if (data.jenisKelamin !== undefined && allowedJenisKelamin.indexOf(data.jenisKelamin) === -1) {
      return { success: false, message: 'Pilihan jenis kelamin tidak valid.' };
    }

    var allowedAgama = ['Kristen Protestan', 'Kristen Katholik', 'Islam', 'Hindu', 'Buddha', 'Konghucu', ''];
    if (data.agama !== undefined && allowedAgama.indexOf(data.agama) === -1) {
      return { success: false, message: 'Pilihan agama tidak valid.' };
    }

    var allowedMarital = ['Belum Menikah', 'Menikah', 'Cerai', ''];
    if (data.statusPernikahan !== undefined && allowedMarital.indexOf(data.statusPernikahan) === -1) {
      return { success: false, message: 'Pilihan status pernikahan tidak valid.' };
    }

    var allowedBloodTypes = ['A', 'B', 'AB', 'O', 'Tidak Tahu', ''];
    if (data.golonganDarah !== undefined && allowedBloodTypes.indexOf(data.golonganDarah) === -1) {
      return { success: false, message: 'Golongan darah tidak valid.' };
    }

    var allowedJenisJabatan = ['Fungsional', 'Pelaksana', 'Struktural', ''];
    if (data.jenisJabatan !== undefined && allowedJenisJabatan.indexOf(data.jenisJabatan) === -1) {
      return { success: false, message: 'Jenis jabatan tidak valid.' };
    }

    // 4. Default password = last 6 digits of NIP
    var defaultPw = getDefaultPassword(nipStr);
    var passwordHash = hashPassword(defaultPw);

    // 5. Build full 25-column row matching COL_PEGAWAI
    var newRow = [
      nipStr,                                        // 0: NIP
      passwordHash,                                  // 1: PASSWORD_HASH
      roleStr,                                       // 2: ROLE
      'Aktif',                                       // 3: STATUS_AKUN
      escapeFormula(data.nama),                      // 4: NAMA_LENGKAP
      statusKepegawaianStr,                          // 5: STATUS_KEPEGAWAIAN
      escapeFormula(data.pangkatGolongan),           // 6: PANGKAT_GOLONGAN
      escapeFormula(data.jabatan),                   // 7: JABATAN
      formatPhoneForStorage(data.noHp),              // 8: NO_HP
      escapeFormula(data.alamat),                    // 9: ALAMAT
      '',                                            // 10: FOLDER_DRIVE_ID
      escapeFormula(data.email),                     // 11: EMAIL
      escapeFormula(data.golonganDarah),             // 12: GOLONGAN_DARAH
      formatNikForStorage(nikStr),                   // 13: NIK
      escapeFormula(data.tempatLahir),               // 14: TEMPAT_LAHIR
      formatDateOnly(data.tanggalLahir),             // 15: TANGGAL_LAHIR
      escapeFormula(data.jenisKelamin),              // 16: JENIS_KELAMIN
      escapeFormula(data.agama),                     // 17: AGAMA
      escapeFormula(data.pendidikanTerakhir),        // 18: PENDIDIKAN_TERAKHIR
      escapeFormula(data.statusPernikahan),          // 19: STATUS_PERNIKAHAN
      formatDateOnly(data.tmtPangkat),               // 20: TMT_PANGKAT
      escapeFormula(data.jenisJabatan),              // 21: JENIS_JABATAN
      formatDateOnly(data.tmtJabatan),               // 22: TMT_JABATAN
      escapeFormula(data.unitOrganisasi),            // 23: UNIT_ORGANISASI
      ''                                             // 24: FOTO_DRIVE_ID
    ];

    appendRow(SHEET_NAMES.DATA_PEGAWAI, newRow);

    // 6. Trigger Google Drive folder creation for new employee
    try {
      getOrCreateEmployeeFolder(nipStr);
    } catch (driveErr) {
      Logger.log('Google Drive folder creation warning: ' + driveErr.toString());
    }

    logActivity(auth.session.nip, auth.session.role, 'PEGAWAI_CREATE', 'USER',
      nipStr, 'Pegawai baru ditambahkan: ' + data.nama + ' (NIP: ' + nipStr + ')', 'SUCCESS');

    return {
      success: true,
      message: 'Pegawai berhasil ditambahkan. Password default: ' + defaultPw,
      data: {
        nip: nipStr,
        nama: data.nama
      }
    };
  } catch (e) {
    Logger.log('adminTambahPegawai error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem: ' + (e.message || e.toString()) };
  }
}

// ============================================================
// UPDATE
// ============================================================

/**
 * Updates an employee's editable fields (Admin can edit all identity, employment, contact, and system fields).
 * @param {string} token - Session token.
 * @param {string} targetNip - NIP of employee to update.
 * @param {Object} updates - Field updates.
 * @returns {Object} Result object.
 */
function adminUpdatePegawai(token, targetNip, updates) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    if (!targetNip) {
      return { success: false, message: 'NIP target harus diisi.' };
    }

    var cleanNip = String(targetNip).replace(/^'+/, '').trim();
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, cleanNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    if (!updates || typeof updates !== 'object') {
      return { success: false, message: 'Data pembaruan tidak valid.' };
    }

    // 1. Validate NIK if provided & uniqueness check
    if (updates.nik !== undefined) {
      var cleanNik = String(updates.nik).replace(/^'+/, '').trim();
      if (cleanNik && !/^\d{16}$/.test(cleanNik)) {
        return { success: false, message: 'NIK harus terdiri dari 16 digit angka.' };
      }
      if (cleanNik && isNikDuplicate(cleanNik, cleanNip)) {
        return { success: false, message: 'NIK ' + cleanNik + ' sudah terdaftar pada pegawai lain.' };
      }
    }

    // 2. Validate Role
    if (updates.role !== undefined && [ROLES.ADMIN, ROLES.PEGAWAI].indexOf(updates.role) === -1) {
      return { success: false, message: 'Role tidak valid.' };
    }

    // 3. Validate Status Akun
    var validStatuses = ['Aktif', 'Nonaktif', 'Ganti_Password'];
    if (updates.statusAkun !== undefined && validStatuses.indexOf(updates.statusAkun) === -1) {
      return { success: false, message: 'Status akun tidak valid.' };
    }

    // 4. Validate Status Kepegawaian
    if (updates.statusKepegawaian !== undefined) {
      var stNorm = String(updates.statusKepegawaian).trim();
      if (stNorm === 'P3K') stNorm = 'PPPK';
      if (['PNS', 'CPNS', 'PPPK'].indexOf(stNorm) === -1) {
        return { success: false, message: 'Status Kepegawaian harus salah satu dari: PNS, CPNS, atau PPPK.' };
      }
    }

    // 5. Format & Enum validations
    if (updates.noHp && !isValidPhoneNumber(updates.noHp)) {
      return { success: false, message: 'Format nomor HP tidak valid.' };
    }
    if (updates.email && !isValidEmail(updates.email)) {
      return { success: false, message: 'Format email tidak valid.' };
    }

    var allowedJenisKelamin = ['Laki-laki', 'Perempuan', ''];
    if (updates.jenisKelamin !== undefined && allowedJenisKelamin.indexOf(updates.jenisKelamin) === -1) {
      return { success: false, message: 'Pilihan jenis kelamin tidak valid.' };
    }

    var allowedAgama = ['Kristen Protestan', 'Kristen Katholik', 'Islam', 'Hindu', 'Buddha', 'Konghucu', ''];
    if (updates.agama !== undefined && allowedAgama.indexOf(updates.agama) === -1) {
      return { success: false, message: 'Pilihan agama tidak valid.' };
    }

    var allowedMarital = ['Belum Menikah', 'Menikah', 'Cerai', ''];
    if (updates.statusPernikahan !== undefined && allowedMarital.indexOf(updates.statusPernikahan) === -1) {
      return { success: false, message: 'Pilihan status pernikahan tidak valid.' };
    }

    var allowedBloodTypes = ['A', 'B', 'AB', 'O', 'Tidak Tahu', ''];
    if (updates.golonganDarah !== undefined && allowedBloodTypes.indexOf(updates.golonganDarah) === -1) {
      return { success: false, message: 'Golongan darah tidak valid.' };
    }

    var allowedJenisJabatan = ['Fungsional', 'Pelaksana', 'Struktural', ''];
    if (updates.jenisJabatan !== undefined && allowedJenisJabatan.indexOf(updates.jenisJabatan) === -1) {
      return { success: false, message: 'Jenis jabatan tidak valid.' };
    }

    // 6. Build update map
    var fields = {};

    // IDENTITAS
    if (updates.nik !== undefined) fields[COL_PEGAWAI.NIK] = formatNikForStorage(updates.nik);
    if (updates.nama !== undefined && String(updates.nama).trim()) fields[COL_PEGAWAI.NAMA_LENGKAP] = escapeFormula(updates.nama);
    if (updates.tempatLahir !== undefined) fields[COL_PEGAWAI.TEMPAT_LAHIR] = escapeFormula(updates.tempatLahir);
    if (updates.tanggalLahir !== undefined) fields[COL_PEGAWAI.TANGGAL_LAHIR] = formatDateOnly(updates.tanggalLahir);
    if (updates.jenisKelamin !== undefined) fields[COL_PEGAWAI.JENIS_KELAMIN] = escapeFormula(updates.jenisKelamin);
    if (updates.agama !== undefined) fields[COL_PEGAWAI.AGAMA] = escapeFormula(updates.agama);
    if (updates.pendidikanTerakhir !== undefined) fields[COL_PEGAWAI.PENDIDIKAN_TERAKHIR] = escapeFormula(updates.pendidikanTerakhir);
    if (updates.statusPernikahan !== undefined) fields[COL_PEGAWAI.STATUS_PERNIKAHAN] = escapeFormula(updates.statusPernikahan);
    if (updates.golonganDarah !== undefined) fields[COL_PEGAWAI.GOLONGAN_DARAH] = escapeFormula(updates.golonganDarah);

    // KEPEGAWAIAN
    if (updates.statusKepegawaian !== undefined) {
      var stKepeg = String(updates.statusKepegawaian).trim();
      if (stKepeg === 'P3K') stKepeg = 'PPPK';
      fields[COL_PEGAWAI.STATUS_KEPEGAWAIAN] = escapeFormula(stKepeg);
    }
    if (updates.pangkatGolongan !== undefined) fields[COL_PEGAWAI.PANGKAT_GOLONGAN] = escapeFormula(updates.pangkatGolongan);
    if (updates.tmtPangkat !== undefined) fields[COL_PEGAWAI.TMT_PANGKAT] = formatDateOnly(updates.tmtPangkat);
    if (updates.jabatan !== undefined) fields[COL_PEGAWAI.JABATAN] = escapeFormula(updates.jabatan);
    if (updates.jenisJabatan !== undefined) fields[COL_PEGAWAI.JENIS_JABATAN] = escapeFormula(updates.jenisJabatan);
    if (updates.tmtJabatan !== undefined) fields[COL_PEGAWAI.TMT_JABATAN] = formatDateOnly(updates.tmtJabatan);
    if (updates.unitOrganisasi !== undefined) fields[COL_PEGAWAI.UNIT_ORGANISASI] = escapeFormula(updates.unitOrganisasi);

    // KONTAK
    if (updates.noHp !== undefined) fields[COL_PEGAWAI.NO_HP] = formatPhoneForStorage(updates.noHp);
    if (updates.email !== undefined) fields[COL_PEGAWAI.EMAIL] = escapeFormula(updates.email);
    if (updates.alamat !== undefined) fields[COL_PEGAWAI.ALAMAT] = escapeFormula(updates.alamat);

    // SYSTEM
    if (updates.role !== undefined) fields[COL_PEGAWAI.ROLE] = escapeFormula(updates.role);
    if (updates.statusAkun !== undefined) fields[COL_PEGAWAI.STATUS_AKUN] = escapeFormula(updates.statusAkun);

    if (Object.keys(fields).length === 0) {
      return { success: false, message: 'Tidak ada perubahan untuk disimpan.' };
    }

    updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, fields);

    logActivity(auth.session.nip, auth.session.role, 'PEGAWAI_UPDATE', 'USER',
      cleanNip, 'Data pegawai diperbarui: ' + Object.keys(fields).join(', '), 'SUCCESS');

    return { success: true, message: 'Data pegawai berhasil diperbarui.' };
  } catch (e) {
    Logger.log('adminUpdatePegawai error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem: ' + (e.message || e.toString()) };
  }
}

/**
 * Uploads a profile photo for any target employee (Admin only).
 * @param {string} token - Session token (Admin only).
 * @param {string} targetNip - NIP of employee.
 * @param {string} base64Data - Base64 encoded image data.
 * @param {string} mimeType - Image mime type (JPEG, JPG, PNG).
 * @returns {Object} Result object.
 */
function adminUploadFotoPegawai(token, targetNip, base64Data, mimeType) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    if (!targetNip) {
      return { success: false, message: 'NIP target harus diisi.' };
    }

    var cleanNip = String(targetNip).replace(/^'+/, '').trim();
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, cleanNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    if (!base64Data || typeof base64Data !== 'string') {
      return { success: false, message: 'Data file foto tidak valid atau kosong.' };
    }

    var cleanBase64 = base64Data.trim();
    if (cleanBase64.indexOf(',') !== -1) {
      cleanBase64 = cleanBase64.split(',')[1];
    }
    cleanBase64 = cleanBase64.replace(/\s/g, '');

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

    var approxBytes = Math.ceil(cleanBase64.length * 0.75);
    if (approxBytes > 5 * 1024 * 1024) {
      return { success: false, message: 'Ukuran foto melebihi batas maksimal 5 MB.' };
    }

    // Trash old photo if exists
    var oldFotoDriveId = String(user.data[COL_PEGAWAI.FOTO_DRIVE_ID] || '').replace(/^'+/, '').trim();
    if (oldFotoDriveId) {
      try {
        DriveApp.getFileById(oldFotoDriveId).setTrashed(true);
      } catch (e) {
        Logger.log('Could not trash old photo ' + oldFotoDriveId + ': ' + e.toString());
      }
    }

    var empFolder = getOrCreateEmployeeFolder(cleanNip);
    var fileName = cleanNip + '_FOTO.' + ext;

    var decodedBytes = Utilities.newBlob(
      Utilities.base64Decode(cleanBase64),
      cleanMime,
      fileName
    );

    var newFile = empFolder.createFile(decodedBytes);
    var newFileId = newFile.getId();

    updateRowFields(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, {
      [COL_PEGAWAI.FOTO_DRIVE_ID]: newFileId
    });

    logActivity(auth.session.nip, auth.session.role, 'FOTO_PROFIL_UPLOAD', 'USER',
      cleanNip, 'Foto profil pegawai diunggah oleh Admin: ' + fileName, 'SUCCESS');

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
    Logger.log('adminUploadFotoPegawai error: ' + e.toString());
    return { success: false, message: 'Gagal mengunggah foto profil: ' + (e.message || e.toString()) };
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
 * Permanently deletes an employee record and associated data.
 * @param {string} token - Session token.
 * @param {string} targetNip - NIP of employee to delete.
 * @returns {Object} Result object.
 */
function adminDeletePegawai(token, targetNip) {
  try {
    var auth = authorize(token, [ROLES.ADMIN], false);
    if (!auth.authorized) return { success: false, message: auth.error };

    // Prevent admin from deleting their own account
    if (String(targetNip) === String(auth.session.nip)) {
      return { success: false, message: 'Anda tidak dapat menghapus akun Anda sendiri.' };
    }

    var cleanNip = String(targetNip).replace(/^'+/, '').trim();
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, cleanNip);
    if (!user) return { success: false, message: 'Pegawai tidak ditemukan.' };

    var namaPegawai = String(user.data[COL_PEGAWAI.NAMA_LENGKAP]).trim();

    // 1. Rename Drive folder (Option B selected)
    var folderId = String(user.data[COL_PEGAWAI.FOLDER_DRIVE_ID] || '').trim();
    if (folderId) {
      try {
        var folder = DriveApp.getFolderById(folderId);
        folder.setName('[DELETED] - ' + namaPegawai);
      } catch (e) {
        Logger.log('Could not rename Drive folder ' + folderId + ': ' + e.toString());
      }
    }

    // 2. Delete rows in Arsip_Dokumen (col NIP is index 1, see COL_ARSIP.NIP)
    deleteByColumnValue(SHEET_NAMES.ARSIP_DOKUMEN, 1, cleanNip);

    // 3. Delete sessions in Sesi_Login (col NIP is index 1, see COL_SESI.NIP)
    deleteByColumnValue(SHEET_NAMES.SESI_LOGIN, 1, cleanNip);

    // 4. Delete the main record in Data_Pegawai
    deleteByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, cleanNip);

    logActivity(auth.session.nip, auth.session.role, 'PEGAWAI_DELETE', 'USER',
      cleanNip, 'Data pegawai dihapus: ' + namaPegawai, 'SUCCESS');

    return {
      success: true,
      message: 'Data pegawai ' + namaPegawai + ' berhasil dihapus.'
    };
  } catch (e) {
    Logger.log('adminDeletePegawai error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem saat menghapus pegawai.' };
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

    // Lookup document name for notification
    var masterDoc = findByPrimaryKey(SHEET_NAMES.MASTER_DOKUMEN, docId);
    var namaDokumen = masterDoc ? masterDoc.data[COL_MASTER_DOKUMEN.NAMA_DOKUMEN] : docId;
    var waStatus = notifyDokumenApproved(String(targetNip).replace(/^'+/, '').trim(), namaDokumen);

    return {
      success: true,
      message: 'Dokumen berhasil disetujui. (' + waStatus + ')'
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
      [COL_ARSIP.CATATAN_ADMIN]: escapeFormula(reasonStr),
      [COL_ARSIP.WAKTU_VERIFIKASI]: nowStr,
      [COL_ARSIP.NIP_VERIFIER]: verifierNip
    });

    var targetNip = record.data[COL_ARSIP.NIP];
    var docId = record.data[COL_ARSIP.ID_DOKUMEN];
    logActivity(verifierNip, auth.session.role, 'DOKUMEN_REJECT', 'DOCUMENT',
      idArsip, 'Verifikasi dokumen ditolak: ID ' + docId + ' (NIP ' + targetNip + '). Alasan: ' + reasonStr, 'SUCCESS');

    // Lookup document name for notification
    var masterDoc = findByPrimaryKey(SHEET_NAMES.MASTER_DOKUMEN, docId);
    var namaDokumen = masterDoc ? masterDoc.data[COL_MASTER_DOKUMEN.NAMA_DOKUMEN] : docId;
    var waStatus = notifyDokumenRejected(String(targetNip).replace(/^'+/, '').trim(), namaDokumen, null, reasonStr);

    return {
      success: true,
      message: 'Dokumen berhasil ditolak. (' + waStatus + ')'
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
 * TEST: Duplicate NIK detection and validation on tambah & update.
 */
function test_admin_pegawai_crud_validation() {
  Logger.log('=== TEST: Pegawai CRUD Validation (NIP, NIK, Updates) ===');

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

  // Test 1: Invalid NIK format (< 16 digits)
  var r1 = adminTambahPegawai(adminToken, {
    nip: '199901012025011099',
    nik: '12345',
    nama: 'Test NIK Pendek',
    statusKepegawaian: 'PNS',
    role: ROLES.PEGAWAI
  });
  Logger.log('T1 (invalid NIK length): ' + (r1.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r1.message);

  // Test 2: Duplicate NIK on create
  var r2 = adminTambahPegawai(adminToken, {
    nip: '199901012025011099',
    nik: '5371015206850001',
    nama: 'Test NIK Duplikat',
    statusKepegawaian: 'PNS',
    role: ROLES.PEGAWAI
  });
  Logger.log('T2 (duplicate NIK on create): ' + (r2.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r2.message);

  // Test 3: Duplicate NIK on update to another employee's NIK
  var r3 = adminUpdatePegawai(adminToken, '199003152015022003', {
    nik: '5371015206850001'
  });
  Logger.log('T3 (duplicate NIK on update): ' + (r3.success === false ? 'PASS ✓' : 'FAIL ✗') + ' — ' + r3.message);

  // Test 4: Successful detail retrieval
  var r4 = adminGetPegawaiDetail(adminToken, '199003152015022003');
  Logger.log('T4 (getPegawaiDetail): ' + (r4.success === true && r4.data && r4.data.nik !== undefined ? 'PASS ✓' : 'FAIL ✗'));

  Logger.log('=== CRUD VALIDATION TESTS COMPLETE ===');
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


