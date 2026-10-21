// Synthetic-only tests for the MOCK importer adapter. In-memory simulation; no network, SQL engine,
// Miniflare, filesystem writes or real data. Simulated faults prove nothing about real transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { COLUMNS, compileChunks, classifyResume } from './core.mjs';
import { createMockAdapter, MockAdapterError, MOCK_FAULTS, MOCK_ERROR_CODES } from './mock-adapter.mjs';

const NOW = '2026-10-18T00:00:00.000Z';
const LATER = '2026-10-18T00:30:00.000Z';
const EXPIRES = '2026-10-18T01:00:00.000Z';
const CREATED = '2026-10-01T00:00:00.000Z';
const PII = 'SENTINEL-PII-Nama \u00e9 \u{1F600}';
const h = (seed) => createHash('sha256').update(seed).digest('hex');
const descriptor = (over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT,
  databaseId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', databaseName: 'sikap-import-synthetic-1', bucket: 'sikap-import-synthetic-1-files',
  profile: 'synthetic', snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: h('ledger'), baselineSha256: h('baseline'), policySha256: h('policy'),
  retentionPolicySha256: h('retention'), runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: EXPIRES, ...over,
});
const row = (table, values) => Object.fromEntries(COLUMNS[table].map((c) => [c, Object.hasOwn(values, c) ? values[c] : null]));
// Canonical synthetic tables built from core COLUMNS (no business validation needed by the mock).
function tables({ jenis = 2, pegawai = 3, logs = 2, extraWajib = [] } = {}) {
  const t = Object.fromEntries(IMPORT_TABLES.map((table) => [table, []]));
  for (let i = 1; i <= jenis; i++) {
    t.jenis_dokumen.push(row('jenis_dokumen', { id: `DOC-SYN${i}`, nama: `Jenis ${i}`, kategori: 'Sintetis', urutan: i, aktif: 1, updated_at: CREATED }));
    t.jenis_dokumen_wajib.push(row('jenis_dokumen_wajib', { jenis_dokumen_id: `DOC-SYN${i}`, status_kepegawaian: 'PNS' }));
  }
  for (const extra of extraWajib) t.jenis_dokumen_wajib.push(row('jenis_dokumen_wajib', extra));
  for (let i = 1; i <= pegawai; i++) {
    t.pegawai.push(row('pegawai', { id: i, nip: `1990${String(i).padStart(14, '0')}`, nama: `${PII} ${i}`, role: 'Pegawai', created_at: CREATED }));
    t.akun.push(row('akun', { pegawai_id: i, password_hash: `legacy-wrap$SECRETHASH${i}`, is_default_password: 0, failed_attempts: 0 }));
  }
  t.arsip_dokumen.push(row('arsip_dokumen', { id: 1, pegawai_id: 1, jenis_dokumen_id: 'DOC-SYN1', status: 'Menunggu' }));
  for (let i = 1; i <= logs; i++) t.log_aktivitas.push(row('log_aktivitas', { id: i, ts: CREATED, action: 'SYN', description: `${PII} log` }));
  return t;
}
const SEED = () => ({
  jenis_dokumen: [row('jenis_dokumen', { id: 'UNTOUCHED', nama: 'Seed', aktif: 1 }), row('jenis_dokumen', { id: 'DOC-SYN1', nama: 'Old seed name', aktif: 1 })],
  jenis_dokumen_wajib: [row('jenis_dokumen_wajib', { jenis_dokumen_id: 'UNTOUCHED', status_kepegawaian: 'PNS' }), row('jenis_dokumen_wajib', { jenis_dokumen_id: 'DOC-SYN1', status_kepegawaian: 'PPPK' })],
});
const compile = (t = tables(), d = descriptor()) => compileChunks({ tables: t }, d, { now: NOW });
const adapter = (artifact, extra = {}) => createMockAdapter({ artifact, descriptor: descriptor(), now: NOW, ...extra });
const codeOf = (fn) => {
  try { fn(); } catch (error) { assert.ok(error instanceof MockAdapterError, String(error?.name)); assert.equal(error.message, error.code); return error.code; }
  return null;
};
const classify = (artifact, mock, ordinal) => classifyResume({ artifact, ordinal, ...mock.inspect().resume });
const assertFlags = (out) => {
  assert.equal(out.localOnly, true);
  assert.equal(out.simulated, true);
  for (const key of ['transportProof', 'transportProven', 'authorizesRetry', 'authorizesSend', 'autoResendAllowed', 'remoteAuthorized', 'readyForImport', 'authorizesExecution']) assert.equal(out[key], false, key);
  assert.ok(Object.isFrozen(out));
};
const assertNoSecrets = (out, artifact) => {
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /SENTINEL|SECRETHASH|DOC-SYN|UNTOUCHED|0123456789abcdef|fedcba98|[0-9a-f]{64}/);
  if (artifact) for (const chunk of artifact.chunks) assert.ok(!text.includes(chunk.chunkSha256));
};
const runAll = (artifact, mock, from = 0) => { for (const chunk of artifact.chunks.slice(from)) assert.equal(mock.send({ chunk, now: NOW, fault: 'none' }).outcome, 'APPLIED_SIMULATED'); };

test('static purity: imports only pure contract/core; no I/O, env, clock, network, spawn or timers', () => {
  const source = readFileSync(new URL('./mock-adapter.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../migrate/contract.mjs', './core.mjs']);
  for (const bad of [/process\./, /\bfetch\b/, /Date\.now/, /new Date\(/, /require\(/, /import\(/, /child_process/, /node:/, /console\./, /Math\.random/, /eval\(/, /setTimeout|setInterval/, /globalThis/, /XMLHttpRequest|WebSocket/]) assert.doesNotMatch(source, bad);
  assert.deepEqual(MOCK_FAULTS, ['none', 'rollback-after-claim', 'rollback-after-data', 'rollback-after-journal', 'timeout-before-commit', 'timeout-after-commit', 'timeout-pending', 'http-429', 'http-500', 'malformed-response']);
});

test('happy path: every chunk applied in order; summary counts only, complete false, flags false', () => {
  const artifact = compile();
  const mock = adapter(artifact);
  assert.ok(Object.isFrozen(mock));
  assert.deepEqual(Object.keys(mock).sort(), ['inspect', 'send', 'settle', 'summary']);
  const first = mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' });
  assertFlags(first);
  assert.equal(first.halted, false);
  assertNoSecrets(first, artifact);
  runAll(artifact, mock, 1);
  const s = mock.summary();
  assertFlags(s);
  assertNoSecrets(s, artifact);
  assert.equal(s.complete, false);
  assert.equal(s.allChunksApplied, true);
  assert.equal(s.committedChunks, artifact.chunkCount);
  assert.equal(s.journalCount, artifact.chunkCount);
  assert.equal(s.sentCount, artifact.chunkCount);
  assert.deepEqual({ ...s.rowsByTable }, { jenis_dokumen: 2, jenis_dokumen_wajib: 2, pegawai: 3, akun: 3, arsip_dokumen: 1, arsip_dokumen_riwayat: 0, log_aktivitas: 2 });
  const view = mock.inspect();
  assert.equal(view.private, true);
  assert.equal(view.resume.exactPrefixVerified, true);
  assert.equal(view.resume.writerQuiescent, true);
  const verdict = classify(artifact, mock, artifact.chunkCount - 1);
  assert.equal(verdict.outcome, 'COMMITTED_OBSERVED');
  assert.equal(verdict.authorizesSend, false);
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' })), 'RUN_EXHAUSTED');
});

test('empty tables still advance ledger and journal; no seed delete without imported jenis', () => {
  const artifact = compile(tables({ jenis: 0, pegawai: 0, logs: 0 }));
  const mock = adapter(artifact, { seed: SEED() });
  runAll(artifact, mock);
  const s = mock.summary();
  assert.equal(s.journalCount, artifact.chunkCount);
  assert.equal(s.allChunksApplied, true);
  assert.equal(s.rowsByTable.jenis_dokumen_wajib, 2);
  assert.equal(mock.inspect().resume.exactPrefixVerified, true);
});

test('seed: upsert keeps untouched jenis, deletes only imported-id matrix rows, prefix verified', () => {
  const artifact = compile();
  const mock = adapter(artifact, { seed: SEED() });
  assert.deepEqual({ ...mock.summary().rowsByTable }, { jenis_dokumen: 2, jenis_dokumen_wajib: 2, pegawai: 0, akun: 0, arsip_dokumen: 0, arsip_dokumen_riwayat: 0, log_aktivitas: 0 });
  runAll(artifact, mock);
  const s = mock.summary();
  assert.equal(s.rowsByTable.jenis_dokumen, 3); // UNTOUCHED + DOC-SYN1 (upserted) + DOC-SYN2
  assert.equal(s.rowsByTable.jenis_dokumen_wajib, 3); // UNTOUCHED/PNS kept, DOC-SYN1/PPPK deleted, 2 imported
  assert.equal(mock.inspect().resume.exactPrefixVerified, true);
  const bad = [
    { ...SEED(), pegawai: [] }, { jenis_dokumen: [] }, { ...SEED(), jenis_dokumen: [{ id: 'X' }] },
    { ...SEED(), jenis_dokumen_wajib: [SEED().jenis_dokumen_wajib[0], SEED().jenis_dokumen_wajib[0]] },
    { ...SEED(), jenis_dokumen: [row('jenis_dokumen', { id: null })] }, { ...SEED(), jenis_dokumen: [row('jenis_dokumen', { id: 'A', urutan: 1.5 })] },
    { ...SEED(), jenis_dokumen: [row('jenis_dokumen', { id: 1 })] }, { ...SEED(), jenis_dokumen: [row('jenis_dokumen', { id: '' })] },
    { ...SEED(), jenis_dokumen_wajib: [row('jenis_dokumen_wajib', { jenis_dokumen_id: 'A', status_kepegawaian: 1 })] },
  ];
  for (const seed of bad) assert.equal(codeOf(() => adapter(artifact, { seed })), 'SEED_INVALID');
  let called = false;
  const getter = SEED();
  Object.defineProperty(getter.jenis_dokumen[0], 'nama', { enumerable: true, get() { called = true; return 'x'; } });
  assert.equal(codeOf(() => adapter(artifact, { seed: getter })), 'SEED_INVALID');
  assert.equal(called, false);
});

test('injected rollback faults publish nothing (data/journal/checkpoint) and halt the instance', () => {
  const artifact = compile();
  for (const fault of ['rollback-after-claim', 'rollback-after-data', 'rollback-after-journal']) {
    for (const ordinal of [0, 2]) { // 0: seed delete + jenis upsert chunk; 2: pegawai insert chunk
      const mock = adapter(artifact, { seed: SEED() });
      for (const chunk of artifact.chunks.slice(0, ordinal)) mock.send({ chunk, now: NOW, fault: 'none' });
      const before = mock.summary();
      const out = mock.send({ chunk: artifact.chunks[ordinal], now: NOW, fault });
      verify(mock, before, out, artifact, ordinal);
    }
  }
  function verify(mock, before, out, art, ordinal) {
    assertFlags(out);
    assert.equal(out.outcome, 'ROLLED_BACK_SIMULATED');
    assert.equal(out.rollbackReason, 'INJECTED_ROLLBACK');
    assert.equal(out.halted, true);
    const after = mock.summary();
    assert.deepEqual(after.rowsByTable, before.rowsByTable);
    assert.equal(after.committedChunks, before.committedChunks);
    assert.equal(after.journalCount, before.journalCount);
    assert.equal(mock.inspect().resume.observedReceipt.claimSeq, ordinal);
    assert.equal(codeOf(() => mock.send({ chunk: art.chunks[ordinal], now: NOW, fault: 'none' })), 'HALTED');
    assert.equal(mock.summary().sentCount, ordinal + 1);
    const verdict = classify(art, mock, ordinal);
    assert.equal(verdict.outcome, 'NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED');
    assert.equal(verdict.authorizesSend, false);
  }
});

test('real mock constraint violation (duplicate matrix row vs untouched seed) rolls back whole chunk', () => {
  const artifact = compile(tables({ extraWajib: [{ jenis_dokumen_id: 'UNTOUCHED', status_kepegawaian: 'PNS' }] }));
  const mock = adapter(artifact, { seed: SEED() });
  assert.equal(mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' }).outcome, 'APPLIED_SIMULATED');
  const stage1 = artifact.chunks[1];
  assert.equal(stage1.table, 'jenis_dokumen_wajib');
  const before = mock.summary();
  const out = mock.send({ chunk: stage1, now: NOW, fault: 'none' });
  assert.equal(out.outcome, 'ROLLED_BACK_SIMULATED');
  assert.equal(out.rollbackReason, 'CONSTRAINT_ABORT');
  assert.equal(out.halted, true);
  assertNoSecrets(out, artifact);
  const after = mock.summary();
  assert.deepEqual(after.rowsByTable, before.rowsByTable); // imported DOC-SYN rows of the same chunk not kept
  assert.equal(after.journalCount, 1);
  assert.equal(mock.inspect().resume.exactPrefixVerified, true);
  assert.equal(classify(artifact, mock, 1).outcome, 'NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED');
});

test('timeout-after-commit / malformed-response: applied, AMBIGUOUS + halted, no resend, core COMMITTED', () => {
  const artifact = compile();
  for (const fault of ['timeout-after-commit', 'malformed-response']) {
    const mock = adapter(artifact);
    const out = mock.send({ chunk: artifact.chunks[0], now: NOW, fault });
    assertFlags(out);
    assert.equal(out.outcome, 'AMBIGUOUS_SIMULATED');
    assert.equal(out.halted, true);
    assert.equal(out.operatorDecisionRequired, true);
    for (const chunk of [artifact.chunks[0], artifact.chunks[1]]) assert.equal(codeOf(() => mock.send({ chunk, now: NOW, fault: 'none' })), 'HALTED');
    const s = mock.summary();
    assert.equal(s.sentCount, 1);
    assert.equal(s.committedChunks, 1);
    const view = mock.inspect().resume;
    assert.equal(view.exactPrefixVerified, true);
    assert.equal(view.journal.length, 1);
    const verdict = classify(artifact, mock, 0);
    assert.equal(verdict.outcome, 'COMMITTED_OBSERVED');
    assert.equal(verdict.authorizesSend, false);
    assert.equal(verdict.autoResendAllowed, false);
  }
});

test('timeout-before-commit / http-429 / http-500: unchanged, halted, NOT_COMMITTED operator required', () => {
  const artifact = compile();
  for (const fault of ['timeout-before-commit', 'http-429', 'http-500']) {
    const mock = adapter(artifact, { seed: SEED() });
    mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' });
    const before = mock.summary();
    const out = mock.send({ chunk: artifact.chunks[1], now: NOW, fault });
    assert.equal(out.outcome, 'AMBIGUOUS_SIMULATED');
    assert.equal(out.halted, true);
    assert.equal(out.pending, false);
    assertFlags(out);
    const after = mock.summary();
    assert.deepEqual(after.rowsByTable, before.rowsByTable);
    assert.equal(after.committedChunks, 1);
    assert.equal(after.sentCount, 2);
    assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[1], now: NOW, fault: 'none' })), 'HALTED');
    assert.equal(mock.summary().sentCount, 2);
    const verdict = classify(artifact, mock, 1);
    assert.equal(verdict.outcome, 'NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED');
    assert.equal(verdict.authorizesSend, false);
    assert.equal(verdict.operatorDecisionRequired, true);
  }
});

test('timeout-pending: HOLD while not quiescent; late commit then COMMITTED; abort then NOT_COMMITTED', () => {
  const artifact = compile();
  const mock = adapter(artifact);
  const out = mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'timeout-pending' });
  assert.equal(out.outcome, 'AMBIGUOUS_SIMULATED');
  assert.equal(out.pending, true);
  assert.equal(mock.inspect().resume.writerQuiescent, false);
  const hold = classify(artifact, mock, 0);
  assert.equal(hold.outcome, 'HOLD_UNCERTAIN');
  assert.equal(hold.reason, 'WRITER_NOT_QUIESCENT');
  const oldObservation = mock.inspect().resume;
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' })), 'HALTED');
  const settled = mock.settle({ outcome: 'commit' });
  assertFlags(settled);
  assert.equal(settled.simulationControl, true);
  assert.equal(settled.halted, true);
  assert.equal(settled.operatorDecisionRequired, true);
  // The earlier observation is now stale; a fresh read classifies the late commit.
  assert.equal(classifyResume({ artifact, ordinal: 0, ...oldObservation }).outcome, 'HOLD_UNCERTAIN');
  const late = classify(artifact, mock, 0);
  assert.equal(late.outcome, 'COMMITTED_OBSERVED');
  assert.equal(late.authorizesSend, false);
  assert.equal(mock.inspect().resume.writerQuiescent, true);
  assert.equal(codeOf(() => mock.settle({ outcome: 'commit' })), 'NOT_PENDING');
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[1], now: NOW, fault: 'none' })), 'HALTED');
  assert.equal(mock.summary().sentCount, 1);
  assert.equal(mock.summary().settledCount, 1);

  const aborted = adapter(artifact);
  aborted.send({ chunk: artifact.chunks[0], now: NOW, fault: 'timeout-pending' });
  assert.equal(aborted.settle({ outcome: 'abort' }).settled, 'abort'); // no `now`: settle is not expiry-gated
  const verdict = classify(artifact, aborted, 0);
  assert.equal(verdict.outcome, 'NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED');
  assert.equal(verdict.authorizesSend, false);
  assert.equal(aborted.summary().sentCount, 1);
  assert.equal(aborted.summary().committedChunks, 0);
  assert.equal(codeOf(() => aborted.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' })), 'HALTED');
  assert.equal(codeOf(() => adapter(artifact).settle({ outcome: 'commit' })), 'NOT_PENDING');
  assert.equal(codeOf(() => mock.settle({ outcome: 'retry' })), 'INPUT_INVALID');
});

test('wrong descriptor / target / foreign artifact: refused at construction with zero attempts', () => {
  const artifact = compile();
  for (const over of [{ ownerNonce: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { runNonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, { epoch: 1 }, { policySha256: h('policy-B') }, { databaseId: '4f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' }, { bucket: 'sikap-import-synthetic-2-files' }, { planSha256: h('plan-B') }]) {
    assert.equal(codeOf(() => createMockAdapter({ artifact, descriptor: descriptor(over), now: NOW })), 'MOCK_BINDING_MISMATCH');
  }
  // Takeover epoch artifact is a different binding even though chunk hashes are equal.
  const epochOne = compile(tables(), descriptor({ epoch: 1 }));
  assert.equal(codeOf(() => adapter(epochOne)), 'MOCK_BINDING_MISMATCH');
  assert.equal(codeOf(() => createMockAdapter({ artifact, descriptor: descriptor({ databaseName: 'sikap-db' }), now: NOW })), 'DESCRIPTOR_INVALID');
  assert.equal(codeOf(() => createMockAdapter({ artifact, descriptor: descriptor({ expiresAt: NOW }), now: NOW })), 'DESCRIPTOR_EXPIRED');
  assert.equal(codeOf(() => createMockAdapter({ artifact, descriptor: descriptor(), now: 'yesterday' })), 'NOW_INVALID');
  assert.equal(codeOf(() => adapter(structuredClone(artifact))), 'ARTIFACT_UNKNOWN');
  assert.equal(codeOf(() => adapter({ ...artifact })), 'ARTIFACT_UNKNOWN');
  assert.equal(codeOf(() => createMockAdapter({ artifact, descriptor: descriptor(), now: NOW, extra: 1 })), 'INPUT_INVALID');
  assert.equal(codeOf(() => createMockAdapter({ artifact, descriptor: descriptor() })), 'INPUT_INVALID');
});

test('expiry and now are revalidated before every send; no attempt is counted', () => {
  const artifact = compile();
  const mock = adapter(artifact);
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: EXPIRES, fault: 'none' })), 'DESCRIPTOR_EXPIRED');
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: '2026-10-18T02:00:00.000Z', fault: 'none' })), 'DESCRIPTOR_EXPIRED');
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: '2026-10-18', fault: 'none' })), 'NOW_INVALID');
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: 1792270000000, fault: 'none' })), 'NOW_INVALID');
  assert.equal(mock.summary().sentCount, 0);
  assert.equal(mock.send({ chunk: artifact.chunks[0], now: LATER, fault: 'none' }).outcome, 'APPLIED_SIMULATED');
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[1], now: NOW, fault: 'none' })), 'NOW_INVALID'); // clock rollback
  assert.equal(mock.summary().sentCount, 1);
  assert.equal(mock.summary().halted, false);
});

test('duplicate, stale, out-of-order and fake chunks are refused before any mutation', () => {
  const artifact = compile();
  const other = compile();
  const mock = adapter(artifact);
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[1], now: NOW, fault: 'none' })), 'CHUNK_OUT_OF_ORDER');
  assert.equal(codeOf(() => mock.send({ chunk: { ...artifact.chunks[0] }, now: NOW, fault: 'none' })), 'CHUNK_FOREIGN');
  assert.equal(codeOf(() => mock.send({ chunk: other.chunks[0], now: NOW, fault: 'none' })), 'CHUNK_FOREIGN');
  assert.equal(codeOf(() => mock.send({ chunk: new Proxy(artifact.chunks[0], {}), now: NOW, fault: 'none' })), 'CHUNK_FOREIGN');
  mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' });
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' })), 'CHUNK_STALE');
  assert.equal(codeOf(() => mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'rollback-after-claim' })), 'CHUNK_STALE');
  const s = mock.summary();
  assert.equal(s.sentCount, 1);
  assert.equal(s.committedChunks, 1);
  assert.equal(s.halted, false);
  assert.equal(mock.inspect().resume.exactPrefixVerified, true);
});

test('hostile inputs fail closed with closed codes; no getter runs; no raw values echoed', () => {
  const artifact = compile();
  const mock = adapter(artifact);
  const chunk = artifact.chunks[0];
  for (const fault of ['retry', 'NONE', '', null, 429]) assert.equal(codeOf(() => mock.send({ chunk, now: NOW, fault })), 'FAULT_INVALID');
  assert.equal(codeOf(() => mock.send({ chunk, now: NOW })), 'INPUT_INVALID');
  assert.equal(codeOf(() => mock.send({ chunk, now: NOW, fault: 'none', sql: 'DROP TABLE pegawai' })), 'INPUT_INVALID');
  assert.equal(codeOf(() => mock.send(Object.assign(Object.create({ x: 1 }), { chunk, now: NOW, fault: 'none' }))), 'INPUT_INVALID');
  let called = false;
  const args = { chunk, now: NOW };
  Object.defineProperty(args, 'fault', { enumerable: true, get() { called = true; return 'none'; } });
  assert.equal(codeOf(() => mock.send(args)), 'INPUT_INVALID');
  assert.equal(called, false);
  const secret = 'SECRET-PROXY-VALUE';
  assert.equal(codeOf(() => mock.send(new Proxy({}, { ownKeys() { throw new Error(secret); } }))), 'INPUT_INVALID');
  try { mock.send({ chunk, now: secret, fault: 'none' }); } catch (error) { assert.doesNotMatch(`${error.message}${error.stack}`, /SECRET/); }
  assert.equal(codeOf(() => mock.inspect({ tamper: true })), 'INPUT_INVALID');
  assert.equal(codeOf(() => mock.summary(1)), 'INPUT_INVALID');
  assert.equal(new MockAdapterError('RAW secret value').message, 'INTERNAL');
  assert.ok(MOCK_ERROR_CODES.includes('MOCK_BINDING_MISMATCH'));
  assert.equal(mock.summary().sentCount, 0);
  assert.throws(() => { mock.send = null; }, TypeError);
});

test('outputs: summary/send/settle are public-safe; inspect is private, frozen and read-only', () => {
  const artifact = compile();
  const mock = adapter(artifact, { seed: SEED() });
  const outs = [mock.send({ chunk: artifact.chunks[0], now: NOW, fault: 'none' }), mock.send({ chunk: artifact.chunks[1], now: NOW, fault: 'timeout-pending' }), mock.settle({ outcome: 'commit' }), mock.summary()];
  for (const out of outs) { assertFlags(out); assertNoSecrets(out, artifact); }
  assert.deepEqual(Object.keys(mock.summary()).sort(), ['allChunksApplied', 'authorizesExecution', 'authorizesRetry', 'authorizesSend', 'autoResendAllowed', 'chunkCount', 'committedChunks', 'complete', 'halted', 'journalCount', 'lastFault', 'lastOutcome', 'localOnly', 'mockVersion', 'pending', 'proofRequired', 'readyForImport', 'remoteAuthorized', 'rowsByTable', 'sentCount', 'settledCount', 'simulated', 'transportProof', 'transportProven']);
  const view = mock.inspect();
  assert.equal(view.private, true);
  assertFlags(view);
  assert.ok(Object.isFrozen(view.resume.journal[0]) && Object.isFrozen(view.resume.observedReceipt));
  assert.ok(!JSON.stringify(view).includes('SENTINEL')); // private view still exposes no row data
  assert.throws(() => { view.resume.journal.push({}); }, TypeError);
  assert.equal(mock.inspect().resume.journal.length, 2);
});
