// Synthetic, offline-only Apps Script VM tests for CopyPrivateSource.gs. The REAL
// exporter helpers are loaded first (same standalone project). No Google/network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { syntheticFixture } from './fixture.mjs';
import { transformExport } from './transform.mjs';

const exporterSource = readFileSync(new URL('./gas/ExportForMigration.gs', import.meta.url), 'utf8');
const copierSource = readFileSync(new URL('./gas/CopyPrivateSource.gs', import.meta.url), 'utf8');
const OWNER = 'synthetic-owner@example.invalid';
const SOURCE_ID = 'src_sheet_0000001';
const PARENT_ID = 'synthetic_parent_01';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1, 2, 3];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 200];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 255];

function iterator(items) {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
}

function blob(data, mime = 'application/octet-stream', name = '') {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data || []);
  return {
    mime, name,
    getBytes: () => Int8Array.from(buffer),
    getDataAsString: () => buffer.toString('utf8'),
  };
}

function setup(options = {}) {
  let now = 1_800_000_000_000;
  class FakeDate extends Date { static now() { return now; } }
  const records = new Map();
  const spreadsheets = new Map();
  const properties = new Map([
    ['MIGRATION_COPY_SOURCE_ID', SOURCE_ID],
    ['MIGRATION_COPY_PARENT_ID', PARENT_ID],
    ['MIGRATION_COPY_CONFIRM', 'COPY_SOURCE_READ_ONLY'],
    ...Object.entries(options.properties || {}),
  ]);
  const logs = [], sourceMutations = [], makeCopyCalls = [], targetSetValue = [];
  const counts = { open: 0, create: 0, binaryCreates: 0, setContent: 0, setProperty: 0, uuid: 0, ids: 0 };
  const fail = { setContentAt: options.failSetContentAt, setPropertyAt: options.failSetPropertyAt };

  function mutation(label) { sourceMutations.push(label); throw Error('source mutation ' + label); }
  function item(id, name, parent, kind, extra = {}) {
    const record = {
      id, name, parent, kind, access: 'PRIVATE', editors: [], viewers: [], isSource: false, ...extra,
      getId() { return this.id; },
      getName() { return this.name; },
      getOwner() { return { getEmail: () => OWNER }; },
      isTrashed() { return false; },
      getSharingAccess() { return this.access; },
      getEditors() { return this.editors; },
      getViewers() { return this.viewers; },
      setSharing(access, permission) {
        if (this.isSource) mutation('setSharing');
        assert.deepEqual([access, permission], ['PRIVATE', 'NONE']);
        this.access = access;
      },
      moveTo(folder) { if (this.isSource) mutation('moveTo'); this.parent = folder.getId(); },
      makeCopy() { makeCopyCalls.push(this.id); if (this.isSource) mutation('makeCopy'); assert.fail('makeCopy is never used'); },
      setTrashed() { if (this.isSource) mutation('setTrashed'); assert.fail('No trashing'); },
      setName() { if (this.isSource) mutation('setName'); assert.fail('No renaming'); },
      getParents() { return iterator(this.parent ? [records.get(this.parent)] : []); },
      children(k) { return [...records.values()].filter((r) => r.parent === this.id && r.kind === k); },
      getFiles() { return iterator(this.children('file')); },
      getFolders() { return iterator(this.children('folder')); },
      getFilesByName(n) { return iterator(this.children('file').filter((r) => r.name === n)); },
      getFoldersByName(n) { return iterator(this.children('folder').filter((r) => r.name === n)); },
      createFolder(n) { return item(newId('out_folder'), n, this.id, 'folder'); },
      createFile(value) {
        if (/^copy-/.test(value.name)) {
          counts.binaryCreates++;
          if (options.onBinaryCreate) options.onBinaryCreate(counts.binaryCreates, (ms) => { now += ms; });
        }
        return item(newId('out_file'), value.name, this.id, 'file', { mime: value.mime, data: value });
      },
      getMimeType() { return this.mime; },
      getSize() { return this.sizeOverride ?? this.data.getBytes().length; },
      getBlob() { return this.data; },
      setContent(value) {
        if (this.isSource) mutation('setContent');
        counts.setContent++;
        if (counts.setContent === fail.setContentAt) throw Error('synthetic crash src_doc raw id');
        this.data = blob(value, 'application/json', this.name);
      },
    };
    records.set(id, record);
    return record;
  }
  function newId(prefix) { return prefix + '_' + String(++counts.ids).padStart(8, '0'); }

  const root = item('synthetic_root_001', 'My Drive', null, 'folder');
  let parentOfParent = root;
  if (options.publicAncestor) {
    parentOfParent = item('synthetic_mid_0001', 'shared mid', root.id, 'folder');
    parentOfParent.access = 'ANYONE';
  }
  item(PARENT_ID, 'empty private parent', parentOfParent.id, 'folder');
  if (options.nonEmptyParent) item('synthetic_junk_01', 'junk', PARENT_ID, 'file', { mime: 'text/plain', data: blob('x') });
  item(SOURCE_ID, 'SIKAP', root.id, 'file', { mime: SHEET_MIME, isSource: true });
  function addSourceFile(id, mime, bytes, extra = {}) {
    return item(id, 'private-original-name', root.id, 'file', { mime, data: blob(bytes, mime), isSource: true, ...extra });
  }
  addSourceFile('src_doc_p_000001', 'application/pdf', PDF);
  addSourceFile('src_doc_q_000001', 'application/pdf', PDF.concat([9]));
  addSourceFile('src_photo_shared01', 'image/jpeg', JPEG);
  addSourceFile('src_png_cross0001', 'image/png', PNG);

  const context = vm.createContext({
    Date: FakeDate, Number, Object, JSON, isFinite,
    LockService: { getScriptLock: () => ({ tryLock: () => !options.locked, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) ?? null,
      deleteProperty(key) {
        assert.ok(['MIGRATION_COPY_TARGET_ID', 'MIGRATION_COPY_EXPORT_FOLDER_ID'].includes(key));
        properties.delete(key);
      },
      setProperties(values, removeOthers) {
        assert.equal(removeOthers, false);
        for (const [key, value] of Object.entries(values)) {
          assert.ok(['MIGRATION_COPY_TARGET_ID', 'MIGRATION_COPY_EXPORT_FOLDER_ID'].includes(key));
          properties.set(key, value);
        }
      },
      setProperty(key, value) {
        assert.ok(['MIGRATION_COPY_JOB_V1', 'MIGRATION_COPY_TARGET_ID', 'MIGRATION_COPY_EXPORT_FOLDER_ID'].includes(key));
        counts.setProperty++;
        if (counts.setProperty === fail.setPropertyAt) throw Error('synthetic property crash');
        properties.set(key, value);
      },
    }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }) },
    Logger: { log: (value) => logs.push(String(value)) },
    Utilities: {
      getUuid: () => '01234567-89ab-4def-8123-' + String(++counts.uuid).padStart(12, '0'),
      newBlob: blob,
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, bytes) => [...createHash('sha256').update(Buffer.from(bytes)).digest()]
        .map((value) => (value > 127 ? value - 256 : value)),
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
      getRootFolder: () => root,
      getFolderById(id) { const r = records.get(id); if (!r || r.kind !== 'folder') throw Error('secret id'); return r; },
      getFileById(id) { const r = records.get(id); if (!r || r.kind !== 'file') throw Error('secret id'); return r; },
    },
  });
  vm.runInContext(exporterSource, context, { filename: 'ExportForMigration.gs' });
  vm.runInContext(copierSource, context, { filename: 'CopyPrivateSource.gs' });
  const headers = JSON.parse(JSON.stringify(context.migrationExportHeaders_()));

  // Synthetic source sheets (fake people only).
  const cells = Object.fromEntries(Object.entries(headers).map(([k, h]) => [k, [h.slice()]]));
  const row = (sheet, fields) => cells[sheet].push(headers[sheet].map((h) => fields[h] ?? ''));
  const employee = (nip, foto, extra = {}) => row('Data_Pegawai', {
    NIP: nip, Password_Hash: 'synthetic-hash', Role: 'User', Nama_Lengkap: 'Sintetis ' + nip.slice(-1),
    No_HP: '+62812000000' + nip.slice(-1), NIK: '730000000000000' + nip.slice(-1),
    Folder_Drive_ID: 'synthetic_prodfolder_' + nip.slice(-1), Foto_Drive_ID: foto,
    Tanggal_Lahir: new FakeDate('1990-01-0' + nip.slice(-1) + 'T00:00:00.000Z'), ...extra,
  });
  employee('199001012020011001', 'src_photo_shared01');
  employee('199001012020011002', 'src_photo_shared01');
  employee('199001012020011003', 'src_png_cross0001');
  const archive = (id, nip, file) => row('Arsip_Dokumen', {
    ID_Arsip: id, NIP: nip, ID_Dokumen: 'DOC-KTP', File_Drive_ID: file,
    File_URL: file ? 'https://drive.google.com/file/d/' + file : '', Status_Verifikasi: 'Terverifikasi',
    Waktu_Upload: new FakeDate('2025-02-01T03:04:05.000Z'),
  });
  archive('ARS-1', '199001012020011001', 'src_doc_p_000001');
  archive('ARS-2', '199001012020011002', 'src_doc_q_000001');
  archive('ARS-3', '199001012020011003', 'src_png_cross0001');
  archive('ARS-4', '199001012020011003', 'src_doc_p_000001');
  archive('ARS-5', '199001012020011001', '');
  row('Master_Dokumen', { ID_Dokumen: 'DOC-KTP', Nama_Dokumen: 'KTP', Kategori: 'Identitas', Status_Wajib: 'Ya' });
  row('Log_Aktivitas', { Log_ID: 'LOG-1', Timestamp: new FakeDate('2025-03-01T00:00:00.000Z'),
    Actor_NIP: '199001012020011001', Description: '+62 nomor @catatan -tes', Result: true });
  if (options.mutate) options.mutate({ cells, headers, row, addSourceFile, records, FakeDate });
  spreadsheets.set(SOURCE_ID, { isSource: true, timezone: 'Asia/Makassar', sheets: new Map(Object.entries(cells)) });

  function cloneCell(v) { return v instanceof Date ? new FakeDate(v.getTime()) : v; }
  function sheetApi(id, name) {
    const book = spreadsheets.get(id);
    const write = (label) => { if (book.isSource) mutation(label); };
    const api = {
      getName: () => name,
      setName(next) { write('setName'); const grid = book.sheets.get(name); book.sheets.delete(name); book.sheets.set(next, grid); return sheetApi(id, next); },
      getMaxRows: () => 100000,
      getMaxColumns: () => 26,
      insertRowsAfter() { write('insertRowsAfter'); return this; },
      insertColumnsAfter() { write('insertColumnsAfter'); return this; },
      getLastRow: () => book.sheets.get(name).length,
      getLastColumn: () => (book.sheets.get(name)[0] || []).length,
      getRange(r, c, nr = 1, nc = 1) {
        const grid = book.sheets.get(name);
        const read = () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc },
          (_, j) => cloneCell((grid[r - 1 + i] || [])[c - 1 + j] ?? '')));
        const put = (vals) => vals.forEach((vr, i) => vr.forEach((v, j) => {
          while (grid.length < r + i) grid.push([]);
          grid[r - 1 + i][c - 1 + j] = cloneCell(v);
        }));
        return {
          getValues: read,
          getDisplayValues: () => read().map((row) => row.map((value) => value instanceof Date ? value.toISOString() : String(value ?? ''))),
          getValue: () => read()[0][0],
          getFormulas: () => read().map((vr) => vr.map(() => '')),
          setNumberFormat() { write('setNumberFormat'); },
          setNumberFormats() { write('setNumberFormats'); },
          setValues(vals) { write('setValues'); put(vals); },
          setValue(v) { write('setValue'); targetSetValue.push({ name, r, c, v }); put([[v]]); },
        };
      },
    };
    return api;
  }
  function bookApi(id) {
    const book = spreadsheets.get(id);
    const write = (label) => { if (book.isSource) mutation(label); };
    return {
      getId: () => id,
      getSpreadsheetTimeZone: () => book.timezone,
      setSpreadsheetTimeZone(tz) { write('setSpreadsheetTimeZone'); book.timezone = tz; },
      getSheetByName: (name) => (book.sheets.has(name) ? sheetApi(id, name) : null),
      getSheets: () => [...book.sheets.keys()].map((name) => sheetApi(id, name)),
      insertSheet(name) { write('insertSheet'); book.sheets.set(name, []); return sheetApi(id, name); },
      deleteSheet(sheet) { write('deleteSheet'); book.sheets.delete(sheet.getName()); },
    };
  }
  context.SpreadsheetApp = {
    openById(id) { counts.open++; if (!spreadsheets.has(id)) throw Error('secret id'); return bookApi(id); },
    create(name) {
      counts.create++;
      const id = newId('out_sheet');
      item(id, name, root.id, 'file', { mime: SHEET_MIME });
      spreadsheets.set(id, { isSource: false, timezone: 'Etc/GMT', sheets: new Map([['Sheet1', []]]) });
      return bookApi(id);
    },
    flush() {},
  };

  const state = () => JSON.parse(properties.get('MIGRATION_COPY_JOB_V1'));
  const manifest = () => JSON.parse(records.get(state().manifestFileId).data.getDataAsString());
  const writeManifest = (m) => { records.get(state().manifestFileId).data = blob(JSON.stringify(m), 'application/json'); };
  const target = () => spreadsheets.get(manifest().targetSpreadsheetId);
  const targetCell = (sheet, rowNumber, header) => target().sheets.get(sheet)[rowNumber - 1][headers[sheet].indexOf(header)];
  return {
    context, records, properties, logs, sourceMutations, makeCopyCalls, targetSetValue, counts, cells, headers,
    state, manifest, writeManifest, target, targetCell, spreadsheets,
    seeded: Object.keys(options.properties || {}),
    run: () => context.copyPrivateMigrationSource_(),
    advance: (ms) => { now += ms; },
  };
}

function assertSourceUntouched(env) {
  assert.deepEqual(env.sourceMutations, [], 'source never receives a write/sharing/move/copy call');
  assert.deepEqual(env.makeCopyCalls, [], 'makeCopy is never called on any item');
  for (const id of ['src_doc_p_000001', 'src_doc_q_000001', 'src_photo_shared01', 'src_png_cross0001', SOURCE_ID]) {
    const r = env.records.get(id);
    if (!r) continue;
    assert.equal(r.access, 'PRIVATE');
    assert.equal(r.parent, 'synthetic_root_001');
  }
  // setProperty is allowlisted to COPY keys in the mock; seeded refusal cases excepted.
  for (const key of ['MIGRATION_SOURCE_READONLY', 'MIGRATION_SPREADSHEET_ID', 'MIGRATION_EXPORT_FOLDER_ID']) {
    if (!env.seeded.includes(key)) assert.ok(!env.properties.has(key));
  }
}

function assertNoSensitiveLogs(env) {
  const text = env.logs.join('\n');
  assert.doesNotMatch(text, /src_|out_|synthetic_|1990010120200110|ARS-|sha|private-original/);
}

test('actual v2 copy feeds exporter and offline transformer without protocol drift', () => {
  const fx = syntheticFixture();
  const env = setup({ mutate({ cells, addSourceFile }) {
    for (const [name, data] of Object.entries(fx.snapshot.sheets)) {
      cells[name] = [data.headers.slice(), ...data.rows.map((row) => row.values.slice())];
    }
    for (const file of fx.files) addSourceFile(file.fileId, file.mimeType, file.bytes);
  } });
  assert.equal(env.run().isComplete, true);
  env.properties.set('MIGRATION_SPREADSHEET_ID', env.properties.get('MIGRATION_COPY_TARGET_ID'));
  env.properties.set('MIGRATION_EXPORT_FOLDER_ID', env.properties.get('MIGRATION_COPY_EXPORT_FOLDER_ID'));
  env.properties.set('MIGRATION_SOURCE_READONLY', 'true');
  const oldProps = env.context.PropertiesService.getScriptProperties();
  env.context.PropertiesService.getScriptProperties = () => ({ ...oldProps,
    setProperty(key, value) {
      if (key === 'MIGRATION_EXPORT_JOB_V1') env.properties.set(key, value);
      else oldProps.setProperty(key, value);
    },
  });
  let exported;
  for (let i = 0; i < 10; i++) { exported = env.context.exportForMigration_(); if (exported.isComplete) break; }
  assert.equal(exported.isComplete, true);
  const checkpoint = JSON.parse(env.properties.get('MIGRATION_EXPORT_JOB_V1'));
  const snapshot = JSON.parse(env.records.get(checkpoint.manifestFileId).getBlob().getDataAsString());
  const plan = transformExport(snapshot, { pepper: 'synthetic-v2-copier-test-only', salt: Buffer.alloc(32, 31) });
  assert.equal(plan.ready, true, JSON.stringify(plan.diagnostics.filter((d) => d.severity === 'error')));
  assert.equal(plan.expected.pegawai, 3);
  assert.equal(plan.expected.arsip, 2);
  assert.equal(plan.files.length, 3);
  assert.deepEqual(env.sourceMutations, []);
});

test('large initialization resumes from a durable checkpoint before any binary copying', () => {
  const env = setup({ mutate({ cells }) {
    const template = cells.Log_Aktivitas[1];
    for (let i = 0; i < 1100; i++) cells.Log_Aktivitas.push([`synthetic-log-${i}`, ...template.slice(1)]);
  } });
  const first = env.run();
  assert.equal(first.phase, 'initializing');
  assert.equal(first.isComplete, false);
  assert.ok(env.properties.has('MIGRATION_COPY_JOB_V1'));
  assert.equal(env.counts.binaryCreates, 0);
  let result = first;
  for (let i = 0; i < 20 && !result.isComplete; i++) result = env.run();
  assert.equal(result.isComplete, true);
  assert.equal(env.target().sheets.get('Log_Aktivitas').length, env.cells.Log_Aktivitas.length);
  assertSourceUntouched(env);
});

test('numeric identities and wrong source timezone stop before creating output', () => {
  const env = setup({ mutate({ cells }) { cells.Data_Pegawai[1][0] = 199001012020011000; } });
  assert.throws(() => env.run(), /COPY_NUMERIC_IDENTITY/);
  assert.equal(env.counts.create, 0);
  const other = setup();
  other.spreadsheets.get(SOURCE_ID).timezone = 'America/New_York';
  assert.throws(() => other.run(), /COPY_SOURCE_TIMEZONE/);
  assert.equal(other.counts.create, 0);
});

test('empty mappings, wrong reference fields, forged done and non-reference edits cannot complete', () => {
  for (const damage of [
    (m) => { m.entries = []; },
    (m) => { m.entries[0].refs[0].header = 'NIP'; },
    (m) => { m.entries[1].status = 'done'; },
    (m) => { m.data.Data_Pegawai[1][2] = 'Admin'; },
  ]) {
    const env = setup({ onBinaryCreate: (n, advance) => { if (n === 1) advance(300000); } });
    assert.equal(env.run().isComplete, false);
    const m = env.manifest(); damage(m); env.writeManifest(m);
    assert.throws(() => env.run(), /COPY_MANIFEST_INVALID/);
    assert.equal(env.properties.has('MIGRATION_COPY_TARGET_ID'), false);
    assertSourceUntouched(env);
  }
});

test('temporary source lookup errors stay pending and can be retried', () => {
  const env = setup();
  const original = env.context.DriveApp.getFileById;
  let failed = false;
  env.context.DriveApp.getFileById = (id) => {
    if (id === 'src_doc_p_000001' && !failed) { failed = true; throw Error('sensitive transient provider error'); }
    return original(id);
  };
  assert.throws(() => env.run(), /COPY_SOURCE_UNAVAILABLE_RETRY/);
  assert.equal(env.manifest().entries[0].status, 'pending');
  assert.equal(env.run().isComplete, true);
  assertSourceUntouched(env);
  assertNoSensitiveLogs(env);
});

test('normal: 3 employees complete, references remapped, source untouched, private outputs', () => {
  const env = setup();
  const summary = env.run();
  assert.equal(summary.isComplete, true);
  assert.equal(summary.copiedFileCount, 6);
  assert.equal(summary.updatedReferenceCount, 7);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.pendingCount, 0);
  assert.equal(summary.sourceUnchangedByTool, true);
  assert.equal(summary.consistent, false);
  assertSourceUntouched(env);
  assertNoSensitiveLogs(env);
  const m = env.manifest();
  assert.equal(env.properties.get('MIGRATION_COPY_TARGET_ID'), m.targetSpreadsheetId);
  assert.equal(env.properties.get('MIGRATION_COPY_EXPORT_FOLDER_ID'), m.exportFolderId);
  assert.notEqual(m.targetSpreadsheetId, SOURCE_ID);
  const book = env.target();
  assert.deepEqual([...book.sheets.keys()].sort(), Object.keys(env.headers).sort());
  assert.equal(book.timezone, 'Asia/Makassar');
  const targetFile = env.records.get(m.targetSpreadsheetId);
  assert.equal(targetFile.parent, m.jobFolderId);
  assert.equal(targetFile.access, 'PRIVATE');
  // Every non-reference, non-cleaned cell is identical (text NIP/NIK/phone, dates, booleans).
  for (const [name, grid] of Object.entries(env.cells)) {
    const out = book.sheets.get(name);
    grid.forEach((r, i) => r.forEach((v, j) => {
      const h = env.headers[name][j];
      if (i > 0 && ['File_Drive_ID', 'Foto_Drive_ID', 'File_URL', 'Folder_Drive_ID'].includes(h)) return;
      if (v instanceof Date) assert.equal(out[i][j].getTime(), v.getTime());
      else assert.equal(out[i][j], v);
    }));
  }
  for (let r = 2; r <= 6; r++) assert.equal(env.targetCell('Arsip_Dokumen', r, 'File_URL'), '');
  for (let r = 2; r <= 4; r++) assert.equal(env.targetCell('Data_Pegawai', r, 'Folder_Drive_ID'), '');
  const ids = m.entries.map((e) => e.targetFileId);
  assert.equal(new Set(ids).size, 6);
  for (const e of m.entries) {
    const f = env.records.get(e.targetFileId);
    assert.equal(f.access, 'PRIVATE');
    assert.equal(f.parent, e.kind === 'document' ? m.documentsFolderId : m.photosFolderId);
    assert.match(f.name, /^copy-(document|photo)-\d+$/);
    for (const ref of e.refs) assert.equal(env.targetCell(ref.sheet, ref.rowNumber, ref.header), e.targetFileId);
  }
  assert.equal(env.targetCell('Arsip_Dokumen', 2, 'File_Drive_ID'), env.targetCell('Arsip_Dokumen', 5, 'File_Drive_ID'));
  assert.equal(env.targetCell('Arsip_Dokumen', 6, 'File_Drive_ID'), '', 'blank stays blank');
  // Source sheet values are byte-for-byte unchanged.
  assert.equal(env.spreadsheets.get(SOURCE_ID).sheets.get('Arsip_Dokumen')[1][3], 'src_doc_p_000001');
});

test('same photo used by 2 employees gets distinct owner-scoped copies', () => {
  const env = setup();
  env.run();
  const a = env.targetCell('Data_Pegawai', 2, 'Foto_Drive_ID');
  const b = env.targetCell('Data_Pegawai', 3, 'Foto_Drive_ID');
  assert.notEqual(a, b);
  assert.notEqual(a, 'src_photo_shared01');
  const ea = env.records.get(a), eb = env.records.get(b);
  assert.deepEqual(Buffer.from(ea.data.getBytes()), Buffer.from(eb.data.getBytes()));
  assertSourceUntouched(env);
});

test('same file referenced as document and photo gets distinct per-kind copies', () => {
  const env = setup();
  env.run();
  const doc = env.targetCell('Arsip_Dokumen', 4, 'File_Drive_ID');
  const photo = env.targetCell('Data_Pegawai', 4, 'Foto_Drive_ID');
  assert.notEqual(doc, photo);
  const m = env.manifest();
  assert.equal(env.records.get(doc).parent, m.documentsFolderId);
  assert.equal(env.records.get(photo).parent, m.photosFolderId);
  assertSourceUntouched(env);
});

test('resume after crash between createFile and manifest adopts the verified copy without duplicates', () => {
  const env = setup({ failSetContentAt: 1 });
  assert.throws(() => env.run(), /COPY_SYSTEM_ERROR/);
  assert.equal(env.manifest().entries[0].status, 'pending');
  const summary = env.run();
  assert.equal(summary.isComplete, true);
  const m = env.manifest();
  const docs = [...env.records.values()].filter((r) => r.parent === m.documentsFolderId && r.name === 'copy-document-0');
  assert.equal(docs.length, 1, 'no duplicate copy');
  assert.equal(m.entries[0].targetFileId, docs[0].id);
  assertSourceUntouched(env);
});

test('crash after cell patch (before manifest or cursor) is idempotent', () => {
  for (const option of [{ failSetContentAt: 7 }, { failSetPropertyAt: 2 }]) {
    const env = setup(option);
    assert.throws(() => env.run(), /COPY_SYSTEM_ERROR/);
    assert.ok(env.targetSetValue.length >= 1);
    const summary = env.run();
    assert.equal(summary.isComplete, true);
    const ars1 = env.targetSetValue.filter((w) => w.name === 'Arsip_Dokumen' && w.r === 2);
    assert.equal(ars1.length, 1, 'cell patched exactly once');
    assert.equal(summary.updatedReferenceCount, 7);
    assertSourceUntouched(env);
  }
});

test('malformed, missing, unsupported, spoofed and oversized refs: originals kept, never complete', () => {
  const env = setup({ mutate({ cells, headers, addSourceFile }) {
    const col = (s, h) => headers[s].indexOf(h);
    addSourceFile('src_html_0000001', 'text/html', Buffer.from('<html>x</html>'));
    addSourceFile('src_fakepdf00001', 'application/pdf', PNG);
    addSourceFile('src_big_00000001', 'application/pdf', PDF, { sizeOverride: 6 * 1024 * 1024 });
    addSourceFile('src_svg_00000001', 'image/svg+xml', Buffer.from('<svg/>'));
    cells.Arsip_Dokumen[1][col('Arsip_Dokumen', 'File_Drive_ID')] = 'src_fakepdf00001';
    cells.Arsip_Dokumen[2][col('Arsip_Dokumen', 'File_Drive_ID')] = 'bad id!';
    addSourceFile('src_missing_00001', 'application/pdf', PDF).isTrashed = () => true;
    cells.Arsip_Dokumen[3][col('Arsip_Dokumen', 'File_Drive_ID')] = 'src_missing_00001';
    cells.Arsip_Dokumen[4][col('Arsip_Dokumen', 'File_Drive_ID')] = 'src_html_0000001';
    cells.Arsip_Dokumen[5][col('Arsip_Dokumen', 'File_Drive_ID')] = 'src_big_00000001';
    cells.Data_Pegawai[3][col('Data_Pegawai', 'Foto_Drive_ID')] = 'src_svg_00000001';
  } });
  const summary = env.run();
  assert.equal(summary.isComplete, false);
  assert.equal(summary.errorCount, 6);
  const codes = env.manifest().entries.filter((e) => e.status === 'error').map((e) => e.code).sort();
  assert.deepEqual(codes, ['MAGIC_MISMATCH', 'INVALID_REFERENCE', 'SOURCE_TRASHED', 'UNSUPPORTED_MIME', 'UNSUPPORTED_MIME', 'SIZE_LIMIT'].sort());
  assert.equal(env.targetCell('Arsip_Dokumen', 2, 'File_Drive_ID'), 'src_fakepdf00001');
  assert.equal(env.targetCell('Arsip_Dokumen', 3, 'File_Drive_ID'), 'bad id!');
  assert.equal(env.targetCell('Arsip_Dokumen', 4, 'File_Drive_ID'), 'src_missing_00001');
  assert.equal(env.targetCell('Arsip_Dokumen', 5, 'File_Drive_ID'), 'src_html_0000001');
  assert.equal(env.targetCell('Arsip_Dokumen', 6, 'File_Drive_ID'), 'src_big_00000001');
  assert.equal(env.targetCell('Data_Pegawai', 4, 'Foto_Drive_ID'), 'src_svg_00000001');
  assert.notEqual(env.targetCell('Data_Pegawai', 2, 'Foto_Drive_ID'), 'src_photo_shared01');
  assert.ok(!env.properties.has('MIGRATION_COPY_TARGET_ID'));
  assert.equal(env.run().isComplete, false, 'rerun never forgives errors');
  assertSourceUntouched(env);
  assertNoSensitiveLogs(env);
});

test('public ancestor, foreign config, bad confirm, non-empty parent refuse before any output', () => {
  const cases = [
    [{ publicAncestor: true }, /private/],
    [{ properties: { MIGRATION_EXPORT_FOLDER_ID: 'synthetic_exp_0001' } }, /COPY_FRESH_PROJECT_REQUIRED/],
    [{ properties: { MIGRATION_SANDBOX_V1: '{}' } }, /COPY_FRESH_PROJECT_REQUIRED/],
    [{ properties: { MIGRATION_COPY_CONFIRM: 'yes' } }, /COPY_CONFIG_INVALID/],
    [{ nonEmptyParent: true }, /COPY_PARENT_NOT_EMPTY/],
    [{ locked: true }, /COPY_BUSY/],
  ];
  for (const [option, pattern] of cases) {
    const env = setup(option);
    const before = env.records.size;
    assert.throws(() => env.run(), pattern);
    assert.equal(env.counts.open, 0);
    assert.equal(env.counts.create, 0);
    assert.equal(env.records.size, before);
    assert.ok(!env.properties.has('MIGRATION_COPY_JOB_V1'));
    assertSourceUntouched(env);
  }
});

test('formula-like or apostrophe text fails closed before creating any output', () => {
  for (const text of ['=HYPERLINK("x")', "'0812"]) {
    const env = setup({ mutate({ cells, headers }) {
      cells.Log_Aktivitas[1][headers.Log_Aktivitas.indexOf('Description')] = text;
    } });
    const before = env.records.size;
    assert.throws(() => env.run(), /COPY_LITERAL_UNSUPPORTED/);
    assert.equal(env.counts.create, 0);
    assert.equal(env.records.size, before);
    assertSourceUntouched(env);
  }
});

test('tampered source/parent binding or manifest target IDs are refused', () => {
  const env = setup();
  env.run();
  env.properties.set('MIGRATION_COPY_SOURCE_ID', 'src_other_0000001');
  assert.throws(() => env.run(), /COPY_CHECKPOINT_MISMATCH/);
  env.properties.set('MIGRATION_COPY_SOURCE_ID', SOURCE_ID);
  const original = env.manifest();
  env.writeManifest({ ...original, targetSpreadsheetId: SOURCE_ID });
  assert.throws(() => env.run(), /COPY_MANIFEST_INVALID/);
  const entries = original.entries.map((e, i) => (i === 0 ? { ...e, targetFileId: e.sourceFileId } : e));
  env.writeManifest({ ...original, entries });
  assert.throws(() => env.run(), /COPY_MANIFEST_INVALID/);
  env.writeManifest(original);
  assert.equal(env.run().isComplete, true);
  assertSourceUntouched(env);
});

test('changed target row identity fails closed without patching the wrong row', () => {
  const env = setup({ onBinaryCreate: (n, advance) => { if (n === 1) advance(300000); } });
  const first = env.run();
  assert.equal(first.isComplete, false);
  assert.equal(env.state().nextIndex, 1);
  env.target().sheets.get('Arsip_Dokumen')[2][env.headers.Arsip_Dokumen.indexOf('ID_Arsip')] = 'ARS-MOVED';
  const writes = env.targetSetValue.length;
  assert.throws(() => env.run(), /COPY_TARGET_CHANGED/);
  assert.equal(env.targetSetValue.length, writes);
  assert.equal(env.targetCell('Arsip_Dokumen', 3, 'File_Drive_ID'), 'src_doc_q_000001');
  assert.equal(env.manifest().entries[1].status, 'pending', 'whole-target validation stops before reading another source file');
  assertSourceUntouched(env);
});

test('changed target reference value (CAS) halts instead of overwriting', () => {
  const env = setup({ onBinaryCreate: (n, advance) => { if (n === 1) advance(300000); } });
  env.run();
  env.target().sheets.get('Arsip_Dokumen')[2][env.headers.Arsip_Dokumen.indexOf('File_Drive_ID')] = 'src_edited_00001';
  assert.throws(() => env.run(), /COPY_TARGET_CHANGED/);
  assert.equal(env.targetCell('Arsip_Dokumen', 3, 'File_Drive_ID'), 'src_edited_00001');
});

test('failed completed-job recheck revokes result properties before checking the target', () => {
  for (const damage of [
    (env) => { env.target().sheets.get('Data_Pegawai')[1][env.headers.Data_Pegawai.indexOf('Nama_Lengkap')] = 'changed'; },
    (env) => { env.records.delete(env.state().manifestFileId); },
    (env) => { env.records.get(env.manifest().entries[0].targetFileId).sizeOverride = 0; },
  ]) {
    const env = setup(); assert.equal(env.run().isComplete, true);
    assert.ok(env.properties.has('MIGRATION_COPY_TARGET_ID'));
    damage(env);
    assert.throws(() => env.run());
    assert.equal(env.properties.has('MIGRATION_COPY_TARGET_ID'), false);
    assert.equal(env.properties.has('MIGRATION_COPY_EXPORT_FOLDER_ID'), false);
    assertSourceUntouched(env);
  }
});

test('more than ten files require bounded copy and verification runs', () => {
  const env = setup({ mutate({ cells, addSourceFile }) {
    const template = cells.Arsip_Dokumen[1];
    for (let i = 0; i < 12; i++) {
      const id = `source_extra_file_${String(i).padStart(4, '0')}`;
      addSourceFile(id, 'application/pdf', PDF);
      const row = template.slice(); row[0] = `EXTRA-${i}`; row[3] = id;
      cells.Arsip_Dokumen.push(row);
    }
  } });
  let summary = env.run();
  assert.equal(summary.isComplete, false);
  assert.equal(env.counts.binaryCreates, 10);
  assert.equal(env.properties.has('MIGRATION_COPY_TARGET_ID'), false);
  for (let i = 0; i < 20 && !summary.isComplete; i++) summary = env.run();
  assert.equal(summary.isComplete, true);
  assert.equal(summary.copiedFileCount, 18);
  const repeat = env.run();
  assert.equal(repeat.isComplete, false, 'completed jobs rehash in bounded windows');
  assert.equal(env.properties.has('MIGRATION_COPY_TARGET_ID'), false);
  assert.equal(env.run().isComplete, true);
  assertSourceUntouched(env);
});

test('millisecond dates round-trip unchanged and initialization rejects manual edits', () => {
  const env = setup({ mutate({ cells, FakeDate }) {
    cells.Log_Aktivitas[1][1] = new FakeDate('2025-03-01T00:00:00.123Z');
    const row = cells.Log_Aktivitas[1];
    for (let i = 0; i < 1100; i++) cells.Log_Aktivitas.push([`ms-${i}`, ...row.slice(1)]);
  } });
  assert.equal(env.run().phase, 'initializing');
  const m = env.manifest();
  const target = env.spreadsheets.get(m.targetSpreadsheetId);
  const written = target.sheets.get('Log_Aktivitas');
  assert.equal(written[1][1].getTime(), new Date('2025-03-01T00:00:00.123Z').getTime());
  // A cell in the next unwritten chunk must stay blank or match the capture.
  while (written.length < 601) written.push([]);
  written[600][0] = 'unrelated manual entry';
  assert.throws(() => env.run(), /COPY_TARGET_CHANGED/);
  assert.equal(env.properties.has('MIGRATION_COPY_TARGET_ID'), false);
  assertSourceUntouched(env);
});

test('repeated runs after completion re-verify outputs instead of blind success', () => {
  const env = setup();
  env.run();
  const creates = env.counts.binaryCreates;
  assert.equal(env.run().isComplete, true);
  assert.equal(env.counts.binaryCreates, creates, 'no new copies');
  const m = env.manifest();
  const photo = env.records.get(m.entries[3].targetFileId);
  photo.access = 'ANYONE';
  assert.throws(() => env.run(), /private/);
  photo.access = 'PRIVATE';
  photo.data = blob(JPEG.concat([1]), 'image/jpeg');
  assert.throws(() => env.run(), /COPY_OUTPUT_FILE_CHANGED/);
  photo.data = blob(JPEG, 'image/jpeg');
  env.target().sheets.get('Data_Pegawai')[1][env.headers.Data_Pegawai.indexOf('Foto_Drive_ID')] = 'src_photo_shared01';
  assert.throws(() => env.run(), /COPY_TARGET_CHANGED/);
  assertSourceUntouched(env);
});
