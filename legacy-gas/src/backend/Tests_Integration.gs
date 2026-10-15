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
      nik: '9999999999999999',
      nama: 'Testing Integration',
      tempatLahir: 'Kupang',
      tanggalLahir: '1995-05-15',
      jenisKelamin: 'Laki-laki',
      agama: 'Kristen Protestan',
      pendidikanTerakhir: 'S-1 / Sarjana Komputer',
      statusPernikahan: 'Belum Menikah',
      golonganDarah: 'O',
      statusKepegawaian: 'PNS',
      pangkatGolongan: 'Penata Muda (III/a)',
      tmtPangkat: '2025-06-01',
      jabatan: 'Penata Kelola Sistem dan Teknologi Informasi',
      jenisJabatan: 'Fungsional',
      tmtJabatan: '2025-06-01',
      unitOrganisasi: 'Subbagian Tata Usaha',
      role: 'Pegawai',
      noHp: '081234567890',
      email: 'test.integration@sikap.local',
      alamat: 'Jl. Test No. 1, Kupang'
    };
    
    // 1. Admin Adds Employee
    var resAdd = adminTambahPegawai(adminToken, payload);
    _assert(resAdd.success, 'Gagal menambahkan pegawai: ' + resAdd.message);
    
    // 2. Admin Verifies Full Detail
    var resDetail = adminGetPegawaiDetail(adminToken, MOCK_EMP_NIP);
    _assert(resDetail.success, 'Gagal mengambil detail pegawai: ' + resDetail.message);
    _assert(resDetail.data.nik === '9999999999999999', 'NIK tidak sesuai');
    _assert(resDetail.data.unitOrganisasi === 'Subbagian Tata Usaha', 'Unit organisasi tidak sesuai');
    _assert(resDetail.data.jenisJabatan === 'Fungsional', 'Jenis jabatan tidak sesuai');

    // 3. Validate Default Password Login
    var expectedPw = MOCK_EMP_NIP.slice(-6);
    var loginRes = login(MOCK_EMP_NIP, expectedPw);
    _assert(loginRes.success, 'Login dengan default password gagal');
    
    // 4. Employee Gets Own Profile
    var profileRes = getMyProfile(loginRes.data.token);
    _assert(profileRes.success, 'Gagal mengambil profil pegawai');
    _assert(profileRes.data.nik === '9999999999999999', 'Profil NIK tidak sesuai');

    _logTestResult('Journey 1 (New Employee & Profile)', true);
    return loginRes.data.token;
  } catch (e) {
    _logTestResult('Journey 1 (New Employee & Profile)', false, e.toString());
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

function test_contact_validationAndCrud(adminToken, empToken) {
  try {
    // 1. Test Phone Validation Helper
    _assert(isValidPhoneNumber('081234567890'), '081234567890 should be valid');
    _assert(isValidPhoneNumber('+6281234567890'), '+6281234567890 should be valid');
    _assert(isValidPhoneNumber('6281234567890'), '6281234567890 should be valid');
    _assert(isValidPhoneNumber('0822-4725-4006'), '0822-4725-4006 should be valid');
    _assert(isValidPhoneNumber('0380821234'), '0380821234 (landline) should be valid');
    _assert(isValidPhoneNumber(''), 'Empty phone should be valid (optional)');
    _assert(!isValidPhoneNumber('12345'), '12345 should be invalid');
    _assert(!isValidPhoneNumber('08abcdefg'), '08abcdefg should be invalid');

    // 2. Test Phone Storage Normalization
    var storedPhone = formatPhoneForStorage('+6282247254006');
    _assert(storedPhone === "'082247254006", 'Stored phone must normalize to 082247254006 with leading quote');
    _assert(formatPhoneForDisplay(storedPhone) === '082247254006', 'Displayed phone must be 082247254006 without quote');

    // 3. Test Email Validation Helper & Case Preservation
    _assert(isValidEmail('elwinmusadi@gmail.com'), 'Valid email should pass');
    _assert(isValidEmail('Elwin.Musadi@NTT.go.id'), 'Mixed-case email should pass');
    _assert(isValidEmail(''), 'Empty email should pass (optional)');
    _assert(!isValidEmail('invalid-email'), 'Invalid email without @ should fail');
    _assert(!isValidEmail('user@domain'), 'Email without TLD should fail');

    // 4. Test Multiline Address & Case-Preserved Email Update via adminUpdatePegawai
    var testEmail = 'Elwin.Musadi@NTT.go.id';
    var testAddress = 'Jln. Lakamola No. 21\nKel. Kuanino, Kec. Kota Raja\nKota Kupang - NTT';
    var testPhone = '+6282247254006';

    var resAdminUpdate = adminUpdatePegawai(adminToken, MOCK_EMP_NIP, {
      noHp: testPhone,
      email: testEmail,
      alamat: testAddress
    });
    _assert(resAdminUpdate.success, 'adminUpdatePegawai contact update failed: ' + resAdminUpdate.message);

    // Verify Admin Detail Retrieval
    var detailRes = adminGetPegawaiDetail(adminToken, MOCK_EMP_NIP);
    _assert(detailRes.success, 'adminGetPegawaiDetail failed');
    _assert(detailRes.data.noHp === '082247254006', 'Phone displayed mismatch: ' + detailRes.data.noHp);
    _assert(detailRes.data.email === testEmail, 'Email case not preserved: ' + detailRes.data.email);
    _assert(detailRes.data.alamat === testAddress, 'Multiline address mismatch: ' + detailRes.data.alamat);

    // 5. Test Employee Profile Contact Update via updateMyProfile
    var empNewAddress = 'Jln. Basuki Rahmat No. 1\nKota Kupang';
    var empNewEmail = 'Pegawai.Aktif@nttprov.go.id';
    var empNewPhone = '081339123456';

    var resEmpUpdate = updateMyProfile(empToken, {
      noHp: empNewPhone,
      email: empNewEmail,
      alamat: empNewAddress
    });
    _assert(resEmpUpdate.success, 'updateMyProfile contact update failed: ' + resEmpUpdate.message);

    // Verify Employee Profile Retrieval
    var myProfileRes = getMyProfile(empToken);
    _assert(myProfileRes.success, 'getMyProfile failed');
    _assert(myProfileRes.data.noHp === empNewPhone, 'Employee profile phone mismatch');
    _assert(myProfileRes.data.email === empNewEmail, 'Employee profile email mismatch');
    _assert(myProfileRes.data.alamat === empNewAddress, 'Employee profile address mismatch');

    // 6. Test Invalid Contact Data Rejection
    var resInvalidPhone = updateMyProfile(empToken, { noHp: '123' });
    _assert(!resInvalidPhone.success, 'Should reject invalid phone number');

    var resInvalidEmail = updateMyProfile(empToken, { email: 'bademail@' });
    _assert(!resInvalidEmail.success, 'Should reject invalid email format');

    _logTestResult('Journey (Data Kontak Validation & CRUD)', true);
  } catch (e) {
    _logTestResult('Journey (Data Kontak Validation & CRUD)', false, e.toString());
    throw e;
  }
}

function test_document_uploadAndValidation(adminToken, empToken) {
  try {
    // 1. Test Valid Upload & File ID & Metadata Persistence
    var validRes = uploadDokumen(empToken, 'DOC-KK', MOCK_BASE64_DATA, 'application/pdf');
    _assert(validRes.success, 'Upload DOC-KK gagal: ' + validRes.message);
    _assert(validRes.data.fileDriveId, 'File ID Google Drive tidak dikembalikan pada upload');
    _assert(validRes.data.idDokumen === 'DOC-KK', 'Metadata idDokumen tidak sesuai');
    _assert(validRes.data.nip === MOCK_EMP_NIP, 'Metadata NIP tidak sesuai');
    _assert(validRes.data.status === DOC_STATUS.MENUNGGU, 'Status bukan Menunggu');

    var arsipRecord = findByPrimaryKey(SHEET_NAMES.ARSIP_DOKUMEN, validRes.data.idArsip);
    _assert(arsipRecord, 'Data arsip tidak tersimpan di sheet Arsip_Dokumen');
    _assert(arsipRecord.data[COL_ARSIP.NIP] === MOCK_EMP_NIP, 'NIP di Arsip_Dokumen tidak cocok');
    _assert(arsipRecord.data[COL_ARSIP.ID_DOKUMEN] === 'DOC-KK', 'ID Dokumen di Arsip_Dokumen tidak cocok');
    _assert(arsipRecord.data[COL_ARSIP.FILE_DRIVE_ID] === validRes.data.fileDriveId, 'File ID di Arsip_Dokumen tidak cocok');

    // 2. Test Invalid File Format
    var invalidMimeRes = uploadDokumen(empToken, 'DOC-NPWP', MOCK_BASE64_DATA, 'application/msword');
    _assert(!invalidMimeRes.success, 'Format msword harus ditolak');

    var invalidExtRes = uploadDokumen(empToken, 'DOC-NPWP', MOCK_BASE64_DATA, 'text/plain');
    _assert(!invalidExtRes.success, 'Format text/plain harus ditolak');

    // 3. Test Empty File Content
    var emptyDataRes = uploadDokumen(empToken, 'DOC-NPWP', '', 'image/png');
    _assert(!emptyDataRes.success, 'Konten kosong harus ditolak');

    // 4. Test Oversized File (> 5 MB)
    var bigBase64 = new Array(9600001).join('A');
    var oversizedRes = uploadDokumen(empToken, 'DOC-NPWP', bigBase64, 'image/jpeg');
    _assert(!oversizedRes.success, 'File oversized harus ditolak');

    // 5. Test Duplicate Submission while Menunggu
    var duplicateRes = uploadDokumen(empToken, 'DOC-KK', MOCK_BASE64_DATA, 'application/pdf');
    _assert(!duplicateRes.success, 'Duplicate upload saat Menunggu harus ditolak');

    // 6. Test Upload with Invalid / Non-existent Document ID
    var invalidDocRes = uploadDokumen(empToken, 'DOC-NONEXISTENT', MOCK_BASE64_DATA, 'application/pdf');
    _assert(!invalidDocRes.success, 'Doc ID non-existent harus ditolak');

    // 7. Test Upload with Invalid / Missing Token
    var noTokenRes = uploadDokumen(null, 'DOC-NPWP', MOCK_BASE64_DATA, 'application/pdf');
    _assert(!noTokenRes.success, 'Upload tanpa token harus ditolak');

    // 8. Test Upload with Inactive Employee Account
    adminSetStatusAkun(adminToken, MOCK_EMP_NIP, 'Nonaktif');
    var inactiveUploadRes = uploadDokumen(empToken, 'DOC-NPWP', MOCK_BASE64_DATA, 'application/pdf');
    _assert(!inactiveUploadRes.success, 'Upload oleh pegawai nonaktif harus ditolak');

    // Restore active status
    adminSetStatusAkun(adminToken, MOCK_EMP_NIP, 'Aktif');

    _logTestResult('Journey (Phase 05B Document Upload & Validation)', true);
  } catch (e) {
    _logTestResult('Journey (Phase 05B Document Upload & Validation)', false, e.toString());
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
    test_contact_validationAndCrud(adminToken, empToken);
    test_document_uploadAndValidation(adminToken, empToken);
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
