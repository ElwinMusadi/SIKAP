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
//     interpolated into SQL. Transport v2: every non-guard statement binds EXACTLY ONE string
//     param, the canonical JSON.stringify of its value array, read slot-by-slot in static SQL via
//     json_extract(?1, '$[i]') (seed delete: json_each(?1)); guards bind none. decodeStatement is
//     the single strict inverse. Remote acceptance, multi-statement atomicity and changes() guards
//     remain UNPROVEN on the remote transport (transportProven:false).
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

export const CORE_VERSION = 2;
export const TRANSPORT = 'd1-rest-json-row-string-param-v2';
export const DESCRIPTOR_FORMAT = 'sikap-remote-import-descriptor';
// Internal conservative policy, not platform limits. bodyBytes = UTF-8 of JSON.stringify({batch})
// (the actual wire incl. double JSON escaping); statements/parameters/values count the whole
// request incl. CAS/guards/journal/checkpoint. parameters = WIRE string params (1 per non-guard
// statement); values = decoded logical values (seed delete counts 1), preserving v1 density.
// rows is a core policy cap per chunk (rows normally bound earlier by values/bytes).
export const LIMITS = Object.freeze({ bodyBytes: 64 * 1024, statementBytes: 100_000, statements: 32, parameters: 100, values: 100, rows: 64 });
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
// Static JSON-row slot reader: the ONLY placeholder is the numbered ?1 (one string param per
// statement), repeated per slot; slot indexes are module constants, never values.
const slot = (index) => `json_extract(?1, '$[${index}]')`;
const slots = (count) => Array.from({ length: count }, (_, index) => slot(index)).join(', ');
// CAS binding read from slots offset..offset+9 (prev hash nullable: IS, never =).
const runBind = (o) => `id = 1 AND run_nonce = ${slot(o)} AND owner_nonce = ${slot(o + 1)} AND epoch = ${slot(o + 2)} AND target_binding_sha256 = ${slot(o + 3)} AND plan_sha256 = ${slot(o + 4)} AND stage = ${slot(o + 5)} AND cursor = ${slot(o + 6)} AND ordinal = ${slot(o + 7)} AND claim_seq = ${slot(o + 8)} AND last_chunk_sha256 IS ${slot(o + 9)} AND complete = 0`;
// Stable target/content identity: excludes runNonce/ownerNonce/epoch/expiresAt (takeover keeps it).
const BINDING_KEYS = Object.freeze(['accountId', 'databaseId', 'databaseName', 'bucket', 'profile', 'snapshotId', 'sourceSha256', 'planSha256', 'appSchemaSha256', 'ledgerSchemaSha256', 'baselineSha256', 'policySha256', 'retentionPolicySha256']);
const EPOCH_PARAMS = 3; // claim, journal, checkpoint each carry epoch once (digits are never escaped)
const MAX_EPOCH_DIGITS = String(Number.MAX_SAFE_INTEGER).length;
export const SQL = deepFreeze({
  claim: `UPDATE ${LEDGER.runTable} SET claim_seq = ${slot(0)} WHERE ${runBind(1)}`,
  guard: "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('') END AS sikap_import_guard",
  seedDelete: 'DELETE FROM jenis_dokumen_wajib WHERE jenis_dokumen_id IN (SELECT value FROM json_each(?1))',
  journal: `INSERT INTO ${LEDGER.journalTable} (${LEDGER.journalColumns.join(', ')}) VALUES (${slots(LEDGER.journalColumns.length)})`,
  checkpoint: `UPDATE ${LEDGER.runTable} SET stage = ${slot(0)}, cursor = ${slot(1)}, ordinal = ${slot(2)}, last_chunk_sha256 = ${slot(3)} WHERE ${runBind(4)}`,
  insert: Object.fromEntries(IMPORT_TABLES.map((table) => {
    const columns = COLUMNS[table];
    let sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${slots(columns.length)})`;
    // Reviewed seed semantics: jenis upsert only; everything else plain INSERT (never REPLACE).
    if (table === 'jenis_dokumen') sql += ` ON CONFLICT(id) DO UPDATE SET ${columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`;
    return [table, sql];
  })),
});
// Decoded logical value count per statement kind (seedDelete: variable non-empty id list).
export const SQL_ARITY = deepFreeze({
  claim: 11, guard: 0, seedDelete: null, journal: LEDGER.journalColumns.length, checkpoint: 14,
  insert: Object.fromEntries(IMPORT_TABLES.map((table) => [table, COLUMNS[table].length])),
});
export const STATEMENT_KINDS = Object.freeze(['claim', 'guard', 'seedDelete', 'insert', 'journal', 'checkpoint']);
// Exact SQL allowlist: sql text -> { kind, table, arity }. Unknown SQL is never interpreted.
const SPECS = new Map([
  [SQL.claim, Object.freeze({ kind: 'claim', table: null, arity: SQL_ARITY.claim })],
  [SQL.guard, Object.freeze({ kind: 'guard', table: null, arity: 0 })],
  [SQL.seedDelete, Object.freeze({ kind: 'seedDelete', table: null, arity: null })],
  [SQL.journal, Object.freeze({ kind: 'journal', table: null, arity: SQL_ARITY.journal })],
  [SQL.checkpoint, Object.freeze({ kind: 'checkpoint', table: null, arity: SQL_ARITY.checkpoint })],
  ...IMPORT_TABLES.map((table) => [SQL.insert[table], Object.freeze({ kind: 'insert', table, arity: SQL_ARITY.insert[table] })]),
]);

export const ERROR_CODES = Object.freeze([
  'INPUT_INVALID', 'NOW_INVALID', 'DESCRIPTOR_SHAPE', 'DESCRIPTOR_FIELD_INVALID', 'DESCRIPTOR_TARGET_DENIED',
  'DESCRIPTOR_EXPIRED', 'DESCRIPTOR_EXPIRY_TOO_LONG', 'TABLES_INVALID', 'ROW_INVALID', 'VALUE_INVALID',
  'KEY_INVALID', 'DUPLICATE_KEY', 'ROW_LIMIT', 'ROWS_DO_NOT_FIT', 'ARTIFACT_UNKNOWN', 'CHUNK_MISMATCH',
  'STATE_INVALID', 'STATEMENT_INVALID', 'INTERNAL',
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

// Distinct bound params of a template: every placeholder must be exactly the numbered `?1`
// (no bare `?`, `?2`, `?12`, `:name`, `@x` or `$x` binders); guards have none.
const boundParams = (sql) => {
  const marks = [...sql.matchAll(/\?\d*/g)].map((match) => match[0]);
  check(marks.every((mark) => mark === '?1') && !/[:@]\w|\$[A-Za-z_]/.test(sql.replace(/'[^']*'/g, '')), 'INTERNAL');
  return marks.length > 0 ? 1 : 0;
};
for (const [sql, spec] of SPECS) check(boundParams(sql) === (spec.kind === 'guard' ? 0 : 1), 'INTERNAL');

const cellOk = (value) => value === null ||
  (typeof value === 'string' ? value.length <= MAX_VALUE_CHARS && !value.includes('\0') && value.isWellFormed() : Number.isSafeInteger(value) && !Object.is(value, -0));

// Strict inverse of the v2 wire encoding for ONE statement {sql, params}. Accepts only the exact
// SQL allowlist, a plain own-data shape (no getter is run) and the single canonical JSON string
// param; returns frozen { kind, table, values } with values in v1 positional order. Every
// rejection is STATEMENT_INVALID; it never echoes input. The param text is bounded by the body
// cap BEFORE parsing (a fitting request can never carry a longer param).
export const decodeStatement = guarded((raw) => {
  const s = plain(raw, ['sql', 'params'], 'STATEMENT_INVALID');
  const spec = typeof s.sql === 'string' ? SPECS.get(s.sql) : undefined;
  check(spec !== undefined, 'STATEMENT_INVALID');
  const params = plainArray(s.params, 1, 'STATEMENT_INVALID');
  if (spec.kind === 'guard') {
    check(params.length === 0, 'STATEMENT_INVALID');
    return deepFreeze({ kind: spec.kind, table: null, values: [] });
  }
  check(params.length === 1 && typeof params[0] === 'string' && params[0].length <= LIMITS.bodyBytes, 'STATEMENT_INVALID');
  const text = params[0];
  let values;
  try { values = JSON.parse(text); } catch { fail('STATEMENT_INVALID'); }
  check(Array.isArray(values), 'STATEMENT_INVALID');
  if (spec.arity === null) {
    // Seed delete: non-empty list of unique non-empty id strings.
    check(values.length > 0 && values.length <= ARTIFACT_LIMITS.rows, 'STATEMENT_INVALID');
    check(values.every((id) => typeof id === 'string' && id.length > 0 && cellOk(id)) && new Set(values).size === values.length, 'STATEMENT_INVALID');
  } else {
    check(values.length === spec.arity && values.every(cellOk), 'STATEMENT_INVALID');
  }
  // Canonical only (after the flat-cell check, so no nested structure is re-serialized): rejects
  // whitespace, -0, 1.0/1e0, alternate string escapes and any other non-JSON.stringify spelling.
  check(JSON.stringify(values) === text, 'STATEMENT_INVALID');
  return deepFreeze({ kind: spec.kind, table: spec.table, values });
});

const statement = (sql, values) => {
  const spec = SPECS.get(sql);
  check(spec !== undefined, 'INTERNAL');
  return { sql, params: spec.kind === 'guard' ? (check(values.length === 0, 'INTERNAL'), []) : [JSON.stringify(values)] };
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
  // Logical statement: { sql, kind, table, values } (values = v1 positional order). Encoded once.
  const op = (sql, values) => ({ sql, ...SPECS.get(sql), values });
  const build = (stage, start, end, seed) => {
    const table = IMPORT_TABLES[stage], rows = tables[table], ordinal = chunks.length;
    const nextStage = end === rows.length ? stage + 1 : stage, nextCursor = end === rows.length ? 0 : end;
    const dataOps = [...seed, ...rows.slice(start, end).map((values) => op(SQL.insert[table], [...values]))];
    const data = dataOps.map((o) => statement(o.sql, o.values));
    // Digest over the exact v2 wire statements (sql + string params) of the data part.
    const dataDigest = sha256(JSON.stringify(data.map((s) => [s.sql, s.params])));
    // Plan-relative identity: excludes epoch/owner/run nonce so a takeover keeps chunk hashes.
    const chunkSha256 = sha256(JSON.stringify(['sikap-import-chunk', CORE_VERSION, TRANSPORT, target, ordinal, stage, table, start, end, previous, dataDigest]));
    const bind = [runNonce, ownerNonce, epoch, target, planSha256, stage, start, ordinal];
    const ops = [
      op(SQL.claim, [ordinal + 1, ...bind, ordinal, previous]),
      op(SQL.guard, []),
      ...dataOps,
      op(SQL.journal, [runNonce, epoch, target, ordinal, stage, table, start, end, chunkSha256]),
      op(SQL.checkpoint, [nextStage, nextCursor, ordinal + 1, chunkSha256, ...bind, ordinal + 1, previous]),
      op(SQL.guard, []),
    ];
    const batch = [...ops.slice(0, 2).map((o) => statement(o.sql, o.values)), ...data, ...ops.slice(-3).map((o) => statement(o.sql, o.values))];
    const valueCount = ops.reduce((sum, o) => sum + (o.kind === 'seedDelete' ? 1 : o.values.length), 0);
    const parameterCount = batch.reduce((sum, s) => sum + s.params.length, 0);
    const bodyBytes = utf8Bytes(JSON.stringify({ batch }));
    // Size against the widest possible epoch so a takeover (new epoch) cannot change boundaries.
    // Epoch digits are plain ASCII inside the JSON param (never escaped): +1 wire byte per digit.
    const fits = valueCount <= LIMITS.values && parameterCount <= LIMITS.parameters && batch.length <= LIMITS.statements && end - start <= LIMITS.rows &&
      bodyBytes + epochSlack <= LIMITS.bodyBytes && batch.every((s) => utf8Bytes(s.sql) <= LIMITS.statementBytes);
    return { fits, ops, chunk: { ordinal, stage, table, startCursor: start, endCursor: end, nextStage, nextCursor, rowCount: end - start, prevChunkSha256: previous, chunkSha256, statementCount: batch.length, valueCount, parameterCount, bodyBytes, batch } };
  };
  // Self-check: the chosen chunk must round-trip through the public decoder to exactly the
  // logical values it was built from; any mismatch is an internal defect, never a send.
  const verifyChunk = (chunk, expected) => {
    try {
      check(chunk.batch.length === expected.length, 'INTERNAL');
      chunk.batch.forEach((s, index) => {
        const decoded = decodeStatement(s), want = expected[index];
        check(decoded.kind === want.kind && decoded.table === want.table && decoded.values.length === want.values.length &&
          decoded.values.every((value, k) => Object.is(value, want.values[k])), 'INTERNAL');
      });
    } catch { fail('INTERNAL'); }
  };
  for (let stage = 0; stage < IMPORT_TABLES.length; stage++) {
    const rows = tables[IMPORT_TABLES[stage]];
    let cursor = 0;
    do {
      // Stage 0 first chunk removes only the matrix rows of imported jenis ids (no-op skipped).
      const seed = stage === 0 && cursor === 0 && seedIds.length ? [op(SQL.seedDelete, [...seedIds])] : [];
      let best = null;
      if (cursor === rows.length) {
        const candidate = build(stage, cursor, cursor, seed);
        if (candidate.fits) best = candidate;
      } else {
        for (let end = cursor + 1; end <= rows.length; end++) {
          const candidate = build(stage, cursor, end, seed);
          if (!candidate.fits) break;
          best = candidate;
        }
      }
      check(best !== null, 'ROWS_DO_NOT_FIT');
      verifyChunk(best.chunk, best.ops);
      best = best.chunk;
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
  let statements = 0, maxBodyBytes = 0, maxParameters = 0, maxValues = 0;
  for (const chunk of artifact.chunks) {
    rowsPerTable[chunk.table] += chunk.rowCount;
    statements += chunk.statementCount;
    maxBodyBytes = Math.max(maxBodyBytes, chunk.bodyBytes);
    maxParameters = Math.max(maxParameters, chunk.parameterCount);
    maxValues = Math.max(maxValues, chunk.valueCount);
  }
  return deepFreeze({
    coreVersion: CORE_VERSION, chunkCount: artifact.chunkCount, rowCount: artifact.rowCount, rowsPerTable,
    statementCount: statements, maxBodyBytes, maxParameters, maxValues, ...SAFETY, semanticValidationRequired: true,
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
