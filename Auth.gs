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
        forceChangePassword: false // isDefaultPassword (Fitur dimatikan sementara)
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

          return {
            nip: nip,
            nama: user.data[COL_PEGAWAI.NAMA_LENGKAP],
            role: user.data[COL_PEGAWAI.ROLE],
            statusKepegawaian: user.data[COL_PEGAWAI.STATUS_KEPEGAWAIAN],
            pangkatGolongan: user.data[COL_PEGAWAI.PANGKAT_GOLONGAN],
            jabatan: user.data[COL_PEGAWAI.JABATAN],
            forceChangePassword: false // isDefaultPassword (Fitur dimatikan sementara)
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
      data: {
        nip: auth.session.nip,
        nama: user.data[COL_PEGAWAI.NAMA_LENGKAP],
        role: user.data[COL_PEGAWAI.ROLE],
        statusKepegawaian: user.data[COL_PEGAWAI.STATUS_KEPEGAWAIAN],
        pangkatGolongan: user.data[COL_PEGAWAI.PANGKAT_GOLONGAN],
        jabatan: user.data[COL_PEGAWAI.JABATAN],
        noHp: user.data[COL_PEGAWAI.NO_HP],
        alamat: user.data[COL_PEGAWAI.ALAMAT]
      }
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
 * Changes a user's password.
 * Used for both force-change and voluntary change.
 * Force-change: currentPassword is null, only token validation required.
 * Voluntary change: currentPassword is required and verified.
 * @param {string} token - Session token.
 * @param {string} newPassword - The new password.
 * @param {string} currentPassword - Current password (required for voluntary change, null for force-change).
 * @returns {Object} Result object.
 */
function changePassword(token, newPassword, currentPassword) {
  try {
    // For force-change: allow even when forceChangePassword is true
    // For voluntary change (currentPassword provided): normal auth
    var isForceChange = !currentPassword;
    var auth = authorize(token, null, isForceChange);
    if (!auth.authorized) {
      return { success: false, message: auth.error };
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

    // If this is a voluntary password change, verify current password
    if (currentPassword) {
      var currentHash = hashPassword(currentPassword);
      if (currentHash !== user.data[COL_PEGAWAI.PASSWORD_HASH]) {
        return { success: false, message: 'Password saat ini salah.' };
      }
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
    'Folder_Drive_ID', 'Email', 'Golongan_Darah'
  ]);
  
  // Admin user — default password is last 6 digits of NIP: "011002"
  pegawaiSheet.appendRow([
    '198506122010011002', hashPassword('011002'), 'Admin', 'Aktif',
    'Maria Klementina, S.Sos', 'PNS', 'Penata / III.c', 'Staf Sub-bagian TU',
    '081234567890', 'Jl. Timor Raya No. 12, Kupang', '', 'maria.klementina@ntt.go.id', 'O'
  ]);

  // Employee user — default password: "022003"
  pegawaiSheet.appendRow([
    '199003152015022003', hashPassword('022003'), 'Pegawai', 'Aktif',
    'Budi Santoso, S.Kom', 'PNS', 'Penata Muda / III.a', 'Staf Pelayanan',
    '085678901234', 'Jl. El Tari No. 5, Kupang', '', 'budi.santoso@ntt.go.id', 'A'
  ]);

  // Another employee — default password: "033001"
  pegawaiSheet.appendRow([
    '198812012020033001', hashPassword('033001'), 'Pegawai', 'Aktif',
    'Antonius Ola, A.Md', 'CPNS', 'Pengatur / II.c', 'Staf Pendataan',
    '082345678901', 'Jl. Lalamentik No. 8, Kupang', '', '', 'B'
  ]);

  // P3K employee — default password: "044001"
  pegawaiSheet.appendRow([
    '200105202022044001', hashPassword('044001'), 'Pegawai', 'Aktif',
    'Siti Aminah', 'P3K', '-', 'Staf Administrasi',
    '087654321098', 'Jl. Soekarno No. 3, Kupang', '', '', ''
  ]);

  // Inactive employee for testing — default password: "055001"
  pegawaiSheet.appendRow([
    '197501012005055001', hashPassword('055001'), 'Pegawai', 'Nonaktif',
    'Ahmad Fauzi, S.H', 'PNS', 'Pembina / IV.a', 'Staf (Pensiun)',
    '089012345678', 'Jl. Veteran No. 20, Kupang', '', '', ''
  ]);

  // --- Master_Dokumen ---
  var dokumenSheet = sheets[SHEET_NAMES.MASTER_DOKUMEN];
  dokumenSheet.clear();
  dokumenSheet.appendRow(['ID_Dokumen', 'Nama_Dokumen', 'Kategori', 'Status_Wajib']);
  dokumenSheet.appendRow(['DOC-KTP', 'Kartu Tanda Penduduk (KTP)', 'Dokumen Pribadi', 'Ya']);
  dokumenSheet.appendRow(['DOC-KK', 'Kartu Keluarga (KK)', 'Dokumen Pribadi', 'Ya']);
  dokumenSheet.appendRow(['DOC-NPWP', 'NPWP', 'Dokumen Pribadi', 'Ya']);
  dokumenSheet.appendRow(['DOC-SK-CPNS', 'SK CPNS', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-SK-PNS', 'SK PNS', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-SPMT', 'Surat Pernyataan Melaksanakan Tugas (SPMT)', 'Dokumen Kepegawaian', 'Ya']);
  dokumenSheet.appendRow(['DOC-KARPEG', 'Kartu Pegawai (KARPEG)', 'Dokumen Kepegawaian', 'Tidak']);
  dokumenSheet.appendRow(['DOC-TASPEN', 'Kartu TASPEN', 'Dokumen Kepegawaian', 'Tidak']);

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
  arsipSheet.appendRow([generateUUID(), sampleNip, 'DOC-SPMT', '', '', 'Ditolak', 'Dokumen tidak terbaca, harap unggah ulang dengan resolusi lebih tinggi.', now2, now2, '198506122010011002']);
  // DOC-KARPEG and DOC-TASPEN intentionally not uploaded

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
