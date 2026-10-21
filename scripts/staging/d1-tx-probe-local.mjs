#!/usr/bin/env node
// LOCAL-ONLY reproduction of the probe's constraint-abort phase on an ephemeral Miniflare D1 binding.
//
// Scope and limits (read before using any output):
//   * Executes the kit's generated statement arrays with `db.batch()` on a fresh, in-memory local Miniflare database
//     (loopback host, port 0, outbound fetch refused with 403, no persistence path, no migrations, no R2, no
//     credentials, no environment reads, no Wrangler, no process spawn). Miniflare's own runtime is a local process
//     reachable on loopback only; this is local I/O by design.
//   * It says NOTHING about `wrangler d1 execute --remote --command` (/query), remote D1, --file imports or global
//     atomicity. remoteExecuted/remoteEvidence/transactionAtomicityVerified/readyForImport/cleanupAuthorized/targetBound
//     are always false. A local rejection never upgrades a remote UNEXPECTED_FAILURE.
//   * The caught error is classified IN MEMORY only: bounded own `message` of the error and of its own `cause` (max two
//     levels) are wrapped in a clearly SYNTHETIC transport result ({status:1, stdout:{"error":{"text":...}}}) and passed
//     to diagnoseFailure(..., 'constraint'). expectedConstraintMessageRecognized = whole-string match of any source to the
//     run module's 20 exact literals OR to the exact observed local pair LOCAL_MESSAGE_LITERALS (unprefixed + 'D1_ERROR: ').
//     Other fixed boolean/enum `features` (core/token/tail) are descriptive only and never feed recognition, rollback or
//     status. An unrecognised message yields INCONCLUSIVE.
//     Raw messages, stacks, keys, SQL, names and the nonce are never printed or returned. The {text} wrapper is unbound
//     by construction (targetBound false).
//   * No cleanup or DROP: the database is ephemeral and discarded by mf.dispose() in a finally block.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { analysePrecondition, analyseProbeRead, createProbeKit, DATA_TABLE, isNonce, ProbeKitError } from './d1-tx-probe-kit.mjs';
import { diagnoseFailure, EXPECTED_COUNTS } from './d1-tx-probe-run.mjs';

export const LOCAL_FLAG = '--local-only';
export const LOCAL_TRANSPORT = 'miniflare-d1-binding-batch';
export const LOCAL_NONCE = '0c0ffee00c0ffee00c0ffee00c0ffee0'; // fixed synthetic nonce; never a target identifier
export const LOCAL_BINDING = 'DB';
export const LOCAL_DATABASE = 'sikap-tx-probe-local-repro';
export const LOCAL_STAGES = Object.freeze(['precondition', 'setup', 'inspect-setup', 'positive', 'inspect-positive',
  'constraint-abort', 'inspect-constraint']);
export const LOCAL_STATUS = Object.freeze(['LOCAL_ROLLBACK_OBSERVED', 'INCONCLUSIVE', 'FAILED']);
export const LOCAL_CODES = Object.freeze(['CLI_ARGUMENTS', 'OPTIONS_INVALID', 'MINIFLARE_UNAVAILABLE', 'MINIFLARE_CONSTRUCT_FAILED',
  'BINDING_UNAVAILABLE', 'PRECONDITION_NOT_EMPTY', 'STAGE_REJECTED', 'RESPONSE_INVALID', 'RECEIPT_MISSING', 'STATE_MISMATCH',
  'CONSTRAINT_NOT_REJECTED', 'STATE_CHANGED_AFTER_CONSTRAINT', 'MESSAGE_UNCLASSIFIED', 'LOCAL_STAGE_FAILED']);
export const MAX_MESSAGE = 4096;
const FALSE_FLAGS = Object.freeze({ remoteExecuted: false, remoteEvidence: false, targetBound: false,
  transactionAtomicityVerified: false, readyForImport: false, cleanupAuthorized: false });
const DIAG_FIELDS = ['sqlMessageShape', 'sqliteSuffix', 'messageWrapper', 'sqlFamily'];
const COUNT_KEYS = Object.keys(EXPECTED_COUNTS.committed);

export class LocalReproError extends Error {
  constructor(code) { super(code); this.name = 'LocalReproError'; this.code = code; }
}
const fail = (code) => { throw new LocalReproError(code); };
// Only this module's fixed codes are ever reported; anything else (incl. kit codes, foreign errors) is LOCAL_STAGE_FAILED.
const safeCode = (e) => {
  const code = e instanceof LocalReproError ? e.code : undefined;
  return LOCAL_CODES.includes(code) ? code : 'LOCAL_STAGE_FAILED';
};
export const LOCAL_SOURCES = Object.freeze(['message', 'cause']);
export const SETUP_PHASES = Object.freeze(['miniflare-import', 'miniflare-construct', 'binding']);

// Own DATA property value only (no getters invoked, no prototype walk); any trap/throw yields undefined.
function ownValue(o, key) {
  try {
    if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return undefined;
    const d = Object.getOwnPropertyDescriptor(o, key);
    return d && 'value' in d ? d.value : undefined;
  } catch { return undefined; }
}
const boundedString = (v) => (typeof v === 'string' && v.length <= MAX_MESSAGE
  && Buffer.byteLength(v, 'utf8') <= MAX_MESSAGE ? v : undefined);

// Fixed boolean/enum LOCAL features of a bounded message (never the text, never lengths). Hypothesis aids only.
const UNIQUE_CORE = `UNIQUE constraint failed: ${DATA_TABLE}.id`;
const EXTENDED_TAIL = ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)';
// LOCAL-ONLY exact literals observed from the Miniflare 5 D1 binding (error.message carries the 'D1_ERROR: ' wrapper, its
// cause does not). Deliberately SEPARATE from the run module's 20-literal taxonomy (which does not contain the
// '(extended: ...)' form and is not modified here). An exact whole-string match counts as LOCAL recognition only; it is
// never remote proof, never feeds the remote classifier and never authorizes anything.
// Exactly the observed pair: unprefixed (error.cause.message) and 'D1_ERROR: '-prefixed (error.message). Whole-string match.
const LOCAL_LITERALS = new Map([['', 'none'], ['D1_ERROR: ', 'D1_ERROR']].map(([pre, wrapper]) => [`${pre}${UNIQUE_CORE}${EXTENDED_TAIL}`,
  Object.freeze({ localMessageShape: 'owned-id-unique-extended-primarykey', localWrapper: wrapper })]));
export const LOCAL_MESSAGE_LITERALS = Object.freeze([...LOCAL_LITERALS.keys()]);
const NO_FEATURES = Object.freeze({ d1ErrorPrefix: false, ownedIdUniqueCore: false, ownedIdUniqueAtStart: false,
  sqliteConstraintToken: 'none', code7500Tail: false, multiline: false, occurrences: 'zero', tailAfterCore: 'unknown',
  localMessageShape: 'unknown', localWrapper: 'unknown' });
const TOKENS = ['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT', 'SQLITE_ERROR'];
// Fixed enum describing the text after the first owned-id core; the tail itself is never retained or returned.
function tailShape(tail) {
  if (tail === '') return 'empty';
  if (tail === EXTENDED_TAIL) return 'colon-constraint-extended-primarykey';
  const token = TOKENS.find((t) => tail.startsWith(`: ${t}`));
  if (!token) return 'other';
  const rest = tail.slice(2 + token.length);
  return rest === '' ? 'colon-token' : rest === ' [code: 7500]' ? 'colon-token-code7500'
    : rest.startsWith(': ') ? 'colon-token-colon-extra' : rest.startsWith(' ') ? 'colon-token-space-extra' : 'colon-token-other-extra';
}
function features(m) {
  const core = m.indexOf(UNIQUE_CORE);
  const count = m.split(UNIQUE_CORE).length - 1;
  const token = TOKENS.find((t) => m.includes(t));
  const local = LOCAL_LITERALS.get(m) ?? { localMessageShape: 'other', localWrapper: 'unknown' };
  return Object.freeze({ d1ErrorPrefix: m.startsWith('D1_ERROR: '), ownedIdUniqueCore: core !== -1,
    ownedIdUniqueAtStart: core === 0 || (m.startsWith('D1_ERROR: ') && core === 'D1_ERROR: '.length),
    sqliteConstraintToken: token ?? 'none', code7500Tail: m.endsWith(' [code: 7500]'), multiline: /[\r\n]/.test(m),
    occurrences: count === 0 ? 'zero' : count === 1 ? 'one' : 'multiple',
    tailAfterCore: core === -1 ? 'unknown' : tailShape(m.slice(core + UNIQUE_CORE.length)), ...local });
}

/** In-memory only: fixed-enum features of a bounded message via the existing taxonomy. Never returns the text. */
export function classifyLocalMessage(sourceInput, message) {
  const source = LOCAL_SOURCES.includes(sourceInput) ? sourceInput : 'unknown'; // never reflects caller input
  const m = boundedString(message);
  if (m === undefined) {
    return Object.freeze({ source, available: false, sqlMessageShape: 'unknown', sqliteSuffix: 'unknown', messageWrapper: 'unknown',
      sqlFamily: 'unknown', reasonCodes: Object.freeze([]), features: NO_FEATURES, syntheticTransport: true, targetBound: false });
  }
  // SYNTHETIC transport result: not a spawn, not Wrangler output. Only the plain {text} wrapper is used (unbound).
  const d = diagnoseFailure({ status: 1, signal: null, error: undefined, stdout: JSON.stringify({ error: { text: m } }), stderr: '' }, 'constraint');
  return Object.freeze({ source, available: true, ...Object.fromEntries(DIAG_FIELDS.map((k) => [k, d[k]])),
    reasonCodes: Object.freeze([...d.reasonCodes]), features: features(m), syntheticTransport: true, targetBound: false });
}

/** Error and its own `cause` only (max two levels); own `message` data properties only. */
export function diagnoseLocalError(error) {
  const cause = ownValue(error, 'cause');
  return Object.freeze([classifyLocalMessage('message', ownValue(error, 'message')),
    classifyLocalMessage('cause', ownValue(cause, 'message'))]);
}

const sets = (out) => out.map((r) => ({ results: ownValue(r, 'results'), success: ownValue(r, 'success') }));
const countsEqual = (a, b) => COUNT_KEYS.every((k) => a[k] === b[k]) && Object.keys(a).length === COUNT_KEYS.length;

function exactOptions(options) {
  if (options === undefined) return LOCAL_NONCE;
  if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype
    || Object.getOwnPropertySymbols(options).length) fail('OPTIONS_INVALID');
  const keys = Object.getOwnPropertyNames(options);
  if (keys.some((k) => k !== 'nonce')) fail('OPTIONS_INVALID');
  const d = Object.getOwnPropertyDescriptor(options, 'nonce');
  if (d && !('value' in d)) fail('OPTIONS_INVALID');
  const nonce = d ? d.value : LOCAL_NONCE;
  if (!isNonce(nonce)) fail('OPTIONS_INVALID');
  return nonce;
}

/**
 * Runs precondition -> setup -> inspect -> positive -> inspect -> constraint-abort -> inspect on a fresh local Miniflare
 * D1 binding and returns a sanitized report. Options: undefined or exactly { nonce: <32 lowercase hex> }.
 */
export async function reproduceLocalConstraint(options) {
  const nonce = exactOptions(options);
  const kit = createProbeKit({ nonce });
  const phase = (id) => kit.phases.find((p) => p.id === id);
  const report = { schemaVersion: 1, local: true, transport: LOCAL_TRANSPORT, status: 'FAILED', ok: false, exitCode: 2,
    stages: [], failedStage: null, constraintAttempted: false, constraintRejected: false, positiveReceiptVerified: false,
    postFailureCounts: null, stateUnchangedAfterConstraint: false, runTaxonomyMatched: false, localLiteralMatched: false,
    expectedConstraintMessageRecognized: false, messageCounts: null,
    localRollbackObserved: false, localReproductionCompleted: false, diagnosticSources: [], warnings: [], codes: [],
    miniflareConstructed: false, disposed: false, ...FALSE_FLAGS };

  let mod;
  try { mod = await import('miniflare'); } catch {
    report.failedStage = 'miniflare-import'; report.codes.push('MINIFLARE_UNAVAILABLE'); return finalizeLocalReport(report);
  }
  let mf;
  try {
    const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = mod;
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
      outboundService: () => new Response(null, { status: 403 }), log: new Log(LogLevel.NONE),
      cf: false, telemetry: { enabled: false }, d1Databases: { [LOCAL_BINDING]: LOCAL_DATABASE },
    }));
    report.miniflareConstructed = true;
  } catch {
    report.failedStage = 'miniflare-construct'; report.codes.push('MINIFLARE_CONSTRUCT_FAILED'); return finalizeLocalReport(report);
  }

  let stage = 'binding';
  try {
    let db;
    try { db = await mf.getD1Database(LOCAL_BINDING); } catch { fail('BINDING_UNAVAILABLE'); }
    stage = null;
    const batch = async (id) => sets(await db.batch(phase(id).statements.map((s) => db.prepare(s))));
    const step = async (id, fn) => { stage = id; await fn(); report.stages.push({ id, passed: true }); stage = null; };
    const write = async (id) => { try { return await batch(id); } catch { return fail('STAGE_REJECTED'); } };
    const inspect = async (expected) => {
      let a;
      try { a = analyseProbeRead('inspect', await batch('inspect')); } catch (e) { fail(e instanceof ProbeKitError ? 'RESPONSE_INVALID' : 'STAGE_REJECTED'); }
      const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, a.counts[k]]));
      const schemaExact = a.schema.ownedTablesExact === true && a.schema.objectCount === 2 && a.ownershipMatches === true;
      return { counts, schemaExact, countsExact: countsEqual({ ...a.counts }, expected), foreignObjectCount: a.schema.foreignObjectCount,
        ddlMatches: a.schema.ddlMatches };
    };

    await step('precondition', async () => {
      let a;
      try { a = analysePrecondition(await batch('precondition')); } catch { fail('RESPONSE_INVALID'); }
      if (a.setupCandidate !== true || a.objectCount !== 0) fail('PRECONDITION_NOT_EMPTY');
    });
    await step('setup', async () => {
      const r = await write('setup');
      if (r.length !== 3 || r.some((s) => s.success !== true)) fail('RESPONSE_INVALID');
    });
    await step('inspect-setup', async () => {
      const i = await inspect(EXPECTED_COUNTS.setup);
      if (!i.countsExact || !i.schemaExact) fail('STATE_MISMATCH');
    });
    await step('positive', async () => {
      const r = await write('positive');
      if (r.length !== 3 || r.some((s) => s.success !== true)) fail('RESPONSE_INVALID');
      const rows = r[2].results;
      if (!Array.isArray(rows) || rows.length !== 1 || ownValue(rows[0], 'receipt_guard') !== 1
        || Object.keys(rows[0]).length !== 1) fail('RECEIPT_MISSING');
      report.positiveReceiptVerified = true;
    });
    await step('inspect-positive', async () => {
      const i = await inspect(EXPECTED_COUNTS.committed);
      if (!i.countsExact || !i.schemaExact) fail('STATE_MISMATCH');
    });
    await step('constraint-abort', async () => {
      report.constraintAttempted = true;
      let caught = false, error;
      try { await batch('constraint-abort'); } catch (e) { caught = true; error = e; }
      if (!caught) fail('CONSTRAINT_NOT_REJECTED');
      report.constraintRejected = true;
      report.diagnosticSources = diagnoseLocalError(error); // in memory; the error object is dropped here
    });
    await step('inspect-constraint', async () => {
      const i = await inspect(EXPECTED_COUNTS.committed);
      report.postFailureCounts = Object.freeze({ ...i.counts, schemaExact: i.schemaExact, ddlMatches: i.ddlMatches,
        foreignObjectCount: i.foreignObjectCount });
      report.stateUnchangedAfterConstraint = i.countsExact && i.schemaExact && i.counts.marker_step === 1;
      if (!report.stateUnchangedAfterConstraint) fail('STATE_CHANGED_AFTER_CONSTRAINT');
    });
    report.localReproductionCompleted = true;
  } catch (e) {
    report.failedStage = stage;
    report.codes.push(safeCode(e));
  } finally {
    try { await mf.dispose(); report.disposed = true; } catch { report.disposed = false; }
  }
  return finalizeLocalReport(report);
}

/** Pure: derives status/flags from collected observations. Exported for state-logic tests only; never proof. */
export function finalizeLocalReport(report) {
  const available = report.diagnosticSources.filter((s) => s.available);
  // Recognition = any available source whole-string equal to one of the run module's 20 exact literals (via diagnoseFailure)
  // OR to the exact observed local pair (LOCAL_MESSAGE_LITERALS). Substring/core/token features never count.
  const isRun = (s) => s.sqlMessageShape === 'owned-id-unique';
  const isLocal = (s) => s.features.localMessageShape === 'owned-id-unique-extended-primarykey';
  report.runTaxonomyMatched = report.constraintRejected && available.some(isRun);
  report.localLiteralMatched = report.constraintRejected && available.some(isLocal);
  report.expectedConstraintMessageRecognized = report.runTaxonomyMatched || report.localLiteralMatched;
  const stagesExact = Array.isArray(report.stages) && report.stages.length === LOCAL_STAGES.length
    && report.stages.every((s, i) => s !== null && typeof s === 'object' && s.id === LOCAL_STAGES[i] && s.passed === true);
  report.localRollbackObserved = report.localReproductionCompleted === true && stagesExact && report.postFailureCounts !== null
    && report.positiveReceiptVerified === true && report.constraintRejected === true
    && report.stateUnchangedAfterConstraint === true && report.expectedConstraintMessageRecognized === true;
  report.messageCounts = Object.freeze({ sources: report.diagnosticSources.length, available: available.length,
    runTaxonomyMatched: available.filter(isRun).length, localLiteralMatched: available.filter(isLocal).length,
    unclassified: available.filter((s) => !isRun(s) && !isLocal(s)).length });
  if (report.localReproductionCompleted && !report.expectedConstraintMessageRecognized) report.warnings.push('MESSAGE_UNCLASSIFIED');
  report.status = report.localRollbackObserved ? 'LOCAL_ROLLBACK_OBSERVED' : report.localReproductionCompleted ? 'INCONCLUSIVE' : 'FAILED';
  report.ok = report.localRollbackObserved;
  report.exitCode = report.ok ? 0 : 2;
  Object.assign(report, FALSE_FLAGS);
  report.stages = Object.freeze(report.stages.map((s) => Object.freeze(s)));
  report.diagnosticSources = Object.freeze([...report.diagnosticSources]);
  return Object.freeze(report);
}

/** CLI: exactly one argument `--local-only`; anything else is refused before Miniflare is loaded. */
export async function main(argv = process.argv.slice(2), write = (line) => process.stdout.write(`${line}\n`)) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== LOCAL_FLAG) {
    write(JSON.stringify({ local: true, transport: LOCAL_TRANSPORT, status: 'FAILED', ok: false, exitCode: 1, codes: ['CLI_ARGUMENTS'],
      constraintAttempted: false, ...FALSE_FLAGS }));
    return 1;
  }
  try {
    const report = await reproduceLocalConstraint();
    write(JSON.stringify(report));
    return report.exitCode;
  } catch (e) {
    write(JSON.stringify({ local: true, transport: LOCAL_TRANSPORT, status: 'FAILED', ok: false, exitCode: 1, codes: [safeCode(e)],
      ...FALSE_FLAGS }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
