// LOCAL Miniflare D1 integration tests for the importer ledger DDL + unchanged core SQL.
// Scope: a fresh in-memory local D1 binding per test (no persistence path, no R2, no Wrangler,
// no network: outbound 403, cf/telemetry off, d1Persist: false). Evidence is about the LOCAL D1
// binding db.batch() only. It is NOT evidence about the D1 REST /query transport, remote D1,
// typed parameter semantics over HTTP or any real target: transportProven/readyForImport stay false.
// All rows are synthetic. Failure assertions compare private snapshots without printing them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { canonicalRow } from '../migrate/apply-local.mjs';
import { splitMigration } from '../migrate/local-store.mjs';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { COLUMNS, PRIMARY, LEDGER, LIMITS, compileChunks, validateDescriptor, classifyResume, decodeStatement } from './core.mjs';
import {
  LEDGER_SCHEMA_VERSION, LEDGER_SQL_FILE, LEDGER_DDL_SHA256, LEDGER_SCHEMA_OBJECTS, LEDGER_FLAGS, LEDGER_MAX_BYTES, validateLedgerSql,
} from './ledger-contract.mjs';

const ROOT = new URL('../../', import.meta.url);
const DDL = readFileSync(new URL(LEDGER_SQL_FILE, ROOT), 'utf8');
const MIGRATIONS = readdirSync(new URL('migrations/', ROOT)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
  .map((name) => readFileSync(new URL(`migrations/${name}`, ROOT), 'utf8'));
const NOW = '2026-10-18T00:00:00.000Z', CREATED = '2026-10-01T00:00:00.000Z';
const SENTINEL = 'Sintetis \'O"Neil\' \u00e9 \u6f22 \u{1F600} \'); DROP TABLE pegawai; --';
const h = (seed) => createHash('sha256').update(seed).digest('hex');
const RUN = LEDGER.runTable, JOURNAL = LEDGER.journalTable;
const descriptor = (over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT,
  databaseId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', databaseName: 'sikap-import-synthetic-1', bucket: 'sikap-import-synthetic-1-files',
  profile: 'synthetic', snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: LEDGER_DDL_SHA256, baselineSha256: h('baseline'), policySha256: h('policy'),
  retentionPolicySha256: h('retention'), runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: '2026-10-18T01:00:00.000Z', ...over,
});
const TARGET = validateDescriptor(descriptor(), NOW).targetBindingSha256;

// Synthetic canonical tables (fake identities; reference ids exist in migration 0002 seeds).
function tables({ pegawai = 3, wide = 0, logs = 2, riwayat = 1, dupNip = false, badStatus = false, orphanAkun = false, badJenis = false } = {}) {
  const t = Object.fromEntries(IMPORT_TABLES.map((table) => [table, []]));
  const row = (table, values) => canonicalRow(table, values, CREATED);
  t.jenis_dokumen.push(row('jenis_dokumen', { id: 'DOC-KTP', nama: 'KTP Sintetis', kategori: 'Dokumen Pribadi', urutan: 1, updated_at: CREATED }));
  t.jenis_dokumen.push(row('jenis_dokumen', { id: 'DOC-SYN-1', nama: SENTINEL, kategori: 'Sintetis', urutan: 99, aktif: badJenis ? 2 : 1 }));
  t.jenis_dokumen_wajib.push(row('jenis_dokumen_wajib', { jenis_dokumen_id: 'DOC-KTP', status_kepegawaian: 'PPPK' }));
  t.jenis_dokumen_wajib.push(row('jenis_dokumen_wajib', { jenis_dokumen_id: 'DOC-SYN-1', status_kepegawaian: 'PNS' }));
  for (let i = 1; i <= pegawai; i++) {
    t.pegawai.push(row('pegawai', {
      id: 900000 + i, nip: `199001012020${String(dupNip && i === 2 ? 1 : i).padStart(6, '0')}`, nik: i === 1 ? '7100000000000001' : null,
      nama: i === 1 ? SENTINEL : `Pegawai Sintetis ${i}`, status_kepegawaian: badStatus && i === 2 ? 'XYZ' : 'PNS',
      pangkat_kode: i === 1 ? 'III/a' : null, unit_id: 1, pendidikan_kode: 'S1', alamat: wide ? '\u00e9'.repeat(wide) : null,
    }));
    t.akun.push(row('akun', { pegawai_id: 900000 + i, password_hash: `legacy-wrap$10000$c2FsdHNhbHRzYWx0c2FsdA==$${'A'.repeat(43)}=`, is_default_password: 0 }));
  }
  if (orphanAkun) t.akun.push(row('akun', { pegawai_id: 999999, password_hash: 'legacy-wrap$10000$x$y', is_default_password: 1 }));
  t.arsip_dokumen.push(row('arsip_dokumen', { id: 1, pegawai_id: 900001, jenis_dokumen_id: 'DOC-SYN-1', status: 'Menunggu', r2_key: 'migration/syn/document/f-1.pdf', file_name: 'syn.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: h('file'), uploaded_at: CREATED }));
  for (let i = 1; i <= riwayat; i++) t.arsip_dokumen_riwayat.push(row('arsip_dokumen_riwayat', { id: i, arsip_id: 1, pegawai_id: 900001, jenis_dokumen_id: 'DOC-SYN-1', versi: 1, aksi: 'UPLOAD', status: 'Menunggu', catatan: SENTINEL, actor_id: 900001, created_at: CREATED }));
  for (let i = 1; i <= logs; i++) t.log_aktivitas.push(row('log_aktivitas', { id: i, ts: CREATED, action: 'SYN_EVENT', result: 'SUCCESS', description: i === 1 ? SENTINEL : null }));
  return t;
}
const compile = (t, d = descriptor()) => compileChunks({ tables: t }, d, { now: NOW });

async function openDb(t, { ledger = true } = {}) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
    outboundService: () => new Response(null, { status: 403 }), log: new Log(LogLevel.NONE),
    cf: false, telemetry: { enabled: false }, d1Databases: { DB: 'sikap-import-ledger-local' },
    d1Persist: false,
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const sql of MIGRATIONS) await db.batch(splitMigration(sql).map((s) => db.prepare(s)));
  if (ledger) await db.batch(splitMigration(DDL).map((s) => db.prepare(s)));
  return db;
}
const send = (db, batch) => db.batch(batch.map((s) => db.prepare(s.sql).bind(...s.params)));
const clone = (chunk) => chunk.batch.map((s) => ({ sql: s.sql, params: [...s.params] }));
const count = async (db, table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
const RUN_INSERT = `INSERT INTO ${RUN} (${LEDGER.runColumns.join(', ')}) VALUES (${LEDGER.runColumns.map(() => '?').join(', ')})`;
const validRun = () => ({ id: 1, run_nonce: descriptor().runNonce, owner_nonce: descriptor().ownerNonce, epoch: 0, target_binding_sha256: TARGET, plan_sha256: h('plan'), stage: 0, cursor: 0, ordinal: 0, claim_seq: 0, last_chunk_sha256: null, complete: 0 });
const insertRun = (db, row) => db.prepare(RUN_INSERT).bind(...LEDGER.runColumns.map((c) => row[c])).run();
const runState = async (db) => await db.prepare(`SELECT * FROM ${RUN} WHERE id = 1`).first();

async function bootstrap(db) {
  assert.equal(await count(db, RUN), 0);
  assert.equal(await count(db, JOURNAL), 0);
  await insertRun(db, validRun());
}
// Full private snapshot of schema and every user table (app + ledger), rowid order, as one string.
async function snapshot(db) {
  const schema = (await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").all()).results;
  const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()).results.map((r) => r.name);
  const out = { schema };
  for (const name of names) out[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  return JSON.stringify(out);
}
const identity = (table, row) => JSON.stringify(PRIMARY[table].map((c) => row[c]));
async function importRows(db) {
  const out = {};
  for (const table of IMPORT_TABLES) {
    const rows = (await db.prepare(`SELECT ${COLUMNS[table].join(', ')} FROM ${table}`).all()).results;
    out[table] = Object.fromEntries(rows.map((r) => [identity(table, r), r]));
  }
  return out;
}
function expectedRows(base, plan, artifact, appliedChunks) {
  const out = {};
  for (const table of IMPORT_TABLES) out[table] = { ...base[table] };
  if (appliedChunks > 0 && plan.jenis_dokumen.length > 0) {
    const plannedIds = new Set(plan.jenis_dokumen.map((r) => r.id));
    for (const [key, row] of Object.entries(out.jenis_dokumen_wajib)) {
      if (plannedIds.has(row.jenis_dokumen_id)) delete out.jenis_dokumen_wajib[key];
    }
  }
  for (let i = 0; i < appliedChunks; i++) {
    const chunk = artifact.chunks[i];
    const rows = plan[chunk.table].slice(chunk.startCursor, chunk.endCursor);
    for (const r of rows) out[chunk.table][identity(chunk.table, r)] = r;
  }
  return out;
}
function sameRows(a, b) {
  for (const table of IMPORT_TABLES) {
    const aKeys = Object.keys(a[table]).sort(), bKeys = Object.keys(b[table]).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (JSON.stringify(a[table][key]) !== JSON.stringify(b[table][key])) return false;
    }
  }
  return true;
}
async function rejectsUnchanged(db, action, matcher) {
  const before = await snapshot(db);
  await assert.rejects(action, matcher);
  assert.equal(await snapshot(db), before);
}
const runRowToReceipt = (r) => ({
  runNonce: r.run_nonce, ownerNonce: r.owner_nonce, epoch: r.epoch, targetBindingSha256: r.target_binding_sha256, planSha256: r.plan_sha256,
  stage: r.stage, cursor: r.cursor, ordinal: r.ordinal, claimSeq: r.claim_seq, lastChunkSha256: r.last_chunk_sha256, complete: r.complete,
});
const journalRowToCamel = (r) => ({
  runNonce: r.run_nonce, epoch: r.epoch, targetBindingSha256: r.target_binding_sha256, ordinal: r.ordinal, stage: r.stage,
  tableName: r.table_name, startCursor: r.start_cursor, endCursor: r.end_cursor, chunkSha256: r.chunk_sha256,
});

test('contract: pinned DDL hash, fixed false flags, closed codes, static DDL shape', () => {
  const result = validateLedgerSql(DDL);
  assert.equal(result.valid, true);
  assert.equal(result.code, 'OK');
  assert.equal(result.schemaVersion, LEDGER_SCHEMA_VERSION);
  for (const [key, val] of Object.entries(LEDGER_FLAGS)) assert.equal(result[key], val);
  assert.equal(validateLedgerSql(null).code, 'LEDGER_SQL_TYPE');
  assert.equal(validateLedgerSql('x'.repeat(LEDGER_MAX_BYTES + 1)).code, 'LEDGER_SQL_SIZE');
  assert.equal(validateLedgerSql(`\uFEFF${DDL}`).code, 'LEDGER_SQL_ENCODING');
  assert.equal(validateLedgerSql('SELECT 1;\0').code, 'LEDGER_SQL_ENCODING');
  assert.equal(validateLedgerSql(DDL.replace(/\n/g, '\r\n')).code, 'OK');
  assert.equal(validateLedgerSql(`${DDL} `).code, 'LEDGER_SQL_HASH_MISMATCH');
  assert.match(DDL, /(?:^|\n)CREATE TABLE __sikap_import_v1_run/);
  assert.match(DDL, /CREATE TABLE __sikap_import_v1_journal/);
  assert.doesNotMatch(DDL, /IF NOT EXISTS|DROP|PRAGMA|TRIGGER|BEGIN|COMMIT/i);
});

test('schema: exact objects/columns/keys/FK on local D1; plain CREATE refuses repeat or collision atomically', async (t) => {
  const db = await openDb(t);
  const objects = (await db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE tbl_name LIKE '__sikap_import_v1_%' ORDER BY type, name").all()).results;
  assert.deepEqual(objects, [...LEDGER_SCHEMA_OBJECTS]);
  const runCols = (await db.prepare(`PRAGMA table_info(${RUN})`).all()).results.map((c) => c.name);
  assert.deepEqual(runCols, [...LEDGER.runColumns]);
  const journalCols = (await db.prepare(`PRAGMA table_info(${JOURNAL})`).all()).results.map((c) => c.name);
  assert.deepEqual(journalCols, [...LEDGER.journalColumns]);
  const fkPragma = await db.prepare('PRAGMA foreign_keys').first();
  assert.equal(fkPragma.foreign_keys, 1);

  await rejectsUnchanged(db, () => db.batch(splitMigration(DDL).map((s) => db.prepare(s))), /table __sikap_import_v1_run already exists/);

  const blank = await openDb(t, { ledger: false });
  await blank.prepare('CREATE TABLE __sikap_import_v1_journal (id INTEGER PRIMARY KEY)').run();
  await assert.rejects(
    () => blank.batch(splitMigration(DDL).map((s) => blank.prepare(s))),
    /table __sikap_import_v1_journal already exists/,
  );
  const created = (await blank.prepare("SELECT name FROM sqlite_master WHERE name = '__sikap_import_v1_run'").all()).results;
  assert.equal(created.length, 0);
});

test('run row CHECKs: singleton, lowercase non-zero hex, NUL, ranges, typeof integer, ordinal/hash/claim_seq/complete rules', async (t) => {
  const db = await openDb(t);
  const NUL64 = `${'a'.repeat(64)}\0zz`;
  const bad = [
    [{ ...validRun(), id: 2 }, /CHECK constraint failed/],
    [{ ...validRun(), run_nonce: '0'.repeat(32) }, /CHECK constraint failed/],
    [{ ...validRun(), run_nonce: 'A'.repeat(32) }, /CHECK constraint failed/],
    [{ ...validRun(), run_nonce: 'g'.repeat(32) }, /CHECK constraint failed/],
    [{ ...validRun(), run_nonce: `${'a'.repeat(32)}\0zz` }, /CHECK constraint failed/],
    [{ ...validRun(), owner_nonce: descriptor().runNonce }, /CHECK constraint failed/],
    [{ ...validRun(), epoch: -1 }, /CHECK constraint failed/],
    [{ ...validRun(), epoch: 1.5 }, /CHECK constraint failed/],
    [{ ...validRun(), target_binding_sha256: NUL64 }, /CHECK constraint failed/],
    [{ ...validRun(), plan_sha256: NUL64 }, /CHECK constraint failed/],
    [{ ...validRun(), stage: 8 }, /CHECK constraint failed/],
    [{ ...validRun(), stage: 7, cursor: 1 }, /CHECK constraint failed/],
    [{ ...validRun(), ordinal: 1, last_chunk_sha256: null }, /CHECK constraint failed/],
    [{ ...validRun(), ordinal: 0, last_chunk_sha256: h('prev') }, /CHECK constraint failed/],
    [{ ...validRun(), claim_seq: 2, ordinal: 0 }, /CHECK constraint failed/],
    [{ ...validRun(), complete: 1 }, /CHECK constraint failed/],
  ];
  for (const [row, matcher] of bad) {
    await rejectsUnchanged(db, () => insertRun(db, row), matcher);
  }
  await insertRun(db, { ...validRun(), claim_seq: 1 });
  assert.equal((await runState(db)).claim_seq, 1);
  await db.prepare(`DELETE FROM ${RUN}`).run();

  await insertRun(db, { ...validRun(), stage: 7, cursor: 0, ordinal: 5, claim_seq: 5, last_chunk_sha256: h('done'), complete: 0 });
  await rejectsUnchanged(db, () => db.prepare(`UPDATE ${RUN} SET complete = 1 WHERE id = 1`).run(), /CHECK constraint failed/);
  await db.prepare(`DELETE FROM ${RUN}`).run();

  await insertRun(db, { ...validRun(), ordinal: Number.MAX_SAFE_INTEGER, claim_seq: Number.MAX_SAFE_INTEGER, last_chunk_sha256: h('max') });
  await rejectsUnchanged(db, () => db.prepare(`UPDATE ${RUN} SET claim_seq = claim_seq + 1 WHERE id = 1`).run(), /CHECK constraint failed/);
});

test('journal CHECKs: PRIMARY KEY (run_nonce, ordinal), FK tuple to run, stage/table parity, cursor order', async (t) => {
  const db = await openDb(t);
  await bootstrap(db);
  const j = (over = {}) => ({
    run_nonce: descriptor().runNonce, epoch: 0, target_binding_sha256: TARGET,
    ordinal: 0, stage: 0, table_name: 'jenis_dokumen', start_cursor: 0, end_cursor: 1, chunk_sha256: h('c0'), ...over,
  });
  const ins = (row) => db.prepare(`INSERT INTO ${JOURNAL} (${LEDGER.journalColumns.join(', ')}) VALUES (${LEDGER.journalColumns.map(() => '?').join(', ')})`).bind(...LEDGER.journalColumns.map((c) => row[c])).run();

  await ins(j());
  await rejectsUnchanged(db, () => ins(j()), /UNIQUE constraint failed/);
  await rejectsUnchanged(db, () => ins(j({ ordinal: 1, target_binding_sha256: h('other') })), /FOREIGN KEY constraint failed/);
  await rejectsUnchanged(db, () => ins(j({ ordinal: 1, run_nonce: 'f'.repeat(32) })), /FOREIGN KEY constraint failed/);
  await rejectsUnchanged(db, () => ins(j({ ordinal: 1, stage: 7, table_name: 'jenis_dokumen' })), /CHECK constraint failed/);
  await rejectsUnchanged(db, () => ins(j({ ordinal: 1, stage: 0, table_name: 'pegawai' })), /CHECK constraint failed/);
  await rejectsUnchanged(db, () => ins(j({ ordinal: 1, start_cursor: 5, end_cursor: 4 })), /CHECK constraint failed/);
});

test('happy path: every compiled chunk via db.batch(prepare.bind); final receipt, journal, exact rows, seeds preserved', async (t) => {
  const db = await openDb(t);
  const data = tables({ pegawai: 3, wide: 50, logs: 2, riwayat: 1 });
  const artifact = compile(data);
  await bootstrap(db);
  const base = await importRows(db);

  for (const chunk of artifact.chunks) {
    const results = await send(db, chunk.batch);
    assert.equal(results.length, chunk.statementCount);
    assert.equal(results[0].meta.changes, 1);
  }

  const finalRun = await runState(db);
  assert.equal(finalRun.stage, 7);
  assert.equal(finalRun.cursor, 0);
  assert.equal(finalRun.ordinal, artifact.chunks.length);
  assert.equal(finalRun.claim_seq, artifact.chunks.length);
  assert.equal(finalRun.last_chunk_sha256, artifact.chunks.at(-1).chunkSha256);
  assert.equal(finalRun.complete, 0);

  await rejectsUnchanged(db, () => db.prepare(`UPDATE ${RUN} SET complete = 1 WHERE id = 1`).run(), /CHECK constraint failed/);
  await rejectsUnchanged(db, () => db.prepare(`UPDATE ${RUN} SET complete = '1' WHERE id = 1`).run(), /CHECK constraint failed/);

  const journals = (await db.prepare(`SELECT * FROM ${JOURNAL} ORDER BY ordinal ASC`).all()).results;
  assert.equal(journals.length, artifact.chunks.length);
  for (let i = 0; i < journals.length; i++) {
    const row = journals[i], c = artifact.chunks[i];
    assert.equal(row.ordinal, i);
    assert.equal(row.stage, c.stage);
    assert.equal(row.table_name, c.table);
    assert.equal(row.start_cursor, c.startCursor);
    assert.equal(row.end_cursor, c.endCursor);
    assert.equal(row.chunk_sha256, c.chunkSha256);
  }

  assert.ok(sameRows(await importRows(db), expectedRows(base, data, artifact, artifact.chunkCount)));
  assert.ok(await db.prepare("SELECT * FROM jenis_dokumen WHERE id = 'DOC-KK'").first());
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM jenis_dokumen_wajib WHERE jenis_dokumen_id = 'DOC-KTP'").first()).n, 1);
});

test('replay and out-of-order chunks abort on the claim guard; full state unchanged', async (t) => {
  const db = await openDb(t);
  const data = tables();
  const artifact = compile(data);
  await bootstrap(db);
  await send(db, artifact.chunks[0].batch);

  await rejectsUnchanged(db, () => send(db, artifact.chunks[0].batch), /malformed JSON/);
  await rejectsUnchanged(db, () => send(db, artifact.chunks[2].batch), /malformed JSON/);
});

test('every mutated claim CAS binding (nonce/owner/epoch/target/plan/stage/cursor/ordinal/claim_seq/prev) aborts atomically', async (t) => {
  const db = await openDb(t);
  const data = tables();
  const artifact = compile(data);
  await bootstrap(db);
  await send(db, artifact.chunks[0].batch);

  const chunk1 = artifact.chunks[1];
  const mutations = [
    { idx: 1, val: 'f'.repeat(32) }, { idx: 2, val: 'f'.repeat(32) }, { idx: 3, val: 99 },
    { idx: 4, val: 'f'.repeat(64) }, { idx: 5, val: 'f'.repeat(64) }, { idx: 6, val: 9 },
    { idx: 7, val: 999 }, { idx: 8, val: 999 }, { idx: 9, val: 999 }, { idx: 10, val: 'f'.repeat(64) },
  ];
  for (const { idx, val } of mutations) {
    const batch = clone(chunk1);
    const decoded = decodeStatement(batch[0]);
    assert.equal(decoded.kind, 'claim');
    const mutated = [...decoded.values];
    mutated[idx] = val;
    batch[0].params = [JSON.stringify(mutated)];
    await rejectsUnchanged(db, () => send(db, batch), /malformed JSON/);
  }
});

test('final checkpoint CAS no-op (mutated WHERE owner / claim_seq) is caught by the last guard: data+journal+claim roll back', async (t) => {
  const db = await openDb(t);
  const data = tables();
  const artifact = compile(data);
  await bootstrap(db);

  const chunk0 = artifact.chunks[0];
  const checkpointIdx = chunk0.batch.length - 2;

  const badOwner = clone(chunk0);
  const decodedOwner = decodeStatement(badOwner[checkpointIdx]);
  assert.equal(decodedOwner.kind, 'checkpoint');
  const mutatedOwner = [...decodedOwner.values];
  mutatedOwner[5] = 'f'.repeat(32);
  badOwner[checkpointIdx].params = [JSON.stringify(mutatedOwner)];
  await rejectsUnchanged(db, () => send(db, badOwner), /malformed JSON/);

  const badClaimSeq = clone(chunk0);
  const decodedClaim = decodeStatement(badClaimSeq[checkpointIdx]);
  assert.equal(decodedClaim.kind, 'checkpoint');
  const mutatedClaim = [...decodedClaim.values];
  mutatedClaim[12] = 999;
  badClaimSeq[checkpointIdx].params = [JSON.stringify(mutatedClaim)];
  await rejectsUnchanged(db, () => send(db, badClaimSeq), /malformed JSON/);
});

test('app UNIQUE: duplicate NIP inside one compiled chunk aborts the whole request (core does no business validation)', async (t) => {
  const db = await openDb(t);
  const data = tables({ dupNip: true });
  const artifact = compile(data);
  await bootstrap(db);

  const pegIdx = artifact.chunks.findIndex((c) => c.table === 'pegawai');
  for (let i = 0; i < pegIdx; i++) await send(db, artifact.chunks[i].batch);
  await rejectsUnchanged(db, () => send(db, artifact.chunks[pegIdx].batch), /UNIQUE constraint failed: pegawai\.nip/);
});

test('app FOREIGN KEY: akun for unknown pegawai aborts; earlier committed chunks stay intact', async (t) => {
  const db = await openDb(t);
  const data = tables({ orphanAkun: true });
  const artifact = compile(data);
  await bootstrap(db);

  const akunIdx = artifact.chunks.findIndex((c) => c.table === 'akun');
  for (let i = 0; i < akunIdx; i++) await send(db, artifact.chunks[i].batch);
  await rejectsUnchanged(db, () => send(db, artifact.chunks[akunIdx].batch), /FOREIGN KEY constraint failed/);
});

test('app CHECK: invalid status_kepegawaian, and stage-0 invalid jenis rolls back seed DELETE + upsert', async (t) => {
  const db = await openDb(t);
  const dataBadStatus = tables({ badStatus: true });
  const artifactBadStatus = compile(dataBadStatus);
  await bootstrap(db);

  const pegIdx = artifactBadStatus.chunks.findIndex((c) => c.table === 'pegawai');
  for (let i = 0; i < pegIdx; i++) await send(db, artifactBadStatus.chunks[i].batch);
  await rejectsUnchanged(db, () => send(db, artifactBadStatus.chunks[pegIdx].batch), /CHECK constraint failed/);

  const db2 = await openDb(t);
  const dataBadJenis = tables({ badJenis: true });
  const artifactBadJenis = compile(dataBadJenis);
  await bootstrap(db2);
  await rejectsUnchanged(db2, () => send(db2, artifactBadJenis.chunks[0].batch), /CHECK constraint failed/);
});

test('pre-existing journal row for the next ordinal: plain journal INSERT conflicts and the chunk rolls back', async (t) => {
  const db = await openDb(t);
  const data = tables();
  const artifact = compile(data);
  await bootstrap(db);
  await send(db, artifact.chunks[0].batch);

  await db.prepare(`INSERT INTO ${JOURNAL} (${LEDGER.journalColumns.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    descriptor().runNonce, 0, TARGET, 1, 1, 'jenis_dokumen_wajib', 0, 1, h('dup'),
  ).run();

  await rejectsUnchanged(db, () => send(db, artifact.chunks[1].batch), /UNIQUE constraint failed: __sikap_import_v1_journal\.run_nonce, __sikap_import_v1_journal\.ordinal/);
});

test('local resume: lost response after commit is read back, classified by core; tamper -> HOLD/DIVERGED; no retry authority', async (t) => {
  const db = await openDb(t);
  const data = tables();
  const artifact = compile(data);
  await bootstrap(db);
  const base = await importRows(db);

  for (let i = 0; i < 2; i++) await send(db, artifact.chunks[i].batch);
  await assert.rejects(async () => {
    await send(db, artifact.chunks[2].batch);
    throw new Error('SIMULATED_LOCAL_TIMEOUT');
  }, /SIMULATED_LOCAL_TIMEOUT/);

  const receipt = runRowToReceipt(await runState(db));
  const journals = (await db.prepare(`SELECT * FROM ${JOURNAL} ORDER BY ordinal ASC`).all()).results.map(journalRowToCamel);

  const prefix = async (k) => sameRows(await importRows(db), expectedRows(base, data, artifact, k));
  const classify = (k, verified) => classifyResume({
    artifact, ordinal: k, observedReceipt: receipt, journal: journals, exactPrefixVerified: verified, writerQuiescent: true,
  });

  assert.equal(await prefix(3), true);
  const res = await classify(2, true);
  assert.equal(res.outcome, 'COMMITTED_OBSERVED');
  assert.equal(res.authorizesRetry, false);
  assert.equal(res.authorizesSend, false);
  assert.equal(res.autoResendAllowed, false);
  assert.equal(res.remoteAuthorized, false);

  await db.prepare("UPDATE pegawai SET nama = 'tampered' WHERE id = 900001").run();
  assert.equal(await prefix(3), false);
  assert.equal((await classify(2, await prefix(3))).outcome, 'HOLD_UNCERTAIN');

  await db.prepare(`UPDATE ${JOURNAL} SET chunk_sha256 = ? WHERE ordinal = 0`).bind(h('tamper')).run();
  const tamperedJournals = (await db.prepare(`SELECT * FROM ${JOURNAL} ORDER BY ordinal ASC`).all()).results.map(journalRowToCamel);
  assert.equal(classifyResume({ artifact, ordinal: 2, observedReceipt: receipt, journal: tamperedJournals, exactPrefixVerified: true, writerQuiescent: true }).outcome, 'DIVERGED');
});

test('batch limits on the local binding: near-64KiB chunks, <=100 params, empty stages advance, typed values preserved', async (t) => {
  const db = await openDb(t);
  const data = tables({ pegawai: 8, wide: 14000, logs: 0, riwayat: 0 });
  const artifact = compile(data);
  assert.ok(artifact.chunks.every((c) => c.valueCount <= LIMITS.values && c.parameterCount <= LIMITS.parameters && c.bodyBytes <= LIMITS.bodyBytes && c.statementCount <= LIMITS.statements));
  assert.ok(Math.max(...artifact.chunks.map((c) => c.bodyBytes)) > 48 * 1024, 'at least one chunk near the body policy limit');
  assert.ok(artifact.chunks.some((c) => c.rowCount === 0 && c.table === 'log_aktivitas'), 'empty stage still emits a moving chunk');
  await bootstrap(db);
  const base = await importRows(db);
  for (const chunk of artifact.chunks) {
    const results = await send(db, chunk.batch);
    assert.equal(results.length, chunk.statementCount);
    assert.equal(results[0].meta.changes, 1);
    const state = await runState(db);
    assert.ok(state.stage === chunk.nextStage && state.cursor === chunk.nextCursor && state.claim_seq === state.ordinal);
  }
  assert.ok(sameRows(await importRows(db), expectedRows(base, data, artifact, artifact.chunkCount)));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM pegawai WHERE typeof(alamat) = 'text' AND length(alamat) = 14000").first()).n, 8);
  assert.equal((await runState(db)).stage, 7);
});

test('v2 transport type fidelity: string-only wire params, typeof SELECT preserves null/text/integer, and canonical row equality', async (t) => {
  const db = await openDb(t);
  const data = tables({ pegawai: 3, wide: 0, logs: 2, riwayat: 1 });
  // Dedicated type-fidelity adjustments: leading-zero 18-digit string NIP and safe integer size_bytes
  data.pegawai[0].nip = '099001012020000001';
  data.arsip_dokumen[0].size_bytes = Number.MAX_SAFE_INTEGER;
  const artifact = compile(data);
  await bootstrap(db);
  const base = await importRows(db);

  // Initial bootstrap: last_chunk_sha256 is null in ledger run table
  const bootRun = await db.prepare(
    `SELECT typeof(last_chunk_sha256) AS prev_sha_t, last_chunk_sha256 FROM ${RUN} WHERE id = 1`,
  ).first();
  assert.equal(bootRun.prev_sha_t, 'null');
  assert.equal(bootRun.last_chunk_sha256, null);

  // Validate wire contract for every statement in every chunk:
  // guard binds [] (0 params); all other statements bind exactly 1 canonical JSON array string.
  for (const chunk of artifact.chunks) {
    for (const stmt of chunk.batch) {
      if (stmt.sql.includes('sikap_import_guard')) {
        assert.deepEqual(stmt.params, [], 'guard statement wire params must be empty');
      } else {
        assert.equal(stmt.params.length, 1, 'non-guard statement wire params must have exactly 1 parameter');
        assert.equal(typeof stmt.params[0], 'string', 'wire param must be string only');
        const parsed = JSON.parse(stmt.params[0]);
        assert.ok(Array.isArray(parsed), 'wire param must parse to a JSON array');
        assert.equal(stmt.params[0], JSON.stringify(parsed), 'wire param must be canonical JSON string');
      }
    }
  }

  // Execute all compiled chunks through Miniflare db.batch(prepare.bind)
  for (const chunk of artifact.chunks) {
    const results = await send(db, chunk.batch);
    assert.equal(results.length, chunk.statementCount);
    assert.equal(results[0].meta.changes, 1);
  }

  // Type fidelity in SQLite: typeof SELECT verifies nullable null, numeric integer, NIP text
  const peg1 = await db.prepare(
    'SELECT typeof(id) AS id_t, typeof(nip) AS nip_t, typeof(nik) AS nik_t, typeof(alamat) AS alamat_t, nip FROM pegawai WHERE id = 900001',
  ).first();
  assert.equal(peg1.id_t, 'integer', 'numeric integer id');
  assert.equal(peg1.nip_t, 'text', 'NIP with leading zero must remain text');
  assert.equal(peg1.nip, '099001012020000001', 'NIP leading zero must be preserved verbatim');
  assert.equal(peg1.nik_t, 'text', 'nik is text when populated');
  assert.equal(peg1.alamat_t, 'null', 'nullable alamat must be null in SQLite');

  const peg2 = await db.prepare(
    'SELECT typeof(nik) AS nik_t, nik FROM pegawai WHERE id = 900002',
  ).first();
  assert.equal(peg2.nik_t, 'null', 'nullable nik must be null in SQLite');
  assert.equal(peg2.nik, null);

  // Safe integer verification in SQLite
  const arsip = await db.prepare(
    'SELECT typeof(size_bytes) AS size_t, size_bytes FROM arsip_dokumen WHERE id = 1',
  ).first();
  assert.equal(arsip.size_t, 'integer', 'safe integer column stored as integer');
  assert.equal(arsip.size_bytes, Number.MAX_SAFE_INTEGER, 'safe integer value matches');

  // Ledger integers and checkpoint state verification
  const run = await db.prepare(
    `SELECT typeof(stage) AS stage_t, typeof(cursor) AS cur_t, typeof(ordinal) AS ord_t, typeof(claim_seq) AS claim_t, typeof(last_chunk_sha256) AS sha_t, stage, cursor, ordinal, claim_seq, last_chunk_sha256 FROM ${RUN} WHERE id = 1`,
  ).first();
  assert.equal(run.stage_t, 'integer');
  assert.equal(run.cur_t, 'integer');
  assert.equal(run.ord_t, 'integer');
  assert.equal(run.claim_t, 'integer');
  assert.equal(run.sha_t, 'text');
  assert.equal(run.stage, 7);
  assert.equal(run.cursor, 0);
  assert.equal(run.ordinal, artifact.chunks.length);
  assert.equal(run.claim_seq, artifact.chunks.length);
  assert.equal(run.last_chunk_sha256, artifact.chunks.at(-1).chunkSha256);

  // Journal integers
  const journal0 = await db.prepare(
    `SELECT typeof(ordinal) AS ord_t, typeof(stage) AS stage_t, typeof(start_cursor) AS start_t, typeof(end_cursor) AS end_t FROM ${JOURNAL} WHERE ordinal = 0`,
  ).first();
  assert.equal(journal0.ord_t, 'integer');
  assert.equal(journal0.stage_t, 'integer');
  assert.equal(journal0.start_t, 'integer');
  assert.equal(journal0.end_t, 'integer');

  // Post-completion replay still fails the claim guard and leaves all rows unchanged.
  const tampered = clone(artifact.chunks[0]);
  const decoded = decodeStatement(tampered[0]);
  const mutatedValues = [...decoded.values];
  mutatedValues[1] = '0'.repeat(32); // additional mismatch; isolated nonce causality is tested in the matrix above
  tampered[0].params = [JSON.stringify(mutatedValues)];
  await rejectsUnchanged(db, () => send(db, tampered), /malformed JSON/);

  // Compare actual SQL rows to expected canonical rows (not mock assertions)
  const actualRows = await importRows(db);
  const expected = expectedRows(base, data, artifact, artifact.chunkCount);
  assert.ok(sameRows(actualRows, expected), 'actual SQL rows must equal canonical expected rows');

  // Verify Unicode quoted SQL-looking text retained verbatim
  assert.equal(actualRows.pegawai[identity('pegawai', { id: 900001 })].nama, SENTINEL);
  assert.equal(actualRows.jenis_dokumen[identity('jenis_dokumen', { id: 'DOC-SYN-1' })].nama, SENTINEL);
});
