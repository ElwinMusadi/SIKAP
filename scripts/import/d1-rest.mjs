// SIKAP D1 REST one-shot request adapter (local-tested with injected fetch).
//
// - Each adapter instance sends AT MOST ONE request (one known core chunk, by identity) and is then
//   halted forever, whatever the outcome. No retry, no resume, no ordinal progression, no full run.
// - Synthetic requests are unchanged; real-data requires a claimed in-process UAT permit.
//   Full descriptor binding and permit lifecycle are revalidated before dispatch; no profile boolean
//   alone enables real-data. Supplying a permit to the synthetic path is rejected.
// - An accepted HTTP response does NOT prove commit/atomicity: every outcome requires an independent
//   ledger read-back (READBACK_REQUIRED). transportProven/pilotAllowed/readyForImport stay false.
// - Caller must inject fetchImpl explicitly (no global fetch default). Token lives only in this
//   closure; it is never returned, logged, or stored elsewhere. No env/FS/child process access.
// - Outputs are counts/flags/closed codes only: no SQL, params, ids, digests, headers or bodies.
// - Wire contract (core TRANSPORT v2): body {batch:[{sql, params}]}, params is [] (guards) or one
//   canonical JSON string; every statement is decoded via core decodeStatement (exact SQL allowlist).
import { COLUMNS, SAFETY, LIMITS, TRANSPORT, CORE_VERSION, ImportCoreError, validateDescriptor, summarize, decodeStatement, compileChunks } from './core.mjs';
import { validatePermitRequest } from './real-data-gate.mjs';

export const ADAPTER_VERSION = 2;
export const ENDPOINT_ORIGIN = 'https://api.cloudflare.com';
export const ENDPOINT_PATH = (accountId, databaseId) => `/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const GUARD_ROW = Object.freeze({ sikap_import_guard: 1 });
const FLAGS = Object.freeze({ localTestingOnly: true, transportProven: false, pilotAllowed: false, authorizesRetry: false, requiresReadBack: true, ...SAFETY, readyForImport: false, remoteAuthorized: false });

export const D1_ADAPTER_ERROR_CODES = Object.freeze([
  'INPUT_INVALID', 'TOKEN_INVALID', 'FETCH_REQUIRED', 'TIMEOUT_INVALID', 'NOW_INVALID', 'NOW_NOT_MONOTONE',
  'DESCRIPTOR_INVALID', 'DESCRIPTOR_EXPIRED', 'DESCRIPTOR_TARGET_DENIED', 'PROFILE_BLOCKED', 'ARTIFACT_UNKNOWN',
  'ARTIFACT_BINDING_MISMATCH', 'CHUNK_UNKNOWN', 'ADAPTER_SPENT', 'PERMIT_REQUIRED', 'PERMIT_INVALID', 'INTERNAL',
]);
export const AMBIGUOUS_REASONS = Object.freeze([
  'FETCH_FAILED', 'TIMEOUT', 'RESPONSE_INVALID', 'REDIRECTED', 'HTTP_STATUS', 'CONTENT_TYPE', 'BODY_OVERSIZE',
  'BODY_INVALID', 'ENVELOPE_INVALID', 'RESULT_COUNT', 'RESULT_INVALID', 'GUARD_INVALID', 'META_INVALID',
]);
const CODES = new Set(D1_ADAPTER_ERROR_CODES), REASONS = new Set(AMBIGUOUS_REASONS), OWN = new WeakSet();
export class D1AdapterError extends Error {
  constructor(code) {
    const safe = CODES.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'D1AdapterError';
    this.code = safe;
    OWN.add(this);
  }
}
const fail = (code) => { throw new D1AdapterError(code); };
const check = (ok, code) => { if (!ok) fail(code); };
class Ambiguous { constructor(reason) { this.reason = REASONS.has(reason) ? reason : 'RESPONSE_INVALID'; } }
const amb = (reason) => { throw new Ambiguous(reason); };
const need = (ok, reason) => { if (!ok) amb(reason); };

// Own enumerable data properties only; exact required keys plus optional ones; getters never run.
function plainArgs(value, required, optional = []) {
  try {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'INPUT_INVALID');
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, 'INPUT_INVALID');
    const own = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]), out = {};
    check(own.every((k) => typeof k === 'string' && allowed.has(k)) && required.every((k) => own.includes(k)), 'INPUT_INVALID');
    for (const key of own) {
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      check(Object.hasOwn(d, 'value') && d.enumerable === true, 'INPUT_INVALID');
      out[key] = d.value;
    }
    return out;
  } catch (error) { if (OWN.has(error)) throw error; throw new D1AdapterError('INPUT_INVALID'); }
}

function validated(descriptor, now) {
  try { return validateDescriptor(descriptor, now); } catch (error) {
    const code = error instanceof ImportCoreError ? error.code : 'INTERNAL';
    if (code === 'NOW_INVALID' || code === 'DESCRIPTOR_EXPIRED' || code === 'DESCRIPTOR_TARGET_DENIED') fail(code);
    fail('DESCRIPTOR_INVALID');
  }
}

const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const JENIS_ID = COLUMNS.jenis_dokumen.indexOf('id');
// Decode every statement of every chunk (exact SQL allowlist + canonical JSON + arity/cell checks in
// core), then re-derive the fixed layout and bound CAS/journal values from the validated descriptor.
function verifyArtifact(artifact, v) {
  try { summarize(artifact); } catch { fail('ARTIFACT_UNKNOWN'); }
  check(artifact.coreVersion === CORE_VERSION && artifact.transport === TRANSPORT && artifact.chunks.length > 0, 'ARTIFACT_BINDING_MISMATCH');
  let decoded;
  try { decoded = artifact.chunks.map((c) => c.batch.map((s) => decodeStatement(s))); } catch { fail('ARTIFACT_BINDING_MISMATCH'); }
  const { runNonce, ownerNonce, epoch, planSha256 } = v.descriptor, target = v.targetBindingSha256;
  // Seed delete must list exactly every jenis_dokumen id imported anywhere in the artifact (global).
  const jenisIds = artifact.chunks.flatMap((c, i) => decoded[i].filter((d) => d.kind === 'insert' && d.table === 'jenis_dokumen').map((d) => d.values[JENIS_ID]));
  const ok = artifact.chunks.every((c, i) => {
    const b = c.batch, d = decoded[i], n = b.length, prev = i === 0 ? null : artifact.chunks[i - 1].chunkSha256;
    const bind = [runNonce, ownerNonce, epoch, target, planSha256, c.stage, c.startCursor, i];
    const data = d.slice(2, n - 3);
    const seed = data[0]?.kind === 'seedDelete' ? 1 : 0;
    const wire = b.reduce((sum, s) => sum + s.params.length, 0);
    const values = d.reduce((sum, s) => sum + (s.kind === 'seedDelete' ? 1 : s.values.length), 0);
    return c.ordinal === i && c.statementCount === n && n >= 5 && n <= LIMITS.statements && Object.is(c.prevChunkSha256, prev) &&
      c.bodyBytes === Buffer.byteLength(JSON.stringify({ batch: b }), 'utf8') && c.bodyBytes <= LIMITS.bodyBytes &&
      c.parameterCount === wire && wire <= LIMITS.parameters && c.valueCount === values && values <= LIMITS.values &&
      d[0].kind === 'claim' && same(d[0].values, [i + 1, ...bind, i, prev]) &&
      d[1].kind === 'guard' && d[n - 1].kind === 'guard' &&
      d[n - 3].kind === 'journal' && same(d[n - 3].values, [runNonce, epoch, target, i, c.stage, c.table, c.startCursor, c.endCursor, c.chunkSha256]) &&
      d[n - 2].kind === 'checkpoint' && same(d[n - 2].values, [c.nextStage, c.nextCursor, i + 1, c.chunkSha256, ...bind, i + 1, prev]) &&
      seed === (i === 0 && jenisIds.length > 0 ? 1 : 0) && (seed === 0 || (c.startCursor === 0 && same(data[0].values, jenisIds))) &&
      data.slice(seed).every((s) => s.kind === 'insert' && s.table === c.table) && data.length - seed === c.rowCount;
  });
  check(ok, 'ARTIFACT_BINDING_MISMATCH');
}

// Bounded plain JSON (meta only); validated for shape, never reflected.
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

function verifyEnvelope(json, chunk) {
  need(exactKeys(json, ['result', 'errors', 'messages', 'success']), 'ENVELOPE_INVALID');
  need(json.success === true && Array.isArray(json.errors) && json.errors.length === 0 && Array.isArray(json.messages) && json.messages.length === 0, 'ENVELOPE_INVALID');
  need(Array.isArray(json.result) && json.result.length === chunk.statementCount, 'RESULT_COUNT');
  const n = chunk.statementCount;
  json.result.forEach((r, i) => {
    need(exactKeys(r, ['success', 'results'], ['meta']) && r.success === true && Array.isArray(r.results), 'RESULT_INVALID');
    // meta is shape-bounded only and never read as commit proof: REST documents meta.changes as
    // cumulative sqlite3_total_changes(), so its value is not compared. In-SQL guards + read-back rule.
    if (Object.hasOwn(r, 'meta')) need(r.meta !== null && typeof r.meta === 'object' && !Array.isArray(r.meta) && boundedJson(r.meta, 0), 'META_INVALID');
    if (i === 1 || i === n - 1) {
      need(r.results.length === 1 && exactKeys(r.results[0], ['sikap_import_guard']) && r.results[0].sikap_import_guard === 1, 'GUARD_INVALID');
    } else need(r.results.length === 0, 'RESULT_INVALID');
  });
}

const httpCategory = (s) => (s === 401 || s === 403 ? 'AUTH' : s === 429 ? 'RATE_LIMITED' : s >= 500 ? 'SERVER' : s >= 400 ? 'CLIENT' : s >= 300 ? 'REDIRECT' : s >= 200 ? 'SUCCESS' : 'INFORMATIONAL');
// Best-effort, never awaited, never throws: a hanging or throwing cancel cannot block or leak.
function quiet(fn) {
  try { const p = fn(); if (p && typeof p.then === 'function') p.then(undefined, () => {}); } catch { /* swallowed */ }
}
function discardBody(response) {
  quiet(() => {
    const b = response?.body;
    if (b && typeof b.cancel === 'function' && b.locked !== true) return b.cancel();
    return undefined;
  });
}
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function createD1RestAdapter(options) {
  try {
    const o = plainArgs(options, ['descriptor', 'artifact', 'token', 'fetchImpl', 'now'], ['timeoutMs', 'permit']);
    check(typeof o.fetchImpl === 'function', 'FETCH_REQUIRED');
    check(typeof o.token === 'string' && o.token.length >= 20 && o.token.length <= 4096 && TOKEN.test(o.token), 'TOKEN_INVALID');
    const timeoutMs = Object.hasOwn(o, 'timeoutMs') ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
    check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS, 'TIMEOUT_INVALID');
    const v = validated(o.descriptor, o.now);
    if (v.descriptor.profile === 'synthetic') {
      check(!Object.hasOwn(o, 'permit'), 'INPUT_INVALID');
    } else if (v.descriptor.profile === 'real-data') {
      check(Object.hasOwn(o, 'permit') && o.permit !== null && typeof o.permit === 'object', 'PROFILE_BLOCKED');
      try {
        const granted = validatePermitRequest(o.permit, v.descriptor, o.now);
        // A registered core artifact alone is insufficient: it could contain arbitrary rows
        // compiled under the same descriptor. Bind actual batches to the permit's tables.
        verifyArtifact(o.artifact, v);
        const expected = compileChunks({ tables: granted.tables }, v.descriptor, { now: o.now });
        check(JSON.stringify(o.artifact.chunks) === JSON.stringify(expected.chunks), 'ARTIFACT_BINDING_MISMATCH');
      } catch (error) {
        if (OWN.has(error)) throw error;
        if (error?.code === 'DESCRIPTOR_EXPIRED') fail('DESCRIPTOR_EXPIRED');
        fail('PERMIT_INVALID');
      }
    } else {
      fail('PROFILE_BLOCKED');
    }
    verifyArtifact(o.artifact, v);
    const { artifact, fetchImpl } = o, token = o.token, createdMs = Date.parse(o.now);
    const endpoint = ENDPOINT_ORIGIN + ENDPOINT_PATH(v.descriptor.accountId, v.descriptor.databaseId);
    const state = { sent: 0, halted: false, outcome: null, reason: null, httpCategory: null };

    const summary = () => Object.freeze({ adapterVersion: ADAPTER_VERSION, oneShot: true, chunkCount: artifact.chunkCount, sentCount: state.sent,
      halted: state.halted, outcome: state.outcome, reason: state.reason, httpCategory: state.httpCategory, ...FLAGS });

    async function send(input) {
      check(!state.halted, 'ADAPTER_SPENT');
      state.halted = true; // synchronous: concurrent/second calls are refused; pre-fetch failures also spend it
      const { chunk, now } = plainArgs(input, ['chunk', 'now']);
      check(typeof now === 'string' && ISO.test(now), 'NOW_INVALID');
      check(Date.parse(now) >= createdMs, 'NOW_NOT_MONOTONE');
      const again = validated(v.descriptor, now); // frozen snapshot; caller object never re-read
      check(again.targetBindingSha256 === v.targetBindingSha256, 'DESCRIPTOR_INVALID');
      if (again.descriptor.profile === 'synthetic') {
        check(again.descriptor.profile === 'synthetic', 'PROFILE_BLOCKED');
      } else if (again.descriptor.profile === 'real-data') {
        check(Object.hasOwn(o, 'permit') && o.permit !== null && typeof o.permit === 'object', 'PROFILE_BLOCKED');
        try {
          validatePermitRequest(o.permit, again.descriptor, now);
        } catch (error) {
          if (error?.code === 'DESCRIPTOR_EXPIRED') fail('DESCRIPTOR_EXPIRED');
          fail('PERMIT_INVALID');
        }
      } else {
        fail('PROFILE_BLOCKED');
      }
      check(artifact.chunks.includes(chunk), 'CHUNK_UNKNOWN');
      const body = JSON.stringify({ batch: chunk.batch });
      check(Buffer.byteLength(body, 'utf8') === chunk.bodyBytes, 'ARTIFACT_BINDING_MISMATCH');

      const base = { ordinal: chunk.ordinal, statementCount: chunk.statementCount, bodyBytes: chunk.bodyBytes, halted: true };
      const controller = new AbortController();
      let timedOut = false, status = null;
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Ambiguous(timedOut ? 'TIMEOUT' : 'BODY_OVERSIZE')), { once: true }));
      aborted.catch(() => {});
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let response = null, reader = null, finished = false;
      try {
        const pending = Promise.resolve().then(() => {
          if (v.descriptor.profile === 'real-data') {
            try { validatePermitRequest(o.permit, v.descriptor, now); } catch { fail('PERMIT_INVALID'); }
          }
          state.sent = 1;
          return fetchImpl(endpoint, {
            method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body, redirect: 'error', cache: 'no-store', signal: controller.signal,
          });
        });
        // A fetch that settles after we already gave up (timeout) gets its body discarded, never read.
        pending.then((late) => { if (finished && late !== response) discardBody(late); }, () => {});
        try {
          response = await Promise.race([pending, aborted]);
        } catch (error) { amb(error instanceof Ambiguous ? error.reason : 'FETCH_FAILED'); }
        need(response !== null && typeof response === 'object', 'RESPONSE_INVALID');
        need(response.redirected !== true && (response.url === undefined || response.url === '' || response.url === endpoint), 'REDIRECTED');
        if (Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599) status = response.status;
        need(status !== null, 'RESPONSE_INVALID');
        state.httpCategory = httpCategory(status);
        need(status >= 200 && status <= 299, 'HTTP_STATUS');
        const type = response.headers?.get?.('content-type');
        need(typeof type === 'string' && /^application\/json\s*(;.*)?$/i.test(type), 'CONTENT_TYPE');
        need(response.body && typeof response.body.getReader === 'function', 'BODY_INVALID');
        const parts = [];
        let total = 0;
        try {
          reader = response.body.getReader();
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done) break;
            need(value instanceof Uint8Array, 'BODY_INVALID');
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) { controller.abort(); amb('BODY_OVERSIZE'); }
            parts.push(value);
          }
        } catch (error) {
          if (reader) quiet(() => reader.cancel());
          throw error instanceof Ambiguous ? error : new Ambiguous('BODY_INVALID');
        } finally {
          if (reader) quiet(() => reader.releaseLock());
        }
        let json;
        try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); } catch { amb('BODY_INVALID'); }
        verifyEnvelope(json, chunk);
        state.outcome = 'RESPONSE_ACCEPTED';
        return Object.freeze({ status: 'RESPONSE_ACCEPTED', reason: null, nextAction: 'READBACK_REQUIRED', httpCategory: state.httpCategory, httpStatus: status, ...base, ...FLAGS });
      } catch (error) {
        state.outcome = 'AMBIGUOUS';
        state.reason = error instanceof Ambiguous ? error.reason : 'RESPONSE_INVALID';
        return Object.freeze({ status: 'AMBIGUOUS', reason: state.reason, nextAction: 'READBACK_REQUIRED', httpCategory: state.httpCategory, httpStatus: status, ...base, ...FLAGS });
      } finally {
        finished = true;
        clearTimeout(timer);
        if (response !== null && reader === null) discardBody(response); // early HTTP/redirect/type exits
      }
    }
    return Object.freeze({ send, summary });
  } catch (error) { if (OWN.has(error)) throw error; throw new D1AdapterError('INTERNAL'); }
}
