// D1 transaction-atomicity probe kit: PURE synthetic SQL templates and strict read analysers.
//
// Scope and limits (read before using any output):
//   * Templates target ONE future transport only: `wrangler d1 execute --remote --command`
//     (Wrangler 4.151.0 sends a --command to POST /query). They say nothing about `--file`
//     (a separate /import upload/ingest flow) or a Worker `env.DB.batch()`.
//   * Nothing here executes SQL, reads files/env/network, spawns processes, or binds a target.
//     The module CANNOT enforce the remote destination. Rendered commands are templates, never
//     authorization. Every result object carries remoteExecuted/remoteVerified/
//     transactionAtomicityVerified/readyForImport/cleanupAuthorized = false; there is no global
//     true verdict. Local Miniflare runs of these templates are binding semantics, not remote proof.
//   * CRITICAL cleanup rule: a SQL guard placed before DROP inside the same command cannot make
//     cleanup safe on the very transport whose stop-on-error/rollback behaviour is under test, so
//     the cleanup templates contain NO guard: each is a single unguarded DROP of one owned table and
//     no SQL in them enforces ownership. A future runner MUST authorize each cleanup step only after
//     an independent, separately executed read (inspect before cleanup-data, cleanup-reinspect before
//     cleanup-marker) analyses as a cleanupCandidate (exact owned schema, marker nonce/version, no
//     foreign rows) AND an explicit operator approval. Any unknown outcome stops the run: do NOT
//     auto-cleanup, do NOT retry. A foreign table, index, trigger or view means NO cleanup. Data is
//     dropped before the marker; the marker is always dropped last.
//   * Partial setup, a missing marker, a missing owned table or any other unexpected state is a MANUAL
//     STOP: no automatic repair, no cleanup retries. Disposing of the probe database itself requires a
//     separate explicit approval and is outside this kit.
import { randomBytes } from 'node:crypto';
import { BASELINE_DENY } from './uat-target.mjs';
import { UAT_ACCOUNT, UAT_DB } from './uat-constants.mjs';

export const KIT_VERSION = 1;
export const PROBE_DB_NAME = 'sikap-uat-tx-probe';
export const PROBE_PREFIX = '__sikap_uat_tx_probe';
export const MARKER_TABLE = `${PROBE_PREFIX}_marker`;
export const DATA_TABLE = `${PROBE_PREFIX}_data`;
export const TRANSPORT = 'wrangler-d1-execute-remote-command';
export const EXPECTED_WRANGLER_VERSION = '4.151.0'; // expectation only; never read from the system
export const MAX_COMMAND_BYTES = 4096;
export const MAX_STATEMENTS = 8;
export const PHASE_IDS = Object.freeze(['precondition', 'setup', 'positive', 'guard-abort', 'constraint-abort',
  'inspect', 'cleanup-data', 'cleanup-reinspect', 'cleanup-marker', 'final-precondition']);
export const SAFETY = Object.freeze({
  remoteExecuted: false, remoteVerified: false, transactionAtomicityVerified: false, readyForImport: false,
  appliesToWorkerBatch: false, appliesToFileImport: false, cleanupAuthorized: false,
  authorizesExecution: false, templatesOnly: true,
});
export const NOTICE = 'Templates only; not remote proof. The module cannot bind or enforce a remote destination. '
  + 'Cleanup templates are single unguarded DROPs: no SQL enforces ownership. Each requires an independent '
  + 'cleanupCandidate read plus explicit approval, and any unknown outcome stops without automatic cleanup.';

export class ProbeKitError extends Error {
  constructor(code) { super(code); this.name = 'ProbeKitError'; this.code = code; }
}
const fail = (code) => { throw new ProbeKitError(code); };

const NONCE_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const DENIED_DATABASE_IDS = new Set([...BASELINE_DENY.databaseIds, UAT_DB, NIL_UUID, MAX_UUID]);
const TARGET_KEYS = Object.freeze(['accountId', 'databaseName', 'databaseId']);
const MAX_ROWS = 1000;
const MAX_COUNT = 1_000_000;
const MAX_TEXT = 4096;

export const isNonce = (value) => typeof value === 'string' && NONCE_RE.test(value);
/** Convenience for a future runner; createProbeKit never generates a nonce itself. */
export const generateNonce = () => randomBytes(16).toString('hex');

// Exact own-data-property object check: no getters, symbols, inherited or extra keys.
function exactObject(value, allowed, required, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) fail(code);
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || !('value' in descriptor) || !descriptor.enumerable) fail(code);
  }
  for (const key of required) if (!keys.includes(key)) fail(code);
  return value;
}

/**
 * Descriptor SYNTAX and denylist check only for a future probe target. Never echoes input; throws
 * ProbeKitError(code). It does NOT verify that the database exists, that the UUID belongs to the
 * named database, or that it is empty, and it authorizes nothing (a config-bound UUID is not
 * identity proof; a separate control-plane identity check remains mandatory before any remote use).
 */
export function validateProbeTarget(target) {
  const t = exactObject(target, TARGET_KEYS, TARGET_KEYS, 'TARGET_SHAPE_INVALID');
  if (t.accountId !== UAT_ACCOUNT) fail('TARGET_ACCOUNT_DENIED');
  if (t.databaseName !== PROBE_DB_NAME || BASELINE_DENY.databaseNames.includes(t.databaseName)) fail('TARGET_NAME_DENIED');
  if (typeof t.databaseId !== 'string' || !UUID_RE.test(t.databaseId)) fail('TARGET_ID_INVALID');
  if (DENIED_DATABASE_IDS.has(t.databaseId)) fail('TARGET_ID_DENIED');
  return Object.freeze({ valid: true, descriptorSyntaxValid: true, existenceVerified: false, identityVerified: false,
    emptinessVerified: false, ...SAFETY });
}

// ---- Fixed SQL. Only validated 32-hex nonces and module constants are ever interpolated. ----
const SCHEMA_FILTER = "substr(name,1,7)<>'sqlite_' AND substr(name,1,4)<>'_cf_'";
export const PRECONDITION_SQL = `SELECT type,name FROM sqlite_schema WHERE ${SCHEMA_FILTER} ORDER BY type,name`;
// Also returns ANY object attached to an owned table (e.g. an index/trigger whose name hides behind the
// sqlite_/_cf_ prefixes), so it is counted as foreign and denies cleanup candidacy.
const SCHEMA_SQL = `SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE (${SCHEMA_FILTER}) `
  + `OR tbl_name IN ('${MARKER_TABLE}', '${DATA_TABLE}') ORDER BY type,name`;
export const MARKER_DDL = `CREATE TABLE ${MARKER_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), `
  + 'nonce TEXT NOT NULL CHECK (length(nonce) = 32), kit_version INTEGER NOT NULL, step INTEGER NOT NULL)';
export const DATA_DDL = `CREATE TABLE ${DATA_TABLE} (id INTEGER PRIMARY KEY, nonce TEXT NOT NULL, `
  + "phase TEXT NOT NULL CHECK (phase IN ('positive', 'fail_guard', 'fail_constraint', 'trailing')))";
// Every row the kit can ever write, by phase. Anything else in the data table is foreign.
export const OWNED_ROWS = Object.freeze({
  positive: Object.freeze([1, 2, 3]), fail_guard: Object.freeze([101, 102, 103]),
  fail_constraint: Object.freeze([201, 202]), trailing: Object.freeze([104, 203]),
});
const MARKER_KEYS = Object.freeze(['marker_rows', 'marker_owned', 'marker_step']);
const DATA_KEYS = Object.freeze(['data_total', 'data_foreign', ...Object.keys(OWNED_ROWS).map((p) => `data_${p}`)]);
const SCHEMA_KEYS = Object.freeze(['type', 'name', 'tbl_name', 'sql']);

const ownedMarker = (n) => `id = 1 AND nonce = '${n}' AND kit_version = ${KIT_VERSION}`;
const rowsIn = (phase) => `phase = '${phase}' AND id IN (${OWNED_ROWS[phase].join(', ')})`;
const ownedData = (n) => `nonce = '${n}' AND (${Object.keys(OWNED_ROWS).map((p) => `(${rowsIn(p)})`).join(' OR ')})`;
const insert = (n, phase, ids) => `INSERT INTO ${DATA_TABLE} (id, nonce, phase) VALUES ${ids.map((id) => `(${id}, '${n}', '${phase}')`).join(', ')}`;
// json('') raises "malformed JSON" only when the CASE falls through, aborting the command.
const guard = (alias, condition) => `SELECT CASE WHEN ${condition} THEN 1 ELSE json('') END AS ${alias}`;
const CLEANUP_PHASES = new Set(['cleanup-data', 'cleanup-marker']);
const CLEANUP_GATE = 'UNSAFE TO EXECUTE: single unguarded DROP, no SQL enforces ownership. Mandatory gate: an independent, '
  + 'separately executed %READ% read analysed by analyseProbeRead as cleanupCandidate AND explicit operator approval. '
  + 'Unknown outcome, partial setup, missing marker or missing table: manual stop, no automatic repair, cleanup or retry. '
  + 'Disposing of the probe database requires separate explicit approval.';

function phaseSpecs(n) {
  const markerAgg = [`(SELECT count(*) FROM ${MARKER_TABLE}) AS marker_rows`,
    `(SELECT count(*) FROM ${MARKER_TABLE} WHERE ${ownedMarker(n)}) AS marker_owned`,
    `(SELECT coalesce(max(step), -1) FROM ${MARKER_TABLE} WHERE ${ownedMarker(n)}) AS marker_step`];
  const dataAgg = [`(SELECT count(*) FROM ${DATA_TABLE}) AS data_total`,
    `(SELECT count(*) FROM ${DATA_TABLE} WHERE NOT (${ownedData(n)})) AS data_foreign`,
    ...Object.keys(OWNED_ROWS).map((p) => `(SELECT count(*) FROM ${DATA_TABLE} WHERE nonce = '${n}' AND ${rowsIn(p)}) AS data_${p}`)];
  const receipt = guard('receipt_guard', 'changes() = 1');
  return [
    ['precondition', 'read', 'Any returned object (including d1_migrations or probe residue) refuses setup.', [PRECONDITION_SQL]],
    ['setup', 'success', 'Run only after analysePrecondition(...).setupCandidate. Plain CREATE: collisions fail, never overwrite.',
      [MARKER_DDL, DATA_DDL, `INSERT INTO ${MARKER_TABLE} (id, nonce, kit_version, step) VALUES (1, '${n}', ${KIT_VERSION}, 0)`]],
    ['positive', 'success', 'Expected to commit rows 1-3 and marker step 1.',
      [insert(n, 'positive', OWNED_ROWS.positive), `UPDATE ${MARKER_TABLE} SET step = 1 WHERE ${ownedMarker(n)} AND step = 0`, receipt]],
    ['guard-abort', 'failure', 'Guard must raise; rows 101-104 must not persist.',
      [insert(n, 'fail_guard', OWNED_ROWS.fail_guard), `UPDATE ${MARKER_TABLE} SET step = 2 WHERE ${ownedMarker(n)} AND step = 99`,
        receipt, insert(n, 'trailing', [104])]],
    ['constraint-abort', 'failure', 'Self-contained duplicate id 201 must raise UNIQUE; rows 201-203 must not persist.',
      [insert(n, 'fail_constraint', OWNED_ROWS.fail_constraint), insert(n, 'fail_constraint', [201]), insert(n, 'trailing', [203])]],
    ['inspect', 'read', 'Analyse with analyseProbeRead("inspect", results). Aggregates and owned DDL comparison only.',
      [`SELECT ${[...markerAgg, ...dataAgg].join(', ')}`, SCHEMA_SQL]],
    ['cleanup-data', 'success', CLEANUP_GATE.replace('%READ%', 'inspect'), [`DROP TABLE ${DATA_TABLE}`]],
    ['cleanup-reinspect', 'read', 'Independent read after cleanup-data. Analyse with analyseProbeRead("cleanup-reinspect", results) before the marker DROP.',
      [`SELECT ${markerAgg.join(', ')}`, SCHEMA_SQL]],
    ['cleanup-marker', 'success', `${CLEANUP_GATE.replace('%READ%', 'cleanup-reinspect')} Marker is always dropped last.`,
      [`DROP TABLE ${MARKER_TABLE}`]],
    ['final-precondition', 'read', 'Must analyse as empty (setupCandidate true) after cleanup.', [PRECONDITION_SQL]],
  ];
}

const FORBIDDEN = /\b(BEGIN|COMMIT|ROLLBACK|END\s+TRANSACTION|TRANSACTION|SAVEPOINT|RELEASE|PRAGMA|ATTACH|DETACH|VACUUM|REPLACE|EXISTS|TEMP|TEMPORARY)\b/i;
const ALLOWED_START = /^(SELECT |CREATE TABLE |INSERT INTO |UPDATE |DROP TABLE )/;
const byteLength = (text) => new TextEncoder().encode(text).length;
const renderSql = (statements) => `${statements.join(';\n')};`;

function checkStatements(statements) {
  if (!Array.isArray(statements) || statements.length < 1 || statements.length > MAX_STATEMENTS) fail('PHASE_TEMPLATE_INVALID');
  for (const s of statements) {
    if (typeof s !== 'string' || !/^[\x20-\x7e]+$/.test(s) || s !== s.trim() || s.includes(';') || s.includes('--')
      || s.includes('/*') || FORBIDDEN.test(s) || !ALLOWED_START.test(s)) fail('PHASE_TEMPLATE_INVALID');
  }
  if (byteLength(renderSql(statements)) > MAX_COMMAND_BYTES) fail('PHASE_TEMPLATE_INVALID');
}

const KITS = new WeakSet();
const PHASES = new WeakSet();
const ANALYSES = new WeakSet();

/** Pure: builds frozen phase templates for a caller-supplied nonce. No I/O, no target binding. */
export function createProbeKit(options) {
  const o = exactObject(options, ['nonce', 'transport'], ['nonce'], 'KIT_OPTIONS_INVALID');
  if (!isNonce(o.nonce)) fail('NONCE_INVALID');
  if ('transport' in o && o.transport !== TRANSPORT) fail('TRANSPORT_UNSUPPORTED');
  const phases = Object.freeze(phaseSpecs(o.nonce).map(([id, expect, gate, statements], order) => {
    checkStatements(statements);
    const phase = Object.freeze({ id, order, expect, writes: expect !== 'read', gate,
      statements: Object.freeze([...statements]), transport: TRANSPORT,
      requiresIndependentReadAndApproval: CLEANUP_PHASES.has(id), ...SAFETY });
    PHASES.add(phase);
    return phase;
  }));
  if (phases.map((p) => p.id).join() !== PHASE_IDS.join()) fail('PHASE_TEMPLATE_INVALID');
  const kit = Object.freeze({ kitVersion: KIT_VERSION, transport: TRANSPORT, expectedWranglerVersion: EXPECTED_WRANGLER_VERSION,
    probeDatabaseName: PROBE_DB_NAME, tables: Object.freeze({ marker: MARKER_TABLE, data: DATA_TABLE }), nonce: o.nonce,
    phaseIds: PHASE_IDS, phases, ...SAFETY, notice: NOTICE });
  KITS.add(kit);
  return kit;
}

export const isProbeKit = (value) => KITS.has(value);

/** Renders ONE module-generated phase as a --command template string. Never accepts caller SQL. */
export function renderPhaseCommand(phase) {
  if (!PHASES.has(phase)) fail('PHASE_NOT_OWNED');
  checkStatements(phase.statements);
  const sql = renderSql(phase.statements);
  return Object.freeze({ phaseId: phase.id, transport: TRANSPORT, sql, byteLength: byteLength(sql),
    statementCount: phase.statements.length, templateOnly: true, targetBound: false,
    requiresIndependentReadAndApproval: phase.requiresIndependentReadAndApproval, ...SAFETY });
}

// ---- Strict analysers. Inputs are untrusted D1 result arrays; outputs are counts/booleans only. ----
function resultSets(raw, count) {
  if (!Array.isArray(raw) || raw.length !== count) fail('RESULT_SHAPE_INVALID');
  return raw.map((set) => {
    exactObject(set, ['results', 'success', 'meta'], ['results', 'success'], 'RESULT_SHAPE_INVALID');
    if (set.success !== true) fail('RESULT_NOT_SUCCESS');
    if (!Array.isArray(set.results) || set.results.length > MAX_ROWS) fail('RESULT_SHAPE_INVALID');
    return set.results;
  });
}
const isText = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;

function aggregate(rows, keys) {
  if (rows.length !== 1) fail('RESULT_SHAPE_INVALID');
  const row = exactObject(rows[0], keys, keys, 'RESULT_ROW_INVALID');
  const out = {};
  for (const key of keys) {
    const v = row[key];
    if (!Number.isSafeInteger(v) || v < (key === 'marker_step' ? -1 : 0) || v > MAX_COUNT) fail('RESULT_VALUE_INVALID');
    out[key] = v;
  }
  if (out.marker_owned > 1 || out.marker_owned > out.marker_rows || (out.marker_owned === 0) !== (out.marker_step === -1)) fail('RESULT_INCONSISTENT');
  return out;
}

function schema(rows, expected) {
  const seen = new Set();
  let owned = 0, foreign = 0, ddlMatches = true;
  for (const row of rows) {
    exactObject(row, SCHEMA_KEYS, SCHEMA_KEYS, 'RESULT_ROW_INVALID');
    if (!isText(row.type) || !isText(row.name) || !isText(row.tbl_name) || !(row.sql === null || isText(row.sql))) fail('RESULT_VALUE_INVALID');
    if (seen.has(row.name)) fail('RESULT_VALUE_INVALID');
    seen.add(row.name);
    const match = expected.find(([name]) => name === row.name);
    if (!match) { foreign++; continue; }
    owned++;
    if (row.type !== 'table' || row.tbl_name !== match[0] || row.sql !== match[1]) ddlMatches = false;
  }
  return Object.freeze({ objectCount: rows.length, ownedObjectCount: owned, foreignObjectCount: foreign, ddlMatches,
    ownedTablesExact: foreign === 0 && owned === expected.length && ddlMatches });
}

const deepFreezeResult = (result) => { ANALYSES.add(Object.freeze(result)); return result; };

// Analysers take UNBOUND observations: they are not tied to a kit, nonce, target, transport run or
// phase execution, and cannot tell where the raw results came from. Nonce ownership is only as good as
// the nonce embedded in the read SQL that produced them. Results are advisory inputs for a future runner.

/** Analyses the precondition / final-precondition read. Never echoes object names. */
export function analysePrecondition(raw) {
  const [rows] = resultSets(raw, 1);
  const seen = new Set();
  let ownedResidue = 0;
  for (const row of rows) {
    exactObject(row, ['type', 'name'], ['type', 'name'], 'RESULT_ROW_INVALID');
    if (!isText(row.type) || !isText(row.name) || seen.has(row.name)) fail('RESULT_VALUE_INVALID');
    seen.add(row.name);
    if (row.name === MARKER_TABLE || row.name === DATA_TABLE) ownedResidue++;
  }
  const empty = rows.length === 0;
  return deepFreezeResult({ phase: 'precondition', kitVersion: KIT_VERSION, transport: TRANSPORT, objectCount: rows.length,
    ownedResidueCount: ownedResidue, foreignObjectCount: rows.length - ownedResidue, empty, setupCandidate: empty,
    ...SAFETY, codes: Object.freeze(empty ? [] : ['TARGET_NOT_EMPTY']) });
}

/**
 * Analyses the `inspect` or `cleanup-reinspect` read. cleanupCandidate only means "observed objects and
 * rows are exactly kit-owned"; cleanupAuthorized is always false. Unknown shapes throw controlled codes.
 */
export function analyseProbeRead(phaseId, raw) {
  if (phaseId !== 'inspect' && phaseId !== 'cleanup-reinspect') fail('PHASE_NOT_READ');
  const full = phaseId === 'inspect';
  const [aggRows, schemaRows] = resultSets(raw, 2);
  const c = aggregate(aggRows, full ? [...MARKER_KEYS, ...DATA_KEYS] : MARKER_KEYS);
  const s = schema(schemaRows, full ? [[DATA_TABLE, DATA_DDL], [MARKER_TABLE, MARKER_DDL]] : [[MARKER_TABLE, MARKER_DDL]]);
  const markerOwned = c.marker_rows === 1 && c.marker_owned === 1 && (c.marker_step === 0 || c.marker_step === 1);
  const codes = [];
  if (!s.ownedTablesExact) codes.push('SCHEMA_NOT_EXACT');
  if (!markerOwned) codes.push('MARKER_NOT_OWNED');
  let extra = {};
  if (full) {
    const owned = Object.keys(OWNED_ROWS).map((p) => c[`data_${p}`]);
    if (c.data_total !== c.data_foreign + owned.reduce((a, b) => a + b, 0)
      || Object.keys(OWNED_ROWS).some((p, i) => owned[i] > OWNED_ROWS[p].length)) fail('RESULT_INCONSISTENT');
    if (c.data_foreign !== 0) codes.push('FOREIGN_DATA');
    const positiveCommitted = c.data_positive === 3 && c.marker_step === 1;
    const failureRowsAbsent = c.data_fail_guard === 0 && c.data_fail_constraint === 0 && c.data_trailing === 0;
    // stateConsistentWithExpectedRows only says the aggregates equal the expected end state. The state
    // after `positive` alone is identical, so this can be true even if neither failure phase was ever
    // attempted or reached the database. It is NOT evidence of remote errors or rollback.
    extra = { positiveCommitted, failureRowsAbsent,
      stateConsistentWithExpectedRows: positiveCommitted && failureRowsAbsent && c.data_total === 3 && s.ownedTablesExact && markerOwned };
  }
  const ownershipMatches = s.ownedTablesExact && markerOwned && (!full || c.data_foreign === 0);
  return deepFreezeResult({ phase: phaseId, kitVersion: KIT_VERSION, transport: TRANSPORT,
    counts: Object.freeze({ ...c }), schema: s, ...extra, ownershipMatches, cleanupCandidate: ownershipMatches,
    ...SAFETY, codes: Object.freeze(codes) });
}

/**
 * True only for an analysis object produced by this module whose observed state is exactly kit-owned.
 * Advisory only: it proves neither provenance of the observation (which target, nonce or run) nor phase
 * approval, and it never authorizes cleanup.
 */
export const isCleanupCandidate = (analysis) => ANALYSES.has(analysis) && analysis.cleanupCandidate === true;
