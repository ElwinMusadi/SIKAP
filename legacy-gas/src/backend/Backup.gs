// ============================================================
// Backup.gs — Pencadangan Data SIKAP (Database & Dokumen)
// ============================================================
// Admin-only. Tidak mengubah data asli sama sekali.
// Semua backup disimpan sebagai snapshot (arsip mati).
// ============================================================

var BACKUP_ROOT_FOLDER_NAME = 'SIKAP_Backups';

/**
 * Melakukan backup Spreadsheet database saja (cepat, hitungan detik).
 * Admin-only.
 * @param {string} token - Session token.
 * @returns {Object} Result with backup folder URL.
 */
function adminBackupDatabase(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN]);
    if (!auth.authorized) {
      return { success: false, message: auth.error };
    }

    var session = auth.session;
    var timestamp = Utilities.formatDate(new Date(), 'Asia/Makassar', 'yyyy-MM-dd_HHmmss');
    var backupName = 'Backup_DB_' + timestamp;

    // 1. Dapatkan atau buat folder root backup
    var backupRoot = _getOrCreateBackupRootFolder();

    // 2. Buat sub-folder untuk sesi backup ini
    var backupFolder = backupRoot.createFolder(backupName);

    // 3. Duplikasi Spreadsheet ke folder backup
    var spreadsheetFile = DriveApp.getFileById(SPREADSHEET_ID);
    spreadsheetFile.makeCopy('SIKAP_Database_' + timestamp, backupFolder);

    var backupFolderUrl = backupFolder.getUrl();

    // 4. Catat di audit log
    logActivity(
      session.nip,
      session.role,
      'BACKUP_DATABASE',
      'SYSTEM',
      'SPREADSHEET',
      'Backup database (Spreadsheet): ' + backupName,
      'SUCCESS'
    );

    return {
      success: true,
      message: 'Backup database berhasil dibuat.',
      data: { name: backupName, url: backupFolderUrl }
    };

  } catch (e) {
    Logger.log('adminBackupDatabase error: ' + e.toString());
    return { success: false, message: 'Gagal melakukan backup database: ' + e.message };
  }
}

/**
 * Melakukan backup penuh: Spreadsheet + seluruh folder dokumen Google Drive.
 * Admin-only. Proses lebih lama, bergantung pada jumlah file di Drive.
 * @param {string} token - Session token.
 * @returns {Object} Result with backup folder URL.
 */
function adminBackupFull(token) {
  try {
    var auth = authorize(token, [ROLES.ADMIN]);
    if (!auth.authorized) {
      return { success: false, message: auth.error };
    }

    var session = auth.session;
    var timestamp = Utilities.formatDate(new Date(), 'Asia/Makassar', 'yyyy-MM-dd_HHmmss');
    var backupName = 'Backup_Full_' + timestamp;

    // 1. Dapatkan atau buat folder root backup
    var backupRoot = _getOrCreateBackupRootFolder();

    // 2. Buat sub-folder untuk sesi backup ini
    var backupFolder = backupRoot.createFolder(backupName);

    // 3. Duplikasi Spreadsheet
    var spreadsheetFile = DriveApp.getFileById(SPREADSHEET_ID);
    spreadsheetFile.makeCopy('SIKAP_Database_' + timestamp, backupFolder);

    // 4. Duplikasi folder dokumen Drive
    var docFolderResult = _copyDocumentsFolderToBackup(backupFolder, timestamp);

    var backupFolderUrl = backupFolder.getUrl();
    var desc = 'Backup penuh (Database + Dokumen Drive): ' + backupName;
    if (!docFolderResult.success) {
      desc += ' | PERINGATAN: ' + docFolderResult.message;
    }

    // 5. Catat di audit log
    logActivity(
      session.nip,
      session.role,
      'BACKUP_FULL',
      'SYSTEM',
      'SPREADSHEET+DRIVE',
      desc,
      docFolderResult.success ? 'SUCCESS' : 'PARTIAL'
    );

    return {
      success: true,
      message: docFolderResult.success
        ? 'Backup penuh berhasil. Database dan semua dokumen berhasil dicadangkan.'
        : 'Backup selesai dengan peringatan: ' + docFolderResult.message,
      data: { name: backupName, url: backupFolderUrl, docsCopied: docFolderResult.count || 0 }
    };

  } catch (e) {
    Logger.log('adminBackupFull error: ' + e.toString());
    return { success: false, message: 'Gagal melakukan backup penuh: ' + e.message };
  }
}

// ============================================================
// PRIVATE HELPERS
// ============================================================

/**
 * Gets or creates the root SIKAP_Backups folder in Google Drive.
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function _getOrCreateBackupRootFolder() {
  var folders = DriveApp.getFoldersByName(BACKUP_ROOT_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(BACKUP_ROOT_FOLDER_NAME);
}

/**
 * Copies the entire SIKAP_Dokumen_Kepegawaian folder tree to a backup folder.
 * Iterates through all employee subfolders and their files.
 * @param {GoogleAppsScript.Drive.Folder} backupFolder
 * @param {string} timestamp
 * @returns {Object} { success, count, message }
 */
function _copyDocumentsFolderToBackup(backupFolder, timestamp) {
  try {
    var rootFolders = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER_NAME);
    if (!rootFolders.hasNext()) {
      return { success: false, count: 0, message: 'Folder SIKAP_Dokumen_Kepegawaian tidak ditemukan di Google Drive.' };
    }

    var sikapRoot = rootFolders.next();
    var docsBackupFolder = backupFolder.createFolder('SIKAP_Dokumen_Kepegawaian_' + timestamp);
    var totalCopied = 0;

    var empFolders = sikapRoot.getFolders();
    while (empFolders.hasNext()) {
      var empFolder = empFolders.next();
      var empBackupFolder = docsBackupFolder.createFolder(empFolder.getName());

      var files = empFolder.getFiles();
      while (files.hasNext()) {
        var file = files.next();
        file.makeCopy(file.getName(), empBackupFolder);
        totalCopied++;
      }
    }

    return { success: true, count: totalCopied, message: '' };

  } catch (e) {
    Logger.log('_copyDocumentsFolderToBackup error: ' + e.toString());
    return { success: false, count: 0, message: e.message };
  }
}
