import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  classifyLocalMessage, diagnoseLocalError, finalizeLocalReport, LOCAL_CODES, LOCAL_FLAG, LOCAL_MESSAGE_LITERALS, LOCAL_NONCE,
  LOCAL_SOURCES, LOCAL_STAGES, LOCAL_TRANSPORT, LocalReproError, main, MAX_MESSAGE, reproduceLocalConstraint, SETUP_PHASES,
} from './d1-tx-probe-local.mjs';
import { DATA_TABLE, MARKER_TABLE, PROBE_DB_NAME, PROBE_PREFIX } from './d1-tx-probe-kit.mjs';
import { DIAGNOSTIC_TAXONOMY_LITERALS } from './d1-tx-probe-run.mjs';
import { PROBE_ACCOUNT_ID, PROBE_DATABASE_ID } from './d1-tx-probe-target.mjs';
import { UAT_ACCOUNT, UAT_DB } from './uat-constants.mjs';

const exitCodeAtImport = process.exitCode;
const SOURCE_URL = new URL('./d1-tx-probe-local.mjs', import.meta.url);
const SECRET = 'TOPSECRET-cf-token-should-never-echo';
const OTHER_NONCE = 'fedcba9876543210fedcba9876543210';
const CORE = `UNIQUE constraint failed: ${DATA_TABLE}.id`;
const OBSERVED_CAUSE = `${CORE}: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)`;
const FALSE_FLAGS = ['remoteExecuted', 'remoteEvidence', 'targetBound', 'transactionAtomicityVerified', 'readyForImport', 'cleanupAuthorized'];
const REPORT_KEYS = ['schemaVersion', 'local', 'transport', 'status', 'ok', 'exitCode', 'stages', 'failedStage', 'constraintAttempted',
  'constraintRejected', 'positiveReceiptVerified', 'postFailureCounts', 'stateUnchangedAfterConstraint', 'runTaxonomyMatched',
  'localLiteralMatched', 'expectedConstraintMessageRecognized', 'messageCounts', 'localRollbackObserved', 'localReproductionCompleted',
  'diagnosticSources', 'warnings', 'codes', 'miniflareConstructed', 'disposed', ...FALSE_FLAGS];
const SOURCE_KEYS = ['source', 'available', 'sqlMessageShape', 'sqliteSuffix', 'messageWrapper', 'sqlFamily', 'reasonCodes', 'features',
  'syntheticTransport', 'targetBound'];
const FEATURE_KEYS = ['d1ErrorPrefix', 'ownedIdUniqueCore', 'ownedIdUniqueAtStart', 'sqliteConstraintToken', 'code7500Tail', 'multiline',
  'occurrences', 'tailAfterCore', 'localMessageShape', 'localWrapper'];
const COUNTS = { marker_rows: 1, marker_owned: 1, marker_step: 1, data_total: 3, data_foreign: 0, data_positive: 3, data_fail_guard: 0,
  data_fail_constraint: 0, data_trailing: 0, schemaExact: true, ddlMatches: true, foreignObjectCount: 0 };
const FORBIDDEN_OUTPUT = [CORE, 'UNIQUE constraint', 'D1_ERROR:', 'extended:', PROBE_PREFIX, DATA_TABLE, MARKER_TABLE, PROBE_DB_NAME,
  PROBE_DATABASE_ID, PROBE_ACCOUNT_ID, UAT_ACCOUNT, UAT_DB, 'sikap-tx-probe-local-repro', LOCAL_NONCE, OTHER_NONCE, 'SELECT ', 'INSERT ',
  'CREATE ', 'DROP ', 'UPDATE ', 'stack', 'at file:', 'node_modules', '127.0.0.1', SECRET];

const assertFlagsFalse = (o) => { for (const f of FALSE_FLAGS) assert.equal(o[f], false, f); };
const assertNoLeak = (value) => {
  const text = JSON.stringify(value);
  for (const s of FORBIDDEN_OUTPUT) assert.ok(!text.includes(s), `output leaks ${s}`);
};
const assertSource = (s) => {
  assert.deepEqual(Object.keys(s), SOURCE_KEYS);
  assert.deepEqual(Object.keys(s.features), FEATURE_KEYS);
  assert.equal(s.syntheticTransport, true); assert.equal(s.targetBound, false);
};

// Current OBSERVED local facts (Miniflare 5 binding): both sources equal the exact local pair, none equals a run literal.
function assertObservedReport(r, inProcess = true) {
  assert.deepEqual(Object.keys(r), REPORT_KEYS);
  if (inProcess) assert.ok(Object.isFrozen(r));
  assert.equal(r.local, true); assert.equal(r.transport, LOCAL_TRANSPORT);
  assert.equal(r.status, 'LOCAL_ROLLBACK_OBSERVED'); assert.equal(r.ok, true); assert.equal(r.exitCode, 0);
  assert.deepEqual(r.stages.map((s) => s.id), [...LOCAL_STAGES]);
  assert.ok(r.stages.every((s) => s.passed === true && Object.keys(s).join() === 'id,passed'));
  assert.equal(r.failedStage, null);
  for (const k of ['constraintAttempted', 'constraintRejected', 'positiveReceiptVerified', 'stateUnchangedAfterConstraint',
    'localLiteralMatched', 'expectedConstraintMessageRecognized', 'localRollbackObserved', 'localReproductionCompleted',
    'miniflareConstructed', 'disposed']) assert.equal(r[k], true, k);
  assert.equal(r.runTaxonomyMatched, false);
  assert.deepEqual({ ...r.postFailureCounts }, COUNTS);
  assert.deepEqual(r.codes, []); assert.deepEqual(r.warnings, []);
  assert.deepEqual({ ...r.messageCounts }, { sources: 2, available: 2, runTaxonomyMatched: 0, localLiteralMatched: 2, unclassified: 0 });
  assert.deepEqual(r.diagnosticSources.map((s) => s.source), ['message', 'cause']);
  for (const s of r.diagnosticSources) {
    assertSource(s); assert.equal(s.available, true);
    assert.equal(s.sqlMessageShape, 'other'); assert.equal(s.sqlFamily, 'other');
    assert.deepEqual(s.reasonCodes, ['UNBOUND_TEXT_WRAPPER', 'MESSAGE_MISMATCH']);
    assert.equal(s.features.localMessageShape, 'owned-id-unique-extended-primarykey');
    assert.equal(s.features.tailAfterCore, 'colon-constraint-extended-primarykey');
  }
  assert.deepEqual(r.diagnosticSources.map((s) => s.features.localWrapper), ['D1_ERROR', 'none']);
  assertFlagsFalse(r);
  assertNoLeak(r);
}

// ---------------------------------------------------------------------------------------------
// ACTUAL local Miniflare D1 binding (loopback, port 0, in-memory, outbound 403). Not remote proof.
// ---------------------------------------------------------------------------------------------
test('ACTUAL local Miniflare run: constraint rejected, state unchanged, sanitized exact schema', { timeout: 120000 }, async () => {
  assertObservedReport(await reproduceLocalConstraint());
});

test('ACTUAL local Miniflare run with injected strict nonce yields the same sanitized result', { timeout: 120000 }, async () => {
  assertObservedReport(await reproduceLocalConstraint({ nonce: OTHER_NONCE }));
});

test('ACTUAL CLI path via exported main with captured writer: exactly --local-only', { timeout: 120000 }, async () => {
  const lines = [];
  const exit = await main([LOCAL_FLAG], (l) => lines.push(l));
  assert.equal(lines.length, 1);
  const r = JSON.parse(lines[0]);
  assertObservedReport(r, false);
  assert.equal(exit, 0);
});

test('CLI refuses anything except exactly --local-only, before Miniflare, error code only', async () => {
  const bad = [[], ['--remote'], ['--local-only', '--remote'], ['--remote', '--local-only'], ['--local-only', '--local-only'],
    ['--cleanup'], ['--local-only', '--cleanup'], ['--run-synthetic-probe'], ['--run-synthetic-probe', '--confirm-database-id', PROBE_DATABASE_ID],
    ['--LOCAL-ONLY'], ['--local-only=1'], [' --local-only'], ['--local-only', '--nonce', OTHER_NONCE], ['--local-only', 'SELECT 1'],
    ['--local-only', `--persist=${SECRET}`], ['--local-only', '--config', 'ops/tx-probe/wrangler.toml'], 'not-an-array', null];
  for (const argv of bad) {
    const lines = [];
    const started = Date.now();
    assert.equal(await main(argv, (l) => lines.push(l)), 1, String(argv));
    assert.ok(Date.now() - started < 1000, 'no runtime started');
    assert.equal(lines.length, 1);
    const out = JSON.parse(lines[0]);
    assert.deepEqual(out, { local: true, transport: LOCAL_TRANSPORT, status: 'FAILED', ok: false, exitCode: 1, codes: ['CLI_ARGUMENTS'],
      constraintAttempted: false, remoteExecuted: false, remoteEvidence: false, targetBound: false, transactionAtomicityVerified: false,
      readyForImport: false, cleanupAuthorized: false });
    assertNoLeak(out);
  }
});

test('options: only undefined or exact { nonce: 32 lowercase hex }; refused before Miniflare without echo', async () => {
  const bad = [null, [], 'x', { nonce: 'X' }, { nonce: OTHER_NONCE.toUpperCase() }, { nonce: `${OTHER_NONCE.slice(0, 31)}'` },
    { nonce: OTHER_NONCE, sql: 'DROP TABLE x' }, { nonce: OTHER_NONCE, databaseId: PROBE_DATABASE_ID }, { remote: true },
    { persist: SECRET }, Object.defineProperty({}, 'nonce', { get: () => OTHER_NONCE, enumerable: true }),
    Object.assign(Object.create({ inherited: 1 }), { nonce: OTHER_NONCE }), { [Symbol('x')]: 1, nonce: OTHER_NONCE }];
  for (const options of bad) {
    await assert.rejects(reproduceLocalConstraint(options),
      (e) => e instanceof LocalReproError && e.code === 'OPTIONS_INVALID' && e.message === 'OPTIONS_INVALID' && !e.message.includes(SECRET));
  }
});

test('classifyLocalMessage: source whitelisted, exact whole-string literals only, bounded, never returns the text', () => {
  for (const src of ['other', SECRET, '', null, undefined, 1, {}, 'Message', 'cause ']) {
    const s = classifyLocalMessage(src, OBSERVED_CAUSE);
    assert.equal(s.source, 'unknown'); assertNoLeak(s);
  }
  assert.equal(classifyLocalMessage('message', 'x').source, 'message'); assert.equal(classifyLocalMessage('cause', 'x').source, 'cause');
  assert.deepEqual([...LOCAL_MESSAGE_LITERALS], [OBSERVED_CAUSE, `D1_ERROR: ${OBSERVED_CAUSE}`]);
  for (const literal of LOCAL_MESSAGE_LITERALS) {
    assert.ok(!DIAGNOSTIC_TAXONOMY_LITERALS.includes(literal), 'local literals are separate from the run taxonomy');
    const s = classifyLocalMessage('message', literal);
    assertSource(s); assert.equal(s.features.localMessageShape, 'owned-id-unique-extended-primarykey');
    assert.equal(s.sqlMessageShape, 'other'); assertNoLeak(s);
  }
  // A run-taxonomy literal is recognised by diagnoseFailure, not by the local literal set.
  const run = classifyLocalMessage('cause', `D1_ERROR: ${CORE}: SQLITE_CONSTRAINT_PRIMARYKEY`);
  assert.equal(run.sqlMessageShape, 'owned-id-unique'); assert.equal(run.messageWrapper, 'D1_ERROR');
  assert.equal(run.sqliteSuffix, 'SQLITE_CONSTRAINT_PRIMARYKEY'); assert.equal(run.features.localMessageShape, 'other');
  assert.equal(run.targetBound, false); assert.ok(run.reasonCodes.includes('UNBOUND_TEXT_WRAPPER'));
  // Near misses: no trim/casefold/substring acceptance.
  for (const near of [` ${OBSERVED_CAUSE}`, `${OBSERVED_CAUSE}\n`, OBSERVED_CAUSE.toLowerCase(), `${OBSERVED_CAUSE} ${SECRET}`,
    `${SECRET} ${OBSERVED_CAUSE}`, OBSERVED_CAUSE.replace(DATA_TABLE, MARKER_TABLE), `${OBSERVED_CAUSE}${OBSERVED_CAUSE}`,
    `${OBSERVED_CAUSE} [code: 7500]`, `D1_ERROR: ${OBSERVED_CAUSE} [code: 7500]`, `D1_ERROR: D1_ERROR: ${OBSERVED_CAUSE}`]) {
    const s = classifyLocalMessage('message', near);
    assert.equal(s.available, true); assert.equal(s.features.localMessageShape, 'other'); assert.equal(s.sqlMessageShape, 'other');
    assertNoLeak(s);
  }
  // Oversize (chars or UTF-8 bytes) and non-strings are unavailable with fixed unknown fields.
  for (const v of [`${OBSERVED_CAUSE}${'x'.repeat(MAX_MESSAGE)}`, 'é'.repeat(MAX_MESSAGE / 2 + 1), undefined, null, 42, {}, ['x']]) {
    const s = classifyLocalMessage('cause', v);
    assertSource(s); assert.equal(s.available, false); assert.equal(s.sqlMessageShape, 'unknown');
    assert.equal(s.features.localMessageShape, 'unknown'); assert.deepEqual(s.reasonCodes, []);
  }
  assert.equal(classifyLocalMessage('message', 'é'.repeat(MAX_MESSAGE / 2)).available, true);
});

test('diagnoseLocalError: own data properties only, max two levels, hostile objects never invoked or echoed', () => {
  let invoked = 0;
  const getterError = new Error('x');
  Object.defineProperty(getterError, 'message', { get() { invoked++; return OBSERVED_CAUSE; } });
  Object.defineProperty(getterError, 'cause', { get() { invoked++; return { message: OBSERVED_CAUSE }; } });
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET); }, get() { throw new Error(SECRET); } });
  const deep = Object.assign(new Error(SECRET), { cause: { message: 42, cause: { message: OBSERVED_CAUSE } } });
  const inherited = Object.create({ message: OBSERVED_CAUSE, cause: { message: OBSERVED_CAUSE } });
  for (const e of [getterError, hostile, deep, inherited, undefined, null, OBSERVED_CAUSE, 7]) {
    const out = diagnoseLocalError(e);
    assert.deepEqual(out.map((s) => s.source), ['message', 'cause']);
    assert.equal(out[1].available, false, 'cause.cause and non-own values are never read');
    assert.equal(out[1].features.localMessageShape, 'unknown');
    assertNoLeak(out);
  }
  assert.equal(invoked, 0, 'getters were never invoked');
  const real = new Error(`D1_ERROR: ${OBSERVED_CAUSE}`, { cause: new Error(OBSERVED_CAUSE) });
  const out = diagnoseLocalError(real);
  assert.deepEqual(out.map((s) => s.features.localWrapper), ['D1_ERROR', 'none']);
  assertNoLeak(out);
});

const baseReport = (over) => ({ schemaVersion: 1, local: true, transport: LOCAL_TRANSPORT, status: 'FAILED', ok: false, exitCode: 2,
  stages: LOCAL_STAGES.map((id) => ({ id, passed: true })), failedStage: null, constraintAttempted: true, constraintRejected: true,
  positiveReceiptVerified: true, postFailureCounts: { ...COUNTS }, stateUnchangedAfterConstraint: true, runTaxonomyMatched: true, localLiteralMatched: true,
  expectedConstraintMessageRecognized: true, messageCounts: null, localRollbackObserved: true, localReproductionCompleted: true,
  diagnosticSources: [], warnings: [], codes: [], miniflareConstructed: true, disposed: true, remoteExecuted: true,
  remoteEvidence: true, targetBound: true, transactionAtomicityVerified: true, readyForImport: true, cleanupAuthorized: true, ...over });

test('finalizeLocalReport: exact run-20 OR exact local pair, plus all state preconditions; unknown is INCONCLUSIVE', () => {
  const unknown = finalizeLocalReport(baseReport({ diagnosticSources: diagnoseLocalError(new Error(SECRET, { cause: new Error(SECRET) })) }));
  assert.equal(unknown.status, 'INCONCLUSIVE'); assert.equal(unknown.localRollbackObserved, false); assert.equal(unknown.ok, false);
  assert.equal(unknown.exitCode, 2); assert.deepEqual(unknown.warnings, ['MESSAGE_UNCLASSIFIED']);
  assert.equal(unknown.runTaxonomyMatched, false); assert.equal(unknown.localLiteralMatched, false);
  assert.deepEqual({ ...unknown.messageCounts }, { sources: 2, available: 2, runTaxonomyMatched: 0, localLiteralMatched: 0, unclassified: 2 });
  assertFlagsFalse(unknown); assertNoLeak(unknown);

  // Substring/core/token features alone never recognise (contains core + token, not an exact literal).
  const near = finalizeLocalReport(baseReport({ diagnosticSources: diagnoseLocalError(new Error(`x ${OBSERVED_CAUSE}`)) }));
  assert.equal(near.status, 'INCONCLUSIVE'); assert.equal(near.expectedConstraintMessageRecognized, false);

  const missing = finalizeLocalReport(baseReport({ diagnosticSources: diagnoseLocalError({}) }));
  assert.equal(missing.status, 'INCONCLUSIVE'); assert.equal(missing.expectedConstraintMessageRecognized, false);

  const observed = diagnoseLocalError(new Error(`D1_ERROR: ${OBSERVED_CAUSE}`, { cause: new Error(OBSERVED_CAUSE) }));
  const local = finalizeLocalReport(baseReport({ diagnosticSources: observed }));
  assert.equal(local.status, 'LOCAL_ROLLBACK_OBSERVED'); assert.equal(local.exitCode, 0); assert.deepEqual(local.warnings, []);
  assert.equal(local.localLiteralMatched, true); assert.equal(local.runTaxonomyMatched, false);
  assertFlagsFalse(local); assert.ok(Object.isFrozen(local));

  const run = finalizeLocalReport(baseReport({ diagnosticSources: diagnoseLocalError(new Error(`D1_ERROR: ${CORE}: SQLITE_CONSTRAINT_PRIMARYKEY`)) }));
  assert.equal(run.status, 'LOCAL_ROLLBACK_OBSERVED'); assert.equal(run.runTaxonomyMatched, true); assert.equal(run.localLiteralMatched, false);
  assert.deepEqual({ ...run.messageCounts }, { sources: 2, available: 1, runTaxonomyMatched: 1, localLiteralMatched: 0, unclassified: 0 });

  // Every precondition must hold even with an exactly recognised message.
  for (const [over, status] of [[{ positiveReceiptVerified: false }, 'INCONCLUSIVE'], [{ stateUnchangedAfterConstraint: false }, 'INCONCLUSIVE'],
    [{ constraintRejected: false }, 'INCONCLUSIVE'],
    [{ localReproductionCompleted: false, failedStage: 'inspect-constraint', codes: ['STATE_CHANGED_AFTER_CONSTRAINT'] }, 'FAILED']]) {
    const r = finalizeLocalReport(baseReport({ diagnosticSources: observed, ...over }));
    assert.equal(r.localRollbackObserved, false, JSON.stringify(over)); assert.equal(r.status, status); assert.equal(r.ok, false);
    assertFlagsFalse(r);
  }

  // Exact stage order and post-failure counts are required even when completed/recognised flags are all true.
  const all = LOCAL_STAGES.map((id) => ({ id, passed: true }));
  for (const over of [{ stages: all.slice(0, -1) }, { stages: all.filter((s) => s.id !== 'positive') }, { stages: [] },
    { stages: [all[1], all[0], ...all.slice(2)] }, { stages: [...all.slice(0, -1), { id: 'inspect-constraint', passed: false }] },
    { stages: [...all, { id: 'inspect-constraint', passed: true }] }, { stages: [...all.slice(0, -1), { id: 'cleanup-data', passed: true }] },
    { stages: [...all.slice(0, -1), null] }, { postFailureCounts: null }]) {
    const r = finalizeLocalReport(baseReport({ diagnosticSources: observed, ...over }));
    assert.equal(r.localReproductionCompleted, true); assert.equal(r.expectedConstraintMessageRecognized, true);
    assert.equal(r.localRollbackObserved, false, JSON.stringify(over)); assert.equal(r.status, 'INCONCLUSIVE');
    assert.equal(r.ok, false); assert.equal(r.exitCode, 2); assertFlagsFalse(r);
  }
});
test('source: proven Miniflare 5 adapter, loopback/port 0/no persistence, no env/spawn/remote/run executor', async () => {
  const src = await readFile(SOURCE_URL, 'utf8');
  for (const required of ["await import('miniflare')", 'new Miniflare(convertV4MiniflareOptions({', "modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,",
    'outboundService: () => new Response(null, { status: 403 }), log: new Log(LogLevel.NONE),',
    'cf: false, telemetry: { enabled: false }, d1Databases: { [LOCAL_BINDING]: LOCAL_DATABASE },',
    'await mf.dispose()', "process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href",
    "import { diagnoseFailure, EXPECTED_COUNTS } from './d1-tx-probe-run.mjs';"]) {
    assert.ok(src.includes(required), required);
  }
  // Executable code only: block comments, whole-line comments and trailing ` // ` comments are stripped first.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//'))
    .map((l) => l.replace(/ \/\/ .*$/, '')).join('\n');
  assert.ok(code.length > 5000);
  for (const forbidden of ['process.env', 'child_process', 'spawn', 'runSyntheticProbe', 'verifyWranglerInstall', 'readSourceConfig',
    'd1-tx-probe-target', 'deploy-uat-app', 'persist', 'r2Buckets', 'migrations', 'wrangler.toml', '--remote', 'renderPhaseCommand',
    "'cleanup-data'", "'cleanup-marker'", 'DROP', 'node:fs', 'console.', '.stack', 'readFile', 'writeFile']) {
    assert.ok(!code.includes(forbidden), `source must not contain ${forbidden}`);
  }
  assert.equal(exitCodeAtImport, process.exitCode, 'import performs no CLI work');
  // Fixed vocabularies: safeCode whitelist only, fixed setup failure phases, whitelisted sources.
  assert.ok(src.includes("return LOCAL_CODES.includes(code) ? code : 'LOCAL_STAGE_FAILED';"));
  assert.ok(!src.includes('/^[A-Z][A-Z0-9_]{2,63}$/'), 'no uppercase-regex code passthrough');
  assert.deepEqual([...SETUP_PHASES], ['miniflare-import', 'miniflare-construct', 'binding']);
  for (const [phase, c] of [['miniflare-import', 'MINIFLARE_UNAVAILABLE'], ['miniflare-construct', 'MINIFLARE_CONSTRUCT_FAILED']]) {
    assert.ok(src.includes(`report.failedStage = '${phase}'; report.codes.push('${c}');`), phase); assert.ok(LOCAL_CODES.includes(c));
  }
  assert.ok(src.includes("let stage = 'binding';") && LOCAL_CODES.includes('BINDING_UNAVAILABLE'));
  assert.deepEqual([...LOCAL_SOURCES], ['message', 'cause']);
});

test('existing classifier/kit modules unchanged and run taxonomy still has 20 literals', async () => {
  const sha = async (name) => createHash('sha256').update((await readFile(new URL(name, import.meta.url), 'utf8')).replaceAll('\r\n', '\n')).digest('hex');
  // Full run-module pin updated only for the intended v3 diagnostic (sqliteExtendedCode); classifier body pinned separately.
  assert.equal(await sha('./d1-tx-probe-run.mjs'), '02c5c4882b50c995d79dbd793f495a9be1394993778cc1de5dd98d199782c6a3');
  const runSrc = (await readFile(new URL('./d1-tx-probe-run.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const start = runSrc.indexOf('export function classifyFailure');
  assert.equal(createHash('sha256').update(runSrc.slice(start, runSrc.indexOf('\n}\n', start) + 3)).digest('hex'),
    '1ea79c1fe5cbdeb88f4c3a767bae1902922e155fc5d6d8aeada4c35d95eeb753');
  assert.equal(await sha('./d1-tx-probe-kit.mjs'), 'c669cbc78942421bd24694dd2c8e18d11cd1b6baeda6fc42ce45debc842af29b');
  assert.equal(DIAGNOSTIC_TAXONOMY_LITERALS.length, 20);
});
