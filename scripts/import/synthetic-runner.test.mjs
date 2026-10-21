// LOCAL Miniflare + HTTP stubs test suite for SIKAP synthetic import runner.
// Tests runSyntheticImport and pure hashBaseline with in-memory SQLite and fake HTTP fetch stubs.
// No remote network, no Wrangler CLI, no cloud credentials, no env access, no real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { canonicalRow } from '../migrate/apply-local.mjs';
import { splitMigration } from '../migrate/local-store.mjs';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { COLUMNS, PRIMARY, LEDGER, compileChunks, validateDescriptor } from './core.mjs';
import { LEDGER_DDL_SHA256, LEDGER_SQL_FILE, validateLedgerSql } from './ledger-contract.mjs';
import { ENDPOINT_ORIGIN, ENDPOINT_PATH } from './d1-rest.mjs';
import { ROW_LIMITS, SCHEMA_QUERY } from './d1-readback.mjs';
import { runSyntheticImport, runPrivateUatImport, runPrivateUatRecovery, UAT_EXPECTED_SCHEMA_SHA256, hashBaseline, READBACK_BUDGET_BYTES, RUNNER_STATUSES, RUNNER_REASONS } from './synthetic-runner.mjs';
import { UAT_TARGET, UAT_APP_SCHEMA_SHA256, UAT_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256, issueRealDataUatPermit, claimPermitForRun, finishPermitRun, isPermitClaimed, isPermitSpent } from './real-data-gate.mjs';

const ROOT = new URL('../../', import.meta.url);
const DDL = readFileSync(new URL(LEDGER_SQL_FILE, ROOT), 'utf8');
const MIGRATIONS = readdirSync(new URL('migrations/', ROOT)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort()
  .map((n) => readFileSync(new URL(`migrations/${n}`, ROOT), 'utf8'));

const NOW = '2026-10-18T00:00:00.000Z', CREATED = '2026-10-01T00:00:00.000Z';
const SENTINEL = 'Sintetis \'O"Neil\' \u00e9 \u6f22 \u{1F600} \'); DROP TABLE pegawai; --';
const h = (data) => createHash('sha256').update(data).digest('hex');
const RUN = LEDGER.runTable;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
const PDF_SHA256 = h(PDF_BYTES);
const D1_TOKEN = 'SYNTHETIC-TEST-TOKEN-' + 'A'.repeat(30);
const R2_ACCESS_KEY = 'SYNTHACCESSKEYID0001';
const R2_SECRET_KEY = 'SYNTHETIC-SECRET/not+a+real+key+0001';

const descriptor = (over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT,
  databaseId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', databaseName: 'sikap-import-synthetic-1',
  bucket: 'sikap-import-synthetic-1-files', profile: 'synthetic',
  snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: LEDGER_DDL_SHA256, baselineSha256: h('baseline'),
  policySha256: h('policy'), retentionPolicySha256: h('retention'),
  runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: '2026-10-18T04:00:00.000Z', ...over,
});

const r2KeyFor = (d, hash = PDF_SHA256) => `migration/${d.snapshotId}/objects/${hash}.pdf`;

function makeTables(r2Key) {
  const t = Object.fromEntries(IMPORT_TABLES.map((table) => [table, []]));
  const row = (table, values) => canonicalRow(table, values, CREATED);
  t.jenis_dokumen.push(row('jenis_dokumen', { id: 'DOC-KTP', nama: 'KTP Sintetis', kategori: 'Dokumen Pribadi', urutan: 1, updated_at: CREATED }));
  t.jenis_dokumen.push(row('jenis_dokumen', { id: 'DOC-SYN-1', nama: SENTINEL, kategori: 'Sintetis', urutan: 99, aktif: 1 }));
  t.jenis_dokumen_wajib.push(row('jenis_dokumen_wajib', { jenis_dokumen_id: 'DOC-KTP', status_kepegawaian: 'PPPK' }));
  t.jenis_dokumen_wajib.push(row('jenis_dokumen_wajib', { jenis_dokumen_id: 'DOC-SYN-1', status_kepegawaian: 'PNS' }));
  t.pegawai.push(row('pegawai', {
    id: 900001, nip: '199001012020000001', nik: '7100000000000001', nama: SENTINEL,
    status_kepegawaian: 'PNS', pangkat_kode: 'III/a', unit_id: 1, pendidikan_kode: 'S1',
  }));
  t.pegawai.push(row('pegawai', {
    id: 900002, nip: '199001012020000002', nik: null,
    nama: 'Pegawai Sintetis 2', status_kepegawaian: 'PNS', pangkat_kode: null, unit_id: 1, pendidikan_kode: 'S1',
  }));
  t.akun.push(row('akun', {
    pegawai_id: 900001, password_hash: `legacy-wrap$10000$c2FsdHNhbHRzYWx0c2FsdA==$${'A'.repeat(43)}=`, is_default_password: 0,
  }));
  t.arsip_dokumen.push(row('arsip_dokumen', {
    id: 1, pegawai_id: 900001, jenis_dokumen_id: 'DOC-SYN-1', status: 'Menunggu',
    r2_key: r2Key, file_name: 'syn.pdf', mime_type: 'application/pdf', size_bytes: PDF_BYTES.byteLength,
    sha256: PDF_SHA256, uploaded_at: CREATED,
  }));
  t.arsip_dokumen_riwayat.push(row('arsip_dokumen_riwayat', {
    id: 1, arsip_id: 1, pegawai_id: 900001, jenis_dokumen_id: 'DOC-SYN-1', versi: 1, aksi: 'UPLOAD',
    status: 'Menunggu', catatan: SENTINEL, actor_id: 900001, created_at: CREATED,
  }));
  t.log_aktivitas.push(row('log_aktivitas', {
    id: 1, ts: CREATED, action: 'SYN_EVENT', result: 'SUCCESS', description: SENTINEL,
  }));
  return t;
}

const makeObjects = (r2Key, bytes = PDF_BYTES, mimeType = 'application/pdf') => [
  { key: r2Key, bytes: new Uint8Array(bytes), mimeType, sha256: h(bytes) },
];

async function readBaseline(db) {
  const out = {};
  for (const table of IMPORT_TABLES) {
    const rows = (await db.prepare(`SELECT ${COLUMNS[table].join(', ')} FROM ${table} ORDER BY ${PRIMARY[table].join(', ')}`).all()).results;
    out[table] = rows;
  }
  return out;
}

const RUN_INSERT = `INSERT INTO ${RUN} (${LEDGER.runColumns.join(', ')}) VALUES (${LEDGER.runColumns.map(() => '?').join(', ')})`;
async function bootstrap(db, d, now = NOW) {
  const target = validateDescriptor(d, now).targetBindingSha256;
  const row = {
    id: 1, run_nonce: d.runNonce, owner_nonce: d.ownerNonce, epoch: d.epoch,
    target_binding_sha256: target, plan_sha256: d.planSha256, stage: 0, cursor: 0,
    ordinal: 0, claim_seq: 0, last_chunk_sha256: null, complete: 0,
  };
  await db.prepare(RUN_INSERT).bind(...LEDGER.runColumns.map((c) => row[c])).run();
}

async function openDb(t) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
    outboundService: () => new Response(null, { status: 403 }), log: new Log(LogLevel.NONE),
    cf: false, telemetry: { enabled: false }, d1Databases: { DB: 'sikap-synthetic-test' }, d1Persist: false,
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const sql of MIGRATIONS) await db.batch(splitMigration(sql).map((s) => db.prepare(s)));
  assert.equal(validateLedgerSql(DDL).valid, true);
  await db.batch(splitMigration(DDL).map((s) => db.prepare(s)));
  return db;
}

async function snapshot(db) {
  const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()).results.map((r) => r.name);
  const out = {};
  for (const name of names) out[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  return JSON.stringify(out);
}

function createR2FetchFake({ onBeforeRequest = null } = {}) {
  const r2Storage = new Map();
  let putCount = 0, getCount = 0, deleteCount = 0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    if (onBeforeRequest) {
      const intercepted = await onBeforeRequest(method, url, init, { putCount, getCount });
      if (intercepted) return intercepted;
    }
    if (method === 'DELETE') {
      deleteCount++;
      assert.fail('DELETE must not be called');
    }
    if (method === 'PUT') {
      putCount++;
      assert.equal(init.headers?.['if-none-match'], '*');
      if (r2Storage.has(url)) return new Response(null, { status: 412, statusText: 'Precondition Failed' });
      const copy = new Uint8Array(init.body);
      r2Storage.set(url, { bytes: copy, mimeType: init.headers?.['content-type'] ?? 'application/octet-stream' });
      return new Response(null, { status: 200, statusText: 'OK' });
    }
    if (method === 'GET') {
      getCount++;
      if (!r2Storage.has(url)) return new Response(null, { status: 404, statusText: 'Not Found' });
      const item = r2Storage.get(url);
      return new Response(new Uint8Array(item.bytes), { status: 200, headers: { 'content-type': item.mimeType } });
    }
    assert.fail(`Unexpected method: ${method}`);
  };
  return { fetchImpl, r2Storage, calls, getCounts: () => ({ putCount, getCount, deleteCount }) };
}

function createD1FetchStub(db, d, { onBeforeBatch = null, onAfterBatch = null } = {}) {
  const expectedUrl = `${ENDPOINT_ORIGIN}${ENDPOINT_PATH(d.accountId, d.databaseId)}`;
  let postCount = 0, readCount = 0, writeCount = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, expectedUrl);
    assert.equal(init.method, 'POST');
    assert.match(init.headers?.Authorization ?? '', /^Bearer SYNTHETIC-TEST-TOKEN-/);
    assert.equal(init.headers?.['Content-Type'], 'application/json');
    postCount++;

    const { batch } = JSON.parse(init.body);
    const isSelect = (batch.length === 9 || batch.length === 10) && batch.every((s) => s.sql.startsWith('SELECT'));
    if (isSelect) readCount++; else writeCount++;
    calls.push({ isSelect, batchLength: batch.length });

    if (onBeforeBatch) {
      const intercepted = await onBeforeBatch({ batch, isSelect, init, postCount, writeCount, readCount });
      if (intercepted) return intercepted;
    }

    const mfResults = await db.batch(batch.map((s) => db.prepare(s.sql).bind(...s.params)));

    if (onAfterBatch) {
      const intercepted = await onAfterBatch({ mfResults, batch, isSelect, init, postCount, writeCount, readCount });
      if (intercepted) return intercepted;
    }

    const result = mfResults.map((r) => {
      assert.equal(r.success, true);
      const item = { success: r.success, results: Array.isArray(r.results) ? r.results.map((x) => ({ ...x })) : [] };
      if (r.meta && typeof r.meta.changes === 'number') item.meta = { changes: r.meta.changes };
      return item;
    });

    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls, getCounts: () => ({ postCount, readCount, writeCount }) };
}

function checkReportSafety(rep, d, realMode = false) {
  assert.equal(rep.ready, false);
  assert.equal(rep.readyForImport, false);
  assert.equal(rep.remoteAuthorized, false);
  assert.equal(rep.transportProven, false);
  assert.equal(rep.authorizesExecution, false);
  assert.equal(rep.authorizesRetry, false);
  assert.equal(rep.authorizesResume, false);
  assert.equal(rep.completeFlagSet, false);
  assert.equal(rep.globalProof, false);
  assert.equal(rep.localSimulationOnly, true);
  assert.equal(rep.syntheticOnly, !realMode);
  assert.equal(rep.pepperVerified, false);
  assert.equal(rep.appBindingAllowed, false);
  assert.ok(RUNNER_STATUSES.includes(rep.status));
  if (rep.reason !== null) assert.ok(RUNNER_REASONS.includes(rep.reason));
  const s = JSON.stringify(rep);
  for (const forbidden of [D1_TOKEN, R2_ACCESS_KEY, R2_SECRET_KEY, SENTINEL, 'SELECT', 'INSERT', 'UPDATE', 'DELETE', d.databaseId, d.bucket]) {
    assert.ok(!s.includes(forbidden), `Report leaked forbidden token/identifier: ${forbidden}`);
  }
}

// (1) Happy path: Object upload -> chunks -> readbacks -> final GET -> COMPLETE_SYNTHETIC_RECONCILED
test('1: happy path - object -> chunks -> readbacks -> final GET -> COMPLETE_SYNTHETIC_RECONCILED', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  assert.match(baselineSha256, /^[0-9a-f]{64}$/);
  assert.equal(baseline.jenis_dokumen.length, 11);
  assert.equal(baseline.jenis_dokumen_wajib.length, 22);

  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  const events = [];
  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method) => {
      events.push(`r2_${method.toLowerCase()}`);
    },
  });
  const d1Stub = createD1FetchStub(db, d, {
    onBeforeBatch: ({ isSelect }) => {
      events.push(isSelect ? 'd1_read' : 'd1_write');
    },
  });

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'COMPLETE_SYNTHETIC_RECONCILED');
  assert.equal(rep.reason, null);
  assert.equal(rep.reconciled, true);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.allChunksObserved, true);
  assert.equal(rep.phase, 'DONE');
  assert.equal(rep.counts.objectsTotal, 1);
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 1);
  assert.equal(rep.counts.chunksTotal, artifact.chunkCount);
  assert.equal(rep.counts.chunksObserved, artifact.chunkCount);
  assert.equal(rep.counts.d1Sends, artifact.chunkCount);
  assert.equal(rep.counts.r2Transfers, 1);

  // Call sequence order: initial readback before any R2 PUT, then R2 PUT + verify GET, then per chunk pre-read/write/post-read
  const expectedEvents = [
    'd1_read',
    'r2_put',
    'r2_get',
    ...Array.from({ length: artifact.chunkCount }, () => ['d1_read', 'd1_write', 'd1_read']).flat(),
    'r2_get',
    'd1_read',
  ];
  assert.deepEqual(events, expectedEvents);

  const expectedReadCount = 2 * artifact.chunkCount + 2;
  const expectedWriteCount = artifact.chunkCount;
  assert.equal(d1Stub.getCounts().readCount, expectedReadCount);
  assert.equal(d1Stub.getCounts().writeCount, expectedWriteCount);
  assert.equal(d1Stub.getCounts().postCount, expectedReadCount + expectedWriteCount);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.equal(r2Fake.getCounts().getCount, 2);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(events.length, expectedEvents.length);
  assert.equal(d1Stub.calls.length, expectedReadCount + expectedWriteCount);
  assert.equal(r2Fake.calls.length, 3);

  // DB ledger and rows verification
  const run = await db.prepare(`SELECT * FROM ${RUN} WHERE id = 1`).first();
  assert.equal(run.stage, 7);
  assert.equal(run.cursor, 0);
  assert.equal(run.complete, 0);
  assert.equal(run.ordinal, artifact.chunkCount);
  assert.equal(run.last_chunk_sha256, artifact.chunks[artifact.chunkCount - 1].chunkSha256);

  const journalRows = (await db.prepare(`SELECT COUNT(*) as c FROM ${LEDGER.journalTable}`).first()).c;
  assert.equal(journalRows, artifact.chunkCount);

  const pegawaiCount = (await db.prepare('SELECT COUNT(*) as c FROM pegawai').first()).c;
  assert.equal(pegawaiCount, 2);

  // Positive control: normal synthetic import fits well within readback capacity budget
  const happyRowBytes = IMPORT_TABLES.reduce((sum, tbl) =>
    sum + [...baseline[tbl], ...data[tbl]].reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r), 'utf8') + 1, 0), 0);
  assert.ok(happyRowBytes < READBACK_BUDGET_BYTES, 'Happy path row bytes must be strictly within READBACK_BUDGET_BYTES');

  checkReportSafety(rep, d);
});

// (2) Wrong baseline hash / initial row tamper / missing bootstrap -> STOP before PUT or D1 writes
test('2: wrong baseline hash / initial row tamper / missing bootstrap -> STOP before PUT or D1 writes', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  // 2a: Wrong baseline hash
  const dWrongBaseline = descriptor({ baselineSha256: 'f'.repeat(64) });
  const r2Fake1 = createR2FetchFake();
  const d1Stub1 = createD1FetchStub(db, dWrongBaseline);
  const snap1 = await snapshot(db);

  const rep1 = await runSyntheticImport({
    descriptor: dWrongBaseline, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep1.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep1.reason, 'BASELINE_HASH_MISMATCH');
  assert.equal(r2Fake1.getCounts().putCount, 0);
  assert.equal(d1Stub1.getCounts().writeCount, 0);
  assert.equal(await snapshot(db), snap1);
  checkReportSafety(rep1, dWrongBaseline);

  // 2b: Foreign run nonce in bootstrap row (must be valid 32-char hex)
  const foreignNonce = 'b'.repeat(32);
  await db.prepare(`UPDATE ${RUN} SET run_nonce = ? WHERE id = 1`).bind(foreignNonce).run();
  const r2Fake2 = createR2FetchFake();
  const d1Stub2 = createD1FetchStub(db, d);
  const snap2 = await snapshot(db);

  const rep2 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub2.fetchImpl, r2FetchImpl: r2Fake2.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep2.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep2.reason, 'RUN_MISMATCH');
  assert.equal(r2Fake2.getCounts().putCount, 0);
  assert.equal(d1Stub2.getCounts().writeCount, 0);
  assert.equal(await snapshot(db), snap2);
  checkReportSafety(rep2, d);

  // 2c: Missing bootstrap row
  await db.prepare(`DELETE FROM ${RUN}`).run();
  const r2Fake3 = createR2FetchFake();
  const d1Stub3 = createD1FetchStub(db, d);
  const snap3 = await snapshot(db);

  const rep3 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub3.fetchImpl, r2FetchImpl: r2Fake3.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep3.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep3.reason, 'RUN_MISSING');
  assert.equal(r2Fake3.getCounts().putCount, 0);
  assert.equal(d1Stub3.getCounts().writeCount, 0);
  assert.equal(await snapshot(db), snap3);
  checkReportSafety(rep3, d);
});

// (3) Wrong artifact tables / objects coverage mismatch -> STOP before any writes
test('3: wrong artifact tables / objects coverage mismatch -> STOP before any writes', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  // 3a: Mutated tables -> artifact mismatch
  const mutatedData = makeTables(r2Key);
  mutatedData.pegawai[0].nama = 'Tampered Sentinel In Plan Tables';
  const r2Fake1 = createR2FetchFake();
  const d1Stub1 = createD1FetchStub(db, d);

  const rep1 = await runSyntheticImport({
    descriptor: d, artifact, tables: mutatedData, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep1.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep1.reason, 'ARTIFACT_MISMATCH');
  assert.equal(r2Fake1.getCounts().putCount, 0);
  assert.equal(d1Stub1.getCounts().writeCount, 0);
  checkReportSafety(rep1, d);

  // 3b: Missing object for arsip_dokumen
  const rep2 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects: [], baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep2.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep2.reason, 'OBJECT_MISSING');
  assert.equal(r2Fake1.getCounts().putCount, 0);
  assert.equal(d1Stub1.getCounts().writeCount, 0);

  // 3c: Extra unreferenced object
  const extraHash = h(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39, 0x39, 0x0a]));
  const extraKey = `migration/${d.snapshotId}/objects/${extraHash}.pdf`;
  const extraObjects = [
    ...objects,
    { key: extraKey, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39, 0x39, 0x0a]), mimeType: 'application/pdf', sha256: extraHash },
  ];

  const rep3 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects: extraObjects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep3.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep3.reason, 'OBJECT_UNREFERENCED');
  assert.equal(r2Fake1.getCounts().putCount, 0);
  assert.equal(d1Stub1.getCounts().writeCount, 0);

  // 3d: Object metadata mismatch (size)
  const metaMismatchData = makeTables(r2Key);
  metaMismatchData.arsip_dokumen[0].size_bytes = 99999;
  const metaMismatchArtifact = compileChunks({ tables: metaMismatchData }, d, { now: NOW });

  const rep4 = await runSyntheticImport({
    descriptor: d, artifact: metaMismatchArtifact, tables: metaMismatchData, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep4.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep4.reason, 'OBJECT_METADATA_MISMATCH');
  assert.equal(r2Fake1.getCounts().putCount, 0);
  assert.equal(d1Stub1.getCounts().writeCount, 0);

  // 3e: Non-null pegawai.foto_r2_key with recompiled artifact -> STOPPED_PREFLIGHT_MISMATCH / PHOTO_UNSUPPORTED
  const photoData = makeTables(r2Key);
  photoData.pegawai[0].foto_r2_key = `migration/${d.snapshotId}/objects/${h('photo')}.jpg`;
  const photoArtifact = compileChunks({ tables: photoData }, d, { now: NOW });
  const r2Fake5 = createR2FetchFake();
  const d1Stub5 = createD1FetchStub(db, d);
  const snap3e = await snapshot(db);

  const rep5 = await runSyntheticImport({
    descriptor: d, artifact: photoArtifact, tables: photoData, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub5.fetchImpl, r2FetchImpl: r2Fake5.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep5.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep5.reason, 'PHOTO_UNSUPPORTED');
  assert.equal(rep5.phase, 'PREFLIGHT');
  assert.equal(d1Stub5.getCounts().postCount, 0);
  assert.equal(d1Stub5.getCounts().readCount, 0);
  assert.equal(d1Stub5.getCounts().writeCount, 0);
  assert.equal(r2Fake5.getCounts().putCount, 0);
  assert.equal(r2Fake5.getCounts().getCount, 0);
  assert.equal(r2Fake5.getCounts().deleteCount, 0);
  assert.equal(await snapshot(db), snap3e);
  assert.equal(rep5.reconciled, false);
  assert.equal(rep5.baselineHashVerified, false);
  assert.equal(rep5.allChunksObserved, false);
  assert.equal(rep5.manualRecoveryRequired, false);
  assert.equal(rep5.objectsMayRemain, false);
  checkReportSafety(rep5, d);

  // 3f: Legacy key filename hash != byte hash (plan r2_key = that wrong key, archive sha/size/mime =
  // actual bytes, artifact recompiled) -> only the object filename binding fails, before any fetch.
  const wrongKey = r2KeyFor(d, 'b'.repeat(64));
  const wrongData = makeTables(wrongKey);
  const wrongArtifact = compileChunks({ tables: wrongData }, d, { now: NOW });
  const r2Fake6 = createR2FetchFake();
  const d1Stub6 = createD1FetchStub(db, d);
  const rep6 = await runSyntheticImport({
    descriptor: d, artifact: wrongArtifact, tables: wrongData, objects: makeObjects(wrongKey), baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub6.fetchImpl, r2FetchImpl: r2Fake6.fetchImpl, nowProvider: () => NOW,
  });
  assert.deepEqual([rep6.status, rep6.reason, rep6.phase], ['STOPPED_INPUT_INVALID', 'OBJECTS_INVALID', 'PREFLIGHT']);
  assert.equal(d1Stub6.getCounts().postCount, 0);
  assert.equal(r2Fake6.calls.length, 0);
  assert.equal(await snapshot(db), snap3e);
  checkReportSafety(rep6, d);
});

// (4) R2 412 and GET mismatch -> STOP with no D1 writes and no DELETE
test('4: R2 412 and GET mismatch -> STOP with no D1 writes and no DELETE', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  // 4a: R2 412 precondition failed
  const r2Fake1 = createR2FetchFake();
  // Pre-populate storage so PUT receives 412
  const fullUrl = `https://${d.accountId}.r2.cloudflarestorage.com/${d.bucket}/${r2Key}`;
  r2Fake1.r2Storage.set(fullUrl, { bytes: PDF_BYTES, mimeType: 'application/pdf' });
  const d1Stub1 = createD1FetchStub(db, d);

  const rep1 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep1.status, 'STOPPED_R2_FAILED');
  assert.equal(rep1.reason, 'CONFLICT');
  assert.equal(d1Stub1.getCounts().writeCount, 0);
  assert.equal(r2Fake1.getCounts().deleteCount, 0);
  assert.equal(rep1.objectsMayRemain, true);
  assert.equal(rep1.reconciled, false);
  checkReportSafety(rep1, d);

  // 4b: Verify GET returns 404
  const r2Fake2 = createR2FetchFake({
    onBeforeRequest: (method) => {
      if (method === 'GET') return new Response(null, { status: 404 });
    },
  });
  const d1Stub2 = createD1FetchStub(db, d);

  const rep2 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub2.fetchImpl, r2FetchImpl: r2Fake2.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep2.status, 'STOPPED_R2_FAILED');
  assert.equal(rep2.reason, 'HALT_AMBIGUOUS');
  assert.equal(d1Stub2.getCounts().writeCount, 0);
  assert.equal(r2Fake2.getCounts().deleteCount, 0);
  assert.equal(rep2.reconciled, false);
});

// (5) D1 fetch throws after batch commit -> ambiguous halt, single observation, no resend
test('5: D1 fetch throws after batch commit -> ambiguous halt, single observation, no resend', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  const r2Fake = createR2FetchFake();
  let observationReadCount = 0;
  const d1Stub = createD1FetchStub(db, d, {
    onAfterBatch: ({ isSelect, writeCount }) => {
      if (!isSelect && writeCount === 1) {
        throw new Error('Network timeout/reset after D1 chunk commit');
      }
      if (isSelect && writeCount === 1) {
        observationReadCount++;
      }
    },
  });

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_D1_AMBIGUOUS');
  assert.equal(rep.reason, 'FETCH_FAILED');
  assert.equal(rep.ambiguousOutcomeObserved, true);
  assert.equal(rep.observation, 'COMMITTED_OBSERVED');
  assert.equal(rep.counts.d1Sends, 1); // exactly 1 send, NO resend
  assert.equal(rep.counts.chunksObserved, 1);
  assert.equal(observationReadCount, 1); // at most one observation read
  assert.equal(rep.authorizesRetry, false);
  assert.equal(rep.authorizesResume, false);
  assert.equal(rep.reconciled, false);
  assert.equal(rep.manualRecoveryRequired, true);

  // Check that chunk 0 committed in DB and chunk 1 was not sent
  const run = await db.prepare(`SELECT * FROM ${RUN} WHERE id = 1`).first();
  assert.equal(run.ordinal, 1);
  checkReportSafety(rep, d);

  // 5b: Ambiguous first D1 write actual commit throw + next readback HTTP 500
  const db5b = await openDb(t);
  const baseline5b = await readBaseline(db5b);
  const baselineSha256_5b = hashBaseline(baseline5b);
  const d5b = descriptor({ baselineSha256: baselineSha256_5b });
  await bootstrap(db5b, d5b);
  const r2Key5b = r2KeyFor(d5b);
  const data5b = makeTables(r2Key5b);
  const artifact5b = compileChunks({ tables: data5b }, d5b, { now: NOW });
  const objects5b = makeObjects(r2Key5b);

  const r2Fake5b = createR2FetchFake();
  let observationAttempts = 0;
  const d1Stub5b = createD1FetchStub(db5b, d5b, {
    onBeforeBatch: ({ isSelect, writeCount }) => {
      if (isSelect && writeCount === 1) {
        observationAttempts++;
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'internal' }], messages: [], result: [] }), {
          status: 500, headers: { 'content-type': 'application/json' },
        });
      }
    },
    onAfterBatch: ({ isSelect, writeCount }) => {
      if (!isSelect && writeCount === 1) {
        throw new Error('Network timeout after commit');
      }
    },
  });

  const rep5b = await runSyntheticImport({
    descriptor: d5b, artifact: artifact5b, tables: data5b, objects: objects5b, baseline: baseline5b,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub5b.fetchImpl, r2FetchImpl: r2Fake5b.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep5b.status, 'STOPPED_READBACK_FAILED');
  assert.equal(rep5b.reason, 'HTTP_STATUS');
  assert.equal(rep5b.ambiguousOutcomeObserved, true);
  assert.equal(rep5b.manualRecoveryRequired, true);
  assert.equal(rep5b.observation, null);
  assert.equal(rep5b.authorizesRetry, false);
  assert.equal(rep5b.reconciled, false);
  assert.equal(rep5b.counts.d1Sends, 1);
  assert.equal(observationAttempts, 1);
  checkReportSafety(rep5b, d5b);
});

// (6) Post-read row tamper after D1 commit -> STOPPED_D1_STATE_MISMATCH and no next chunk
test('6: post-read row tamper after D1 commit -> STOPPED_D1_STATE_MISMATCH and no next chunk', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  const r2Fake = createR2FetchFake();
  const d1Stub = createD1FetchStub(db, d, {
    onAfterBatch: async ({ isSelect, writeCount }) => {
      // Tamper row immediately after chunk 0 commit
      if (!isSelect && writeCount === 1) {
        await db.prepare("UPDATE jenis_dokumen SET nama = 'Tampered After Commit' WHERE id = 'DOC-KTP'").run();
      }
    },
  });

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_D1_STATE_MISMATCH');
  assert.equal(rep.reason, 'ROWS_MISMATCH');
  assert.equal(rep.counts.d1Sends, 1); // stopped immediately, no next chunk
  assert.equal(rep.reconciled, false);
  checkReportSafety(rep, d);

  // 6b: Duplicate readback row IDs in post-read (HIGH security fix)
  const db6b = await openDb(t);
  const baseline6b = await readBaseline(db6b);
  const baselineSha256_6b = hashBaseline(baseline6b);
  const d6b = descriptor({ baselineSha256: baselineSha256_6b });
  await bootstrap(db6b, d6b);
  const r2Key6b = r2KeyFor(d6b);
  const data6b = makeTables(r2Key6b);
  const artifact6b = compileChunks({ tables: data6b }, d6b, { now: NOW });
  const objects6b = makeObjects(r2Key6b);

  const r2Fake6b = createR2FetchFake();
  const d1BaseStub6b = createD1FetchStub(db6b, d6b);
  const d1WrappedFetchImpl = async (url, init) => {
    const res = await d1BaseStub6b.fetchImpl(url, init);
    const { batch } = JSON.parse(init.body);
    const isSelect = batch.length === 9 && batch[0].sql.startsWith('SELECT');
    if (isSelect && d1BaseStub6b.getCounts().writeCount === 3) {
      // Chunk 2 (pegawai) just committed. Mutate readback response to duplicate pegawai row 0 into row 1
      const json = await res.json();
      if (json.result[4]?.results?.length >= 2) {
        json.result[4].results[1] = { ...json.result[4].results[0] };
      }
      return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return res;
  };

  const rep6b = await runSyntheticImport({
    descriptor: d6b, artifact: artifact6b, tables: data6b, objects: objects6b, baseline: baseline6b,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1WrappedFetchImpl, r2FetchImpl: r2Fake6b.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep6b.status, 'STOPPED_D1_STATE_MISMATCH');
  assert.equal(rep6b.reason, 'ROWS_MISMATCH');
  assert.equal(rep6b.counts.d1Sends, 3); // stopped after chunk 2 post-read, chunk 3 not sent
  assert.equal(rep6b.reconciled, false);
  checkReportSafety(rep6b, d6b);
});

// (7) Final R2 GET tamper -> STOPPED_FINAL_OBJECT_MISMATCH after all D1 writes committed
test('7: final R2 GET tamper -> STOPPED_FINAL_OBJECT_MISMATCH after all D1 writes committed', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method, _url, _init, { getCount }) => {
      // First GET (transfer verification) succeeds.
      // Second GET (final object recheck) returns tampered bytes.
      if (method === 'GET' && getCount === 1) {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xde, 0xad, 0xbe, 0xef]), {
          status: 200, headers: { 'content-type': 'application/pdf' },
        });
      }
    },
  });
  const d1Stub = createD1FetchStub(db, d);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep.reason, 'OBJECT_MISMATCH');
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.equal(rep.counts.d1Sends, artifact.chunkCount); // all D1 chunks committed
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 0); // failed recheck
  assert.equal(rep.reconciled, false);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(rep.counts.r2Gets, 1);
  assert.equal(d1Stub.calls.length, 1 + 3 * artifact.chunkCount);
  checkReportSafety(rep, d);

  // 7b: Stalled final GET reader canceled on timeout
  const db7b = await openDb(t);
  const baseline7b = await readBaseline(db7b);
  const baselineSha256_7b = hashBaseline(baseline7b);
  const d7b = descriptor({ baselineSha256: baselineSha256_7b });
  await bootstrap(db7b, d7b);
  const r2Key7b = r2KeyFor(d7b);
  const data7b = makeTables(r2Key7b);
  const artifact7b = compileChunks({ tables: data7b }, d7b, { now: NOW });
  const objects7b = makeObjects(r2Key7b);

  let streamCanceled = false;
  const r2Fake7b = createR2FetchFake({
    onBeforeRequest: (method, _url, _init, { getCount }) => {
      if (method === 'GET' && getCount === 1) {
        const stalledStream = new ReadableStream({
          start() {},
          pull() {},
          cancel() { streamCanceled = true; },
        });
        return new Response(stalledStream, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
    },
  });
  const d1Stub7b = createD1FetchStub(db7b, d7b);

  const rep7b = await runSyntheticImport({
    descriptor: d7b, artifact: artifact7b, tables: data7b, objects: objects7b, baseline: baseline7b,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub7b.fetchImpl, r2FetchImpl: r2Fake7b.fetchImpl, nowProvider: () => NOW,
    timeoutMs: 150,
  });

  assert.equal(rep7b.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep7b.reason, 'GET_TIMEOUT');
  assert.equal(rep7b.phase, 'FINAL_OBJECTS');
  assert.equal(streamCanceled, true);
  assert.equal(rep7b.reconciled, false);
  checkReportSafety(rep7b, d7b);

  // 7c: Late final GET response canceled after timeout
  const db7c = await openDb(t);
  const baseline7c = await readBaseline(db7c);
  const baselineSha256_7c = hashBaseline(baseline7c);
  const d7c = descriptor({ baselineSha256: baselineSha256_7c });
  await bootstrap(db7c, d7c);
  const r2Key7c = r2KeyFor(d7c);
  const data7c = makeTables(r2Key7c);
  const artifact7c = compileChunks({ tables: data7c }, d7c, { now: NOW });
  const objects7c = makeObjects(r2Key7c);

  let lateBodyCanceled = false;
  const r2Fake7c = createR2FetchFake({
    onBeforeRequest: async (method, _url, _init, { getCount }) => {
      if (method === 'GET' && getCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const lateStream = new ReadableStream({
          start() {},
          pull() {},
          cancel() { lateBodyCanceled = true; },
        });
        return new Response(lateStream, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
    },
  });
  const d1Stub7c = createD1FetchStub(db7c, d7c);

  const rep7c = await runSyntheticImport({
    descriptor: d7c, artifact: artifact7c, tables: data7c, objects: objects7c, baseline: baseline7c,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub7c.fetchImpl, r2FetchImpl: r2Fake7c.fetchImpl, nowProvider: () => NOW,
    timeoutMs: 150,
  });

  assert.equal(rep7c.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep7c.reason, 'GET_TIMEOUT');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lateBodyCanceled, true);
  assert.equal(rep7c.reconciled, false);
  checkReportSafety(rep7c, d7c);
});

// (8) Expiry advancement halts next write, clock rollback invalid, profile real-data blocked
test('8: expiry advancement halts next write, clock rollback invalid, profile real-data blocked', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  // 8a: Expiry advancement past descriptor.expiresAt ('2026-10-18T04:00:00.000Z') before D1 write
  let clockTime = NOW;
  const r2Fake1 = createR2FetchFake({
    onBeforeRequest: (method) => {
      // After object transfer GET completes, advance clock past descriptor expiry
      if (method === 'GET') clockTime = '2026-10-18T04:00:01.000Z';
    },
  });
  const d1Stub1 = createD1FetchStub(db, d);

  const rep1 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl, nowProvider: () => clockTime,
  });

  assert.equal(rep1.status, 'STOPPED_DESCRIPTOR_EXPIRED');
  assert.equal(rep1.reason, 'DESCRIPTOR_EXPIRED');
  assert.equal(rep1.counts.d1Sends, 0); // NEXT write prevented
  assert.equal(rep1.objectsMayRemain, true); // R2 object was transferred
  assert.equal(rep1.reconciled, false);
  checkReportSafety(rep1, d);

  // 8b: Clock rollback (non-monotonic)
  let ticks = 0;
  const rep2 = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub1.fetchImpl, r2FetchImpl: r2Fake1.fetchImpl,
    nowProvider: () => {
      ticks++;
      return ticks > 2 ? '2026-10-17T23:00:00.000Z' : NOW;
    },
  });

  assert.equal(rep2.status, 'STOPPED_CLOCK_INVALID');
  assert.equal(rep2.reason, 'NOW_NOT_MONOTONE');
  assert.equal(rep2.reconciled, false);

  // 8c: Profile real-data blocked with zero fetch calls
  const dReal = descriptor({ profile: 'real-data', baselineSha256 });
  const r2Fake3 = createR2FetchFake();
  const d1Stub3 = createD1FetchStub(db, dReal);

  const rep3 = await runSyntheticImport({
    descriptor: dReal, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub3.fetchImpl, r2FetchImpl: r2Fake3.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep3.status, 'STOPPED_PROFILE_BLOCKED');
  assert.equal(rep3.reason, 'PROFILE_BLOCKED');
  assert.equal(d1Stub3.getCounts().postCount, 0);
  assert.equal(r2Fake3.getCounts().putCount, 0);
  assert.equal(r2Fake3.getCounts().getCount, 0);
  checkReportSafety(rep3, dReal);
});

// (9) Final GET boundary - oversized streaming body -> cancel stream and STOPPED_FINAL_OBJECT_MISMATCH / OBJECT_MISMATCH
test('9: final GET boundary - oversized streaming body cancels reader and halts with OBJECT_MISMATCH', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  let streamCanceled = false;
  let finalGetInit = null;
  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method, _url, init, { getCount }) => {
      // First GET (transfer verification) succeeds normally.
      // Second GET (final object recheck) returns an oversized stream.
      if (method === 'GET' && getCount === 1) {
        finalGetInit = init;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(PDF_BYTES);
            controller.enqueue(new Uint8Array([0x45, 0x58, 0x54, 0x52, 0x41]));
          },
          cancel() {
            streamCanceled = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(PDF_BYTES.byteLength),
          },
        });
      }
    },
  });
  const d1Stub = createD1FetchStub(db, d);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep.reason, 'OBJECT_MISMATCH');
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.equal(rep.reconciled, false);
  assert.equal(rep.allChunksObserved, false);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.objectsMayRemain, true);
  assert.equal(rep.manualRecoveryRequired, true);
  assert.equal(streamCanceled, true);
  assert.equal(rep.counts.d1Sends, artifact.chunkCount);
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 0);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal(d1Stub.getCounts().readCount, 1 + 2 * artifact.chunkCount);
  assert.equal(d1Stub.calls.length, 1 + 3 * artifact.chunkCount);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(rep.counts.r2Gets, 1);
  assert.ok(finalGetInit !== null);
  assert.equal(finalGetInit.method, 'GET');
  assert.equal(finalGetInit.redirect, 'error');
  checkReportSafety(rep, d);
});

// (10) Final GET boundary - redirect rejection (redirected: true) -> STOPPED_FINAL_OBJECT_MISMATCH / GET_UNTRUSTED
test('10: final GET boundary - redirect rejection (redirected: true) -> STOPPED_FINAL_OBJECT_MISMATCH / GET_UNTRUSTED', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  let finalGetInit = null;
  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method, _url, init, { getCount }) => {
      if (method === 'GET' && getCount === 1) {
        finalGetInit = init;
        const res = new Response(new Uint8Array(PDF_BYTES), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
        Object.defineProperty(res, 'redirected', { value: true, configurable: true });
        return res;
      }
    },
  });
  const d1Stub = createD1FetchStub(db, d);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep.reason, 'GET_UNTRUSTED');
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.equal(rep.reconciled, false);
  assert.equal(rep.allChunksObserved, false);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.objectsMayRemain, true);
  assert.equal(rep.manualRecoveryRequired, true);
  assert.equal(rep.counts.d1Sends, artifact.chunkCount);
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 0);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal(d1Stub.getCounts().readCount, 1 + 2 * artifact.chunkCount);
  assert.equal(d1Stub.calls.length, 1 + 3 * artifact.chunkCount);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(rep.counts.r2Gets, 1);
  assert.ok(finalGetInit !== null);
  assert.equal(finalGetInit.method, 'GET');
  assert.equal(finalGetInit.redirect, 'error');
  checkReportSafety(rep, d);
});

// (11) Final GET boundary - untrusted response URL -> STOPPED_FINAL_OBJECT_MISMATCH / GET_UNTRUSTED
test('11: final GET boundary - untrusted response URL -> STOPPED_FINAL_OBJECT_MISMATCH / GET_UNTRUSTED', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  let finalGetInit = null;
  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method, _url, init, { getCount }) => {
      if (method === 'GET' && getCount === 1) {
        finalGetInit = init;
        const res = new Response(new Uint8Array(PDF_BYTES), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
        Object.defineProperty(res, 'url', { value: 'https://attacker.example.com/spoofed/file.pdf', configurable: true });
        return res;
      }
    },
  });
  const d1Stub = createD1FetchStub(db, d);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep.reason, 'GET_UNTRUSTED');
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.equal(rep.reconciled, false);
  assert.equal(rep.allChunksObserved, false);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.objectsMayRemain, true);
  assert.equal(rep.manualRecoveryRequired, true);
  assert.equal(rep.counts.d1Sends, artifact.chunkCount);
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 0);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal(d1Stub.getCounts().readCount, 1 + 2 * artifact.chunkCount);
  assert.equal(d1Stub.calls.length, 1 + 3 * artifact.chunkCount);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(rep.counts.r2Gets, 1);
  assert.ok(finalGetInit !== null);
  assert.equal(finalGetInit.method, 'GET');
  assert.equal(finalGetInit.redirect, 'error');
  checkReportSafety(rep, d);
});

// (12) Final GET boundary - wrong MIME same correct bytes -> STOPPED_FINAL_OBJECT_MISMATCH / OBJECT_MISMATCH
test('12: final GET boundary - wrong MIME same correct bytes -> STOPPED_FINAL_OBJECT_MISMATCH / OBJECT_MISMATCH', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  let finalGetInit = null;
  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method, _url, init, { getCount }) => {
      if (method === 'GET' && getCount === 1) {
        finalGetInit = init;
        return new Response(new Uint8Array(PDF_BYTES), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
    },
  });
  const d1Stub = createD1FetchStub(db, d);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep.reason, 'OBJECT_MISMATCH');
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.equal(rep.reconciled, false);
  assert.equal(rep.allChunksObserved, false);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.objectsMayRemain, true);
  assert.equal(rep.manualRecoveryRequired, true);
  assert.equal(rep.counts.d1Sends, artifact.chunkCount);
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 0);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal(d1Stub.getCounts().readCount, 1 + 2 * artifact.chunkCount);
  assert.equal(d1Stub.calls.length, 1 + 3 * artifact.chunkCount);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(rep.counts.r2Gets, 1);
  assert.ok(finalGetInit !== null);
  assert.equal(finalGetInit.method, 'GET');
  assert.equal(finalGetInit.redirect, 'error');
  checkReportSafety(rep, d);
});

// (13) Final GET boundary - short body -> STOPPED_FINAL_OBJECT_MISMATCH / OBJECT_MISMATCH
test('13: final GET boundary - short body -> STOPPED_FINAL_OBJECT_MISMATCH / OBJECT_MISMATCH', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  let finalGetInit = null;
  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method, _url, init, { getCount }) => {
      if (method === 'GET' && getCount === 1) {
        finalGetInit = init;
        return new Response(PDF_BYTES.slice(0, 4), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
    },
  });
  const d1Stub = createD1FetchStub(db, d);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep.reason, 'OBJECT_MISMATCH');
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.equal(rep.reconciled, false);
  assert.equal(rep.allChunksObserved, false);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.objectsMayRemain, true);
  assert.equal(rep.manualRecoveryRequired, true);
  assert.equal(rep.counts.d1Sends, artifact.chunkCount);
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 0);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal(d1Stub.getCounts().readCount, 1 + 2 * artifact.chunkCount);
  assert.equal(d1Stub.calls.length, 1 + 3 * artifact.chunkCount);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(rep.counts.r2Gets, 1);
  assert.ok(finalGetInit !== null);
  assert.equal(finalGetInit.method, 'GET');
  assert.equal(finalGetInit.redirect, 'error');
  checkReportSafety(rep, d);
});

// (14) Final GET boundary - non-200 HTTP status -> STOPPED_FINAL_OBJECT_MISMATCH / GET_STATUS
test('14: final GET boundary - non-200 HTTP status -> STOPPED_FINAL_OBJECT_MISMATCH / GET_STATUS', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  let finalGetInit = null;
  const r2Fake = createR2FetchFake({
    onBeforeRequest: (method, _url, init, { getCount }) => {
      if (method === 'GET' && getCount === 1) {
        finalGetInit = init;
        return new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'content-type': 'text/plain' },
        });
      }
    },
  });
  const d1Stub = createD1FetchStub(db, d);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.equal(rep.reason, 'GET_STATUS');
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.equal(rep.reconciled, false);
  assert.equal(rep.allChunksObserved, false);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.objectsMayRemain, true);
  assert.equal(rep.manualRecoveryRequired, true);
  assert.equal(rep.counts.d1Sends, artifact.chunkCount);
  assert.equal(rep.counts.objectsVerified, 1);
  assert.equal(rep.counts.objectsRechecked, 0);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal(d1Stub.getCounts().readCount, 1 + 2 * artifact.chunkCount);
  assert.equal(d1Stub.calls.length, 1 + 3 * artifact.chunkCount);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'GET']);
  assert.equal(rep.counts.r2Gets, 1);
  assert.ok(finalGetInit !== null);
  assert.equal(finalGetInit.method, 'GET');
  assert.equal(finalGetInit.redirect, 'error');
  checkReportSafety(rep, d);
});

// (15) Capacity preflight - fixture exceeding READBACK_BUDGET_BYTES -> STOPPED_PREFLIGHT_MISMATCH / READBACK_CAPACITY
test('15: capacity preflight - fixture exceeding READBACK_BUDGET_BYTES stops before any fetch with unchanged DB', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const baselineSha256 = hashBaseline(baseline);
  const d = descriptor({ baselineSha256 });
  await bootstrap(db, d);
  const r2Key = r2KeyFor(d);
  const data = makeTables(r2Key);

  // Replace log_aktivitas with 10k rows of 630 characters (~7 MB row data, exceeding 6MiB budget)
  data.log_aktivitas = [];
  const logPayload = 'L'.repeat(630);
  for (let i = 1; i <= 10_000; i++) {
    data.log_aktivitas.push(canonicalRow('log_aktivitas', {
      id: i,
      ts: CREATED,
      action: 'SYN_LOG',
      result: 'SUCCESS',
      description: logPayload,
    }));
  }

  // Independently verify that raw serialized row bytes exceed READBACK_BUDGET_BYTES
  const independentRowBytes = IMPORT_TABLES.reduce((sum, tbl) =>
    sum + [...baseline[tbl], ...data[tbl]].reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r), 'utf8') + 1, 0), 0);
  assert.ok(independentRowBytes > READBACK_BUDGET_BYTES,
    `Independent row bytes (${independentRowBytes}) must exceed READBACK_BUDGET_BYTES (${READBACK_BUDGET_BYTES})`);

  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const objects = makeObjects(r2Key);

  // Assert baseline+plan rows <= ROW_LIMITS.tables and chunkCount <= ROW_LIMITS.journal
  // to prove rejection is definitely from byte capacity and not row/chunk limits
  const totalRows = IMPORT_TABLES.reduce((sum, tbl) => sum + baseline[tbl].length + data[tbl].length, 0);
  assert.ok(totalRows <= ROW_LIMITS.tables,
    `Total rows (${totalRows}) must be <= ROW_LIMITS.tables (${ROW_LIMITS.tables})`);
  assert.ok(artifact.chunkCount <= ROW_LIMITS.journal,
    `Chunk count (${artifact.chunkCount}) must be <= ROW_LIMITS.journal (${ROW_LIMITS.journal})`);

  const r2Fake = createR2FetchFake();
  const d1Stub = createD1FetchStub(db, d);
  const snapBefore = await snapshot(db);

  const rep = await runSyntheticImport({
    descriptor: d, artifact, tables: data, objects, baseline,
    d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
    d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
  });

  assert.equal(rep.status, 'STOPPED_PREFLIGHT_MISMATCH');
  assert.equal(rep.reason, 'READBACK_CAPACITY');
  assert.equal(rep.phase, 'PREFLIGHT');
  assert.equal(d1Stub.getCounts().postCount, 0);
  assert.equal(d1Stub.getCounts().readCount, 0);
  assert.equal(d1Stub.getCounts().writeCount, 0);
  assert.equal(r2Fake.getCounts().putCount, 0);
  assert.equal(r2Fake.getCounts().getCount, 0);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(await snapshot(db), snapBefore);
  assert.equal(rep.reconciled, false);
  assert.equal(rep.baselineHashVerified, false);
  assert.equal(rep.allChunksObserved, false);
  assert.equal(rep.manualRecoveryRequired, false);
  assert.equal(rep.objectsMayRemain, false);
  checkReportSafety(rep, d);
});

// ---- transform-canonical file keys: migration/<snapshot>/(document|photo)/<fileId>-<sha>.<ext> ----
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x08, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const DOC_ID = 'SynDoc_File-0001', PHOTO_ID = 'SynPhoto_File-0002';
const canonKey = (d, kind, fileId, bytes, ext) => `migration/${d.snapshotId}/${kind}/${fileId}-${h(bytes)}.${ext}`;
const obj = (key, bytes, mimeType, sha256 = h(bytes)) => ({ key, bytes: new Uint8Array(bytes), mimeType, sha256 });
function canonicalFixture(d) {
  const docKey = canonKey(d, 'document', DOC_ID, PDF_BYTES, 'pdf'), photoKey = canonKey(d, 'photo', PHOTO_ID, WEBP_BYTES, 'webp');
  const data = makeTables(docKey);
  data.pegawai[0].foto_r2_key = photoKey;
  return { docKey, photoKey, data, objects: [obj(docKey, PDF_BYTES, 'application/pdf'), obj(photoKey, WEBP_BYTES, 'image/webp')] };
}
const runArgs = (db, d, data, objects, baseline, r2Fake, d1Stub, artifact = compileChunks({ tables: data }, d, { now: NOW })) => ({
  descriptor: d, artifact, tables: data, objects, baseline,
  d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
  d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW,
});

test('16: canonical document + WEBP photo keys -> create-only PUT, verify GET, D1 chunks, final GET, reconciled', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const d = descriptor({ baselineSha256: hashBaseline(baseline) });
  await bootstrap(db, d);
  const { docKey, photoKey, data, objects } = canonicalFixture(d);
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const r2Fake = createR2FetchFake();
  const d1Stub = createD1FetchStub(db, d);
  const rep = await runSyntheticImport(runArgs(db, d, data, objects, baseline, r2Fake, d1Stub, artifact));

  assert.equal(rep.status, 'COMPLETE_SYNTHETIC_RECONCILED');
  assert.equal(rep.reason, null);
  assert.equal(rep.reconciled, true);
  assert.deepEqual([rep.counts.objectsTotal, rep.counts.objectsVerified, rep.counts.objectsRechecked, rep.counts.r2Transfers, rep.counts.r2Gets], [2, 2, 2, 2, 2]);
  const base = `https://${d.accountId}.r2.cloudflarestorage.com/${d.bucket}/`;
  // Exact keys (never rewritten): per object PUT + verify GET in input order, then one final GET each.
  assert.deepEqual(r2Fake.calls, [
    { method: 'PUT', url: base + docKey }, { method: 'GET', url: base + docKey },
    { method: 'PUT', url: base + photoKey }, { method: 'GET', url: base + photoKey },
    { method: 'GET', url: base + docKey }, { method: 'GET', url: base + photoKey },
  ]);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.deepEqual([...r2Fake.r2Storage.keys()].sort(), [base + docKey, base + photoKey].sort());
  assert.equal(r2Fake.r2Storage.get(base + photoKey).mimeType, 'image/webp');
  assert.equal(h(r2Fake.r2Storage.get(base + photoKey).bytes), h(WEBP_BYTES));
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal(d1Stub.getCounts().readCount, 2 * artifact.chunkCount + 2);
  const rows = (await db.prepare('SELECT id, foto_r2_key FROM pegawai ORDER BY id').all()).results;
  assert.deepEqual(rows, [{ id: 900001, foto_r2_key: photoKey }, { id: 900002, foto_r2_key: null }]);
  assert.equal((await db.prepare('SELECT r2_key FROM arsip_dokumen WHERE id = 1').first()).r2_key, docKey);
  checkReportSafety(rep, d);
});

test('17: canonical file contract violations stop in preflight before ANY fetch (recompiled artifacts)', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const d = descriptor({ baselineSha256: hashBaseline(baseline) });
  await bootstrap(db, d);
  const snapBefore = await snapshot(db);
  const photoPdfKey = canonKey(d, 'photo', PHOTO_ID, PDF_BYTES, 'pdf');
  const badRiff = new Uint8Array(WEBP_BYTES); badRiff[4] = 0x09; // RIFF length != byteLength - 8
  const pngKey = canonKey(d, 'photo', 'SynPhoto_File-0003', PNG_BYTES, 'png');
  const cases = [
    ['archive references photo key', (f) => {
      Object.assign(f.data.arsip_dokumen[0], { r2_key: f.photoKey, mime_type: 'image/webp', size_bytes: WEBP_BYTES.byteLength, sha256: h(WEBP_BYTES), file_name: 'syn.webp' });
      f.data.pegawai[0].foto_r2_key = null;
    }, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_REF_UNSUPPORTED'],
    ['photo column references document key', (f) => { f.data.pegawai[1].foto_r2_key = f.docKey; }, 'STOPPED_PREFLIGHT_MISMATCH', 'PHOTO_UNSUPPORTED'],
    ['photo object as PDF', (f) => { f.data.pegawai[0].foto_r2_key = photoPdfKey; f.objects[1] = obj(photoPdfKey, PDF_BYTES, 'application/pdf'); }, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID'],
    ['filename hash differs from bytes', (f) => {
      const key = `migration/${d.snapshotId}/photo/${PHOTO_ID}-${'a'.repeat(64)}.webp`;
      f.data.pegawai[0].foto_r2_key = key; f.objects[1] = obj(key, WEBP_BYTES, 'image/webp');
    }, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID'],
    ['tampered RIFF length', (f) => {
      const key = canonKey(d, 'photo', PHOTO_ID, badRiff, 'webp');
      f.data.pegawai[0].foto_r2_key = key; f.objects[1] = obj(key, badRiff, 'image/webp');
    }, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID'],
    ['non-canonical uppercase extension', (f) => { f.objects[1] = obj(f.photoKey.replace(/\.webp$/, '.WEBP'), WEBP_BYTES, 'image/webp'); }, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID'],
    ['path traversal fileId', (f) => { f.objects.push(obj(`migration/${d.snapshotId}/photo/../${PHOTO_ID}-${h(PNG_BYTES)}.png`, PNG_BYTES, 'image/png')); }, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID'],
    ['missing photo object', (f) => { f.objects.pop(); }, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_MISSING'],
    ['photo shared by two employees', (f) => { f.data.pegawai[1].foto_r2_key = f.photoKey; }, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_REF_UNSUPPORTED'],
    ['orphan canonical photo object', (f) => { f.objects.push(obj(pngKey, PNG_BYTES, 'image/png')); }, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_UNREFERENCED'],
  ];
  for (const [name, mutate, status, reason] of cases) {
    const f = canonicalFixture(d);
    mutate(f);
    const r2Fake = createR2FetchFake();
    const d1Stub = createD1FetchStub(db, d);
    const rep = await runSyntheticImport(runArgs(db, d, f.data, f.objects, baseline, r2Fake, d1Stub));
    assert.deepEqual([rep.status, rep.reason, rep.phase], [status, reason, 'PREFLIGHT'], name);
    assert.equal(d1Stub.getCounts().postCount, 0, name);
    assert.equal(r2Fake.calls.length, 0, name);
    assert.equal(rep.objectsMayRemain, false, name);
    assert.equal(rep.manualRecoveryRequired, false, name);
    checkReportSafety(rep, d);
  }
  assert.equal(await snapshot(db), snapBefore);
});

test('18: canonical PUT 412 / verify-GET tamper -> STOPPED_R2_FAILED, no D1 write, no DELETE, no overwrite', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const d = descriptor({ baselineSha256: hashBaseline(baseline) });
  await bootstrap(db, d);
  const base = `https://${d.accountId}.r2.cloudflarestorage.com/${d.bucket}/`;

  const f1 = canonicalFixture(d);
  const r2Fake1 = createR2FetchFake();
  r2Fake1.r2Storage.set(base + f1.docKey, { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x30]), mimeType: 'application/pdf' });
  const d1Stub1 = createD1FetchStub(db, d);
  const rep1 = await runSyntheticImport(runArgs(db, d, f1.data, f1.objects, baseline, r2Fake1, d1Stub1));
  assert.deepEqual([rep1.status, rep1.reason], ['STOPPED_R2_FAILED', 'CONFLICT']);
  assert.deepEqual(r2Fake1.calls.map((c) => c.method), ['PUT']);
  assert.deepEqual(r2Fake1.r2Storage.get(base + f1.docKey).bytes, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x30]));
  assert.deepEqual([d1Stub1.getCounts().readCount, d1Stub1.getCounts().writeCount], [1, 0]);
  assert.equal(rep1.objectsMayRemain, true);
  assert.equal(rep1.manualRecoveryRequired, true);
  checkReportSafety(rep1, d);

  const f2 = canonicalFixture(d);
  const r2Fake2 = createR2FetchFake({
    onBeforeRequest: (method, url) => {
      if (method === 'GET' && url === base + f2.photoKey) return new Response(new Uint8Array(PNG_BYTES), { status: 200, headers: { 'content-type': 'image/webp' } });
    },
  });
  const d1Stub2 = createD1FetchStub(db, d);
  const rep2 = await runSyntheticImport(runArgs(db, d, f2.data, f2.objects, baseline, r2Fake2, d1Stub2));
  assert.deepEqual([rep2.status, rep2.reason], ['STOPPED_R2_FAILED', 'INTEGRITY_MISMATCH']);
  assert.deepEqual(r2Fake2.calls.map((c) => c.method), ['PUT', 'GET', 'PUT', 'GET']);
  assert.equal(r2Fake2.getCounts().deleteCount, 0);
  assert.deepEqual([d1Stub2.getCounts().readCount, d1Stub2.getCounts().writeCount], [1, 0]);
  checkReportSafety(rep2, d);
});

test('19: same JPEG fileId/bytes under document/ and photo/ keys -> two distinct objects, both transferred and rechecked', async (t) => {
  const db = await openDb(t);
  const baseline = await readBaseline(db);
  const d = descriptor({ baselineSha256: hashBaseline(baseline) });
  await bootstrap(db, d);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const fileId = 'SynShared_File-0009';
  const docKey = canonKey(d, 'document', fileId, jpeg, 'jpg'), photoKey = canonKey(d, 'photo', fileId, jpeg, 'jpg');
  const data = makeTables(docKey);
  Object.assign(data.arsip_dokumen[0], { mime_type: 'image/jpeg', size_bytes: jpeg.byteLength, sha256: h(jpeg), file_name: 'syn.jpg' });
  data.pegawai[0].foto_r2_key = photoKey;
  const objects = [obj(docKey, jpeg, 'image/jpeg'), obj(photoKey, jpeg, 'image/jpeg')];
  const artifact = compileChunks({ tables: data }, d, { now: NOW });
  const r2Fake = createR2FetchFake();
  const d1Stub = createD1FetchStub(db, d);
  const rep = await runSyntheticImport(runArgs(db, d, data, objects, baseline, r2Fake, d1Stub, artifact));

  assert.equal(rep.status, 'COMPLETE_SYNTHETIC_RECONCILED');
  assert.equal(rep.reason, null);
  assert.deepEqual([rep.counts.objectsTotal, rep.counts.objectsVerified, rep.counts.objectsRechecked, rep.counts.r2Transfers, rep.counts.r2Gets], [2, 2, 2, 2, 2]);
  const base = `https://${d.accountId}.r2.cloudflarestorage.com/${d.bucket}/`;
  assert.deepEqual(r2Fake.calls, [
    { method: 'PUT', url: base + docKey }, { method: 'GET', url: base + docKey },
    { method: 'PUT', url: base + photoKey }, { method: 'GET', url: base + photoKey },
    { method: 'GET', url: base + docKey }, { method: 'GET', url: base + photoKey },
  ]);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(r2Fake.r2Storage.size, 2);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.equal((await db.prepare('SELECT foto_r2_key FROM pegawai WHERE id = 900001').first()).foto_r2_key, photoKey);
  assert.equal((await db.prepare('SELECT r2_key FROM arsip_dokumen WHERE id = 1').first()).r2_key, docKey);
  checkReportSafety(rep, d);
});

// Genuine byte-validated plan fixture only; no private input, real credential or network access.
function uatFixture(baseline, mutatePlan = () => {}) {
  const d = descriptor({ ...UAT_TARGET, baselineSha256: hashBaseline(baseline), appSchemaSha256: UAT_APP_SCHEMA_SHA256,
    policySha256: UAT_POLICY_SHA256, retentionPolicySha256: UAT_RETENTION_POLICY_SHA256 });
  const f = canonicalFixture(d);
  f.data.akun.push({ ...f.data.akun[0], pegawai_id: 900002 });
  const plan = {
    format: 'sikap-migration-plan', version: 1, snapshotId: d.snapshotId, sourceSha256: d.sourceSha256, createdAt: CREATED,
    sourceReadOnlyDeclared: true, consistent: false, ready: true, tables: f.data,
    files: [
      { fileId: DOC_ID, kind: 'document', r2Key: f.docKey, mimeType: 'application/pdf', sizeBytes: PDF_BYTES.byteLength, sha256: PDF_SHA256 },
      { fileId: PHOTO_ID, kind: 'photo', r2Key: f.photoKey, mimeType: 'image/webp', sizeBytes: WEBP_BYTES.byteLength, sha256: h(WEBP_BYTES) },
    ],
    expected: { pegawai: 2, akun: 2, arsip: 1, files: 2, totalFileBytes: PDF_BYTES.byteLength + WEBP_BYTES.byteLength,
      arsipPerStatus: { Menunggu: 1, Terverifikasi: 0, Ditolak: 0 } }, diagnostics: [],
  };
  mutatePlan(plan);
  const planBytes = new TextEncoder().encode(JSON.stringify(plan));
  d.planSha256 = h(planBytes);
  const permit = issueRealDataUatPermit({ descriptor: d, planBytes, now: NOW });
  return { ...f, d, plan, permit, baseline };
}
const uatArgs = (f, d1Stub, r2Fake, extra = {}) => ({
  permit: f.permit, objects: f.objects, baseline: f.baseline,
  d1Token: D1_TOKEN, r2AccessKeyId: R2_ACCESS_KEY, r2SecretAccessKey: R2_SECRET_KEY,
  d1FetchImpl: d1Stub.fetchImpl, r2FetchImpl: r2Fake.fetchImpl, nowProvider: () => NOW, ...extra,
});
const schemaReceipt = (rows) => h(JSON.stringify([...rows].sort((a, b) =>
  a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  .map((r) => [r.type, r.name, r.tbl_name, r.sql])));

test('20: pinned sqlite_schema receipt reproduces migrations 0001..0008 + ledger offline', async (t) => {
  const db = await openDb(t);
  assert.equal(MIGRATIONS.length, 8);
  const rows = (await db.prepare(SCHEMA_QUERY.sql).all()).results;
  assert.equal(rows.filter((r) => r.type === 'table').length, 21);
  assert.equal(schemaReceipt(rows), UAT_EXPECTED_SCHEMA_SHA256);
  assert.equal(schemaReceipt(rows.reverse().map((r) => ({ sql: r.sql, tbl_name: r.tbl_name, name: r.name, type: r.type }))), UAT_EXPECTED_SCHEMA_SHA256);
});

test('21: genuine private UAT permit compiles private plan, verifies initial schema, transfers via adapter, spends permit', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const artifact = compileChunks({ tables: f.plan.tables }, f.d, { now: NOW });
  const r2Fake = createR2FetchFake();
  const d1Stub = createD1FetchStub(db, f.d);
  const fetchImpl = async (url, init) => {
    const res = await d1Stub.fetchImpl(url, init), json = await res.json();
    if (json.result.length === 10) json.result[9].results.reverse(); // never assume provider row order
    return Response.json(json);
  };
  const args = uatArgs(f, d1Stub, r2Fake, { d1FetchImpl: fetchImpl });
  const rep = await runPrivateUatImport(args);
  assert.deepEqual([rep.status, rep.reason, rep.phase], ['COMPLETE_UAT_RECONCILED', null, 'DONE']);
  assert.equal(rep.reconciled, true);
  assert.equal(rep.baselineHashVerified, true);
  assert.equal(rep.schemaFingerprintVerified, true);
  assert.equal(rep.allChunksObserved, true);
  assert.deepEqual([rep.counts.objectsVerified, rep.counts.objectsRechecked, rep.counts.d1Sends], [2, 2, artifact.chunkCount]);
  assert.deepEqual(d1Stub.calls.filter((c) => c.isSelect).map((c) => c.batchLength), [10, ...Array(2 * artifact.chunkCount + 1).fill(9)]);
  assert.equal(d1Stub.getCounts().writeCount, artifact.chunkCount);
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'PUT', 'GET', 'GET', 'GET']);
  assert.equal((await db.prepare(`SELECT complete FROM ${RUN}`).first()).complete, 0);
  assert.equal((await db.prepare(`SELECT stage FROM ${RUN}`).first()).stage, 7);
  assert.equal(isPermitClaimed(f.permit), true);
  assert.equal(isPermitSpent(f.permit), true);
  assert.equal(Object.isFrozen(rep), true);
  checkReportSafety(rep, f.d, true);
  const before = [d1Stub.calls.length, r2Fake.calls.length];
  const reused = await runPrivateUatImport(args);
  assert.equal(reused.status, 'STOPPED_INPUT_INVALID');
  assert.ok(['PERMIT_ALREADY_CLAIMED', 'PERMIT_SPENT'].includes(reused.reason));
  assert.deepEqual([d1Stub.calls.length, r2Fake.calls.length], before);
});

test('22: forged/cloned/claimed permits and caller executable inputs denied before any fetch', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  const d1Stub = createD1FetchStub(db, f.d), r2Fake = createR2FetchFake();
  for (const permit of [{}, { ...f.permit }, structuredClone(f.permit)]) {
    const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake, { permit }));
    assert.deepEqual([rep.status, rep.reason], ['STOPPED_INPUT_INVALID', 'PERMIT_INVALID']);
    checkReportSafety(rep, f.d, true);
  }
  for (const extra of [{ descriptor: f.d }, { tables: f.plan.tables }, { artifact: compileChunks({ tables: f.plan.tables }, f.d, { now: NOW }) }]) {
    const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake, extra));
    assert.deepEqual([rep.status, rep.reason], ['STOPPED_INPUT_INVALID', 'ARGS_INVALID']);
    assert.equal(isPermitClaimed(f.permit), false);
  }
  claimPermitForRun(f.permit, { now: NOW });
  const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake));
  assert.deepEqual([rep.status, rep.reason], ['STOPPED_INPUT_INVALID', 'PERMIT_ALREADY_CLAIMED']);
  assert.equal(isPermitSpent(f.permit), false); // this invocation never owned the claim
  finishPermitRun(f.permit);
  assert.equal(d1Stub.calls.length, 0);
  assert.equal(r2Fake.calls.length, 0);
});

test('23: private object list exact coverage and permit photo size mismatch stop before fetch', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), before = await snapshot(db);
  const orphanKey = canonKey(descriptor(), 'photo', 'UnusedPhoto_00003', PNG_BYTES, 'png');
  const cases = [
    ['missing', (f) => { f.objects.pop(); }, null, 'OBJECT_MISSING'],
    ['orphan', (f) => { f.objects.push(obj(orphanKey, PNG_BYTES, 'image/png')); }, null, 'OBJECT_UNREFERENCED'],
    ['duplicate', (f) => { f.objects.push(f.objects[0]); }, null, 'OBJECTS_INVALID'],
    ['bytes', (f) => { f.objects[0].bytes[5] ^= 1; }, null, 'OBJECTS_INVALID'],
    ['photo manifest size', () => {}, (p) => { p.files[1].sizeBytes++; p.expected.totalFileBytes++; }, 'OBJECT_MANIFEST_MISMATCH'],
  ];
  for (const [name, mutate, mutatePlan, reason] of cases) {
    const f = uatFixture(baseline, mutatePlan ?? (() => {}));
    mutate(f);
    const d1Stub = createD1FetchStub(db, f.d), r2Fake = createR2FetchFake();
    const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake));
    assert.equal(rep.reason, reason, name);
    assert.equal(rep.phase, 'PREFLIGHT', name);
    assert.equal(d1Stub.calls.length, 0, name);
    assert.equal(r2Fake.calls.length, 0, name);
    assert.equal(isPermitSpent(f.permit), true, name);
  }
  assert.equal(await snapshot(db), before);
});

test('24: missing/tampered SQL schema stops after initial read only, even with all 21 tables present', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), beforeBootstrap = await snapshot(db);
  const f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const before = await snapshot(db);
  const cases = [
    ['missing schema result', (json) => { json.result.pop(); }, 'RESULT_COUNT'],
    ['empty schema', (json) => { json.result[9].results = []; }, 'SCHEMA_MISMATCH'],
    ['SQL changed', (json) => {
      const rows = json.result[9].results;
      assert.equal(rows.filter((r) => r.type === 'table').length, 21);
      rows.find((r) => r.type === 'table' && r.name === 'pegawai').sql += ' /* drift */';
    }, 'SCHEMA_MISMATCH'],
    ['extra index', (json) => { json.result[9].results.push({ type: 'index', name: 'unexpected', tbl_name: 'pegawai', sql: 'CREATE INDEX unexpected ON pegawai(nama)' }); }, 'SCHEMA_MISMATCH'],
  ];
  for (const [name, mutate, reason] of cases) {
    const permit = issueRealDataUatPermit({ descriptor: f.d, planBytes: new TextEncoder().encode(JSON.stringify(f.plan)), now: NOW });
    const d1Stub = createD1FetchStub(db, f.d), r2Fake = createR2FetchFake();
    const fetchImpl = async (url, init) => { const json = await (await d1Stub.fetchImpl(url, init)).json(); mutate(json); return Response.json(json); };
    const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake, { permit, d1FetchImpl: fetchImpl }));
    assert.equal(rep.reason, reason, name);
    assert.equal(rep.schemaFingerprintVerified, false, name);
    assert.equal(rep.reconciled, false, name);
    assert.deepEqual(d1Stub.getCounts(), { postCount: 1, readCount: 1, writeCount: 0 }, name);
    assert.deepEqual(d1Stub.calls, [{ isSelect: true, batchLength: 10 }], name);
    assert.equal(r2Fake.calls.length, 0, name);
    assert.equal(isPermitSpent(permit), true, name);
    assert.equal(await snapshot(db), before, name);
  }
  assert.notEqual(before, beforeBootstrap); // test bootstrap is the only write
});

test('25: caller baseline hash, seed-only and actual initial-row comparison remain mandatory in UAT', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const wrong = structuredClone(baseline); wrong.jenis_dokumen[0].nama = 'Different baseline';
  const d1Stub = createD1FetchStub(db, f.d), r2Fake = createR2FetchFake();
  const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake, { baseline: wrong }));
  assert.deepEqual([rep.status, rep.reason], ['STOPPED_PREFLIGHT_MISMATCH', 'BASELINE_HASH_MISMATCH']);
  assert.equal(d1Stub.calls.length, 0);
  assert.equal(r2Fake.calls.length, 0);
  const dirty = structuredClone(baseline); dirty.pegawai = f.plan.tables.pegawai;
  const dirtyF = uatFixture(dirty);
  const dirtyRep = await runPrivateUatImport(uatArgs(dirtyF, d1Stub, r2Fake));
  assert.equal(dirtyRep.reason, 'BASELINE_NOT_SEED_ONLY');
  assert.equal(d1Stub.calls.length, 0);
  const actualF = uatFixture(baseline);
  await db.prepare("UPDATE jenis_dokumen SET nama = 'Actual state differs' WHERE id = 'DOC-KTP'").run();
  const actualRep = await runPrivateUatImport(uatArgs(actualF, d1Stub, r2Fake));
  assert.deepEqual([actualRep.status, actualRep.reason], ['STOPPED_PREFLIGHT_MISMATCH', 'ROWS_MISMATCH']);
  assert.equal(actualRep.schemaFingerprintVerified, true);
  assert.equal(actualRep.baselineHashVerified, false);
  assert.deepEqual(d1Stub.getCounts(), { postCount: 1, readCount: 1, writeCount: 0 });
  assert.equal(r2Fake.calls.length, 0);
});

test('27: permit finished after FINAL_OBJECTS tick but before queued GET dispatch -> no final GET, no success', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const chunkCount = compileChunks({ tables: f.plan.tables }, f.d, { now: NOW }).chunkCount;
  const d1Stub = createD1FetchStub(db, f.d), r2Fake = createR2FetchFake();
  let queued = false;
  const nowProvider = () => {
    const c = d1Stub.getCounts();
    if (!queued && r2Fake.calls.length === 4 && c.writeCount === chunkCount && c.readCount === 2 * chunkCount + 1) {
      queued = true;
      queueMicrotask(() => finishPermitRun(f.permit)); // runs after outer tick validation, before dispatch
    }
    return NOW;
  };
  const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake, { nowProvider }));
  assert.equal(queued, true);
  assert.equal(rep.status, 'STOPPED_FINAL_OBJECT_MISMATCH');
  assert.ok(['PERMIT_SPENT', 'PERMIT_INVALID'].includes(rep.reason));
  assert.equal(rep.phase, 'FINAL_OBJECTS');
  assert.deepEqual(r2Fake.calls.map((c) => c.method), ['PUT', 'GET', 'PUT', 'GET']); // upload verify GETs only
  assert.deepEqual(d1Stub.getCounts(), { postCount: 3 * chunkCount + 1, readCount: 2 * chunkCount + 1, writeCount: chunkCount }); // no final read
  assert.equal(rep.reconciled, false);
  assert.equal(rep.counts.objectsRechecked, 0);
  assert.equal(rep.manualRecoveryRequired, true);
  assert.equal(isPermitSpent(f.permit), true);
  checkReportSafety(rep, f.d, true);
});

test('26: synthetic entry still rejects real profile and permit; entrypoints share the same active lock', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const d1Stub = createD1FetchStub(db, f.d), r2Fake = createR2FetchFake();
  const synthArgs = runArgs(db, f.d, f.plan.tables, f.objects, baseline, r2Fake, d1Stub);
  const realProfile = await runSyntheticImport(synthArgs);
  assert.deepEqual([realProfile.status, realProfile.reason], ['STOPPED_PROFILE_BLOCKED', 'PROFILE_BLOCKED']);
  const permitArg = await runSyntheticImport({ ...synthArgs, permit: f.permit });
  assert.deepEqual([permitArg.status, permitArg.reason], ['STOPPED_INPUT_INVALID', 'ARGS_INVALID']);
  assert.equal(d1Stub.calls.length, 0);
  assert.equal(r2Fake.calls.length, 0);
  let release, entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const pending = runPrivateUatImport(uatArgs(f, d1Stub, r2Fake, { d1FetchImpl: async () => { entered(); await hold; return new Response(null, { status: 503 }); } }));
  await ready;
  const other = uatFixture(baseline);
  const busyUat = await runPrivateUatImport(uatArgs(other, d1Stub, r2Fake));
  const busySynthetic = await runSyntheticImport(synthArgs);
  assert.deepEqual([busyUat.status, busySynthetic.status], ['STOPPED_BUSY', 'STOPPED_BUSY']);
  assert.equal(isPermitClaimed(other.permit), false);
  release();
  const stopped = await pending;
  assert.equal(stopped.status, 'STOPPED_READBACK_FAILED');
  assert.equal(isPermitSpent(f.permit), true);
  assert.equal(r2Fake.calls.length, 0);
});

// ---- ordinal-0 object recovery entry (synthetic permit fixtures only) ----
const r2Base = (d) => `https://${d.accountId}.r2.cloudflarestorage.com/${d.bucket}/`;
const freshPermit = (f) => issueRealDataUatPermit({ descriptor: f.d, planBytes: new TextEncoder().encode(JSON.stringify(f.plan)), now: NOW });
async function receiptState(db) {
  const run = await db.prepare(`SELECT stage, cursor, ordinal, claim_seq, last_chunk_sha256, complete FROM ${RUN}`).all();
  const journal = await db.prepare(`SELECT count(*) AS n FROM ${LEDGER.journalTable}`).first();
  return { run: run.results, journal: journal.n };
}
const RECEIPT_ZERO = { run: [{ stage: 0, cursor: 0, ordinal: 0, claim_seq: 0, last_chunk_sha256: null, complete: 0 }], journal: 0 };

test('28: recovery reuses exact pre-existing object (GET only), uploads 404 object once, D1 once, final GET all', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const chunkCount = compileChunks({ tables: f.plan.tables }, f.d, { now: NOW }).chunkCount;
  const base = r2Base(f.d);
  const r2Fake = createR2FetchFake();
  r2Fake.r2Storage.set(base + f.docKey, { bytes: new Uint8Array(PDF_BYTES), mimeType: 'application/pdf' });
  const d1Stub = createD1FetchStub(db, f.d);
  const rep = await runPrivateUatRecovery(uatArgs(f, d1Stub, r2Fake));
  assert.deepEqual([rep.status, rep.reason, rep.phase], ['COMPLETE_UAT_RECONCILED', null, 'DONE']);
  assert.equal(rep.recoveryRun, true);
  assert.equal(rep.reconciled, true);
  assert.equal(rep.authorizesRetry, false);
  assert.equal(rep.authorizesResume, false);
  assert.deepEqual(r2Fake.calls, [
    { method: 'GET', url: base + f.docKey }, // pre-check 200 exact: reused, no PUT
    { method: 'GET', url: base + f.photoKey }, // pre-check 404
    { method: 'PUT', url: base + f.photoKey }, { method: 'GET', url: base + f.photoKey }, // create-only transfer
    { method: 'GET', url: base + f.docKey }, { method: 'GET', url: base + f.photoKey }, // final GET all
  ]);
  const c = rep.counts;
  assert.deepEqual([c.objectsTotal, c.objectsVerified, c.objectsReused, c.objectsUploaded, c.r2Transfers, c.r2Gets, c.objectsRechecked], [2, 2, 1, 1, 1, 4, 2]);
  assert.equal(r2Fake.getCounts().putCount, 1);
  assert.equal(r2Fake.getCounts().deleteCount, 0);
  assert.equal(c.d1Sends, chunkCount);
  assert.deepEqual(d1Stub.getCounts(), { postCount: 3 * chunkCount + 2, readCount: 2 * chunkCount + 2, writeCount: chunkCount });
  assert.deepEqual(d1Stub.calls.filter((x) => x.isSelect).map((x) => x.batchLength), [10, ...Array(2 * chunkCount + 1).fill(9)]);
  assert.equal((await db.prepare(`SELECT stage FROM ${RUN}`).first()).stage, 7);
  assert.equal(isPermitSpent(f.permit), true);
  checkReportSafety(rep, f.d, true);
});

test('29: recovery pre-GET mismatch/403 stops before D1 (no PUT/overwrite); original entry still rejects conflicts', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const before = await snapshot(db);
  const base = r2Base(f.d), tampered = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x30]);
  const cases = [
    ['bytes differ', { bytes: tampered, mimeType: 'application/pdf' }, null, 'OBJECT_MISMATCH'],
    ['MIME differs', { bytes: new Uint8Array(PDF_BYTES), mimeType: 'application/octet-stream' }, null, 'OBJECT_MISMATCH'],
    ['403', null, (method) => (method === 'GET' ? new Response(null, { status: 403 }) : undefined), 'GET_STATUS'],
  ];
  for (const [name, stored, onBeforeRequest, reason] of cases) {
    const permit = freshPermit(f);
    const r2Fake = createR2FetchFake({ onBeforeRequest });
    if (stored) r2Fake.r2Storage.set(base + f.docKey, stored);
    const d1Stub = createD1FetchStub(db, f.d);
    const rep = await runPrivateUatRecovery(uatArgs(f, d1Stub, r2Fake, { permit }));
    assert.deepEqual([rep.status, rep.reason, rep.phase], ['STOPPED_R2_FAILED', reason, 'OBJECTS'], name);
    assert.deepEqual(r2Fake.calls.map((x) => x.method), ['GET'], name);
    if (stored) assert.deepEqual(r2Fake.r2Storage.get(base + f.docKey), stored, name);
    assert.deepEqual(d1Stub.getCounts(), { postCount: 1, readCount: 1, writeCount: 0 }, name);
    assert.deepEqual([rep.counts.objectsReused, rep.counts.objectsUploaded, rep.counts.r2Transfers, rep.counts.d1Sends], [0, 0, 0, 0], name);
    assert.equal(rep.recoveryRun, true, name);
    assert.equal(rep.reconciled, false, name);
    assert.equal(isPermitSpent(permit), true, name);
    checkReportSafety(rep, f.d, true);
  }
  assert.equal(await snapshot(db), before);
  // Original entry: unchanged create-only behaviour (PUT 412 => CONFLICT), no recovery fields.
  const r2Fake = createR2FetchFake();
  r2Fake.r2Storage.set(base + f.docKey, { bytes: new Uint8Array(PDF_BYTES), mimeType: 'application/pdf' });
  const d1Stub = createD1FetchStub(db, f.d);
  const rep = await runPrivateUatImport(uatArgs(f, d1Stub, r2Fake, { permit: freshPermit(f) }));
  assert.deepEqual([rep.status, rep.reason], ['STOPPED_R2_FAILED', 'CONFLICT']);
  assert.deepEqual(r2Fake.calls.map((x) => x.method), ['PUT']);
  assert.equal(Object.hasOwn(rep, 'recoveryRun'), false);
  assert.equal(Object.hasOwn(rep.counts, 'objectsReused') || Object.hasOwn(rep.counts, 'objectsUploaded'), false);
  assert.equal(d1Stub.getCounts().writeCount, 0);
  assert.equal(await snapshot(db), before);
});

test('30: recovery 404 then PUT 412 race / ambiguous PUT -> stop, no resend, receipt stays ordinal 0', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const base = r2Base(f.d);
  for (const [name, putStatus, reason] of [['412 race', 412, 'CONFLICT'], ['ambiguous 500', 500, 'HALT_AMBIGUOUS']]) {
    const permit = freshPermit(f);
    const r2Fake = createR2FetchFake({ onBeforeRequest: (method) => (method === 'PUT' ? new Response(null, { status: putStatus }) : undefined) });
    const d1Stub = createD1FetchStub(db, f.d);
    const rep = await runPrivateUatRecovery(uatArgs(f, d1Stub, r2Fake, { permit }));
    assert.deepEqual([rep.status, rep.reason, rep.phase], ['STOPPED_R2_FAILED', reason, 'OBJECTS'], name);
    // Pass 1 GETs every object (both 404) before the first PUT; the stop prevents any second PUT.
    assert.deepEqual(r2Fake.calls, [{ method: 'GET', url: base + f.docKey }, { method: 'GET', url: base + f.photoKey }, { method: 'PUT', url: base + f.docKey }], name);
    assert.equal(r2Fake.r2Storage.size, 0, name);
    assert.deepEqual(d1Stub.getCounts(), { postCount: 1, readCount: 1, writeCount: 0 }, name);
    assert.deepEqual([rep.counts.r2Transfers, rep.counts.objectsUploaded, rep.counts.d1Sends], [1, 0, 0], name);
    assert.equal(rep.manualRecoveryRequired, true, name);
    assert.equal(rep.authorizesRetry, false, name);
    assert.deepEqual(await receiptState(db), RECEIPT_ZERO, name);
    checkReportSafety(rep, f.d, true);
  }
});

test('31: recovery requires exact state-0 receipt: nonzero ordinal rejects with zero R2 requests even if objects exist', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  await db.prepare(`UPDATE ${RUN} SET ordinal = 1, claim_seq = 1, last_chunk_sha256 = ? WHERE id = 1`).bind('a'.repeat(64)).run();
  const before = await snapshot(db);
  const base = r2Base(f.d);
  const r2Fake = createR2FetchFake();
  r2Fake.r2Storage.set(base + f.docKey, { bytes: new Uint8Array(PDF_BYTES), mimeType: 'application/pdf' });
  r2Fake.r2Storage.set(base + f.photoKey, { bytes: new Uint8Array(WEBP_BYTES), mimeType: 'image/webp' });
  const d1Stub = createD1FetchStub(db, f.d);
  const rep = await runPrivateUatRecovery(uatArgs(f, d1Stub, r2Fake));
  assert.deepEqual([rep.status, rep.reason, rep.phase], ['STOPPED_PREFLIGHT_MISMATCH', 'RUN_MISMATCH', 'INITIAL_READ']);
  assert.equal(rep.schemaFingerprintVerified, true);
  assert.equal(rep.baselineHashVerified, false);
  assert.equal(r2Fake.calls.length, 0);
  assert.deepEqual(d1Stub.getCounts(), { postCount: 1, readCount: 1, writeCount: 0 });
  assert.equal(rep.objectsMayRemain, false);
  assert.equal(isPermitSpent(f.permit), true);
  assert.equal(await snapshot(db), before);
  checkReportSafety(rep, f.d, true);
});

test('32: recovery GETs ALL objects before any write: first 404, second present with wrong bytes -> GET only, no PUT, no D1 write', async (t) => {
  const db = await openDb(t), baseline = await readBaseline(db), f = uatFixture(baseline);
  await bootstrap(db, f.d);
  const before = await snapshot(db);
  const base = r2Base(f.d), wrong = { bytes: new Uint8Array(PNG_BYTES), mimeType: 'image/webp' };
  const r2Fake = createR2FetchFake();
  r2Fake.r2Storage.set(base + f.photoKey, wrong); // docKey (first) absent => 404
  const d1Stub = createD1FetchStub(db, f.d);
  const rep = await runPrivateUatRecovery(uatArgs(f, d1Stub, r2Fake));
  assert.deepEqual([rep.status, rep.reason, rep.phase], ['STOPPED_R2_FAILED', 'OBJECT_MISMATCH', 'OBJECTS']);
  assert.deepEqual(r2Fake.calls, [{ method: 'GET', url: base + f.docKey }, { method: 'GET', url: base + f.photoKey }]);
  assert.equal(r2Fake.getCounts().putCount, 0);
  assert.deepEqual(r2Fake.r2Storage.get(base + f.photoKey), wrong);
  assert.equal(r2Fake.r2Storage.has(base + f.docKey), false);
  assert.deepEqual(d1Stub.getCounts(), { postCount: 1, readCount: 1, writeCount: 0 });
  assert.deepEqual([rep.counts.r2Gets, rep.counts.r2Transfers, rep.counts.objectsReused, rep.counts.objectsUploaded, rep.counts.d1Sends], [2, 0, 0, 0, 0]);
  assert.deepEqual(await receiptState(db), RECEIPT_ZERO);
  assert.equal(await snapshot(db), before);
  assert.equal(isPermitSpent(f.permit), true);
  checkReportSafety(rep, f.d, true);
});

