// Synthetic, offline-only Apps Script VM tests for CreateSyntheticSandbox.gs.
// No Google services, network, Drive or production data are used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';
import { transformExport } from './transform.mjs';

const sandboxSource = readFileSync(new URL('./gas/CreateSyntheticSandbox.gs', import.meta.url), 'utf8');
const exporterSource = readFileSync(new URL('./gas/ExportForMigration.gs', import.meta.url), 'utf8');
const OWNER = 'synthetic-owner@example.invalid';
const PARENT = 'synthetic_parent_12345';
const SOURCE_KEYS = ['MIGRATION_SPREADSHEET_ID', 'MIGRATION_EXPORT_FOLDER_ID', 'MIGRATION_SOURCE_READONLY'];
const ALLOWED_KEYS = [...SOURCE_KEYS, 'MIGRATION_EXPORT_JOB_V1', 'MIGRATION_SANDBOX_V1', 'MIGRATION_SANDBOX_PARENT_ID'];
const transformOptions = { pepper: 'synthetic-test-pepper', salt: Buffer.alloc(32, 7) };
const plain = (value) => JSON.parse(JSON.stringify(value));
const sha = (value) => createHash('sha256').update(value).digest('hex');

function iterator(items) {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
}

function toBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  return Buffer.from(Array.from(data || [], (b) => b & 255));
}

function blob(data, mime = 'application/octet-stream', name = '') {
  const buffer = toBuffer(data);
  return {
    name, mime,
    getBytes: () => Int8Array.from(buffer),
    getDataAsString: () => buffer.toString('utf8'),
  };
}

function witaDisplay(date, format) {
  const wita = new Date(date.getTime() + 8 * 3600 * 1000).toISOString();
  return format === 'yyyy-mm-dd' ? wita.slice(0, 10) : wita.slice(0, 19).replace('T', ' ');
}

function setup(options = {}) {
  const records = new Map();
  const properties = new Map(Object.entries(options.properties || { MIGRATION_SANDBOX_PARENT_ID: PARENT }));
  const logs = [], events = [], propertyWrites = [], sharingCalls = [];
  let counter = 0, createFileCalls = 0, uuid = 0;
  const sheetsById = new Map();

  function item(id, name, parent, init = {}) {
    const record = {
      id, name, parent, access: 'PRIVATE', editors: [], viewers: [], owner: OWNER, trashed: false,
      isFolder: !init.data && !init.spreadsheet, data: init.data, isPreexisting: !!init.isPreexisting,
      getId() { return this.id; },
      getName() { return this.name; },
      getOwner() { return this.owner ? { getEmail: () => this.owner } : null; },
      isTrashed() { return this.trashed; },
      getSharingAccess() { return this.access; },
      getEditors() { return this.editors; },
      getViewers() { return this.viewers; },
      setSharing(access, permission) {
        assert.equal(this.isPreexisting, false, 'Pre-existing items are never re-shared');
        assert.equal(access, 'PRIVATE');
        assert.equal(permission, 'NONE');
        sharingCalls.push(this.id);
        this.access = access;
      },
      getParents() { return iterator(this.parent ? [records.get(this.parent)] : []); },
      getFiles() { return iterator([...records.values()].filter((r) => r.parent === this.id && !r.isFolder)); },
      getFolders() { return iterator([...records.values()].filter((r) => r.parent === this.id && r.isFolder)); },
      getFilesByName(n) {
        return iterator([...records.values()].filter((r) => r.parent === this.id && !r.isFolder && r.name === n));
      },
      getFoldersByName(n) {
        return iterator([...records.values()].filter((r) => r.parent === this.id && r.isFolder && r.name === n));
      },
      createFolder(n) {
        assert.ok(this.isFolder);
        events.push('create-folder');
        return item('created_folder_' + String(++counter).padStart(8, '0'), n, this.id);
      },
      createFile(value) {
        createFileCalls++;
        if (options.failCreateFileAt === createFileCalls) throw Error('secret drive quota detail ' + this.id);
        events.push('create-file');
        return item('created_file_' + String(++counter).padStart(8, '0'), value.name, this.id, { data: value });
      },
      moveTo(folder) {
        assert.equal(this.isPreexisting, false);
        if (options.failMove) throw Error('secret move failure ' + this.id);
        this.parent = folder.getId();
      },
      getMimeType() { return this.data.mime; },
      getSize() { return this.data.getBytes().length; },
      getBlob() { return this.data; },
      setContent(value) { this.data = blob(value, 'application/json', this.name); },
      setTrashed() { assert.fail('Nothing may be trashed'); },
    };
    records.set(id, record);
    return record;
  }

  item('synthetic_mydrive_root', 'My Drive', null, { isPreexisting: true });
  // Private ancestor chain: My Drive > ancestor > parent. sharedAncestor makes
  // only the intermediate ancestor visible to another account.
  const ancestor = item('synthetic_ancestor_12345', 'operator folder', 'synthetic_mydrive_root', { isPreexisting: true });
  if (options.sharedAncestor) ancestor.editors = [{ getEmail: () => 'other@example.invalid' }];
  if (!options.noParent) {
    const parent = item(PARENT, 'operator private parent', ancestor.id, { isPreexisting: true });
    if (options.sharedParent) parent.viewers = [{ getEmail: () => 'other@example.invalid' }];
    if (options.publicParent) parent.access = 'ANYONE_WITH_LINK';
    if (options.sharedDriveParent) parent.owner = null;
    if (options.nonEmptyParent) item('preexisting_file_12345', 'keep', PARENT, { data: blob('x'), isPreexisting: true });
  }

  function makeSheet(name) {
    const sheet = {
      name, cells: [], formats: {},
      setName(n) { this.name = n; },
      getName() { return this.name; },
      getLastRow() { return this.cells.length; },
      getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); },
      getRange(r, c, nr, nc) {
        const s = this;
        return {
          setNumberFormat(format) {
            for (let col = c; col < c + nc; col++) s.formats[col] = format;
            events.push(`format:${s.name}:${c}`);
          },
          setValues(values) {
            assert.equal(values.length, nr);
            events.push(`values:${s.name}`);
            values.forEach((row, i) => {
              assert.equal(row.length, nc);
              s.cells[r - 1 + i] = s.cells[r - 1 + i] || [];
              row.forEach((value, j) => {
                const format = s.formats[c + j];
                // Simulate Sheets auto-conversion: digit strings become (lossy) numbers
                // unless the column is plain text '@'.
                const stored = typeof value === 'string' && /^\d+$/.test(value) && format !== '@'
                  ? Number(value) : value;
                s.cells[r - 1 + i][c - 1 + j] = stored;
              });
            });
          },
          getValues() {
            return s.cells.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc));
          },
          getDisplayValues() {
            return s.cells.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)
              .map((v, j) => v instanceof Date ? witaDisplay(v, s.formats[c + j]) : String(v ?? '')));
          },
        };
      },
    };
    return sheet;
  }

  const context = vm.createContext({
    Date, Number, Object, JSON, isFinite, Array,
    LockService: { getScriptLock: () => ({ tryLock: () => !options.locked, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) {
        assert.ok(ALLOWED_KEYS.includes(key), 'Only allowlisted properties are read');
        return properties.get(key) ?? null;
      },
      setProperty(key, value) {
        assert.equal(key, 'MIGRATION_EXPORT_JOB_V1', 'Only the exporter sets single properties');
        propertyWrites.push(key);
        properties.set(key, value);
      },
      setProperties(values, deleteAllOthers) {
        assert.equal(deleteAllOthers, false);
        events.push('set-properties');
        for (const [key, value] of Object.entries(values)) {
          assert.ok(ALLOWED_KEYS.includes(key));
          propertyWrites.push(key);
          properties.set(key, value);
        }
      },
    }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }) },
    Logger: { log: (value) => logs.push(String(value)) },
    Utilities: {
      getUuid: () => `0123456${++uuid}-89ab-4def-8123-0123456789ab`,
      newBlob: blob,
      base64Decode: (text) => Array.from(Buffer.from(text, 'base64'), (b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'UTF-8' },
      computeDigest: (_, value) => [...createHash('sha256').update(toBuffer(value)).digest()]
        .map((b) => (b > 127 ? b - 256 : b)),
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
      getRootFolder: () => records.get('synthetic_mydrive_root'),
      getFolderById(id) {
        const record = records.get(id);
        if (!record || !record.isFolder) throw Error('secret folder id ' + id);
        return record;
      },
      getFileById(id) {
        const record = records.get(id);
        if (!record || record.isFolder) throw Error('secret file id ' + id);
        return record;
      },
    },
    SpreadsheetApp: {
      create(name) {
        const id = 'created_sheet_' + String(++counter).padStart(8, '0');
        item(id, name, 'synthetic_mydrive_root', { spreadsheet: true, data: blob('', 'application/vnd.google-apps.spreadsheet') });
        const book = {
          timezone: 'Etc/UTC', sheets: [makeSheet('Sheet1')],
          getId: () => id,
          getSheets() { return this.sheets.slice(); },
          insertSheet(n) { const s = makeSheet(n); this.sheets.push(s); return s; },
          getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; },
          setSpreadsheetTimeZone(tz) { this.timezone = tz; },
          getSpreadsheetTimeZone() { return this.timezone; },
        };
        sheetsById.set(id, book);
        return book;
      },
      openById(id) {
        const book = sheetsById.get(id);
        if (!book) throw Error('secret spreadsheet id');
        return book;
      },
      flush() {},
    },
  });
  if (!options.noExporter) vm.runInContext(exporterSource, context, { filename: 'ExportForMigration.gs' });
  vm.runInContext(sandboxSource, context, { filename: 'CreateSyntheticSandbox.gs' });
  return {
    context, records, properties, logs, events, propertyWrites, sharingCalls, sheetsById,
    create() { return plain(context.createMigrationSandbox_()); },
    exportRun() { return plain(context.exportForMigration_()); },
    marker() { return JSON.parse(properties.get('MIGRATION_SANDBOX_V1')); },
    book() { return sheetsById.get(this.marker().spreadsheetId); },
    manifest() {
      const record = [...records.values()].find((r) => r.name === 'snapshot.sikap-export.json');
      return record && JSON.parse(record.data.getDataAsString());
    },
  };
}

function pngChunksValid(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  let offset = 8;
  const types = [];
  let idat = Buffer.alloc(0);
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    assert.equal(buffer.readUInt32BE(offset + 8 + length), crc(Buffer.concat([type, data])), 'PNG chunk CRC');
    types.push(type.toString('latin1'));
    if (types.at(-1) === 'IDAT') idat = Buffer.concat([idat, data]);
    offset += 12 + length;
  }
  assert.equal(offset, buffer.length);
  assert.equal(types[0], 'IHDR');
  assert.equal(types.at(-1), 'IEND');
  assert.ok(inflateSync(idat).length > 0);
}

function fileBytes(env, id) { return Buffer.from(env.records.get(id).data.getBytes()); }

const MINIMAL_EXPORTER = `
function exportForMigration_() {}
function migrationExportConfig_() {}
function migrationExportAssertPrivate_() {}
function migrationExportValidId_(v) { return typeof v === 'string'; }
function migrationExportFail_(m) { throw new Error(m); }
function migrationExportAssertPrivateAncestors_() {}
`;

test('All function declarations are private trailing underscore, no endpoints/triggers/enumeration', () => {
  const code = sandboxSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const names = [...code.matchAll(/function\s+([\w$]+)\s*\(/g)].map((m) => m[1]);
  assert.ok(names.length > 15);
  assert.ok(names.every((name) => name.endsWith('_')), names.filter((n) => !n.endsWith('_')).join());
  assert.ok(names.includes('createMigrationSandbox_'));
  assert.ok(!/doGet|doPost|UrlFetchApp|ScriptApp|newTrigger|getProperties\s*\(|setTrashed|deleteProperty|deleteAllProperties|addEditor|addViewer|exportForMigration_\s*\(/
    .test(code));
  const idLike = [...code.matchAll(/'([A-Za-z0-9_-]{20,})'/g)].map((m) => m[1])
    .filter((value) => !/^(MIGRATION_[A-Z0-9_]+|sikap-synthetic-rehearsal-|synthetic-[a-z-]+)$/.test(value));
  assert.deepEqual(idLike, [], 'No hardcoded Drive-like/production IDs');
});

test('Refuses before creating anything: missing exporter, parent or lock, unsafe parent', () => {
  for (const options of [
    { noExporter: true }, { noParent: true }, { locked: true }, { sharedParent: true },
    { publicParent: true }, { sharedDriveParent: true }, { nonEmptyParent: true }, { sharedAncestor: true },
    { properties: {} }, { properties: { MIGRATION_SANDBOX_PARENT_ID: '../bad' } },
  ]) {
    const env = setup(options);
    const before = env.records.size;
    assert.throws(() => env.create(), JSON.stringify(options));
    assert.equal(env.records.size, before);
    assert.equal(env.propertyWrites.length, 0);
    assert.equal(env.sharingCalls.length, 0);
  }
  const partial = setup({ noExporter: true });
  vm.runInContext('function exportForMigration_() {}', partial.context);
  assert.throws(() => partial.create(), /ExportForMigration\.gs/);
});

test('Pre-existing export configuration or checkpoint without marker is refused and never cleared', () => {
  for (const key of [...SOURCE_KEYS, 'MIGRATION_EXPORT_JOB_V1']) {
    const original = key === 'MIGRATION_SOURCE_READONLY' ? 'false' : 'production_like_value_123';
    const env = setup({ properties: { MIGRATION_SANDBOX_PARENT_ID: PARENT, [key]: original } });
    const before = env.records.size;
    assert.throws(() => env.create(), key === 'MIGRATION_EXPORT_JOB_V1' ? /checkpoint/ : /without a sandbox marker/);
    assert.equal(env.records.size, before, 'Nothing created');
    assert.equal(env.properties.get(key), original, 'Never overwritten or cleared');
    assert.equal(env.propertyWrites.length, 0);
  }
});

test('Creates private synthetic sandbox: 4 sheets, plaintext identities, fixtures, properties last', () => {
  const env = setup();
  const summary = env.create();
  assert.equal(summary.created, true);
  assert.equal(summary.contentVerified, true);
  assert.equal(summary.exportStarted, false);
  assert.deepEqual([summary.employeeCount, summary.documentCount, summary.fileCount, summary.sheetCount],
    [3, 2, 3, 4]);
  assert.equal(env.manifest(), undefined, 'Export never runs automatically');
  assert.equal(env.events.at(-1), 'set-properties', 'Properties are written only after everything else');
  assert.deepEqual(env.propertyWrites.sort(), [...SOURCE_KEYS, 'MIGRATION_SANDBOX_V1'].sort());
  assert.equal(env.properties.get('MIGRATION_SOURCE_READONLY'), 'true');
  const marker = env.marker();
  assert.equal(env.properties.get('MIGRATION_SPREADSHEET_ID'), marker.spreadsheetId);
  assert.equal(env.properties.get('MIGRATION_EXPORT_FOLDER_ID'), marker.exportFolderId);

  const root = env.records.get(marker.rootFolderId);
  assert.equal(root.parent, PARENT);
  assert.match(root.name, /^sikap-synthetic-rehearsal-[0-9a-f-]{36}$/);
  const created = [...env.records.values()].filter((r) => !r.isPreexisting);
  assert.equal(created.length, 7);
  for (const record of created) {
    assert.equal(record.access, 'PRIVATE');
    assert.ok(env.sharingCalls.includes(record.id), 'Every new artifact explicitly made private');
  }
  const spreadsheetFile = env.records.get(marker.spreadsheetId);
  assert.equal(spreadsheetFile.parent, root.id, 'Spreadsheet moved out of My Drive root');
  assert.match(spreadsheetFile.name, /SYNTHETIC/);
  assert.equal(env.records.get(marker.exportFolderId).parent, root.id);
  const ids = [marker.spreadsheetId, ...marker.documentFileIds, marker.photoFileId];
  assert.equal(new Set(ids).size, ids.length, 'Photo and document IDs are distinct');

  const book = env.book();
  assert.equal(book.getSpreadsheetTimeZone(), 'Asia/Makassar');
  const headers = plain(env.context.migrationExportHeaders_());
  assert.deepEqual(book.sheets.map((s) => s.name), Object.keys(headers));
  const pegawai = book.getSheetByName('Data_Pegawai');
  assert.equal(headers.Data_Pegawai.length, 25);
  assert.deepEqual(plain(pegawai.cells[0]), headers.Data_Pegawai);
  assert.equal(pegawai.cells.length, 4);
  const formatIndex = env.events.indexOf('format:Data_Pegawai:1');
  const nikIndex = env.events.indexOf('format:Data_Pegawai:14');
  const valuesIndex = env.events.indexOf('values:Data_Pegawai');
  assert.ok(formatIndex >= 0 && nikIndex >= 0 && formatIndex < valuesIndex && nikIndex < valuesIndex);
  assert.equal(pegawai.formats[1], '@');
  assert.equal(pegawai.formats[14], '@');
  const nip = headers.Data_Pegawai.indexOf('NIP');
  const nik = headers.Data_Pegawai.indexOf('NIK');
  const hash = headers.Data_Pegawai.indexOf('Password_Hash');
  const name = headers.Data_Pegawai.indexOf('Nama_Lengkap');
  const role = headers.Data_Pegawai.indexOf('Role');
  const status = headers.Data_Pegawai.indexOf('Status_Kepegawaian');
  const lahir = headers.Data_Pegawai.indexOf('Tanggal_Lahir');
  const foto = headers.Data_Pegawai.indexOf('Foto_Drive_ID');
  const kelamin = headers.Data_Pegawai.indexOf('Jenis_Kelamin');
  assert.deepEqual(pegawai.cells.slice(1).map((r) => r[nip]),
    ['199001012020011001', '199002022021022002', '199003032022032003']);
  assert.deepEqual(pegawai.cells.slice(1).map((r) => [r[lahir].toISOString(), r[kelamin]]), [
    ['1989-12-31T16:00:00.000Z', 'Laki-laki'],
    ['1990-02-01T16:00:00.000Z', 'Perempuan'],
    ['1990-03-02T16:00:00.000Z', 'Perempuan'],
  ], 'WITA midnight birth dates and gender match each NIP');
  for (const row of pegawai.cells.slice(1)) {
    assert.equal(typeof row[nip], 'string');
    // yyyymmdd birth + yyyymm appointment + gender 1|2 + 3-digit sequence.
    assert.match(row[nip], /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(19|20)\d{2}(0[1-9]|1[0-2])[12]\d{3}$/);
    assert.equal(witaDisplay(row[lahir], 'yyyy-mm-dd').replace(/-/g, ''), row[nip].slice(0, 8));
    assert.equal(row[kelamin], row[nip][14] === '1' ? 'Laki-laki' : 'Perempuan');
    assert.match(row[nik], /^[0-9]{16}$/);
    assert.equal(row[hash], sha(row[nip].slice(-6)));
    assert.match(row[name], /^SINTETIS /);
  }
  assert.deepEqual(pegawai.cells.slice(1).map((r) => [r[role], r[status]]),
    [['Admin', 'PNS'], ['Pegawai', 'PNS'], ['Pegawai', 'P3K']]);
  assert.equal(pegawai.cells[2][foto], marker.photoFileId);
  assert.equal(book.getSheetByName('Master_Dokumen').cells.length, 12, '11 seed document types');
  const arsip = book.getSheetByName('Arsip_Dokumen').cells;
  assert.deepEqual(plain(arsip.slice(1).map((r) => [r[1], r[2], r[3], r[5]])), [
    [pegawai.cells[2][nip], 'DOC-KTP', marker.documentFileIds[0], 'Terverifikasi'],
    [pegawai.cells[3][nip], 'DOC-KK', marker.documentFileIds[1], 'Ditolak'],
  ]);
  assert.ok(arsip[1][7] instanceof Date && arsip[1][8] instanceof Date);
  assert.equal(book.getSheetByName('Log_Aktivitas').cells.length, 2);

  const pdf = fileBytes(env, marker.documentFileIds[0]).toString('latin1');
  assert.equal(env.records.get(marker.documentFileIds[0]).getMimeType(), 'application/pdf');
  assert.ok(pdf.startsWith('%PDF-1.4\n') && pdf.endsWith('%%EOF\n'));
  const xref = Number(/startxref\n(\d+)\n/.exec(pdf)[1]);
  assert.ok(pdf.startsWith('xref\n', xref));
  const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((offset, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, offset)));
  for (const id of [marker.documentFileIds[1], marker.photoFileId]) {
    assert.equal(env.records.get(id).getMimeType(), 'image/png');
    pngChunksValid(fileBytes(env, id));
  }
  assert.notEqual(sha(fileBytes(env, marker.documentFileIds[1])), sha(fileBytes(env, marker.photoFileId)));

  const logText = env.logs.join('\n');
  assert.ok(!/SINTETIS|created_|synthetic_parent|@example/.test(logText), 'Logs contain counts only');
});

test('Repeat run is idempotent and re-verifies privacy without creating or writing', () => {
  const env = setup();
  env.create();
  const size = env.records.size, writes = env.propertyWrites.length;
  const again = env.create();
  assert.equal(again.created, false);
  assert.equal(again.alreadyCreated, true);
  assert.equal(again.contentVerified, false, 'Rerun does not claim content verification');
  assert.equal(again.exportStarted, false);
  assert.equal(again.employeeCount, undefined, 'No hardcoded counts on rerun');
  assert.equal(env.records.size, size);
  assert.equal(env.propertyWrites.length, writes);
  const ancestor = env.records.get('synthetic_ancestor_12345');
  ancestor.viewers = [{ getEmail: () => 'other@example.invalid' }];
  assert.throws(() => env.create(), /private/, 'Rerun re-verifies the ancestor chain');
  ancestor.viewers = [];
  env.records.get(PARENT).access = 'ANYONE_WITH_LINK';
  assert.throws(() => env.create(), /private/, 'Rerun re-verifies the parent');
  env.records.get(PARENT).access = 'PRIVATE';
  assert.equal(env.create().created, false);
  env.records.get(env.marker().photoFileId).editors = [{ getEmail: () => 'other@example.invalid' }];
  assert.throws(() => env.create(), /private/);
  env.records.get(env.marker().photoFileId).editors = [];
  env.properties.set('MIGRATION_SPREADSHEET_ID', 'foreign_sheet_123456');
  assert.throws(() => env.create(), /does not match the sandbox marker/);
  assert.equal(env.properties.get('MIGRATION_SPREADSHEET_ID'), 'foreign_sheet_123456');
  env.properties.set('MIGRATION_SANDBOX_V1', '{"version":1}');
  assert.throws(() => env.create(), /marker is invalid/);
});

test('Partial failure is sanitized, writes no properties and deletes nothing', () => {
  const env = setup({ failCreateFileAt: 2 });
  assert.throws(() => env.create(), (error) => {
    assert.match(error.message, /Synthetic sandbox creation stopped/);
    assert.ok(!/secret|created_|synthetic_parent/.test(error.message));
    return true;
  });
  assert.equal(env.propertyWrites.length, 0);
  assert.equal(env.properties.has('MIGRATION_SPREADSHEET_ID'), false);
  const partialRoot = [...env.records.values()].find((r) => r.name.startsWith('sikap-synthetic-rehearsal-'));
  assert.ok(partialRoot, 'Partial folder left for operator inspection');
  assert.ok([...env.records.values()].every((r) => !r.trashed));
  assert.throws(() => env.create(), /EMPTY folder/, 'Retry requires a new empty parent; no reuse of partial');

  const move = setup({ failMove: true });
  assert.throws(() => move.create(), (error) => {
    assert.match(error.message, /My Drive root/);
    assert.ok(!/secret|created_/.test(error.message));
    return true;
  });
  const stranded = [...move.records.values()].find((r) => /SYNTHETIC/.test(r.name));
  assert.equal(stranded.parent, 'synthetic_mydrive_root', 'Unmoved spreadsheet is left, not deleted');
  assert.equal(move.propertyWrites.length, 0);
  assert.ok([...move.records.values()].every((r) => !r.trashed));
});

test('Real exporter runs end-to-end on the sandbox and transformExport accepts the snapshot', () => {
  const env = setup();
  env.create();
  const result = env.exportRun();
  assert.equal(result.isComplete, true);
  assert.equal(result.availableCount, 3);
  assert.equal(result.invalidCount + result.missingCount + result.pendingCount, 0);
  const snapshot = env.manifest();
  assert.equal(snapshot.readOnlyDeclared, true);
  const pegawai = snapshot.sheets.Data_Pegawai;
  const nip = pegawai.headers.indexOf('NIP');
  assert.ok(pegawai.rows.every((row) => typeof row.values[nip] === 'string' && row.values[nip].length === 18));
  const kinds = Object.fromEntries(snapshot.fileManifest.map((f) => [f.fileId, f.kind]));
  assert.equal(kinds[env.marker().photoFileId], 'photo');
  assert.ok(env.marker().documentFileIds.every((id) => kinds[id] === 'document'));
  const plan = transformExport(snapshot, transformOptions);
  assert.equal(plan.ready, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.expected.pegawai, 3);
  assert.equal(plan.expected.arsip, 2);
  assert.equal(plan.expected.files, 3);

  const job = env.properties.get('MIGRATION_EXPORT_JOB_V1');
  const size = env.records.size;
  const rerun = env.create();
  assert.equal(rerun.created, false);
  assert.equal(rerun.exportStarted, true);
  assert.equal(rerun.contentVerified, false);
  assert.equal(env.properties.get('MIGRATION_EXPORT_JOB_V1'), job, 'Completed checkpoint untouched');
  assert.equal(env.records.size, size);
});

test('Minimal exporter stub lacking headers is refused', () => {
  const env = setup({ noExporter: true });
  vm.runInContext(MINIMAL_EXPORTER, env.context);
  assert.throws(() => env.create(), /ExportForMigration\.gs/);
  assert.equal(env.propertyWrites.length, 0);
});
