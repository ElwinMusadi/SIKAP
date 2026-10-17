/**
 * Phase 8 SYNTHETIC rehearsal sandbox creator. MANUAL, PRIVATE, OPERATOR-ONLY.
 *
 * Purpose: let the operator exercise the REAL Apps Script runtime (DriveApp,
 * SpreadsheetApp, Utilities, LockService) with the reviewed exporter
 * ExportForMigration.gs against SYNTHETIC data before any production PII is
 * copied. Every row/file created here is fake and labelled SINTETIS/SYNTHETIC.
 * Fake password hashes are SHA-256 of the last 6 NIP digits (fixture rule); they
 * are not credentials of any real account.
 *
 * NEVER paste this into the production/legacy SIKAP project, src, legacy-gas, a
 * clasp deployment, a web app, a trigger, or a google.script.run call. There is
 * no doGet/doPost/API/trigger and there must never be one.
 *
 * MANUAL OWNER PROCEDURE (this file performs none of these steps itself):
 * 1. Signed in as the owner account, create a NEW STANDALONE Apps Script project
 *    (script.google.com > New project). Do NOT use a spreadsheet-bound project and
 *    do NOT reuse any project that has MIGRATION_* Script Properties already set.
 * 2. Paste ExportForMigration.gs (unchanged) as one file and this file as another.
 *    This tool refuses to run unless the exporter functions are defined.
 * 3. In private My Drive (NOT a shared drive, NOT inside a shared folder) create a
 *    NEW EMPTY folder. Check Drive "Share": no users/groups, General access
 *    Restricted. Shared-drive items have no owner and are rejected.
 * 4. Project settings > Script Properties: set ONLY
 *      MIGRATION_SANDBOX_PARENT_ID   ID of that empty private folder
 *    MIGRATION_SPREADSHEET_ID, MIGRATION_EXPORT_FOLDER_ID,
 *    MIGRATION_SOURCE_READONLY and MIGRATION_EXPORT_JOB_V1 MUST be ABSENT. Any of
 *    them without this tool's own MIGRATION_SANDBOX_V1 marker is refused, so a
 *    production configuration is never overwritten or reused.
 * 5. Add a TEMPORARY editor-only wrapper in a separate file:
 *      function tmpCreateSandbox() { createMigrationSandbox_(); }
 *    Run it once from the editor, approve the Drive/Sheets scopes, then DELETE the
 *    wrapper. The log shows counts only; find the folder
 *    sikap-synthetic-rehearsal-<UUID> manually inside the parent folder.
 * 6. This tool NEVER runs the export. Separately add a temporary wrapper
 *      function tmpRunExport() { exportForMigration_(); }
 *    run it until isComplete=true, then delete the wrapper. Download the
 *    snapshot-<UUID> folder from synthetic-export-output and run the LOCAL
 *    transform/apply-local rehearsal on it.
 * 7. Rerunning tmpCreateSandbox after success only re-verifies ownership/privacy
 *    and placement of the recorded artifacts (and the parent's ancestors). It does
 *    NOT reread or recount sheet/file content: it returns contentVerified=false
 *    and no counts. Nothing new is created and the export checkpoint (pending or
 *    completed) is never cleared or reused; exportStarted reports its presence.
 * 8. On failure the message is sanitized and NOTHING is cleaned up: a partial
 *    sikap-synthetic-rehearsal-<UUID> folder may remain, and if the failure hit
 *    before/while moving it, a new "SIKAP SYNTHETIC rehearsal source" spreadsheet
 *    may remain in My Drive root. Inspect and delete those NEW items manually;
 *    never delete anything else. Script Properties are written only after every
 *    artifact is verified. Use a NEW empty parent folder to retry.
 * 9. When finished, delete the standalone project (or its MIGRATION_* properties)
 *    and the synthetic folder manually. Never move synthetic data into production.
 *
 * Writes performed: new folders/files/spreadsheet under the parent, PRIVATE
 * sharing on those NEW items only, and four Script Properties after verification.
 * It never changes, shares, moves, trashes or deletes any pre-existing item.
 */
function createMigrationSandbox_() {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(1000);
    if (!locked) migrationSandboxFail_('Another migration run is active.');
    migrationSandboxPreflightExporter_();
    var ownerEmail = Session.getEffectiveUser().getEmail();
    if (!ownerEmail) migrationSandboxFail_('A verifiable owner account is required.');
    var properties = PropertiesService.getScriptProperties();
    var rawMarker = properties.getProperty('MIGRATION_SANDBOX_V1');
    if (rawMarker !== null) return migrationSandboxExisting_(properties, rawMarker, ownerEmail);
    migrationSandboxAssertUnconfigured_(properties);
    var parent = migrationSandboxParent_(properties, ownerEmail);
    var created = migrationSandboxBuild_(parent, ownerEmail);
    migrationSandboxVerifyCreated_(created, ownerEmail);
    migrationSandboxConfigure_(properties, created);
    // Content was just written and NIP/NIK read back, so counts are legitimate.
    return migrationSandboxSummary_(true, true, false);
  } catch (error) {
    // Never propagate Drive/Sheets exception text: it can contain IDs or names.
    throw new Error(error && (error.migrationSandboxSafe_ === true || error.migrationExportSafe_ === true)
      ? error.message
      : 'Synthetic sandbox creation stopped. Manually inspect the new sikap-synthetic-rehearsal-* ' +
        'folder and any new SYNTHETIC spreadsheet left in My Drive root; delete only those new items. ' +
        'Script Properties are only written after full verification. Nothing was deleted.');
  } finally {
    if (locked) lock.releaseLock();
  }
}

function migrationSandboxPreflightExporter_() {
  if (typeof exportForMigration_ !== 'function' || typeof migrationExportHeaders_ !== 'function' ||
      typeof migrationExportConfig_ !== 'function' || typeof migrationExportAssertPrivate_ !== 'function' ||
      typeof migrationExportValidId_ !== 'function' || typeof migrationExportFail_ !== 'function' ||
      typeof migrationExportAssertPrivateAncestors_ !== 'function') {
    migrationSandboxFail_('Paste the reviewed ExportForMigration.gs into this standalone project first.');
  }
  var headers = migrationExportHeaders_();
  var expected = { Data_Pegawai: 25, Master_Dokumen: 4, Arsip_Dokumen: 10, Log_Aktivitas: 9 };
  var names = Object.keys(headers);
  if (names.length !== 4) migrationSandboxFail_('Exporter header allowlist is unexpected.');
  for (var i = 0; i < names.length; i++) {
    if (expected[names[i]] !== headers[names[i]].length) {
      migrationSandboxFail_('Exporter header allowlist is unexpected.');
    }
  }
}

function migrationSandboxAssertUnconfigured_(properties) {
  // Refuse, never clear: a pending OR completed checkpoint belongs to some export.
  if (properties.getProperty('MIGRATION_EXPORT_JOB_V1') !== null) {
    migrationSandboxFail_('An export checkpoint exists; the sandbox tool never clears or reuses it.');
  }
  var keys = ['MIGRATION_SPREADSHEET_ID', 'MIGRATION_EXPORT_FOLDER_ID', 'MIGRATION_SOURCE_READONLY'];
  for (var i = 0; i < keys.length; i++) {
    if (properties.getProperty(keys[i]) !== null) {
      migrationSandboxFail_('Export configuration already exists without a sandbox marker; refusing to overwrite it.');
    }
  }
}

function migrationSandboxParent_(properties, ownerEmail) {
  var parentId = properties.getProperty('MIGRATION_SANDBOX_PARENT_ID');
  if (!migrationExportValidId_(parentId)) {
    migrationSandboxFail_('MIGRATION_SANDBOX_PARENT_ID is missing or malformed.');
  }
  var parent = DriveApp.getFolderById(parentId);
  // Owner must equal the effective user (shared-drive items have no owner),
  // link access PRIVATE, and no visible editors/viewers.
  migrationSandboxAssertPrivate_(parent, ownerEmail);
  // Exporter-owned helper: every ancestor up to My Drive must be owned/private too.
  migrationExportAssertPrivateAncestors_(parent, ownerEmail);
  if (parent.getFiles().hasNext() || parent.getFolders().hasNext()) {
    migrationSandboxFail_('MIGRATION_SANDBOX_PARENT_ID must be a new EMPTY folder.');
  }
  return parent;
}

function migrationSandboxBuild_(parent, ownerEmail) {
  var rehearsalId = Utilities.getUuid();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rehearsalId)) {
    migrationSandboxFail_('Rehearsal UUID is invalid.');
  }
  var root = parent.createFolder('sikap-synthetic-rehearsal-' + rehearsalId);
  migrationSandboxMakePrivate_(root, ownerEmail);
  var sourceFiles = root.createFolder('synthetic-source-files');
  migrationSandboxMakePrivate_(sourceFiles, ownerEmail);
  var exportFolder = root.createFolder('synthetic-export-output');
  migrationSandboxMakePrivate_(exportFolder, ownerEmail);

  var ktp = migrationSandboxCreateFile_(sourceFiles, Utilities.newBlob(
    migrationSandboxPdf_(), 'application/pdf', 'SINTETIS-DOC-KTP.pdf'), ownerEmail);
  var kk = migrationSandboxCreateFile_(sourceFiles, Utilities.newBlob(
    Utilities.base64Decode(migrationSandboxPngDocument_()), 'image/png', 'SINTETIS-DOC-KK.png'), ownerEmail);
  var photo = migrationSandboxCreateFile_(sourceFiles, Utilities.newBlob(
    Utilities.base64Decode(migrationSandboxPngPhoto_()), 'image/png', 'SINTETIS-foto-profil.png'), ownerEmail);

  // SpreadsheetApp.create places the file in My Drive root; move it at once into
  // the private rehearsal folder and force PRIVATE sharing on this NEW file only.
  var spreadsheet = SpreadsheetApp.create(
    'SIKAP SYNTHETIC rehearsal source - SINTETIS - NOT PRODUCTION - ' + rehearsalId);
  var spreadsheetFile = DriveApp.getFileById(spreadsheet.getId());
  spreadsheetFile.moveTo(root);
  migrationSandboxMakePrivate_(spreadsheetFile, ownerEmail);
  spreadsheet.setSpreadsheetTimeZone('Asia/Makassar');

  var created = {
    rehearsalId: rehearsalId, parentId: parent.getId(),
    root: root, sourceFiles: sourceFiles, exportFolder: exportFolder,
    spreadsheetFile: spreadsheetFile, documents: [ktp, kk], photo: photo
  };
  migrationSandboxAssertDistinct_(created);
  migrationSandboxWriteSheets_(spreadsheet, {
    ktp: ktp.getId(), kk: kk.getId(), photo: photo.getId()
  });
  SpreadsheetApp.flush();
  if (spreadsheet.getSpreadsheetTimeZone() !== 'Asia/Makassar') {
    migrationSandboxFail_('Synthetic spreadsheet timezone could not be set.');
  }
  return created;
}

function migrationSandboxCreateFile_(folder, blob, ownerEmail) {
  var file = folder.createFile(blob);
  migrationSandboxMakePrivate_(file, ownerEmail);
  return file;
}

function migrationSandboxAssertDistinct_(created) {
  var ids = [created.root.getId(), created.sourceFiles.getId(), created.exportFolder.getId(),
    created.spreadsheetFile.getId(), created.documents[0].getId(), created.documents[1].getId(),
    created.photo.getId()];
  var seen = Object.create(null);
  for (var i = 0; i < ids.length; i++) {
    if (!migrationExportValidId_(ids[i]) || seen[ids[i]]) {
      migrationSandboxFail_('Created artifact IDs are invalid or not distinct.');
    }
    seen[ids[i]] = true;
  }
}

function migrationSandboxWriteSheets_(spreadsheet, fileIds) {
  var headers = migrationExportHeaders_();
  var names = Object.keys(headers);
  var initial = spreadsheet.getSheets();
  if (initial.length !== 1) migrationSandboxFail_('New synthetic spreadsheet layout is unexpected.');
  initial[0].setName(names[0]);
  for (var n = 1; n < names.length; n++) spreadsheet.insertSheet(names[n]);
  if (spreadsheet.getSheets().length !== names.length) {
    migrationSandboxFail_('Synthetic spreadsheet must contain exactly four sheets.');
  }
  var rows = migrationSandboxRows_(fileIds);
  for (var i = 0; i < names.length; i++) {
    migrationSandboxWriteSheet_(spreadsheet.getSheetByName(names[i]), headers[names[i]], rows[names[i]]);
  }
  migrationSandboxVerifyIdentity_(spreadsheet.getSheetByName('Data_Pegawai'), headers.Data_Pegawai,
    rows.Data_Pegawai);
}

function migrationSandboxWriteSheet_(sheet, headers, records) {
  var dateFormats = migrationSandboxDateFormats_();
  var values = [headers.slice()];
  for (var r = 0; r < records.length; r++) {
    var keys = Object.keys(records[r]);
    for (var k = 0; k < keys.length; k++) {
      if (headers.indexOf(keys[k]) < 0) migrationSandboxFail_('Synthetic row uses an unknown header.');
    }
    var row = [];
    for (var h = 0; h < headers.length; h++) {
      row.push(Object.prototype.hasOwnProperty.call(records[r], headers[h]) ? records[r][headers[h]] : '');
    }
    values.push(row);
  }
  // Plain-text '@' for every non-date column (NIP 18 / NIK 16 digits, leading-zero
  // phone numbers) BEFORE setValues so Sheets never converts or rounds them.
  for (var c = 0; c < headers.length; c++) {
    sheet.getRange(1, c + 1, values.length, 1).setNumberFormat(dateFormats[headers[c]] || '@');
  }
  sheet.getRange(1, 1, values.length, headers.length).setValues(values);
}

function migrationSandboxDateFormats_() {
  return {
    Tanggal_Lahir: 'yyyy-mm-dd', TMT_Pangkat: 'yyyy-mm-dd', TMT_Jabatan: 'yyyy-mm-dd',
    Waktu_Upload: 'yyyy-mm-dd hh:mm:ss', Waktu_Verifikasi: 'yyyy-mm-dd hh:mm:ss',
    Timestamp: 'yyyy-mm-dd hh:mm:ss'
  };
}

function migrationSandboxVerifyIdentity_(sheet, headers, records) {
  var nipColumn = headers.indexOf('NIP');
  var nikColumn = headers.indexOf('NIK');
  var values = sheet.getRange(1, 1, records.length + 1, headers.length).getValues();
  for (var r = 0; r < records.length; r++) {
    var nip = values[r + 1][nipColumn];
    var nik = values[r + 1][nikColumn];
    if (typeof nip !== 'string' || nip !== records[r].NIP || !/^[0-9]{18}$/.test(nip) ||
        typeof nik !== 'string' || nik !== records[r].NIK || !/^[0-9]{16}$/.test(nik)) {
      migrationSandboxFail_('Synthetic NIP/NIK cells were not stored as exact plain text.');
    }
  }
}

function migrationSandboxWita_(year, month, day, hour, minute, second) {
  // Real Date objects at a WITA (UTC+08:00, no DST) wall-clock time.
  return new Date(Date.UTC(year, month - 1, day, (hour || 0) - 8, minute || 0, second || 0));
}

function migrationSandboxRows_(fileIds) {
  // Fake NIPs follow the 18-digit layout: birth yyyymmdd + appointment yyyymm +
  // gender digit (1 = Laki-laki, 2 = Perempuan) + 3-digit sequence. Birth date and
  // Jenis_Kelamin match each NIP. Password_Hash = SHA-256(last 6 NIP digits).
  var people = [
    { nip: '199001012020011001', name: 'SINTETIS Admin Rehearsal', role: 'Admin', status: 'PNS',
      pangkat: 'Penata Muda (III/a)', nik: '5371999900000001', photo: '' },
    { nip: '199002022021022002', name: 'SINTETIS Pegawai PNS', role: 'Pegawai', status: 'PNS',
      pangkat: 'Penata / III.c', nik: '5371999900000002', photo: fileIds.photo },
    { nip: '199003032022032003', name: 'SINTETIS Pegawai PPPK', role: 'Pegawai', status: 'P3K',
      pangkat: 'Ahli Pertama (IX)', nik: '5371999900000003', photo: '' }
  ];
  var pegawai = [];
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    pegawai.push({
      NIP: p.nip, Password_Hash: migrationSandboxSha256Hex_(p.nip.slice(-6)), Role: p.role,
      Status_Akun: 'Aktif', Nama_Lengkap: p.name, Status_Kepegawaian: p.status,
      Pangkat_Golongan: p.pangkat, Jabatan: 'Analis Contoh SINTETIS', No_HP: '081299990001',
      Alamat: 'Alamat SINTETIS rehearsal', Folder_Drive_ID: '', Email: p.nip + '@example.test',
      Golongan_Darah: 'O', NIK: p.nik, Tempat_Lahir: 'Kupang',
      Tanggal_Lahir: migrationSandboxWita_(Number(p.nip.slice(0, 4)), Number(p.nip.slice(4, 6)),
        Number(p.nip.slice(6, 8))),
      Jenis_Kelamin: p.nip.charAt(14) === '1' ? 'Laki-laki' : 'Perempuan', Agama: 'Islam',
      Pendidikan_Terakhir: 'S-1 / Sarjana', Status_Pernikahan: 'Menikah',
      TMT_Pangkat: migrationSandboxWita_(2023, 4, 1), Jenis_Jabatan: 'Fungsional',
      TMT_Jabatan: migrationSandboxWita_(2023, 4, 1), Unit_Organisasi: 'Subbagian Tata Usaha',
      Foto_Drive_ID: p.photo
    });
  }
  var seeds = [
    ['DOC-KTP', 'Kartu Tanda Penduduk (KTP)', 'Dokumen Pribadi', 'Ya'],
    ['DOC-KK', 'Kartu Keluarga (KK)', 'Dokumen Pribadi', 'Ya'],
    ['DOC-NPWP', 'NPWP', 'Dokumen Pribadi', 'Ya'],
    ['DOC-SK-CPNS', 'SK CPNS', 'Dokumen Kepegawaian', 'Ya'],
    ['DOC-SPMT-CPNS', 'SPMT CPNS', 'Dokumen Kepegawaian', 'Ya'],
    ['DOC-SK-PNS', 'SK PNS', 'Dokumen Kepegawaian', 'Ya'],
    ['DOC-DRH', 'DRH', 'Dokumen Kepegawaian', 'Ya'],
    ['DOC-IJAZAH', 'Ijazah Terakhir', 'Dokumen Pendidikan', 'Ya'],
    ['DOC-SKP', 'SKP', 'Dokumen Kepegawaian', 'Ya'],
    ['DOC-KARPEG', 'Kartu Pegawai (KARPEG)', 'Dokumen Kepegawaian', 'Tidak'],
    ['DOC-TASPEN', 'Kartu Taspen', 'Dokumen Kepegawaian', 'Tidak']
  ];
  var master = [];
  for (var s = 0; s < seeds.length; s++) {
    master.push({ ID_Dokumen: seeds[s][0], Nama_Dokumen: seeds[s][1], Kategori: seeds[s][2],
      Status_Wajib: seeds[s][3] });
  }
  var uploaded = migrationSandboxWita_(2026, 10, 16, 9, 15, 0);
  var verified = migrationSandboxWita_(2026, 10, 16, 10, 30, 0);
  return {
    Data_Pegawai: pegawai,
    Master_Dokumen: master,
    Arsip_Dokumen: [
      { ID_Arsip: 'archive-synthetic-1', NIP: people[1].nip, ID_Dokumen: 'DOC-KTP',
        File_Drive_ID: fileIds.ktp, File_URL: '', Status_Verifikasi: 'Terverifikasi',
        Catatan_Admin: '', Waktu_Upload: uploaded, Waktu_Verifikasi: verified, NIP_Verifier: people[0].nip },
      { ID_Arsip: 'archive-synthetic-2', NIP: people[2].nip, ID_Dokumen: 'DOC-KK',
        File_Drive_ID: fileIds.kk, File_URL: '', Status_Verifikasi: 'Ditolak',
        Catatan_Admin: 'SINTETIS: dokumen contoh tidak terbaca.', Waktu_Upload: uploaded,
        Waktu_Verifikasi: verified, NIP_Verifier: people[0].nip }
    ],
    Log_Aktivitas: [
      { Log_ID: 'synthetic-log-1', Timestamp: verified, Actor_NIP: people[0].nip, Actor_Role: 'Admin',
        Action: 'DOKUMEN_APPROVE', Target_Type: 'Arsip_Dokumen', Target_ID: 'archive-synthetic-1',
        Description: 'SINTETIS aktivitas rehearsal.', Result: 'SUCCESS' }
    ]
  };
}

function migrationSandboxSha256Hex_(text) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var part = (digest[i] & 255).toString(16);
    hex += part.length === 1 ? '0' + part : part;
  }
  return hex;
}

function migrationSandboxPdf_() {
  // Minimal but structurally valid one-page PDF with an exact xref table.
  var stream = 'BT /F1 12 Tf 20 100 Td (SINTETIS - BUKAN DATA ASLI) Tj ET';
  var objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  var pdf = '%PDF-1.4\n';
  var offsets = [];
  for (var i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += (i + 1) + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  var xref = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (var o = 0; o < offsets.length; o++) {
    pdf += ('0000000000' + offsets[o]).slice(-10) + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return pdf;
}

function migrationSandboxPngDocument_() {
  // Public, standard 1x1 grayscale+alpha PNG.
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
}

function migrationSandboxPngPhoto_() {
  // Public, standard 1x1 RGBA PNG (different bytes from the document PNG).
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
}

function migrationSandboxVerifyCreated_(created, ownerEmail) {
  migrationSandboxAssertPrivate_(created.root, ownerEmail);
  migrationSandboxAssertParent_(created.root, created.parentId);
  var children = [created.sourceFiles, created.exportFolder, created.spreadsheetFile];
  for (var i = 0; i < children.length; i++) {
    migrationSandboxAssertPrivate_(children[i], ownerEmail);
    migrationSandboxAssertParent_(children[i], created.root.getId());
  }
  var files = [created.documents[0], created.documents[1], created.photo];
  for (var f = 0; f < files.length; f++) {
    migrationSandboxAssertPrivate_(files[f], ownerEmail);
    migrationSandboxAssertParent_(files[f], created.sourceFiles.getId());
  }
  // A fresh export folder must be empty; after export runs it holds snapshots.
  if (!created.existing &&
      (created.exportFolder.getFiles().hasNext() || created.exportFolder.getFolders().hasNext())) {
    migrationSandboxFail_('New synthetic export folder is not empty.');
  }
}

function migrationSandboxConfigure_(properties, created) {
  migrationSandboxAssertUnconfigured_(properties);
  var marker = {
    version: 1,
    rehearsalId: created.rehearsalId,
    rootFolderId: created.root.getId(),
    sourceFilesFolderId: created.sourceFiles.getId(),
    exportFolderId: created.exportFolder.getId(),
    spreadsheetId: created.spreadsheetFile.getId(),
    documentFileIds: [created.documents[0].getId(), created.documents[1].getId()],
    photoFileId: created.photo.getId()
  };
  // Only after every artifact is created and verified private. Synthetic data has
  // no writers or triggers, so the read-only declaration is truthful here.
  // One setProperties call (deleteAllOthers=false: no other property is touched)
  // so the config and its marker are written together, not one-by-one.
  properties.setProperties({
    MIGRATION_SPREADSHEET_ID: marker.spreadsheetId,
    MIGRATION_EXPORT_FOLDER_ID: marker.exportFolderId,
    MIGRATION_SOURCE_READONLY: 'true',
    MIGRATION_SANDBOX_V1: JSON.stringify(marker)
  }, false);
}

function migrationSandboxParseMarker_(rawMarker) {
  var marker;
  try { marker = JSON.parse(rawMarker); } catch (error) {
    migrationSandboxFail_('MIGRATION_SANDBOX_V1 marker is invalid; refusing.');
  }
  var keys = ['version', 'rehearsalId', 'rootFolderId', 'sourceFilesFolderId', 'exportFolderId',
    'spreadsheetId', 'documentFileIds', 'photoFileId'];
  if (!marker || typeof marker !== 'object' || marker.version !== 1 ||
      Object.keys(marker).length !== keys.length ||
      !keys.every(function (key) { return Object.prototype.hasOwnProperty.call(marker, key); }) ||
      typeof marker.rehearsalId !== 'string' || !Array.isArray(marker.documentFileIds) ||
      marker.documentFileIds.length !== 2) {
    migrationSandboxFail_('MIGRATION_SANDBOX_V1 marker is invalid; refusing.');
  }
  var ids = [marker.rootFolderId, marker.sourceFilesFolderId, marker.exportFolderId, marker.spreadsheetId,
    marker.documentFileIds[0], marker.documentFileIds[1], marker.photoFileId];
  for (var i = 0; i < ids.length; i++) {
    if (!migrationExportValidId_(ids[i])) migrationSandboxFail_('MIGRATION_SANDBOX_V1 marker is invalid; refusing.');
  }
  return marker;
}

function migrationSandboxExisting_(properties, rawMarker, ownerEmail) {
  var marker = migrationSandboxParseMarker_(rawMarker);
  if (properties.getProperty('MIGRATION_SPREADSHEET_ID') !== marker.spreadsheetId ||
      properties.getProperty('MIGRATION_EXPORT_FOLDER_ID') !== marker.exportFolderId ||
      properties.getProperty('MIGRATION_SOURCE_READONLY') !== 'true') {
    migrationSandboxFail_('Export configuration does not match the sandbox marker; refusing.');
  }
  var parentId = properties.getProperty('MIGRATION_SANDBOX_PARENT_ID');
  if (!migrationExportValidId_(parentId)) {
    migrationSandboxFail_('MIGRATION_SANDBOX_PARENT_ID is missing or malformed.');
  }
  // Re-verify the parent and its whole ancestor chain: sharing may have changed.
  var parent = DriveApp.getFolderById(parentId);
  migrationSandboxAssertPrivate_(parent, ownerEmail);
  migrationExportAssertPrivateAncestors_(parent, ownerEmail);
  var root = DriveApp.getFolderById(marker.rootFolderId);
  if (root.getName() !== 'sikap-synthetic-rehearsal-' + marker.rehearsalId) {
    migrationSandboxFail_('Sandbox marker does not match its rehearsal folder; refusing.');
  }
  migrationSandboxVerifyCreated_({
    existing: true,
    parentId: parentId,
    root: root,
    sourceFiles: DriveApp.getFolderById(marker.sourceFilesFolderId),
    exportFolder: DriveApp.getFolderById(marker.exportFolderId),
    spreadsheetFile: DriveApp.getFileById(marker.spreadsheetId),
    documents: [DriveApp.getFileById(marker.documentFileIds[0]), DriveApp.getFileById(marker.documentFileIds[1])],
    photo: DriveApp.getFileById(marker.photoFileId)
  }, ownerEmail);
  // Idempotent: never recreate, and never touch a pending/completed checkpoint.
  // Only ownership/privacy/placement was re-verified; content is NOT reread.
  return migrationSandboxSummary_(false, false, properties.getProperty('MIGRATION_EXPORT_JOB_V1') !== null);
}

function migrationSandboxAssertPrivate_(item, ownerEmail) {
  // Reuse the reviewed exporter rule: owner === effective user, not trashed,
  // DriveApp.Access.PRIVATE, no visible editors/viewers (shared drives: no owner).
  migrationExportAssertPrivate_(item, ownerEmail);
}

function migrationSandboxMakePrivate_(item, ownerEmail) {
  // Called ONLY for items this tool just created; never for the parent or sources.
  item.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  migrationSandboxAssertPrivate_(item, ownerEmail);
}

function migrationSandboxAssertParent_(item, expectedParentId) {
  var parents = item.getParents();
  if (!parents.hasNext() || parents.next().getId() !== expectedParentId || parents.hasNext()) {
    migrationSandboxFail_('Synthetic artifact is outside its private rehearsal folder.');
  }
}

function migrationSandboxSummary_(created, contentVerified, exportStarted) {
  // Counts and booleans only: no Drive IDs, names, hashes or rows are logged.
  // Counts are reported ONLY when this call wrote and verified the content.
  var summary = {
    synthetic: true, created: created, alreadyCreated: !created,
    contentVerified: contentVerified, exportStarted: exportStarted
  };
  if (contentVerified) {
    summary.sheetCount = 4;
    summary.employeeCount = 3;
    summary.documentCount = 2;
    summary.fileCount = 3;
    summary.masterDocumentCount = 11;
    summary.logCount = 1;
  }
  Logger.log(JSON.stringify(summary));
  return summary;
}

function migrationSandboxFail_(message) {
  var error = new Error(message);
  error.migrationSandboxSafe_ = true;
  throw error;
}
