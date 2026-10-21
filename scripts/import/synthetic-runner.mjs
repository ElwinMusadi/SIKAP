// SIKAP import runner: local-tested orchestration with explicit injected transports only.
//
// Scope and limits (read before using any output):
//   * runSyntheticImport refuses real-data and permits. runPrivateUatImport requires a genuine,
//     one-run gate permit; descriptor, tables and compiled artifact come only from that permit.
//     d1FetchImpl / r2FetchImpl / nowProvider are explicit injected dependencies. No env, FS,
//     console, CLI, DDL, bootstrap, cleanup or delete. The ledger run row must already exist.
//   * Private UAT preflight checks the exact sqlite_schema fingerprint and 7 import tables + 2
//     ledger tables. It does NOT attest reference row contents, foreign_key_check, or emptiness
//     of the other operational tables; the caller's driver must check those before bootstrap.
//   * Every flag that would mean authority stays false (ready/readyForImport/remoteAuthorized/
//     transportProven). COMPLETE_SYNTHETIC_RECONCILED means a local protocol simulation passed
//     its own read-back checks; it is not schema, pepper, identity or transport proof.
//   * Booleans in the report are computed from actual read-back rows / GET bytes, never accepted
//     from the caller. Any ambiguous D1 outcome gets ONE read-only observation and stops; the
//     runner never retries, resends, resumes or attests writer quiescence (writerQuiescent:false).
//   * R2 objects written before a stop may remain (objectsMayRemain); no automatic cleanup.
//   * Inputs are snapshotted (own enumerable data properties only, bytes copied) before the first
//     await. Reports carry counts, closed codes and booleans only: no rows, keys, hashes, nonces,
//     SQL, params, tokens or provider text. Errors never escape as exceptions.
//   * The final object re-check uses a minimal signed GET defined here (signV4 from r2-s3); it
//     never issues PUT/DELETE, follows no redirect and does not retry. The runner issues no PUT
//     itself: every object (legacy and canonical) is written only via createR2S3Adapter().transfer
//     (create-only If-None-Match:* PUT + verify GET, owned by r2-s3).
//   * Object keys: legacy probe keys `migration/<snapshot>/objects/<sha>.<ext>` (archive only) and
//     transform-canonical keys `migration/<snapshot>/(document|photo)/<fileId>-<sha>.<ext>`
//     (fileId DRIVE_ID, sha must equal the bytes, ext = MIME_EXT[mime], photo never PDF). Keys are
//     matched exactly, never rewritten. Kind is derived from the key only.
import { createHash } from 'node:crypto';
import { ARTIFACT_LIMITS, IMPORT_TABLES } from '../migrate/contract.mjs';
import { DRIVE_ID, MIME_EXT } from '../migrate/normalize.mjs';
import { COLUMNS, KEY_TYPES, LEDGER, MAX_VALUE_CHARS, PRIMARY, RESUME_OUTCOMES, advanceState, classifyResume, compileChunks, createState, summarize, validateDescriptor } from './core.mjs';
import { AMBIGUOUS_REASONS, D1_ADAPTER_ERROR_CODES, createD1RestAdapter } from './d1-rest.mjs';
import { MAX_RESPONSE_BYTES, READBACK_ERROR_CODES, ROW_LIMITS, createD1Readback } from './d1-readback.mjs';
import { MAX_OBJECT_BYTES, R2_ERROR_CODES, R2_OUTCOMES, R2_REGION, R2_SERVICE, createR2S3Adapter, signV4 } from './r2-s3.mjs';
import { REAL_DATA_GATE_ERROR_CODES, assertPermittedObject, claimPermitForRun, finishPermitRun, getPermitTables, getPermitManifest, getPermitFile, validatePermitRequest } from './real-data-gate.mjs';

export const RUNNER_VERSION = 1;
export const MAX_OBJECTS = 1000;
export const MAX_TOTAL_OBJECT_BYTES = 64 * 1024 * 1024;
export const MAX_RUNNER_TIMEOUT_MS = 60_000;
export const RUNNER_STATUSES = Object.freeze([
  'COMPLETE_SYNTHETIC_RECONCILED', 'COMPLETE_UAT_RECONCILED', 'STOPPED_BUSY', 'STOPPED_INPUT_INVALID', 'STOPPED_PROFILE_BLOCKED',
  'STOPPED_CLOCK_INVALID', 'STOPPED_DESCRIPTOR_EXPIRED', 'STOPPED_PREFLIGHT_MISMATCH', 'STOPPED_READBACK_FAILED',
  'STOPPED_R2_FAILED', 'STOPPED_D1_SEND_REFUSED', 'STOPPED_D1_AMBIGUOUS', 'STOPPED_D1_STATE_MISMATCH',
  'STOPPED_FINAL_OBJECT_MISMATCH', 'STOPPED_FINAL_STATE_MISMATCH', 'STOPPED_INTERNAL',
]);
const OWN_REASONS = [
  'ARGS_INVALID', 'TABLES_INVALID', 'BASELINE_INVALID', 'OBJECTS_INVALID', 'TIMEOUT_INVALID', 'FETCH_REQUIRED',
  'NOW_PROVIDER_REQUIRED', 'NOW_INVALID', 'NOW_NOT_MONOTONE', 'DESCRIPTOR_INVALID', 'ARTIFACT_UNKNOWN',
  'ARTIFACT_MISMATCH', 'BASELINE_HASH_MISMATCH', 'BASELINE_NOT_SEED_ONLY', 'PLAN_CONFLICTS_BASELINE',
  'OBJECT_MISSING', 'OBJECT_METADATA_MISMATCH', 'OBJECT_UNREFERENCED', 'OBJECT_REF_UNSUPPORTED', 'PHOTO_UNSUPPORTED', 'RUN_MISSING',
  'RUN_MISMATCH', 'JOURNAL_MISMATCH', 'ROWS_MISMATCH', 'FINAL_STAGE_MISMATCH', 'READBACK_SHAPE', 'GET_TIMEOUT',
  'GET_FAILED', 'GET_UNTRUSTED', 'GET_STATUS', 'GET_BODY_INVALID', 'OBJECT_MISMATCH', 'READBACK_CAPACITY', 'SCHEMA_MISMATCH', 'BUSY', 'INTERNAL',
];
export const RUNNER_REASONS = Object.freeze([...new Set([...OWN_REASONS, ...D1_ADAPTER_ERROR_CODES, ...AMBIGUOUS_REASONS,
  ...READBACK_ERROR_CODES, ...R2_ERROR_CODES, ...R2_OUTCOMES, ...REAL_DATA_GATE_ERROR_CODES])]);
const STATUS_SET = new Set(RUNNER_STATUSES), REASON_SET = new Set(RUNNER_REASONS);
const FLAGS = Object.freeze({
  ready: false, readyForImport: false, remoteAuthorized: false, transportProven: false, authorizesExecution: false,
  authorizesRetry: false, authorizesResume: false, autoCleanupAttempted: false, completeFlagSet: false,
  proofRequired: true, localSimulationOnly: true, syntheticOnly: true, semanticValidationRequired: true,
  schemaProofRequired: true, pepperProofRequired: true, identityProofRequired: true, appSchemaHashVerified: false,
  ledgerSchemaHashVerified: false, pepperVerified: false, appBindingAllowed: false,
});

class Stop { constructor(status, reason) { this.status = status; this.reason = reason; } }
const stop = (status, reason) => { throw new Stop(status, reason); };
const need = (ok, status, reason) => { if (!ok) stop(status, reason); };
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const EMPTY_SHA256 = sha256Hex(new Uint8Array(0));
const SHA = /^[0-9a-f]{64}$/;
// Reproduced by the local Miniflare test from fixed migrations 0001..0008 + ledger v1.
// This is a sqlite_schema receipt, NOT the gate's combined application-script hash.
export const UAT_EXPECTED_SCHEMA_SHA256 = '0b3e09660faa6e2e3f585fa6e4817dbf9dbdc944276f065b3bb44452cf375802';
function schemaDigest(rows) {
  const sorted = [...rows].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return sha256Hex(JSON.stringify(sorted.map((r) => [r.type, r.name, r.tbl_name, r.sql])));
}
const permitOptions = (ctx) => ctx.realMode ? { permit: ctx.permit } : {};
function gateCall(fn) {
  try { return fn(); } catch (error) {
    stop(error?.code === 'DESCRIPTOR_EXPIRED' ? 'STOPPED_DESCRIPTOR_EXPIRED' : 'STOPPED_INPUT_INVALID',
      REAL_DATA_GATE_ERROR_CODES.includes(error?.code) ? error.code : 'INTERNAL');
  }
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXT_MIME = Object.freeze({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' });
const MAGIC = Object.freeze({ 'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] });
// Same rule as apply-local magic(): 'RIFF' + LE uint32 (length - 8) + 'WEBP'.
const isWebp = (b) => b.byteLength >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 && ((b[4] | (b[5] << 8) | (b[6] << 16)) + b[7] * 0x1000000) + 8 === b.byteLength;
const magicOk = (bytes, mime) => (mime === 'image/webp' ? isWebp(bytes) : Object.hasOwn(MAGIC, mime) && MAGIC[mime].every((b, i) => bytes[i] === b));
const CANONICAL_EXT_MIME = Object.freeze(Object.fromEntries(Object.entries(MIME_EXT).map(([mime, ext]) => [ext, mime])));
const LEGACY_TAIL = /^objects\/([0-9a-f]{64})\.(pdf|jpg|jpeg|png)$/;
const CANONICAL_TAIL = /^(document|photo)\/(.+)-([0-9a-f]{64})\.([a-z]+)$/;
const MAX_KEY_CHARS = 512; // apply-local foto_r2_key cap; canonical keys are at most ~330 chars
// Pure exact key classification (no normalization). null = not a recognized key for this snapshot.
function parseKey(key, snapshotId) {
  const prefix = `migration/${snapshotId}/`;
  if (typeof key !== 'string' || key.length > MAX_KEY_CHARS || !key.startsWith(prefix)) return null;
  const tail = key.slice(prefix.length);
  const legacy = LEGACY_TAIL.exec(tail);
  if (legacy !== null) return { kind: 'legacy', fileId: null, sha256: legacy[1], mimeType: EXT_MIME[legacy[2]] };
  const c = CANONICAL_TAIL.exec(tail);
  if (c === null || !DRIVE_ID.test(c[2]) || !Object.hasOwn(CANONICAL_EXT_MIME, c[4])) return null;
  const mimeType = CANONICAL_EXT_MIME[c[4]];
  if (c[1] === 'photo' && mimeType === 'application/pdf') return null;
  return { kind: c[1], fileId: c[2], sha256: c[3], mimeType };
}
const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TA_TAG = Reflect.getOwnPropertyDescriptor(TA_PROTO, Symbol.toStringTag).get;
const TA_LEN = Reflect.getOwnPropertyDescriptor(TA_PROTO, 'byteLength').get;
const TA_SET = TA_PROTO.set;
const SEED_TABLES = new Set(['jenis_dokumen', 'jenis_dokumen_wajib']);

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
// Own enumerable DATA properties only (getters never run), exact required + optional keys.
function plain(value, required, optional, reason) {
  try {
    need(value !== null && typeof value === 'object' && !Array.isArray(value), 'STOPPED_INPUT_INVALID', reason);
    const proto = Object.getPrototypeOf(value);
    need(proto === Object.prototype || proto === null, 'STOPPED_INPUT_INVALID', reason);
    const allowed = new Set([...required, ...optional]), out = {};
    for (const key of Reflect.ownKeys(value)) {
      need(typeof key === 'string' && allowed.has(key), 'STOPPED_INPUT_INVALID', reason);
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      need(Object.hasOwn(d, 'value') && d.enumerable === true, 'STOPPED_INPUT_INVALID', reason);
      out[key] = d.value;
    }
    need(required.every((key) => Object.hasOwn(out, key)), 'STOPPED_INPUT_INVALID', reason);
    return out;
  } catch (error) { if (error instanceof Stop) throw error; return stop('STOPPED_INPUT_INVALID', reason); }
}
function plainArray(value, max, reason) {
  try {
    need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'STOPPED_INPUT_INVALID', reason);
    const length = Reflect.getOwnPropertyDescriptor(value, 'length').value;
    need(Number.isSafeInteger(length) && length <= max && Reflect.ownKeys(value).length === length + 1, 'STOPPED_INPUT_INVALID', reason);
    return Array.from({ length }, (_, i) => {
      const d = Reflect.getOwnPropertyDescriptor(value, String(i));
      need(d !== undefined && Object.hasOwn(d, 'value') && d.enumerable === true, 'STOPPED_INPUT_INVALID', reason);
      return d.value;
    });
  } catch (error) { if (error instanceof Stop) throw error; return stop('STOPPED_INPUT_INVALID', reason); }
}
const cellOk = (v) => v === null || (Number.isSafeInteger(v) && !Object.is(v, -0)) ||
  (typeof v === 'string' && v.length <= MAX_VALUE_CHARS && !v.includes('\0') && v.isWellFormed());
const identity = (table, row) => JSON.stringify(PRIMARY[table].map((c) => row[c]));
const rowJson = (table, row) => JSON.stringify(COLUMNS[table].map((c) => row[c]));

// Deep, frozen, canonical-column snapshot of 7-table input (plan tables or baseline).
function snapshotTables(raw, reason) {
  const t = plain(raw, IMPORT_TABLES, [], reason), out = {};
  let total = 0;
  for (const table of IMPORT_TABLES) {
    const rows = plainArray(t[table], ARTIFACT_LIMITS.rows, reason), seen = new Set();
    total += rows.length;
    need(total <= ARTIFACT_LIMITS.rows, 'STOPPED_INPUT_INVALID', reason);
    out[table] = Object.freeze(rows.map((rawRow) => {
      const r = plain(rawRow, COLUMNS[table], [], reason), row = {};
      for (const column of COLUMNS[table]) { need(cellOk(r[column]), 'STOPPED_INPUT_INVALID', reason); row[column] = r[column]; }
      need(PRIMARY[table].every((c) => (KEY_TYPES[table][c] === 'text' ? typeof row[c] === 'string' && row[c].length > 0 : typeof row[c] === 'number')), 'STOPPED_INPUT_INVALID', reason);
      const id = identity(table, row);
      need(!seen.has(id), 'STOPPED_INPUT_INVALID', reason);
      seen.add(id);
      return Object.freeze(row);
    }));
  }
  return Object.freeze(out);
}
const canonicalBaseline = (b) => IMPORT_TABLES.map((table) => [table, [...b[table]]
  .sort((x, y) => { const a = identity(table, x), c = identity(table, y); return a < c ? -1 : a > c ? 1 : 0; })
  .map((row) => COLUMNS[table].map((c) => row[c]))]);
const baselineDigest = (b) => sha256Hex(JSON.stringify(['sikap-import-baseline', 1, canonicalBaseline(b)]));
// Pure: digest of canonical expected baseline rows (input order irrelevant). Fixture/descriptor helper.
export function hashBaseline(baseline) {
  try { return baselineDigest(snapshotTables(baseline, 'BASELINE_INVALID')); } catch { throw new Error('BASELINE_INVALID'); }
}

function snapshotObjects(raw, snapshotId) {
  const keys = new Set();
  let total = 0;
  return Object.freeze(plainArray(raw, MAX_OBJECTS, 'OBJECTS_INVALID').map((rawObj) => {
    const o = plain(rawObj, ['key', 'bytes', 'mimeType', 'sha256'], [], 'OBJECTS_INVALID');
    let bytes;
    try {
      need(TA_TAG.call(o.bytes) === 'Uint8Array', 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID');
      const length = TA_LEN.call(o.bytes);
      need(length > 0 && length <= MAX_OBJECT_BYTES, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID');
      bytes = new Uint8Array(length);
      TA_SET.call(bytes, o.bytes);
    } catch { stop('STOPPED_INPUT_INVALID', 'OBJECTS_INVALID'); }
    total += bytes.byteLength;
    const k = parseKey(o.key, snapshotId);
    need(k !== null && k.mimeType === o.mimeType && !keys.has(o.key) && total <= MAX_TOTAL_OBJECT_BYTES, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID');
    need(typeof o.sha256 === 'string' && SHA.test(o.sha256) && sha256Hex(bytes) === o.sha256 && magicOk(bytes, o.mimeType), 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID');
    // Every key (legacy and canonical): filename hash must equal the byte hash. Keys are unique; the
    // same fileId may legitimately appear under document/ and photo/ (transform dedups by kind:fileId).
    need(k.sha256 === o.sha256, 'STOPPED_INPUT_INVALID', 'OBJECTS_INVALID');
    keys.add(o.key);
    return Object.freeze({ key: o.key, kind: k.kind, bytes, mimeType: o.mimeType, sha256: o.sha256, size: bytes.byteLength });
  }));
}

// Blob-reference columns across all 7 tables (COLUMNS): arsip_dokumen.r2_key and pegawai.foto_r2_key
// (both covered below). arsip_dokumen_riwayat/log_aktivitas/jenis/akun carry none; any future
// *r2_key column fails closed until the runner explicitly covers it.
const KNOWN_BLOB_COLUMNS = new Set(['arsip_dokumen.r2_key', 'pegawai.foto_r2_key']);
const BLOB_COLUMNS_OK = IMPORT_TABLES.every((t) => COLUMNS[t].every((c) => !/r2_key$/.test(c) || KNOWN_BLOB_COLUMNS.has(`${t}.${c}`)));
// Exact-key coverage (apply-local validatePlan semantics):
//   * non-null foto_r2_key must be a canonical photo key of this snapshot (legacy/document/other keys
//     -> PHOTO_UNSUPPORTED), present (OBJECT_MISSING) and not shared by two employees
//     (OBJECT_REF_UNSUPPORTED). pegawai has no size/mime/sha columns: integrity is key hash = byte
//     hash + magic, checked at snapshot.
//   * non-null arsip r2_key must not be a photo key (OBJECT_REF_UNSUPPORTED), must match exactly one
//     legacy/document object (OBJECT_MISSING) with equal sha/mime/size (OBJECT_METADATA_MISMATCH).
//   * every supplied object is referenced (OBJECT_UNREFERENCED).
function checkCoverage(tables, objects, snapshotId) {
  const byKey = new Map(objects.map((o) => [o.key, o])), used = new Set(), photos = new Set();
  need(BLOB_COLUMNS_OK, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_REF_UNSUPPORTED');
  for (const row of tables.pegawai) {
    if (row.foto_r2_key === null) continue;
    need(parseKey(row.foto_r2_key, snapshotId)?.kind === 'photo', 'STOPPED_PREFLIGHT_MISMATCH', 'PHOTO_UNSUPPORTED');
    const o = byKey.get(row.foto_r2_key); // same exact key => object kind is 'photo' too
    need(o !== undefined, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_MISSING');
    need(!photos.has(o.key), 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_REF_UNSUPPORTED');
    photos.add(o.key);
    used.add(o.key);
  }
  for (const row of tables.arsip_dokumen) {
    if (row.r2_key === null) continue;
    need(parseKey(row.r2_key, snapshotId)?.kind !== 'photo', 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_REF_UNSUPPORTED');
    const o = byKey.get(row.r2_key);
    need(o !== undefined, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_MISSING');
    need(row.sha256 === o.sha256 && row.mime_type === o.mimeType && row.size_bytes === o.size, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_METADATA_MISMATCH');
    used.add(o.key);
  }
  need(used.size === objects.length, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_UNREFERENCED');
}

// Permit file list is authoritative even for photos (which have no size column in pegawai).
function checkPermitObjects(ctx) {
  const manifest = gateCall(() => getPermitManifest(ctx.permit));
  need(ctx.objects.length === manifest.length, 'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_MANIFEST_MISMATCH');
  for (const o of ctx.objects) {
    const f = gateCall(() => getPermitFile(ctx.permit, o.key));
    need(f !== null && f.r2Key === o.key && f.kind === o.kind && f.mimeType === o.mimeType &&
      f.sha256 === o.sha256 && f.sizeBytes === o.size && f.fileId === parseKey(o.key, ctx.d.snapshotId)?.fileId,
    'STOPPED_PREFLIGHT_MISMATCH', 'OBJECT_MANIFEST_MISMATCH');
  }
}

function checkArtifact(artifact, tables, descriptor, now) {
  try { summarize(artifact); } catch { stop('STOPPED_PREFLIGHT_MISMATCH', 'ARTIFACT_UNKNOWN'); }
  let fresh;
  try { fresh = compileChunks({ tables }, descriptor, { now }); } catch { stop('STOPPED_INPUT_INVALID', 'TABLES_INVALID'); }
  const fields = ['ordinal', 'stage', 'table', 'startCursor', 'endCursor', 'nextStage', 'nextCursor', 'rowCount', 'prevChunkSha256', 'chunkSha256', 'statementCount', 'parameterCount', 'valueCount', 'bodyBytes'];
  need(fresh.chunkCount === artifact.chunkCount && fresh.chunks.length === artifact.chunks.length && artifact.chunks.every((c, i) =>
    fields.every((f) => Object.is(c[f], fresh.chunks[i][f])) && JSON.stringify(c.batch) === JSON.stringify(fresh.chunks[i].batch)), 'STOPPED_PREFLIGHT_MISMATCH', 'ARTIFACT_MISMATCH');
}

// Expected application rows after `k` committed chunks: baseline, chunk-0 seed delete, plan prefix.
function expectedRows(ctx, k) {
  const out = {};
  for (const table of IMPORT_TABLES) out[table] = new Map(ctx.baseline[table].map((r) => [identity(table, r), rowJson(table, r)]));
  if (k > 0 && ctx.jenisIds.size > 0) {
    for (const [id, json] of out.jenis_dokumen_wajib) if (ctx.jenisIds.has(JSON.parse(json)[0])) out.jenis_dokumen_wajib.delete(id);
  }
  for (let i = 0; i < k; i++) {
    const c = ctx.artifact.chunks[i];
    for (const row of ctx.tables[c.table].slice(c.startCursor, c.endCursor)) {
      const id = identity(c.table, row);
      if (c.table !== 'jenis_dokumen' && out[c.table].has(id)) return null; // plain INSERT would collide
      out[c.table].set(id, rowJson(c.table, row));
    }
  }
  return out;
}
const runRow = (ctx, s) => [1, ctx.d.runNonce, ctx.d.ownerNonce, ctx.d.epoch, ctx.target, ctx.d.planSha256, s.stage, s.cursor, s.ordinal, s.claimSeq, s.lastChunkSha256, 0];
const journalRow = (ctx, c) => [ctx.d.runNonce, ctx.d.epoch, ctx.target, c.ordinal, c.stage, c.table, c.startCursor, c.endCursor, c.chunkSha256];

// Read-back capacity preflight (pure, before any request). Every read-back (initial, per-chunk
// pre/post, observation, final) returns at most: baseline rows ∪ plan-prefix rows (seed deletes and
// jenis upserts only shrink/replace), journal rows for a chunk prefix, one run row. So bounding
// baseline + ALL plan rows, ALL journal rows and a worst-case run row bounds every prefix state.
// The byte estimate is the local canonical wire only: row OBJECTS in canonical column order, as
// JSON.stringify/UTF-8 would emit them, +1 separator each, plus a fixed empty envelope. It is NOT a
// remote guarantee (provider meta, whitespace or \u escaping may differ); the remaining quarter of
// MAX_RESPONSE_BYTES is a local reserve for that, not proof of fit.
export const READBACK_BUDGET_BYTES = Math.floor(0.75 * MAX_RESPONSE_BYTES);
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const READBACK_ENVELOPE_BYTES = jsonBytes({ result: Array.from({ length: IMPORT_TABLES.length + 2 }, () => ({ results: [], success: true })), errors: [], messages: [], success: true });
const keyed = (columns, values) => Object.fromEntries(columns.map((c, i) => [c, values[i]]));
function checkReadbackCapacity(ctx) {
  const chunks = ctx.artifact.chunks;
  let rows = 0;
  for (const table of IMPORT_TABLES) rows += ctx.baseline[table].length + ctx.tables[table].length;
  need(rows <= ROW_LIMITS.tables && chunks.length <= ROW_LIMITS.journal, 'STOPPED_PREFLIGHT_MISMATCH', 'READBACK_CAPACITY');
  let bytes = READBACK_ENVELOPE_BYTES;
  const add = (row) => { bytes += jsonBytes(row) + 1; need(bytes <= READBACK_BUDGET_BYTES, 'STOPPED_PREFLIGHT_MISMATCH', 'READBACK_CAPACITY'); };
  // Worst run row: per-field maxima over all states (non-negative integers: max value = max digits);
  // every non-null last_chunk_sha256 is 64 hex, so the final state's value is the widest.
  const worst = { stage: 0, cursor: 0, ordinal: 0, claimSeq: 0, lastChunkSha256: ctx.states[ctx.states.length - 1].lastChunkSha256 };
  for (const s of ctx.states) for (const f of ['stage', 'cursor', 'ordinal', 'claimSeq']) worst[f] = Math.max(worst[f], s[f]);
  add(keyed(LEDGER.runColumns, runRow(ctx, worst)));
  for (const c of chunks) add(keyed(LEDGER.journalColumns, journalRow(ctx, c)));
  // Snapshot rows are frozen objects whose keys were inserted in COLUMNS order.
  for (const table of IMPORT_TABLES) for (const list of [ctx.baseline[table], ctx.tables[table]]) for (const row of list) add(row);
}

// Compare an actual read-back with the expected state after k chunks. Returns null or a reason.
function stateMismatch(ctx, read, k) {
  if (read.run.length !== 1) return 'RUN_MISSING';
  if (JSON.stringify(LEDGER.runColumns.map((c) => read.run[0][c])) !== JSON.stringify(runRow(ctx, ctx.states[k]))) return 'RUN_MISMATCH';
  const journal = read.journal.map((r) => JSON.stringify(LEDGER.journalColumns.map((c) => r[c])));
  if (journal.length !== k || journal.some((j, i) => j !== JSON.stringify(journalRow(ctx, ctx.artifact.chunks[i])))) return 'JOURNAL_MISMATCH';
  const expected = expectedRows(ctx, k);
  for (const table of IMPORT_TABLES) {
    const rows = read.tables[table], ids = new Set(rows.map((r) => identity(table, r)));
    // Exact set equality: unique identities, same size, every row byte-equal to its expected row.
    if (ids.size !== rows.length || rows.length !== expected[table].size ||
      rows.some((r) => expected[table].get(identity(table, r)) !== rowJson(table, r))) return 'ROWS_MISMATCH';
  }
  return null;
}
const receiptOf = (r) => ({ runNonce: r.run_nonce, ownerNonce: r.owner_nonce, epoch: r.epoch, targetBindingSha256: r.target_binding_sha256, planSha256: r.plan_sha256,
  stage: r.stage, cursor: r.cursor, ordinal: r.ordinal, claimSeq: r.claim_seq, lastChunkSha256: r.last_chunk_sha256, complete: r.complete });
const journalOf = (r) => ({ runNonce: r.run_nonce, epoch: r.epoch, targetBindingSha256: r.target_binding_sha256, ordinal: r.ordinal, stage: r.stage,
  tableName: r.table_name, startCursor: r.start_cursor, endCursor: r.end_cursor, chunkSha256: r.chunk_sha256 });
// writerQuiescent is always false: the runner never attests quiescence. Core then reports a
// "before" (uncommitted-looking) state as HOLD_UNCERTAIN; COMMITTED_OBSERVED needs only the exact
// next receipt + journal + full row prefix. Neither outcome authorizes a resend here.
function classify(ctx, read, ordinal) {
  if (read.run.length !== 1) return 'DIVERGED';
  const exact = stateMismatch(ctx, read, ordinal + 1) === null || stateMismatch(ctx, read, ordinal) === null;
  try {
    return classifyResume({ artifact: ctx.artifact, ordinal, observedReceipt: receiptOf(read.run[0]), journal: read.journal.map(journalOf), exactPrefixVerified: exact, writerQuiescent: false }).outcome;
  } catch { return 'DIVERGED'; }
}

async function readback(ctx, now, includeSchema = false) {
  ctx.counts.readbacks++;
  let read;
  try {
    const reader = createD1Readback({ descriptor: ctx.d, token: ctx.d1Token, fetchImpl: ctx.d1FetchImpl, ...ctx.timeout,
      ...permitOptions(ctx), ...(includeSchema ? { includeSchema: true } : {}) });
    read = await reader.read({ now });
  } catch (error) { return stop('STOPPED_READBACK_FAILED', typeof error?.code === 'string' ? error.code : 'INTERNAL'); }
  need(read !== null && typeof read === 'object' && read.private === true && Array.isArray(read.run) && Array.isArray(read.journal) &&
    read.tables !== null && typeof read.tables === 'object' && IMPORT_TABLES.every((t) => Array.isArray(read.tables[t])), 'STOPPED_READBACK_FAILED', 'READBACK_SHAPE');
  return read;
}

// Minimal signed read-only GET (no PUT/DELETE, no retry, no redirect), bounded bytes and time.
// Best-effort, never awaited, never throws.
function quietCancel(target) {
  try { const p = target?.cancel?.(); if (p && typeof p.then === 'function') p.then(undefined, () => {}); } catch { /* ignore */ }
}
const INVALID = Symbol('invalid'), OVERSIZE = Symbol('oversize');
// Reads at most `limit` bytes. Abort cancels a stalled reader; aborted/invalid never yields bytes.
async function readCapped(body, limit, signal) {
  if (signal.aborted) { quietCancel(body); return INVALID; }
  let reader;
  try { if (!body || typeof body.getReader !== 'function') return INVALID; reader = body.getReader(); } catch { quietCancel(body); return INVALID; }
  const onAbort = () => quietCancel(reader);
  signal.addEventListener('abort', onAbort, { once: true });
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return INVALID;
      if (done) break;
      if (TA_TAG.call(value) !== 'Uint8Array') { quietCancel(reader); return INVALID; }
      total += TA_LEN.call(value);
      if (total > limit) { quietCancel(reader); return OVERSIZE; }
      const part = new Uint8Array(TA_LEN.call(value));
      TA_SET.call(part, value);
      parts.push(part);
    }
  } catch { quietCancel(reader); return INVALID; } finally {
    signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return signal.aborted ? INVALID : Buffer.concat(parts);
}
// allowMissing is private to the recovery pre-check: a trusted 404 becomes the closed marker
// OBJECT_MISSING; every final GET omits it, so a final 404 stays a GET_STATUS failure.
async function getObject(ctx, o, now, { allowMissing = false } = {}) {
  const host = `${ctx.d.accountId}.r2.cloudflarestorage.com`, canonicalUri = `/${ctx.d.bucket}/${o.key}`, url = `https://${host}${canonicalUri}`;
  const amzDate = `${now.slice(0, 4)}${now.slice(5, 7)}${now.slice(8, 10)}T${now.slice(11, 13)}${now.slice(14, 16)}${now.slice(17, 19)}Z`;
  const headers = { 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': amzDate };
  const { authorization } = signV4({ method: 'GET', canonicalUri, headers: { ...headers, host }, payloadSha256: EMPTY_SHA256, amzDate, region: R2_REGION, service: R2_SERVICE, accessKeyId: ctx.r2AccessKeyId, secretAccessKey: ctx.r2SecretAccessKey });
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve('GET_TIMEOUT'); }, ctx.timeoutMs); });
  ctx.counts.r2Gets++;
  const discard = (res) => { try { quietCancel(res?.body); } catch { /* ignore */ } };
  let accepted = null;
  let refused = null;
  const pending = Promise.resolve().then(() => {
    // Dispatch-time capability check: a permit finished after the outer tick must block this GET.
    if (ctx.realMode) {
      try { assertPermittedObject(ctx.permit, ctx.d, now, { key: o.key, sha256: o.sha256, mimeType: o.mimeType, sizeBytes: o.size }); } catch (error) {
        refused = REAL_DATA_GATE_ERROR_CODES.includes(error?.code) ? error.code : 'PERMIT_INVALID';
        throw error;
      }
    }
    return ctx.r2FetchImpl(url, { method: 'GET', headers: { ...headers, authorization }, redirect: 'error', cache: 'no-store', signal: controller.signal });
  });
  const work = pending.then(async (res) => {
    if (controller.signal.aborted) { discard(res); return 'GET_TIMEOUT'; } // late response: cancel, never read
    accepted = res;
    let trusted = false;
    try { trusted = res !== null && typeof res === 'object' && res.redirected !== true && (res.url === undefined || res.url === '' || res.url === url); } catch { /* untrusted */ }
    if (!trusted) { discard(res); return 'GET_UNTRUSTED'; }
    let status = null, mime = null, body = null;
    try { status = res.status; mime = res.headers.get('content-type'); body = res.body; } catch { /* checked below */ }
    if (allowMissing === true && status === 404) { discard(res); return 'OBJECT_MISSING'; }
    if (status !== 200) { discard(res); return 'GET_STATUS'; }
    if (typeof mime !== 'string' || mime.split(';')[0].trim().toLowerCase() !== o.mimeType) { discard(res); return 'OBJECT_MISMATCH'; }
    const bytes = await readCapped(body, o.size, controller.signal);
    if (bytes === INVALID) return controller.signal.aborted ? 'GET_TIMEOUT' : 'GET_BODY_INVALID';
    if (bytes === OVERSIZE) return 'OBJECT_MISMATCH';
    return bytes.byteLength === o.size && sha256Hex(bytes) === o.sha256 ? null : 'OBJECT_MISMATCH';
  }, () => refused ?? 'GET_FAILED').catch(() => 'GET_FAILED');
  try { return await Promise.race([work, deadline]); } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(); // also cancels a stalled body reader
    // A response that settles late (or was never accepted) gets its body cancelled, never read.
    pending.then((late) => { if (late !== accepted) discard(late); }, () => {});
  }
}

async function execute(raw, ctx) {
  // ---- synchronous snapshot of every input (before the first await) ----
  const common = ['objects', 'baseline', 'd1Token', 'r2AccessKeyId', 'r2SecretAccessKey', 'd1FetchImpl', 'r2FetchImpl', 'nowProvider'];
  const a = plain(raw, [...(ctx.realMode ? ['permit'] : ['descriptor', 'artifact', 'tables']), ...common], ['timeoutMs'], 'ARGS_INVALID');
  need(typeof a.nowProvider === 'function', 'STOPPED_INPUT_INVALID', 'NOW_PROVIDER_REQUIRED');
  need(typeof a.d1FetchImpl === 'function' && typeof a.r2FetchImpl === 'function', 'STOPPED_INPUT_INVALID', 'FETCH_REQUIRED');
  need(!Object.hasOwn(a, 'timeoutMs') || (Number.isSafeInteger(a.timeoutMs) && a.timeoutMs >= 1 && a.timeoutMs <= MAX_RUNNER_TIMEOUT_MS), 'STOPPED_INPUT_INVALID', 'TIMEOUT_INVALID');
  Object.assign(ctx, { nowProvider: a.nowProvider, d1FetchImpl: a.d1FetchImpl, r2FetchImpl: a.r2FetchImpl, d1Token: a.d1Token,
    r2AccessKeyId: a.r2AccessKeyId, r2SecretAccessKey: a.r2SecretAccessKey, timeoutMs: a.timeoutMs ?? 30_000,
    timeout: Object.hasOwn(a, 'timeoutMs') ? { timeoutMs: a.timeoutMs } : {}, lastMs: null });
  let v;
  const first = tickRaw(ctx);
  if (ctx.realMode) {
    const claimed = gateCall(() => claimPermitForRun(a.permit, { now: first }));
    ctx.permit = a.permit; // only a successful claim can be finished by this invocation
    v = claimed;
  } else {
    try { v = validateDescriptor(a.descriptor, first); } catch (error) {
      const expired = error?.code === 'DESCRIPTOR_EXPIRED';
      stop(expired ? 'STOPPED_DESCRIPTOR_EXPIRED' : 'STOPPED_INPUT_INVALID', expired ? 'DESCRIPTOR_EXPIRED' : 'DESCRIPTOR_INVALID');
    }
  }
  need(v.descriptor.profile === (ctx.realMode ? 'real-data' : 'synthetic'), 'STOPPED_PROFILE_BLOCKED', 'PROFILE_BLOCKED');
  Object.assign(ctx, { d: v.descriptor, target: v.targetBindingSha256 });
  ctx.tables = snapshotTables(ctx.realMode ? gateCall(() => getPermitTables(ctx.permit)) : a.tables, 'TABLES_INVALID');
  if (ctx.realMode) {
    try { ctx.artifact = compileChunks({ tables: ctx.tables }, ctx.d, { now: first }); } catch { stop('STOPPED_INPUT_INVALID', 'TABLES_INVALID'); }
  } else ctx.artifact = a.artifact;
  for (const table of IMPORT_TABLES) ctx.rowsPerTable[table] = ctx.tables[table].length;
  ctx.baseline = snapshotTables(a.baseline, 'BASELINE_INVALID');
  ctx.objects = snapshotObjects(a.objects, ctx.d.snapshotId);
  ctx.counts.objectsTotal = ctx.objects.length;

  // ---- preflight (no requests): baseline binding, artifact recompile, coverage, adapter construction ----
  need(baselineDigest(ctx.baseline) === ctx.d.baselineSha256, 'STOPPED_PREFLIGHT_MISMATCH', 'BASELINE_HASH_MISMATCH');
  need(IMPORT_TABLES.every((t) => SEED_TABLES.has(t) || ctx.baseline[t].length === 0), 'STOPPED_PREFLIGHT_MISMATCH', 'BASELINE_NOT_SEED_ONLY');
  checkArtifact(ctx.artifact, ctx.tables, ctx.d, first);
  ctx.counts.chunksTotal = ctx.artifact.chunkCount;
  ctx.jenisIds = new Set(ctx.tables.jenis_dokumen.map((r) => r.id));
  need(expectedRows(ctx, ctx.artifact.chunkCount) !== null, 'STOPPED_PREFLIGHT_MISMATCH', 'PLAN_CONFLICTS_BASELINE');
  checkCoverage(ctx.tables, ctx.objects, ctx.d.snapshotId);
  if (ctx.realMode) checkPermitObjects(ctx);
  ctx.states = [createState(ctx.artifact)];
  for (const chunk of ctx.artifact.chunks) ctx.states.push(advanceState(ctx.states[ctx.states.length - 1], ctx.artifact, chunk));
  checkReadbackCapacity(ctx);
  const adapterError = (fn) => { try { return fn(); } catch (error) { return stop('STOPPED_INPUT_INVALID', typeof error?.code === 'string' ? error.code : 'INTERNAL'); } };
  adapterError(() => createD1RestAdapter({ descriptor: ctx.d, artifact: ctx.artifact, token: ctx.d1Token, fetchImpl: ctx.d1FetchImpl, now: first, ...ctx.timeout, ...permitOptions(ctx) }));
  adapterError(() => createR2S3Adapter({ descriptor: ctx.d, accessKeyId: ctx.r2AccessKeyId, secretAccessKey: ctx.r2SecretAccessKey, fetchImpl: ctx.r2FetchImpl, now: first, ...ctx.timeout, ...permitOptions(ctx) }));
  ctx.phase = 'INITIAL_READ';

  // ---- initial read-only state: bootstrap run row exact, empty journal, tables exactly baseline ----
  const initial = await readback(ctx, tick(ctx), ctx.realMode);
  if (ctx.realMode) {
    need(Array.isArray(initial.schema) && schemaDigest(initial.schema) === UAT_EXPECTED_SCHEMA_SHA256,
      'STOPPED_PREFLIGHT_MISMATCH', 'SCHEMA_MISMATCH');
    ctx.schemaFingerprintVerified = true;
  }
  const initialMismatch = stateMismatch(ctx, initial, 0);
  need(initialMismatch === null, 'STOPPED_PREFLIGHT_MISMATCH', initialMismatch);
  ctx.baselineHashVerified = true;

  // ---- objects: one create-only PUT + verify GET each; any failure stops before D1 writes ----
  // Recovery entry only, two passes. Pass 1: one signed bounded GET for EVERY object; 200 with exact
  // size/hash/MIME is reused, a trusted 404 is queued; anything else (401/403/other status, mismatch,
  // timeout, untrusted) stops with zero PUTs and zero D1 requests. Pass 2: only the queued 404 objects,
  // in input order, each via a fresh tick + the normal create-only transfer.
  ctx.phase = 'OBJECTS';
  let toTransfer = ctx.objects;
  if (ctx.recoveryMode) {
    ctx.objectsMayRemain = true; // objects from the earlier stopped run already exist remotely
    const missing = [];
    for (const o of ctx.objects) {
      const pre = await getObject(ctx, o, tick(ctx), { allowMissing: true });
      if (pre === null) { ctx.counts.objectsVerified++; ctx.counts.objectsReused++; continue; }
      need(pre === 'OBJECT_MISSING', 'STOPPED_R2_FAILED', pre);
      missing.push(o);
    }
    toTransfer = missing;
  }
  for (const o of toTransfer) {
    const now = tick(ctx);
    const r2 = adapterError(() => createR2S3Adapter({ descriptor: ctx.d, accessKeyId: ctx.r2AccessKeyId, secretAccessKey: ctx.r2SecretAccessKey, fetchImpl: ctx.r2FetchImpl, now, ...ctx.timeout, ...permitOptions(ctx) }));
    ctx.objectsMayRemain = true; // conservative: a PUT may be attempted from here on
    ctx.counts.r2Transfers++;
    let result;
    try { result = await r2.transfer({ key: o.key, bytes: o.bytes, mimeType: o.mimeType, sha256: o.sha256, now }); } catch (error) {
      stop('STOPPED_R2_FAILED', typeof error?.code === 'string' ? error.code : 'INTERNAL');
    }
    need(result.outcome === (ctx.realMode ? 'OBJECT_VERIFIED_UAT' : 'OBJECT_VERIFIED_SYNTHETIC'), 'STOPPED_R2_FAILED', result.outcome);
    ctx.counts.objectsVerified++;
    if (ctx.recoveryMode) ctx.counts.objectsUploaded++;
  }

  // ---- D1 chunks: fresh exact pre-read, one one-shot send, post-read exact + classifyResume ----
  ctx.phase = 'CHUNKS';
  for (const chunk of ctx.artifact.chunks) {
    const k = chunk.ordinal;
    const pre = await readback(ctx, tick(ctx));
    const preMismatch = stateMismatch(ctx, pre, k);
    need(preMismatch === null, 'STOPPED_D1_STATE_MISMATCH', preMismatch);
    const sendNow = tick(ctx);
    const adapter = adapterError(() => createD1RestAdapter({ descriptor: ctx.d, artifact: ctx.artifact, token: ctx.d1Token, fetchImpl: ctx.d1FetchImpl, now: sendNow, ...ctx.timeout, ...permitOptions(ctx) }));
    let res;
    try { res = await adapter.send({ chunk, now: sendNow }); } catch (error) {
      ctx.counts.d1Sends += adapter.summary().sentCount;
      stop('STOPPED_D1_SEND_REFUSED', typeof error?.code === 'string' ? error.code : 'INTERNAL');
    }
    ctx.counts.d1Sends += adapter.summary().sentCount;
    if (res.status !== 'RESPONSE_ACCEPTED') {
      ctx.ambiguousOutcomeObserved = true;
      const observed = await readback(ctx, tick(ctx)); // ONE read-only observation, never a resend
      ctx.observation = classify(ctx, observed, k);
      if (ctx.observation === 'COMMITTED_OBSERVED') ctx.counts.chunksObserved = k + 1;
      stop('STOPPED_D1_AMBIGUOUS', res.reason);
    }
    const post = await readback(ctx, tick(ctx));
    const postMismatch = stateMismatch(ctx, post, k + 1);
    need(postMismatch === null, 'STOPPED_D1_STATE_MISMATCH', postMismatch);
    need(classify(ctx, post, k) === 'COMMITTED_OBSERVED', 'STOPPED_D1_STATE_MISMATCH', 'RUN_MISMATCH');
    ctx.counts.chunksObserved = k + 1;
  }
  ctx.allChunksObserved = ctx.counts.chunksObserved === ctx.artifact.chunkCount;

  // ---- final reconcile: re-GET every object, then full read-back at stage 7 / complete 0 ----
  ctx.phase = 'FINAL_OBJECTS';
  for (const o of ctx.objects) {
    const problem = await getObject(ctx, o, tick(ctx));
    need(problem === null, 'STOPPED_FINAL_OBJECT_MISMATCH', problem);
    ctx.counts.objectsRechecked++;
  }
  ctx.phase = 'FINAL_READ';
  const last = ctx.states[ctx.states.length - 1];
  need(last.stage === IMPORT_TABLES.length && last.cursor === 0, 'STOPPED_FINAL_STATE_MISMATCH', 'FINAL_STAGE_MISMATCH');
  const final = await readback(ctx, tick(ctx));
  const finalMismatch = stateMismatch(ctx, final, ctx.artifact.chunkCount);
  need(finalMismatch === null, 'STOPPED_FINAL_STATE_MISMATCH', finalMismatch);
  // Recheck the active capability and monotone clock after the final response, before success.
  if (ctx.realMode) tick(ctx);
  ctx.reconciled = true;
  ctx.phase = 'DONE';
}

// Injected clock: canonical ISO string, non-decreasing; descriptor expiry re-checked on every tick.
function tickRaw(ctx) {
  let now;
  try { now = ctx.nowProvider(); } catch { stop('STOPPED_CLOCK_INVALID', 'NOW_INVALID'); }
  need(typeof now === 'string' && ISO.test(now) && Number.isFinite(Date.parse(now)) && new Date(Date.parse(now)).toISOString() === now, 'STOPPED_CLOCK_INVALID', 'NOW_INVALID');
  need(ctx.lastMs === null || Date.parse(now) >= ctx.lastMs, 'STOPPED_CLOCK_INVALID', 'NOW_NOT_MONOTONE');
  ctx.lastMs = Date.parse(now);
  return now;
}
function tick(ctx) {
  const now = tickRaw(ctx);
  try { validateDescriptor(ctx.d, now); } catch (error) {
    stop(error?.code === 'DESCRIPTOR_EXPIRED' ? 'STOPPED_DESCRIPTOR_EXPIRED' : 'STOPPED_INPUT_INVALID', error?.code === 'DESCRIPTOR_EXPIRED' ? 'DESCRIPTOR_EXPIRED' : 'DESCRIPTOR_INVALID');
  }
  if (ctx.realMode) gateCall(() => validatePermitRequest(ctx.permit, ctx.d, now));
  return now;
}

function report(ctx, status, reason) {
  const ok = status === (ctx.realMode ? 'COMPLETE_UAT_RECONCILED' : 'COMPLETE_SYNTHETIC_RECONCILED');
  const wrote = ctx.objectsMayRemain || ctx.counts.d1Sends > 0;
  return deepFreeze({
    runnerVersion: RUNNER_VERSION, status: STATUS_SET.has(status) ? status : 'STOPPED_INTERNAL',
    reason: reason === null ? null : REASON_SET.has(reason) ? reason : 'INTERNAL', phase: ctx.phase,
    counts: { ...ctx.counts }, rowsPerTable: { ...ctx.rowsPerTable }, baselineHashVerified: ctx.baselineHashVerified,
    allChunksObserved: ok && ctx.allChunksObserved, reconciled: ok && ctx.reconciled, globalProof: false,
    ambiguousOutcomeObserved: ctx.ambiguousOutcomeObserved, observation: RESUME_OUTCOMES.includes(ctx.observation) ? ctx.observation : null,
    objectsMayRemain: ctx.objectsMayRemain, manualRecoveryRequired: !ok && wrote, ...FLAGS,
    syntheticOnly: !ctx.realMode, schemaFingerprintVerified: ctx.schemaFingerprintVerified,
    ...(ctx.recoveryMode ? { recoveryRun: true } : {}),
  });
}

let active = false;
// Both entrypoints share one busy lock; neither retries, resumes, cleans up or grants authority.
async function runImport(args, realMode, recoveryMode = false) {
  const ctx = {
    realMode, recoveryMode: realMode && recoveryMode === true, schemaFingerprintVerified: false,
    phase: 'PREFLIGHT', baselineHashVerified: false, allChunksObserved: false, reconciled: false, ambiguousOutcomeObserved: false,
    observation: null, objectsMayRemain: false, rowsPerTable: Object.fromEntries(IMPORT_TABLES.map((t) => [t, 0])),
    counts: { objectsTotal: 0, objectsVerified: 0, objectsRechecked: 0, chunksTotal: 0, chunksObserved: 0, d1Sends: 0, readbacks: 0, r2Transfers: 0, r2Gets: 0 },
  };
  if (ctx.recoveryMode) Object.assign(ctx.counts, { objectsReused: 0, objectsUploaded: 0 });
  if (active) return report(ctx, 'STOPPED_BUSY', 'BUSY');
  active = true;
  try {
    await execute(args, ctx);
    return report(ctx, realMode ? 'COMPLETE_UAT_RECONCILED' : 'COMPLETE_SYNTHETIC_RECONCILED', null);
  } catch (error) {
    return error instanceof Stop ? report(ctx, error.status, error.reason) : report(ctx, 'STOPPED_INTERNAL', 'INTERNAL');
  } finally {
    try { if (ctx.realMode && ctx.permit) finishPermitRun(ctx.permit); } finally { active = false; }
  }
}

// Never throws; returns a frozen public-safe report. Synthetic argument shape is unchanged.
export async function runSyntheticImport(args) { return runImport(args, false); }
// No caller descriptor/tables/artifact: all executable plan data is bound by the gate permit.
export async function runPrivateUatImport(args) { return runImport(args, true); }
// Operator-approved ordinal-0 object recovery: identical arguments, permit, preflight, exact state-0
// initial read, D1 flow and final checks as runPrivateUatImport. The only difference is the OBJECTS
// phase: each object is pre-checked by GET and reused when exactly verified, or uploaded create-only
// on a 404. No caller skip flag, no resume from a later ordinal, no DELETE, no retry or resend.
export async function runPrivateUatRecovery(args) { return runImport(args, true, true); }
