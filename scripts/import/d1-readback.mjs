// SIKAP D1 REST read-back reader (local-tested with injected fetch).
//
// - Sends ONE read-only request per read(): a fixed list of static SELECTs (ledger run, ledger
//   journal, the seven import tables, optionally sqlite_schema). The caller supplies no SQL, table,
//   column, key, filter or params. No mutating statement or DDL is ever sent.
// - Synthetic behavior is unchanged. Real-data requires a claimed in-process UAT permit. The
//   descriptor is snapshotted at creation and its full permit binding, expiry and lifecycle are
//   revalidated with explicit `now` on every read before dispatch. No caller profile flag grants access.
// - Caller injects fetchImpl (no global default). Token lives only in this closure; never returned.
// - Returned rows are PRIVATE (PII/password hashes in synthetic shape): never print or log them.
//   The reader proves no target identity, schema, commit or transport property:
//   identityVerified/transportProven stay false and SAFETY flags are carried unchanged.
// - Strict fail-closed parsing; any failure throws ReadbackError with a closed code only (no
//   provider text, status, SQL, values) and permanently halts the instance. No retry, no paging.
import { ARTIFACT_LIMITS, IMPORT_TABLES } from '../migrate/contract.mjs';
import { COLUMNS, LEDGER, PRIMARY, SAFETY, ImportCoreError, validateDescriptor } from './core.mjs';
import { ENDPOINT_ORIGIN, ENDPOINT_PATH } from './d1-rest.mjs';
import { isPermitClaimed, isPermitSpent, validatePermitRequest } from './real-data-gate.mjs';

export const READBACK_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_STRING_BYTES = 64 * 1024;
export const ROW_LIMITS = Object.freeze({ run: 1, journal: 100_000, tables: ARTIFACT_LIMITS.rows, schema: 1_000 });

const freezeAll = (v) => { if (v && typeof v === 'object') { for (const k of Object.keys(v)) freezeAll(v[k]); Object.freeze(v); } return v; };
const select = (columns, table, order) => `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order.join(', ')}`;
// Static query list; order defines the expected result order.
export const READBACK_QUERIES = freezeAll([
  { key: 'run', columns: [...LEDGER.runColumns], sql: select(LEDGER.runColumns, LEDGER.runTable, ['id']) },
  { key: 'journal', columns: [...LEDGER.journalColumns], sql: select(LEDGER.journalColumns, LEDGER.journalTable, ['run_nonce', 'ordinal']) },
  ...IMPORT_TABLES.map((table) => ({ key: table, columns: [...COLUMNS[table]], sql: select(COLUMNS[table], table, PRIMARY[table]) })),
]);
export const SCHEMA_QUERY = freezeAll({
  key: 'schema', columns: ['type', 'name', 'tbl_name', 'sql'],
  sql: "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 11) <> 'sqlite_stat' AND name <> 'sqlite_sequence' ORDER BY type, name",
});

export const READBACK_ERROR_CODES = Object.freeze([
  'INPUT_INVALID', 'TOKEN_INVALID', 'FETCH_REQUIRED', 'TIMEOUT_INVALID', 'NOW_INVALID', 'NOW_NOT_MONOTONE',
  'DESCRIPTOR_INVALID', 'DESCRIPTOR_EXPIRED', 'DESCRIPTOR_TARGET_DENIED', 'PROFILE_BLOCKED', 'BUSY', 'HALTED',
  'FETCH_FAILED', 'TIMEOUT', 'REDIRECTED', 'HTTP_STATUS', 'CONTENT_TYPE', 'BODY_OVERSIZE', 'BODY_INVALID',
  'ENVELOPE_INVALID', 'RESULT_COUNT', 'RESULT_INVALID', 'META_INVALID', 'ROW_LIMIT', 'ROW_INVALID', 'VALUE_INVALID',
  'PERMIT_INVALID', 'INTERNAL',
]);
const CODES = new Set(READBACK_ERROR_CODES), OWN = new WeakSet();
export class ReadbackError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'ReadbackError';
    this.code = safe;
    OWN.add(this);
  }
}
const fail = (code) => { throw new ReadbackError(code); };
const check = (ok, code) => { if (!ok) fail(code); };
const safeError = (error) => (OWN.has(error) ? error : new ReadbackError('INTERNAL'));

// Own enumerable data properties only; getters never run. required=null allows any string keys.
function plainArgs(value, required, optional = []) {
  try {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'INPUT_INVALID');
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, 'INPUT_INVALID');
    const own = Reflect.ownKeys(value), allowed = new Set([...(required ?? []), ...optional]), out = {};
    check(own.every((k) => typeof k === 'string' && (required === null || allowed.has(k))), 'INPUT_INVALID');
    check(required === null || required.every((k) => own.includes(k)), 'INPUT_INVALID');
    for (const key of own) {
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      check(Object.hasOwn(d, 'value') && d.enumerable === true, 'INPUT_INVALID');
      out[key] = d.value;
    }
    return out;
  } catch (error) { throw OWN.has(error) ? error : new ReadbackError('INPUT_INVALID'); }
}

function validated(descriptor, now) {
  try { return validateDescriptor(descriptor, now); } catch (error) {
    const code = error instanceof ImportCoreError ? error.code : 'INTERNAL';
    if (code === 'NOW_INVALID' || code === 'DESCRIPTOR_EXPIRED' || code === 'DESCRIPTOR_TARGET_DENIED') fail(code);
    return fail('DESCRIPTOR_INVALID');
  }
}

// Copied from d1-rest (private there): bounded plain JSON meta, validated and never reflected.
function boundedJson(value, depth) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 1024;
  if (depth >= 4 || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length <= 32 && value.every((x) => boundedJson(x, depth + 1));
  const keys = Object.keys(value);
  return Object.getPrototypeOf(value) === Object.prototype && keys.length <= 32 && keys.every((k) => boundedJson(value[k], depth + 1));
}
const exactKeys = (o, keys, optional = []) => o !== null && typeof o === 'object' && !Array.isArray(o) &&
  Object.getPrototypeOf(o) === Object.prototype && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k)) && keys.every((k) => Object.hasOwn(o, k));
const cell = (v) => v === null || (Number.isSafeInteger(v) && !Object.is(v, -0)) ||
  (typeof v === 'string' && !v.includes('\0') && v.isWellFormed() && Buffer.byteLength(v, 'utf8') <= MAX_STRING_BYTES);

function quiet(fn) {
  try { const p = fn(); if (p && typeof p.then === 'function') p.then(undefined, () => {}); } catch { /* swallowed */ }
}
function discardBody(response) {
  quiet(() => {
    const b = response?.body;
    return b && typeof b.cancel === 'function' && b.locked !== true ? b.cancel() : undefined;
  });
}
const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TA_TAG = Reflect.getOwnPropertyDescriptor(TA_PROTO, Symbol.toStringTag).get;
const TA_BYTE_LENGTH = Reflect.getOwnPropertyDescriptor(TA_PROTO, 'byteLength').get;
const TA_SET = TA_PROTO.set;
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Rows: exact column key set (any response order), primitive cells, re-emitted in canonical order.
function rowsOf(r, q, max) {
  check(exactKeys(r, ['success', 'results'], ['meta']) && r.success === true && Array.isArray(r.results), 'RESULT_INVALID');
  if (Object.hasOwn(r, 'meta')) check(r.meta !== null && typeof r.meta === 'object' && !Array.isArray(r.meta) && boundedJson(r.meta, 0), 'META_INVALID');
  check(r.results.length <= max, 'ROW_LIMIT');
  return Object.freeze(r.results.map((row) => {
    check(exactKeys(row, q.columns), 'ROW_INVALID');
    const out = {};
    for (const column of q.columns) { check(cell(row[column]), 'VALUE_INVALID'); out[column] = row[column]; }
    return Object.freeze(out);
  }));
}

function parse(json, queries) {
  check(exactKeys(json, ['result', 'errors', 'messages', 'success']), 'ENVELOPE_INVALID');
  check(json.success === true && Array.isArray(json.errors) && json.errors.length === 0 && Array.isArray(json.messages) && json.messages.length === 0, 'ENVELOPE_INVALID');
  check(Array.isArray(json.result) && json.result.length === queries.length, 'RESULT_COUNT');
  const run = rowsOf(json.result[0], queries[0], ROW_LIMITS.run);
  const journal = rowsOf(json.result[1], queries[1], ROW_LIMITS.journal);
  const tables = {};
  let total = 0;
  IMPORT_TABLES.forEach((table, i) => {
    tables[table] = rowsOf(json.result[i + 2], queries[i + 2], ROW_LIMITS.tables);
    total += tables[table].length;
    check(total <= ROW_LIMITS.tables, 'ROW_LIMIT');
  });
  const extra = queries.length > 9 ? { schema: rowsOf(json.result[9], queries[9], ROW_LIMITS.schema) } : {};
  return Object.freeze({ private: true, run, journal, tables: Object.freeze(tables), ...extra, ...SAFETY, identityVerified: false, transportProven: false });
}

async function transport(fetchImpl, endpoint, token, body, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false, response = null, reader = null, pending = null;
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new ReadbackError(timedOut ? 'TIMEOUT' : 'BODY_OVERSIZE')), { once: true }));
  aborted.catch(() => {});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    pending = Promise.resolve().then(() => fetchImpl(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body, redirect: 'error', cache: 'no-store', signal: controller.signal,
    }));
    try { response = await Promise.race([pending, aborted]); } catch (error) { fail(OWN.has(error) ? error.code : 'FETCH_FAILED'); }
    check(response !== null && typeof response === 'object', 'FETCH_FAILED');
    check(response.redirected !== true && (response.url === undefined || response.url === '' || response.url === endpoint), 'REDIRECTED');
    check(Number.isSafeInteger(response.status) && response.status >= 200 && response.status <= 299, 'HTTP_STATUS');
    const type = response.headers?.get?.('content-type');
    check(typeof type === 'string' && /^application\/json\s*(;.*)?$/i.test(type), 'CONTENT_TYPE');
    check(response.body && typeof response.body.getReader === 'function', 'BODY_INVALID');
    const parts = [];
    let total = 0;
    try {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        // Intrinsic typed-array slots only (as r2-s3): subclasses/Proxies cannot fake length; private copy.
        let part = null;
        try {
          check(TA_TAG.call(value) === 'Uint8Array', 'BODY_INVALID');
          total += TA_BYTE_LENGTH.call(value);
          if (total <= MAX_RESPONSE_BYTES) { part = new Uint8Array(TA_BYTE_LENGTH.call(value)); TA_SET.call(part, value); }
        } catch { fail('BODY_INVALID'); }
        if (total > MAX_RESPONSE_BYTES) { controller.abort(); fail('BODY_OVERSIZE'); }
        parts.push(part);
      }
    } catch (error) {
      if (reader) quiet(() => reader.cancel());
      throw OWN.has(error) ? error : new ReadbackError('BODY_INVALID');
    } finally {
      if (reader) quiet(() => reader.releaseLock());
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); } catch { return fail('BODY_INVALID'); }
  } finally {
    clearTimeout(timer);
    // Registered after we gave up: a fetch settling late (or any time) that is not ours gets its body discarded.
    pending?.then((late) => { if (late !== response) discardBody(late); }, () => {});
    if (response !== null && reader === null) discardBody(response); // early status/redirect/type exits
  }
}

export function createD1Readback(options) {
  try {
    const o = plainArgs(options, ['descriptor', 'token', 'fetchImpl'], ['timeoutMs', 'includeSchema', 'permit']);
    check(typeof o.fetchImpl === 'function', 'FETCH_REQUIRED');
    check(typeof o.token === 'string' && o.token.length >= 20 && o.token.length <= 4096 && TOKEN.test(o.token), 'TOKEN_INVALID');
    const timeoutMs = Object.hasOwn(o, 'timeoutMs') ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
    check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS, 'TIMEOUT_INVALID');
    const includeSchema = Object.hasOwn(o, 'includeSchema') ? o.includeSchema : false;
    check(typeof includeSchema === 'boolean', 'INPUT_INVALID');
    let snapshot;
    try { snapshot = Object.freeze(plainArgs(o.descriptor, null)); } catch { fail('DESCRIPTOR_INVALID'); }
    check(Object.values(snapshot).every((v) => typeof v === 'string' || typeof v === 'number'), 'DESCRIPTOR_INVALID');
    if (snapshot.profile === 'synthetic') {
      check(!Object.hasOwn(o, 'permit'), 'INPUT_INVALID');
    } else {
      check(snapshot.profile === 'real-data' && Object.hasOwn(o, 'permit'), 'PROFILE_BLOCKED');
      check(isPermitClaimed(o.permit) && !isPermitSpent(o.permit), 'PERMIT_INVALID');
    }
    const { fetchImpl } = o, token = o.token;
    const queries = includeSchema ? [...READBACK_QUERIES, SCHEMA_QUERY] : READBACK_QUERIES;
    const body = JSON.stringify({ batch: queries.map((q) => ({ sql: q.sql, params: [] })) });
    const state = { busy: false, halted: false, lastMs: null };

    async function attempt(input) {
      const { now } = plainArgs(input, ['now']);
      check(typeof now === 'string' && ISO.test(now), 'NOW_INVALID');
      const v = validated(snapshot, now); // frozen snapshot; caller object never re-read
      const nowMs = Date.parse(now);
      check(state.lastMs === null || nowMs >= state.lastMs, 'NOW_NOT_MONOTONE');
      state.lastMs = nowMs;
      const checkPermit = () => {
        if (v.descriptor.profile === 'real-data') {
          try { validatePermitRequest(o.permit, v.descriptor, now); } catch (error) {
            if (error?.code === 'DESCRIPTOR_EXPIRED') fail('DESCRIPTOR_EXPIRED');
            fail('PERMIT_INVALID');
          }
        } else check(v.descriptor.profile === 'synthetic', 'PROFILE_BLOCKED');
      };
      checkPermit();
      const endpoint = ENDPOINT_ORIGIN + ENDPOINT_PATH(v.descriptor.accountId, v.descriptor.databaseId);
      // Recheck at actual dispatch too, closing a finishPermitRun call before queued fetch runs.
      const requestFetch = v.descriptor.profile === 'real-data' ? (...args) => { checkPermit(); return fetchImpl(...args); } : fetchImpl;
      return parse(await transport(requestFetch, endpoint, token, body, timeoutMs), queries);
    }
    async function read(input) {
      if (state.busy) { state.halted = true; fail('BUSY'); } // concurrent use is a caller bug: halt
      check(!state.halted, 'HALTED');
      state.busy = true;
      try { return await attempt(input); } catch (error) {
        state.halted = true;
        throw safeError(error);
      } finally { state.busy = false; }
    }
    return Object.freeze({ read });
  } catch (error) { throw safeError(error); }
}
