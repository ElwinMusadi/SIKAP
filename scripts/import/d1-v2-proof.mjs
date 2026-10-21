// SIKAP D1 v2 transport proof HARNESS (SYNTHETIC-ONLY, LOCAL CANDIDATE; tested only with injected fetch).
//
// Scope and limits (read before using any output):
//   * PRECONDITION (not verified here): a PRIVATE, PREPARED synthetic database, used by a single
//     operator, whose app migrations and reviewed ledger DDL are already applied, whose ledger run
//     row is already bootstrapped at state 0 (empty journal) and whose app tables hold exactly the
//     caller's seed-only baseline. This module performs no setup, DDL, bootstrap, cleanup, resource
//     creation, retry or resume. No env, FS, spawn, CLI, console or global fetch: fetchImpl,
//     nowProvider and token are explicit injected dependencies. No real execution wiring exists.
//   * The plan is a FIXED internal synthetic fixture (no real data, no PPI). The descriptor's
//     planSha256 is CONTEXT ONLY and non-authorizing: it is bound into the manifest hash but is never
//     verified against any plan (planHashVerified:false always). proofScenarioSha256 offers a
//     deterministic scenario hash a caller MAY use as that value; nothing here requires or proves it.
//   * Every send is a genuine core-compiled chunk sent through the real createD1RestAdapter; every
//     read is the real createD1Readback (fixed 9 static SELECTs). No caller SQL, no mutated batch.
//   * Each write is followed by exactly ONE post read; the next step relies on that verified read
//     (no fresh pre-read, no writer-quiescence proof). The first unexpected result stops the run.
//   * "stateUnchangedObserved" means the full run/journal/table state equals the pre-step state. It
//     does NOT identify the provider's constraint type or error cause (provider text is never read).
//   * The manifest is PRIVATE (synthetic PII-shaped rows, nonces): never print or log it. Use
//     summarizeProof (counts/hashes/flags). Reports carry counts, closed codes and booleans only.
//   * All authority flags stay false: a passing run is an observation on one synthetic target only.
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { COLUMNS, KEY_TYPES, LEDGER, MAX_VALUE_CHARS, PRIMARY, advanceState, classifyResume, compileChunks, createState, validateDescriptor } from './core.mjs';
import { AMBIGUOUS_REASONS, D1_ADAPTER_ERROR_CODES, createD1RestAdapter } from './d1-rest.mjs';
import { READBACK_ERROR_CODES, createD1Readback } from './d1-readback.mjs';
import { hashBaseline } from './synthetic-runner.mjs';

export const PROOF_VERSION = 1;
export const MAX_BASELINE_ROWS = 1000;
export const MAX_BASELINE_BYTES = 1024 * 1024;
export const MAX_PROOF_TIMEOUT_MS = 60_000;
export const PROOF_STEPS = Object.freeze([
  'FAULT_CHECK_JENIS', 'COMMIT_JENIS', 'COMMIT_WAJIB', 'FAULT_UNIQUE_PEGAWAI', 'COMMIT_PEGAWAI', 'FAULT_FK_AKUN',
  'REPLAY_PEGAWAI', 'COMMIT_AKUN', 'COMMIT_ARSIP_EMPTY', 'COMMIT_RIWAYAT_EMPTY', 'LOST_RESPONSE_LOG',
]);
export const PROOF_STATUSES = Object.freeze([
  'SYNTHETIC_PROOF_OBSERVED', 'STOPPED_BUSY', 'STOPPED_INPUT_INVALID', 'STOPPED_CLOCK_INVALID', 'STOPPED_DESCRIPTOR_EXPIRED',
  'STOPPED_READBACK_FAILED', 'STOPPED_INITIAL_STATE_MISMATCH', 'STOPPED_SEND_REFUSED', 'STOPPED_UNEXPECTED_OUTCOME',
  'STOPPED_STATE_MISMATCH', 'STOPPED_INTERNAL',
]);
const OWN_REASONS = ['ARGS_INVALID', 'MANIFEST_UNKNOWN', 'FETCH_REQUIRED', 'NOW_PROVIDER_REQUIRED', 'TIMEOUT_INVALID', 'NOW_INVALID',
  'NOW_NOT_MONOTONE', 'DESCRIPTOR_INVALID', 'DESCRIPTOR_EXPIRED', 'READBACK_SHAPE', 'STATE_MISMATCH', 'FAULT_ACCEPTED',
  'UNEXPECTED_ADAPTER_RESULT', 'OBSERVATION_NOT_COMMITTED', 'BUSY', 'INTERNAL'];
export const PROOF_REASONS = Object.freeze([...new Set([...OWN_REASONS, ...D1_ADAPTER_ERROR_CODES, ...AMBIGUOUS_REASONS, ...READBACK_ERROR_CODES])]);
export const PROOF_BUILD_ERROR_CODES = Object.freeze(['INPUT_INVALID', 'NOW_INVALID', 'DESCRIPTOR_INVALID', 'DESCRIPTOR_EXPIRED',
  'DESCRIPTOR_TARGET_DENIED', 'PROFILE_BLOCKED', 'BASELINE_INVALID', 'BASELINE_LIMIT', 'BASELINE_NOT_SEED_ONLY',
  'BASELINE_HASH_MISMATCH', 'PLAN_CONFLICTS_BASELINE', 'LAYOUT_MISMATCH', 'MANIFEST_UNKNOWN', 'INTERNAL']);
const FLAGS = Object.freeze({
  globalProof: false, remoteAuthorized: false, readyForImport: false, transportProven: false, authorizesRetry: false,
  authorizesExecution: false, cleanupAuthorized: false, planHashVerified: false, sourceHashVerified: false,
  schemaProofVerified: false, writerQuiescenceVerified: false, providerErrorTypeVerified: false, syntheticOnly: true,
});

const BUILD_CODES = new Set(PROOF_BUILD_ERROR_CODES), OWN_ERRORS = new WeakSet();
export class D1V2ProofError extends Error {
  constructor(code) {
    const safe = BUILD_CODES.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'D1V2ProofError';
    this.code = safe;
    OWN_ERRORS.add(this);
  }
}
const fail = (code) => { throw new D1V2ProofError(code); };
const check = (ok, code) => { if (!ok) fail(code); };
const guarded = (fn) => (...args) => {
  try { return fn(...args); } catch (error) { throw OWN_ERRORS.has(error) ? error : new D1V2ProofError('INTERNAL'); }
};
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Own enumerable DATA properties only (getters never run): exact required + optional keys.
function plain(value, required, optional, code) {
  try {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), code);
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, code);
    const allowed = new Set([...required, ...optional]), out = {};
    for (const key of Reflect.ownKeys(value)) {
      check(typeof key === 'string' && allowed.has(key), code);
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      check(Object.hasOwn(d, 'value') && d.enumerable === true, code);
      out[key] = d.value;
    }
    check(required.every((key) => Object.hasOwn(out, key)), code);
    return out;
  } catch (error) { throw OWN_ERRORS.has(error) ? error : new D1V2ProofError(code); }
}
function plainArray(value, max, code) {
  try {
    check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, code);
    const length = Reflect.getOwnPropertyDescriptor(value, 'length').value;
    check(Number.isSafeInteger(length) && length <= max && Reflect.ownKeys(value).length === length + 1, code);
    return Array.from({ length }, (_, i) => {
      const d = Reflect.getOwnPropertyDescriptor(value, String(i));
      check(d !== undefined && Object.hasOwn(d, 'value') && d.enumerable === true, code);
      return d.value;
    });
  } catch (error) { throw OWN_ERRORS.has(error) ? error : new D1V2ProofError(code); }
}
const cellOk = (v) => v === null || (Number.isSafeInteger(v) && !Object.is(v, -0)) ||
  (typeof v === 'string' && v.length <= MAX_VALUE_CHARS && !v.includes('\0') && v.isWellFormed());
const keyOf = (table, values) => JSON.stringify(PRIMARY[table].map((c) => values[COLUMNS[table].indexOf(c)]));
const toValues = (table, row) => COLUMNS[table].map((c) => row[c]);

// ---- fixed synthetic fixture (every COLUMNS key explicit; SQL defaults as apply-local canonicalRow) ----
const CREATED = '2026-10-01T00:00:00.000Z';
const SENTINEL = 'Sintetis \'O"Neil\' \u00e9 \u6f22 \u{1F600} \'); DROP TABLE pegawai; --';
const DEFAULTS = {
  jenis_dokumen: { urutan: 0, aktif: 1, max_size_bytes: 5 * 1024 * 1024, updated_at: '1970-01-01T00:00:00.000Z' },
  pegawai: { role: 'Pegawai', status_akun: 'Aktif', created_at: CREATED, updated_at: CREATED },
  akun: { failed_attempts: 0 }, arsip_dokumen: { versi: 1 },
};
function row(table, values) {
  check(Object.keys(values).every((c) => COLUMNS[table].includes(c)), 'INTERNAL');
  return Object.fromEntries(COLUMNS[table].map((c) => [c, Object.hasOwn(values, c) ? values[c] : DEFAULTS[table]?.[c] ?? null]));
}
const HASH = `legacy-wrap$10000$c2FsdHNhbHRzYWx0c2FsdA==$${'A'.repeat(43)}=`;
const VARIANTS = Object.freeze(['plan', 'check', 'unique', 'fk']);
// Fault variants differ from the plan in ONE row of ONE table only (check: jenis, unique: pegawai, fk: akun).
function fixture(variant) {
  const t = Object.fromEntries(IMPORT_TABLES.map((table) => [table, []]));
  t.jenis_dokumen.push(row('jenis_dokumen', { id: 'DOC-KTP', nama: 'KTP Sintetis', kategori: 'Dokumen Pribadi', urutan: 1, updated_at: CREATED }));
  t.jenis_dokumen.push(row('jenis_dokumen', { id: 'DOC-PROOF', nama: SENTINEL, kategori: 'Sintetis', urutan: 99, aktif: variant === 'check' ? 2 : 1 }));
  for (const [id, status] of [['DOC-KTP', 'PNS'], ['DOC-KTP', 'PPPK'], ['DOC-PROOF', 'PNS']]) t.jenis_dokumen_wajib.push(row('jenis_dokumen_wajib', { jenis_dokumen_id: id, status_kepegawaian: status }));
  t.pegawai.push(row('pegawai', { id: 900001, nip: '099001012020000001', nik: '7100000000000001', nama: SENTINEL, status_kepegawaian: 'PNS', pangkat_kode: 'III/a', unit_id: 1, pendidikan_kode: 'S1' }));
  t.pegawai.push(row('pegawai', { id: 900002, nip: variant === 'unique' ? '099001012020000001' : '199001012020000002', nama: 'Pegawai Sintetis Dua', status_kepegawaian: 'PNS', unit_id: 1, pendidikan_kode: 'S1' }));
  t.akun.push(row('akun', { pegawai_id: 900001, password_hash: HASH, is_default_password: 0 }));
  t.akun.push(row('akun', { pegawai_id: variant === 'fk' ? 999999 : 900002, password_hash: HASH, is_default_password: 0 }));
  t.log_aktivitas.push(row('log_aktivitas', { id: 1, ts: CREATED, action: 'SYN_PROOF', result: 'SUCCESS', description: SENTINEL }));
  return t;
}
const FAULT_TABLE = Object.freeze({ check: 'jenis_dokumen', unique: 'pegawai', fk: 'akun' });
// Step spec: [label, kind, variant, table, stateBefore]. Ordinals derive from the plan layout.
const STEP_SPECS = [
  ['FAULT_CHECK_JENIS', 'fault', 'check', 'jenis_dokumen', 0], ['COMMIT_JENIS', 'commit', 'plan', 'jenis_dokumen', 0],
  ['COMMIT_WAJIB', 'commit', 'plan', 'jenis_dokumen_wajib', 1], ['FAULT_UNIQUE_PEGAWAI', 'fault', 'unique', 'pegawai', 2],
  ['COMMIT_PEGAWAI', 'commit', 'plan', 'pegawai', 2], ['FAULT_FK_AKUN', 'fault', 'fk', 'akun', 3],
  ['REPLAY_PEGAWAI', 'fault', 'plan', 'pegawai', 3], ['COMMIT_AKUN', 'commit', 'plan', 'akun', 3],
  ['COMMIT_ARSIP_EMPTY', 'commit', 'plan', 'arsip_dokumen', 4], ['COMMIT_RIWAYAT_EMPTY', 'commit', 'plan', 'arsip_dokumen_riwayat', 5],
  ['LOST_RESPONSE_LOG', 'lost', 'plan', 'log_aktivitas', 6],
];
const SCENARIO_SHA256 = sha256(JSON.stringify(['sikap-d1-v2-proof-scenario', PROOF_VERSION, STEP_SPECS,
  VARIANTS.map((v) => [v, IMPORT_TABLES.map((table) => fixture(v)[table].map((r) => toValues(table, r)))])]));

// ---- baseline: seed-only canonical snapshot, small fixture caps ----
function snapshotBaseline(raw) {
  const t = plain(raw, IMPORT_TABLES, [], 'BASELINE_INVALID'), out = {};
  let rows = 0, bytes = 0;
  for (const table of IMPORT_TABLES) {
    const length = Array.isArray(t[table]) ? Reflect.getOwnPropertyDescriptor(t[table], 'length')?.value : null;
    check(!Number.isSafeInteger(length) || length <= MAX_BASELINE_ROWS, 'BASELINE_LIMIT');
    const list = plainArray(t[table], MAX_BASELINE_ROWS, 'BASELINE_INVALID'), seen = new Set();
    rows += list.length;
    check(rows <= MAX_BASELINE_ROWS, 'BASELINE_LIMIT');
    out[table] = list.map((rawRow) => {
      const r = plain(rawRow, COLUMNS[table], [], 'BASELINE_INVALID'), copy = {};
      for (const c of COLUMNS[table]) { check(cellOk(r[c]), 'BASELINE_INVALID'); copy[c] = r[c]; }
      check(PRIMARY[table].every((c) => (KEY_TYPES[table][c] === 'text' ? typeof copy[c] === 'string' && copy[c].length > 0 : typeof copy[c] === 'number')), 'BASELINE_INVALID');
      const key = keyOf(table, toValues(table, copy));
      check(!seen.has(key), 'BASELINE_INVALID');
      seen.add(key);
      bytes += Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;
      check(bytes <= MAX_BASELINE_BYTES, 'BASELINE_LIMIT');
      return copy;
    });
    check(table === 'jenis_dokumen' || table === 'jenis_dokumen_wajib' || list.length === 0, 'BASELINE_NOT_SEED_ONLY');
  }
  return deepFreeze(out);
}
function baselineHash(snapshot) {
  try { return hashBaseline(snapshot); } catch { return fail('BASELINE_INVALID'); }
}

// Pure: required hashes for a caller-built descriptor (baselineSha256 is checked by build; scenario is informational).
export const proofScenarioSha256 = guarded((args) => {
  const { baseline } = plain(args, ['baseline'], [], 'INPUT_INVALID');
  return Object.freeze({ baselineSha256: baselineHash(snapshotBaseline(baseline)), scenarioSha256: SCENARIO_SHA256 });
});

// Canonical full state: run + journal (reader order) + tables sorted locally by typed PK; null on duplicate PK.
function canonical(run, journal, tables) {
  const out = [];
  for (const table of IMPORT_TABLES) {
    const sorted = tables[table].map((values) => [keyOf(table, values), values]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (sorted.some((entry, i) => i > 0 && entry[0] === sorted[i - 1][0])) return null;
    out.push([table, sorted.map((entry) => entry[1])]);
  }
  return JSON.stringify(['sikap-d1-v2-proof-state', run, journal, out]);
}
const runValues = (d, target, s) => [1, d.runNonce, d.ownerNonce, d.epoch, target, d.planSha256, s.stage, s.cursor, s.ordinal, s.claimSeq, s.lastChunkSha256, 0];
const journalValues = (d, target, c) => [d.runNonce, d.epoch, target, c.ordinal, c.stage, c.table, c.startCursor, c.endCursor, c.chunkSha256];
// Expected state after k plan chunks: baseline, chunk-0 seed delete of planned jenis ids, then plan prefix.
function expectedState(base, plan, artifact, states, d, target, k) {
  const maps = Object.fromEntries(IMPORT_TABLES.map((table) => [table, new Map(base[table].map((r) => { const v = toValues(table, r); return [keyOf(table, v), v]; }))]));
  const jenisIds = new Set(plan.jenis_dokumen.map((r) => r.id));
  if (k > 0) for (const [key, v] of maps.jenis_dokumen_wajib) if (jenisIds.has(v[0])) maps.jenis_dokumen_wajib.delete(key);
  for (const c of artifact.chunks.slice(0, k)) {
    for (const r of plan[c.table].slice(c.startCursor, c.endCursor)) {
      const v = toValues(c.table, r), key = keyOf(c.table, v);
      if (c.table !== 'jenis_dokumen' && maps[c.table].has(key)) return null; // plain INSERT would collide
      maps[c.table].set(key, v);
    }
  }
  const tables = Object.fromEntries(IMPORT_TABLES.map((table) => [table, [...maps[table].values()]]));
  return canonical([runValues(d, target, states[k])], artifact.chunks.slice(0, k).map((c) => journalValues(d, target, c)), tables);
}

const LAYOUT = ['ordinal', 'stage', 'table', 'startCursor', 'endCursor', 'nextStage', 'nextCursor', 'rowCount', 'statementCount'];
// Plan: exactly one chunk per stage. Fault: same layout, identical prefix chunks, only the target chunk differs.
function checkLayout(plan, tables, fault, target) {
  check(plan.chunkCount === IMPORT_TABLES.length && plan.chunks.every((c, i) => c.stage === i && c.table === IMPORT_TABLES[i] &&
    c.startCursor === 0 && c.endCursor === tables[c.table].length && c.nextStage === i + 1 && c.nextCursor === 0), 'LAYOUT_MISMATCH');
  if (fault === null) return;
  check(fault.chunkCount === plan.chunkCount && fault.chunks.every((c, i) => LAYOUT.every((f) => Object.is(c[f], plan.chunks[i][f]))), 'LAYOUT_MISMATCH');
  check(fault.chunks.slice(0, target).every((c, i) => c.chunkSha256 === plan.chunks[i].chunkSha256 && JSON.stringify(c.batch) === JSON.stringify(plan.chunks[i].batch)), 'LAYOUT_MISMATCH');
  check(fault.chunks[target].prevChunkSha256 === plan.chunks[target].prevChunkSha256 && fault.chunks[target].chunkSha256 !== plan.chunks[target].chunkSha256, 'LAYOUT_MISMATCH');
}

const MANIFESTS = new WeakMap();
// Builds the registered, deep-frozen PRIVATE manifest. Never sends anything. Throws D1V2ProofError.
export const buildD1V2Proof = guarded((args) => {
  const a = plain(args, ['descriptor', 'baseline', 'now'], [], 'INPUT_INVALID');
  let v;
  try { v = validateDescriptor(a.descriptor, a.now); } catch (error) {
    const code = error?.code;
    fail(code === 'NOW_INVALID' || code === 'DESCRIPTOR_EXPIRED' || code === 'DESCRIPTOR_TARGET_DENIED' ? code : 'DESCRIPTOR_INVALID');
  }
  const d = v.descriptor, target = v.targetBindingSha256;
  check(d.profile === 'synthetic', 'PROFILE_BLOCKED');
  const baseline = snapshotBaseline(a.baseline);
  check(baselineHash(baseline) === d.baselineSha256, 'BASELINE_HASH_MISMATCH');
  const tables = Object.fromEntries(VARIANTS.map((variant) => [variant, deepFreeze(fixture(variant))]));
  const artifacts = {};
  for (const variant of VARIANTS) {
    try { artifacts[variant] = compileChunks({ tables: tables[variant] }, d, { now: a.now }); } catch { fail('INTERNAL'); }
  }
  checkLayout(artifacts.plan, tables.plan, null, 0);
  for (const variant of ['check', 'unique', 'fk']) checkLayout(artifacts.plan, tables.plan, artifacts[variant], IMPORT_TABLES.indexOf(FAULT_TABLE[variant]));
  const plan = artifacts.plan, states = [createState(plan)];
  for (const chunk of plan.chunks) states.push(advanceState(states[states.length - 1], plan, chunk));
  const expected = states.map((_, k) => expectedState(baseline, tables.plan, plan, states, d, target, k));
  check(expected.every((s) => s !== null), 'PLAN_CONFLICTS_BASELINE');
  const steps = STEP_SPECS.map(([label, kind, variant, table, before]) => {
    const ordinal = plan.chunks.findIndex((c) => c.table === table);
    check(ordinal === IMPORT_TABLES.indexOf(table), 'LAYOUT_MISMATCH');
    return { label, kind, variant, table, ordinal, artifact: artifacts[variant], chunk: artifacts[variant].chunks[ordinal], before, after: kind === 'fault' ? before : before + 1 };
  });
  check(steps.every((s) => s.kind === 'fault' || s.ordinal === s.before), 'LAYOUT_MISMATCH');
  const baselineSha256 = d.baselineSha256;
  const manifestSha256 = sha256(JSON.stringify(['sikap-d1-v2-proof-manifest', PROOF_VERSION, SCENARIO_SHA256, baselineSha256, target,
    Object.keys(d).map((k) => [k, d[k]]), VARIANTS.map((variant) => artifacts[variant].chunks.map((c) => [c.chunkSha256, sha256(JSON.stringify(c.batch))])),
    expected.map((s) => sha256(s))]));
  const manifest = deepFreeze({
    proofVersion: PROOF_VERSION, privateManifest: true, descriptor: d, targetBindingSha256: target, artifacts, states, expected, steps,
    ...FLAGS,
  });
  MANIFESTS.set(manifest, Object.freeze({
    manifestSha256, scenarioSha256: SCENARIO_SHA256, baselineSha256,
    baselineRows: IMPORT_TABLES.reduce((n, t) => n + baseline[t].length, 0),
    planRowsPerTable: Object.freeze(Object.fromEntries(IMPORT_TABLES.map((t) => [t, tables.plan[t].length]))),
    maxBodyBytes: Math.max(...VARIANTS.flatMap((variant) => artifacts[variant].chunks.map((c) => c.bodyBytes))),
  }));
  return manifest;
});

// Public-safe: counts, hashes and flags only (no rows, nonces, SQL, params or ids).
export const summarizeProof = guarded((manifest) => {
  const meta = MANIFESTS.get(manifest);
  check(meta !== undefined, 'MANIFEST_UNKNOWN');
  return deepFreeze({
    proofVersion: PROOF_VERSION, ...meta, planRowsPerTable: { ...meta.planRowsPerTable }, artifactCount: VARIANTS.length,
    chunkCount: manifest.artifacts.plan.chunkCount, stepsTotal: PROOF_STEPS.length, stepLabels: [...PROOF_STEPS],
    expectedFetches: 1 + 2 * PROOF_STEPS.length, ...FLAGS,
  });
});

// ---- run ----
const STATUS_SET = new Set(PROOF_STATUSES), REASON_SET = new Set(PROOF_REASONS);
class Stop { constructor(status, reason) { this.status = status; this.reason = reason; } }
const stop = (status, reason) => { throw new Stop(status, reason); };
const need = (ok, status, reason) => { if (!ok) stop(status, reason); };
const codeOf = (error) => (typeof error?.code === 'string' ? error.code : 'INTERNAL');
function quiet(fn) {
  try { const p = fn(); if (p && typeof p.then === 'function') p.then(undefined, () => {}); } catch { /* swallowed */ }
}
// Injected lost response (final step only): the real request completes, its body is cancelled
// (never awaited or read) and the caller sees a fetch failure. Endpoint and init pass unchanged.
const lostResponse = (fetchImpl) => async (url, init) => {
  const response = await fetchImpl(url, init);
  quiet(() => { const b = response?.body; return b && typeof b.cancel === 'function' && b.locked !== true ? b.cancel() : undefined; });
  throw new Error('PROOF_LOST_RESPONSE');
};

function tick(ctx) {
  let now;
  try { now = ctx.nowProvider(); } catch { stop('STOPPED_CLOCK_INVALID', 'NOW_INVALID'); }
  const ms = typeof now === 'string' && ISO.test(now) ? Date.parse(now) : NaN;
  need(Number.isFinite(ms) && new Date(ms).toISOString() === now, 'STOPPED_CLOCK_INVALID', 'NOW_INVALID');
  need(ctx.lastMs === null || ms >= ctx.lastMs, 'STOPPED_CLOCK_INVALID', 'NOW_NOT_MONOTONE');
  ctx.lastMs = ms;
  try { validateDescriptor(ctx.m.descriptor, now); } catch (error) {
    if (error?.code === 'DESCRIPTOR_EXPIRED') stop('STOPPED_DESCRIPTOR_EXPIRED', 'DESCRIPTOR_EXPIRED');
    stop('STOPPED_INPUT_INVALID', 'DESCRIPTOR_INVALID');
  }
  return now;
}
async function read(ctx) {
  const now = tick(ctx);
  ctx.counts.reads++;
  let r;
  try { r = await ctx.reader.read({ now }); } catch (error) { return stop('STOPPED_READBACK_FAILED', codeOf(error)); }
  need(r !== null && typeof r === 'object' && r.private === true && Array.isArray(r.run) && Array.isArray(r.journal) &&
    r.tables !== null && typeof r.tables === 'object' && IMPORT_TABLES.every((t) => Array.isArray(r.tables[t])), 'STOPPED_READBACK_FAILED', 'READBACK_SHAPE');
  const state = canonical(r.run.map((x) => LEDGER.runColumns.map((c) => x[c])), r.journal.map((x) => LEDGER.journalColumns.map((c) => x[c])),
    Object.fromEntries(IMPORT_TABLES.map((t) => [t, r.tables[t].map((x) => toValues(t, x))])));
  return { r, state };
}
const receiptOf = (x) => ({ runNonce: x.run_nonce, ownerNonce: x.owner_nonce, epoch: x.epoch, targetBindingSha256: x.target_binding_sha256, planSha256: x.plan_sha256,
  stage: x.stage, cursor: x.cursor, ordinal: x.ordinal, claimSeq: x.claim_seq, lastChunkSha256: x.last_chunk_sha256, complete: x.complete });
const journalOf = (x) => ({ runNonce: x.run_nonce, epoch: x.epoch, targetBindingSha256: x.target_binding_sha256, ordinal: x.ordinal, stage: x.stage,
  tableName: x.table_name, startCursor: x.start_cursor, endCursor: x.end_cursor, chunkSha256: x.chunk_sha256 });
// writerQuiescent is never attested; COMMITTED_OBSERVED needs exact next receipt + journal + full prefix.
function observe(ctx, r, ordinal, exact) {
  if (r.run.length !== 1) return 'DIVERGED';
  try {
    return classifyResume({ artifact: ctx.m.artifacts.plan, ordinal, observedReceipt: receiptOf(r.run[0]), journal: r.journal.map(journalOf), exactPrefixVerified: exact, writerQuiescent: false }).outcome;
  } catch { return 'DIVERGED'; }
}
const EXPECT = Object.freeze({
  fault: Object.freeze({ status: 'AMBIGUOUS', reason: 'HTTP_STATUS', httpCategory: 'CLIENT' }),
  commit: Object.freeze({ status: 'RESPONSE_ACCEPTED', reason: null, httpCategory: 'SUCCESS' }),
  lost: Object.freeze({ status: 'AMBIGUOUS', reason: 'FETCH_FAILED', httpCategory: null }),
});

async function execute(raw, ctx) {
  const a = plain(raw, ['manifest', 'token', 'fetchImpl', 'nowProvider'], ['timeoutMs'], 'INPUT_INVALID');
  need(MANIFESTS.has(a.manifest), 'STOPPED_INPUT_INVALID', 'MANIFEST_UNKNOWN');
  need(typeof a.fetchImpl === 'function', 'STOPPED_INPUT_INVALID', 'FETCH_REQUIRED');
  need(typeof a.nowProvider === 'function', 'STOPPED_INPUT_INVALID', 'NOW_PROVIDER_REQUIRED');
  need(!Object.hasOwn(a, 'timeoutMs') || (Number.isSafeInteger(a.timeoutMs) && a.timeoutMs >= 1 && a.timeoutMs <= MAX_PROOF_TIMEOUT_MS), 'STOPPED_INPUT_INVALID', 'TIMEOUT_INVALID');
  const m = a.manifest, timeout = Object.hasOwn(a, 'timeoutMs') ? { timeoutMs: a.timeoutMs } : {};
  Object.assign(ctx, { m, nowProvider: a.nowProvider, lastMs: null });
  const adapterFor = (step, fetchImpl, now) => {
    try { return createD1RestAdapter({ descriptor: m.descriptor, artifact: step.artifact, token: a.token, fetchImpl, now, ...timeout }); } catch (error) {
      return stop(ctx.counts.sends === 0 ? 'STOPPED_INPUT_INVALID' : 'STOPPED_SEND_REFUSED', codeOf(error));
    }
  };
  // Preflight (no request): reader + a probe adapter validate token/fetch/timeout/profile/artifact binding.
  try { ctx.reader = createD1Readback({ descriptor: m.descriptor, token: a.token, fetchImpl: a.fetchImpl, ...timeout }); } catch (error) { stop('STOPPED_INPUT_INVALID', codeOf(error)); }
  adapterFor(m.steps[0], a.fetchImpl, tick(ctx));

  ctx.phase = 'INITIAL_READ';
  const initial = await read(ctx);
  need(initial.state === m.expected[0], 'STOPPED_INITIAL_STATE_MISMATCH', 'STATE_MISMATCH');
  ctx.baselineObserved = true;

  ctx.phase = 'STEPS';
  for (const step of m.steps) {
    // Precondition: the previous verified post read is the pre-state (private single-operator target).
    const now = tick(ctx);
    const adapter = adapterFor(step, step.kind === 'lost' ? lostResponse(a.fetchImpl) : a.fetchImpl, now);
    let res;
    try { res = await adapter.send({ chunk: step.chunk, now }); } catch (error) {
      ctx.counts.sends += adapter.summary().sentCount;
      stop('STOPPED_SEND_REFUSED', codeOf(error));
    }
    ctx.counts.sends += adapter.summary().sentCount;
    const entry = { label: step.label, sent: true, adapterStatus: res.status, adapterReason: res.reason, httpCategory: res.httpCategory,
      exactStateObserved: false, stateUnchangedObserved: null, observation: null, passed: false };
    ctx.steps.push(entry);
    const post = await read(ctx); // the ONE observation read for this send; never a resend
    entry.exactStateObserved = post.state === m.expected[step.after];
    if (step.kind === 'fault') entry.stateUnchangedObserved = entry.exactStateObserved;
    else entry.observation = observe(ctx, post.r, step.ordinal, entry.exactStateObserved);
    const want = EXPECT[step.kind];
    if (res.status !== want.status || res.reason !== want.reason || res.httpCategory !== want.httpCategory) {
      stop('STOPPED_UNEXPECTED_OUTCOME', step.kind === 'fault' && res.status === 'RESPONSE_ACCEPTED' ? 'FAULT_ACCEPTED' : REASON_SET.has(res.reason) ? res.reason : 'UNEXPECTED_ADAPTER_RESULT');
    }
    need(entry.exactStateObserved, 'STOPPED_STATE_MISMATCH', 'STATE_MISMATCH');
    need(step.kind === 'fault' || entry.observation === 'COMMITTED_OBSERVED', 'STOPPED_STATE_MISMATCH', 'OBSERVATION_NOT_COMMITTED');
    entry.passed = true;
    ctx.counts.stepsPassed++;
  }
  ctx.phase = 'DONE';
}

function report(ctx, status, reason) {
  const ok = status === 'SYNTHETIC_PROOF_OBSERVED';
  return deepFreeze({
    proofVersion: PROOF_VERSION, status: STATUS_SET.has(status) ? status : 'STOPPED_INTERNAL',
    reason: reason === null ? null : REASON_SET.has(reason) ? reason : 'INTERNAL', phase: ctx.phase,
    counts: { ...ctx.counts, stepsTotal: PROOF_STEPS.length }, steps: ctx.steps.map((s) => ({ ...s })),
    baselineObserved: ctx.baselineObserved, syntheticSequenceObserved: ok && ctx.counts.stepsPassed === PROOF_STEPS.length,
    syntheticRowsMayRemain: ctx.counts.sends > 0, manualRecoveryRequired: !ok && ctx.counts.sends > 0, ...FLAGS,
  });
}

let active = false;
// Runs the fixed 11-send synthetic sequence once. Never throws; returns a frozen public-safe report.
export async function runD1V2Proof(args) {
  const ctx = { phase: 'PREFLIGHT', baselineObserved: false, steps: [], counts: { sends: 0, reads: 0, stepsPassed: 0 } };
  if (active) return report(ctx, 'STOPPED_BUSY', 'BUSY');
  active = true;
  try {
    await execute(args, ctx);
    return report(ctx, 'SYNTHETIC_PROOF_OBSERVED', null);
  } catch (error) {
    if (error instanceof Stop) return report(ctx, error.status, error.reason);
    if (OWN_ERRORS.has(error)) return report(ctx, 'STOPPED_INPUT_INVALID', 'ARGS_INVALID');
    return report(ctx, 'STOPPED_INTERNAL', 'INTERNAL');
  } finally { active = false; }
}
