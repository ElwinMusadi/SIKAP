// MOCK-ONLY importer adapter: LOCAL deterministic in-memory simulation of the core's candidate
// chunk protocol (CAS claim, guards, seed delete, typed inserts, journal, checkpoint).
//
// Scope and limits (read before using any output):
//   * Pure except private closure state. No network, HTTP, R2, credentials, environment,
//     filesystem, process spawn, clock, timers or SQL engine. `now` is always explicit.
//   * It is NOT a transport and proves nothing about D1/REST/HTTP semantics. Faults are a fixed
//     enum of SIMULATION CONTROLS; a simulated 429/500/timeout says nothing about a real server.
//     Only primary-key conflicts are modelled, not the database's UNIQUE, FK or CHECK constraints.
//     Every output carries localOnly:true, simulated:true, transportProof:false and the core
//     SAFETY flags (remoteAuthorized/readyForImport/authorizesExecution false).
//   * Only the fixed core SQL templates of a known compiled artifact are recognized, matched by
//     identity at construction and decoded by the core v2 decodeStatement (JSON-row string
//     params) before any positional check; arbitrary SQL is never interpreted.
//   * Every ambiguous outcome HALTS the instance; there is no automatic resend or retry. settle()
//     only resolves a simulated in-flight request and never authorizes a resume or retry.
//   * inspect() is PRIVATE (contains nonces/digests needed by core classifyResume); never log it.
//     summary() is public-safe: counts, enums and flags only.
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { COLUMNS, PRIMARY, KEY_TYPES, SQL, SAFETY, ImportCoreError, decodeStatement, validateDescriptor, summarize } from './core.mjs';

export const MOCK_VERSION = 1;
export const MOCK_FAULTS = Object.freeze([
  'none', 'rollback-after-claim', 'rollback-after-data', 'rollback-after-journal', 'timeout-before-commit',
  'timeout-after-commit', 'timeout-pending', 'http-429', 'http-500', 'malformed-response',
]);
export const MOCK_OUTCOMES = Object.freeze(['APPLIED_SIMULATED', 'ROLLED_BACK_SIMULATED', 'AMBIGUOUS_SIMULATED']);
export const MOCK_ROLLBACK_REASONS = Object.freeze(['GUARD_ABORT', 'CONSTRAINT_ABORT', 'INJECTED_ROLLBACK']);
export const MOCK_ERROR_CODES = Object.freeze([
  'INPUT_INVALID', 'NOW_INVALID', 'DESCRIPTOR_INVALID', 'DESCRIPTOR_EXPIRED', 'ARTIFACT_UNKNOWN', 'ARTIFACT_SHAPE',
  'MOCK_BINDING_MISMATCH', 'SEED_INVALID', 'FAULT_INVALID', 'CHUNK_FOREIGN', 'CHUNK_STALE', 'CHUNK_OUT_OF_ORDER',
  'RUN_EXHAUSTED', 'HALTED', 'NOT_PENDING', 'INTERNAL',
]);
const FLAGS = Object.freeze({
  localOnly: true, simulated: true, transportProof: false, transportProven: false, authorizesRetry: false,
  authorizesSend: false, autoResendAllowed: false, ...SAFETY,
});
const SEED_TABLES = Object.freeze(['jenis_dokumen', 'jenis_dokumen_wajib']);
const MAX_SEED_ROWS = 1000;
const MAX_VALUE_CHARS = 16_384;
// Core PRIMARY/KEY_TYPES (type-strict keys: 1 and '1' never alias; values never coerced).
const KEY_INDEXES = Object.freeze(Object.fromEntries(IMPORT_TABLES.map((table) => [table, Object.freeze(PRIMARY[table].map((column) => COLUMNS[table].indexOf(column)))])));
const keyTyped = (table, values) => PRIMARY[table].every((column, i) => {
  const value = values[KEY_INDEXES[table][i]];
  return KEY_TYPES[table][column] === 'text' ? typeof value === 'string' && value.length > 0 : Number.isSafeInteger(value);
});

const CODE_SET = new Set(MOCK_ERROR_CODES);
const OWN_ERRORS = new WeakSet();
// Closed-code error: message === code; never carries input values.
export class MockAdapterError extends Error {
  constructor(code) {
    const safe = typeof code === 'string' && CODE_SET.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'MockAdapterError';
    this.code = safe;
    OWN_ERRORS.add(this);
  }
}
const fail = (code) => { throw new MockAdapterError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
function mapCore(error) {
  try {
    if (!(error instanceof ImportCoreError)) return 'INTERNAL';
    const code = error.code;
    if (code === 'NOW_INVALID' || code === 'DESCRIPTOR_EXPIRED' || code === 'ARTIFACT_UNKNOWN') return code;
    return typeof code === 'string' && code.startsWith('DESCRIPTOR_') ? 'DESCRIPTOR_INVALID' : 'INTERNAL';
  } catch { return 'INTERNAL'; }
}
function guarded(fn) {
  return (...args) => {
    try { return fn(...args); } catch (error) {
      if (OWN_ERRORS.has(error)) throw error;
      throw new MockAdapterError(mapCore(error));
    }
  };
}
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Snapshot own enumerable DATA properties (no getters run, no symbols/inherited/extra keys).
function snapshot(value, required, optional, code) {
  try {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), code);
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, code);
    const allowed = new Set([...required, ...optional]);
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
      check(typeof key === 'string' && allowed.has(key), code);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      check(descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true, code);
      out[key] = descriptor.value;
    }
    check(required.every((key) => Object.hasOwn(out, key)), code);
    return out;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    throw new MockAdapterError(code);
  }
}
function snapshotArray(value, max, code) {
  try {
    check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, code);
    const length = Reflect.getOwnPropertyDescriptor(value, 'length')?.value;
    check(Number.isSafeInteger(length) && length <= max && Reflect.ownKeys(value).length === length + 1, code);
    const out = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      check(descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true, code);
      out.push(descriptor.value);
    }
    return out;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    throw new MockAdapterError(code);
  }
}

const keyOf = (table, values) => JSON.stringify(KEY_INDEXES[table].map((index) => values[index]));
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, index) => value === b[index]);

// Synthetic canonical seed for the two seed tables only (test baseline; not business-validated).
function readSeed(raw) {
  const out = Object.fromEntries(IMPORT_TABLES.map((table) => [table, new Map()]));
  if (raw === undefined) return out;
  const seed = snapshot(raw, SEED_TABLES, [], 'SEED_INVALID');
  for (const table of SEED_TABLES) {
    const columns = COLUMNS[table];
    for (const rawRow of snapshotArray(seed[table], MAX_SEED_ROWS, 'SEED_INVALID')) {
      const row = snapshot(rawRow, columns, [], 'SEED_INVALID');
      const values = Object.freeze(columns.map((column) => {
        const value = row[column];
        if (value === null) return null;
        if (typeof value === 'string') {
          check(value.length <= MAX_VALUE_CHARS && !value.includes('\0') && value.isWellFormed(), 'SEED_INVALID');
          return value;
        }
        check(Number.isSafeInteger(value) && !Object.is(value, -0), 'SEED_INVALID');
        return value;
      }));
      check(keyTyped(table, values), 'SEED_INVALID');
      const key = keyOf(table, values);
      check(!out[table].has(key), 'SEED_INVALID');
      out[table].set(key, values);
    }
  }
  return out;
}

// Strict core v2 decode of one wire statement; any rejection is an artifact shape failure.
const decode = (statement) => {
  try { return decodeStatement(statement); } catch { return fail('ARTIFACT_SHAPE'); }
};

// Recognize ONLY the fixed core templates of each chunk: every statement is decoded by the core
// v2 decoder FIRST (exact SQL allowlist, single canonical JSON param), then every binding value is
// checked at its fixed decoded position against the descriptor (claim, journal, checkpoint).
// Returns typed operations over decoded values; wire params are never interpreted directly.
function compileOps(artifact, b) {
  const chunks = artifact.chunks;
  return Object.freeze(chunks.map((chunk, i) => {
    const batch = chunk.batch, prev = chunk.prevChunkSha256;
    check(Array.isArray(batch) && batch.length >= 5 && chunk.ordinal === i && chunk.table === IMPORT_TABLES[chunk.stage], 'ARTIFACT_SHAPE');
    check(prev === (i === 0 ? null : chunks[i - 1].chunkSha256), 'ARTIFACT_SHAPE');
    const decoded = batch.map(decode);
    check(batch[0].sql === SQL.claim && batch[1].sql === SQL.guard && batch.at(-3).sql === SQL.journal &&
      batch.at(-2).sql === SQL.checkpoint && batch.at(-1).sql === SQL.guard, 'ARTIFACT_SHAPE');
    check(decoded[0].kind === 'claim' && decoded[1].kind === 'guard' && decoded.at(-3).kind === 'journal' &&
      decoded.at(-2).kind === 'checkpoint' && decoded.at(-1).kind === 'guard', 'ARTIFACT_SHAPE');
    const bind = [b.runNonce, b.ownerNonce, b.epoch, b.target, b.plan, chunk.stage, chunk.startCursor, i];
    const journal = [b.runNonce, b.epoch, b.target, i, chunk.stage, chunk.table, chunk.startCursor, chunk.endCursor, chunk.chunkSha256];
    check(sameList(decoded[0].values, [i + 1, ...bind, i, prev]), 'MOCK_BINDING_MISMATCH');
    check(sameList(decoded.at(-3).values, journal), 'MOCK_BINDING_MISMATCH');
    check(sameList(decoded.at(-2).values, [chunk.nextStage, chunk.nextCursor, i + 1, chunk.chunkSha256, ...bind, i + 1, prev]), 'MOCK_BINDING_MISMATCH');
    const ops = [{ kind: 'claim', set: i + 1, where: [...bind, i, prev] }, { kind: 'guard' }];
    let rows = 0;
    decoded.slice(2, -3).forEach((s, k) => {
      if (s.kind === 'seedDelete' && i === 0 && k === 0 && chunk.startCursor === 0) {
        ops.push({ kind: 'seedDelete', ids: new Set(s.values) }); // decoded: non-empty unique id strings
      } else {
        check(s.kind === 'insert' && s.table === chunk.table && s.values.length === COLUMNS[chunk.table].length && keyTyped(chunk.table, s.values), 'ARTIFACT_SHAPE');
        ops.push({ kind: chunk.table === 'jenis_dokumen' ? 'upsert' : 'insert', table: chunk.table, values: s.values });
        rows++;
      }
    });
    check(rows === chunk.rowCount, 'ARTIFACT_SHAPE');
    const [runNonce, epoch, targetBindingSha256, ordinal, stage, tableName, startCursor, endCursor, chunkSha256] = journal;
    ops.push(
      { kind: 'journal', entry: { runNonce, epoch, targetBindingSha256, ordinal, stage, tableName, startCursor, endCursor, chunkSha256 } },
      { kind: 'checkpoint', where: [...bind, i + 1, prev], set: { stage: chunk.nextStage, cursor: chunk.nextCursor, ordinal: i + 1, last: chunk.chunkSha256 } },
      { kind: 'guard' },
    );
    return deepFreeze(ops);
  }));
}

const casMatches = (b, l, w) => l.complete === 0 && sameList(w, [b.runNonce, b.ownerNonce, b.epoch, b.target, b.plan, l.stage, l.cursor, l.ordinal, l.claimSeq, l.last]);

// Execute one chunk's typed operations against an isolated draft. Returns null on success or a
// rollback reason; the caller publishes the draft only on null (all-or-nothing).
function execute(b, ops, draft, fault) {
  let changes = 0;
  for (const op of ops) {
    if (op.kind === 'claim') {
      changes = casMatches(b, draft.ledger, op.where) ? 1 : 0;
      if (changes) draft.ledger.claimSeq = op.set;
      if (fault === 'rollback-after-claim') return 'INJECTED_ROLLBACK';
    } else if (op.kind === 'guard') {
      if (changes !== 1) return 'GUARD_ABORT';
    } else if (op.kind === 'seedDelete') {
      changes = 0;
      for (const [key, values] of draft.tables.jenis_dokumen_wajib) if (op.ids.has(values[0])) { draft.tables.jenis_dokumen_wajib.delete(key); changes++; }
    } else if (op.kind === 'upsert') {
      draft.tables[op.table].set(keyOf(op.table, op.values), op.values);
      changes = 1;
    } else if (op.kind === 'insert') {
      const key = keyOf(op.table, op.values);
      if (draft.tables[op.table].has(key)) return 'CONSTRAINT_ABORT';
      draft.tables[op.table].set(key, op.values);
      changes = 1;
    } else if (op.kind === 'journal') {
      if (fault === 'rollback-after-data') return 'INJECTED_ROLLBACK';
      if (draft.journal.some((e) => e.runNonce === op.entry.runNonce && e.ordinal === op.entry.ordinal)) return 'CONSTRAINT_ABORT';
      draft.journal.push(op.entry);
      changes = 1;
      if (fault === 'rollback-after-journal') return 'INJECTED_ROLLBACK';
    } else if (op.kind === 'checkpoint') {
      changes = casMatches(b, draft.ledger, op.where) ? 1 : 0;
      if (changes) Object.assign(draft.ledger, op.set);
    } else return 'GUARD_ABORT';
  }
  return null;
}

const cloneTables = (tables) => Object.fromEntries(IMPORT_TABLES.map((table) => [table, new Map(tables[table])]));
const counts = (tables) => Object.fromEntries(IMPORT_TABLES.map((table) => [table, tables[table].size]));

export const createMockAdapter = guarded((raw) => {
  const input = snapshot(raw, ['artifact', 'descriptor', 'now'], ['seed'], 'INPUT_INVALID');
  const { descriptor: d, targetBindingSha256 } = validateDescriptor(input.descriptor, input.now);
  summarize(input.artifact); // known core artifact only (ARTIFACT_UNKNOWN otherwise)
  const artifact = input.artifact, chunks = artifact.chunks;
  const b = Object.freeze({ runNonce: d.runNonce, ownerNonce: d.ownerNonce, epoch: d.epoch, target: targetBindingSha256, plan: d.planSha256 });
  const ops = compileOps(artifact, b);
  check(chunks.length > 0 && chunks.at(-1).nextStage === IMPORT_TABLES.length, 'ARTIFACT_SHAPE');
  const seed = readSeed(input.seed);
  let lastNowMs = Date.parse(input.now);
  let st = { tables: cloneTables(seed), ledger: { stage: 0, cursor: 0, ordinal: 0, claimSeq: 0, last: null, complete: 0 }, journal: [] };
  let halted = false, pending = null, sentCount = 0, settledCount = 0, lastFault = null, lastOutcome = null;

  // Independent prefix replay from the seed over artifact.chunks[0..n) compared with actual maps,
  // journal and ledger. Computed from private state, never a caller attestation.
  const verifyPrefix = () => {
    const n = st.ledger.ordinal, expected = cloneTables(seed);
    for (let i = 0; i < n; i++) {
      for (const op of ops[i]) {
        if (op.kind === 'seedDelete') { for (const [key, values] of expected.jenis_dokumen_wajib) if (op.ids.has(values[0])) expected.jenis_dokumen_wajib.delete(key); }
        else if (op.kind === 'upsert' || op.kind === 'insert') expected[op.table].set(keyOf(op.table, op.values), op.values);
      }
    }
    const dataOk = IMPORT_TABLES.every((table) => expected[table].size === st.tables[table].size &&
      [...expected[table]].every(([key, values]) => sameList(st.tables[table].get(key), values)));
    const journalOk = st.journal.length === n && st.journal.every((entry, i) => {
      const want = ops[i].find((op) => op.kind === 'journal').entry;
      return Object.keys(want).every((key) => entry[key] === want[key]);
    });
    const l = st.ledger, prior = n === 0 ? null : chunks[n - 1];
    const ledgerOk = l.complete === 0 && l.claimSeq === n && l.stage === (prior ? prior.nextStage : 0) &&
      l.cursor === (prior ? prior.nextCursor : 0) && l.last === (prior ? prior.chunkSha256 : null);
    return dataOk && journalOk && ledgerOk;
  };

  const send = guarded((rawArgs) => {
    const a = snapshot(rawArgs, ['chunk', 'now', 'fault'], [], 'INPUT_INVALID');
    check(typeof a.fault === 'string' && MOCK_FAULTS.includes(a.fault), 'FAULT_INVALID');
    validateDescriptor(d, a.now); // expiry re-checked before EVERY attempt (expiresAt equality rejects)
    const nowMs = Date.parse(a.now);
    check(nowMs >= lastNowMs, 'NOW_INVALID');
    lastNowMs = nowMs;
    check(!halted, 'HALTED');
    const index = chunks.indexOf(a.chunk), n = st.ledger.ordinal;
    check(index >= 0, 'CHUNK_FOREIGN');
    check(n < chunks.length, 'RUN_EXHAUSTED');
    check(index >= n, 'CHUNK_STALE');
    check(index === n, 'CHUNK_OUT_OF_ORDER');
    sentCount++;
    lastFault = a.fault;
    const draft = { tables: cloneTables(st.tables), ledger: { ...st.ledger }, journal: st.journal.slice() };
    let outcome, reason = null;
    if (a.fault === 'timeout-before-commit' || a.fault === 'http-429' || a.fault === 'http-500') {
      outcome = 'AMBIGUOUS_SIMULATED'; // modelled as not executed; the caller cannot know that
    } else if (a.fault === 'timeout-pending') {
      pending = { draft: execute(b, ops[n], draft, 'none') === null ? draft : null };
      outcome = 'AMBIGUOUS_SIMULATED';
    } else if (a.fault === 'timeout-after-commit' || a.fault === 'malformed-response') {
      if (execute(b, ops[n], draft, 'none') === null) st = draft; // modelled as executed
      outcome = 'AMBIGUOUS_SIMULATED';
    } else {
      reason = execute(b, ops[n], draft, a.fault);
      if (reason === null) st = draft;
      outcome = reason === null ? 'APPLIED_SIMULATED' : 'ROLLED_BACK_SIMULATED';
    }
    if (outcome !== 'APPLIED_SIMULATED') halted = true;
    lastOutcome = outcome;
    return deepFreeze({
      outcome, rollbackReason: reason, fault: a.fault, halted, pending: pending !== null, sentCount,
      operatorDecisionRequired: halted, ...FLAGS,
    });
  });

  // SIMULATION CONTROL only: resolves a simulated in-flight request (late commit or abort). Takes
  // no `now`: elapsed time cannot undo an already-sent write. Never re-enables sending.
  const settle = guarded((rawArgs) => {
    const { outcome } = snapshot(rawArgs, ['outcome'], [], 'INPUT_INVALID');
    check(outcome === 'commit' || outcome === 'abort', 'INPUT_INVALID');
    check(pending !== null, 'NOT_PENDING');
    if (outcome === 'commit' && pending.draft !== null) st = pending.draft;
    pending = null;
    settledCount++;
    return deepFreeze({ settled: outcome, simulationControl: true, halted, pending: false, operatorDecisionRequired: true, ...FLAGS });
  });

  // PRIVATE read-only observation shaped for core classifyResume (spread `resume` into it).
  const inspect = guarded((...rest) => {
    check(rest.length === 0, 'INPUT_INVALID');
    const l = st.ledger;
    return deepFreeze({
      private: true,
      resume: {
        observedReceipt: {
          runNonce: b.runNonce, ownerNonce: b.ownerNonce, epoch: b.epoch, targetBindingSha256: b.target, planSha256: b.plan,
          stage: l.stage, cursor: l.cursor, ordinal: l.ordinal, claimSeq: l.claimSeq, lastChunkSha256: l.last, complete: l.complete,
        },
        journal: st.journal.map((entry) => ({ ...entry })),
        exactPrefixVerified: verifyPrefix(),
        writerQuiescent: pending === null,
      },
      rowsByTable: counts(st.tables), ...FLAGS,
    });
  });

  // Public-safe: counts, enums and flags only (no ids, hashes, nonces, params or error text).
  const summary = guarded((...rest) => {
    check(rest.length === 0, 'INPUT_INVALID');
    return deepFreeze({
      mockVersion: MOCK_VERSION, chunkCount: chunks.length, sentCount, settledCount, committedChunks: st.ledger.ordinal,
      journalCount: st.journal.length, rowsByTable: counts(st.tables), halted, pending: pending !== null,
      allChunksApplied: st.ledger.ordinal === chunks.length, complete: false, lastFault, lastOutcome, ...FLAGS,
    });
  });

  return Object.freeze({ send, inspect, settle, summary });
});
