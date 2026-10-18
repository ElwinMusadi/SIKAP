// Remote importer PURE core (local only). Compiles canonical plan tables into candidate
// parameterized D1 REST batch chunks and classifies resume observations.
//
// Scope and limits (read before using any output):
//   * No filesystem, environment, network, process spawn, clock or CLI. Imports node:crypto and
//     two static contract modules only. `now` is always an explicit ISO argument.
//   * Descriptor validation is SYNTAX + static denylist only. It proves no target existence,
//     identity, emptiness, schema, pepper/runtime proof or approval. Nothing here authorizes a
//     network request: every report carries remoteAuthorized/readyForImport = false and
//     proofRequired = true.
//   * compileChunks accepts tables that are ALREADY canonical (every COLUMNS key present, SQL
//     defaults materialized, e.g. via apply-local canonicalRow after validatePlan). It checks
//     structure/types/limits/primary keys only. Business validation (validatePlan), the raw plan
//     bytes vs descriptor.planSha256/sourceSha256, schema/ledger DDL and target state are separate
//     gates of a future adapter: semanticValidationRequired/planHashVerified flags say so.
//   * The returned artifact is PRIVATE: params contain PII and password hashes. Never print or
//     log it; use summarize() for counts/flags only. SQL text is static; no value is ever
//     interpolated into SQL. The request shape, typed null/number params, multi-statement
//     atomicity and changes() guards are UNPROVEN on the remote transport (transportProven:false).
//   * Ledger table/column names below are a prospective contract; no DDL exists yet. A future
//     reviewed ledger DDL must match them exactly.
//   * classifyResume never authorizes a resend or retry. Uncertain outcomes stop for an operator.
//   * Descriptor expiry is checked ONLY at compile time against the caller's `now`. A compiled
//     artifact carries no live lease: any future adapter must re-validate the descriptor (expiry,
//     target, binding) per call/request with a fresh `now`. No real adapter exists in this module.
//   * Primary keys are type-strict per schema column (KEY_TYPES): TEXT keys must be non-empty
//     strings and INTEGER keys numbers, so 1 vs '1' can never alias one SQLite key. Values are
//     never coerced or normalized.
import { createHash } from 'node:crypto';
import { ARTIFACT_LIMITS, IMPORT_TABLES } from '../migrate/contract.mjs';
import { UAT_ACCOUNT, UAT_DB } from '../staging/uat-constants.mjs';

export const CORE_VERSION = 1;
export const TRANSPORT = 'd1-rest-parameterized-batch-candidate-v1';
export const DESCRIPTOR_FORMAT = 'sikap-remote-import-descriptor';
// Internal conservative policy, not platform limits. bodyBytes = UTF-8 of JSON.stringify({batch});
// parameters/statements count the whole request incl. CAS/guards/journal/checkpoint; rows is a
// core policy cap per chunk (rows normally bound earlier by parameters/bytes).
export const LIMITS = Object.freeze({ bodyBytes: 64 * 1024, statementBytes: 100_000, statements: 32, parameters: 100, rows: 64 });
export const MAX_VALUE_CHARS = 16_384;
export const MAX_DESCRIPTOR_TTL_MS = 4 * 60 * 60 * 1000;
export const SAFETY = Object.freeze({ remoteAuthorized: false, readyForImport: false, proofRequired: true, authorizesExecution: false });

// Copy of apply-local COLUMNS (importing it would pull fs I/O); tests pin equality.
export const COLUMNS = deepFreeze({
  jenis_dokumen: 'id nama kategori urutan aktif max_size_bytes updated_at'.split(' '),
  jenis_dokumen_wajib: 'jenis_dokumen_id status_kepegawaian'.split(' '),
  pegawai: 'id nip nik nama role status_akun status_kepegawaian pangkat_kode tmt_pangkat jabatan jenis_jabatan tmt_jabatan unit_id tempat_lahir tanggal_lahir jenis_kelamin agama pendidikan_kode status_pernikahan golongan_darah no_hp email alamat foto_r2_key created_at updated_at deleted_at deleted_by purge_after'.split(' '),
  akun: 'pegawai_id password_hash is_default_password failed_attempts locked_until password_changed_at last_login_at'.split(' '),
  arsip_dokumen: 'id pegawai_id jenis_dokumen_id status r2_key file_name mime_type size_bytes sha256 versi catatan_admin uploaded_at uploaded_by verified_at verified_by deleted_at purge_after'.split(' '),
  arsip_dokumen_riwayat: 'id arsip_id pegawai_id jenis_dokumen_id versi aksi status catatan actor_id created_at'.split(' '),
  log_aktivitas: 'id ts actor_id actor_nip actor_nama actor_role action target_type target_id description result ip'.split(' '),
});
// Copy of apply-local PRIMARY (tests pin equality).
export const PRIMARY = deepFreeze(Object.fromEntries(IMPORT_TABLES.map((table) => [table, table === 'akun' ? ['pegawai_id'] : table === 'jenis_dokumen_wajib' ? [...COLUMNS[table]] : ['id']])));
// Declared type of every PRIMARY column in migrations/0001_init.sql (tests pin it).
export const KEY_TYPES = deepFreeze({
  jenis_dokumen: { id: 'text' }, jenis_dokumen_wajib: { jenis_dokumen_id: 'text', status_kepegawaian: 'text' },
  pegawai: { id: 'integer' }, akun: { pegawai_id: 'integer' }, arsip_dokumen: { id: 'integer' },
  arsip_dokumen_riwayat: { id: 'integer' }, log_aktivitas: { id: 'integer' },
});

// Known non-import targets (copy of staging BASELINE_DENY plus UAT/probe/local; tests pin it).
// The name/bucket patterns already exclude them; the explicit list is defence in depth.
export const DENY = deepFreeze({
  databaseIds: ['b8611b82-8067-4153-ae5e-d6a0b94be7a6', '1bd39313-4072-43a7-a183-7544c8264c46', UAT_DB, '95f86a58-578b-44ac-9016-8472522e8be4', '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  databaseNames: ['sikap-db', 'sikap-db-preview', 'sikap-uat-db', 'sikap-uat-tx-probe', 'sikap-tx-probe-local-repro', 'sikap-migration-local'],
  buckets: ['sikap-files', 'sikap-files-preview', 'sikap-backup', 'sikap-backup-preview', 'sikap-uat-files', 'sikap-uat-backup', 'sikap-migration-local-files'],
});
export const ALLOWED_ACCOUNT_IDS = Object.freeze([UAT_ACCOUNT]);

export const LEDGER = deepFreeze({
  runTable: '__sikap_import_v1_run',
  runColumns: ['id', 'run_nonce', 'owner_nonce', 'epoch', 'target_binding_sha256', 'plan_sha256', 'stage', 'cursor', 'ordinal', 'claim_seq', 'last_chunk_sha256', 'complete'],
  journalTable: '__sikap_import_v1_journal',
  journalColumns: ['run_nonce', 'epoch', 'target_binding_sha256', 'ordinal', 'stage', 'table_name', 'start_cursor', 'end_cursor', 'chunk_sha256'],
  // Future reviewed DDL MUST declare UNIQUE(run_nonce, ordinal); the journal INSERT is plain (no
  // OR IGNORE/REPLACE), so a duplicate ordinal aborts the whole candidate request.
  journalUniqueKey: ['run_nonce', 'ordinal'],
});
const RUN_BIND = 'id = 1 AND run_nonce = ? AND owner_nonce = ? AND epoch = ? AND target_binding_sha256 = ? AND plan_sha256 = ? AND stage = ? AND cursor = ? AND ordinal = ? AND claim_seq = ? AND last_chunk_sha256 IS ? AND complete = 0';
// Stable target/content identity: excludes runNonce/ownerNonce/epoch/expiresAt (takeover keeps it).
const BINDING_KEYS = Object.freeze(['accountId', 'databaseId', 'databaseName', 'bucket', 'profile', 'snapshotId', 'sourceSha256', 'planSha256', 'appSchemaSha256', 'ledgerSchemaSha256', 'baselineSha256', 'policySha256', 'retentionPolicySha256']);
const EPOCH_PARAMS = 3; // claim, journal, checkpoint each bind epoch once
const MAX_EPOCH_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
export const SQL = deepFreeze({
  claim: `UPDATE ${LEDGER.runTable} SET claim_seq = ? WHERE ${RUN_BIND}`,
  guard: "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('') END AS sikap_import_guard",
  seedDelete: 'DELETE FROM jenis_dokumen_wajib WHERE jenis_dokumen_id IN (SELECT value FROM json_each(?))',
  journal: `INSERT INTO ${LEDGER.journalTable} (${LEDGER.journalColumns.join(', ')}) VALUES (${LEDGER.journalColumns.map(() => '?').join(', ')})`,
  checkpoint: `UPDATE ${LEDGER.runTable} SET stage = ?, cursor = ?, ordinal = ?, last_chunk_sha256 = ? WHERE ${RUN_BIND}`,
  insert: Object.fromEntries(IMPORT_TABLES.map((table) => {
    const columns = COLUMNS[table];
    let sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    // Reviewed seed semantics: jenis upsert only; everything else plain INSERT (never REPLACE).
    if (table === 'jenis_dokumen') sql += ` ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
    return [table, sql];
  })),
});

export const ERROR_CODES = Object.freeze([
  'INPUT_INVALID', 'NOW_INVALID', 'DESCRIPTOR_SHAPE', 'DESCRIPTOR_FIELD_INVALID', 'DESCRIPTOR_TARGET_DENIED',
  'DESCRIPTOR_EXPIRED', 'DESCRIPTOR_EXPIRY_TOO_LONG', 'TABLES_INVALID', 'ROW_INVALID', 'VALUE_INVALID',
  'KEY_INVALID', 'DUPLICATE_KEY', 'ROW_LIMIT', 'ROWS_DO_NOT_FIT', 'ARTIFACT_UNKNOWN', 'CHUNK_MISMATCH',
  'STATE_INVALID', 'INTERNAL',
]);
const CODE_SET = new Set(ERROR_CODES);
const OWN_ERRORS = new WeakSet();
// Closed-code error: message === code; never carries input values.
export class ImportCoreError extends Error {
  constructor(code) {
    const safe = typeof code === 'string' && CODE_SET.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'ImportCoreError';
    this.code = safe;
    OWN_ERRORS.add(this);
  }
}
const fail = (code) => { throw new ImportCoreError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
function guarded(fn) {
  return (...args) => {
    try { return fn(...args); } catch (error) {
      if (OWN_ERRORS.has(error)) throw error;
      throw new ImportCoreError('INTERNAL');
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
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const utf8Bytes = (text) => Buffer.byteLength(text, 'utf8');

// Snapshot a plain data object with EXACTLY `keys` (own, enumerable, data properties; no symbols,
// getters, inherited or extra keys). Values are read once from descriptors; getters never run.
function plain(value, keys, code) {
  try {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), code);
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, code);
    const own = Reflect.ownKeys(value);
    check(own.length === keys.length, code);
    const out = {};
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      check(descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true, code);
      out[key] = descriptor.value;
    }
    return out;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    throw new ImportCoreError(code);
  }
}
function plainArray(value, max, code) {
  try {
    check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, code);
    const own = Reflect.ownKeys(value);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    check(Number.isSafeInteger(length) && length <= max && own.length === length + 1, code);
    const out = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      check(descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true, code);
      out.push(descriptor.value);
    }
    return out;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    throw new ImportCoreError(code);
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isoMs(value, code) {
  check(typeof value === 'string' && ISO.test(value), code);
  const ms = Date.parse(value);
  check(Number.isFinite(ms) && new Date(ms).toISOString() === value, code);
  return ms;
}

const HEX32 = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMPORT_NAME = /^sikap-import-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESCRIPTOR_KEYS = Object.freeze(['format', 'version', 'accountId', 'databaseId', 'databaseName', 'bucket', 'profile', 'snapshotId', 'sourceSha256', 'planSha256', 'appSchemaSha256', 'ledgerSchemaSha256', 'baselineSha256', 'policySha256', 'retentionPolicySha256', 'runNonce', 'ownerNonce', 'epoch', 'expiresAt']);
const HASH_KEYS = ['sourceSha256', 'planSha256', 'appSchemaSha256', 'ledgerSchemaSha256', 'baselineSha256', 'policySha256', 'retentionPolicySha256'];
const nonZero = (text) => /[^0]/.test(text);

// Syntax + static denylist validation of a private target descriptor. Case is canonical
// (lowercase); variants are rejected, never normalized. Validity NEVER authorizes network.
export const validateDescriptor = guarded((raw, now) => {
  const nowMs = isoMs(now, 'NOW_INVALID');
  const d = plain(raw, DESCRIPTOR_KEYS, 'DESCRIPTOR_SHAPE');
  const field = (condition) => check(condition, 'DESCRIPTOR_FIELD_INVALID');
  field(d.format === DESCRIPTOR_FORMAT && d.version === 1);
  field(typeof d.accountId === 'string' && HEX32.test(d.accountId));
  field(typeof d.databaseId === 'string' && UUID.test(d.databaseId) && typeof d.snapshotId === 'string' && UUID.test(d.snapshotId));
  for (const key of ['databaseName', 'bucket']) field(typeof d[key] === 'string' && d[key].length <= 63);
  field(d.profile === 'synthetic' || d.profile === 'real-data');
  for (const key of HASH_KEYS) field(typeof d[key] === 'string' && SHA.test(d[key]) && nonZero(d[key]));
  for (const key of ['runNonce', 'ownerNonce']) field(typeof d[key] === 'string' && HEX32.test(d[key]) && nonZero(d[key]));
  field(d.runNonce !== d.ownerNonce && Number.isSafeInteger(d.epoch) && d.epoch >= 0 && !Object.is(d.epoch, -0));
  const expiresMs = isoMs(d.expiresAt, 'DESCRIPTOR_FIELD_INVALID');
  check(!DENY.databaseIds.includes(d.databaseId) && !DENY.databaseNames.includes(d.databaseName) && !DENY.buckets.includes(d.bucket), 'DESCRIPTOR_TARGET_DENIED');
  check(ALLOWED_ACCOUNT_IDS.includes(d.accountId) && IMPORT_NAME.test(d.databaseName) && IMPORT_NAME.test(d.bucket), 'DESCRIPTOR_TARGET_DENIED');
  check(expiresMs > nowMs, 'DESCRIPTOR_EXPIRED');
  check(expiresMs - nowMs <= MAX_DESCRIPTOR_TTL_MS, 'DESCRIPTOR_EXPIRY_TOO_LONG');
  const targetBindingSha256 = sha256(JSON.stringify(['sikap-import-target', CORE_VERSION, ...BINDING_KEYS.map((key) => d[key])]));
  return deepFreeze({
    descriptor: d, targetBindingSha256, descriptorSyntaxValid: true, existenceVerified: false, identityVerified: false,
    planHashVerified: false, sourceHashVerified: false, ...SAFETY,
  });
});

function readTables(raw) {
  const tables = plain(raw, IMPORT_TABLES, 'TABLES_INVALID');
  const out = {};
  let total = 0;
  for (const table of IMPORT_TABLES) {
    const rows = plainArray(tables[table], ARTIFACT_LIMITS.rows, 'TABLES_INVALID');
    total += rows.length;
    check(total <= ARTIFACT_LIMITS.rows, 'ROW_LIMIT');
    const columns = COLUMNS[table], keyIndexes = PRIMARY[table].map((column) => columns.indexOf(column));
    const keyTypes = PRIMARY[table].map((column) => KEY_TYPES[table][column]);
    const seen = new Set();
    out[table] = rows.map((rawRow) => {
      const row = plain(rawRow, columns, 'ROW_INVALID');
      const values = columns.map((column) => {
        const value = row[column];
        if (value === null) return null;
        if (typeof value === 'string') {
          check(value.length <= MAX_VALUE_CHARS && !value.includes('\0') && value.isWellFormed(), 'VALUE_INVALID');
          return value;
        }
        check(Number.isSafeInteger(value) && !Object.is(value, -0), 'VALUE_INVALID');
        return value;
      });
      const key = keyIndexes.map((index) => values[index]);
      // Type-strict, never coerced: TEXT key = non-empty string, INTEGER key = number (already a
      // safe integer above). Blocks 1 vs '1' aliasing under SQLite column affinity.
      check(key.every((value, i) => (keyTypes[i] === 'text' ? typeof value === 'string' && value.length > 0 : typeof value === 'number')), 'KEY_INVALID');
      const identity = JSON.stringify(key);
      check(!seen.has(identity), 'DUPLICATE_KEY');
      seen.add(identity);
      return values;
    });
  }
  return out;
}

const placeholders = (sql) => (sql.match(/\?/g) ?? []).length;
const statement = (sql, params) => {
  check(placeholders(sql) === params.length, 'INTERNAL');
  return { sql, params };
};
const ARTIFACTS = new WeakMap();

// Pure deterministic compiler: canonical tables + validated descriptor -> private candidate chunks.
// Each chunk is ONE candidate atomic request: claim CAS, guard, [seed delete], data inserts,
// journal insert, checkpoint CAS, guard. Rows keep the caller's canonical plan order.
export const compileChunks = guarded((input, rawDescriptor, options) => {
  const { now } = plain(options, ['now'], 'INPUT_INVALID');
  const { descriptor, targetBindingSha256: target } = validateDescriptor(rawDescriptor, now);
  const { tables: rawTables } = plain(input, ['tables'], 'TABLES_INVALID');
  const tables = readTables(rawTables);
  const { runNonce, ownerNonce, epoch, planSha256 } = descriptor;
  const epochSlack = EPOCH_PARAMS * (MAX_EPOCH_DIGITS - String(epoch).length);
  const seedIds = tables.jenis_dokumen.map((values) => values[0]);
  const chunks = [];
  let previous = null;
  const build = (stage, start, end, seed) => {
    const table = IMPORT_TABLES[stage], rows = tables[table], ordinal = chunks.length;
    const nextStage = end === rows.length ? stage + 1 : stage, nextCursor = end === rows.length ? 0 : end;
    const data = [...seed, ...rows.slice(start, end).map((values) => statement(SQL.insert[table], [...values]))];
    const dataDigest = sha256(JSON.stringify(data.map((s) => [s.sql, s.params])));
    // Plan-relative identity: excludes epoch/owner/run nonce so a takeover keeps chunk hashes.
    const chunkSha256 = sha256(JSON.stringify(['sikap-import-chunk', CORE_VERSION, TRANSPORT, target, ordinal, stage, table, start, end, previous, dataDigest]));
    const bind = [runNonce, ownerNonce, epoch, target, planSha256, stage, start, ordinal];
    const batch = [
      statement(SQL.claim, [ordinal + 1, ...bind, ordinal, previous]),
      statement(SQL.guard, []),
      ...data,
      statement(SQL.journal, [runNonce, epoch, target, ordinal, stage, table, start, end, chunkSha256]),
      statement(SQL.checkpoint, [nextStage, nextCursor, ordinal + 1, chunkSha256, ...bind, ordinal + 1, previous]),
      statement(SQL.guard, []),
    ];
    const parameterCount = batch.reduce((sum, s) => sum + s.params.length, 0);
    const bodyBytes = utf8Bytes(JSON.stringify({ batch }));
    // Size against the widest possible epoch so a takeover (new epoch) cannot change boundaries.
    const fits = parameterCount <= LIMITS.parameters && batch.length <= LIMITS.statements && end - start <= LIMITS.rows &&
      bodyBytes + epochSlack <= LIMITS.bodyBytes && batch.every((s) => utf8Bytes(s.sql) <= LIMITS.statementBytes);
    return { fits, chunk: { ordinal, stage, table, startCursor: start, endCursor: end, nextStage, nextCursor, rowCount: end - start, prevChunkSha256: previous, chunkSha256, statementCount: batch.length, parameterCount, bodyBytes, batch } };
  };
  for (let stage = 0; stage < IMPORT_TABLES.length; stage++) {
    const rows = tables[IMPORT_TABLES[stage]];
    let cursor = 0;
    do {
      // Stage 0 first chunk removes only the matrix rows of imported jenis ids (no-op skipped).
      const seed = stage === 0 && cursor === 0 && seedIds.length ? [statement(SQL.seedDelete, [JSON.stringify(seedIds)])] : [];
      let best = null;
      if (cursor === rows.length) {
        const candidate = build(stage, cursor, cursor, seed);
        if (candidate.fits) best = candidate.chunk;
      } else {
        for (let end = cursor + 1; end <= rows.length; end++) {
          const candidate = build(stage, cursor, end, seed);
          if (!candidate.fits) break;
          best = candidate.chunk;
        }
      }
      check(best !== null, 'ROWS_DO_NOT_FIT');
      chunks.push(best);
      previous = best.chunkSha256;
      cursor = best.endCursor;
    } while (cursor < rows.length);
  }
  const artifact = deepFreeze({
    coreVersion: CORE_VERSION, transport: TRANSPORT, limits: LIMITS, ...SAFETY,
    semanticValidationRequired: true, schemaRequired: true, planHashVerified: false, sourceHashVerified: false,
    transportProven: false, privateArtifact: true,
    rowCount: IMPORT_TABLES.reduce((sum, table) => sum + tables[table].length, 0),
    chunkCount: chunks.length, chunks,
  });
  ARTIFACTS.set(artifact, Object.freeze({ runNonce, ownerNonce, epoch, planSha256, targetBindingSha256: target }));
  return artifact;
});

// Public-safe report: counts, limits and flags only. No SQL, params, ids, hashes or nonces.
export const summarize = guarded((artifact) => {
  check(ARTIFACTS.has(artifact), 'ARTIFACT_UNKNOWN');
  const rowsPerTable = Object.fromEntries(IMPORT_TABLES.map((table) => [table, 0]));
  let statements = 0, maxBodyBytes = 0, maxParameters = 0;
  for (const chunk of artifact.chunks) {
    rowsPerTable[chunk.table] += chunk.rowCount;
    statements += chunk.statementCount;
    maxBodyBytes = Math.max(maxBodyBytes, chunk.bodyBytes);
    maxParameters = Math.max(maxParameters, chunk.parameterCount);
  }
  return deepFreeze({
    coreVersion: CORE_VERSION, chunkCount: artifact.chunkCount, rowCount: artifact.rowCount, rowsPerTable,
    statementCount: statements, maxBodyBytes, maxParameters, ...SAFETY, semanticValidationRequired: true,
    schemaRequired: true, planHashVerified: false, transportProven: false,
  });
});

// Pure ledger simulation mirroring the CAS protocol. Confers no authority.
const STATES = new WeakMap();
function makeState(artifact, fields) {
  const binding = ARTIFACTS.get(artifact);
  const state = deepFreeze({
    stage: fields.stage, cursor: fields.cursor, ordinal: fields.ordinal, claimSeq: fields.ordinal,
    lastChunkSha256: fields.last, complete: false, allChunksApplied: fields.ordinal === artifact.chunks.length,
    epoch: binding.epoch, completeAuthorized: false, reconciliationRequired: true, ...SAFETY,
  });
  STATES.set(state, artifact);
  return state;
}
export const createState = guarded((artifact) => {
  check(ARTIFACTS.has(artifact), 'ARTIFACT_UNKNOWN');
  return makeState(artifact, { stage: 0, cursor: 0, ordinal: 0, last: null });
});
export const advanceState = guarded((state, artifact, chunk) => {
  check(STATES.has(state), 'STATE_INVALID');
  check(STATES.get(state) === artifact, 'CHUNK_MISMATCH');
  check(state.ordinal < artifact.chunks.length, 'STATE_INVALID');
  const expected = artifact.chunks[state.ordinal];
  check(chunk === expected && chunk.stage === state.stage && chunk.startCursor === state.cursor && chunk.prevChunkSha256 === state.lastChunkSha256, 'CHUNK_MISMATCH');
  return makeState(artifact, { stage: chunk.nextStage, cursor: chunk.nextCursor, ordinal: chunk.ordinal + 1, last: chunk.chunkSha256 });
});

export const RESUME_OUTCOMES = Object.freeze(['COMMITTED_OBSERVED', 'HOLD_UNCERTAIN', 'NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED', 'DIVERGED']);
const RECEIPT_KEYS = ['runNonce', 'ownerNonce', 'epoch', 'targetBindingSha256', 'planSha256', 'stage', 'cursor', 'ordinal', 'claimSeq', 'lastChunkSha256', 'complete'];
const JOURNAL_KEYS = ['runNonce', 'epoch', 'targetBindingSha256', 'ordinal', 'stage', 'tableName', 'startCursor', 'endCursor', 'chunkSha256'];
const verdict = (outcome, reason) => deepFreeze({
  outcome, reason, authorizesRetry: false, authorizesSend: false, autoResendAllowed: false,
  operatorDecisionRequired: true, ...SAFETY,
});

// Classify a read-only observation after an uncertain send of artifact.chunks[ordinal].
// Expected before/after states derive from the compiled artifact, not from caller claims.
// Booleans are caller attestations; no single flag ever authorizes a resend.
export const classifyResume = guarded((args) => {
  const a = plain(args, ['artifact', 'ordinal', 'observedReceipt', 'journal', 'exactPrefixVerified', 'writerQuiescent'], 'INPUT_INVALID');
  const binding = ARTIFACTS.get(a.artifact);
  check(binding !== undefined, 'ARTIFACT_UNKNOWN');
  const chunks = a.artifact.chunks;
  check(Number.isSafeInteger(a.ordinal) && a.ordinal >= 0 && a.ordinal < chunks.length, 'INPUT_INVALID');
  check(typeof a.exactPrefixVerified === 'boolean' && typeof a.writerQuiescent === 'boolean', 'INPUT_INVALID');
  let receipt, journal;
  try {
    receipt = plain(a.observedReceipt, RECEIPT_KEYS, 'INPUT_INVALID');
    journal = plainArray(a.journal, chunks.length, 'INPUT_INVALID').map((entry) => plain(entry, JOURNAL_KEYS, 'INPUT_INVALID'));
  } catch { return verdict('DIVERGED', 'OBSERVED_SHAPE'); }
  const n = a.ordinal, chunk = chunks[n];
  if (receipt.runNonce !== binding.runNonce || receipt.ownerNonce !== binding.ownerNonce || !Object.is(receipt.epoch, binding.epoch) ||
    receipt.targetBindingSha256 !== binding.targetBindingSha256 || receipt.planSha256 !== binding.planSha256 || receipt.complete !== 0) return verdict('DIVERGED', 'BINDING_MISMATCH');
  // Epochs: non-negative safe integers (no -0), non-decreasing along ordinals, never above the
  // binding epoch; the entry for the classified ordinal must carry exactly the binding epoch.
  let priorEpoch = 0;
  const journalOk = journal.every((entry, index) => {
    const expected = chunks[index];
    const epochOk = Number.isSafeInteger(entry.epoch) && entry.epoch >= 0 && !Object.is(entry.epoch, -0) &&
      entry.epoch >= priorEpoch && entry.epoch <= binding.epoch && (index !== n || entry.epoch === binding.epoch);
    if (epochOk) priorEpoch = entry.epoch;
    return epochOk && entry.ordinal === index && entry.runNonce === binding.runNonce && entry.targetBindingSha256 === binding.targetBindingSha256 &&
      entry.stage === expected.stage &&
      entry.tableName === expected.table && entry.startCursor === expected.startCursor && entry.endCursor === expected.endCursor &&
      entry.chunkSha256 === expected.chunkSha256;
  });
  if (!journalOk) return verdict('DIVERGED', 'JOURNAL_MISMATCH');
  const after = receipt.ordinal === n + 1 && receipt.claimSeq === n + 1 && receipt.stage === chunk.nextStage &&
    receipt.cursor === chunk.nextCursor && receipt.lastChunkSha256 === chunk.chunkSha256 && journal.length === n + 1;
  if (after) return a.exactPrefixVerified ? verdict('COMMITTED_OBSERVED', 'NEXT_ORDINAL_JOURNAL_PREFIX') : verdict('HOLD_UNCERTAIN', 'PREFIX_UNVERIFIED');
  const before = receipt.ordinal === n && receipt.claimSeq === n && receipt.stage === chunk.stage && receipt.cursor === chunk.startCursor &&
    receipt.lastChunkSha256 === chunk.prevChunkSha256 && journal.length === n;
  if (before) {
    return a.writerQuiescent && a.exactPrefixVerified
      ? verdict('NOT_COMMITTED_OBSERVED_OPERATOR_REQUIRED', 'PRIOR_STATE_QUIESCENT_PREFIX')
      : verdict('HOLD_UNCERTAIN', a.writerQuiescent ? 'PREFIX_UNVERIFIED' : 'WRITER_NOT_QUIESCENT');
  }
  return verdict('DIVERGED', 'STATE_MISMATCH');
});
