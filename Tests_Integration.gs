// ============================================================
// Tests_Integration.gs — Phase 09 Automated Integration Tests
// Run `runAllIntegrationTests()` directly from the Apps Script Editor.
// ============================================================

var MOCK_EMP_NIP = '999999999999999999';
var MOCK_DOC_ID = 'DOC-KTP';
var MOCK_BASE64_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // 1x1 transparent PNG

function _assert(condition, message) {
  if (!condition) {
    throw new Error('ASSERTION FAILED: ' + message);
  }
}

function _logTestResult(testName, passed, message) {
  var prefix = passed ? '✅ PASS' : '❌ FAIL';
  Logger.log(prefix + ' | ' + testName + (message ? ' - ' + message : ''));
}

/**
 * Creates a temporary admin session directly to bypass knowing passwords.
 * @returns {string} token
 */
function _createTempAdminSession() {
  var sheetData = getAllData(SHEET_NAMES.DATA_PEGAWAI);
  var adminNip = null;
  for (var i = 0; i < sheetData.length; i++) {
    if (sheetData[i][COL_PEGAWAI.ROLE] === ROLES.ADMIN) {
      adminNip = sheetData[i][COL_PEGAWAI.NIP];
      break;
    }
  }
  _assert(adminNip, 'Tidak dapat menemukan NIP Admin di Data Pegawai untuk testing.');

  var token = 'TEST-ADMIN-TOKEN-' + generateUUID();
  var expiry = new Date();
  expiry.setHours(expiry.getHours() + 1);
  
  var expiryStr = Utilities.formatDate(expiry, 'Asia/Makassar', "yyyy-MM-dd'T'HH:mm:ss");
  appendRow(SHEET_NAMES.SESI_LOGIN, [token, adminNip, getTimestamp(), expiryStr]);
  return token;
}

/**
 * Creates a temporary employee session directly.
 */
function _createTempEmpSession(nip) {
  var token = 'TEST-EMP-TOKEN-' + generateUUID();
  var expiry = new Date();
  expiry.setHours(expiry.getHours() + 1);
  var expiryStr = Utilities.formatDate(expiry, 'Asia/Makassar', "yyyy-MM-dd'T'HH:mm:ss");
  appendRow(SHEET_NAMES.SESI_LOGIN, [token, nip, getTimestamp(), expiryStr]);
  return token;
}

function _cleanupMockData() {
  Logger.log('Menjalankan Cleanup Mock Data...');
  
  // Clean Data_Pegawai
  var empSheet = getSheet(SHEET_NAMES.DATA_PEGAWAI);
  var empData = empSheet.getDataRange().getValues();
  for (var i = empData.length - 1; i >= 1; i--) {
    if (String(empData[i][COL_PEGAWAI.NIP]) === MOCK_EMP_NIP) {
      // Find folder and trash it first
      var folderId = String(empData[i][COL_PEGAWAI.FOLDER_DRIVE_ID] || '').replace(/^'+/, '').trim();
      if (folderId) {
        try {
          DriveApp.getFolderById(folderId).setTrashed(true);
          Logger.log('Trashed mock folder: ' + folderId);
        } catch (e) { }
      }
      empSheet.deleteRow(i + 1);
    }
  }

  // Clean Arsip_Dokumen
  var arsipSheet = getSheet(SHEET_NAMES.ARSIP_DOKUMEN);
  var arsipData = arsipSheet.getDataRange().getValues();
  for (var j = arsipData.length - 1; j >= 1; j--) {
    if (String(arsipData[j][COL_ARSIP.NIP]) === MOCK_EMP_NIP) {
      // Find file and trash it first
      var fileId = String(arsipData[j][COL_ARSIP.FILE_DRIVE_ID] || '').replace(/^'+/, '').trim();
      if (fileId) {
        try {
          DriveApp.getFileById(fileId).setTrashed(true);
        } catch (e) { }
      }
      arsipSheet.deleteRow(j + 1);
    }
  }

  // Clean Sesi_Login
  var sesiSheet = getSheet(SHEET_NAMES.SESI_LOGIN);
  var sesiData = sesiSheet.getDataRange().getValues();
  for (var k = sesiData.length - 1; k >= 1; k--) {
    var token = String(sesiData[k][COL_SESI.TOKEN_ID]);
    if (token.indexOf('TEST-') === 0 || String(sesiData[k][COL_SESI.NIP]) === MOCK_EMP_NIP) {
      sesiSheet.deleteRow(k + 1);
    }
  }

  // Clean Log_Aktivitas (Only delete logs involving MOCK_EMP_NIP to keep real logs safe)
  var logSheet = getSheet(SHEET_NAMES.LOG_AKTIVITAS);
  var logData = logSheet.getDataRange().getValues();
  for (var l = logData.length - 1; l >= 1; l--) {
    if (String(logData[l][COL_LOG.ACTOR_NIP]) === MOCK_EMP_NIP || String(logData[l][COL_LOG.TARGET_ID]).indexOf(MOCK_EMP_NIP) !== -1) {
      logSheet.deleteRow(l + 1);
    }
  }
}

// ============================================================
// TEST SCENARIOS
// ============================================================

function test_journey1_newEmployee(adminToken) {
  try {
    var payload = {
      nip: MOCK_EMP_NIP,
      nama: 'Testing Integration',
      statusKepegawaian: 'PNS',
      role: 'Pegawai',
      noHp: '081234567890'
    };
    
    // 1. Admin Adds Employee
    var resAdd = adminTambahPegawai(adminToken, payload);
    _assert(resAdd.success, 'Gagal menambahkan pegawai: ' + resAdd.message);
    
    // 2. Validate Default Password
    var expectedPw = MOCK_EMP_NIP.slice(-6);
    var loginRes = login(MOCK_EMP_NIP, expectedPw);
    _assert(loginRes.success, 'Login dengan default password gagal');
    // Bagian forceChangePassword dilewati (skipped) karena fitur sedang dinonaktifkan
    
    _logTestResult('Journey 1 (New Employee)', true);
    return loginRes.data.token;
  } catch (e) {
    _logTestResult('Journey 1 (New Employee)', false, e.toString());
    throw e;
  }
}

function test_journey2_employeeDocument(empToken) {
  try {
    // 1. Employee Uploads Document
    var resUpload = uploadDokumen(empToken, MOCK_DOC_ID, MOCK_BASE64_DATA, 'image/png');
    _assert(resUpload.success, 'Upload dokumen gagal: ' + resUpload.message);
    
    // 2. Validate Status is Menunggu
    var userDocs = getArsipDokumenPegawai(empToken);
    _assert(userDocs.success, 'Gagal ambil arsip');
    
    var docStatus = '';
    for (var i = 0; i < userDocs.data.tableRows.length; i++) {
      if (userDocs.data.tableRows[i].idDokumen === MOCK_DOC_ID) {
        docStatus = userDocs.data.tableRows[i].status;
        break;
      }
    }
    _assert(docStatus === DOC_STATUS.MENUNGGU, 'Status dokumen bukan Menunggu, tapi ' + docStatus);
    
    _logTestResult('Journey 2 (Employee Document)', true);
    
    // Pass ID_Arsip to next journey
    var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
    for (var j = 0; j < allArsip.length; j++) {
      if (String(allArsip[j][COL_ARSIP.NIP]) === MOCK_EMP_NIP && allArsip[j][COL_ARSIP.ID_DOKUMEN] === MOCK_DOC_ID) {
        return allArsip[j][COL_ARSIP.ID_ARSIP];
      }
    }
  } catch (e) {
    _logTestResult('Journey 2 (Employee Document)', false, e.toString());
    throw e;
  }
}

function test_journey3_adminVerification(adminToken, idArsip) {
  try {
    // 1. Admin sees queue
    var queueRes = adminGetVerificationQueue(adminToken);
    _assert(queueRes.success, 'Gagal ambil queue verifikasi');
    
    var inQueue = false;
    for (var i = 0; i < queueRes.data.length; i++) {
      if (queueRes.data[i].idArsip === idArsip) {
        inQueue = true;
        break;
      }
    }
    _assert(inQueue, 'Dokumen mock tidak ditemukan di Verification Queue');
    
    // 2. Admin Approves
    var resApprove = adminApproveDokumen(adminToken, idArsip);
    _assert(resApprove.success, 'Gagal approve dokumen: ' + resApprove.message);
    
    // 3. Verify Status
    var record = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsip);
    _assert(record.data[COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.TERVERIFIKASI, 'Status tidak berubah ke Terverifikasi');
    
    _logTestResult('Journey 3 (Admin Verification)', true);
  } catch (e) {
    _logTestResult('Journey 3 (Admin Verification)', false, e.toString());
    throw e;
  }
}

function test_journey4_rejectionAndReupload(adminToken, empToken, idArsip) {
  try {
    // Note: It's already 'Terverifikasi' from Journey 3. Let's upload a fresh one to test reject.
    // For simplicity, we manually reset status to 'Menunggu' first before rejecting so it simulates fresh queue
    var record = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsip);
    updateRowFields(SHEET_NAMES.ARSIP_DOKUMEN, record.rowIndex, { [COL_ARSIP.STATUS_VERIFIKASI]: DOC_STATUS.MENUNGGU });

    // 1. Admin Rejects
    var resReject = adminRejectDokumen(adminToken, idArsip, 'Blurry image');
    _assert(resReject.success, 'Gagal tolak dokumen: ' + resReject.message);
    
    var checkRecord = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsip);
    _assert(checkRecord.data[COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.DITOLAK, 'Status tidak Ditolak');
    
    // 2. Employee Re-uploads
    var resReupload = uploadDokumen(empToken, MOCK_DOC_ID, MOCK_BASE64_DATA, 'image/png');
    _assert(resReupload.success, 'Re-upload gagal setelah ditolak');
    
    checkRecord = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, idArsip);
    _assert(checkRecord.data[COL_ARSIP.STATUS_VERIFIKASI] === DOC_STATUS.MENUNGGU, 'Status setelah re-upload bukan Menunggu');
    
    _logTestResult('Journey 4 (Rejection & Re-upload)', true);
  } catch (e) {
    _logTestResult('Journey 4 (Rejection & Re-upload)', false, e.toString());
    throw e;
  }
}

function test_journey5_securityAndEdgeCases(adminToken, empToken) {
  try {
    // 1. Cross Access (Employee tries Admin Route)
    var resAdminAction = adminGetAllPegawai(empToken);
    _assert(!resAdminAction.success, 'Security Breach: Pegawai bisa panggil fungsi adminGetAllPegawai');
    
    // 2. Cross Profile Edit
    var resAdminEdit = adminUpdatePegawai(empToken, MOCK_EMP_NIP, { nama: 'Hacked' });
    _assert(!resAdminEdit.success, 'Security Breach: Pegawai bisa edit pegawai lain via admin fungsi');
    
    // 3. Reject without reason
    var allArsip = getAllData(SHEET_NAMES.ARSIP_DOKUMEN);
    var targetIdArsip = null;
    for (var j = 0; j < allArsip.length; j++) {
      if (String(allArsip[j][COL_ARSIP.NIP]) === MOCK_EMP_NIP) targetIdArsip = allArsip[j][COL_ARSIP.ID_ARSIP];
    }
    var resRejectEmpty = adminRejectDokumen(adminToken, targetIdArsip, '');
    _assert(!resRejectEmpty.success, 'Edge Case Breach: Admin bisa reject tanpa alasan');
    
    // 4. Inactive Account Login
    adminSetStatusAkun(adminToken, MOCK_EMP_NIP, 'Nonaktif');
    var resLoginInactive = login(MOCK_EMP_NIP, MOCK_EMP_NIP.slice(-6));
    _assert(!resLoginInactive.success, 'Security Breach: Akun nonaktif masih bisa login');
    
    // 5. Duplicate Upload (While Menunggu)
    // Upload again to ensure Menunggu state (from J4 it is Menunggu)
    var resDupe = uploadDokumen(empToken, MOCK_DOC_ID, MOCK_BASE64_DATA, 'image/png');
    _assert(!resDupe.success, 'Edge Case Breach: Pegawai bisa upload duplicate saat status Menunggu');
    
    _logTestResult('Journey 5 (Security & Edge Cases)', true);
  } catch (e) {
    _logTestResult('Journey 5 (Security & Edge Cases)', false, e.toString());
    throw e;
  }
}

/**
 * MAIN EXECUTION ENTRY POINT
 */
function runAllIntegrationTests() {
  Logger.log('============================================');
  Logger.log('STARTING SIKAP INTEGRATION TESTS (PHASE 09)');
  Logger.log('============================================');
  
  _cleanupMockData(); // Clean before starting

  try {
    var adminToken = _createTempAdminSession();
    
    var empToken = test_journey1_newEmployee(adminToken);
    var idArsip = test_journey2_employeeDocument(empToken);
    test_journey3_adminVerification(adminToken, idArsip);
    test_journey4_rejectionAndReupload(adminToken, empToken, idArsip);
    test_journey5_securityAndEdgeCases(adminToken, empToken);

    Logger.log('============================================');
    Logger.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
    Logger.log('============================================');

  } catch (error) {
    Logger.log('============================================');
    Logger.log('💥 TESTS ABORTED DUE TO ERROR:');
    Logger.log(error);
    Logger.log('============================================');
  } finally {
    _cleanupMockData(); // Always clean up after
    Logger.log('Test Execution Finished.');
  }
}
