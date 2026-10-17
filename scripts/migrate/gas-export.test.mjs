// Synthetic, offline-only Apps Script VM tests. No Google services or network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { syntheticFixture } from './fixture.mjs';
import { transformExport } from './transform.mjs';

const source = readFileSync(new URL('./gas/ExportForMigration.gs', import.meta.url), 'utf8');
const OWNER = 'synthetic-owner@example.invalid';
const BASE_RECORDS = 2; // synthetic My Drive root + configured output folder
const EXPORT_KEYS = [
  'format', 'version', 'snapshotId', 'createdAt', 'sourceTimezone', 'consistent',
  'readOnlyDeclared', 'isComplete', 'finishedAt', 'sheets', 'fileManifest',
].sort();
const transformOptions = { pepper: 'synthetic-test-pepper', salt: Buffer.alloc(32, 7) };

function iterator(items) {
  let i = 0;
  return { hasNext: () => i < items.length, next: () => items[i++] };
}

function blob(data, mime = 'application/octet-stream', name = '') {
  const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data || []);
  return {
    name, mime,
    getBytes: () => Int8Array.from(buffer),
    getDataAsString: () => buffer.toString('utf8'),
  };
}

function setup(options = {}) {
  const records = new Map();
  const properties = new Map([
    ['MIGRATION_SPREADSHEET_ID', 'synthetic_sheet_12345'],
    ['MIGRATION_EXPORT_FOLDER_ID', 'synthetic_output_12345'],
    ['MIGRATION_SOURCE_READONLY', options.readonly || 'true'],
    ['UNRELATED_SECRET', 'never-export-this-secret'],
  ]);
  const logs = [], events = [], filenames = [], sourceIds = [], contentWriteSizes = [];
  let counter = 0, opened = 0, sourceReads = 0, propertyWrites = 0, failPropertyWrite = null;
  let bulkReads = 0, rangeReads = 0, driveCalls = 0;
  function item(id, name, parent, data, isSource = false) {
    const record = {
      id, name, parent, data, isSource, access: 'PRIVATE', editors: [], viewers: [],
      getId() { return this.id; },
      getName() { return this.name; },
      getOwner() { return { getEmail: () => OWNER }; },
      isTrashed() { return false; },
      getSharingAccess() { return this.access; },
      getEditors() { return this.editors; },
      getViewers() { return this.viewers; },
      setSharing(access, permission) {
        assert.equal(this.isSource, false, 'Source sharing never changes');
        assert.equal(access, 'PRIVATE');
        assert.equal(permission, 'NONE');
        this.access = access;
      },
      getParents() { return iterator(this.parent ? [records.get(this.parent)] : []); },
      getFilesByName(name) {
        return iterator([...records.values()].filter((r) => r.parent === this.id && r.data && r.name === name));
      },
      getFoldersByName(name) {
        return iterator([...records.values()].filter((r) => r.parent === this.id && !r.data && r.name === name));
      },
      createFolder(name) {
        return item('output_folder_' + (++counter).toString().padStart(8, '0'), name, this.id);
      },
      createFile(value) {
        events.push(value.name === 'snapshot.sikap-export.json' ? 'manifest-created' : 'binary-created');
        filenames.push(value.name);
        return item('output_file_' + (++counter).toString().padStart(8, '0'), value.name, this.id, value);
      },
      getMimeType() { return this.data.mime; },
      getSize() { return this.sizeOverride ?? this.data.getBytes().length; },
      getBlob() {
        this.blobReads = (this.blobReads || 0) + 1;
        if (this.isSource) { sourceReads++; events.push('source-file-read'); }
        return this.data;
      },
      setContent(value) {
        assert.equal(this.isSource, false);
        const bytes = Buffer.byteLength(value, 'utf8');
        contentWriteSizes.push(bytes);
        assert.ok(bytes <= 8 * 1024 * 1024, 'setContent must never receive more than 8 MiB');
        this.data = blob(value, 'application/json', this.name);
      },
      setTrashed() { assert.fail('Neither sources nor existing output may be trashed'); },
    };
    records.set(id, record);
    return record;
  }
  // Bounded synthetic ancestry: My Drive root, then the configured output folder.
  const root = item('synthetic_root_12345', 'My Drive', null);
  const output = item('synthetic_output_12345', 'private output', root.id);
  if (options.publicOutput) output.access = 'ANYONE';
  if (options.sharedOutput) output.editors = [{ getEmail: () => 'other@example.invalid' }];
  const context = vm.createContext({
    Date, Number, Object, JSON, isFinite,
    LockService: { getScriptLock: () => ({ tryLock: () => !options.locked, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty(key) {
        assert.ok([
          'MIGRATION_SPREADSHEET_ID', 'MIGRATION_EXPORT_FOLDER_ID',
          'MIGRATION_SOURCE_READONLY', 'MIGRATION_EXPORT_JOB_V1',
        ].includes(key));
        return properties.get(key) ?? null;
      },
      setProperty(key, value) {
        assert.equal(key, 'MIGRATION_EXPORT_JOB_V1');
        propertyWrites++;
        if (propertyWrites === failPropertyWrite) throw Error('synthetic secret raw Drive ID');
        properties.set(key, value);
      },
    }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }) },
    Logger: { log: (value) => logs.push(value) },
    Utilities: {
      getUuid: () => '01234567-89ab-4def-8123-0123456789ab',
      newBlob: blob,
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, bytes) => [...createHash('sha256').update(Buffer.from(bytes)).digest()]
        .map((value) => value > 127 ? value - 256 : value),
    },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
      getRootFolder() { driveCalls++; return root; },
      getFolderById(id) {
        driveCalls++;
        const record = records.get(id);
        if (!record || record.data) throw Error('secret folder id');
        return record;
      },
      getFileById(id) {
        driveCalls++;
        const record = records.get(id);
        if (!record || !record.data) throw Error('secret name or file ID');
        return record;
      },
    },
  });
  vm.runInContext(source, context, { filename: 'ExportForMigration.gs' });
  const headers = JSON.parse(JSON.stringify(context.migrationExportHeaders_()));
  const cells = Object.fromEntries(Object.entries(headers).map(([key, names]) => [key, [names.slice()]]));
  function row(name, fields) {
    cells[name].push(headers[name].map((header) => fields[header] ?? ''));
  }
  function addFile(id, mime = 'application/pdf', bytes = [0, 127, -128, -1]) {
    const record = item(id, 'synthetic-private-filename', null, blob(bytes, mime), true);
    sourceIds.push(id);
    return record;
  }
  context.SpreadsheetApp = { openById(id) {
    assert.equal(id, 'synthetic_sheet_12345');
    opened++;
    return {
      getSpreadsheetTimeZone: () => options.timezone || 'Asia/Makassar',
      getSheetByName(name) {
        assert.ok(Object.hasOwn(headers, name), 'Only four allowlisted sheets');
        if (options.missingSheet === name) return null;
        const values = cells[name];
        return {
          getLastRow: () => options.lastRows?.[name] ?? values.length,
          getLastColumn: () => values[0].length,
          getRange(r, c, nr, nc) {
            rangeReads++;
            assert.deepEqual([r, c, nr, nc], [1, 1, values.length, headers[name].length]);
            return {
              getValues() { bulkReads++; return values; },
              getDisplayValues() {
                bulkReads++;
                return values.map((a) => a.map((value) =>
                  value instanceof Date ? '16/10/2026' : String(value ?? '')));
              },
            };
          },
        };
      },
    };
  } };
  return {
    context, root, output, item, records, properties, logs, events, filenames, sourceIds, cells, headers, row, addFile,
    contentWriteSizes,
    failNextStateWriteAfter(n) { failPropertyWrite = propertyWrites + n; },
    get opened() { return opened; },
    get sourceReads() { return sourceReads; },
    get bulkReads() { return bulkReads; },
    get rangeReads() { return rangeReads; },
    get driveCalls() { return driveCalls; },
    manifest() {
      const record = [...records.values()].find((r) => r.name === 'snapshot.sikap-export.json');
      return record && JSON.parse(record.data.getDataAsString());
    },
    run() { return JSON.parse(JSON.stringify(context.exportForMigration_())); },
  };
}

function loadFixture(env) {
  const fixture = syntheticFixture();
  for (const [name, sheet] of Object.entries(fixture.snapshot.sheets)) {
    assert.deepEqual(sheet.headers, env.headers[name]);
    for (const row of sheet.rows) {
      env.cells[name].push(row.values.map((value) =>
        value && typeof value === 'object' && '$date' in value ? new Date(value.$date) : value));
    }
  }
  for (const file of fixture.files) env.addFile(file.fileId, file.mimeType, file.bytes);
  return fixture;
}

function transformSnapshot(env) {
  const snapshot = env.manifest();
  assert.deepEqual(Object.keys(snapshot).sort(), EXPORT_KEYS);
  assert.equal(Object.hasOwn(snapshot, 'issues'), false);
  return transformExport(snapshot, transformOptions);
}

test('All executable function declarations are private trailing underscore', () => {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const names = [...withoutComments.matchAll(/function\s+([\w$]+)\s*\(/g)].map((m) => m[1]);
  assert.ok(names.length > 10);
  assert.ok(names.every((name) => name.endsWith('_')));
  assert.ok(names.includes('exportForMigration_'));
  assert.ok(!/UrlFetchApp|doGet\s*\(|doPost\s*\(|getProperties\s*\(/.test(withoutComments));
});

test('Batch checkpoint/resume preserves typed cells, dates and exact signed-byte SHA', () => {
  const env = setup();
  for (let i = 0; i < 23; i++) {
    const id = 'synthetic_doc_' + String(i).padStart(8, '0');
    env.addFile(id);
    env.row('Arsip_Dokumen', { ID_Arsip: 'a' + i, File_Drive_ID: id });
  }
  env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_doc_00000000' });
  env.addFile('synthetic_photo_12345', 'image/png');
  env.row('Data_Pegawai', {
    NIP: Number('199003152015022003'), Nama_Lengkap: 'private synthetic name',
    Foto_Drive_ID: 'synthetic_photo_12345', Tanggal_Lahir: new Date('2026-10-16T00:00:00Z'),
  });
  const first = env.run();
  assert.equal(first.isComplete, false);
  assert.equal(first.processedCount, 20);
  assert.equal(first.pendingCount, 4);
  assert.deepEqual(Object.keys(env.manifest()).sort(), EXPORT_KEYS);
  assert.equal(env.opened, 1);
  assert.equal(env.sourceReads, 20);
  assert.ok(env.events.indexOf('manifest-created') < env.events.indexOf('source-file-read'));
  const second = env.run();
  assert.equal(second.isComplete, true);
  assert.equal(second.availableCount, 24);
  assert.equal(env.opened, 1, 'Resume never rereads sheets');
  const final = env.manifest();
  assert.deepEqual(Object.keys(final).sort(), EXPORT_KEYS);
  assert.deepEqual(Object.keys(final.sheets).sort(), Object.keys(env.headers).sort());
  assert.equal(final.version, 1);
  assert.equal(final.format, 'sikap-gas-export');
  assert.equal(final.consistent, false);
  assert.equal(final.readOnlyDeclared, true);
  assert.ok(final.createdAt.endsWith('Z'));
  assert.ok(final.finishedAt.endsWith('Z'));
  const pegawai = final.sheets.Data_Pegawai.rows[0];
  assert.equal(pegawai.rowNumber, 2);
  assert.equal(typeof pegawai.values[0], 'number');
  assert.deepEqual(pegawai.values[15], { $date: '2026-10-16T00:00:00.000Z' });
  assert.equal(pegawai.displayValues[15], '16/10/2026');
  const hash = createHash('sha256').update(Buffer.from([0, 127, 128, 255])).digest('hex');
  assert.ok(final.fileManifest.every((entry) => entry.sha256 === hash));
  assert.equal(final.fileManifest.length, 24);
  assert.equal(env.run().processedCount, 0, 'Completed job is idempotent');
  const state = JSON.parse(env.properties.get('MIGRATION_EXPORT_JOB_V1'));
  assert.deepEqual(Object.keys(state).sort(), [
    'manifestFileId', 'nextFileIndex', 'outputFolderId', 'snapshotFolderId', 'sourceSpreadsheetId',
  ]);
  assert.equal(state.sourceSpreadsheetId, 'synthetic_sheet_12345');
  assert.equal(state.outputFolderId, 'synthetic_output_12345');
  assert.ok(!JSON.stringify(final).includes('synthetic_sheet_12345'), 'Envelope never carries source ID');
  assert.ok(!JSON.stringify(state).includes('private synthetic name'));
  assert.ok(!JSON.stringify(final).includes('never-export-this-secret'));
  assert.ok(!env.logs.join('\n').includes(hash));
  assert.ok(env.sourceIds.every((id) => !env.logs.join('\n').includes(id)));
  assert.ok(!env.logs.join('\n').includes('private synthetic name'));
});

test('Missing, oversize, native and malformed files retain missing/invalid manifest rows', () => {
  const env = setup({ readonly: 'false' });
  env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_missing_12345' });
  env.addFile('synthetic_oversize_12345').sizeOverride = 5 * 1024 * 1024 + 1;
  env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_oversize_12345' });
  env.addFile('synthetic_native_12345', 'application/vnd.google-apps.document');
  env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_native_12345' });
  env.row('Arsip_Dokumen', { File_Drive_ID: '../not-safe' });
  const result = env.run();
  assert.equal(result.isComplete, true);
  assert.equal(result.missingCount, 1);
  assert.equal(result.invalidCount, 3);
  const final = env.manifest();
  assert.equal(final.readOnlyDeclared, false);
  assert.equal(final.consistent, false);
  assert.ok(env.logs.some((log) => log.startsWith('Dry-run warning')));
  assert.ok(final.fileManifest.every((entry) => entry.status !== 'pending'));
  assert.deepEqual(Object.keys(final).sort(), EXPORT_KEYS);
  assert.equal(final.fileManifest.find((entry) => entry.fileId === '../not-safe').status, 'invalid');
  assert.ok(!JSON.stringify(final).includes('secret name or file ID'));
});

test('Public/shared output, absent config and missing headers stop before any export', () => {
  for (const options of [{ publicOutput: true }, { sharedOutput: true }, { readonly: 'TRUE' }, { locked: true }]) {
    const env = setup(options);
    assert.throws(() => env.run());
    assert.equal(env.opened, 0);
    assert.equal(env.records.size, BASE_RECORDS);
  }
  const env = setup();
  env.properties.delete('MIGRATION_SPREADSHEET_ID');
  assert.throws(() => env.run());
  assert.equal(env.opened, 0);
  for (const mutate of [
    (bad) => { bad.cells.Data_Pegawai[0][0] = 'secret bad header value'; },
    (bad) => { bad.cells.Data_Pegawai[0].pop(); },
  ]) {
    const bad = setup();
    mutate(bad);
    assert.throws(() => bad.run(), /Canonical header (mismatch|width mismatch): Data_Pegawai/);
    assert.equal(bad.manifest(), undefined);
    assert.equal(bad.records.size, BASE_RECORDS);
    assert.equal(bad.properties.has('MIGRATION_EXPORT_JOB_V1'), false);
  }
  const missing = setup({ missingSheet: 'Master_Dokumen' });
  assert.throws(() => missing.run(), /Required sheet missing: Master_Dokumen/);
  assert.equal(missing.records.size, BASE_RECORDS);
  const timezone = setup({ timezone: 'Etc/UTC' });
  assert.throws(() => timezone.run(), /timezone/);
});

test('Manifest-first recovery tolerates a failed post-file checkpoint write', () => {
  const env = setup();
  env.addFile('synthetic_doc_12345');
  env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_doc_12345' });
  env.failNextStateWriteAfter(2);
  assert.throws(() => env.run(), /Migration export stopped/);
  assert.equal(env.manifest().fileManifest[0].status, 'available');
  assert.equal(JSON.parse(env.properties.get('MIGRATION_EXPORT_JOB_V1')).nextFileIndex, 0);
  assert.equal(env.run().isComplete, true);
  assert.equal(env.sourceReads, 1);
  assert.equal(env.opened, 1);
  assert.equal(env.filenames.filter((name) => name.endsWith('.bin')).length, 1);
});

test('Read-only declaration cannot promote a dry-run snapshot during resume', () => {
  const env = setup({ readonly: 'false' });
  for (let i = 0; i < 21; i++) {
    const id = 'synthetic_doc_' + String(i).padStart(8, '0');
    env.addFile(id);
    env.row('Arsip_Dokumen', { File_Drive_ID: id });
  }
  env.run();
  env.properties.set('MIGRATION_SOURCE_READONLY', 'true');
  assert.throws(() => env.run(), /Read-only declaration changed/);
  assert.equal(env.manifest().readOnlyDeclared, false);
});

test('Resume rejects privacy/parent changes, pending completion and extra envelope fields', () => {
  const env = setup();
  env.run();
  const state = JSON.parse(env.properties.get('MIGRATION_EXPORT_JOB_V1'));
  const snapshotFolder = env.records.get(state.snapshotFolderId);
  snapshotFolder.access = 'ANYONE';
  assert.throws(() => env.run(), /Output must be private/);
  snapshotFolder.access = 'PRIVATE';
  snapshotFolder.parent = null;
  assert.throws(() => env.run(), /outside/);
  snapshotFolder.parent = env.output.id;
  const file = env.records.get(state.manifestFileId);
  const original = env.manifest();
  file.setContent(JSON.stringify({ ...original, issues: [] }));
  assert.throws(() => env.run(), /Snapshot envelope fields are invalid/);
  file.setContent(JSON.stringify({ ...original, fileManifest: [
    { fileId: 'synthetic_doc_12345', kind: 'document', status: 'pending' },
  ] }));
  assert.throws(() => env.run(), /manifest or checkpoint/);
});

test('Changed source/output or unbound checkpoint fails before any read, write or progress', () => {
  function pendingEnv() {
    const env = setup();
    for (let i = 0; i < 21; i++) {
      const id = 'synthetic_doc_' + String(i).padStart(8, '0');
      env.addFile(id);
      env.row('Arsip_Dokumen', { File_Drive_ID: id });
    }
    assert.equal(env.run().isComplete, false);
    return env;
  }
  function completedEnv() {
    const env = setup();
    env.addFile('synthetic_doc_12345');
    env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_doc_12345' });
    assert.equal(env.run().isComplete, true);
    return env;
  }
  const mutations = [
    (env) => env.properties.set('MIGRATION_SPREADSHEET_ID', 'synthetic_other_sheet_12345'),
    (env) => env.properties.set('MIGRATION_EXPORT_FOLDER_ID', 'synthetic_other_output_12345'),
    (env) => {
      const legacy = JSON.parse(env.properties.get('MIGRATION_EXPORT_JOB_V1'));
      delete legacy.sourceSpreadsheetId;
      delete legacy.outputFolderId;
      env.properties.set('MIGRATION_EXPORT_JOB_V1', JSON.stringify(legacy));
    },
  ];
  for (const make of [pendingEnv, completedEnv]) {
    for (const mutate of mutations) {
      const env = make();
      mutate(env);
      const rawState = env.properties.get('MIGRATION_EXPORT_JOB_V1');
      const manifestBefore = JSON.stringify(env.manifest());
      const counts = [env.opened, env.sourceReads, env.bulkReads, env.records.size,
        env.contentWriteSizes.length, env.filenames.length];
      env.context.DriveApp.getFolderById = () => assert.fail('No Drive access on mismatch');
      env.context.DriveApp.getRootFolder = () => assert.fail('No Drive access on mismatch');
      env.context.DriveApp.getFileById = () => assert.fail('No Drive access on mismatch');
      assert.throws(() => env.run(), (error) => {
        assert.match(error.message, /^CHECKPOINT_SOURCE_MISMATCH/);
        assert.ok(!/synthetic_(other_)?(sheet|output)/.test(error.message), 'No IDs in errors');
        return true;
      });
      assert.deepEqual([env.opened, env.sourceReads, env.bulkReads, env.records.size,
        env.contentWriteSizes.length, env.filenames.length], counts);
      assert.equal(env.properties.get('MIGRATION_EXPORT_JOB_V1'), rawState, 'Never overridden/deleted');
      assert.equal(JSON.stringify(env.manifest()), manifestBefore);
      assert.deepEqual(Object.keys(env.manifest()).sort(), EXPORT_KEYS);
    }
  }
});

test('Shared/unowned ancestor, multiple parents, cycle, non-root top and depth fail before writes', () => {
  const cases = {
    sharedAncestor(env) {
      const parent = env.item('synthetic_parent_12345', 'private parent', env.root.id);
      const shared = env.item('synthetic_shared_anc_12345', 'shared ancestor', env.root.id);
      shared.access = 'ANYONE_WITH_LINK';
      parent.parent = shared.id;
      env.output.parent = parent.id;
    },
    editorAncestor(env) {
      const parent = env.item('synthetic_parent_12345', 'private parent', env.root.id);
      parent.viewers = [{ getEmail: () => 'other@example.invalid' }];
      env.output.parent = parent.id;
    },
    unownedRoot(env) { env.root.getOwner = () => null; },
    multipleParents(env) {
      const a = env.item('synthetic_parent_a_12345', 'a', env.root.id);
      const b = env.item('synthetic_parent_b_12345', 'b', env.root.id);
      env.output.getParents = () => iterator([a, b]);
    },
    cycle(env) {
      const a = env.item('synthetic_cycle_a_12345', 'a', null);
      const b = env.item('synthetic_cycle_b_12345', 'b', a.id);
      a.parent = b.id;
      env.output.parent = a.id;
    },
    notMyDriveRoot(env) {
      env.output.parent = env.item('synthetic_shared_drive_12345', 'other top', null).id;
    },
    tooDeep(env) {
      let parent = env.root.id;
      for (let i = 0; i < 33; i++) {
        parent = env.item('synthetic_deep_' + String(i).padStart(8, '0'), 'd', parent).id;
      }
      env.output.parent = parent;
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const env = setup();
    env.addFile('synthetic_doc_12345');
    env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_doc_12345' });
    mutate(env);
    const size = env.records.size;
    assert.throws(() => env.run(), /Output (must be private|folder)/, name);
    assert.equal(env.opened, 0, name);
    assert.equal(env.records.size, size, name);
    assert.equal(env.filenames.length, 0, name);
    assert.equal(env.properties.has('MIGRATION_EXPORT_JOB_V1'), false, name);
  }
  // Ancestor sharing introduced mid-job stops resume before any source read/write.
  const env = setup();
  for (let i = 0; i < 21; i++) {
    const id = 'synthetic_doc_' + String(i).padStart(8, '0');
    env.addFile(id);
    env.row('Arsip_Dokumen', { File_Drive_ID: id });
  }
  env.run();
  const rawState = env.properties.get('MIGRATION_EXPORT_JOB_V1');
  const reads = env.sourceReads, writes = env.contentWriteSizes.length;
  env.root.editors = [{ getEmail: () => 'other@example.invalid' }];
  assert.throws(() => env.run(), /Output must be private/);
  assert.equal(env.sourceReads, reads);
  assert.equal(env.contentWriteSizes.length, writes);
  assert.equal(env.properties.get('MIGRATION_EXPORT_JOB_V1'), rawState);
  // Ready helper is directly callable for reuse.
  const fresh = setup();
  assert.equal(fresh.context.migrationExportAssertPrivateAncestors_(fresh.output, OWNER), undefined);
});

test('Empty existing checkpoint fails closed without Drive/Sheets access or writes', () => {
  const env = setup();
  env.properties.set('MIGRATION_EXPORT_JOB_V1', '');
  assert.throws(() => env.run(), /Migration checkpoint JSON is invalid/);
  assert.equal(env.driveCalls, 0);
  assert.equal(env.opened, 0);
  assert.equal(env.records.size, BASE_RECORDS);
  assert.equal(env.filenames.length, 0);
  assert.equal(env.contentWriteSizes.length, 0);
  assert.equal(env.properties.get('MIGRATION_EXPORT_JOB_V1'), '');
});

test('Interrupted binary copy is verified and reused without duplicates or destructive writes', () => {
  const env = setup();
  env.addFile('synthetic_doc_12345');
  env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_doc_12345' });
  env.run();
  const final = env.manifest();
  final.isComplete = false;
  final.finishedAt = null;
  final.fileManifest[0].status = 'pending';
  final.fileManifest[0].sha256 = null;
  const state = JSON.parse(env.properties.get('MIGRATION_EXPORT_JOB_V1'));
  state.nextFileIndex = 0;
  env.records.get(state.manifestFileId).setContent(JSON.stringify(final));
  env.properties.set('MIGRATION_EXPORT_JOB_V1', JSON.stringify(state));
  assert.equal(env.run().availableCount, 1);
  assert.equal(env.filenames.filter((name) => name.endsWith('.bin')).length, 1);
});

test('Cross-kind reuse and malformed numeric file IDs never become available', () => {
  const env = setup();
  env.addFile('synthetic_shared_12345');
  env.row('Arsip_Dokumen', { File_Drive_ID: 'synthetic_shared_12345' });
  env.row('Data_Pegawai', { Foto_Drive_ID: 'synthetic_shared_12345' });
  env.row('Arsip_Dokumen', { File_Drive_ID: 123456789012345 });
  env.row('Arsip_Dokumen', { File_Drive_ID: '123456789012345' });
  const result = env.run();
  assert.equal(result.isComplete, true);
  assert.equal(result.availableCount, 0);
  assert.equal(result.invalidCount, 2);
  assert.equal(env.sourceReads, 0);
  assert.equal(env.manifest().fileManifest.length, 2);
});

test('Whole GAS export JSON is accepted by transformExport with the exact v1 envelope', () => {
  const env = setup();
  const fixture = loadFixture(env);
  assert.equal(env.run().isComplete, true);
  const plan = transformSnapshot(env);
  assert.equal(plan.ready, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.diagnostics.some((entry) => entry.code === 'UNEXPECTED_EXPORT_FIELD'), false);
  assert.equal(plan.expected.pegawai, fixture.snapshot.sheets.Data_Pegawai.rows.length);
  assert.equal(plan.expected.arsip, fixture.snapshot.sheets.Arsip_Dokumen.rows.length);
  assert.equal(plan.expected.files, fixture.files.length);
});

test('Whole GAS export retains missing/invalid files as fatal transformer errors', () => {
  for (const status of ['missing', 'invalid']) {
    const env = setup();
    const fixture = loadFixture(env);
    const fileId = fixture.files.find((file) => file.kind === 'document').fileId;
    if (status === 'missing') env.records.delete(fileId);
    else env.records.get(fileId).sizeOverride = 5 * 1024 * 1024 + 1;
    assert.equal(env.run().isComplete, true);
    assert.equal(env.manifest().fileManifest.find((file) => file.fileId === fileId).status, status);
    const plan = transformSnapshot(env);
    assert.equal(plan.ready, false);
    assert.equal(plan.diagnostics.some((entry) => entry.code === 'UNEXPECTED_EXPORT_FIELD'), false);
    assert.ok(plan.diagnostics.some((entry) => entry.code === 'FILE_UNAVAILABLE' && entry.severity === 'error'));
  }
});

test('Row limit rejects 100001 rows across all sheets before any range/value read', () => {
  for (const lastRows of [
    { Data_Pegawai: 100002 },
    { Data_Pegawai: 50001, Log_Aktivitas: 50002 },
  ]) {
    const env = setup({ lastRows });
    assert.throws(() => env.run(), /EXPORT_ROW_LIMIT/);
    assert.equal(env.bulkReads, 0);
    assert.equal(env.rangeReads, 0);
    assert.equal(env.records.size, BASE_RECORDS);
    assert.equal(env.properties.has('MIGRATION_EXPORT_JOB_V1'), false);
  }
});

test('Initial UTF-8 size cap rejects non-ASCII bytes before output or checkpoint creation', () => {
  const env = setup();
  // Stored twice (values/displayValues): under 7 MiB as UTF-16 code units,
  // over 8 MiB as UTF-8 bytes. This must fail on bytes, not string.length.
  env.row('Log_Aktivitas', { Description: '界'.repeat(1500000) });
  assert.throws(() => env.run(), /EXPORT_SIZE_LIMIT/);
  assert.equal(env.records.size, BASE_RECORDS);
  assert.equal(env.properties.has('MIGRATION_EXPORT_JOB_V1'), false);
  assert.equal(env.contentWriteSizes.length, 0);
});

test('Serializer enforces exact UTF-8 limits and reserves initial checkpoint headroom', () => {
  const env = setup();
  const limit = 8 * 1024 * 1024;
  const atLimit = { value: 'a'.repeat(limit - Buffer.byteLength('{"value":""}')) };
  assert.equal(Buffer.byteLength(env.context.migrationExportSerialize_(atLimit, limit)), limit);
  atLimit.value += 'a';
  assert.throws(() => env.context.migrationExportSerialize_(atLimit, limit), /EXPORT_SIZE_LIMIT/);
  const unicode = { value: '界'.repeat(1500000) };
  const json = JSON.stringify(unicode);
  assert.ok(json.length < 3 * 1024 * 1024);
  assert.ok(Buffer.byteLength(json) > 3 * 1024 * 1024);
  assert.throws(() => env.context.migrationExportSerialize_(unicode, 3 * 1024 * 1024), /EXPORT_SIZE_LIMIT/);
  const reserve = { value: 'a'.repeat(7 * 1024 * 1024) };
  assert.throws(() => env.context.migrationExportSerialize_(reserve, 7 * 1024 * 1024), /EXPORT_SIZE_LIMIT/);
  assert.ok(env.context.migrationExportSerialize_(reserve, limit));
});

test('Oversized resume is rejected before blob read, decode or JSON parse', () => {
  const env = setup();
  env.run();
  const rawState = env.properties.get('MIGRATION_EXPORT_JOB_V1');
  const state = JSON.parse(rawState);
  const file = env.records.get(state.manifestFileId);
  file.sizeOverride = 8 * 1024 * 1024 + 1;
  const reads = file.blobReads || 0;
  file.getBlob = () => { assert.fail('Oversized resume must not read its blob'); };
  assert.throws(() => env.run(), /EXPORT_SIZE_LIMIT/);
  assert.equal(file.blobReads || 0, reads);
  assert.equal(env.properties.get('MIGRATION_EXPORT_JOB_V1'), rawState);
});

test('Every checkpoint rejects oversize JSON before setContent and preserves durable state', () => {
  const env = setup();
  env.run();
  const rawState = env.properties.get('MIGRATION_EXPORT_JOB_V1');
  const state = JSON.parse(rawState);
  const manifest = env.manifest();
  const snapshotFolder = env.records.get(state.snapshotFolderId);
  const manifestFile = env.records.get(state.manifestFileId);
  const filesFolder = [...env.records.values()].find((record) => record.parent === snapshotFolder.id && record.name === 'files');
  const context = { manifest, snapshotFolder, manifestFile, filesFolder };
  const before = manifestFile.data.getDataAsString();
  const writes = env.contentWriteSizes.length;
  manifest.sheets.Log_Aktivitas.rows.push({
    rowNumber: 2, values: ['界'.repeat(3000000)], displayValues: [],
  });
  assert.throws(() => env.context.migrationExportSaveManifest_(context, env.output, OWNER), /EXPORT_SIZE_LIMIT/);
  assert.equal(env.contentWriteSizes.length, writes);
  assert.equal(manifestFile.data.getDataAsString(), before);
  assert.equal(env.properties.get('MIGRATION_EXPORT_JOB_V1'), rawState);
  assert.ok(env.contentWriteSizes.every((bytes) => bytes <= 8 * 1024 * 1024));
});
