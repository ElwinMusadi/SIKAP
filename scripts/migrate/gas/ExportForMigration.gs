/**
 * Phase 8 PRIVATE, MANUAL migration exporter. Review, then paste ONLY into a NEW,
 * standalone, owner-only Apps Script project created for one export stage. NEVER
 * paste it into the live/production SIKAP project or editor, and NEVER put this
 * file in src, legacy-gas, a clasp deployment, a web API, a trigger, or a
 * google.script.run call. Use a fresh standalone project per stage (dry run,
 * cutover); never reuse a project or completed job for a different source.
 *
 * MANUAL OWNER PROCEDURE (this file does not perform these steps):
 * 1. Use the owner account. Create an EMPTY, unshared folder in private My Drive,
 *    outside shared ancestors. Check its permissions in Drive, including explicit
 *    users/groups. PRIVATE link access alone cannot prove every inherited/admin
 *    ACL; visible editors/viewers are also rejected here. Shared drives are rejected.
 *    The destination AND every ancestor up to the My Drive root (max 32 levels)
 *    must be owner-owned, PRIVATE, without visible editors/viewers, with a single
 *    parent and no cycle; the top must equal DriveApp.getRootFolder(). This is
 *    rechecked before every write. No owner bypass exists: if the real root
 *    reports no owner, export fails closed (verify once manually on a test run).
 * 2. Set exactly these Script Properties manually in project settings:
 *      MIGRATION_SPREADSHEET_ID     explicit source spreadsheet ID
 *      MIGRATION_EXPORT_FOLDER_ID   existing private destination folder ID
 *      MIGRATION_SOURCE_READONLY    literal "true" or "false" (required)
 *    No production IDs or credentials belong in this file. Other properties are
 *    NEVER enumerated/exported. Password_Hash cells are sensitive snapshot data.
 * 3. For CUTOVER, freeze ALL source writers, including scheduled jobs, and keep
 *    them frozen through the final snapshot and binary copies. Set READONLY=true
 *    only after doing that manually. false is permitted for a warned dry run only.
 *    This declaration is not enforced by code. Reads of values/display values,
 *    separate sheets and later file copies are NOT transactionally consistent;
 *    consistent ALWAYS remains false, even with a read-only declaration.
 * 4. Every function here ends in _. Apps Script may hide these from the Run menu.
 *    If necessary, add a TEMPORARY editor-only wrapper in a separate editor file:
 *      function temporaryMigrationRun() { exportForMigration_(); }
 *    DELETE that wrapper immediately after manual runs; never deploy it. Do not
 *    expose a callable endpoint, use a client, or create an automatic trigger.
 * 5. Run manually repeatedly until the count-only result says isComplete=true.
 *    MIGRATION_EXPORT_JOB_V1 is a resumable checkpoint, NOT an output. Do not edit
 *    it while pending. Resumes read the private snapshot, never reread the sheets.
 *    Keep the read-only declaration unchanged during a job; a dry-run snapshot
 *    cannot be promoted to a cutover snapshot by changing a property on resume.
 *    createdAt and finishedAt are UTC ISO strings (finishedAt starts as null).
 *    A soft 4.5-minute budget reserves 30 seconds for checkpointing; individual
 *    Drive/Sheets calls cannot be interrupted. At most 20 entries run per call.
 * 6. Inspect all invalid/missing counts and file statuses. Complete means processed, NOT
 *    success: downstream MUST require isComplete=true, no pending file entries,
 *    and readOnlyDeclared=true for cutover, then enforce its own integrity rules.
 *    Unsafe numeric NIP/NIK values remain numbers; downstream must reject lost
 *    precision, not silently stringify them or trust displayValues as recovery.
 * 7. Download snapshot-UUID using the Drive browser's folder download. Extract the
 *    browser-generated ZIP LOCALLY. It contains snapshot.sikap-export.json and
 *    files/{fileId}.bin (ordinary Drive folders/files, NOT a ZIP created by GAS).
 *    Treat the JSON, hashes and bytes as confidential. No public URLs are used.
 * 8. After verifying a download, delete MIGRATION_EXPORT_JOB_V1 manually ONLY to
 *    start a new snapshot of the SAME source. A completed checkpoint otherwise
 *    stays idempotent. The checkpoint is bound to MIGRATION_SPREADSHEET_ID and
 *    MIGRATION_EXPORT_FOLDER_ID at start; if either property later differs (or a
 *    legacy checkpoint lacks that binding) every run stops with
 *    CHECKPOINT_SOURCE_MISMATCH before any Drive/Sheets access, without reporting
 *    the old result. It is never overridden or deleted automatically. For a new
 *    source, use a fresh standalone project; do not reuse a completed job.
 *    If capture failed before checkpoint creation, inspect/remove its private
 *    orphan output before retrying. Remove exporter/wrapper from the editor when
 *    finished. Never change source sharing or revoke source permissions.
 *
 * Protocol v1: pending is allowed ONLY in an incomplete manifest. finishedAt is
 * null until all entries are processed. File statuses retain failures without
 * adding diagnostic fields to the strict v1 snapshot. One entry per fileId; a file
 * referenced as both document/photo is invalid (ambiguous kind; both limits 5 MiB).
 * Native Google Workspace files are invalid: getBlob would convert their bytes.
 * GAS-specific limits are narrower than the protocol's 50 MiB upper bound:
 * at most 100,000 data rows total, 7 MiB initial JSON (1 MiB metadata reserve),
 * and 8 MiB UTF-8 JSON on every checkpoint/resume. This stays below setContent's
 * 10 MB limit. EXPORT_SIZE_LIMIT stops before an oversized write; a pending job
 * may need manual review/restart if metadata exhausts the reserve. It is never
 * marked complete or advanced past the last durable checkpoint on that failure.
 */
function exportForMigration_() {
  var startedAt = Date.now();
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(1000);
    if (!locked) migrationExportFail_('Another migration export is running.');
    var properties = PropertiesService.getScriptProperties();
    var config = migrationExportConfig_(properties);
    var rawState = properties.getProperty('MIGRATION_EXPORT_JOB_V1');
    // Any present value, including '', is a checkpoint: it must parse or fail
    // closed. Only an absent property (null) may start a new snapshot.
    var hasState = rawState !== null;
    // Fail fast on a changed source/output BEFORE any Drive/Sheets access, so a
    // completed job can never report a stale success for a different source.
    if (hasState) migrationExportParseState_(rawState, config);
    var ownerEmail = Session.getEffectiveUser().getEmail();
    if (!ownerEmail) migrationExportFail_('A verifiable owner account is required.');
    var outputFolder = DriveApp.getFolderById(config.outputFolderId);
    migrationExportAssertPrivateAncestors_(outputFolder, ownerEmail);
    var context = hasState
      ? migrationExportResume_(rawState, outputFolder, ownerEmail, config)
      : migrationExportStart_(config, outputFolder, ownerEmail, startedAt);
    var manifest = context.manifest;
    var state = context.state;
    if (manifest.readOnlyDeclared !== config.readOnlyDeclared) {
      migrationExportFail_('Read-only declaration changed; preserve this job or start a new snapshot manually.');
    }
    if (!hasState) migrationExportSaveState_(properties, state);
    if (!manifest.readOnlyDeclared) {
      Logger.log('Dry-run warning: readOnlyDeclared=false; not valid for cutover.');
    }
    if (manifest.isComplete) return migrationExportSummary_(manifest, 0);

    var processed = 0;
    while (state.nextFileIndex < manifest.fileManifest.length && processed < 20 &&
           Date.now() - startedAt < 240000) {
      var fileIndex = state.nextFileIndex;
      var entry = manifest.fileManifest[fileIndex];
      if (entry.status === 'pending') {
        migrationExportAssertOutput_(context, outputFolder, ownerEmail);
        migrationExportProcessFile_(entry, context.filesFolder, ownerEmail);
      }
      state.nextFileIndex++;
      processed++;
      // Manifest first: a crash before the index write only rechecks a final entry.
      migrationExportSaveManifest_(context, outputFolder, ownerEmail);
      migrationExportSaveState_(properties, state);
    }
    if (state.nextFileIndex === manifest.fileManifest.length) {
      for (var i = 0; i < manifest.fileManifest.length; i++) {
        if (manifest.fileManifest[i].status === 'pending') {
          migrationExportFail_('Checkpoint still contains pending files.');
        }
      }
      manifest.isComplete = true;
      manifest.finishedAt = new Date().toISOString();
      migrationExportSaveManifest_(context, outputFolder, ownerEmail);
      migrationExportSaveState_(properties, state);
    }
    return migrationExportSummary_(manifest, processed);
  } catch (error) {
    // Never propagate Drive/Sheets exception text: it can contain IDs or content.
    throw new Error(error && error.migrationExportSafe_ === true
      ? error.message
      : 'Migration export stopped. Check owner access, configuration, quotas and private checkpoint files.');
  } finally {
    if (locked) lock.releaseLock();
  }
}

function migrationExportConfig_(properties) {
  var spreadsheetId = properties.getProperty('MIGRATION_SPREADSHEET_ID');
  var outputFolderId = properties.getProperty('MIGRATION_EXPORT_FOLDER_ID');
  var declaration = properties.getProperty('MIGRATION_SOURCE_READONLY');
  if (!migrationExportValidId_(spreadsheetId) || !migrationExportValidId_(outputFolderId)) {
    migrationExportFail_('Required manual spreadsheet/folder configuration is missing or malformed.');
  }
  if (declaration !== 'true' && declaration !== 'false') {
    migrationExportFail_('MIGRATION_SOURCE_READONLY must explicitly be true or false.');
  }
  return {
    spreadsheetId: spreadsheetId,
    outputFolderId: outputFolderId,
    readOnlyDeclared: declaration === 'true'
  };
}

function migrationExportHeaders_() {
  return {
    Data_Pegawai: [
      'NIP', 'Password_Hash', 'Role', 'Status_Akun', 'Nama_Lengkap',
      'Status_Kepegawaian', 'Pangkat_Golongan', 'Jabatan', 'No_HP', 'Alamat',
      'Folder_Drive_ID', 'Email', 'Golongan_Darah', 'NIK', 'Tempat_Lahir',
      'Tanggal_Lahir', 'Jenis_Kelamin', 'Agama', 'Pendidikan_Terakhir',
      'Status_Pernikahan', 'TMT_Pangkat', 'Jenis_Jabatan', 'TMT_Jabatan',
      'Unit_Organisasi', 'Foto_Drive_ID'
    ],
    Master_Dokumen: ['ID_Dokumen', 'Nama_Dokumen', 'Kategori', 'Status_Wajib'],
    Arsip_Dokumen: [
      'ID_Arsip', 'NIP', 'ID_Dokumen', 'File_Drive_ID', 'File_URL',
      'Status_Verifikasi', 'Catatan_Admin', 'Waktu_Upload', 'Waktu_Verifikasi', 'NIP_Verifier'
    ],
    Log_Aktivitas: [
      'Log_ID', 'Timestamp', 'Actor_NIP', 'Actor_Role', 'Action',
      'Target_Type', 'Target_ID', 'Description', 'Result'
    ]
  };
}

function migrationExportStart_(config, outputFolder, ownerEmail, startedAt) {
  var manifest = {
    format: 'sikap-gas-export',
    version: 1,
    snapshotId: Utilities.getUuid(),
    createdAt: new Date().toISOString(),
    sourceTimezone: 'Asia/Makassar',
    consistent: false,
    readOnlyDeclared: config.readOnlyDeclared,
    isComplete: false,
    finishedAt: null,
    sheets: {},
    fileManifest: []
  };
  // Independent of every deployed helper/global, including hotfix helpers.
  var spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
  if (spreadsheet.getSpreadsheetTimeZone() !== 'Asia/Makassar') {
    migrationExportFail_('Source spreadsheet timezone must be Asia/Makassar.');
  }
  var canonical = migrationExportHeaders_();
  var sheetNames = Object.keys(canonical);
  // Check ALL sheet dimensions before any bulk value/display reads.
  var captures = migrationExportPreflight_(spreadsheet, canonical);
  for (var i = 0; i < sheetNames.length; i++) {
    var sheetName = sheetNames[i];
    manifest.sheets[sheetName] = migrationExportReadSheet_(captures[sheetName], sheetName, canonical[sheetName]);
    if (Date.now() - startedAt >= 240000) {
      migrationExportFail_('Sheet capture exceeded the safe budget; no resumable checkpoint was created.');
    }
  }
  migrationExportCollectFiles_(manifest);
  // Fail before creating any output or persistent job state. Reserve 1 MiB for
  // file metadata and completion timestamps; every later write is checked too.
  var serialized = migrationExportSerialize_(manifest, 7 * 1024 * 1024);
  migrationExportAssertPrivateAncestors_(outputFolder, ownerEmail);
  var snapshotFolder = outputFolder.createFolder('snapshot-' + manifest.snapshotId);
  migrationExportMakePrivate_(snapshotFolder, ownerEmail);
  var filesFolder = snapshotFolder.createFolder('files');
  migrationExportMakePrivate_(filesFolder, ownerEmail);
  // Capture all rows FIRST. No source file is opened until this JSON is durable.
  // This same JSON is updated in place; no second PII-containing manifest exists.
  var manifestFile = snapshotFolder.createFile(Utilities.newBlob(
    serialized, 'application/json', 'snapshot.sikap-export.json'
  ));
  migrationExportMakePrivate_(manifestFile, ownerEmail);
  return {
    manifest: manifest,
    snapshotFolder: snapshotFolder,
    filesFolder: filesFolder,
    manifestFile: manifestFile,
    state: {
      sourceSpreadsheetId: config.spreadsheetId,
      outputFolderId: config.outputFolderId,
      snapshotFolderId: snapshotFolder.getId(),
      manifestFileId: manifestFile.getId(),
      nextFileIndex: 0
    }
  };
}

function migrationExportPreflight_(spreadsheet, canonical) {
  var names = Object.keys(canonical);
  var captures = {};
  var totalRows = 0;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) migrationExportFail_('Required sheet missing: ' + name + '.');
    var rowCount = sheet.getLastRow();
    if (!Number.isInteger(rowCount) || rowCount < 1 ||
        sheet.getLastColumn() !== canonical[name].length) {
      migrationExportFail_('Canonical header width mismatch: ' + name + ', row 1.');
    }
    totalRows += rowCount - 1;
    if (totalRows > 100000) migrationExportFail_('EXPORT_ROW_LIMIT');
    captures[name] = { sheet: sheet, rowCount: rowCount };
  }
  return captures;
}

function migrationExportReadSheet_(capture, sheetName, headers) {
  var sheet = capture.sheet;
  var rowCount = capture.rowCount;
  if (sheet.getLastRow() !== rowCount || sheet.getLastColumn() !== headers.length) {
    migrationExportFail_('Sheet dimensions changed during capture: ' + sheetName + '.');
  }
  var range = sheet.getRange(1, 1, rowCount, headers.length);
  var values = range.getValues();
  var displayValues = range.getDisplayValues();
  if (values.length !== rowCount || displayValues.length !== rowCount) {
    migrationExportFail_('Sheet dimensions changed during capture: ' + sheetName + '.');
  }
  for (var h = 0; h < headers.length; h++) {
    if (values[0][h] !== headers[h]) {
      migrationExportFail_('Canonical header mismatch: ' + sheetName + ', row 1, column ' + (h + 1) + '.');
    }
  }
  var rows = [];
  for (var r = 1; r < rowCount; r++) {
    if (values[r].length !== headers.length || displayValues[r].length !== headers.length) {
      migrationExportFail_('Sheet row width mismatch: ' + sheetName + ', row ' + (r + 1) + '.');
    }
    var cells = [];
    for (var c = 0; c < headers.length; c++) {
      cells.push(migrationExportCell_(values[r][c], sheetName, r + 1, c + 1));
      if (typeof displayValues[r][c] !== 'string') {
        migrationExportFail_('Invalid display cell: ' + sheetName + ', row ' + (r + 1) + ', column ' + (c + 1) + '.');
      }
    }
    rows.push({ rowNumber: r + 1, values: cells, displayValues: displayValues[r] });
  }
  return { headers: headers.slice(), rows: rows };
}

function migrationExportCell_(value, sheetName, rowNumber, columnNumber) {
  if (value instanceof Date && isFinite(value.getTime())) return { $date: value.toISOString() };
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && isFinite(value))) return value;
  migrationExportFail_('Unsupported cell: ' + sheetName + ', row ' + rowNumber + ', column ' + columnNumber + '.');
}

function migrationExportCollectFiles_(manifest) {
  var references = [
    { sheet: 'Arsip_Dokumen', header: 'File_Drive_ID', kind: 'document' },
    { sheet: 'Data_Pegawai', header: 'Foto_Drive_ID', kind: 'photo' }
  ];
  var seen = Object.create(null);
  for (var s = 0; s < references.length; s++) {
    var reference = references[s];
    var sheet = manifest.sheets[reference.sheet];
    var column = sheet.headers.indexOf(reference.header);
    if (column < 0) migrationExportFail_('Required file reference header is missing.');
    for (var r = 0; r < sheet.rows.length; r++) {
      var row = sheet.rows[r];
      var value = row.values[column];
      if (value === '' || value === null) continue;
      // Only FILE references get a string representation for invalid reporting.
      // Source cells, especially numeric NIP/NIK, are never changed/coerced.
      var fileId = typeof value === 'string' ? value : JSON.stringify(value);
      var valid = migrationExportValidId_(value);
      if (Object.prototype.hasOwnProperty.call(seen, fileId)) {
        var previous = manifest.fileManifest[seen[fileId]];
        // A malformed typed reference must never be legitimized by deduplication.
        if (!valid || previous.kind !== reference.kind) previous.status = 'invalid';
        continue;
      }
      seen[fileId] = manifest.fileManifest.length;
      manifest.fileManifest.push({
        fileId: fileId, kind: reference.kind,
        name: null, mimeType: null, sizeBytes: null, sha256: null,
        status: valid ? 'pending' : 'invalid'
      });
    }
  }
}

function migrationExportParseState_(rawState, config) {
  var state;
  try { state = JSON.parse(rawState); } catch (error) {
    migrationExportFail_('Migration checkpoint JSON is invalid.');
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !migrationExportValidId_(state.snapshotFolderId) ||
      !migrationExportValidId_(state.manifestFileId) ||
      !Number.isInteger(state.nextFileIndex) || state.nextFileIndex < 0) {
    migrationExportFail_('Migration checkpoint fields are invalid.');
  }
  var keys = Object.keys(state);
  var bindingKeys = ['sourceSpreadsheetId', 'outputFolderId'];
  var hasBinding = bindingKeys.some(function (key) {
    return Object.prototype.hasOwnProperty.call(state, key);
  });
  // A legacy (unbound) checkpoint cannot prove its source; refuse, never adopt it.
  if (!hasBinding && keys.length === 3) {
    migrationExportFail_('CHECKPOINT_SOURCE_MISMATCH: checkpoint has no source binding. Preserve it; use a fresh standalone project.');
  }
  if (keys.length !== 5 || !migrationExportValidId_(state.sourceSpreadsheetId) ||
      !migrationExportValidId_(state.outputFolderId)) {
    migrationExportFail_('Migration checkpoint fields are invalid.');
  }
  // IDs are intentionally omitted from the message.
  if (state.sourceSpreadsheetId !== config.spreadsheetId ||
      state.outputFolderId !== config.outputFolderId) {
    migrationExportFail_('CHECKPOINT_SOURCE_MISMATCH: configured source/output differs from this checkpoint. Preserve it; use a fresh standalone project.');
  }
  return state;
}

function migrationExportResume_(rawState, outputFolder, ownerEmail, config) {
  var state = migrationExportParseState_(rawState, config);
  if (outputFolder.getId() !== state.outputFolderId) {
    migrationExportFail_('CHECKPOINT_SOURCE_MISMATCH: configured source/output differs from this checkpoint. Preserve it; use a fresh standalone project.');
  }
  var snapshotFolder = DriveApp.getFolderById(state.snapshotFolderId);
  migrationExportAssertPrivate_(snapshotFolder, ownerEmail);
  migrationExportAssertParent_(snapshotFolder, outputFolder.getId());
  var manifestFile = DriveApp.getFileById(state.manifestFileId);
  migrationExportAssertPrivate_(manifestFile, ownerEmail);
  migrationExportAssertParent_(manifestFile, snapshotFolder.getId());
  if (manifestFile.getName() !== 'snapshot.sikap-export.json') {
    migrationExportFail_('Checkpoint manifest filename is invalid.');
  }
  var manifestSize = manifestFile.getSize();
  if (!Number.isInteger(manifestSize) || manifestSize < 0 || manifestSize > 8 * 1024 * 1024) {
    migrationExportFail_('EXPORT_SIZE_LIMIT');
  }
  var manifestBlob = manifestFile.getBlob();
  // Recheck bytes in case a file changed after getSize; reject before decoding.
  if (manifestBlob.getBytes().length > 8 * 1024 * 1024) {
    migrationExportFail_('EXPORT_SIZE_LIMIT');
  }
  var manifest;
  try { manifest = JSON.parse(manifestBlob.getDataAsString('UTF-8')); } catch (error) {
    migrationExportFail_('Private snapshot JSON is invalid.');
  }
  migrationExportValidateManifest_(manifest, state.nextFileIndex);
  if (snapshotFolder.getName() !== 'snapshot-' + manifest.snapshotId) {
    migrationExportFail_('Checkpoint snapshot folder does not match the manifest.');
  }
  var folders = snapshotFolder.getFoldersByName('files');
  if (!folders.hasNext()) migrationExportFail_('Private files folder is missing.');
  var filesFolder = folders.next();
  if (folders.hasNext()) migrationExportFail_('Private files folder is ambiguous.');
  migrationExportAssertPrivate_(filesFolder, ownerEmail);
  return {
    manifest: manifest, state: state, snapshotFolder: snapshotFolder,
    manifestFile: manifestFile, filesFolder: filesFolder
  };
}

function migrationExportValidateManifest_(manifest, nextFileIndex) {
  if (!manifest || manifest.format !== 'sikap-gas-export' || manifest.version !== 1 ||
      typeof manifest.snapshotId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manifest.snapshotId) ||
      typeof manifest.createdAt !== 'string' || manifest.sourceTimezone !== 'Asia/Makassar' ||
      manifest.consistent !== false || typeof manifest.readOnlyDeclared !== 'boolean' ||
      typeof manifest.isComplete !== 'boolean' || !Array.isArray(manifest.fileManifest) ||
      !manifest.sheets ||
      nextFileIndex > manifest.fileManifest.length) {
    migrationExportFail_('Snapshot protocol or checkpoint is invalid.');
  }
  var allowedKeys = [
    'format', 'version', 'snapshotId', 'createdAt', 'sourceTimezone', 'consistent',
    'readOnlyDeclared', 'isComplete', 'finishedAt', 'sheets', 'fileManifest'
  ];
  var manifestKeys = Object.keys(manifest);
  if (manifestKeys.length !== allowedKeys.length || manifestKeys.some(function (key) {
    return allowedKeys.indexOf(key) < 0;
  })) {
    migrationExportFail_('Snapshot envelope fields are invalid.');
  }
  var names = Object.keys(migrationExportHeaders_());
  if (Object.keys(manifest.sheets).length !== names.length) {
    migrationExportFail_('Snapshot sheet allowlist is invalid.');
  }
  for (var s = 0; s < names.length; s++) {
    if (!Object.prototype.hasOwnProperty.call(manifest.sheets, names[s])) {
      migrationExportFail_('Snapshot sheet allowlist is invalid.');
    }
  }
  var seen = Object.create(null);
  for (var i = 0; i < manifest.fileManifest.length; i++) {
    var entry = manifest.fileManifest[i];
    if (!entry || typeof entry.fileId !== 'string' ||
        Object.prototype.hasOwnProperty.call(seen, entry.fileId) ||
        (entry.kind !== 'document' && entry.kind !== 'photo') ||
        ['pending', 'available', 'missing', 'invalid'].indexOf(entry.status) < 0 ||
        (entry.status !== 'invalid' && !migrationExportValidId_(entry.fileId)) ||
        (entry.status === 'pending' && (i < nextFileIndex || manifest.isComplete))) {
      migrationExportFail_('Snapshot file manifest or checkpoint is invalid.');
    }
    seen[entry.fileId] = true;
  }
  if ((manifest.isComplete && (nextFileIndex !== manifest.fileManifest.length ||
       typeof manifest.finishedAt !== 'string')) || (!manifest.isComplete && manifest.finishedAt !== null)) {
    migrationExportFail_('Snapshot completion marker is invalid.');
  }
}

function migrationExportProcessFile_(entry, filesFolder, ownerEmail) {
  if (!migrationExportValidId_(entry.fileId)) {
    entry.status = 'invalid';
    return;
  }
  var bytes;
  var maxBytes = 5 * 1024 * 1024; // Independently applies to documents AND photos.
  try {
    var sourceFile = DriveApp.getFileById(entry.fileId);
    if (sourceFile.isTrashed()) {
      entry.status = 'missing';
      return;
    }
    entry.name = sourceFile.getName();
    entry.mimeType = sourceFile.getMimeType();
    entry.sizeBytes = sourceFile.getSize();
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > maxBytes) {
      entry.status = 'invalid';
      return;
    }
    if (entry.mimeType.indexOf('application/vnd.google-apps.') === 0) {
      entry.status = 'invalid';
      return;
    }
    bytes = sourceFile.getBlob().getBytes();
    if (bytes.length > maxBytes || bytes.length !== entry.sizeBytes) {
      entry.status = 'invalid';
      return;
    }
  } catch (error) {
    entry.status = 'missing';
    return;
  }
  // Output/privacy failures abort safely rather than declaring a possibly shared
  // copy available. Only source access failures above become missing entries.
  migrationExportAssertPrivate_(filesFolder, ownerEmail);
  var filename = entry.fileId + '.bin';
  var existing = filesFolder.getFilesByName(filename);
  var copied;
  if (existing.hasNext()) {
    // Recover a copy left by interruption. Never overwrite/trash an existing file,
    // even in this snapshot: an operator could have moved a source into it.
    copied = existing.next();
    migrationExportAssertPrivate_(copied, ownerEmail);
    if (existing.hasNext() || copied.getSize() !== bytes.length) {
      entry.status = 'invalid';
      return;
    }
  } else {
    copied = filesFolder.createFile(Utilities.newBlob(bytes, 'application/octet-stream', filename));
    migrationExportMakePrivate_(copied, ownerEmail);
  }
  var copiedBytes = copied.getBlob().getBytes();
  var sourceDigest = migrationExportSha256_(bytes);
  if (copiedBytes.length !== bytes.length || migrationExportSha256_(copiedBytes) !== sourceDigest) {
    entry.status = 'invalid';
    return;
  }
  entry.sha256 = sourceDigest;
  entry.status = 'available';
}

function migrationExportSha256_(bytes) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var part = (digest[i] & 255).toString(16);
    hex += part.length === 1 ? '0' + part : part;
  }
  return hex;
}

function migrationExportAssertOutput_(context, outputFolder, ownerEmail) {
  migrationExportAssertPrivateAncestors_(outputFolder, ownerEmail);
  migrationExportAssertPrivate_(context.snapshotFolder, ownerEmail);
  migrationExportAssertPrivate_(context.filesFolder, ownerEmail);
  migrationExportAssertPrivate_(context.manifestFile, ownerEmail);
  migrationExportAssertParent_(context.snapshotFolder, outputFolder.getId());
  migrationExportAssertParent_(context.filesFolder, context.snapshotFolder.getId());
  migrationExportAssertParent_(context.manifestFile, context.snapshotFolder.getId());
}

function migrationExportSerialize_(manifest, maxBytes) {
  var serialized = JSON.stringify(manifest);
  if (Utilities.newBlob(serialized, 'application/json').getBytes().length > maxBytes) {
    migrationExportFail_('EXPORT_SIZE_LIMIT');
  }
  return serialized;
}

function migrationExportSaveManifest_(context, outputFolder, ownerEmail) {
  // Count UTF-8 bytes, not JavaScript UTF-16 code units; setContent has a 10 MB cap.
  var serialized = migrationExportSerialize_(context.manifest, 8 * 1024 * 1024);
  migrationExportAssertOutput_(context, outputFolder, ownerEmail);
  context.manifestFile.setContent(serialized);
  migrationExportAssertPrivate_(context.manifestFile, ownerEmail);
}

function migrationExportSaveState_(properties, state) {
  // Private Script Property only. The configured spreadsheet/output folder IDs bind
  // the job to its source; no rows, source file IDs, hashes, credentials, names
  // or other PII. These IDs are NEVER written into the exported JSON envelope.
  properties.setProperty('MIGRATION_EXPORT_JOB_V1', JSON.stringify({
    sourceSpreadsheetId: state.sourceSpreadsheetId,
    outputFolderId: state.outputFolderId,
    snapshotFolderId: state.snapshotFolderId,
    manifestFileId: state.manifestFileId,
    nextFileIndex: state.nextFileIndex
  }));
}

function migrationExportAssertPrivate_(item, ownerEmail) {
  var owner = item.getOwner();
  if (item.isTrashed() || !owner || owner.getEmail().toLowerCase() !== ownerEmail.toLowerCase() ||
      item.getSharingAccess() !== DriveApp.Access.PRIVATE ||
      item.getEditors().length !== 0 || item.getViewers().length !== 0) {
    migrationExportFail_('Output must be private, unshared and owned by the executing account.');
  }
}

/**
 * Reusable: asserts `folder` and EVERY ancestor up to the owner's My Drive root
 * with migrationExportAssertPrivate_ (owner match, PRIVATE, no visible
 * editors/viewers). Rejects multiple parents, cycles, more than 32 ancestors and
 * any top-level folder other than DriveApp.getRootFolder() (shared drives,
 * "Shared with me" orphans). No owner bypass for the root: a null owner fails.
 */
function migrationExportAssertPrivateAncestors_(folder, ownerEmail) {
  var rootId = DriveApp.getRootFolder().getId();
  var visited = Object.create(null);
  var current = folder;
  for (var depth = 0; depth <= 32; depth++) {
    var id = current.getId();
    if (Object.prototype.hasOwnProperty.call(visited, id)) {
      migrationExportFail_('Output folder ancestry is invalid (cycle).');
    }
    visited[id] = true;
    migrationExportAssertPrivate_(current, ownerEmail);
    var parents = current.getParents();
    if (!parents.hasNext()) {
      if (id !== rootId) migrationExportFail_('Output folder must be inside the owner My Drive root.');
      return;
    }
    var parent = parents.next();
    if (parents.hasNext()) migrationExportFail_('Output folder ancestry is invalid (multiple parents).');
    current = parent;
  }
  migrationExportFail_('Output folder ancestry is too deep.');
}

function migrationExportMakePrivate_(item, ownerEmail) {
  // Called ONLY for newly created output, never for the destination or source.
  item.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  migrationExportAssertPrivate_(item, ownerEmail);
}

function migrationExportAssertParent_(item, expectedParentId) {
  var parents = item.getParents();
  if (!parents.hasNext() || parents.next().getId() !== expectedParentId || parents.hasNext()) {
    migrationExportFail_('Checkpoint output is outside the configured private folder.');
  }
}

function migrationExportValidId_(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

function migrationExportSummary_(manifest, processed) {
  var summary = {
    snapshotId: manifest.snapshotId, isComplete: manifest.isComplete,
    processedCount: processed, pendingCount: 0, availableCount: 0,
    missingCount: 0, invalidCount: 0
  };
  for (var i = 0; i < manifest.fileManifest.length; i++) {
    summary[manifest.fileManifest[i].status + 'Count']++;
  }
  // Only counts, completion state and the snapshot UUID; no Drive IDs/PII/hashes.
  Logger.log(JSON.stringify(summary));
  return summary;
}

function migrationExportFail_(message) {
  var error = new Error(message);
  error.migrationExportSafe_ = true;
  throw error;
}
