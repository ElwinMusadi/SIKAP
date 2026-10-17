/**
 * SIKAP: PENYALIN SUMBER PRIVAT v2 — MANUAL, BUKAN WEB APP.
 * Pasang bersama ExportForMigration.gs di project Apps Script standalone BARU.
 * JANGAN pasang di project produksi, Deploy, trigger, atau google.script.run.
 *
 * Script Properties:
 * MIGRATION_COPY_SOURCE_ID: spreadsheet sumber yang diizinkan untuk DIBACA.
 * MIGRATION_COPY_PARENT_ID: folder My Drive BARU/KOSONG, milik operator, PRIVATE,
 *   tanpa editor/viewer tambahan; seluruh induk sampai root harus sama-sama privat.
 * MIGRATION_COPY_CONFIRM: COPY_SOURCE_READ_ONLY (persis).
 * Fungsi sementara: function runPrivateCopy(){copyPrivateMigrationSource_();}
 * Jalankan berulang hingga isComplete=true, pendingCount=0, errorCount=0; hapus wrapper.
 *
 * Sumber tidak ditulis/diubah sharing/dipindah/dihapus. Target dibuat sendiri dengan
 * SpreadsheetApp.create: hanya NILAI empat tab, bukan bound script/formula/trigger.
 * File_URL dan Folder_Drive_ID dikosongkan hanya pada target. Teks berawalan '=' atau
 * apostrof ditolak; identitas numerik ditolak, bukan diperbaiki dengan tebakan.
 * Spreadsheet ditulis maksimal 5 x 200 baris/run, file 10/run, anggaran lunak 240s.
 * Checkpoint disimpan SEBELUM bulk write; pemetaan file disimpan SEBELUM patch sel.
 * Dokumen/foto: PDF/JPEG/PNG/WEBP, foto hanya gambar, maks5MiB, SHA-256 cocok.
 * Foto bersama mendapat salinan per pegawai. Tidak ada makeCopy/penghapusan apa pun.
 *
 * Jika getFileById gagal (izin/hilang/kuota/network), entri tetap pending; periksa akses
 * lalu ulangi. File terkonfirmasi trashed/bad-MIME dicatat error dan memblokir complete.
 * Jangan mengedit manifest/checkpoint untuk melewati guard. Manifest berisi PII: privat.
 * Kegagalan sebelum checkpoint pertama dapat meninggalkan folder/spreadsheet baru,
 * termasuk di My Drive root bila moveTo gagal. Bersihkan HANYA artefak baru secara manual.
 *
 * Hasil Script Properties: MIGRATION_COPY_TARGET_ID, MIGRATION_COPY_EXPORT_FOLDER_ID.
 * Tool TIDAK mengisi properti exporter standar/flag read-only dan tidak memulai ekspor.
 * Setelah memeriksa/membekukan target, operator mengisi properti ekspor. Jangan jalankan
 * copy lagi setelahnya. Sumber ini NONTRANSAKSIONAL: freeze seluruh penulis saat cutover.
 * Tidak ada jaminan API ACL domain terwakili sempurna; periksa Share secara manual juga.
 */
var COPY_MIGRATION_STATE_KEY_ = 'MIGRATION_COPY_JOB_V1';
var COPY_MIGRATION_ALLOWED_MIME_ = {
  document: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
  photo: ['image/jpeg', 'image/png', 'image/webp']
};

function copyPrivateMigrationSource_() {
  var startedAt = Date.now();
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(1000);
    if (!locked) copyMigrationFail_('COPY_BUSY');
    var properties = PropertiesService.getScriptProperties();
    var config = copyMigrationConfig_(properties);
    var rawState = properties.getProperty(COPY_MIGRATION_STATE_KEY_);
    if (rawState !== null) {
      copyMigrationParseState_(rawState, config);
      // Revoke the readiness signal BEFORE any Drive access or re-verification.
      // Even an inaccessible/damaged manifest must not leave stale export-ready IDs.
      properties.deleteProperty('MIGRATION_COPY_TARGET_ID');
      properties.deleteProperty('MIGRATION_COPY_EXPORT_FOLDER_ID');
    }
    var ownerEmail = Session.getEffectiveUser().getEmail();
    if (!ownerEmail) copyMigrationFail_('COPY_OWNER_UNAVAILABLE');
    var parent = DriveApp.getFolderById(config.parentFolderId);
    migrationExportAssertPrivateAncestors_(parent, ownerEmail);
    var ctx;
    if (rawState === null) {
      ctx = copyMigrationStart_(config, parent, ownerEmail, startedAt);
      copyMigrationSaveState_(properties, ctx.state);
    } else ctx = copyMigrationResume_(rawState, config, parent, ownerEmail);
    var m = ctx.manifest;
    if (m.isComplete) {
      m.isComplete = false; m.finishedAt = null; m.verifyIndex = 0;
      copyMigrationSaveManifest_(ctx, ownerEmail);
    }
    if (m.phase === 'initializing') {
      copyMigrationInitialize_(ctx, ownerEmail, startedAt);
      if (m.phase === 'initializing') return copyMigrationSummary_(m);
    }
    copyMigrationCheckAllTarget_(ctx);
    var processed = 0;
    while (ctx.state.nextIndex < m.entries.length && processed < 10 && Date.now() - startedAt < 240000) {
      var entry = m.entries[ctx.state.nextIndex];
      if (entry.status === 'pending') {
        copyMigrationAssertContext_(ctx, ownerEmail);
        copyMigrationCopyFile_(entry, ctx, ownerEmail);
        copyMigrationSaveManifest_(ctx, ownerEmail);
      }
      if (entry.status === 'copied') {
        copyMigrationAssertContext_(ctx, ownerEmail);
        copyMigrationPatch_(entry, ctx, ownerEmail);
        entry.status = 'done';
        copyMigrationSaveManifest_(ctx, ownerEmail);
      }
      ctx.state.nextIndex++;
      processed++;
      copyMigrationSaveState_(properties, ctx.state);
    }
    if (ctx.state.nextIndex === m.entries.length) {
      var ok = copyMigrationFinalVerify_(ctx, ownerEmail, startedAt);
      if (ok && copyMigrationCount_(m, 'error') === 0) {
        copyMigrationValidateReferences_(m);
        copyMigrationCheckAllTarget_(ctx);
        m.isComplete = true; m.finishedAt = new Date().toISOString();
        copyMigrationSaveManifest_(ctx, ownerEmail);
        properties.setProperties({ MIGRATION_COPY_TARGET_ID: m.targetSpreadsheetId,
          MIGRATION_COPY_EXPORT_FOLDER_ID: m.exportFolderId }, false);
      }
    }
    return copyMigrationSummary_(m);
  } catch (error) {
    throw new Error(error && error.migrationExportSafe_ === true ? error.message : 'COPY_SYSTEM_ERROR');
  } finally { if (locked) lock.releaseLock(); }
}

function copyMigrationConfig_(properties) {
  var sourceId = properties.getProperty('MIGRATION_COPY_SOURCE_ID');
  var parentId = properties.getProperty('MIGRATION_COPY_PARENT_ID');
  if (!migrationExportValidId_(sourceId) || !migrationExportValidId_(parentId) || sourceId === parentId ||
      properties.getProperty('MIGRATION_COPY_CONFIRM') !== 'COPY_SOURCE_READ_ONLY') copyMigrationFail_('COPY_CONFIG_INVALID');
  ['MIGRATION_EXPORT_JOB_V1', 'MIGRATION_SANDBOX_V1', 'MIGRATION_SPREADSHEET_ID',
    'MIGRATION_EXPORT_FOLDER_ID', 'MIGRATION_SOURCE_READONLY'].forEach(function (key) {
    if (properties.getProperty(key) !== null) copyMigrationFail_('COPY_FRESH_PROJECT_REQUIRED');
  });
  return { sourceSpreadsheetId: sourceId, parentFolderId: parentId };
}

function copyMigrationStart_(config, parent, ownerEmail, startedAt) {
  var properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('MIGRATION_COPY_TARGET_ID') !== null ||
      properties.getProperty('MIGRATION_COPY_EXPORT_FOLDER_ID') !== null) copyMigrationFail_('COPY_FRESH_PROJECT_REQUIRED');
  if (parent.getFiles().hasNext() || parent.getFolders().hasNext()) copyMigrationFail_('COPY_PARENT_NOT_EMPTY');
  var sourceFile = DriveApp.getFileById(config.sourceSpreadsheetId);
  if (sourceFile.isTrashed() || sourceFile.getMimeType() !== 'application/vnd.google-apps.spreadsheet') copyMigrationFail_('COPY_SOURCE_NOT_SPREADSHEET');
  var captured = copyMigrationCaptureSource_(config.sourceSpreadsheetId);
  var entries = copyMigrationCollect_(captured);
  if (Date.now() - startedAt >= 180000) copyMigrationFail_('COPY_CAPTURE_TIME_LIMIT');
  var m = { format: 'sikap-private-copy', version: 2, jobId: Utilities.getUuid(),
    createdAt: new Date().toISOString(), finishedAt: null, isComplete: false, verifyIndex: 0,
    consistent: false, sourceUnchangedByTool: true, sourceSpreadsheetId: config.sourceSpreadsheetId,
    jobFolderId: null, targetSpreadsheetId: null, documentsFolderId: null,
    photosFolderId: null, exportFolderId: null, sheets: {}, data: {}, entries: entries,
    phase: 'initializing', sheetIndex: 0, nextRow: 0 };
  Object.keys(captured).forEach(function (name) {
    m.sheets[name] = { rowCount: captured[name].length };
    m.data[name] = captured[name].map(function (row) { return row.map(function (v) {
      return v instanceof Date ? { $date: v.toISOString() } : v;
    }); });
  });
  m.referenceCount = entries.reduce(function (n, e) { return n + e.refs.length; }, 0);
  m.referenceHash = copyMigrationReferenceHash_(m);
  m.dataHash = copyMigrationDataHash_(m);
  migrationExportSerialize_(m, 7 * 1024 * 1024);
  migrationExportAssertPrivateAncestors_(parent, ownerEmail);
  var jobFolder = parent.createFolder('sikap-private-copy-' + m.jobId);
  migrationExportMakePrivate_(jobFolder, ownerEmail);
  var folders = {};
  ['documents', 'photos', 'export-output'].forEach(function (name) {
    folders[name] = jobFolder.createFolder(name); migrationExportMakePrivate_(folders[name], ownerEmail);
  });
  var target = SpreadsheetApp.create('SIKAP PRIVATE MIGRATION COPY ' + m.jobId);
  if (target.getId() === config.sourceSpreadsheetId) copyMigrationFail_('COPY_TARGET_IS_SOURCE');
  var targetFile = DriveApp.getFileById(target.getId());
  targetFile.moveTo(jobFolder); migrationExportMakePrivate_(targetFile, ownerEmail);
  target.setSpreadsheetTimeZone('Asia/Makassar');
  m.jobFolderId = jobFolder.getId(); m.targetSpreadsheetId = target.getId();
  m.documentsFolderId = folders.documents.getId(); m.photosFolderId = folders.photos.getId();
  m.exportFolderId = folders['export-output'].getId();
  // Persist captured values before bulk target writes. Creation failures before this
  // point leave only private new artifacts; the source is never changed.
  var manifestFile = jobFolder.createFile(Utilities.newBlob(migrationExportSerialize_(m, 8 * 1024 * 1024),
    'application/json', 'manifest.json'));
  migrationExportMakePrivate_(manifestFile, ownerEmail);
  var state = { version: 2, sourceSpreadsheetId: config.sourceSpreadsheetId,
    parentFolderId: config.parentFolderId, jobFolderId: m.jobFolderId,
    targetSpreadsheetId: m.targetSpreadsheetId, manifestFileId: manifestFile.getId(), nextIndex: 0,
    referenceCount: m.referenceCount, referenceHash: m.referenceHash, dataHash: m.dataHash };
  var ctx = { manifest: m, state: state, parent: parent, jobFolder: jobFolder, manifestFile: manifestFile };
  copyMigrationLoadOutputs_(ctx, ownerEmail);
  return ctx;
}

function copyMigrationCaptureSource_(sourceId) {
  var ss = SpreadsheetApp.openById(sourceId);
  if (ss.getSpreadsheetTimeZone() !== 'Asia/Makassar') copyMigrationFail_('COPY_SOURCE_TIMEZONE');
  var headers = migrationExportHeaders_(); var captures = migrationExportPreflight_(ss, headers); var data = {};
  Object.keys(headers).forEach(function (name) {
    var rows = captures[name].sheet.getRange(1, 1, captures[name].rowCount, headers[name].length).getValues();
    if (rows.length !== captures[name].rowCount || JSON.stringify(rows[0]) !== JSON.stringify(headers[name])) copyMigrationFail_('COPY_SOURCE_HEADER');
    rows.forEach(function (row, index) {
      if (row.length !== headers[name].length) copyMigrationFail_('COPY_SOURCE_SHAPE');
      row.forEach(function (v, column) {
        var key = headers[name][column];
        if (index && ['NIP', 'Actor_NIP', 'NIP_Verifier', 'NIK'].indexOf(key) >= 0 && v !== '' && v !== null && typeof v !== 'string') copyMigrationFail_('COPY_NUMERIC_IDENTITY');
        if (v instanceof Date) { if (!isFinite(v.getTime())) copyMigrationFail_('COPY_CELL_INVALID'); }
        else if (typeof v === 'string') { if (v.charAt(0) === '=' || v.charAt(0) === "'") copyMigrationFail_('COPY_LITERAL_UNSUPPORTED'); }
        else if (!(typeof v === 'boolean' || (typeof v === 'number' && isFinite(v)))) copyMigrationFail_('COPY_CELL_INVALID');
      });
    });
    data[name] = rows;
  });
  ['File_URL', 'Folder_Drive_ID'].forEach(function (key) {
    var name = key === 'File_URL' ? 'Arsip_Dokumen' : 'Data_Pegawai'; var col = headers[name].indexOf(key);
    for (var i = 1; i < data[name].length; i++) data[name][i][col] = '';
    // A row containing only a stale navigation link is not a valid source record.
    if (data[name].length > 1 && data[name][data[name].length - 1].every(function (v) { return v === ''; })) copyMigrationFail_('COPY_EMPTY_SOURCE_ROW');
  });
  return data;
}

function copyMigrationCollect_(captured) {
  var headers = migrationExportHeaders_(); var entries = []; var documents = Object.create(null);
  [{ sheet: 'Arsip_Dokumen', header: 'File_Drive_ID', identity: 'ID_Arsip', kind: 'document' },
    { sheet: 'Data_Pegawai', header: 'Foto_Drive_ID', identity: 'NIP', kind: 'photo' }].forEach(function (spec) {
    var rows = captured[spec.sheet], cols = headers[spec.sheet], counts = Object.create(null);
    for (var r = 1; r < rows.length; r++) {
      var identity = rows[r][cols.indexOf(spec.identity)];
      if (typeof identity !== 'string' || !identity) copyMigrationFail_('COPY_ROW_IDENTITY_INVALID');
      counts[identity] = (counts[identity] || 0) + 1;
      if (counts[identity] > 1) copyMigrationFail_('COPY_DUPLICATE_ROW_IDENTITY');
    }
    for (r = 1; r < rows.length; r++) {
      var value = rows[r][cols.indexOf(spec.header)]; if (value === '') continue;
      var ref = { sheet: spec.sheet, header: spec.header, identityHeader: spec.identity,
        identity: rows[r][cols.indexOf(spec.identity)], rowNumber: r + 1, original: value, done: false };
      if (!migrationExportValidId_(value)) entries.push(copyMigrationEntry_(entries.length, spec.kind, null, ref, 'error', 'INVALID_REFERENCE'));
      else if (spec.kind === 'document' && documents[value] !== undefined) entries[documents[value]].refs.push(ref);
      else { if (spec.kind === 'document') documents[value] = entries.length;
        entries.push(copyMigrationEntry_(entries.length, spec.kind, value, ref, 'pending', null)); }
    }
  });
  return entries;
}

function copyMigrationEntry_(index, kind, sourceFileId, ref, status, code) {
  return { index: index, kind: kind, name: 'copy-' + kind + '-' + index, sourceFileId: sourceFileId,
    status: status, code: code, targetFileId: null, mimeType: null, sizeBytes: null, sha256: null, refs: [ref] };
}

function copyMigrationInitialize_(ctx, owner, startedAt) {
  var m = ctx.manifest, names = Object.keys(migrationExportHeaders_()), chunks = 0;
  while (m.sheetIndex < names.length && chunks < 5 && Date.now() - startedAt < 180000) {
    copyMigrationAssertContext_(ctx, owner);
    var name = names[m.sheetIndex], rows = m.data[name], sheet = ctx.target.getSheetByName(name);
    if (!sheet) {
      if (m.sheetIndex === 0 && ctx.target.getSheets().length === 1 && ctx.target.getSheets()[0].getLastRow() === 0) sheet = ctx.target.getSheets()[0].setName(name);
      else sheet = ctx.target.insertSheet(name);
    }
    var part = rows.slice(m.nextRow, m.nextRow + 200), width = rows[0].length;
    if (sheet.getMaxRows() < m.nextRow + part.length) sheet.insertRowsAfter(sheet.getMaxRows(), m.nextRow + part.length - sheet.getMaxRows());
    if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
    var range = sheet.getRange(m.nextRow + 1, 1, part.length, width), current = range.getValues(), formulas = range.getFormulas();
    for (var r = 0; r < part.length; r++) for (var c = 0; c < width; c++) {
      if (formulas[r][c] || (current[r][c] !== '' && !copyMigrationSame_(current[r][c], part[r][c]))) copyMigrationFail_('COPY_TARGET_CHANGED');
    }
    var formats = part.map(function (row) { return row.map(function (v) {
      return v && typeof v === 'object' && v.$date ? 'yyyy-mm-dd hh:mm:ss' : typeof v === 'string' ? '@' : 'General';
    }); });
    var values = part.map(function (row) { return row.map(function (v) { return v && typeof v === 'object' && v.$date ? new Date(v.$date) : v; }); });
    range.setNumberFormats(formats); range.setValues(values); SpreadsheetApp.flush();
    current = range.getValues(); formulas = range.getFormulas();
    for (r = 0; r < part.length; r++) for (c = 0; c < width; c++) {
      if (formulas[r][c] || !copyMigrationSame_(current[r][c], part[r][c])) copyMigrationFail_('COPY_TARGET_WRITE_FAILED');
    }
    m.nextRow += part.length;
    if (m.nextRow === rows.length) { m.nextRow = 0; m.sheetIndex++; }
    chunks++; copyMigrationSaveManifest_(ctx, owner);
  }
  if (m.sheetIndex === names.length) {
    copyMigrationCheckAllTarget_(ctx); m.phase = 'copying'; copyMigrationSaveManifest_(ctx, owner);
  }
}

function copyMigrationParseState_(raw, config) {
  var s; try { s = JSON.parse(raw); } catch (_) { copyMigrationFail_('COPY_CHECKPOINT_INVALID'); }
  var keys = ['version', 'sourceSpreadsheetId', 'parentFolderId', 'jobFolderId', 'targetSpreadsheetId',
    'manifestFileId', 'nextIndex', 'referenceCount', 'referenceHash', 'dataHash'];
  if (!s || Object.keys(s).length !== keys.length || keys.some(function (k) { return !Object.prototype.hasOwnProperty.call(s, k); }) ||
      s.version !== 2 || s.sourceSpreadsheetId !== config.sourceSpreadsheetId || s.parentFolderId !== config.parentFolderId ||
      s.targetSpreadsheetId === config.sourceSpreadsheetId || !Number.isInteger(s.nextIndex) || s.nextIndex < 0 ||
      !Number.isInteger(s.referenceCount) || s.referenceCount < 0 ||
      ['sourceSpreadsheetId', 'parentFolderId', 'jobFolderId', 'targetSpreadsheetId', 'manifestFileId'].some(function (k) { return !migrationExportValidId_(s[k]); }) ||
      [s.referenceHash, s.dataHash].some(function (h) { return typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h); })) copyMigrationFail_('COPY_CHECKPOINT_MISMATCH');
  return s;
}

function copyMigrationResume_(raw, config, parent, owner) {
  var state = copyMigrationParseState_(raw, config), folder = DriveApp.getFolderById(state.jobFolderId);
  migrationExportAssertPrivate_(folder, owner); migrationExportAssertParent_(folder, parent.getId());
  var file = DriveApp.getFileById(state.manifestFileId);
  migrationExportAssertPrivate_(file, owner); migrationExportAssertParent_(file, folder.getId());
  if (file.getName() !== 'manifest.json' || file.getSize() > 8 * 1024 * 1024) copyMigrationFail_('COPY_MANIFEST_LIMIT');
  var blob = file.getBlob(); if (blob.getBytes().length > 8 * 1024 * 1024) copyMigrationFail_('COPY_MANIFEST_LIMIT');
  var m; try { m = JSON.parse(blob.getDataAsString('UTF-8')); } catch (_) { copyMigrationFail_('COPY_MANIFEST_INVALID'); }
  copyMigrationValidateManifest_(m, state);
  if (folder.getName() !== 'sikap-private-copy-' + m.jobId) copyMigrationFail_('COPY_MANIFEST_INVALID');
  var ctx = { manifest: m, state: state, parent: parent, jobFolder: folder, manifestFile: file };
  copyMigrationLoadOutputs_(ctx, owner); return ctx;
}

function copyMigrationReferenceHash_(m) {
  var refs = m.entries.map(function (e) { return { index: e.index, kind: e.kind, sourceFileId: e.sourceFileId,
    refs: e.refs.map(function (r) { return { sheet: r.sheet, header: r.header, identityHeader: r.identityHeader,
      identity: r.identity, rowNumber: r.rowNumber, original: r.original }; }) }; });
  return migrationExportSha256_(Utilities.newBlob(JSON.stringify(refs), 'application/json').getBytes());
}

function copyMigrationDataHash_(m) {
  var names = Object.keys(migrationExportHeaders_());
  var rows = names.map(function (name) {
    var headers = migrationExportHeaders_()[name];
    var ref = headers.indexOf(name === 'Data_Pegawai' ? 'Foto_Drive_ID' : name === 'Arsip_Dokumen' ? 'File_Drive_ID' : '');
    return { name: name, rows: m.data[name].map(function (row) { return row.map(function (v, c) { return c === ref ? null : v; }); }) };
  });
  return migrationExportSha256_(Utilities.newBlob(JSON.stringify(rows), 'application/json').getBytes());
}

function copyMigrationValidateManifest_(m, state) {
  var headers = migrationExportHeaders_(), names = Object.keys(headers), total = 0, covered = Object.create(null);
  if (!m || m.format !== 'sikap-private-copy' || m.version !== 2 || !/^[0-9a-f-]{36}$/i.test(m.jobId) ||
      m.sourceSpreadsheetId !== state.sourceSpreadsheetId || m.jobFolderId !== state.jobFolderId || m.targetSpreadsheetId !== state.targetSpreadsheetId ||
      typeof m.isComplete !== 'boolean' || m.consistent !== false || m.sourceUnchangedByTool !== true ||
      ['initializing', 'copying'].indexOf(m.phase) < 0 || !Number.isInteger(m.sheetIndex) || m.sheetIndex < 0 || m.sheetIndex > 4 ||
      !Number.isInteger(m.nextRow) || m.nextRow < 0 || !Array.isArray(m.entries) || state.nextIndex > m.entries.length ||
      !Number.isInteger(m.verifyIndex) || m.verifyIndex < 0 || m.verifyIndex > m.entries.length || !m.data || !m.sheets ||
      Object.keys(m.data).sort().join('|') !== names.slice().sort().join('|') || Object.keys(m.sheets).sort().join('|') !== names.slice().sort().join('|')) copyMigrationFail_('COPY_MANIFEST_INVALID');
  var ids = [m.sourceSpreadsheetId, m.jobFolderId, m.targetSpreadsheetId, m.documentsFolderId, m.photosFolderId, m.exportFolderId, state.manifestFileId];
  if (ids.some(function (id) { return !migrationExportValidId_(id); }) || new Set(ids).size !== ids.length) copyMigrationFail_('COPY_MANIFEST_INVALID');
  names.forEach(function (name) {
    var rows = m.data[name];
    if (!Array.isArray(rows) || rows.length < 1 || m.sheets[name].rowCount !== rows.length || JSON.stringify(rows[0]) !== JSON.stringify(headers[name])) copyMigrationFail_('COPY_MANIFEST_INVALID');
    total += rows.length - 1;
    rows.forEach(function (row) { if (!Array.isArray(row) || row.length !== headers[name].length) copyMigrationFail_('COPY_MANIFEST_INVALID'); });
  });
  if (total > 100000 || (m.phase === 'copying' && (m.sheetIndex !== 4 || m.nextRow !== 0)) ||
      (m.phase === 'initializing' && (m.sheetIndex === 4 ? m.nextRow !== 0 : m.nextRow >= m.data[names[m.sheetIndex]].length))) copyMigrationFail_('COPY_MANIFEST_INVALID');
  var count = 0;
  m.entries.forEach(function (e, i) {
    if (!e || e.index !== i || !COPY_MIGRATION_ALLOWED_MIME_[e.kind] || e.name !== 'copy-' + e.kind + '-' + i ||
        ['pending', 'copied', 'done', 'error'].indexOf(e.status) < 0 || !Array.isArray(e.refs) || !e.refs.length ||
        (e.status !== 'error' && !migrationExportValidId_(e.sourceFileId)) ||
        (i < state.nextIndex && ['done', 'error'].indexOf(e.status) < 0)) copyMigrationFail_('COPY_MANIFEST_INVALID');
    if (e.status === 'copied' || e.status === 'done') {
      if (!migrationExportValidId_(e.targetFileId) || e.targetFileId === e.sourceFileId ||
          COPY_MIGRATION_ALLOWED_MIME_[e.kind].indexOf(e.mimeType) < 0 || !Number.isInteger(e.sizeBytes) || e.sizeBytes < 1 || e.sizeBytes > 5 * 1024 * 1024 ||
          typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) copyMigrationFail_('COPY_MANIFEST_INVALID');
    } else if (e.targetFileId !== null) copyMigrationFail_('COPY_MANIFEST_INVALID');
    var name = e.kind === 'document' ? 'Arsip_Dokumen' : 'Data_Pegawai';
    var field = e.kind === 'document' ? 'File_Drive_ID' : 'Foto_Drive_ID', identity = e.kind === 'document' ? 'ID_Arsip' : 'NIP';
    e.refs.forEach(function (ref) {
      if (!ref || ref.sheet !== name || ref.header !== field || ref.identityHeader !== identity ||
          !Number.isInteger(ref.rowNumber) || ref.rowNumber < 2 || ref.rowNumber > m.data[name].length ||
          typeof ref.identity !== 'string' || !ref.identity || typeof ref.done !== 'boolean' ||
          m.data[name][ref.rowNumber - 1][headers[name].indexOf(identity)] !== ref.identity ||
          (e.sourceFileId !== null && ref.original !== e.sourceFileId)) copyMigrationFail_('COPY_MANIFEST_INVALID');
      var key = name + '|' + ref.rowNumber;
      if (covered[key]) copyMigrationFail_('COPY_MANIFEST_INVALID'); covered[key] = true; count++;
    });
  });
  if (count !== state.referenceCount || m.referenceCount !== state.referenceCount ||
      m.referenceHash !== state.referenceHash || m.dataHash !== state.dataHash ||
      copyMigrationReferenceHash_(m) !== state.referenceHash || copyMigrationDataHash_(m) !== state.dataHash) copyMigrationFail_('COPY_MANIFEST_INVALID');
}

function copyMigrationLoadOutputs_(ctx, owner) {
  var m = ctx.manifest;
  ctx.documentsFolder = DriveApp.getFolderById(m.documentsFolderId); ctx.photosFolder = DriveApp.getFolderById(m.photosFolderId);
  ctx.exportFolder = DriveApp.getFolderById(m.exportFolderId); ctx.targetFile = DriveApp.getFileById(m.targetSpreadsheetId);
  if (ctx.targetFile.getId() === m.sourceSpreadsheetId || ctx.targetFile.getMimeType() !== 'application/vnd.google-apps.spreadsheet') copyMigrationFail_('COPY_TARGET_IS_SOURCE');
  copyMigrationAssertContext_(ctx, owner); ctx.target = SpreadsheetApp.openById(m.targetSpreadsheetId);
}

function copyMigrationAssertContext_(ctx, owner) {
  migrationExportAssertPrivateAncestors_(ctx.jobFolder, owner); migrationExportAssertParent_(ctx.jobFolder, ctx.state.parentFolderId);
  [ctx.documentsFolder, ctx.photosFolder, ctx.exportFolder, ctx.targetFile, ctx.manifestFile].forEach(function (item) {
    migrationExportAssertPrivate_(item, owner); migrationExportAssertParent_(item, ctx.jobFolder.getId());
  });
}

function copyMigrationCheckAllTarget_(ctx) {
  var m = ctx.manifest, headers = migrationExportHeaders_();
  if (ctx.target.getSpreadsheetTimeZone() !== 'Asia/Makassar' || ctx.target.getSheets().length !== 4) copyMigrationFail_('COPY_TARGET_CHANGED');
  Object.keys(headers).forEach(function (name) {
    var rows = m.data[name], sheet = ctx.target.getSheetByName(name);
    if (!sheet || sheet.getLastRow() !== rows.length || sheet.getLastColumn() !== headers[name].length) copyMigrationFail_('COPY_TARGET_CHANGED');
    var range = sheet.getRange(1, 1, rows.length, headers[name].length), actual = range.getValues(), formulas = range.getFormulas();
    for (var r = 0; r < rows.length; r++) for (var c = 0; c < rows[r].length; c++) {
      if (formulas[r][c]) copyMigrationFail_('COPY_TARGET_CHANGED');
      if (!copyMigrationSame_(actual[r][c], rows[r][c])) {
        var replay = m.entries.some(function (e) { return e.status === 'copied' && e.targetFileId === actual[r][c] &&
          e.refs.some(function (ref) { return ref.sheet === name && ref.rowNumber === r + 1 && headers[name].indexOf(ref.header) === c &&
            actual[r][headers[name].indexOf(ref.identityHeader)] === ref.identity && rows[r][c] === ref.original; }); });
        if (!replay) copyMigrationFail_('COPY_TARGET_CHANGED');
      }
    }
  });
}

function copyMigrationCopyFile_(entry, ctx, owner) {
  var source = copyMigrationReadSource_(entry); if (!source) return;
  var folder = entry.kind === 'document' ? ctx.documentsFolder : ctx.photosFolder, existing = folder.getFilesByName(entry.name), copied;
  if (existing.hasNext()) {
    copied = existing.next(); if (existing.hasNext()) copyMigrationFail_('COPY_DUPLICATE_OUTPUT');
    // Adopt only the exact bytes owned by us in this job; then repair PRIVATE if
    // a previous run stopped between createFile and the privacy call.
    if (!copied.getOwner() || copied.getOwner().getEmail().toLowerCase() !== owner.toLowerCase()) copyMigrationFail_('COPY_OUTPUT_OWNER');
    migrationExportAssertParent_(copied, folder.getId());
    if (copied.getMimeType() !== source.mimeType || copied.getSize() !== source.bytes.length ||
        migrationExportSha256_(copied.getBlob().getBytes()) !== source.sha256) copyMigrationFail_('COPY_OUTPUT_FILE_CHANGED');
    migrationExportMakePrivate_(copied, owner);
  } else {
    copied = folder.createFile(Utilities.newBlob(source.bytes, source.mimeType, entry.name)); migrationExportMakePrivate_(copied, owner);
  }
  copyMigrationCheckFile_(copied, folder.getId(), source.mimeType, source.bytes.length, source.sha256, owner);
  if (copied.getId() === entry.sourceFileId) copyMigrationFail_('COPY_TARGET_IS_SOURCE');
  entry.targetFileId = copied.getId(); entry.mimeType = source.mimeType; entry.sizeBytes = source.bytes.length; entry.sha256 = source.sha256; entry.status = 'copied';
}

function copyMigrationReadSource_(entry) {
  var file;
  try { file = DriveApp.getFileById(entry.sourceFileId); } catch (_) { copyMigrationFail_('COPY_SOURCE_UNAVAILABLE_RETRY'); }
  if (file.isTrashed()) return copyMigrationEntryError_(entry, 'SOURCE_TRASHED');
  var type = file.getMimeType(), size = file.getSize();
  if (COPY_MIGRATION_ALLOWED_MIME_[entry.kind].indexOf(type) < 0) return copyMigrationEntryError_(entry, 'UNSUPPORTED_MIME');
  if (!Number.isInteger(size) || size < 1 || size > 5 * 1024 * 1024) return copyMigrationEntryError_(entry, 'SIZE_LIMIT');
  var bytes = file.getBlob().getBytes(); // Transient read errors leave the entry pending.
  if (bytes.length !== size) copyMigrationFail_('COPY_SOURCE_UNAVAILABLE_RETRY');
  if (copyMigrationDetectMime_(bytes) !== type) return copyMigrationEntryError_(entry, 'MAGIC_MISMATCH');
  return { bytes: bytes, mimeType: type, sha256: migrationExportSha256_(bytes) };
}

function copyMigrationDetectMime_(bytes) {
  var at = function (i) { return i < bytes.length ? bytes[i] & 255 : -1; };
  var match = function (offset, values) { return values.every(function (v, i) { return at(offset + i) === v; }); };
  if (match(0, [37,80,68,70,45])) return 'application/pdf';
  if (match(0, [255,216,255])) return 'image/jpeg';
  if (match(0, [137,80,78,71,13,10,26,10])) return 'image/png';
  if (match(0, [82,73,70,70]) && match(8, [87,69,66,80])) return 'image/webp';
  return null;
}

function copyMigrationEntryError_(entry, code) { entry.status = 'error'; entry.code = code; return null; }

function copyMigrationPatch_(entry, ctx, owner) {
  var headers = migrationExportHeaders_();
  entry.refs.forEach(function (ref) {
    if (ref.done) return;
    copyMigrationAssertContext_(ctx, owner);
    var sheet = ctx.target.getSheetByName(ref.sheet), cols = headers[ref.sheet], row = sheet.getRange(ref.rowNumber, 1, 1, cols.length).getValues()[0];
    if (row[cols.indexOf(ref.identityHeader)] !== ref.identity) copyMigrationFail_('COPY_ROW_IDENTITY_CHANGED');
    var cell = sheet.getRange(ref.rowNumber, cols.indexOf(ref.header) + 1), value = cell.getValue();
    if (value !== ref.original && value !== entry.targetFileId) copyMigrationFail_('COPY_REFERENCE_CHANGED');
    if (value !== entry.targetFileId) { cell.setNumberFormat('@'); cell.setValue(entry.targetFileId); SpreadsheetApp.flush();
      if (cell.getValue() !== entry.targetFileId) copyMigrationFail_('COPY_REFERENCE_WRITE_FAILED'); }
    mDataPatch_(ctx.manifest, ref, entry.targetFileId); ref.done = true;
    copyMigrationSaveManifest_(ctx, owner);
  });
}

function mDataPatch_(m, ref, value) { m.data[ref.sheet][ref.rowNumber - 1][migrationExportHeaders_()[ref.sheet].indexOf(ref.header)] = value; }

function copyMigrationCheckFile_(file, parentId, mime, size, hash, owner) {
  migrationExportAssertPrivate_(file, owner); migrationExportAssertParent_(file, parentId);
  if (file.getMimeType() !== mime || file.getSize() !== size || migrationExportSha256_(file.getBlob().getBytes()) !== hash) copyMigrationFail_('COPY_OUTPUT_FILE_CHANGED');
}

function copyMigrationFinalVerify_(ctx, owner, startedAt) {
  var m = ctx.manifest, checked = 0;
  if (m.entries.some(function (e) { return ['pending', 'copied'].indexOf(e.status) >= 0; })) return false;
  while (m.verifyIndex < m.entries.length && checked < 10 && Date.now() - startedAt < 240000) {
    var e = m.entries[m.verifyIndex];
    copyMigrationAssertContext_(ctx, owner);
    if (e.status === 'done') copyMigrationCheckFile_(DriveApp.getFileById(e.targetFileId),
      e.kind === 'document' ? m.documentsFolderId : m.photosFolderId, e.mimeType, e.sizeBytes, e.sha256, owner);
    m.verifyIndex++; checked++; copyMigrationSaveManifest_(ctx, owner);
  }
  return m.verifyIndex === m.entries.length;
}

function copyMigrationValidateReferences_(m) {
  var locations = Object.create(null), headers = migrationExportHeaders_();
  m.entries.forEach(function (e) {
    if (e.status !== 'done' || e.sourceFileId === e.targetFileId) copyMigrationFail_('COPY_REFERENCES_INCOMPLETE');
    e.refs.forEach(function (r) { if (!r.done) copyMigrationFail_('COPY_REFERENCES_INCOMPLETE'); locations[r.sheet + '|' + r.rowNumber] = e.targetFileId; });
  });
  ['Arsip_Dokumen', 'Data_Pegawai'].forEach(function (name) {
    var col = headers[name].indexOf(name === 'Arsip_Dokumen' ? 'File_Drive_ID' : 'Foto_Drive_ID');
    for (var i = 1; i < m.data[name].length; i++) {
      var v = m.data[name][i][col];
      if (v !== '' && locations[name + '|' + (i + 1)] !== v) copyMigrationFail_('COPY_REFERENCES_INCOMPLETE');
    }
  });
}

function copyMigrationSame_(actual, expected) {
  return expected && typeof expected === 'object' && typeof expected.$date === 'string'
    ? actual instanceof Date && actual.toISOString() === expected.$date
    : expected instanceof Date ? actual instanceof Date && actual.getTime() === expected.getTime() : actual === expected;
}
function copyMigrationSaveManifest_(ctx, owner) {
  copyMigrationAssertContext_(ctx, owner);
  ctx.manifestFile.setContent(migrationExportSerialize_(ctx.manifest, 8 * 1024 * 1024));
}
function copyMigrationSaveState_(properties, state) { properties.setProperty(COPY_MIGRATION_STATE_KEY_, JSON.stringify(state)); }
function copyMigrationCount_(manifest, status) { return manifest.entries.filter(function (e) { return e.status === status; }).length; }
function copyMigrationSummary_(m) {
  var updated = 0; m.entries.forEach(function (e) { e.refs.forEach(function (r) { if (r.done) updated++; }); });
  var summary = { jobId: m.jobId, phase: m.phase, sheetsCompleted: m.sheetIndex, isComplete: m.isComplete,
    sourceUnchangedByTool: true, consistent: false, copiedFileCount: m.entries.filter(function (e) { return !!e.targetFileId; }).length,
    updatedReferenceCount: updated, pendingCount: copyMigrationCount_(m, 'pending') + copyMigrationCount_(m, 'copied'),
    errorCount: copyMigrationCount_(m, 'error'), verifiedFileCount: m.verifyIndex };
  if (!summary.isComplete && !summary.pendingCount && !summary.errorCount) summary.pendingCount = Math.max(0, m.entries.length - m.verifyIndex);
  Logger.log(JSON.stringify(summary)); return summary;
}
function copyMigrationFail_(message) { var error = new Error(message); error.migrationExportSafe_ = true; throw error; }
