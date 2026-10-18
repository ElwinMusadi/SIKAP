// Synthetic-only tests for the pure importer core. No network, SQL execution or real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { COLUMNS as APPLY_COLUMNS, PRIMARY as APPLY_PRIMARY, canonicalRow } from '../migrate/apply-local.mjs';
import { BASELINE_DENY } from '../staging/uat-target.mjs';
import { UAT_ACCOUNT, UAT_DB } from '../staging/uat-constants.mjs';
import { PROBE_DATABASE_ID } from '../staging/d1-tx-probe-target.mjs';
import {
  CORE_VERSION, TRANSPORT, LIMITS, COLUMNS, PRIMARY, KEY_TYPES, DENY, SQL, LEDGER, ERROR_CODES, ImportCoreError, validateDescriptor,
  compileChunks, summarize, createState, advanceState, classifyResume, RESUME_OUTCOMES,
} from './core.mjs';

const NOW = '2026-10-18T00:00:00.000Z';
const CREATED = '2026-10-01T00:00:00.000Z';
const h = (seed) => createHash('sha256').update(seed).digest('hex');
const descriptor = (over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT,
  databaseId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', databaseName: 'sikap-import-synthetic-1', bucket: 'sikap-import-synthetic-1-files',
  profile: 'synthetic', snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: h('ledger'), baselineSha256: h('baseline'), policySha256: h('policy'),
  retentionPolicySha256: h('retention'), runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: '2026-10-18T01:00:00.000Z', ...over,
});
const codeOf = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof ImportCoreError); assert.equal(error.message, error.code); return error.code; } return null; };

// Synthetic canonical rows (full COLUMNS via the offline canonicalRow defaults). Fake values only.
const SECRET_NAME = 'Sintetis "Kutip" \u00e9\u00e8 \u{1F600} O\'Neil';
function tables({ pegawai = 3, logs = 2, jenis = 2, wide = 0 } = {}) {
  const t = Object.fromEntries(IMPORT_TABLES.map((table) => [table, []]));
  for (let i = 1; i <= jenis; i++) t.jenis_dokumen.push(canonicalRow('jenis_dokumen', { id: `DOC-SYN${i}`, nama: `Jenis ${i}`, kategori: 'Sintetis' }, CREATED));
  for (let i = 1; i <= jenis; i++) t.jenis_dokumen_wajib.push(canonicalRow('jenis_dokumen_wajib', { jenis_dokumen_id: `DOC-SYN${i}`, status_kepegawaian: 'PNS' }, CREATED));
  for (let i = 1; i <= pegawai; i++) {
    t.pegawai.push(canonicalRow('pegawai', { id: i, nip: `1990${String(i).padStart(14, '0')}`, nama: `${SECRET_NAME} ${i}`, alamat: wide ? 'x'.repeat(wide) : null }, CREATED));
    t.akun.push(canonicalRow('akun', { pegawai_id: i, password_hash: `legacy-wrap$10000$c2FsdHNhbHRzYWx0c2FsdA==$${'A'.repeat(43)}=`, is_default_password: 0 }, CREATED));
  }
  t.arsip_dokumen.push(canonicalRow('arsip_dokumen', { id: 1, pegawai_id: 1, jenis_dokumen_id: 'DOC-SYN1', status: 'Menunggu', r2_key: 'migration/x/document/f-1.pdf', file_name: 'syn.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: h('f'), uploaded_at: CREATED }, CREATED));
  for (let i = 1; i <= logs; i++) t.log_aktivitas.push(canonicalRow('log_aktivitas', { id: i, ts: CREATED, action: 'SYN_EVENT', result: 'SUCCESS', description: `log ${i}` }, CREATED));
  return t;
}
const compile = (t = tables(), d = descriptor()) => compileChunks({ tables: t }, d, { now: NOW });
const placeholders = (sql) => (sql.match(/\?/g) ?? []).length;

test('static purity: only node:crypto and pure contract imports; no I/O/env/clock/network', () => {
  const source = readFileSync(new URL('./core.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../migrate/contract.mjs', '../staging/uat-constants.mjs', 'node:crypto']);
  for (const bad of [/process\./, /\bfetch\b/, /Date\.now/, /new Date\(\)/, /require\(/, /import\(/, /child_process/, /node:fs/, /console\./, /Math\.random/, /eval\(/]) assert.doesNotMatch(source, bad);
});

test('pinned contracts: COLUMNS equal apply-local, deny list covers baseline/UAT/probe, frozen limits', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(COLUMNS)), APPLY_COLUMNS);
  for (const id of [...BASELINE_DENY.databaseIds, UAT_DB, PROBE_DATABASE_ID]) assert.ok(DENY.databaseIds.includes(id));
  for (const name of BASELINE_DENY.databaseNames) assert.ok(DENY.databaseNames.includes(name));
  for (const bucket of BASELINE_DENY.buckets) assert.ok(DENY.buckets.includes(bucket));
  assert.deepEqual({ ...LIMITS }, { bodyBytes: 65536, statementBytes: 100000, statements: 32, parameters: 100, rows: 64 });
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(COLUMNS.pegawai) && Object.isFrozen(SQL.insert) && Object.isFrozen(DENY.buckets));
  assert.equal(CORE_VERSION, 1);
  assert.equal(TRANSPORT, 'd1-rest-parameterized-batch-candidate-v1');
  assert.equal(LEDGER.runTable, '__sikap_import_v1_run');
  for (const sql of [SQL.claim, SQL.checkpoint, SQL.journal, SQL.seedDelete, ...Object.values(SQL.insert)]) assert.doesNotMatch(sql, /REPLACE|CASCADE|DROP/i);
  assert.match(SQL.insert.jenis_dokumen, /ON CONFLICT\(id\) DO UPDATE/);
  for (const table of IMPORT_TABLES.filter((t) => t !== 'jenis_dokumen')) assert.doesNotMatch(SQL.insert[table], /CONFLICT/);
  assert.match(SQL.claim, /claim_seq = \? AND last_chunk_sha256 IS \? AND complete = 0$/);
});

test('descriptor: valid input returns frozen syntax-only result with all safety flags false', () => {
  const result = validateDescriptor(descriptor(), NOW);
  assert.equal(result.descriptorSyntaxValid, true);
  for (const key of ['existenceVerified', 'identityVerified', 'planHashVerified', 'sourceHashVerified', 'remoteAuthorized', 'readyForImport', 'authorizesExecution']) assert.equal(result[key], false);
  assert.equal(result.proofRequired, true);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.descriptor));
  assert.equal(validateDescriptor(descriptor({ profile: 'real-data', epoch: 7 }), NOW).descriptor.epoch, 7);
});

test('descriptor: closed error codes for shape, field, deny, expiry and hostile objects', () => {
  const secret = 'SECRET-VALUE-XYZ';
  const cases = [
    [descriptor({ extra: 1 }), 'DESCRIPTOR_SHAPE'], [(() => { const d = descriptor(); delete d.bucket; return d; })(), 'DESCRIPTOR_SHAPE'],
    [Object.assign(Object.create({ inherited: 1 }), descriptor()), 'DESCRIPTOR_SHAPE'], [{ ...descriptor(), [Symbol('s')]: 1 }, 'DESCRIPTOR_SHAPE'],
    [JSON.parse(JSON.stringify(descriptor()).replace('{', '{"__proto__":{"x":1},')), 'DESCRIPTOR_SHAPE'],
    [descriptor({ accountId: UAT_ACCOUNT.toUpperCase() }), 'DESCRIPTOR_FIELD_INVALID'], [descriptor({ databaseId: secret }), 'DESCRIPTOR_FIELD_INVALID'],
    [descriptor({ databaseId: '3F1C2B4A-5D6E-4F70-8A9B-0C1D2E3F4A5B' }), 'DESCRIPTOR_FIELD_INVALID'], [descriptor({ epoch: -1 }), 'DESCRIPTOR_FIELD_INVALID'],
    [descriptor({ epoch: 1.5 }), 'DESCRIPTOR_FIELD_INVALID'], [descriptor({ epoch: '1' }), 'DESCRIPTOR_FIELD_INVALID'], [descriptor({ profile: 'prod' }), 'DESCRIPTOR_FIELD_INVALID'],
    [descriptor({ planSha256: '0'.repeat(64) }), 'DESCRIPTOR_FIELD_INVALID'], [descriptor({ ownerNonce: '0123456789abcdef0123456789abcdef' }), 'DESCRIPTOR_FIELD_INVALID'],
    [descriptor({ version: 2 }), 'DESCRIPTOR_FIELD_INVALID'], [descriptor({ expiresAt: '2026-10-18T01:00:00Z' }), 'DESCRIPTOR_FIELD_INVALID'],
    [descriptor({ databaseId: BASELINE_DENY.databaseIds[0] }), 'DESCRIPTOR_TARGET_DENIED'], [descriptor({ databaseId: UAT_DB }), 'DESCRIPTOR_TARGET_DENIED'],
    [descriptor({ databaseId: PROBE_DATABASE_ID }), 'DESCRIPTOR_TARGET_DENIED'], [descriptor({ databaseName: 'sikap-db' }), 'DESCRIPTOR_TARGET_DENIED'],
    [descriptor({ databaseName: 'sikap-uat-db' }), 'DESCRIPTOR_TARGET_DENIED'], [descriptor({ bucket: 'sikap-files' }), 'DESCRIPTOR_TARGET_DENIED'],
    [descriptor({ databaseName: 'my-import' }), 'DESCRIPTOR_TARGET_DENIED'], [descriptor({ bucket: 'SIKAP-IMPORT-X' }), 'DESCRIPTOR_TARGET_DENIED'],
    [descriptor({ accountId: 'a'.repeat(32) }), 'DESCRIPTOR_TARGET_DENIED'],
    [descriptor({ expiresAt: NOW }), 'DESCRIPTOR_EXPIRED'], [descriptor({ expiresAt: '2026-10-18T04:00:00.001Z' }), 'DESCRIPTOR_EXPIRY_TOO_LONG'],
  ];
  for (const [input, code] of cases) assert.equal(codeOf(() => validateDescriptor(input, NOW)), code, code);
  let called = false;
  const getter = descriptor();
  Object.defineProperty(getter, 'bucket', { enumerable: true, get() { called = true; return 'sikap-import-x'; } });
  assert.equal(codeOf(() => validateDescriptor(getter, NOW)), 'DESCRIPTOR_SHAPE');
  assert.equal(called, false);
  assert.equal(codeOf(() => validateDescriptor(new Proxy(descriptor(), { ownKeys() { throw new Error(secret); } }), NOW)), 'DESCRIPTOR_SHAPE');
  for (const now of [undefined, '2026-10-18', 'not-a-date', 1792270000000]) assert.equal(codeOf(() => validateDescriptor(descriptor(), now)), 'NOW_INVALID');
  try { validateDescriptor(descriptor({ databaseId: secret }), NOW); } catch (error) { assert.doesNotMatch(`${error.message}${error.stack}`, /SECRET/); }
  assert.equal(new ImportCoreError('RAW secret').message, 'INTERNAL');
  assert.ok(ERROR_CODES.includes('ROWS_DO_NOT_FIT'));
});

test('compile: ordered stages, seed delete first, static SQL, exact params, limits and flags', () => {
  const input = tables();
  const artifact = compile(input);
  assert.equal(artifact.semanticValidationRequired, true);
  for (const key of ['remoteAuthorized', 'readyForImport', 'planHashVerified', 'sourceHashVerified', 'transportProven']) assert.equal(artifact[key], false);
  assert.equal(artifact.proofRequired, true);
  assert.deepEqual(artifact.chunks.map((c) => c.ordinal), artifact.chunks.map((_, i) => i));
  assert.deepEqual([...new Set(artifact.chunks.map((c) => c.stage))], IMPORT_TABLES.map((_, i) => i));
  const first = artifact.chunks[0];
  assert.equal(first.batch[2].sql, SQL.seedDelete);
  assert.deepEqual(first.batch[2].params, [JSON.stringify(['DOC-SYN1', 'DOC-SYN2'])]);
  assert.equal(artifact.chunks.filter((c) => c.batch.some((s) => s.sql === SQL.seedDelete)).length, 1);
  let previous = null;
  for (const chunk of artifact.chunks) {
    const sqls = chunk.batch.map((s) => s.sql);
    assert.deepEqual([sqls[0], sqls[1]], [SQL.claim, SQL.guard]);
    assert.deepEqual(sqls.slice(-3), [SQL.journal, SQL.checkpoint, SQL.guard]);
    for (const s of chunk.batch) {
      assert.equal(placeholders(s.sql), s.params.length);
      assert.doesNotMatch(s.sql, /Sintetis|legacy-wrap|DOC-SYN|log \d/);
      for (const p of s.params) assert.ok(p === null || typeof p === 'string' || Number.isSafeInteger(p));
    }
    assert.ok(chunk.parameterCount <= 100 && chunk.statementCount <= 32 && chunk.rowCount <= 64 && chunk.bodyBytes <= 65536);
    assert.equal(chunk.bodyBytes, Buffer.byteLength(JSON.stringify({ batch: chunk.batch }), 'utf8'));
    assert.equal(chunk.prevChunkSha256, previous);
    const [claimNext, ...claimRest] = chunk.batch[0].params;
    assert.equal(claimNext, chunk.ordinal + 1);
    assert.deepEqual(claimRest.slice(-2), [chunk.ordinal, previous]);
    const cp = chunk.batch.at(-2).params;
    assert.deepEqual(cp.slice(0, 4), [chunk.nextStage, chunk.nextCursor, chunk.ordinal + 1, chunk.chunkSha256]);
    assert.deepEqual(cp.slice(-2), [chunk.ordinal + 1, previous]);
    previous = chunk.chunkSha256;
  }
  // Rows reconstructed from params equal canonical input order (Unicode/quotes preserved).
  for (const table of IMPORT_TABLES) {
    const rows = artifact.chunks.filter((c) => c.table === table).flatMap((c) => c.batch.filter((s) => s.sql === SQL.insert[table]).map((s) => s.params));
    assert.deepEqual(rows, input[table].map((row) => COLUMNS[table].map((col) => row[col])));
  }
  assert.ok(Object.isFrozen(artifact.chunks[0].batch[3].params));
});

test('compile: empty stages still advance; no seed delete when no jenis imported', () => {
  const artifact = compile(tables({ pegawai: 0, logs: 0, jenis: 0 }));
  const emptyStages = artifact.chunks.filter((c) => c.rowCount === 0);
  assert.ok(emptyStages.length >= 5);
  for (const chunk of emptyStages) assert.equal(chunk.statementCount, 5);
  assert.ok(artifact.chunks.every((c) => c.batch.every((s) => s.sql !== SQL.seedDelete)));
  assert.equal(artifact.chunks.at(-1).nextStage, IMPORT_TABLES.length);
});

test('compile: chunking by params/bytes, 64-row policy, wide rows fit, oversize row rejected', () => {
  const many = compile(tables({ pegawai: 5, logs: 300 }));
  const logChunks = many.chunks.filter((c) => c.table === 'log_aktivitas');
  assert.equal(logChunks.reduce((s, c) => s + c.rowCount, 0), 300);
  assert.ok(logChunks.every((c) => c.rowCount <= 64 && c.parameterCount <= 100));
  assert.equal(many.chunks.filter((c) => c.table === 'pegawai').length, 3); // 30 cols: 2 rows/chunk
  const wide = compile(tables({ pegawai: 3, wide: 16384 }));
  assert.ok(wide.chunks.every((c) => c.bodyBytes <= LIMITS.bodyBytes));
  const huge = tables({ pegawai: 1 });
  for (const col of ['nama', 'jabatan', 'tempat_lahir', 'alamat', 'email']) huge.pegawai[0][col] = '\u{1F600}'.repeat(8192);
  assert.equal(codeOf(() => compile(huge)), 'ROWS_DO_NOT_FIT');
});

test('compile: hostile or non-canonical rows fail closed with closed codes', () => {
  const mutate = (fn) => { const t = tables(); fn(t); return codeOf(() => compile(t)); };
  assert.equal(mutate((t) => { t.pegawai[0].nama = 'a\0b'; }), 'VALUE_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0].unit_id = 1.5; }), 'VALUE_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0].unit_id = 2 ** 53; }), 'VALUE_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0].unit_id = true; }), 'VALUE_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0].alamat = { x: 1 }; }), 'VALUE_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0].alamat = '\uD800'; }), 'VALUE_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0].alamat = 'x'.repeat(16385); }), 'VALUE_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0].unknown_col = 1; }), 'ROW_INVALID');
  assert.equal(mutate((t) => { delete t.akun[0].failed_attempts; }), 'ROW_INVALID');
  assert.equal(mutate((t) => { t.pegawai[0] = JSON.parse(JSON.stringify(t.pegawai[0]).replace('{', '{"__proto__":null,')); }), 'ROW_INVALID');
  assert.equal(mutate((t) => { Object.defineProperty(t.pegawai[0], 'nama', { enumerable: true, get: () => 'x' }); }), 'ROW_INVALID');
  assert.equal(mutate((t) => { t.pegawai[1].id = 1; }), 'DUPLICATE_KEY');
  assert.equal(mutate((t) => { t.jenis_dokumen_wajib.push({ ...t.jenis_dokumen_wajib[0] }); }), 'DUPLICATE_KEY');
  assert.equal(mutate((t) => { t.akun[0].pegawai_id = null; }), 'KEY_INVALID');
  assert.equal(mutate((t) => { delete t.sesi; t.extra = []; }), 'TABLES_INVALID');
  assert.equal(mutate((t) => { t.pegawai.extra = 1; }), 'TABLES_INVALID');
  assert.equal(mutate((t) => { delete t.log_aktivitas; }), 'TABLES_INVALID');
  assert.equal(codeOf(() => compileChunks({ tables: tables(), plan: {} }, descriptor(), { now: NOW })), 'TABLES_INVALID');
  assert.equal(codeOf(() => compileChunks({ tables: tables() }, descriptor(), { now: NOW, limits: {} })), 'INPUT_INVALID');
  assert.equal(codeOf(() => compileChunks({ tables: tables() }, descriptor({ databaseName: 'sikap-db' }), { now: NOW })), 'DESCRIPTOR_TARGET_DENIED');
});

test('compile: deterministic, immutable vs caller mutation, hashes bind content and plan digest', () => {
  const input = tables();
  const a = compile(input), b = compile(tables());
  assert.deepEqual(a.chunks.map((c) => c.chunkSha256), b.chunks.map((c) => c.chunkSha256));
  const before = JSON.stringify(a);
  input.pegawai[0].nama = 'changed'; input.pegawai.push(input.pegawai[0]);
  assert.equal(JSON.stringify(a), before);
  assert.throws(() => { a.chunks[0].batch[0].params[0] = 9; }, TypeError);
  const changed = tables(); changed.log_aktivitas[1].description = 'log 2 changed';
  const c = compile(changed);
  const logIndex = a.chunks.findIndex((x) => x.table === 'log_aktivitas');
  assert.deepEqual(c.chunks.slice(0, logIndex).map((x) => x.chunkSha256), a.chunks.slice(0, logIndex).map((x) => x.chunkSha256));
  assert.notEqual(c.chunks[logIndex].chunkSha256, a.chunks[logIndex].chunkSha256);
  for (const over of [{ planSha256: h('plan-2') }, { databaseId: '4f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' }, { policySha256: h('policy-2') }, { bucket: 'sikap-import-other' }]) {
    const other = compile(tables(), descriptor(over));
    assert.ok(other.chunks.every((x, i) => x.chunkSha256 !== a.chunks[i].chunkSha256));
    assert.notDeepEqual(other.chunks[0].batch[0].params, a.chunks[0].batch[0].params);
  }
  const takeover = compile(tables(), descriptor({ epoch: 9007199254740991, ownerNonce: 'abcdefabcdefabcdefabcdefabcdefab', expiresAt: '2026-10-18T02:00:00.000Z' }));
  assert.deepEqual(takeover.chunks.map((x) => [x.chunkSha256, x.startCursor, x.endCursor]), a.chunks.map((x) => [x.chunkSha256, x.startCursor, x.endCursor]));
  assert.notDeepEqual(takeover.chunks[0].batch[0].params, a.chunks[0].batch[0].params);
  assert.ok(takeover.chunks.every((x) => x.bodyBytes <= LIMITS.bodyBytes));
});

test('summarize: counts/flags only; no SQL, params, hashes, ids or nonces', () => {
  const artifact = compile();
  const summary = summarize(artifact);
  const text = JSON.stringify(summary);
  for (const bad of [/Sintetis/, /legacy-wrap/, /DOC-SYN/, /INSERT|UPDATE|SELECT/, /[0-9a-f]{32}/, new RegExp(UAT_ACCOUNT), /sikap-import/]) assert.doesNotMatch(text, bad);
  assert.equal(summary.rowCount, artifact.rowCount);
  assert.equal(summary.remoteAuthorized, false);
  assert.equal(summary.readyForImport, false);
  assert.equal(codeOf(() => summarize(JSON.parse(JSON.stringify(artifact)))), 'ARTIFACT_UNKNOWN');
});

test('state engine: exact sequential chunks only; no skipping, foreign artifacts or forged states', () => {
  const artifact = compile(), other = compile(tables({ logs: 3 }));
  let state = createState(artifact);
  assert.deepEqual([state.stage, state.cursor, state.ordinal, state.lastChunkSha256], [0, 0, 0, null]);
  assert.equal(codeOf(() => advanceState(state, artifact, artifact.chunks[1])), 'CHUNK_MISMATCH');
  assert.equal(codeOf(() => advanceState(state, other, other.chunks[0])), 'CHUNK_MISMATCH');
  assert.equal(codeOf(() => advanceState(state, artifact, { ...artifact.chunks[0] })), 'CHUNK_MISMATCH');
  assert.equal(codeOf(() => advanceState({ ...state }, artifact, artifact.chunks[0])), 'STATE_INVALID');
  for (const chunk of artifact.chunks) {
    state = advanceState(state, artifact, chunk);
    assert.equal(state.claimSeq, chunk.ordinal + 1);
    assert.equal(state.lastChunkSha256, chunk.chunkSha256);
  }
  assert.equal(state.stage, IMPORT_TABLES.length);
  assert.equal(state.allChunksApplied, true);
  assert.equal(state.complete, false);
  assert.equal(state.completeAuthorized, false);
  assert.equal(codeOf(() => advanceState(state, artifact, artifact.chunks[0])), 'STATE_INVALID');
});

test('classifyResume: committed/hold/not-committed/diverged; never authorizes resend', () => {
  const artifact = compile();
  const d = descriptor(), n = 3;
  const target = validateDescriptor(d, NOW).targetBindingSha256;
  const receiptAt = (k) => ({
    runNonce: d.runNonce, ownerNonce: d.ownerNonce, epoch: d.epoch, targetBindingSha256: target, planSha256: d.planSha256,
    stage: k === 0 ? 0 : artifact.chunks[k - 1].nextStage, cursor: k === 0 ? 0 : artifact.chunks[k - 1].nextCursor,
    ordinal: k, claimSeq: k, lastChunkSha256: k === 0 ? null : artifact.chunks[k - 1].chunkSha256, complete: 0,
  });
  const journalTo = (k) => artifact.chunks.slice(0, k).map((c) => ({ runNonce: d.runNonce, epoch: d.epoch, targetBindingSha256: target, ordinal: c.ordinal, stage: c.stage, tableName: c.table, startCursor: c.startCursor, endCursor: c.endCursor, chunkSha256: c.chunkSha256 }));
  const run = (over) => classifyResume({ artifact, ordinal: n, observedReceipt: receiptAt(n + 1), journal: journalTo(n + 1), exactPrefixVerified: true, writerQuiescent: true, ...over });
  const cases = [
    [{}, 'COMMITTED_OBSERVED'],
    [{ exactPrefixVerified: false }, 'HOLD_UNCERTAIN'],
    [{ observedReceipt: receiptAt(n), journal: journalTo(n) }, 'NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED'],
    [{ observedReceipt: receiptAt(n), journal: journalTo(n), writerQuiescent: false }, 'HOLD_UNCERTAIN'],
    [{ observedReceipt: receiptAt(n), journal: journalTo(n), exactPrefixVerified: false }, 'HOLD_UNCERTAIN'],
    [{ observedReceipt: receiptAt(n + 2), journal: journalTo(n + 2) }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), runNonce: 'f'.repeat(32) } }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), epoch: 1 } }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), ownerNonce: 'a'.repeat(32) } }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), lastChunkSha256: h('x') } }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), targetBindingSha256: h('other-target') } }, 'DIVERGED'],
    [{ journal: [...journalTo(n), { ...journalTo(n + 1)[n], targetBindingSha256: h('other-target') }] }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), claimSeq: n + 2 } }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n), claimSeq: n + 1 }, journal: journalTo(n) }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), complete: 1 } }, 'DIVERGED'],
    [{ journal: journalTo(n) }, 'DIVERGED'],
    [{ journal: [...journalTo(n), { ...journalTo(n + 1)[n], chunkSha256: h('y') }] }, 'DIVERGED'],
    [{ journal: [...journalTo(n), { ...journalTo(n + 1)[n], epoch: 5 }] }, 'DIVERGED'],
    [{ observedReceipt: { ...receiptAt(n + 1), extra: 1 } }, 'DIVERGED'],
  ];
  for (const [over, outcome] of cases) {
    const result = run(over);
    assert.equal(result.outcome, outcome, JSON.stringify(Object.keys(over)));
    assert.ok(RESUME_OUTCOMES.includes(result.outcome));
    for (const key of ['authorizesRetry', 'authorizesSend', 'autoResendAllowed', 'remoteAuthorized', 'readyForImport']) assert.equal(result[key], false);
    assert.equal(result.operatorDecisionRequired, true);
  }
  assert.equal(codeOf(() => run({ writerQuiescent: 'yes' })), 'INPUT_INVALID');
  assert.equal(codeOf(() => run({ ordinal: artifact.chunks.length })), 'INPUT_INVALID');
  assert.equal(codeOf(() => run({ artifact: JSON.parse(JSON.stringify(artifact)) })), 'ARTIFACT_UNKNOWN');
});

test('PRIMARY equals apply-local; KEY_TYPES match declared schema column types (static read)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(PRIMARY)), APPLY_PRIMARY);
  assert.ok(Object.isFrozen(PRIMARY) && Object.isFrozen(PRIMARY.jenis_dokumen_wajib) && Object.isFrozen(KEY_TYPES.pegawai));
  const ddl = readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8');
  for (const table of IMPORT_TABLES) {
    assert.deepEqual(Object.keys(KEY_TYPES[table]), PRIMARY[table], table);
    const block = ddl.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))[1];
    for (const column of PRIMARY[table]) {
      const declared = block.match(new RegExp(`^\\s*${column}\\s+(TEXT|INTEGER)\\b`, 'm'))[1].toLowerCase();
      assert.equal(KEY_TYPES[table][column], declared, `${table}.${column}`);
    }
  }
});

test('compile: primary keys are type-strict per schema; no coercion, valid string ids preserved', () => {
  const mutate = (fn) => { const t = tables(); fn(t); return codeOf(() => compile(t)); };
  const invalid = {
    'jenis numeric id': (t) => { t.jenis_dokumen[0].id = 1; },
    'jenis blank id': (t) => { t.jenis_dokumen[0].id = ''; },
    'jenis null id': (t) => { t.jenis_dokumen[0].id = null; },
    'wajib numeric jenis id': (t) => { t.jenis_dokumen_wajib[0].jenis_dokumen_id = 1; },
    'wajib null status': (t) => { t.jenis_dokumen_wajib[0].status_kepegawaian = null; },
    'wajib blank status': (t) => { t.jenis_dokumen_wajib[0].status_kepegawaian = ''; },
    'wajib blank jenis id': (t) => { t.jenis_dokumen_wajib[1].jenis_dokumen_id = ''; },
    'pegawai string id': (t) => { t.pegawai[0].id = '1'; },
    'pegawai null id': (t) => { t.pegawai[0].id = null; },
    'akun string key': (t) => { t.akun[0].pegawai_id = '1'; },
    'akun null key': (t) => { t.akun[0].pegawai_id = null; },
    'arsip string id': (t) => { t.arsip_dokumen[0].id = ''; },
    'log string id': (t) => { t.log_aktivitas[0].id = '2'; },
  };
  for (const [name, fn] of Object.entries(invalid)) assert.equal(mutate(fn), 'KEY_INVALID', name);
  // 1 vs '1' cannot alias: the string form is rejected before duplicate detection.
  assert.equal(mutate((t) => { t.log_aktivitas[1].id = '1'; }), 'KEY_INVALID');
  // Missing key column violates the full canonical row contract (shape error, not a key default).
  assert.equal(mutate((t) => { delete t.pegawai[0].id; }), 'ROW_INVALID');
  assert.equal(mutate((t) => { delete t.jenis_dokumen_wajib[0].status_kepegawaian; }), 'ROW_INVALID');
  // Non-safe / -0 integer keys stay VALUE_INVALID (unchanged precedence).
  assert.equal(mutate((t) => { t.pegawai[0].id = -0; }), 'VALUE_INVALID');
  // Valid string ids (incl. '0', whitespace, Unicode) pass verbatim: no trim/case/normalization.
  const ids = ['0', ' DOC ', 'doc-\u00e9', 'DOC-\u{1F600}'];
  const t = tables({ jenis: ids.length });
  ids.forEach((id, i) => { t.jenis_dokumen[i].id = id; t.jenis_dokumen_wajib[i].jenis_dokumen_id = id; });
  const artifact = compile(t);
  assert.deepEqual(artifact.chunks[0].batch[2].params, [JSON.stringify(ids)]);
  const sent = (table) => artifact.chunks.flatMap((c) => c.batch.filter((s) => s.sql === SQL.insert[table]).map((s) => s.params[0]));
  assert.deepEqual(sent('jenis_dokumen'), ids);
  assert.deepEqual(sent('jenis_dokumen_wajib'), ids);
});

test('compile: stage 0 split across many jenis chunks carries exactly ONE seed delete with the whole id list', () => {
  const artifact = compile(tables({ jenis: 40 }));
  const stage0 = artifact.chunks.filter((c) => c.stage === 0);
  assert.ok(stage0.length > 1);
  assert.equal(stage0.reduce((s, c) => s + c.rowCount, 0), 40);
  const seeded = artifact.chunks.filter((c) => c.batch.some((s) => s.sql === SQL.seedDelete));
  assert.deepEqual(seeded, [stage0[0]]);
  assert.equal(stage0[0].batch[2].sql, SQL.seedDelete);
  assert.deepEqual(stage0[0].batch[2].params, [JSON.stringify(Array.from({ length: 40 }, (_, i) => `DOC-SYN${i + 1}`))]);
  for (const chunk of stage0.slice(1)) assert.equal(chunk.batch[2].sql, SQL.insert.jenis_dokumen);
});

test('compile: epoch 0 vs MAX_SAFE_INTEGER at the 64 KiB boundary keeps ranges and hashes stable', () => {
  const COLS = ['nama', 'jabatan', 'tempat_lahir', 'alamat', 'email'];
  const build = (fill) => {
    const t = tables({ pegawai: 2, logs: 0, jenis: 0 });
    let left = fill;
    for (const col of COLS) { const n = Math.min(left, 16384); t.pegawai[0][col] = 'x'.repeat(n); left -= n; }
    assert.equal(left, 0);
    return t;
  };
  const maxEpoch = descriptor({ epoch: Number.MAX_SAFE_INTEGER });
  const pegawaiChunks = (a) => a.chunks.filter((c) => c.table === 'pegawai');
  const probe = pegawaiChunks(compile(build(30000)));
  assert.equal(probe.length, 1);
  const slack = 3 * (String(Number.MAX_SAFE_INTEGER).length - 1);
  const fill = 30000 + (LIMITS.bodyBytes - slack - probe[0].bodyBytes);
  // Exactly at the boundary: both rows share one chunk under either epoch; MAX lands on the limit.
  const low = compile(build(fill)), high = compile(build(fill), maxEpoch);
  assert.equal(pegawaiChunks(low).length, 1);
  assert.equal(pegawaiChunks(low)[0].bodyBytes, LIMITS.bodyBytes - slack);
  assert.equal(pegawaiChunks(high)[0].bodyBytes, LIMITS.bodyBytes);
  const shape = (a) => a.chunks.map((c) => [c.chunkSha256, c.stage, c.startCursor, c.endCursor]);
  assert.deepEqual(shape(high), shape(low));
  // One byte over: both epochs split identically even though epoch 0 alone would still fit.
  const low2 = compile(build(fill + 1)), high2 = compile(build(fill + 1), maxEpoch);
  assert.deepEqual(pegawaiChunks(low2).map((c) => [c.startCursor, c.endCursor]), [[0, 1], [1, 2]]);
  assert.deepEqual(shape(high2), shape(low2));
  assert.ok(high2.chunks.every((c) => c.bodyBytes <= LIMITS.bodyBytes));
});

test('classifyResume: journal epochs must be non-decreasing, bounded and exact for the current entry', () => {
  const d = descriptor({ epoch: 2 }), n = 3;
  const artifact = compile(tables(), d);
  const target = validateDescriptor(d, NOW).targetBindingSha256;
  const receiptAt = (k) => ({
    runNonce: d.runNonce, ownerNonce: d.ownerNonce, epoch: d.epoch, targetBindingSha256: target, planSha256: d.planSha256,
    stage: k === 0 ? 0 : artifact.chunks[k - 1].nextStage, cursor: k === 0 ? 0 : artifact.chunks[k - 1].nextCursor,
    ordinal: k, claimSeq: k, lastChunkSha256: k === 0 ? null : artifact.chunks[k - 1].chunkSha256, complete: 0,
  });
  const journal = (epochs) => epochs.map((epoch, i) => {
    const c = artifact.chunks[i];
    return { runNonce: d.runNonce, epoch, targetBindingSha256: target, ordinal: i, stage: c.stage, tableName: c.table, startCursor: c.startCursor, endCursor: c.endCursor, chunkSha256: c.chunkSha256 };
  });
  const run = (epochs, over = {}) => {
    const result = classifyResume({ artifact, ordinal: n, observedReceipt: receiptAt(epochs.length), journal: journal(epochs), exactPrefixVerified: true, writerQuiescent: true, ...over });
    for (const key of ['authorizesRetry', 'authorizesSend', 'autoResendAllowed', 'remoteAuthorized']) assert.equal(result[key], false);
    return [result.outcome, result.reason];
  };
  assert.deepEqual(run([0, 1, 1, 2]), ['COMMITTED_OBSERVED', 'NEXT_ORDINAL_JOURNAL_PREFIX']);
  assert.deepEqual(run([2, 2, 2, 2]), ['COMMITTED_OBSERVED', 'NEXT_ORDINAL_JOURNAL_PREFIX']);
  // Monotone epochs alone never suffice: prefix, nonce and hash still gate the verdict.
  assert.deepEqual(run([0, 1, 1, 2], { exactPrefixVerified: false }), ['HOLD_UNCERTAIN', 'PREFIX_UNVERIFIED']);
  const forged = journal([0, 1, 1, 2]);
  assert.equal(classifyResume({ artifact, ordinal: n, observedReceipt: receiptAt(4), journal: [{ ...forged[0], runNonce: 'f'.repeat(32) }, ...forged.slice(1)], exactPrefixVerified: true, writerQuiescent: true }).outcome, 'DIVERGED');
  assert.equal(classifyResume({ artifact, ordinal: n, observedReceipt: receiptAt(4), journal: [...forged.slice(0, 2), { ...forged[2], chunkSha256: h('z') }, forged[3]], exactPrefixVerified: true, writerQuiescent: true }).outcome, 'DIVERGED');
  for (const epochs of [[2, 0, 1, 2], [0, 2, 1, 2], [0, 1, 3, 2], [0, 0, 0, 3], [3, 3, 3, 3], [0, 1, 1, 1], [-1, 1, 1, 2], [-0, 1, 1, 2], [0.5, 1, 1, 2], ['0', 1, 1, 2], [null, 1, 1, 2], [0, 1, 1, 2 ** 53]]) {
    assert.deepEqual(run(epochs), ['DIVERGED', 'JOURNAL_MISMATCH'], JSON.stringify(epochs));
  }
  // Before-state decisions unchanged; earlier epochs still validated for order.
  assert.deepEqual(run([0, 1, 1]), ['NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED', 'PRIOR_STATE_QUIESCENT_PREFIX']);
  assert.deepEqual(run([0, 1, 1], { writerQuiescent: false }), ['HOLD_UNCERTAIN', 'WRITER_NOT_QUIESCENT']);
  assert.deepEqual(run([1, 0, 1]), ['DIVERGED', 'JOURNAL_MISMATCH']);
  assert.deepEqual(run([0, 1, 3]), ['DIVERGED', 'JOURNAL_MISMATCH']);
  // Epoch 0 binding: -0 receipt or journal entry never matches.
  const d0 = descriptor(), a0 = compile(tables(), d0), t0 = validateDescriptor(d0, NOW).targetBindingSha256, c0 = a0.chunks[0];
  const r0 = { runNonce: d0.runNonce, ownerNonce: d0.ownerNonce, epoch: 0, targetBindingSha256: t0, planSha256: d0.planSha256, stage: c0.nextStage, cursor: c0.nextCursor, ordinal: 1, claimSeq: 1, lastChunkSha256: c0.chunkSha256, complete: 0 };
  const j0 = { runNonce: d0.runNonce, epoch: 0, targetBindingSha256: t0, ordinal: 0, stage: c0.stage, tableName: c0.table, startCursor: c0.startCursor, endCursor: c0.endCursor, chunkSha256: c0.chunkSha256 };
  const base0 = { artifact: a0, ordinal: 0, observedReceipt: r0, journal: [j0], exactPrefixVerified: true, writerQuiescent: true };
  assert.equal(classifyResume(base0).outcome, 'COMMITTED_OBSERVED');
  assert.deepEqual(Object.values(classifyResume({ ...base0, observedReceipt: { ...r0, epoch: -0 } })).slice(0, 2), ['DIVERGED', 'BINDING_MISMATCH']);
  assert.deepEqual(Object.values(classifyResume({ ...base0, journal: [{ ...j0, epoch: -0 }] })).slice(0, 2), ['DIVERGED', 'JOURNAL_MISMATCH']);
});

test('target binding: SQL params carry stable digest; other target/policy observations are not interchangeable', () => {
  const d = descriptor();
  const { targetBindingSha256: target } = validateDescriptor(d, NOW);
  assert.match(target, /^[0-9a-f]{64}$/);
  // Takeover fields (owner/epoch/expiry/runNonce) do not change the stable binding; target/policy fields do.
  assert.equal(validateDescriptor(descriptor({ ownerNonce: 'abcdefabcdefabcdefabcdefabcdefab', epoch: 4, expiresAt: '2026-10-18T03:00:00.000Z', runNonce: '11111111111111111111111111111111' }), NOW).targetBindingSha256, target);
  for (const over of [{ databaseId: '4f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' }, { databaseName: 'sikap-import-x' }, { bucket: 'sikap-import-y' }, { profile: 'real-data' }, { policySha256: h('p2') }, { retentionPolicySha256: h('r2') }, { appSchemaSha256: h('a2') }, { ledgerSchemaSha256: h('l2') }, { baselineSha256: h('b2') }, { sourceSha256: h('s2') }, { snapshotId: '8a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' }]) {
    assert.notEqual(validateDescriptor(descriptor(over), NOW).targetBindingSha256, target, Object.keys(over)[0]);
  }
  assert.ok(LEDGER.runColumns.includes('target_binding_sha256') && LEDGER.journalColumns.includes('target_binding_sha256'));
  assert.deepEqual([...LEDGER.journalUniqueKey], ['run_nonce', 'ordinal']);
  assert.ok(Object.isFrozen(LEDGER.journalUniqueKey) && LEDGER.journalUniqueKey.every((c) => LEDGER.journalColumns.includes(c)));
  assert.match(SQL.journal, /^INSERT INTO __sikap_import_v1_journal \(/);
  assert.doesNotMatch(SQL.journal, /OR IGNORE|OR REPLACE|REPLACE|ON CONFLICT/i);
  const a = compile(tables(), d);
  for (const chunk of a.chunks) {
    const [claim, , ...rest] = chunk.batch;
    assert.equal(claim.params[4], target); // ordinal+1, runNonce, ownerNonce, epoch, target, plan...
    assert.equal(chunk.batch.at(-2).params[7], target); // stage, cursor, ordinal, hash, runNonce, ownerNonce, epoch, target
    assert.equal(rest.at(-3).params[2], target); // journal: runNonce, epoch, target
  }
  const b = compile(tables(), descriptor({ policySha256: h('p2') }));
  const n = 0, c = b.chunks[n];
  const receipt = { runNonce: d.runNonce, ownerNonce: d.ownerNonce, epoch: d.epoch, targetBindingSha256: validateDescriptor(descriptor({ policySha256: h('p2') }), NOW).targetBindingSha256, planSha256: d.planSha256, stage: c.nextStage, cursor: c.nextCursor, ordinal: 1, claimSeq: 1, lastChunkSha256: c.chunkSha256, complete: 0 };
  const journal = [{ runNonce: d.runNonce, epoch: d.epoch, targetBindingSha256: receipt.targetBindingSha256, ordinal: 0, stage: c.stage, tableName: c.table, startCursor: c.startCursor, endCursor: c.endCursor, chunkSha256: c.chunkSha256 }];
  const args = { ordinal: n, observedReceipt: receipt, journal, exactPrefixVerified: true, writerQuiescent: true };
  assert.equal(classifyResume({ artifact: b, ...args }).outcome, 'COMMITTED_OBSERVED');
  assert.equal(classifyResume({ artifact: a, ...args }).outcome, 'DIVERGED');
  assert.notEqual(a.chunks[0].chunkSha256, c.chunkSha256);
});
