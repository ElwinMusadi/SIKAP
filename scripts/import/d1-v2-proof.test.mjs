// LOCAL Miniflare integration tests for D1 Transport v2 Proof Runner (SIKAP).
// Scope: Ephemeral Miniflare D1 (d1Persist: false, outbound 403, cf: false) + fake REST fetch stub.
// Local protocol emulation only against local prepared schema (0001..0008 + ledger). Not remote proof.
// All authority flags remain false. No remote credentials, network, or production access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { canonicalRow } from '../migrate/apply-local.mjs';
import { splitMigration } from '../migrate/local-store.mjs';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { COLUMNS, PRIMARY, LEDGER, validateDescriptor } from './core.mjs';
import { LEDGER_SQL_FILE, LEDGER_DDL_SHA256, validateLedgerSql } from './ledger-contract.mjs';
import { ENDPOINT_ORIGIN, ENDPOINT_PATH } from './d1-rest.mjs';
import { hashBaseline } from './synthetic-runner.mjs';
import {
  PROOF_VERSION, PROOF_STEPS, buildD1V2Proof, summarizeProof, runD1V2Proof, D1V2ProofError,
} from './d1-v2-proof.mjs';

const ROOT = new URL('../../', import.meta.url);
const DDL = readFileSync(new URL(LEDGER_SQL_FILE, ROOT), 'utf8');
const MIGRATIONS = readdirSync(new URL('migrations/', ROOT)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort()
  .map((n) => readFileSync(new URL(`migrations/${n}`, ROOT), 'utf8'));

const NOW = '2026-10-18T00:00:00.000Z';
const D1_TOKEN = 'SYNTHETIC-TEST-TOKEN-' + 'A'.repeat(30);
const h = (data) => createHash('sha256').update(data).digest('hex');

const makeDescriptor = (baseline, over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT,
  databaseId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', databaseName: 'sikap-import-synthetic-1',
  bucket: 'sikap-import-synthetic-1-files', profile: 'synthetic',
  snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: LEDGER_DDL_SHA256, baselineSha256: hashBaseline(baseline),
  policySha256: h('policy'), retentionPolicySha256: h('retention'),
  runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: '2026-10-18T04:00:00.000Z', ...over,
});

async function openDb(t) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
    outboundService: () => new Response(null, { status: 403 }), log: new Log(LogLevel.NONE),
    cf: false, telemetry: { enabled: false }, d1Databases: { DB: 'sikap-proof-local' }, d1Persist: false,
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const sql of MIGRATIONS) await db.batch(splitMigration(sql).map((s) => db.prepare(s)));
  assert.equal(validateLedgerSql(DDL).valid, true);
  await db.batch(splitMigration(DDL).map((s) => db.prepare(s)));
  return db;
}

async function readBaseline(db) {
  const base = {};
  for (const table of IMPORT_TABLES) {
    const rows = (await db.prepare(`SELECT ${COLUMNS[table].join(', ')} FROM ${table} ORDER BY ${PRIMARY[table].join(', ')}`).all()).results;
    base[table] = rows.map((r) => {
      const obj = {};
      for (const col of COLUMNS[table]) obj[col] = r[col];
      return obj;
    });
  }
  return base;
}

async function bootstrapLedger(db, d) {
  const target = validateDescriptor(d, NOW).targetBindingSha256;
  const row = {
    id: 1, run_nonce: d.runNonce, owner_nonce: d.ownerNonce, epoch: d.epoch,
    target_binding_sha256: target, plan_sha256: d.planSha256, stage: 0, cursor: 0,
    ordinal: 0, claim_seq: 0, last_chunk_sha256: null, complete: 0,
  };
  const RUN_INSERT = `INSERT INTO ${LEDGER.runTable} (${LEDGER.runColumns.join(', ')}) VALUES (${LEDGER.runColumns.map(() => '?').join(', ')})`;
  await db.prepare(RUN_INSERT).bind(...LEDGER.runColumns.map((c) => row[c])).run();
}

async function snapshot(db) {
  const schema = (await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").all()).results;
  const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()).results.map((r) => r.name);
  const out = { schema };
  for (const name of names) out[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  return JSON.stringify(out);
}

function createFetchStub(db, d, {
  simulateNonAtomicFirstFault = false,
  simulateUnexpectedSuccessOnFault = false,
  simulateMalformedEnvelopeOnCommitStep = null,
} = {}) {
  const expectedUrl = `${ENDPOINT_ORIGIN}${ENDPOINT_PATH(d.accountId, d.databaseId)}`;
  let postCount = 0;
  const calls = [];
  const faultSnapshots = [];

  const fetchImpl = async (url, init = {}) => {
    assert.equal(url, expectedUrl);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers?.['Content-Type'], 'application/json');
    assert.match(init.headers?.Authorization ?? '', /^Bearer SYNTHETIC-TEST-TOKEN-/);
    postCount++;
    calls.push({ url, method: init.method, body: init.body });

    const { batch } = JSON.parse(init.body);

    if (simulateNonAtomicFirstFault && postCount === 2) {
      // Partial non-atomic execution: apply claim to DB before failure
      await db.prepare(batch[0].sql).bind(...batch[0].params).run();
      return new Response(JSON.stringify({
        success: false, errors: [{ code: 7500, message: 'D1_ERROR: simulated non-atomic failure' }], messages: [], result: null,
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    if (simulateUnexpectedSuccessOnFault && postCount === 2) {
      const fakeResult = batch.map((s, idx) => {
        if (idx === 1 || idx === batch.length - 1) {
          return { success: true, results: [{ sikap_import_guard: 1 }], meta: { changes: 1 } };
        }
        return { success: true, results: [], meta: { changes: 1 } };
      });
      return new Response(JSON.stringify({
        success: true, errors: [], messages: [], result: fakeResult,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const snapBeforeBatch = await snapshot(db);
    let mfResults;
    try {
      mfResults = await db.batch(batch.map((s) => db.prepare(s.sql).bind(...s.params)));
    } catch (err) {
      const snapAfterThrow = await snapshot(db);
      faultSnapshots.push({ postCount, before: snapBeforeBatch, after: snapAfterThrow, error: err.message });
      return new Response(JSON.stringify({
        success: false, errors: [{ code: 7500, message: 'D1_ERROR: ' + err.message }], messages: [], result: null,
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    if (simulateMalformedEnvelopeOnCommitStep !== null && postCount === simulateMalformedEnvelopeOnCommitStep) {
      return new Response(JSON.stringify({
        success: true, errors: [], messages: [], result: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const result = mfResults.map((r) => {
      assert.equal(r.success, true);
      const item = { success: r.success, results: Array.isArray(r.results) ? r.results.map((x) => ({ ...x })) : [] };
      if (r.meta && typeof r.meta.changes === 'number') item.meta = { changes: r.meta.changes };
      return item;
    });

    return new Response(JSON.stringify({
      success: true, errors: [], messages: [], result,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return { fetchImpl, getPostCount: () => postCount, getCalls: () => calls, getFaultSnapshots: () => faultSnapshots };
}

test('Test 1: build determinism, safe summary, synthetic descriptor and baseline checks', async (t) => {
  const db = await openDb(t);
  const base = await readBaseline(db);
  const d = makeDescriptor(base);

  const m1 = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });
  const m2 = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });

  assert.equal(m1.steps.length, 11);
  assert.equal(m2.steps.length, 11);
  assert.deepEqual(m1.steps.map((s) => s.label), PROOF_STEPS);
  assert.deepEqual(m2.steps.map((s) => s.label), PROOF_STEPS);
  assert.ok(Array.isArray(m1.expected) && m1.expected.length === 8);
  assert.ok(m1.steps.every((step) => Array.isArray(step.chunk?.batch) && step.chunk.batch.length >= 5));
  assert.deepEqual(m1, m2);

  const s = summarizeProof(m1);
  assert.equal(s.globalProof, false);
  assert.equal(s.remoteAuthorized, false);
  assert.equal(s.transportProven, false);
  assert.equal(s.readyForImport, false);
  assert.equal(s.authorizesRetry, false);
  assert.equal(s.cleanupAuthorized, false);
  assert.equal(Object.hasOwn(s, 'token'), false);
  assert.equal(Object.hasOwn(s, 'steps'), false);

  assert.throws(
    () => buildD1V2Proof({ descriptor: makeDescriptor(base, { profile: 'real-data' }), baseline: base, now: NOW }),
    (err) => err instanceof D1V2ProofError && (err.code === 'PROFILE_BLOCKED' || err.code === 'DESCRIPTOR_INVALID'),
  );

  assert.throws(
    () => buildD1V2Proof({ descriptor: makeDescriptor(base, { baselineSha256: h('wrong') }), baseline: base, now: NOW }),
    (err) => err instanceof D1V2ProofError && err.code === 'BASELINE_HASH_MISMATCH',
  );

  const dirtyBase = {
    ...base,
    pegawai: [canonicalRow('pegawai', {
      id: 900001, nip: '099001012020000001', nik: null, nama: 'Sintetis', status_kepegawaian: 'PNS',
      pangkat_kode: null, unit_id: 1, pendidikan_kode: 'S1', alamat: null,
    }, NOW)],
  };
  assert.throws(
    () => buildD1V2Proof({ descriptor: makeDescriptor(dirtyBase), baseline: dirtyBase, now: NOW }),
    (err) => err instanceof D1V2ProofError && (err.code === 'BASELINE_NOT_SEED_ONLY' || err.code === 'BASELINE_HASH_MISMATCH'),
  );
});

test('Test 2: full 11-step execution, faults rollback, type fidelity, lost response, authority flags false', async (t) => {
  const db = await openDb(t);
  const base = await readBaseline(db);
  const d = makeDescriptor(base);
  await bootstrapLedger(db, d);

  const m = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });
  const stub = createFetchStub(db, d);

  const rep = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stub.fetchImpl, nowProvider: () => NOW });

  assert.equal(rep.proofVersion, PROOF_VERSION);
  assert.equal(rep.status, 'SYNTHETIC_PROOF_OBSERVED');
  assert.equal(rep.counts.sends, 11);
  assert.equal(rep.counts.reads, 12);
  assert.equal(rep.counts.stepsPassed, 11);
  assert.equal(rep.counts.stepsTotal, 11);
  assert.equal(rep.steps.length, 11);
  assert.equal(stub.getPostCount(), 23);
  const faults = stub.getFaultSnapshots();
  assert.deepEqual(faults.map((fault) => fault.postCount), [2, 8, 12, 14]);
  const categories = [/CHECK constraint failed/, /UNIQUE constraint failed: pegawai\./, /FOREIGN KEY constraint failed/, /malformed JSON/];
  faults.forEach((fault, i) => {
    assert.equal(fault.after, fault.before, `Fault ${i} must roll back all local schema and rows`);
    assert.match(fault.error, categories[i]);
    assert.doesNotMatch(fault.error, /syntax error|no such (table|column)|SQLITE_RANGE|incomplete input|wrong number/i);
  });

  assert.equal(rep.steps[0].label, 'FAULT_CHECK_JENIS');
  assert.equal(rep.steps[0].stateUnchangedObserved, true);
  assert.equal(rep.steps[0].passed, true);

  assert.equal(rep.steps[1].label, 'COMMIT_JENIS');
  assert.equal(rep.steps[1].exactStateObserved, true);
  assert.equal(rep.steps[1].observation, 'COMMITTED_OBSERVED');
  assert.equal(rep.steps[1].passed, true);

  assert.equal(rep.steps[2].label, 'COMMIT_WAJIB');
  assert.equal(rep.steps[2].exactStateObserved, true);
  assert.equal(rep.steps[2].passed, true);

  assert.equal(rep.steps[3].label, 'FAULT_UNIQUE_PEGAWAI');
  assert.equal(rep.steps[3].stateUnchangedObserved, true);
  assert.equal(rep.steps[3].passed, true);

  assert.equal(rep.steps[4].label, 'COMMIT_PEGAWAI');
  assert.equal(rep.steps[4].exactStateObserved, true);
  assert.equal(rep.steps[4].passed, true);

  assert.equal(rep.steps[5].label, 'FAULT_FK_AKUN');
  assert.equal(rep.steps[5].stateUnchangedObserved, true);
  assert.equal(rep.steps[5].passed, true);

  assert.equal(rep.steps[6].label, 'REPLAY_PEGAWAI');
  assert.equal(rep.steps[6].stateUnchangedObserved, true);
  assert.equal(rep.steps[6].passed, true);

  assert.equal(rep.steps[7].label, 'COMMIT_AKUN');
  assert.equal(rep.steps[7].exactStateObserved, true);
  assert.equal(rep.steps[7].passed, true);

  assert.equal(rep.steps[8].label, 'COMMIT_ARSIP_EMPTY');
  assert.equal(rep.steps[8].exactStateObserved, true);
  assert.equal(rep.steps[8].passed, true);

  assert.equal(rep.steps[9].label, 'COMMIT_RIWAYAT_EMPTY');
  assert.equal(rep.steps[9].exactStateObserved, true);
  assert.equal(rep.steps[9].passed, true);

  assert.equal(rep.steps[10].label, 'LOST_RESPONSE_LOG');
  assert.equal(rep.steps[10].observation, 'COMMITTED_OBSERVED');
  assert.equal(rep.steps[10].passed, true);

  const run = await db.prepare(`SELECT * FROM ${LEDGER.runTable} WHERE id = 1`).first();
  assert.equal(run.stage, 7);
  assert.equal(run.complete, 0);

  const peg1 = await db.prepare('SELECT * FROM pegawai WHERE id = 900001').first();
  assert.ok(peg1);
  assert.match(peg1.nip, /^0/);
  const peg2 = await db.prepare('SELECT * FROM pegawai WHERE id = 900002').first();
  assert.ok(peg2);
  assert.equal(peg2.nik, null);

  const journalEntries = (await db.prepare(`SELECT * FROM ${LEDGER.journalTable} ORDER BY ordinal`).all()).results;
  assert.equal(journalEntries.length, 7);

  const faultSnaps = stub.getFaultSnapshots();
  assert.ok(faultSnaps.length >= 4);
  for (const snap of faultSnaps) {
    assert.equal(snap.before, snap.after);
  }

  assert.equal(rep.globalProof, false);
  assert.equal(rep.remoteAuthorized, false);
  assert.equal(rep.transportProven, false);
  assert.equal(rep.readyForImport, false);
  assert.equal(rep.authorizesRetry, false);
  assert.equal(rep.cleanupAuthorized, false);
});

test('Test 3: initial non-matching or missing bootstrap stops with zero mutating sends and unchanged db', async (t) => {
  const db = await openDb(t);
  const base = await readBaseline(db);
  const d = makeDescriptor(base);
  const m = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });
  const stub = createFetchStub(db, d);

  const snapBefore = await snapshot(db);
  const rep = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stub.fetchImpl, nowProvider: () => NOW });

  assert.equal(rep.status, 'STOPPED_INITIAL_STATE_MISMATCH');
  assert.equal(rep.counts.sends, 0);
  assert.equal(rep.counts.reads, 1);
  const snapAfter = await snapshot(db);
  assert.equal(snapBefore, snapAfter);

  await bootstrapLedger(db, d);
  await db.prepare("INSERT INTO pegawai (id, nip, nama, status_kepegawaian, unit_id, pendidikan_kode) VALUES (999999, '099999999999999999', 'Stray', 'PNS', 1, 'S1')").run();
  const snapBeforeStray = await snapshot(db);
  const stub2 = createFetchStub(db, d);
  const repStray = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stub2.fetchImpl, nowProvider: () => NOW });
  assert.equal(repStray.status, 'STOPPED_INITIAL_STATE_MISMATCH');
  assert.equal(repStray.counts.sends, 0);
  assert.equal(repStray.counts.reads, 1);
  const snapAfterStray = await snapshot(db);
  assert.equal(snapBeforeStray, snapAfterStray);
});

test('Test 4: non-atomic partial execution detection halts after 1 send', async (t) => {
  const db = await openDb(t);
  const base = await readBaseline(db);
  const d = makeDescriptor(base);
  await bootstrapLedger(db, d);
  const m = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });
  const stub = createFetchStub(db, d, { simulateNonAtomicFirstFault: true });

  const snapBefore = await snapshot(db);
  const rep = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stub.fetchImpl, nowProvider: () => NOW });

  assert.equal(rep.status, 'STOPPED_STATE_MISMATCH');
  assert.equal(rep.counts.sends, 1);
  assert.equal(rep.counts.reads, 2);
  assert.equal(stub.getPostCount(), 3);
  assert.equal(rep.manualRecoveryRequired, true);
  const snapAfter = await snapshot(db);
  assert.notEqual(snapBefore, snapAfter);
});

test('Test 5: unexpected fault acceptance halts before further writes', async (t) => {
  const db = await openDb(t);
  const base = await readBaseline(db);
  const d = makeDescriptor(base);
  await bootstrapLedger(db, d);
  const m = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });
  const stub = createFetchStub(db, d, { simulateUnexpectedSuccessOnFault: true });

  const rep = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stub.fetchImpl, nowProvider: () => NOW });

  assert.equal(rep.status, 'STOPPED_UNEXPECTED_OUTCOME');
  assert.equal(rep.reason, 'FAULT_ACCEPTED');
  assert.equal(rep.counts.sends, 1);
});

test('Test 6: malformed positive envelope after commit halts with one observation and no resend', async (t) => {
  const db = await openDb(t);
  const base = await readBaseline(db);
  const d = makeDescriptor(base);
  await bootstrapLedger(db, d);
  const m = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });
  // Step 1 send is postCount 2, post-read is postCount 3, Step 2 send is postCount 4
  const stub = createFetchStub(db, d, { simulateMalformedEnvelopeOnCommitStep: 4 });

  const rep = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stub.fetchImpl, nowProvider: () => NOW });

  assert.equal(rep.status, 'STOPPED_UNEXPECTED_OUTCOME');
  assert.equal(rep.reason, 'RESULT_COUNT');
  assert.equal(rep.counts.sends, 2);
  assert.equal(rep.counts.reads, 3);
  assert.equal(stub.getPostCount(), 5);
  assert.equal(rep.steps[1].label, 'COMMIT_JENIS');
  assert.equal(rep.steps[1].passed, false);
});

test('Test 7: clock rollback and lease expiry safeguards halt immediately', async (t) => {
  const db = await openDb(t);
  const base = await readBaseline(db);
  const d = makeDescriptor(base);
  await bootstrapLedger(db, d);
  const m = buildD1V2Proof({ descriptor: d, baseline: base, now: NOW });

  let callCount = 0;
  const rollbackNow = () => {
    callCount++;
    return callCount === 1 ? NOW : '2026-10-17T00:00:00.000Z';
  };
  const stubRollback = createFetchStub(db, d);
  const repRollback = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stubRollback.fetchImpl, nowProvider: rollbackNow });
  assert.equal(repRollback.status, 'STOPPED_CLOCK_INVALID');
  assert.equal(repRollback.counts.sends, 0);

  const expiredNow = () => '2026-10-18T05:00:00.000Z';
  const stubExpired = createFetchStub(db, d);
  const repExpired = await runD1V2Proof({ manifest: m, token: D1_TOKEN, fetchImpl: stubExpired.fetchImpl, nowProvider: expiredNow });
  assert.equal(repExpired.status, 'STOPPED_DESCRIPTOR_EXPIRED');
  assert.equal(repExpired.counts.sends, 0);
});
