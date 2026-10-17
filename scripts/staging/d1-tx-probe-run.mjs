#!/usr/bin/env node
// Gated executor for the synthetic D1 transaction probe against ONE pinned disposable database.
//
// Runs exactly: wrangler --version, `d1 info <PINNED_UUID> --json`, then 9 `d1 execute --remote --command`
// calls (precondition, setup, inspect, positive, inspect, guard-abort, inspect, constraint-abort, inspect).
// Never runs cleanup or DROP phases and has no executor-level retry (each command is spawned at most once; this
// does not prove every internal Wrangler code path is retry-free), never writes report files, never prints raw Wrangler
// stdout/stderr/errors. It only observes ONE transport (wrangler d1 execute --remote --command, i.e. /query);
// it proves nothing about Worker env.DB.batch(), --file imports or global atomicity, and authorizes no import
// or cleanup. The two probe tables are deliberately left behind; removing them needs separate approval.
// Every spawn: source config re-validated (no links, exact pin), fresh isolated cwd outside the repo, LF copy
// of the pinned config passed by absolute --config (no autodiscovery), filtered env, shell:false, no stdin.
// Spawns wrangler-dist/cli.js directly (never bin/wrangler.js: that wrapper re-spawns a child, forwards execArgv
// and maps a signal-killed child to exit 0), with only `--no-warnings` and no inherited execArgv/NODE_OPTIONS.
import { readFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  analysePrecondition, analyseProbeRead, createProbeKit, DATA_TABLE, EXPECTED_WRANGLER_VERSION, generateNonce, isNonce,
  KIT_VERSION, MARKER_TABLE, ProbeKitError, renderPhaseCommand, TRANSPORT,
} from './d1-tx-probe-kit.mjs';
import {
  PROBE_ACCOUNT_ID, PROBE_BINDING, PROBE_CONFIG_PATH, PROBE_DATABASE_ID, PROBE_DATABASE_NAME, validateProbeConfig,
} from './d1-tx-probe-target.mjs';
import { childEnvFor, createIsolatedDir, defaultTmpRoot, PREFLIGHT_PREFIX } from './deploy-uat-app.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WRANGLER_CLI = path.join(ROOT, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js');
export const NODE_ARGS = Object.freeze(['--no-warnings']);
export const MIN_NODE_MAJOR = 22; // same minimum the bypassed bin/wrangler.js wrapper enforces
export const RUN_FLAG = '--run-synthetic-probe';
export const CONFIRM_FLAG = '--confirm-database-id';
export const SPAWN_TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_PAYLOAD = 65_536;
export const EXECUTED_PHASES = Object.freeze(['precondition', 'setup', 'positive', 'guard-abort', 'constraint-abort', 'inspect']);
export const STEPS = Object.freeze(['version', 'identity', 'precondition', 'setup', 'inspect-setup', 'positive',
  'inspect-positive', 'guard-abort', 'inspect-guard', 'constraint-abort', 'inspect-constraint']);
const QUERY_ERROR_TEXT = `A request to the Cloudflare API (/accounts/${PROBE_ACCOUNT_ID}/d1/database/${PROBE_DATABASE_ID}/query) failed.`;
const CODE_TAG = '(?: \\[code: 7500\\])?';
// Exact anchored D1 SQL messages. Anything else (auth, network, rate limit, syntax, other SQL) is UNEXPECTED_FAILURE.
export const SQL_ERROR_PATTERNS = Object.freeze({
  guard: new RegExp(`^malformed JSON(?:: SQLITE_ERROR)?${CODE_TAG}$`),
  constraint: new RegExp(`^UNIQUE constraint failed: ${DATA_TABLE}\\.id(?:: SQLITE_CONSTRAINT)?${CODE_TAG}$`),
});
// Own properties Wrangler 4.151.0 serializes for an APIError inside {"error": ...} (d1 execute --json).
const API_ERROR_KEYS = ['name', 'text', 'notes', 'location', 'kind', 'telemetryMessage', 'code', 'accountTag', 'meta', 'retryAfterMs'];
const WRANGLER_PARTS = [['bin'], ['bin', 'wrangler.js'], ['wrangler-dist'], ['wrangler-dist', 'cli.js'], ['package.json']];
const COUNT_KEYS = ['marker_rows', 'marker_owned', 'marker_step', 'data_total', 'data_foreign', 'data_positive',
  'data_fail_guard', 'data_fail_constraint', 'data_trailing'];
const counts = (step, positive) => Object.fromEntries(COUNT_KEYS.map((k) => [k, ({ marker_rows: 1, marker_owned: 1,
  marker_step: step, data_total: positive, data_positive: positive })[k] ?? 0]));
export const EXPECTED_COUNTS = Object.freeze({ setup: Object.freeze(counts(0, 0)), committed: Object.freeze(counts(1, 3)) });

export class ProbeRunError extends Error {
  constructor(code) { super(code); this.name = 'ProbeRunError'; this.code = code; }
}
const fail = (code) => { throw new ProbeRunError(code); };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const safetyFlags = () => ({ transactionAtomicityVerified: false, readyForImport: false, appliesToWorkerBatch: false,
  appliesToFileImport: false, cleanupAuthorized: false, globalAtomicityClaimed: false });

// Own enumerable data properties only, plain prototype, no symbols; keys within `allowed`, `required` present.
function plain(value, allowed, required = allowed) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(value).length) return false;
  const keys = Object.getOwnPropertyNames(value);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if ((allowed && !allowed.includes(key)) || !('value' in d) || !d.enumerable) return false;
  }
  return required.every((k) => keys.includes(k));
}
const parseJson = (text) => { try { return typeof text === 'string' ? JSON.parse(text) : undefined; } catch { return undefined; } };

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== RUN_FLAG || argv[1] !== CONFIRM_FLAG || argv[2] !== PROBE_DATABASE_ID) {
    fail('CLI_ARGUMENTS');
  }
  return Object.freeze({ databaseId: PROBE_DATABASE_ID });
}

/**
 * Local-only: the installed Wrangler under the repo ROOT (never caller-chosen; any other root is refused) must be the
 * pinned, link-free 4.151.0, and the running Node must meet the wrapper's minimum. Returns the verified CLI path.
 */
export async function verifyWranglerInstall(root = ROOT) {
  if (root !== ROOT) fail('WRANGLER_ROOT_UNEXPECTED');
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) fail('NODE_VERSION_UNSUPPORTED');
  const pkgDir = path.join(root, 'node_modules', 'wrangler');
  if (WRANGLER_CLI !== path.join(pkgDir, 'wrangler-dist', 'cli.js') || !path.isAbsolute(WRANGLER_CLI)) fail('WRANGLER_CLI_UNEXPECTED');
  const realPkgDir = path.join(await realpath(root), 'node_modules', 'wrangler');
  for (const [p, dir] of [[path.join(root, 'node_modules'), true], [pkgDir, true], ...WRANGLER_PARTS.map((parts) =>
    [path.join(pkgDir, ...parts), parts.length === 1 && !parts[0].includes('.')])]) {
    const st = await lstat(p);
    if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile())) fail('WRANGLER_INSTALL_UNSAFE');
    if (await realpath(p) !== path.join(realPkgDir, path.relative(pkgDir, p))) fail('WRANGLER_INSTALL_UNSAFE');
  }
  const pkg = parseJson(await readFile(path.join(pkgDir, 'package.json'), 'utf8'));
  if (pkg?.name !== 'wrangler' || pkg.version !== EXPECTED_WRANGLER_VERSION) fail('WRANGLER_VERSION_UNEXPECTED');
  const rootPkg = parseJson(await readFile(path.join(root, 'package.json'), 'utf8'));
  const declared = rootPkg?.devDependencies?.wrangler ?? rootPkg?.dependencies?.wrangler;
  if (declared !== `^${EXPECTED_WRANGLER_VERSION}` && declared !== EXPECTED_WRANGLER_VERSION) fail('WRANGLER_DEPENDENCY_UNEXPECTED');
  return WRANGLER_CLI;
}

/** Re-reads the pinned source config under `base`: every component link-free, exact hash pin. Returns LF text. */
export async function readSourceConfig(base) {
  const parts = PROBE_CONFIG_PATH.split('/');
  const realBase = await realpath(base);
  let current = base;
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const st = await lstat(current);
    const last = i === parts.length - 1;
    if (st.isSymbolicLink() || (last ? !st.isFile() || st.nlink !== 1 : !st.isDirectory())) fail('CONFIG_SOURCE_UNSAFE');
  }
  if (await realpath(current) !== path.join(realBase, ...parts)) fail('CONFIG_SOURCE_UNSAFE');
  const text = await readFile(current, 'utf8');
  validateProbeConfig(text);
  return text.replaceAll('\r\n', '\n');
}

function childEnv(env) {
  const out = Object.fromEntries(Object.entries(childEnvFor(env))
    .filter(([key]) => !['CI', 'CLOUDFLARE_ACCOUNT_ID'].includes(key.toUpperCase())));
  out.CLOUDFLARE_ACCOUNT_ID = PROBE_ACCOUNT_ID;
  out.CI = 'true';
  return Object.freeze(out);
}

const transportClass = (r) => (!r || r.error || r.signal || !Number.isInteger(r.status) ? 'TRANSPORT_UNCERTAIN'
  : r.status === 0 ? null : 'UNEXPECTED_FAILURE');

function errorPayload(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!t.startsWith('{') || t.length > MAX_ERROR_PAYLOAD) return undefined;
  const v = parseJson(t);
  return plain(v, ['error']) ? v.error : undefined;
}

// Two accepted shapes: Wrangler's {text} wrapper for a plain Error (targetBound false), or the APIError of the
// pinned /query URL with exactly one note (targetBound true). Any other key, value or note count fails closed.
function sqlMessage(e) {
  if (plain(e, ['text'])) return typeof e.text === 'string' && e.text.length <= 4096 ? { message: e.text, targetBound: false } : null;
  if (!plain(e, API_ERROR_KEYS, ['name', 'text', 'notes']) || e.name !== 'APIError' || e.text !== QUERY_ERROR_TEXT) return null;
  if ('location' in e || 'retryAfterMs' in e || 'meta' in e) return null;
  if (('kind' in e && e.kind !== 'error') || ('code' in e && e.code !== 7500) || ('telemetryMessage' in e && e.telemetryMessage !== false)
    || ('accountTag' in e && e.accountTag !== PROBE_ACCOUNT_ID)) return null;
  if (!Array.isArray(e.notes) || e.notes.length !== 1 || !plain(e.notes[0], ['text']) || typeof e.notes[0].text !== 'string'
    || e.notes[0].text.length > 4096) return null;
  return { message: e.notes[0].text, targetBound: true };
}

/**
 * Classifies an expected-failure spawn. No signal/exit status => TRANSPORT_UNCERTAIN (whatever the output says);
 * exit 0 => UNEXPECTED_SUCCESS; non-zero => exactly ONE {"error":...} JSON payload in stdout or stderr while the
 * other stream is empty after trim (any warning/auth/rate-limit text there fails closed), of a known shape whose
 * single SQL message matches the anchored pattern for `kind`, else UNEXPECTED_FAILURE. Never echoes.
 * Diagnostic only: EXPECTED_SQL_ERROR with targetBound:false is NOT accepted as run proof (see UNBOUND_SQL_ERROR).
 */
export function classifyFailure(result, kind) {
  if (!Object.hasOwn(SQL_ERROR_PATTERNS, kind)) fail('CLASSIFIER_KIND_INVALID');
  const transport = transportClass(result);
  if (transport === 'TRANSPORT_UNCERTAIN') return Object.freeze({ class: transport, targetBound: false });
  if (transport === null) return Object.freeze({ class: 'UNEXPECTED_SUCCESS', targetBound: false });
  const streams = [result.stdout, result.stderr];
  const payloads = streams.map(errorPayload);
  const index = payloads.findIndex((p) => p !== undefined);
  const other = streams[1 - index];
  const single = index !== -1 && payloads[1 - index] === undefined && (other === undefined || other === null
    || (typeof other === 'string' && other.trim() === ''));
  const parsed = single ? sqlMessage(payloads[index]) : null;
  if (parsed && SQL_ERROR_PATTERNS[kind].test(parsed.message)) return Object.freeze({ class: 'EXPECTED_SQL_ERROR', targetBound: parsed.targetBound });
  return Object.freeze({ class: 'UNEXPECTED_FAILURE', targetBound: false });
}

function successSets(stdout, expectedRows) {
  const raw = parseJson(stdout);
  if (!Array.isArray(raw) || raw.length !== expectedRows.length) return false;
  return raw.every((set, i) => plain(set, ['results', 'success', 'meta'], ['results', 'success']) && set.success === true
    && (!('meta' in set) || plain(set.meta, null, [])) && Array.isArray(set.results)
    && set.results.length === expectedRows[i].length && set.results.every((row, j) => plain(row, Object.keys(expectedRows[i][j]))
      && Object.entries(expectedRows[i][j]).every(([k, v]) => row[k] === v)));
}

function identityMatches(stdout) {
  const v = parseJson(stdout);
  return plain(v, null, ['uuid', 'name', 'read_replication']) && v.uuid === PROBE_DATABASE_ID && v.name === PROBE_DATABASE_NAME
    && plain(v.read_replication, ['mode']) && v.read_replication.mode === 'disabled';
}

// Diagnostics: fixed-enum hypothesis FEATURES of one local result, never evidence, provenance or authorization. They do
// not recover any historical cause (raw output discarded) and never echo raw text, key names or arbitrary numbers.
export const DIAGNOSTIC_REASON_CODES = Object.freeze(['INPUT_INVALID', 'TRANSPORT_UNCERTAIN', 'EXIT_ZERO', 'NO_ERROR_PAYLOAD',
  'OPPOSITE_STREAM_NONEMPTY', 'PAYLOAD_SHAPE_UNKNOWN', 'UNBOUND_TEXT_WRAPPER', 'TARGET_MISMATCH', 'API_CODE_NOT_7500',
  'METADATA_REJECTED', 'UNEXPECTED_KEYS', 'NOTE_INVALID', 'MESSAGE_MISMATCH']);
const DIAG_PROVIDER_CODES = [7500, 9109, 10000, 10001, 10002];
const DIAG_ERRNO = ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES'];
const DIAG_FAMILY = { guard: 'guard', constraint: 'owned-unique' };
// Schema v2 adds sqlMessageShape/sqliteSuffix/messageWrapper (default 'unknown'); schema v3 adds sqliteExtendedCode
// (default 'unknown'). Historical v1/v2 reports are not rewritten or reinterpreted.
const DIAG_DEFAULT = { schemaVersion: 3, kind: 'invalid', transport: 'unknown', errorCode: 'none', stdout: 'unknown', stderr: 'unknown',
  payloadStream: 'none', payloadShape: 'none', targetBinding: 'unknown', providerCode: 'none', sqlFamily: 'unknown', noteCount: 'invalid',
  hasUnexpectedKeys: false, hasMeta: false, hasLocation: false, hasRetryAfter: false, sqlMessageShape: 'unknown', sqliteSuffix: 'unknown',
  messageWrapper: 'unknown', sqliteExtendedCode: 'unknown' };
// v2 message taxonomy: a LOCAL exact-literal match HYPOTHESIS, never evidence, proof, acceptance or authorization, and it
// never feeds SQL_ERROR_PATTERNS/diagSql/sqlFamily/reasonCodes/classifyFailure. Controlled cross product of full literals:
// optional 'D1_ERROR: ' prefix (D1 debug docs), SQLite tokens SQLITE_CONSTRAINT_PRIMARYKEY(1555)/_UNIQUE(2067) per
// sqlite.org/rescode.html, optional ' [code: 7500]' (Wrangler renderError appends ' [code: N]' to the raw D1 message and does
// not rewrite SQLite tokens). ': SQLITE_ERROR' is an unconfirmed diagnostic hypothesis (generic SQLite code), never observed.
// 'owned-id-unique' labels message SHAPE only, not a remote constraint proof. No regex, trim, casefold or raw substrings.
const DIAG_TAXONOMY = new Map([['', 'none'], ['D1_ERROR: ', 'D1_ERROR']].flatMap(([pre, messageWrapper]) => [['', 'none'],
  [': SQLITE_ERROR', 'SQLITE_ERROR'], [': SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT'],
  [': SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_PRIMARYKEY'], [': SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_UNIQUE']]
  .flatMap(([suffix, sqliteSuffix]) => ['', ' [code: 7500]'].map((tail) => [`${pre}UNIQUE constraint failed: ${DATA_TABLE}.id${suffix}${tail}`,
    Object.freeze({ sqlMessageShape: 'owned-id-unique', sqliteSuffix, messageWrapper })]))));
export const DIAGNOSTIC_TAXONOMY_LITERALS = Object.freeze([...DIAG_TAXONOMY.keys()]);
// v3 extended literals (separate map; the 20 above are unchanged and report sqliteExtendedCode 'none'). LOCALITY EVIDENCE:
// the local Miniflare 5.20261012.0-beta harness observed the exact tail ': SQLITE_CONSTRAINT (extended:
// SQLITE_CONSTRAINT_PRIMARYKEY)' with and without 'D1_ERROR: '. REMOTE HYPOTHESIS ONLY: the remote D1/Wrangler text is
// unknown; ' [code: 7500]' variants are the prospective Wrangler renderError form, never observed remotely. Diagnostic ONLY:
// never feeds SQL_ERROR_PATTERNS/diagSql/sqlFamily/reasonCodes/classifyFailure (sqlFamily stays 'other' => MESSAGE_MISMATCH).
// Exact whole-string Map lookup; no regex, trim, casefold, substrings or similar-variant fallback.
const DIAG_EXTENDED = new Map([['', 'none'], ['D1_ERROR: ', 'D1_ERROR']].flatMap(([pre, messageWrapper]) => ['', ' [code: 7500]']
  .map((tail) => [`${pre}UNIQUE constraint failed: ${DATA_TABLE}.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)${tail}`,
    Object.freeze({ sqlMessageShape: 'owned-id-unique', sqliteSuffix: 'SQLITE_CONSTRAINT', messageWrapper,
      sqliteExtendedCode: 'SQLITE_CONSTRAINT_PRIMARYKEY' })])));
export const DIAGNOSTIC_EXTENDED_LITERALS = Object.freeze([...DIAG_EXTENDED.keys()]);
// Bounded (<= 4096 chars AND UTF-8 bytes) or all-unknown; any other readable string is 'other' with suffix/wrapper/extended unknown.
// Extended literals match ONLY in the clean pinned APIError context (`bound`); in the unbound {text} wrapper they are 'other',
// so the local Miniflare module's exact-pair recognition (which feeds this wrapper) keeps its prior result.
const diagTaxonomy = (m, bound) => (typeof m !== 'string' || m.length > 4096 || Buffer.byteLength(m, 'utf8') > 4096 ? {}
  : DIAG_TAXONOMY.has(m) ? { ...DIAG_TAXONOMY.get(m), sqliteExtendedCode: 'none' }
    : (bound && DIAG_EXTENDED.get(m)) || { sqlMessageShape: 'other' });
const DIAG_FLAGS = { hypothesisOnly: true, historicalCauseRecovered: false, evidenceAccepted: false, authorizesRetry: false,
  cleanupAuthorized: false };
const diagRecord = (fields, reasons) => Object.freeze({ ...DIAG_DEFAULT, ...fields,
  reasonCodes: Object.freeze(DIAGNOSTIC_REASON_CODES.filter((c) => reasons.includes(c))), ...DIAG_FLAGS });
const ownValue = (o, k) => { const d = o !== null && typeof o === 'object' ? Object.getOwnPropertyDescriptor(o, k) : undefined;
  return d && 'value' in d ? d.value : undefined; };
const diagSql = (m) => (typeof m !== 'string' || m.length > 4096 ? 'unknown' : SQL_ERROR_PATTERNS.guard.test(m) ? 'guard'
  : SQL_ERROR_PATTERNS.constraint.test(m) ? 'owned-unique' : 'other');

function diagStream(s) {
  if (s === undefined || s === null) return { shape: 'missing' };
  if (typeof s !== 'string') return { shape: 'wrong-type' };
  const t = s.trim();
  if (t === '') return { shape: 'empty' };
  // Stricter than the classifier (also caps UTF-8 bytes) so parsing is bounded; diagnostics never change acceptance.
  if (t.length > MAX_ERROR_PAYLOAD || Buffer.byteLength(t, 'utf8') > MAX_ERROR_PAYLOAD) return { shape: 'oversize' };
  const v = t.startsWith('{') ? parseJson(t) : undefined;
  if (v === undefined) return { shape: 'not-json' };
  const envelope = plain(v, null, ['error']);
  return { shape: 'json', envelope, extra: envelope && Object.keys(v).length !== 1, error: envelope ? v.error : undefined };
}

function diagnose(result, kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(SQL_ERROR_PATTERNS, kind)) return diagRecord({}, ['INPUT_INVALID']);
  if (result === null || typeof result !== 'object') {
    return diagRecord({ kind, transport: 'missing-result', stdout: 'missing', stderr: 'missing' }, ['TRANSPORT_UNCERTAIN']);
  }
  const fields = ['error', 'signal', 'status', 'stdout', 'stderr'];
  if (fields.some((k) => { const d = Object.getOwnPropertyDescriptor(result, k); return d && !('value' in d); })) {
    return diagRecord({ kind }, ['INPUT_INVALID']);
  }
  const [error, signal, status] = fields.map((k) => ownValue(result, k));
  const errno = ownValue(error, 'code');
  const f = { ...DIAG_DEFAULT, kind, errorCode: !error ? 'none' : DIAG_ERRNO.includes(errno) ? errno : 'OTHER',
    transport: error ? (errno === 'ETIMEDOUT' ? 'timeout' : 'spawn-error') : signal ? 'signal'
      : !Number.isInteger(status) ? 'invalid-status' : status === 0 ? 'exit-zero' : 'exit-nonzero' };
  const streams = [diagStream(ownValue(result, 'stdout')), diagStream(ownValue(result, 'stderr'))];
  [f.stdout, f.stderr] = streams.map((s) => s.shape);
  const has = streams.map((s) => s.envelope === true);
  f.payloadStream = has[0] && has[1] ? 'both' : has[0] ? 'stdout' : has[1] ? 'stderr' : 'none';
  const p = has[0] ? streams[0] : has[1] ? streams[1] : null;
  const opposite = has[0] && has[1] ? true : has[0] ? !['missing', 'empty'].includes(f.stderr)
    : has[1] && !['missing', 'empty'].includes(f.stdout);
  const e = p?.error;
  let metaBad = false, noteBad = false, message;
  f.hasUnexpectedKeys = p?.extra === true;
  if (p && plain(e, ['text'])) {
    Object.assign(f, { payloadShape: 'text-wrapper', targetBinding: 'missing', noteCount: 'zero', sqlFamily: diagSql(e.text) });
    noteBad = f.sqlFamily === 'unknown';
    message = { value: e.text };
  } else if (p && plain(e, null, []) && e.name === 'APIError') {
    const keys = Object.keys(e);
    const notes = e.notes;
    f.payloadShape = 'api-error';
    f.hasUnexpectedKeys ||= keys.some((k) => !API_ERROR_KEYS.includes(k));
    [f.hasMeta, f.hasLocation, f.hasRetryAfter] = ['meta', 'location', 'retryAfterMs'].map((k) => keys.includes(k));
    f.targetBinding = !keys.includes('text') ? 'missing' : e.text === QUERY_ERROR_TEXT ? 'match' : typeof e.text === 'string' ? 'mismatch' : 'unknown';
    f.providerCode = !keys.includes('code') ? 'none' : DIAG_PROVIDER_CODES.includes(e.code) ? String(e.code) : 'OTHER';
    f.noteCount = !Array.isArray(notes) ? 'invalid' : ['zero', 'one'][notes.length] ?? 'multiple';
    const note = f.noteCount === 'one' && plain(notes[0], ['text']) ? notes[0].text : undefined;
    f.sqlFamily = diagSql(note);
    if (f.noteCount === 'one' && plain(notes[0], ['text'])) message = { value: note };
    noteBad = typeof note !== 'string' || note.length > 4096;
    metaBad = f.hasMeta || f.hasLocation || f.hasRetryAfter || (keys.includes('kind') && e.kind !== 'error')
      || (keys.includes('telemetryMessage') && e.telemetryMessage !== false) || (keys.includes('accountTag') && e.accountTag !== PROBE_ACCOUNT_ID);
  } else if (p) f.payloadShape = 'unknown';
  // v2 taxonomy gate: non-zero exit, exactly ONE clean payload (opposite stream empty/missing, no envelope extras) and the
  // single readable wrapper text or single note. APIError also needs target match, no unexpected keys, no rejected
  // metadata/account and providerCode none/7500. The plain {text} wrapper stays unbound (shape only, never proof). Any
  // other context, incl. multiple/ambiguous streams or notes, keeps all four fields 'unknown' (no first-note policy).
  const apiClean = f.payloadShape === 'api-error' && f.targetBinding === 'match' && !f.hasUnexpectedKeys && !metaBad
    && ['none', '7500'].includes(f.providerCode);
  if (message && f.transport === 'exit-nonzero' && !opposite && p.extra === false && !f.hasUnexpectedKeys
    && (f.payloadShape === 'text-wrapper' || apiClean)) Object.assign(f, diagTaxonomy(message.value, apiClean));
  if (f.transport !== 'exit-nonzero') return diagRecord(f, [f.transport === 'exit-zero' ? 'EXIT_ZERO' : 'TRANSPORT_UNCERTAIN']);
  const known = f.payloadShape === 'api-error' || f.payloadShape === 'text-wrapper';
  return diagRecord(f, [!p && 'NO_ERROR_PAYLOAD', opposite && 'OPPOSITE_STREAM_NONEMPTY', f.payloadShape === 'unknown' && 'PAYLOAD_SHAPE_UNKNOWN',
    f.payloadShape === 'text-wrapper' && 'UNBOUND_TEXT_WRAPPER', f.payloadShape === 'api-error' && f.targetBinding !== 'match' && 'TARGET_MISMATCH',
    !['none', '7500'].includes(f.providerCode) && 'API_CODE_NOT_7500', metaBad && 'METADATA_REJECTED',
    f.hasUnexpectedKeys && 'UNEXPECTED_KEYS', noteBad && 'NOTE_INVALID',
    known && f.sqlFamily !== 'unknown' && f.sqlFamily !== DIAG_FAMILY[kind] && 'MESSAGE_MISMATCH']);
}

/**
 * Pure, never throws: bounded enum/boolean features explaining why `classifyFailure` might reject `result`. An invalid
 * `kind` or malformed/accessor-bearing input returns a fixed INPUT_INVALID record (explicit choice: no throw). Empty
 * reasonCodes means no rejection feature was found; it is still NOT evidence. Always evidenceAccepted/authorizesRetry/
 * cleanupAuthorized false and historicalCauseRecovered false. Does not alter classifyFailure or acceptance.
 */
export function diagnoseFailure(result, kind) {
  try { return diagnose(result, kind); } catch {
    let valid = false;
    try { valid = typeof kind === 'string' && Object.hasOwn(SQL_ERROR_PATTERNS, kind); } catch { /* fixed fallback */ }
    return diagRecord({ kind: valid ? kind : 'invalid' }, ['INPUT_INVALID']);
  }
}

const safeCode = (e) => {
  const code = e instanceof ProbeRunError || e instanceof ProbeKitError ? e.code : /^UAT_[A-Z_]+$/.test(e?.message ?? '') ? e.message : '';
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'LOCAL_GATE_FAILED';
};

/**
 * Executes the synthetic probe. `confirmation` must be exactly { databaseId: <pinned UUID> } regardless of caller.
 * Throws (zero spawns) on local gate failures; once any spawn is attempted it returns a sanitized report.
 */
export async function runSyntheticProbe(confirmation, deps = {}) {
  if (!plain(confirmation, ['databaseId']) || confirmation.databaseId !== PROBE_DATABASE_ID) fail('CONFIRMATION_REQUIRED');
  if (!plain(deps, ['env', 'spawn', 'base', 'tmpRoot', 'nonce'], [])) fail('DEPENDENCIES_INVALID');
  const { env = process.env, spawn = spawnSync, base = ROOT, tmpRoot = defaultTmpRoot() } = deps;
  if (!env || typeof env !== 'object' || env.CLOUDFLARE_ACCOUNT_ID !== PROBE_ACCOUNT_ID) fail('PROBE_ACCOUNT_REQUIRED');
  if (typeof spawn !== 'function') fail('DEPENDENCIES_INVALID');
  const nonce = deps.nonce ?? generateNonce();
  if (!isNonce(nonce)) fail('NONCE_INVALID');
  const kit = createProbeKit({ nonce, transport: TRANSPORT });
  const sql = Object.fromEntries(kit.phases.filter((p) => EXECUTED_PHASES.includes(p.id)).map((p) => [p.id, renderPhaseCommand(p).sql]));
  if (Object.keys(sql).length !== EXECUTED_PHASES.length || Object.values(sql).some((s) => /\bDROP\b/i.test(s))) fail('PHASE_FORBIDDEN');
  const env2 = childEnv(env);
  if (env2.CLOUDFLARE_ACCOUNT_ID !== PROBE_ACCOUNT_ID) fail('PROBE_ACCOUNT_REQUIRED');
  await verifyWranglerInstall(ROOT); // zero-spawn gate; repeated inside run() before every spawn
  await readSourceConfig(base);

  const report = { ok: false, exitCode: 2, nonce, nonceSynthetic: true, kitVersion: KIT_VERSION, transport: TRANSPORT,
    wranglerVersion: null, target: { databaseName: PROBE_DATABASE_NAME, databaseId: PROBE_DATABASE_ID },
    identityVerified: false, remoteExecutionAttempted: false, setupAttempted: false, stateUncertain: false,
    observedTransportRollback: false, steps: [], codes: [] };

  let spawns = 0;
  const run = async (step, remote, argsFor) => {
    const cli = await verifyWranglerInstall(ROOT); // re-verified before EVERY spawn, not only once
    if (cli !== WRANGLER_CLI) fail('WRANGLER_CLI_UNEXPECTED');
    const text = await readSourceConfig(base);
    const dir = await createIsolatedDir({ prefix: PREFLIGHT_PREFIX, tmpRoot, bases: [base] });
    try {
      const copy = path.join(dir.path, 'probe.toml');
      await writeFile(copy, text, { flag: 'wx' });
      const st = await lstat(copy);
      const back = await readFile(copy, 'utf8');
      if (!st.isFile() || st.isSymbolicLink() || back !== text) fail('CONFIG_COPY_MISMATCH');
      validateProbeConfig(back);
      if (remote) report.remoteExecutionAttempted = true;
      if (step === 'setup') report.setupAttempted = true;
      spawns++;
      try {
        return spawn(process.execPath, [...NODE_ARGS, cli, ...argsFor(copy)], { cwd: dir.path, env: env2, shell: false,
          stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true });
      } catch {
        return { error: true, status: null, signal: null };
      }
    } finally {
      await dir.cleanup();
    }
  };
  const execute = (step, phaseId) => run(step, true, (cfg) => ['d1', 'execute', PROBE_BINDING, '--remote', '--config', cfg,
    '--command', sql[phaseId], '--json']);
  const record = (phaseId, step, r, cls, extra = {}) => {
    const passed = cls === 'OK' || cls === 'EXPECTED_SQL_ERROR';
    report.steps.push({ phaseId, step, exitCode: Number.isInteger(r?.status) ? r.status : null, class: cls, passed, ...extra });
    if (!passed) report.codes.push(`STEP_FAILED_${step.toUpperCase().replaceAll('-', '_')}`);
    return passed;
  };
  const inspect = async (step, expected) => {
    const r = await execute(step, 'inspect');
    const t = transportClass(r);
    if (t) return record('inspect', step, r, t);
    let a;
    try { a = analyseProbeRead('inspect', parseJson(r.stdout)); } catch { return record('inspect', step, r, 'RESPONSE_INVALID'); }
    const observed = { ...a.counts };
    const countsExact = Object.keys(observed).length === COUNT_KEYS.length && COUNT_KEYS.every((k) => observed[k] === expected[k]);
    const schemaExact = a.schema.ownedTablesExact === true && a.schema.objectCount === 2 && a.ownershipMatches === true;
    if (!a.ownershipMatches) report.codes.push('OWNERSHIP_NOT_CONFIRMED_MANUAL_STOP');
    const evidenceSha256 = sha256(JSON.stringify({ nonce, kitVersion: KIT_VERSION, phaseId: 'inspect', step, counts: observed, schemaExact }));
    return record('inspect', step, r, countsExact && schemaExact ? 'OK' : 'STATE_MISMATCH', { counts: observed, schemaExact, evidenceSha256 });
  };
  const success = async (step, rows) => {
    const r = await execute(step, step);
    return record(step, step, r, transportClass(r) ?? (successSets(r.stdout, rows) ? 'OK' : 'RESPONSE_INVALID'));
  };
  const abort = async (step, kind) => {
    const r = await execute(step, step);
    const c = classifyFailure(r, kind);
    // Run proof requires the SQL error to come from the pinned /query APIError; an unbound message is not proof.
    const cls = c.class === 'EXPECTED_SQL_ERROR' && c.targetBound !== true ? 'UNBOUND_SQL_ERROR' : c.class;
    // Failed aborts only: enum-only hypothesis features, never proof; acceptance is decided solely by `cls` above.
    return record(step, step, r, cls, { targetBound: c.targetBound === true,
      ...(cls === 'EXPECTED_SQL_ERROR' ? {} : { diagnostics: diagnoseFailure(r, kind) }) });
  };

  try {
    const v = await run('version', false, () => ['--version']);
    const vOk = !transportClass(v) && typeof v.stdout === 'string' && v.stdout.trim() === EXPECTED_WRANGLER_VERSION;
    if (!record('version', 'version', v, vOk ? 'OK' : transportClass(v) ?? 'VERSION_MISMATCH')) return finish(report);
    report.wranglerVersion = EXPECTED_WRANGLER_VERSION;
    const id = await run('identity', true, (cfg) => ['d1', 'info', PROBE_DATABASE_ID, '--config', cfg, '--json']);
    report.identityVerified = !transportClass(id) && identityMatches(id.stdout);
    if (!record('identity', 'identity', id, transportClass(id) ?? (report.identityVerified ? 'OK' : 'IDENTITY_MISMATCH'))) return finish(report);
    const pre = await execute('precondition', 'precondition');
    let preClass = transportClass(pre), preCounts;
    if (!preClass) {
      try {
        const a = analysePrecondition(parseJson(pre.stdout));
        preCounts = { objectCount: a.objectCount, ownedResidueCount: a.ownedResidueCount };
        preClass = a.setupCandidate === true && a.objectCount === 0 ? 'OK' : 'TARGET_NOT_EMPTY';
      } catch { preClass = 'RESPONSE_INVALID'; }
    }
    if (!record('precondition', 'precondition', pre, preClass, preCounts ? { counts: preCounts } : {})) return finish(report);
    if (!await success('setup', [[], [], []])) return finish(report);
    if (!await inspect('inspect-setup', EXPECTED_COUNTS.setup)) return finish(report);
    if (!await success('positive', [[], [], [{ receipt_guard: 1 }]])) return finish(report);
    if (!await inspect('inspect-positive', EXPECTED_COUNTS.committed)) return finish(report);
    if (!await abort('guard-abort', 'guard')) return finish(report);
    if (!await inspect('inspect-guard', EXPECTED_COUNTS.committed)) return finish(report);
    if (!await abort('constraint-abort', 'constraint')) return finish(report);
    if (!await inspect('inspect-constraint', EXPECTED_COUNTS.committed)) return finish(report);
    report.observedTransportRollback = report.steps.length === STEPS.length
      && report.steps.every((s, i) => s.passed && s.step === STEPS[i])
      && report.steps.filter((s) => s.class === 'EXPECTED_SQL_ERROR' && s.targetBound === true)
        .map((s) => s.step).join() === 'guard-abort,constraint-abort';
  } catch (e) {
    if (spawns === 0) throw e; // local gate before any process: CLI exit 1, no report of a run
    report.codes.push(safeCode(e));
  }
  return finish(report);
}

function finish(report) {
  const done = report.observedTransportRollback === true;
  report.ok = done;
  report.exitCode = done ? 0 : 2;
  report.stateUncertain = report.setupAttempted && !done;
  report.residue = Object.freeze({ manualCleanupRequired: report.setupAttempted, cleanupApprovalPending: report.setupAttempted,
    automaticCleanup: false, ownedTables: report.setupAttempted ? [MARKER_TABLE, DATA_TABLE] : [] });
  Object.assign(report, safetyFlags());
  return report;
}

export async function main(argv = process.argv.slice(2), deps = {}, write = (line) => process.stdout.write(`${line}\n`)) {
  try {
    const report = await runSyntheticProbe(parseArgs(argv), deps);
    write(JSON.stringify(report));
    return report.exitCode;
  } catch (e) {
    write(JSON.stringify({ ok: false, exitCode: 1, codes: [safeCode(e)], remoteExecutionAttempted: false, setupAttempted: false,
      observedTransportRollback: false, ...safetyFlags() }));
    return 1;
  }
}
export const runCli = main;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
