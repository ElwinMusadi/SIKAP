// LOCAL Miniflare + REST/S3 adapter rehearsal integration tests for SIKAP importer.
// THIS IS LOCAL EMULATION OF HTTP SHAPE NOT REMOTE PROOF.
// Scope: In-memory Miniflare D1 (ephemeral, d1Persist: false, outbound 403) + injected fetch stubs
// for createD1RestAdapter and createR2S3Adapter. No network, no Wrangler, no cloud credentials,
// no remote state. All flags (transportProven, readyForImport, remoteAuthorized) remain false.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { canonicalRow } from '../migrate/apply-local.mjs';
import { splitMigration } from '../migrate/local-store.mjs';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { COLUMNS, PRIMARY, LEDGER, compileChunks, validateDescriptor, classifyResume } from './core.mjs';
import { LEDGER_DDL_SHA256, LEDGER_SQL_FILE, validateLedgerSql } from './ledger-contract.mjs';
import { createD1RestAdapter, ENDPOINT_ORIGIN, ENDPOINT_PATH } from './d1-rest.mjs';
import { createR2S3Adapter } from './r2-s3.mjs';

const ROOT = new URL('../../', import.meta.url);
const DDL = readFileSync(new URL(LEDGER_SQL_FILE, ROOT), 'utf8');
const MIGRATIONS = readdirSync(new URL('migrations/', ROOT)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort()
  .map((n) => readFileSync(new URL(`migrations/${n}`, ROOT), 'utf8'));

const NOW = '2026-10-18T00:00:00.000Z', CREATED = '2026-10-01T00:00:00.000Z';
const SENTINEL = 'Sintetis \'O"Neil\' \u00e9 \u6f22 \u{1F600} \'); DROP TABLE pegawai; --';
const h = (data) => createHash('sha256').update(data).digest('hex');
const RUN = LEDGER.runTable, JOURNAL = LEDGER.journalTable;

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
const r2UrlFor = (d, key) => `https://${d.accountId}.r2.cloudflarestorage.com/${d.bucket}/${key}`;

function tables(r2Key, { dupNip = false } = {}) {
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
    id: 900002, nip: dupNip ? '199001012020000001' : '199001012020000002', nik: null,
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

const compile = (t, d = descriptor()) => compileChunks({ tables: t }, d, { now: NOW });

async function openDb(t) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
    outboundService: () => new Response(null, { status: 403 }), log: new Log(LogLevel.NONE),
    cf: false, telemetry: { enabled: false }, d1Databases: { DB: 'sikap-rehearsal-local' }, d1Persist: false,
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const sql of MIGRATIONS) await db.batch(splitMigration(sql).map((s) => db.prepare(s)));
  assert.equal(validateLedgerSql(DDL).valid, true);
  await db.batch(splitMigration(DDL).map((s) => db.prepare(s)));
  return db;
}

const RUN_INSERT = `INSERT INTO ${RUN} (${LEDGER.runColumns.join(', ')}) VALUES (${LEDGER.runColumns.map(() => '?').join(', ')})`;
async function bootstrap(db, d = descriptor()) {
  const target = validateDescriptor(d, NOW).targetBindingSha256;
  const row = {
    id: 1, run_nonce: d.runNonce, owner_nonce: d.ownerNonce, epoch: d.epoch,
    target_binding_sha256: target, plan_sha256: d.planSha256, stage: 0, cursor: 0,
    ordinal: 0, claim_seq: 0, last_chunk_sha256: null, complete: 0,
  };
  await db.prepare(RUN_INSERT).bind(...LEDGER.runColumns.map((c) => row[c])).run();
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

async function snapshot(db) {
  const schema = (await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").all()).results;
  const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()).results.map((r) => r.name);
  const out = { schema };
  for (const name of names) out[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  return JSON.stringify(out);
}

const runState = async (db) => await db.prepare(`SELECT * FROM ${RUN} WHERE id = 1`).first();
const runRowToReceipt = (r) => ({
  runNonce: r.run_nonce, ownerNonce: r.owner_nonce, epoch: r.epoch, targetBindingSha256: r.target_binding_sha256,
  planSha256: r.plan_sha256, stage: r.stage, cursor: r.cursor, ordinal: r.ordinal, claimSeq: r.claim_seq,
  lastChunkSha256: r.last_chunk_sha256, complete: r.complete,
});
const journalRowToCamel = (r) => ({
  runNonce: r.run_nonce, epoch: r.epoch, targetBindingSha256: r.target_binding_sha256, ordinal: r.ordinal,
  stage: r.stage, tableName: r.table_name, startCursor: r.start_cursor, endCursor: r.end_cursor, chunkSha256: r.chunk_sha256,
});

function createR2FetchFake() {
  const r2Storage = new Map();
  let putCount = 0, getCount = 0;
  const fetchImpl = async (url, init) => {
    const method = init.method ?? 'GET';
    if (method === 'PUT') {
      putCount++;
      assert.equal(init.headers?.['if-none-match'], '*');
      if (r2Storage.has(url)) return new Response(null, { status: 412, statusText: 'Precondition Failed' });
      const copy = new Uint8Array(init.body);
      r2Storage.set(url, { bytes: copy, contentType: init.headers?.['content-type'] ?? 'application/octet-stream' });
      return new Response(null, { status: 200, statusText: 'OK' });
    }
    if (method === 'GET') {
      getCount++;
      if (!r2Storage.has(url)) return new Response(null, { status: 404, statusText: 'Not Found' });
      const item = r2Storage.get(url);
      return new Response(item.bytes, { status: 200, headers: { 'content-type': item.contentType } });
    }
    assert.fail(`Unexpected method: ${method}`);
  };
  return { fetchImpl, r2Storage, getCounts: () => ({ putCount, getCount }) };
}

function createD1FetchStub(db, d, { onBeforeBatch = null, onAfterBatch = null, onBatchError = null } = {}) {
  const expectedUrl = `${ENDPOINT_ORIGIN}${ENDPOINT_PATH(d.accountId, d.databaseId)}`;
  let postCount = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(url, expectedUrl);
    assert.equal(init.method, 'POST');
    assert.match(init.headers?.Authorization ?? '', /^Bearer SYNTHETIC-TEST-TOKEN-/);
    assert.equal(init.headers?.['Content-Type'], 'application/json');
    postCount++;

    if (onBeforeBatch) {
      const intercepted = await onBeforeBatch(init, postCount);
      if (intercepted) return intercepted;
    }

    let mfResults;
    try {
      const { batch } = JSON.parse(init.body);
      mfResults = await db.batch(batch.map((s) => db.prepare(s.sql).bind(...s.params)));
    } catch (err) {
      if (onBatchError) return onBatchError(err, init, postCount);
      throw err;
    }

    if (onAfterBatch) {
      const intercepted = await onAfterBatch(mfResults, init, postCount);
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
  return { fetchImpl, getPostCount: () => postCount };
}

// Shared local execution pipeline: verifies R2 transfer gate then executes D1 chunks with read-back per chunk
async function runPipeline({ db, d, base, r2Adapter = null, d1Stub, data, artifact, r2Key, continueIfReconciled = null, onAfterChunk = null }) {
  let r2Res = null;
  if (r2Adapter) {
    r2Res = await r2Adapter.transfer({ key: r2Key, bytes: PDF_BYTES, mimeType: 'application/pdf', sha256: PDF_SHA256, now: NOW });
    if (r2Res.outcome !== 'OBJECT_VERIFIED_SYNTHETIC') {
      return { r2Res, chunkResults: [], stoppedAt: 'R2_GATE', completed: false };
    }
  }

  const chunkResults = [];
  for (let i = 0; i < artifact.chunks.length; i++) {
    if (continueIfReconciled) {
      const allowed = await continueIfReconciled(i, chunkResults);
      if (!allowed) {
        return { r2Res, chunkResults, stoppedAt: 'RECONCILE_GATE', completed: false };
      }
    }

    const chunk = artifact.chunks[i];
    const adapter = createD1RestAdapter({ descriptor: d, artifact, token: D1_TOKEN, fetchImpl: d1Stub.fetchImpl, now: NOW });
    const res = await adapter.send({ chunk, now: NOW });
    chunkResults.push(res);
    if (res.status !== 'RESPONSE_ACCEPTED') {
      return { r2Res, chunkResults, stoppedAt: 'D1_SEND', completed: false };
    }

    // Independent read-back
    const run = await runState(db);
    assert.equal(run.ordinal, chunk.ordinal + 1);
    assert.equal(run.last_chunk_sha256, chunk.chunkSha256);
    assert.equal(run.complete, 0);

    const journalRow = await db.prepare(`SELECT * FROM ${JOURNAL} WHERE chunk_sha256 = ?`).bind(chunk.chunkSha256).first();
    assert.ok(journalRow);
    assert.equal(journalRow.ordinal, chunk.ordinal);

    const currentRows = await importRows(db);
    assert.equal(sameRows(currentRows, expectedRows(base, data, artifact, i + 1)), true);

    if (onAfterChunk) await onAfterChunk(i, chunk, res);
  }

  return { r2Res, chunkResults, stoppedAt: null, completed: true };
}

// (1) Happy path rehearsal: R2 PUT/GET -> all D1 compiled chunks via HTTP stub -> read-back matches seeds and rows
test('rehearsal 1: end-to-end R2 upload -> D1 chunks via HTTP stub -> verified read-back matches seed and row baselines', async (t) => {
  const db = await openDb(t);
  const d = descriptor();
  const r2Key = r2KeyFor(d);
  const r2Fake = createR2FetchFake();
  const r2Adapter = createR2S3Adapter({
    descriptor: d, accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY, fetchImpl: r2Fake.fetchImpl, now: NOW,
  });

  await bootstrap(db, d);
  const base = await importRows(db);
  const data = tables(r2Key);
  const artifact = compile(data, d);
  assert.ok(artifact.chunks.length > 0);

  const d1Stub = createD1FetchStub(db, d);
  const pipeRes = await runPipeline({ db, d, base, r2Adapter, d1Stub, data, artifact, r2Key });

  assert.equal(pipeRes.completed, true);
  assert.equal(pipeRes.r2Res.outcome, 'OBJECT_VERIFIED_SYNTHETIC');
  assert.equal(pipeRes.r2Res.objectVerifiedSynthetic, true);
  assert.equal(pipeRes.r2Res.ownershipProven, false);
  assert.equal(pipeRes.r2Res.ready, false);
  assert.equal(pipeRes.r2Res.remoteAuthorized, false);
  assert.equal(d1Stub.getPostCount(), artifact.chunks.length);

  const finalRun = await runState(db);
  assert.equal(finalRun.complete, 0);
  const finalRows = await importRows(db);
  assert.equal(sameRows(finalRows, expectedRows(base, data, artifact, artifact.chunks.length)), true);

  // Verify DOC-KK in seed baseline is untouched, and DOC-KTP is imported/updated
  assert.equal(finalRows.jenis_dokumen['["DOC-KK"]'].nama, 'Kartu Keluarga (KK)');
  assert.equal(finalRows.jenis_dokumen['["DOC-KTP"]'].nama, 'KTP Sintetis');
  assert.equal(finalRows.pegawai['[900001]'].unit_id, 1);

  // Object in R2 fake store verified via GET request
  const getRes = await r2Fake.fetchImpl(r2UrlFor(d, r2Key), { method: 'GET' });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get('content-type'), 'application/pdf');
  const storedBytes = new Uint8Array(await getRes.arrayBuffer());
  assert.equal(storedBytes.byteLength, PDF_BYTES.byteLength);
  assert.equal(h(storedBytes), PDF_SHA256);
});

// (2) D1 timeout after commit: HTTP stub awaits batch then throws; adapter halts ambiguous, COMMITTED_OBSERVED on readback
test('rehearsal 2: D1 timeout after commit -> adapter ambiguous halt -> read-back classifies COMMITTED_OBSERVED without auto-resend', async (t) => {
  const db = await openDb(t);
  const d = descriptor();
  const r2Key = r2KeyFor(d);
  await bootstrap(db, d);
  const base = await importRows(db);
  const data = tables(r2Key);
  const artifact = compile(data, d);

  const d1Stub = createD1FetchStub(db, d, {
    onAfterBatch: async (_mfResults, _init, postCount) => {
      if (postCount === 2) throw new TypeError('fetch failed: synthetic connection drop after write');
      return null;
    },
  });

  const a0 = createD1RestAdapter({ descriptor: d, artifact, token: D1_TOKEN, fetchImpl: d1Stub.fetchImpl, now: NOW });
  assert.equal((await a0.send({ chunk: artifact.chunks[0], now: NOW })).status, 'RESPONSE_ACCEPTED');

  const a1 = createD1RestAdapter({ descriptor: d, artifact, token: D1_TOKEN, fetchImpl: d1Stub.fetchImpl, now: NOW });
  const res1 = await a1.send({ chunk: artifact.chunks[1], now: NOW });
  assert.equal(res1.status, 'AMBIGUOUS');
  assert.equal(res1.reason, 'FETCH_FAILED');
  assert.equal(res1.halted, true);
  assert.equal(a1.summary().sentCount, 1);

  const receipt = runRowToReceipt(await runState(db));
  const journals = (await db.prepare(`SELECT * FROM ${JOURNAL} ORDER BY ordinal ASC`).all()).results.map(journalRowToCamel);
  const currentRows = await importRows(db);
  assert.equal(sameRows(currentRows, expectedRows(base, data, artifact, 2)), true);

  const classified = classifyResume({
    artifact, ordinal: 1, observedReceipt: receipt, journal: journals, exactPrefixVerified: true, writerQuiescent: true,
  });
  assert.equal(classified.outcome, 'COMMITTED_OBSERVED');
  assert.equal(classified.authorizesRetry, false);
  assert.equal(classified.authorizesSend, false);
  assert.equal(classified.autoResendAllowed, false);
  assert.equal(classified.remoteAuthorized, false);
});

// (3) D1 constraint failure mid-chunk: binding throws, REST returns 400 error, snapshot preserved, no secret leak
test('rehearsal 3: D1 constraint failure mid-chunk -> binding throws, REST 400 envelope -> snapshot unchanged, no secret echo', async (t) => {
  const db = await openDb(t);
  const d = descriptor();
  const r2Key = r2KeyFor(d);
  await bootstrap(db, d);
  const data = tables(r2Key, { dupNip: true });
  const artifact = compile(data, d);

  const d1Stub = createD1FetchStub(db, d, {
    onBatchError: async (err) => {
      assert.match(err.message, /UNIQUE constraint failed: pegawai\.nip/);
      return new Response(JSON.stringify({
        success: false,
        errors: [{ code: 7500, message: 'D1_ERROR: UNIQUE constraint failed: pegawai.nip [SECRET_REDACT_ME]' }],
        messages: [],
        result: [],
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    },
  });

  for (let i = 0; i < 2; i++) {
    const a = createD1RestAdapter({ descriptor: d, artifact, token: D1_TOKEN, fetchImpl: d1Stub.fetchImpl, now: NOW });
    assert.equal((await a.send({ chunk: artifact.chunks[i], now: NOW })).status, 'RESPONSE_ACCEPTED');
  }

  const snapBefore = await snapshot(db);
  const failingAdapter = createD1RestAdapter({ descriptor: d, artifact, token: D1_TOKEN, fetchImpl: d1Stub.fetchImpl, now: NOW });
  const res = await failingAdapter.send({ chunk: artifact.chunks[2], now: NOW });

  assert.equal(res.status, 'AMBIGUOUS');
  assert.equal(res.reason, 'HTTP_STATUS');
  assert.equal(res.httpStatus, 400);
  assert.equal(res.httpCategory, 'CLIENT');
  assert.equal(res.halted, true);

  const snapAfter = await snapshot(db);
  assert.equal(snapAfter, snapBefore);

  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes('SECRET_REDACT_ME'), false);
  assert.equal(serialized.includes('INSERT INTO'), false);
  assert.equal(serialized.includes(D1_TOKEN), false);
});

// (4) R2 412 precondition conflict: stops immediately before ANY D1 POST (count 0), no overwrite or deletion
test('rehearsal 4: R2 pre-existing object 412 conflict -> aborts before any D1 POST (count 0), no overwrite or deletion', async (t) => {
  const db = await openDb(t);
  const d = descriptor();
  const r2Key = r2KeyFor(d);
  const r2Url = r2UrlFor(d, r2Key);
  const r2Fake = createR2FetchFake();
  const preExistingBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39, 0x39]);
  r2Fake.r2Storage.set(r2Url, { bytes: preExistingBytes, contentType: 'application/pdf' });

  await bootstrap(db, d);
  const base = await importRows(db);
  const data = tables(r2Key);
  const artifact = compile(data, d);
  const d1Stub = createD1FetchStub(db, d);

  const r2Adapter = createR2S3Adapter({
    descriptor: d, accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY, fetchImpl: r2Fake.fetchImpl, now: NOW,
  });

  const res = await runPipeline({ db, d, base, r2Adapter, d1Stub, data, artifact, r2Key });

  assert.equal(res.completed, false);
  assert.equal(res.stoppedAt, 'R2_GATE');
  assert.equal(res.r2Res.outcome, 'CONFLICT');
  assert.equal(res.r2Res.reason, 'PRECONDITION_FAILED');
  assert.equal(res.r2Res.objectVerifiedSynthetic, false);
  assert.equal(res.r2Res.deleteAttempted, false);
  assert.equal(res.r2Res.ownershipProven, false);
  assert.equal(res.r2Res.ready, false);
  assert.equal(res.r2Res.remoteAuthorized, false);

  assert.deepEqual(r2Fake.r2Storage.get(r2Url).bytes, preExistingBytes);
  assert.equal(d1Stub.getPostCount(), 0);
});

// (5) Final reconcile: actual row / file tamper reveals mismatch and prevents further POST; Unicode/null preserved
test('rehearsal 5: reconciliation detects DB row and R2 file tampering -> HOLD_UNCERTAIN and no further POST; preserves Unicode/nulls', async (t) => {
  const db = await openDb(t);
  const d = descriptor();
  const r2Key = r2KeyFor(d);
  const r2Url = r2UrlFor(d, r2Key);
  const r2Fake = createR2FetchFake();
  const r2Adapter = createR2S3Adapter({
    descriptor: d, accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY, fetchImpl: r2Fake.fetchImpl, now: NOW,
  });

  await bootstrap(db, d);
  const base = await importRows(db);
  const data = tables(r2Key);
  const artifact = compile(data, d);
  const d1Stub = createD1FetchStub(db, d);

  const pipeRes = await runPipeline({ db, d, base, r2Adapter, d1Stub, data, artifact, r2Key });
  assert.equal(pipeRes.completed, true);
  assert.equal(d1Stub.getPostCount(), artifact.chunks.length);

  // Verify parameters: Unicode Sentinel quotes/emoji and null preservation
  const p1 = await db.prepare('SELECT * FROM pegawai WHERE id = 900001').first();
  assert.equal(p1.nama, SENTINEL);
  assert.equal(p1.nik, '7100000000000001');

  const p2 = await db.prepare('SELECT * FROM pegawai WHERE id = 900002').first();
  assert.equal(p2.nik, null);
  assert.equal(p2.pangkat_kode, null);
  assert.equal(p2.alamat, null);
  assert.equal(p2.foto_r2_key, null);

  const doc = await db.prepare('SELECT * FROM arsip_dokumen WHERE id = 1').first();
  assert.equal(doc.r2_key, r2Key);
  assert.equal(doc.sha256, PDF_SHA256);
  assert.equal(doc.size_bytes, PDF_BYTES.byteLength);

  // File final verification via actual GET fake response
  const getRes = await r2Fake.fetchImpl(r2Url, { method: 'GET' });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get('content-type'), 'application/pdf');
  const verifiedBytes = new Uint8Array(await getRes.arrayBuffer());
  assert.equal(verifiedBytes.byteLength, PDF_BYTES.byteLength);
  assert.equal(h(verifiedBytes), PDF_SHA256);

  // Row tampering in Miniflare DB
  await db.prepare("UPDATE pegawai SET nama = 'tampered' WHERE id = 900001").run();
  const tamperedRows = await importRows(db);
  const prefixMatch = sameRows(tamperedRows, expectedRows(base, data, artifact, artifact.chunks.length));
  assert.equal(prefixMatch, false);

  const receipt = runRowToReceipt(await runState(db));
  const journals = (await db.prepare(`SELECT * FROM ${JOURNAL} ORDER BY ordinal ASC`).all()).results.map(journalRowToCamel);
  const classified = classifyResume({
    artifact, ordinal: artifact.chunks.length - 1, observedReceipt: receipt, journal: journals,
    exactPrefixVerified: prefixMatch, writerQuiescent: true,
  });
  assert.equal(classified.outcome, 'HOLD_UNCERTAIN');
  assert.equal(classified.authorizesSend, false);

  // Explicit gate test: pipeline with continueIfReconciled returning false halts and blocks next send
  const blockedPipe = await runPipeline({
    db, d, base, d1Stub, data, artifact, r2Key,
    continueIfReconciled: () => prefixMatch,
  });
  assert.equal(blockedPipe.completed, false);
  assert.equal(blockedPipe.stoppedAt, 'RECONCILE_GATE');
  assert.equal(d1Stub.getPostCount(), artifact.chunks.length);

  // File tampering in R2 fake store verified via GET response
  const storedItem = r2Fake.r2Storage.get(r2Url);
  const corrupted = new Uint8Array(storedItem.bytes);
  corrupted[0] ^= 0xff;
  r2Fake.r2Storage.set(r2Url, { ...storedItem, bytes: corrupted });

  const corruptedGet = await r2Fake.fetchImpl(r2Url, { method: 'GET' });
  assert.equal(corruptedGet.status, 200);
  const corruptedBytes = new Uint8Array(await corruptedGet.arrayBuffer());
  assert.notEqual(h(corruptedBytes), PDF_SHA256);

  // No further D1 POSTs sent
  assert.equal(d1Stub.getPostCount(), artifact.chunks.length);
});
