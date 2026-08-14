// ============================================================
// Auth.gs — Authentication & Session Management
// ============================================================

// Session expiry in hours
var SESSION_EXPIRY_HOURS = 12;

// Valid roles for RBAC
var ROLES = {
  ADMIN: 'Admin',
  PEGAWAI: 'Pegawai'
};

// Feature Flag: Set to true in production to force users with default passwords to change their password on login.
var ENABLE_FORCE_CHANGE_PASSWORD = false;

/**
 * Authenticates a user by NIP and password.
 * Called from frontend via google.script.run.
 * @param {string} nip - The NIP (username).
 * @param {string} password - The plain text password.
 * @returns {Object} Result object with success, data, message.
 */
function login(nip, password) {
  try {
    if (!nip || !password) {
      return { success: false, message: 'NIP dan Password harus diisi.' };
    }

    // Find user by NIP
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nip);
    if (!user) {
      return { success: false, message: 'Kredensial tidak valid.' };
    }

    var userData = user.data;

    // Check account status
    var statusAkun = userData[COL_PEGAWAI.STATUS_AKUN];
    if (statusAkun === 'Nonaktif') {
      return { success: false, message: 'Akun tidak aktif. Silakan hubungi administrator.' };
    }

    // Verify password
    var passwordHash = hashPassword(password);
    if (passwordHash !== userData[COL_PEGAWAI.PASSWORD_HASH]) {
      return { success: false, message: 'Kredensial tidak valid.' };
    }

    // Check if using default password (last 6 digits of NIP)
    var defaultPassword = getDefaultPassword(nip);
    var isDefaultPassword = (password === defaultPassword);
    var shouldForceChange = ENABLE_FORCE_CHANGE_PASSWORD && isDefaultPassword;

    // Create session token
    var token = generateUUID();
    var now = new Date();
    var expiry = new Date(now.getTime() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

    // Store session in Sesi_Login sheet
    appendRow(SHEET_NAMES.SESI_LOGIN, [
      token,
      nip,
      getTimestamp(),
      Utilities.formatDate(expiry, 'Asia/Makassar', "yyyy-MM-dd'T'HH:mm:ss")
    ]);

    // Log the login action
    logActivity(nip, userData[COL_PEGAWAI.ROLE], 'LOGIN', 'USER', nip, 'Login berhasil', 'SUCCESS');

    return {
      success: true,
      data: {
        token: token,
        nip: nip,
        nama: userData[COL_PEGAWAI.NAMA_LENGKAP],
        role: userData[COL_PEGAWAI.ROLE],
        statusKepegawaian: userData[COL_PEGAWAI.STATUS_KEPEGAWAIAN],
        pangkatGolongan: userData[COL_PEGAWAI.PANGKAT_GOLONGAN],
        jabatan: userData[COL_PEGAWAI.JABATAN],
        forceChangePassword: shouldForceChange
      },
      message: 'Login berhasil.'
    };
  } catch (e) {
    Logger.log('Login error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem. Silakan coba lagi.' };
  }
}

/**
 * Validates a session token server-side.
 * CRITICAL: This is called before every protected operation.
 * @param {string} token - The session token from localStorage.
 * @returns {Object|null} User session data or null if invalid.
 */
function validateSession(token) {
  if (!token) return null;

  var allSessions = getAllData(SHEET_NAMES.SESI_LOGIN);
  var now = new Date();

  for (var i = 0; i < allSessions.length; i++) {
    if (allSessions[i][COL_SESI.TOKEN_ID] === token) {
      var expiryStr = allSessions[i][COL_SESI.WAKTU_EXPIRED];
      var expiry = new Date(expiryStr);

      if (now < expiry) {
        // Token is valid — retrieve user data
        var nip = allSessions[i][COL_SESI.NIP];
        var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, nip);
        if (user && user.data[COL_PEGAWAI.STATUS_AKUN] !== 'Nonaktif') {
          var defaultPw = getDefaultPassword(nip);
          var defaultPwHash = hashPassword(defaultPw);
          var isDefaultPassword = (user.data[COL_PEGAWAI.PASSWORD_HASH] === defaultPwHash);
          var shouldForceChange = ENABLE_FORCE_CHANGE_PASSWORD && isDefaultPassword;

          return {
            nip: nip,
            nama: user.data[COL_PEGAWAI.NAMA_LENGKAP],
            role: user.data[COL_PEGAWAI.ROLE],
            statusKepegawaian: user.data[COL_PEGAWAI.STATUS_KEPEGAWAIAN],
            pangkatGolongan: user.data[COL_PEGAWAI.PANGKAT_GOLONGAN],
            jabatan: user.data[COL_PEGAWAI.JABATAN],
            forceChangePassword: shouldForceChange
          };
        }
      }
      break;
    }
  }
  return null;
}

/**
 * RBAC Authorization Middleware.
 * Validates token, checks role, and enforces force-change-password restriction.
 * CRITICAL: Every protected backend function MUST call this.
 * @param {string} token - Session token from frontend.
 * @param {Array|null} allowedRoles - Array of allowed roles (e.g. ['Admin']) or null for any authenticated user.
 * @param {boolean} allowForceChange - If true, allows access even when forceChangePassword is true.
 * @returns {Object} { authorized: boolean, session: Object|null, error: string|null }
 */
function authorize(token, allowedRoles, allowForceChange) {
  if (!token) {
    return { authorized: false, session: null, error: 'Sesi tidak valid. Silakan login kembali.' };
  }

  var session = validateSession(token);
  if (!session) {
    return { authorized: false, session: null, error: 'Sesi tidak valid atau sudah berakhir.' };
  }

  // Enforce force-change-password restriction
  if (session.forceChangePassword && !allowForceChange) {
    return { authorized: false, session: session, error: 'Anda harus mengganti password terlebih dahulu.' };
  }

  // Check role if specified
  if (allowedRoles && allowedRoles.length > 0) {
    if (allowedRoles.indexOf(session.role) === -1) {
      return { authorized: false, session: session, error: 'Anda tidak memiliki izin untuk melakukan aksi ini.' };
    }
  }

  return { authorized: true, session: session, error: null };
}

/**
 * Checks session validity. Called from frontend.
 * @param {string} token - Session token.
 * @returns {Object} Result with user data or error.
 */
function checkSession(token) {
  try {
    var session = validateSession(token);
    if (session) {
      return { success: true, data: session };
    }
    return { success: false, message: 'Sesi tidak valid atau sudah berakhir.' };
  } catch (e) {
    Logger.log('CheckSession error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Gets the current user's profile for the Settings page.
 * Returns non-sensitive user data.
 * @param {string} token - Session token.
 * @returns {Object} Result with user profile data.
 */
function getUserProfile(token) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) {
      return { success: false, message: auth.error };
    }

    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, auth.session.nip);
    if (!user) {
      return { success: false, message: 'Data pengguna tidak ditemukan.' };
    }

    return {
      success: true,
      data: _mapPegawaiRowToObject(user.data)
    };
  } catch (e) {
    Logger.log('getUserProfile error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Cleans up expired sessions from the Sesi_Login sheet.
 * Can be run as a time-driven trigger or manually.
 */
function cleanExpiredSessions() {
  try {
    var sheet = getSheet(SHEET_NAMES.SESI_LOGIN);
    if (!sheet) return;
    var data = sheet.getDataRange().getValues();
    var now = new Date();
    var deletedCount = 0;

    // Delete from bottom to top
    for (var i = data.length - 1; i >= 1; i--) {
      var expiryStr = data[i][COL_SESI.WAKTU_EXPIRED];
      if (expiryStr) {
        var expiry = new Date(expiryStr);
        if (now > expiry) {
          sheet.deleteRow(i + 1);
          deletedCount++;
        }
      }
    }
    Logger.log('Cleaned ' + deletedCount + ' expired sessions.');
    return deletedCount;
  } catch (e) {
    Logger.log('cleanExpiredSessions error: ' + e.toString());
    return 0;
  }
}

/**
 * Voluntary Password Change.
 * Requires and verifies currentPassword.
 * @param {string} token - Session token.
 * @param {string} newPassword - The new password.
 * @param {string} currentPassword - Current password (MUST be provided and verified).
 * @returns {Object} Result object.
 */
function changePassword(token, newPassword, currentPassword) {
  try {
    var auth = authorize(token, null, false);
    if (!auth.authorized) {
      return { success: false, message: auth.error };
    }

    if (!currentPassword) {
      return { success: false, message: 'Password saat ini harus diisi.' };
    }

    var session = auth.session;

    // Validate new password requirements
    if (!newPassword || newPassword.length < 8) {
      return { success: false, message: 'Password minimal 8 karakter.' };
    }
    if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword)) {
      return { success: false, message: 'Password harus mengandung huruf besar dan kecil.' };
    }
    if (!/\d/.test(newPassword)) {
      return { success: false, message: 'Password harus mengandung minimal 1 angka.' };
    }

    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, session.nip);
    if (!user) {
      return { success: false, message: 'Data pengguna tidak ditemukan.' };
    }

    // Verify current password
    var currentHash = hashPassword(currentPassword);
    if (currentHash !== user.data[COL_PEGAWAI.PASSWORD_HASH]) {
      return { success: false, message: 'Password saat ini salah.' };
    }

    // Ensure new password is not the same as default
    var defaultPw = getDefaultPassword(session.nip);
    if (newPassword === defaultPw) {
      return { success: false, message: 'Password baru tidak boleh sama dengan password default.' };
    }

    // Update password hash
    var newHash = hashPassword(newPassword);
    updateCell(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, COL_PEGAWAI.PASSWORD_HASH + 1, newHash);

    // Update account status to 'Aktif' if it was 'Ganti_Password'
    if (user.data[COL_PEGAWAI.STATUS_AKUN] === 'Ganti_Password') {
      updateCell(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, COL_PEGAWAI.STATUS_AKUN + 1, 'Aktif');
    }

    // Log the action
    logActivity(session.nip, session.role, 'PASSWORD_CHANGE', 'USER', session.nip, 'Password berhasil diubah', 'SUCCESS');

    return {
      success: true,
      data: {
        nip: session.nip,
        nama: session.nama,
        role: session.role,
        statusKepegawaian: session.statusKepegawaian,
        pangkatGolongan: session.pangkatGolongan,
        jabatan: session.jabatan,
        forceChangePassword: false
      },
      message: 'Password berhasil diubah.'
    };
  } catch (e) {
    Logger.log('ChangePassword error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Force-changes a user's password (e.g. during first login with default password).
 * Server validates that the user is actually required or eligible for force password change.
 * @param {string} token - Session token.
 * @param {string} newPassword - The new password.
 * @returns {Object} Result object.
 */
function forceChangePassword(token, newPassword) {
  try {
    var auth = authorize(token, null, true); // Allow even if forceChangePassword is true
    if (!auth.authorized) {
      return { success: false, message: auth.error };
    }

    var session = auth.session;
    var user = findByPrimaryKey(SHEET_NAMES.DATA_PEGAWAI, session.nip);
    if (!user) {
      return { success: false, message: 'Data pengguna tidak ditemukan.' };
    }

    // Check if user is actually eligible/required for force change password
    var defaultPw = getDefaultPassword(session.nip);
    var defaultHash = hashPassword(defaultPw);
    var isDefaultPw = (user.data[COL_PEGAWAI.PASSWORD_HASH] === defaultHash);
    var isGantiStatus = (user.data[COL_PEGAWAI.STATUS_AKUN] === 'Ganti_Password');

    if (!isDefaultPw && !isGantiStatus && !session.forceChangePassword) {
      return { success: false, message: 'Akun Anda tidak dalam status wajib ganti password.' };
    }

    // Validate new password requirements
    if (!newPassword || newPassword.length < 8) {
      return { success: false, message: 'Password minimal 8 karakter.' };
    }
    if (!/[a-z]/.test(newPassword) || !/[A-Z]/.test(newPassword)) {
      return { success: false, message: 'Password harus mengandung huruf besar dan kecil.' };
    }
    if (!/\d/.test(newPassword)) {
      return { success: false, message: 'Password harus mengandung minimal 1 angka.' };
    }

    // Ensure new password is not the same as default
    if (newPassword === defaultPw) {
      return { success: false, message: 'Password baru tidak boleh sama dengan password default.' };
    }

    // Update password hash
    var newHash = hashPassword(newPassword);
    updateCell(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, COL_PEGAWAI.PASSWORD_HASH + 1, newHash);

    // Update account status to 'Aktif' if it was 'Ganti_Password'
    if (user.data[COL_PEGAWAI.STATUS_AKUN] === 'Ganti_Password') {
      updateCell(SHEET_NAMES.DATA_PEGAWAI, user.rowIndex, COL_PEGAWAI.STATUS_AKUN + 1, 'Aktif');
    }

    logActivity(session.nip, session.role, 'FORCE_PASSWORD_CHANGE', 'USER', session.nip, 'Password default berhasil diubah', 'SUCCESS');

    return {
      success: true,
      data: {
        nip: session.nip,
        nama: session.nama,
        role: session.role,
        statusKepegawaian: session.statusKepegawaian,
        pangkatGolongan: session.pangkatGolongan,
        jabatan: session.jabatan,
        forceChangePassword: false
      },
      message: 'Password berhasil diubah.'
    };
  } catch (e) {
    Logger.log('forceChangePassword error: ' + e.toString());
    return { success: false, message: 'Terjadi kesalahan sistem.' };
  }
}

/**
 * Logs out a user by deleting their session.
 * @param {string} token - Session token.
 * @returns {Object} Result object.
 */
function logout(token) {
  try {
    if (token) {
      // Get user info before deleting session for audit log
      var session = validateSession(token);
      
      // Delete the session
      deleteByPrimaryKey(SHEET_NAMES.SESI_LOGIN, token);

      if (session) {
        logActivity(session.nip, session.role, 'LOGOUT', 'USER', session.nip, 'Logout berhasil', 'SUCCESS');
      }
    }
    return { success: true, message: 'Berhasil keluar.' };
  } catch (e) {
    Logger.log('Logout error: ' + e.toString());
    return { success: true, message: 'Berhasil keluar.' }; // Always return success for logout
  }
}

/**
 * Logs an activity to the Log_Aktivitas sheet.
 * @param {string} actorNip - NIP of the actor.
 * @param {string} actorRole - Role of the actor.
 * @param {string} action - Action identifier.
 * @param {string} targetType - Target type (USER, DOCUMENT, etc.).
 * @param {string} targetId - Target identifier.
 * @param {string} description - Human-readable description.
 * @param {string} result - Result (SUCCESS, FAILURE).
 */
function logActivity(actorNip, actorRole, action, targetType, targetId, description, result) {
  try {
    appendRow(SHEET_NAMES.LOG_AKTIVITAS, [
      generateUUID(),
      getTimestamp(),
      actorNip,
      actorRole,
      action,
      targetType,
      targetId,
      description,
      result
    ]);
  } catch (e) {
    Logger.log('LogActivity error: ' + e.toString());
    // Don't throw — logging failure should not break main operations
  }
}

/**
 * Seeds initial data for development/testing.
 * Run this manually once to populate the spreadsheet.
 */
function seedData() {
  var ss = getSpreadsheet();
  
  // --- Create or get sheets ---
  var sheets = {};
  for (var key in SHEET_NAMES) {
    var name = SHEET_NAMES[key];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    sheets[name] = sheet;
  }

  // --- Data_Pegawai ---
  var pegawaiSheet = sheets[SHEET_NAMES.DATA_PEGAWAI];
  pegawaiSheet.clear();
  pegawaiSheet.appendRow([
    'NIP', 'Password_Hash', 'Role', 'Status_Akun', 'Nama_Lengkap',
    'Status_Kepegawaian', 'Pangkat_Golongan', 'Jabatan', 'No_HP', 'Alamat',
    'Folder_Drive_ID', 'Email', 'Golongan_Darah', 'NIK', 'Tempat_Lahir',
    'Tanggal_Lahir', 'Jenis_Kelamin', 'Agama', 'Pendidikan_Terakhir', 'Status_Pernikahan',
    'TMT_Pangkat', 'Jenis_Jabatan', 'TMT_Jabatan', 'Unit_Organisasi', 'Foto_Drive_ID'
  ]);
  
  // Admin user — default password is last 6 digits of NIP: "011002"
  pegawaiSheet.appendRow([
    '198506122010011002', hashPassword('011002'), 'Admin', 'Aktif',
    'Maria Klementina, S.Sos', 'PNS', 'Penata / III.c', 'Kepala Subbagian Tata Usaha',
    formatPhoneForStorage('081234567890'), 'Jl. Timor Raya No. 12, Kupang', '', 'maria.klementina@ntt.go.id', 'O',
    formatNikForStorage('5371015206850001'), 'Kupang', '1985-06-12', 'Perempuan', 'Kristen Katholik', 'S-1 / Ilmu Administrasi Negara', 'Menikah',
    '2022-04-01', 'Struktural', '2020-01-15', 'Subbagian Tata Usaha', ''
  ]);

  // Employee user — default password: "022003"
  pegawaiSheet.appendRow([
    '199003152015022003', hashPassword('022003'), 'Pegawai', 'Aktif',
    'Budi Santoso, S.Kom', 'PNS', 'Penata Muda / III.a', 'Penata Kelola Sistem dan Teknologi Informasi',
    formatPhoneForStorage('085678901234'), 'Jl. El Tari No. 5, Kupang', '', 'budi.santoso@ntt.go.id', 'A',
    formatNikForStorage('5371021503900002'), 'Kupang', '1990-03-15', 'Laki-laki', 'Kristen Protestan', 'S-1 / Teknik Informatika', 'Menikah',
    '2023-10-01', 'Fungsional', '2021-06-01', 'Subbagian Tata Usaha', ''
  ]);

  // Another employee — default password: "033001"
  pegawaiSheet.appendRow([
    '198812012020033001', hashPassword('033001'), 'Pegawai', 'Aktif',
    'Antonius Ola, A.Md', 'CPNS', 'Pengatur / II.c', 'Pengelola Penetapan Pajak Daerah',
    formatPhoneForStorage('082345678901'), 'Jl. Lalamentik No. 8, Kupang', '', '', 'B',
    formatNikForStorage('5371030112880003'), 'Flores Timur', '1988-12-01', 'Laki-laki', 'Kristen Katholik', 'D-III / Perpajakan', 'Belum Menikah',
    '2024-03-01', 'Pelaksana', '2024-03-01', 'Seksi Penetapan', ''
  ]);

  // PPPK employee — default password: "044001"
  pegawaiSheet.appendRow([
    '200105202022044001', hashPassword('044001'), 'Pegawai', 'Aktif',
    'Siti Aminah, S.E', 'PPPK', 'Ahli Pertama (IX)', 'Verifikator Pajak Daerah',
    formatPhoneForStorage('087654321098'), 'Jl. Soekarno No. 3, Kupang', '', '', 'AB',
    formatNikForStorage('5371046005010004'), 'Kupang', '2001-05-20', 'Perempuan', 'Islam', 'S-1 / Akuntansi', 'Belum Menikah',
    '2022-04-01', 'Fungsional', '2022-04-01', 'Seksi Verifikasi', ''
  ]);

  // Inactive employee for testing — default password: "055001"
  pegawaiSheet.appendRow([
    '197501012005055001', hashPassword('055001'), 'Pegawai', 'Nonaktif',
    'Ahmad Fauzi, S.H', 'PNS', 'Pembina / IV.a', 'Pemeriksa Pajak Daerah (Pensiun)',
    formatPhoneForStorage('089012345678'), 'Jl. Veteran No. 20, Kupang', '', '', '',
    formatNikForStorage('5371010101750005'), 'Rote', '1975-01-01', 'Laki-laki', 'Islam', 'S-1 / Ilmu Hukum', 'Menikah',
    '2018-04-01', 'Fungsional', '2015-02-01', 'Seksi Penetapan', ''
  ]);

  // --- Master_Dokumen ---
  var dokumenSheet = sheets[SHEET_NAMES.MASTER_DOKUMEN];
  dokumenSheet.clear();
  dokumenSheet.appendRow(['ID_Dokumen', 'Nama_Dokumen', 'Kategori', 'Status_Wajib']);
  dokumenSheet.appendRow(['DOC-KTP', 'Kartu Tanda Penduduk (KTP)', 'Dokumen Pribadi', 'Ya']);
  dokumenSheet.appendRow(['DOC-KK', 'Kartu Keluarga (KK)', 'Dokumen Pribadi', 'Ya']);
  dokumenSheet.appendRow(['DOC-NPWP', 'NPWP', 'Dokumen Pribadi', 'Ya']);
  dokumenSheet.appendRow(['DOC-SK-CPNS', 'SK CPNS', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-SPMT-CPNS', 'SPMT CPNS', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-SK-PNS', 'SK PNS', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-DRH', 'DRH', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-IJAZAH', 'Ijazah Terakhir', 'Dokumen Pendidikan', 'Ya']);
  dokumenSheet.appendRow(['DOC-SKP', 'SKP', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-KARPEG', 'Kartu Pegawai (KARPEG)', 'Dokumen Kepegawaian', 'Tidak']);
  dokumenSheet.appendRow(['DOC-TASPEN', 'Kartu Taspen', 'Dokumen Kepegawaian', 'Tidak']);

  // --- Arsip_Dokumen (sample data for Budi Santoso dashboard) ---
  var arsipSheet = sheets[SHEET_NAMES.ARSIP_DOKUMEN];
  arsipSheet.clear();
  arsipSheet.appendRow([
    'ID_Arsip', 'NIP', 'ID_Dokumen', 'File_Drive_ID', 'File_URL',
    'Status_Verifikasi', 'Catatan_Admin', 'Waktu_Upload', 'Waktu_Verifikasi', 'NIP_Verifier'
  ]);
  var sampleNip = '199003152015022003';
  var now2 = new Date();
  arsipSheet.appendRow([generateUUID(), sampleNip, 'DOC-KTP', '', '', 'Terverifikasi', '', now2, now2, '198506122010011002']);
  arsipSheet.appendRow([generateUUID(), sampleNip, 'DOC-KK', '', '', 'Terverifikasi', '', now2, now2, '198506122010011002']);
  arsipSheet.appendRow([generateUUID(), sampleNip, 'DOC-NPWP', '', '', 'Terverifikasi', '', now2, now2, '198506122010011002']);
  arsipSheet.appendRow([generateUUID(), sampleNip, 'DOC-SK-CPNS', '', '', 'Terverifikasi', '', now2, now2, '198506122010011002']);
  arsipSheet.appendRow([generateUUID(), sampleNip, 'DOC-SK-PNS', '', '', 'Menunggu', '', now2, '', '']);
  arsipSheet.appendRow([generateUUID(), sampleNip, 'DOC-SPMT-CPNS', '', '', 'Ditolak', 'Dokumen tidak terbaca, harap unggah ulang dengan resolusi lebih tinggi.', now2, now2, '198506122010011002']);
  // DOC-DRH, DOC-IJAZAH, DOC-SKP, DOC-KARPEG, DOC-TASPEN intentionally not uploaded yet

  // --- Sesi_Login ---
  var sesiSheet = sheets[SHEET_NAMES.SESI_LOGIN];
  sesiSheet.clear();
  sesiSheet.appendRow(['Token_ID', 'NIP', 'Waktu_Dibuat', 'Waktu_Expired']);

  // --- Log_Aktivitas ---
  var logSheet = sheets[SHEET_NAMES.LOG_AKTIVITAS];
  logSheet.clear();
  logSheet.appendRow([
    'Log_ID', 'Timestamp', 'Actor_NIP', 'Actor_Role', 'Action',
    'Target_Type', 'Target_ID', 'Description', 'Result'
  ]);

  Logger.log('Seed data created successfully.');
  return 'Seed data berhasil dibuat.';
}

/**
 * TEST: Verifies audit log entries for all 10 action categories.
 */
function test_audit_logging() {
  Logger.log('=== TEST: Audit Logging Suite ===');

  var actionsToTest = [
    { action: 'LOGIN', targetType: 'USER', desc: 'Test Audit LOGIN' },
    { action: 'LOGOUT', targetType: 'USER', desc: 'Test Audit LOGOUT' },
    { action: 'PASSWORD_CHANGE', targetType: 'USER', desc: 'Test Audit PASSWORD_CHANGE' },
    { action: 'PEGAWAI_CREATE', targetType: 'USER', desc: 'Test Audit PEGAWAI_CREATE' },
    { action: 'PEGAWAI_UPDATE', targetType: 'USER', desc: 'Test Audit PEGAWAI_UPDATE' },
    { action: 'PEGAWAI_DEACTIVATE', targetType: 'USER', desc: 'Test Audit PEGAWAI_DEACTIVATE' },
    { action: 'DOKUMEN_UPLOAD', targetType: 'DOCUMENT', desc: 'Test Audit DOKUMEN_UPLOAD' },
    { action: 'DOKUMEN_REUPLOAD', targetType: 'DOCUMENT', desc: 'Test Audit DOKUMEN_REUPLOAD' },
    { action: 'DOKUMEN_APPROVE', targetType: 'DOCUMENT', desc: 'Test Audit DOKUMEN_APPROVE' },
    { action: 'DOKUMEN_REJECT', targetType: 'DOCUMENT', desc: 'Test Audit DOKUMEN_REJECT' }
  ];

  var testNip = '198506122010011002';
  for (var i = 0; i < actionsToTest.length; i++) {
    var item = actionsToTest[i];
    logActivity(testNip, 'Admin', item.action, item.targetType, 'TEST-ID', item.desc, 'SUCCESS');
    Logger.log('Log entry created: ' + item.action + ' ✓');
  }

  Logger.log('=== AUDIT LOG SUITE COMPLETE ===');
}

