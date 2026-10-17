// All spawns are mocked: no Wrangler process, network or remote call happens in these tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFailure, CONFIRM_FLAG, diagnoseFailure, DIAGNOSTIC_EXTENDED_LITERALS, DIAGNOSTIC_REASON_CODES, DIAGNOSTIC_TAXONOMY_LITERALS,
  EXECUTED_PHASES, main,
  parseArgs, RUN_FLAG, runSyntheticProbe, SPAWN_TIMEOUT_MS, SQL_ERROR_PATTERNS, STEPS,
} from './d1-tx-probe-run.mjs';
import { createProbeKit, DATA_DDL, DATA_TABLE, MARKER_DDL, MARKER_TABLE, renderPhaseCommand } from './d1-tx-probe-kit.mjs';
import {
  PROBE_ACCOUNT_ID, PROBE_BINDING, PROBE_CONFIG_PATH, PROBE_CONFIG_SHA256, PROBE_DATABASE_ID, PROBE_DATABASE_NAME,
} from './d1-tx-probe-target.mjs';
import { defaultTmpRoot, WRANGLER_BIN } from './deploy-uat-app.mjs';
import { MIN_NODE_MAJOR, NODE_ARGS, ROOT, verifyWranglerInstall, WRANGLER_CLI } from './d1-tx-probe-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(path.join(here, '../..', PROBE_CONFIG_PATH), 'utf8').replaceAll('\r\n', '\n');
const NONCE = '0123456789abcdef0123456789abcdef';
const SECRET = 'TOPSECRET-provider-token-sentinel';
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
const KIT = createProbeKit({ nonce: NONCE });
// precondition and final-precondition render identical SQL; only executed phases are mapped.
const SQL = Object.fromEntries(KIT.phases.filter((p) => EXECUTED_PHASES.includes(p.id)).map((p) => [renderPhaseCommand(p).sql, p.id]));
const CONFIRM = Object.freeze({ databaseId: PROBE_DATABASE_ID });
const ARGV = [RUN_FLAG, CONFIRM_FLAG, PROBE_DATABASE_ID];
const QUERY_TEXT = `A request to the Cloudflare API (/accounts/${PROBE_ACCOUNT_ID}/d1/database/${PROBE_DATABASE_ID}/query) failed.`;
const PREFIX = ['--no-warnings', WRANGLER_CLI];
const scratch = mkdtempSync(path.join(defaultTmpRoot(), 'sikap-probe-run-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let seq = 0;

function workspace() {
  const id = ++seq;
  const base = path.join(scratch, `base${id}`);
  const tmpRoot = path.join(scratch, `tmp${id}`);
  mkdirSync(path.join(base, 'ops', 'tx-probe'), { recursive: true });
  mkdirSync(tmpRoot);
  const configPath = path.join(base, ...PROBE_CONFIG_PATH.split('/'));
  writeFileSync(configPath, CONFIG.replaceAll('\n', '\r\n'));
  return { base, tmpRoot, configPath };
}
const env = () => ({ CLOUDFLARE_ACCOUNT_ID: PROBE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: SECRET, PATH: process.env.PATH ?? '',
  NODE_OPTIONS: '--require evil.js', CLOUDFLARE_API_BASE_URL: 'https://evil.invalid', CLOUDFLARE_ENV: 'production',
  WRANGLER_LOG: 'debug', HTTPS_PROXY: 'http://evil.invalid', CI: 'false', cloudflare_account_id: 'deadbeef' });

const ok = (stdout) => ({ status: 0, signal: null, stdout, stderr: '' });
const sets = (...rows) => JSON.stringify(rows.map((results) => ({ results, success: true, meta: { duration: 1, served_by: 'x' } })));
const countsRow = (step, positive, extra = {}) => ({ marker_rows: 1, marker_owned: 1, marker_step: step, data_total: positive,
  data_foreign: 0, data_positive: positive, data_fail_guard: 0, data_fail_constraint: 0, data_trailing: 0, ...extra });
const SCHEMA = [{ type: 'table', name: DATA_TABLE, tbl_name: DATA_TABLE, sql: DATA_DDL },
  { type: 'table', name: MARKER_TABLE, tbl_name: MARKER_TABLE, sql: MARKER_DDL }];
const apiError = (note, extra = {}) => JSON.stringify({ error: { text: QUERY_TEXT, notes: [{ text: note }], kind: 'error',
  name: 'APIError', code: 7500, accountTag: PROBE_ACCOUNT_ID, ...extra } }, null, 2);
const sqlFail = (note, extra) => ({ status: 1, signal: null, stdout: apiError(note, extra), stderr: '' });

const DEFAULT = {
  version: () => ok('4.151.0\n'),
  identity: () => ok(JSON.stringify({ uuid: PROBE_DATABASE_ID, name: PROBE_DATABASE_NAME, created_at: 'x', version: 'production',
    num_tables: 0, file_size: 12288, running_in_region: 'APAC', read_replication: { mode: 'disabled' } })),
  precondition: () => ok(sets([])),
  setup: () => ok(sets([], [], [])),
  'inspect-setup': () => ok(sets([countsRow(0, 0)], SCHEMA)),
  positive: () => ok(sets([], [], [{ receipt_guard: 1 }])),
  'inspect-positive': () => ok(sets([countsRow(1, 3)], SCHEMA)),
  'guard-abort': () => sqlFail('malformed JSON: SQLITE_ERROR [code: 7500]'),
  'inspect-guard': () => ok(sets([countsRow(1, 3)], SCHEMA)),
  'constraint-abort': () => sqlFail(`UNIQUE constraint failed: ${DATA_TABLE}.id: SQLITE_CONSTRAINT [code: 7500]`),
  'inspect-constraint': () => ok(sets([countsRow(1, 3)], SCHEMA)),
};

function harness(overrides = {}, hooks = {}) {
  const calls = [];
  let inspects = 0;
  const spawn = (cmd, raw, opts) => {
    // Canonical Wrangler args: the fixed Node prefix ['--no-warnings', WRANGLER_CLI] is asserted then stripped.
    assert.deepEqual(raw.slice(0, 2), PREFIX);
    const args = raw.slice(2);
    let step;
    if (args.length === 1 && args[0] === '--version') step = 'version';
    else if (args[0] === 'd1' && args[1] === 'info') step = 'identity';
    else if (args[0] === 'd1' && args[1] === 'execute') {
      const phase = SQL[args[args.indexOf('--command') + 1]];
      step = phase === 'inspect' ? ['inspect-setup', 'inspect-positive', 'inspect-guard', 'inspect-constraint'][inspects++] : phase;
    }
    const cfgIndex = args.indexOf('--config');
    const cfg = cfgIndex >= 0 ? args[cfgIndex + 1] : path.join(opts.cwd, 'probe.toml');
    calls.push({ step, cmd, raw: [...raw], args, opts, configSha: sha(readFileSync(cfg, 'utf8')), cwdEntries: readdirSync(opts.cwd) });
    hooks[step]?.();
    return (overrides[step] ?? DEFAULT[step] ?? (() => { throw new Error('unknown step'); }))();
  };
  return { spawn, calls };
}
async function runWith(overrides, hooks) {
  const ws = workspace();
  const h = harness(overrides, hooks?.(ws));
  const report = await runSyntheticProbe(CONFIRM, { env: env(), spawn: h.spawn, base: ws.base, tmpRoot: ws.tmpRoot, nonce: NONCE });
  return { report, calls: h.calls, ws };
}
const noSecret = (value) => {
  const s = JSON.stringify(value);
  for (const bad of [SECRET, 'malformed', 'UNIQUE', 'evil', 'CREATE TABLE', 'served_by']) assert.ok(!s.includes(bad), bad);
};

test('parseArgs accepts only the exact flag pair with the pinned UUID', () => {
  assert.deepEqual(parseArgs(ARGV), { databaseId: PROBE_DATABASE_ID });
  for (const argv of [[], [RUN_FLAG], [RUN_FLAG, CONFIRM_FLAG], [...ARGV, '--cleanup'], [...ARGV, RUN_FLAG],
    [CONFIRM_FLAG, PROBE_DATABASE_ID, RUN_FLAG], [RUN_FLAG, CONFIRM_FLAG, PROBE_DATABASE_ID.toUpperCase()],
    [RUN_FLAG, `${CONFIRM_FLAG}=${PROBE_DATABASE_ID}`], [RUN_FLAG, CONFIRM_FLAG, ` ${PROBE_DATABASE_ID}`],
    [RUN_FLAG, CONFIRM_FLAG, '00000000-0000-0000-0000-000000000000'], [RUN_FLAG, RUN_FLAG, CONFIRM_FLAG]]) {
    assert.throws(() => parseArgs(argv), { code: 'CLI_ARGUMENTS' });
  }
});

test('CLI errors and missing confirmation/account make zero spawns', async () => {
  const ws = workspace();
  const h = harness();
  const deps = { env: env(), spawn: h.spawn, base: ws.base, tmpRoot: ws.tmpRoot, nonce: NONCE };
  const out = [];
  assert.equal(await main([...ARGV, '--extra'], deps, (l) => out.push(l)), 1);
  assert.equal(await main([RUN_FLAG, CONFIRM_FLAG, 'b8611b82-8067-4153-ae5e-d6a0b94be7a6'], deps, (l) => out.push(l)), 1);
  for (const bad of [undefined, {}, { databaseId: PROBE_DATABASE_ID.toUpperCase() }, { databaseId: PROBE_DATABASE_ID, x: 1 },
    Object.create({ databaseId: PROBE_DATABASE_ID })]) {
    await assert.rejects(runSyntheticProbe(bad, deps), { code: 'CONFIRMATION_REQUIRED' });
  }
  for (const account of [undefined, '', 'deadbeefdeadbeefdeadbeefdeadbeef', PROBE_ACCOUNT_ID.toUpperCase()]) {
    const e = { ...env(), CLOUDFLARE_ACCOUNT_ID: account };
    await assert.rejects(runSyntheticProbe(CONFIRM, { ...deps, env: e }), { code: 'PROBE_ACCOUNT_REQUIRED' });
    assert.equal(await main(ARGV, { ...deps, env: e }, (l) => out.push(l)), 1);
  }
  await assert.rejects(runSyntheticProbe(CONFIRM, { ...deps, nonce: 'abc' }), { code: 'NONCE_INVALID' });
  await assert.rejects(runSyntheticProbe(CONFIRM, { ...deps, extra: true }), { code: 'DEPENDENCIES_INVALID' });
  assert.equal(h.calls.length, 0);
  for (const line of out) { const r = JSON.parse(line); assert.equal(r.exitCode, 1); assert.equal(r.remoteExecutionAttempted, false); }
  noSecret(out);
});

test('valid mocked run: exact 11 spawns, 9 executes, isolated config copies, filtered env, sanitized report', async () => {
  const { report, calls, ws } = await runWith();
  assert.deepEqual(calls.map((c) => c.step), STEPS);
  const executes = calls.filter((c) => c.args[1] === 'execute');
  assert.equal(executes.length, 9);
  const cwds = new Set();
  for (const c of calls) {
    assert.equal(c.cmd, process.execPath);
    assert.deepEqual(c.raw.slice(0, 2), ['--no-warnings', WRANGLER_CLI]);
    assert.ok(path.isAbsolute(c.raw[1]));
    assert.ok(!c.raw.includes(WRANGLER_BIN), 'never the bin/wrangler.js wrapper');
    for (const a of process.execArgv) if (a !== '--no-warnings') assert.ok(!c.raw.includes(a), 'no inherited execArgv');
    assert.equal(c.opts.shell, false);
    assert.deepEqual(c.opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(c.opts.timeout, SPAWN_TIMEOUT_MS);
    assert.equal(c.opts.maxBuffer, 2 * 1024 * 1024);
    assert.equal(c.configSha, PROBE_CONFIG_SHA256);
    assert.deepEqual(c.cwdEntries, ['probe.toml']);
    assert.equal(path.dirname(c.opts.cwd), path.resolve(ws.tmpRoot));
    assert.ok(!c.opts.cwd.startsWith(ws.base));
    cwds.add(c.opts.cwd);
    assert.equal(existsSync(c.opts.cwd), false, 'isolated dir removed');
    const e = c.opts.env;
    assert.equal(e.CLOUDFLARE_ACCOUNT_ID, PROBE_ACCOUNT_ID);
    assert.equal(e.CI, 'true');
    for (const k of ['NODE_OPTIONS', 'CLOUDFLARE_API_BASE_URL', 'CLOUDFLARE_ENV', 'WRANGLER_LOG', 'HTTPS_PROXY', 'cloudflare_account_id']) {
      assert.ok(!(k in e), k);
    }
    if (c.step !== 'version') {
      const cfg = c.args[c.args.indexOf('--config') + 1];
      assert.equal(cfg, path.join(c.opts.cwd, 'probe.toml'));
    }
  }
  assert.equal(cwds.size, 11, 'fresh dir per spawn');
  assert.deepEqual(calls[0].raw, ['--no-warnings', WRANGLER_CLI, '--version']);
  assert.deepEqual(calls[1].raw, ['--no-warnings', WRANGLER_CLI, 'd1', 'info', PROBE_DATABASE_ID, '--config',
    path.join(calls[1].opts.cwd, 'probe.toml'), '--json']);
  assert.equal(PROBE_BINDING, 'PROBE_DB');
  for (const c of executes) {
    assert.deepEqual(c.raw, ['--no-warnings', WRANGLER_CLI, 'd1', 'execute', PROBE_BINDING, '--remote', '--config',
      path.join(c.opts.cwd, 'probe.toml'), '--command', c.args[7], '--json']);
    assert.equal(c.args.length, 9);
    assert.equal(c.args[6], '--command');
    assert.ok(!/\bDROP\b/i.test(c.raw.join(' ')));
    assert.ok(EXECUTED_PHASES.includes(SQL[c.args[7]]));
  }
  assert.deepEqual(executes.map((c) => SQL[c.args[7]]), ['precondition', 'setup', 'inspect', 'positive', 'inspect',
    'guard-abort', 'inspect', 'constraint-abort', 'inspect']);
  assert.equal(readdirSync(ws.tmpRoot).length, 0);
  assert.equal(report.exitCode, 0);
  assert.equal(report.ok, true);
  assert.equal(report.observedTransportRollback, true);
  assert.equal(report.identityVerified, true);
  assert.equal(report.wranglerVersion, '4.151.0');
  assert.equal(report.remoteExecutionAttempted, true);
  assert.equal(report.setupAttempted, true);
  assert.equal(report.stateUncertain, false);
  assert.deepEqual(report.target, { databaseName: PROBE_DATABASE_NAME, databaseId: PROBE_DATABASE_ID });
  for (const k of ['transactionAtomicityVerified', 'readyForImport', 'appliesToWorkerBatch', 'appliesToFileImport', 'cleanupAuthorized',
    'globalAtomicityClaimed']) assert.equal(report[k], false, k);
  assert.equal('remoteExecuted' in report, false);
  assert.deepEqual(report.residue, { manualCleanupRequired: true, cleanupApprovalPending: true, automaticCleanup: false,
    ownedTables: [MARKER_TABLE, DATA_TABLE] });
  assert.deepEqual(report.steps.map((s) => s.class), ['OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'EXPECTED_SQL_ERROR', 'OK',
    'EXPECTED_SQL_ERROR', 'OK']);
  assert.deepEqual(report.steps[4].counts, countsRow(0, 0));
  assert.deepEqual(report.steps[10].counts, countsRow(1, 3));
  assert.ok(report.steps.filter((s) => s.phaseId === 'inspect').every((s) => s.schemaExact && /^[0-9a-f]{64}$/.test(s.evidenceSha256)));
  assert.equal(new Set(report.steps.filter((s) => s.evidenceSha256).map((s) => s.evidenceSha256)).size, 4);
  assert.equal(report.steps[7].targetBound, true);
  assert.deepEqual(report.codes, []);
  noSecret(report);
  const out = [];
  const h = harness();
  const ws2 = workspace();
  assert.equal(await main(ARGV, { env: env(), spawn: h.spawn, base: ws2.base, tmpRoot: ws2.tmpRoot, nonce: NONCE }, (l) => out.push(l)), 0);
  assert.equal(out.length, 1);
  noSecret(out);
});

const stopsAt = (calls, step) => assert.equal(calls.at(-1).step, step);

test('version and identity mismatches stop before any SQL', async () => {
  for (const v of ['4.150.0\n', '', ' 4.151.0 extra']) {
    const { report, calls } = await runWith({ version: () => ok(v) });
    assert.equal(calls.length, 1);
    assert.equal(report.exitCode, 2);
    assert.equal(report.remoteExecutionAttempted, false);
    assert.equal(report.steps[0].class, 'VERSION_MISMATCH');
  }
  const ident = JSON.parse(DEFAULT.identity().stdout);
  for (const bad of [{ ...ident, uuid: 'b8611b82-8067-4153-ae5e-d6a0b94be7a6' }, { ...ident, name: 'sikap-uat-db' },
    { ...ident, read_replication: { mode: 'auto' } }, { ...ident, read_replication: undefined }, [ident]]) {
    const { report, calls } = await runWith({ identity: () => ok(JSON.stringify(bad)) });
    assert.equal(calls.length, 2);
    stopsAt(calls, 'identity');
    assert.equal(report.identityVerified, false);
    assert.equal(report.setupAttempted, false);
    assert.equal(report.stateUncertain, false);
    assert.equal(report.residue.manualCleanupRequired, false);
    assert.equal(report.exitCode, 2);
  }
  const { report } = await runWith({ identity: () => ({ status: 1, signal: null, stdout: '', stderr: SECRET }) });
  assert.equal(report.steps[1].class, 'UNEXPECTED_FAILURE');
  noSecret(report);
});

test('non-empty precondition refuses setup', async () => {
  const { report, calls } = await runWith({ precondition: () => ok(sets([{ type: 'table', name: 'd1_migrations' }])) });
  stopsAt(calls, 'precondition');
  assert.equal(report.steps[2].class, 'TARGET_NOT_EMPTY');
  assert.equal(report.setupAttempted, false);
  noSecret(report);
});

test('source config tamper before first spawn (zero spawns) or between spawns (stop, stateUncertain)', async () => {
  const ws = workspace();
  writeFileSync(ws.configPath, `${CONFIG}# x\n`);
  const h = harness();
  const out = [];
  assert.equal(await main(ARGV, { env: env(), spawn: h.spawn, base: ws.base, tmpRoot: ws.tmpRoot, nonce: NONCE }, (l) => out.push(l)), 1);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(JSON.parse(out[0]).codes, ['CONFIG_HASH_MISMATCH']);
  const { report, calls } = await runWith({}, (w) => ({ setup: () => writeFileSync(w.configPath, CONFIG.replace('PROBE_DB', 'PROBE_XX')) }));
  stopsAt(calls, 'setup');
  assert.equal(report.stateUncertain, true);
  assert.equal(report.observedTransportRollback, false);
  assert.ok(report.codes.includes('CONFIG_HASH_MISMATCH'));
  assert.equal(report.residue.manualCleanupRequired, true);
  assert.equal(report.exitCode, 2);
  const { report: r2 } = await runWith({}, (w) => ({ version: () => { rmSync(w.configPath); } }));
  assert.equal(r2.steps.length, 1);
  assert.equal(r2.exitCode, 2);
});

test('transport uncertainty, unexpected success, wrong SQL error and rollback mismatch never pass', async () => {
  const cases = [
    ['guard-abort', () => ({ error: Object.assign(new Error(SECRET), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM',
      stdout: '', stderr: apiError('malformed JSON') }), 'TRANSPORT_UNCERTAIN'],
    ['guard-abort', () => { throw new Error(SECRET); }, 'TRANSPORT_UNCERTAIN'],
    ['guard-abort', () => ok(sets([], [], [])), 'UNEXPECTED_SUCCESS'],
    ['guard-abort', () => sqlFail(`UNIQUE constraint failed: ${DATA_TABLE}.id`), 'UNEXPECTED_FAILURE'],
    ['guard-abort', () => ({ status: 1, signal: null, stdout: '', stderr: `not json ${SECRET} malformed JSON` }), 'UNEXPECTED_FAILURE'],
    ['constraint-abort', () => sqlFail('malformed JSON'), 'UNEXPECTED_FAILURE'],
    ['constraint-abort', () => sqlFail('UNIQUE constraint failed: other.id'), 'UNEXPECTED_FAILURE'],
    ['inspect-guard', () => ok(sets([countsRow(1, 3, { data_fail_guard: 1, data_total: 4 })], SCHEMA)), 'STATE_MISMATCH'],
    ['inspect-constraint', () => ok(sets([countsRow(1, 3, { data_trailing: 1, data_total: 4 })], SCHEMA)), 'STATE_MISMATCH'],
    ['inspect-guard', () => ok(sets([countsRow(1, 3)], [...SCHEMA, { type: 'index', name: 'x', tbl_name: DATA_TABLE, sql: 'CREATE INDEX' }])), 'STATE_MISMATCH'],
    ['positive', () => ok(sets([], [], [{ receipt_guard: 0 }])), 'RESPONSE_INVALID'],
    ['positive', () => ok(sets([], [], [{ receipt_guard: 1, extra: 1 }])), 'RESPONSE_INVALID'],
    ['positive', () => ok(sets([], [])), 'RESPONSE_INVALID'],
    ['positive', () => ok(JSON.stringify([{ results: [], success: true }, { results: [], success: true },
      { results: [{ receipt_guard: 1 }], success: true, leak: SECRET }])), 'RESPONSE_INVALID'],
    ['setup', () => ok(sets([], [{ x: 1 }], [])), 'RESPONSE_INVALID'],
    ['inspect-setup', () => ok(sets([countsRow(1, 3)], SCHEMA)), 'STATE_MISMATCH'],
    ['inspect-positive', () => ok('{'), 'RESPONSE_INVALID'],
  ];
  for (const [step, fn, cls] of cases) {
    const { report, calls, ws } = await runWith({ [step]: fn });
    stopsAt(calls, step);
    assert.equal(calls.filter((c) => c.step === step).length, 1, 'no retry');
    assert.equal(report.steps.at(-1).class, cls, `${step} ${cls}`);
    assert.equal(report.observedTransportRollback, false);
    assert.equal(report.exitCode, 2);
    assert.equal(report.stateUncertain, true);
    assert.equal(report.residue.automaticCleanup, false);
    assert.equal(readdirSync(ws.tmpRoot).length, 0, 'isolated dirs removed on failure');
    assert.ok(!calls.some((c) => /\bDROP\b/i.test(c.args.join(' '))));
    noSecret(report);
  }
});

test('unbound plain {text} SQL errors are never run proof: UNBOUND_SQL_ERROR, no post-inspect, no retry', async () => {
  const plainText = (text) => () => ({ status: 1, signal: null, stdout: JSON.stringify({ error: { text } }), stderr: '' });
  const cases = [
    ['guard-abort', plainText('malformed JSON: SQLITE_ERROR'), 8],
    ['guard-abort', plainText('malformed JSON'), 8],
    ['constraint-abort', plainText(`UNIQUE constraint failed: ${DATA_TABLE}.id: SQLITE_CONSTRAINT`), 10],
    ['constraint-abort', plainText(`UNIQUE constraint failed: ${DATA_TABLE}.id`), 10],
  ];
  for (const [step, fn, spawnCount] of cases) {
    const { report, calls, ws } = await runWith({ [step]: fn });
    assert.equal(calls.length, spawnCount);
    stopsAt(calls, step);
    assert.equal(calls.filter((c) => c.step === step).length, 1, 'no retry');
    assert.ok(!calls.some((c) => c.step === (step === 'guard-abort' ? 'inspect-guard' : 'inspect-constraint')), 'no post-inspect');
    const last = report.steps.at(-1);
    assert.deepEqual([last.step, last.class, last.passed, last.targetBound], [step, 'UNBOUND_SQL_ERROR', false, false]);
    assert.equal(report.observedTransportRollback, false);
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 2);
    assert.equal(report.stateUncertain, true);
    assert.equal(report.residue.manualCleanupRequired, true);
    assert.equal(readdirSync(ws.tmpRoot).length, 0);
    noSecret(report);
  }
});

test('bound JSON error with contradictory non-empty opposite stream fails closed in a full run', async () => {
  for (const stderr of ['Authentication error [code: 10000]', 'Too many requests, rate limited', '▲ [WARNING] something',
    apiError('malformed JSON')]) {
    const { report, calls } = await runWith({ 'guard-abort': () => ({ ...sqlFail('malformed JSON: SQLITE_ERROR'), stderr }) });
    stopsAt(calls, 'guard-abort');
    assert.equal(report.steps.at(-1).class, 'UNEXPECTED_FAILURE');
    assert.equal(report.observedTransportRollback, false);
    assert.equal(report.stateUncertain, true);
    noSecret(report);
  }
  const { report } = await runWith({ 'constraint-abort': () => ({ status: 1, signal: null, stdout: 'Rate limit exceeded',
    stderr: apiError(`UNIQUE constraint failed: ${DATA_TABLE}.id`) }) });
  assert.equal(report.steps.at(-1).class, 'UNEXPECTED_FAILURE');
  assert.equal(report.exitCode, 2);
});

test('direct CLI spawn: signal-killed child (status null) is TRANSPORT_UNCERTAIN and stops every later command', async () => {
  for (const step of ['version', 'identity', 'setup', 'positive', 'inspect-guard', 'constraint-abort']) {
    const { report, calls } = await runWith({ [step]: () => ({ status: null, signal: 'SIGTERM', stdout: sets([]), stderr: '' }) });
    stopsAt(calls, step);
    assert.equal(calls.filter((c) => c.step === step).length, 1, 'no retry');
    assert.equal(report.steps.at(-1).class, 'TRANSPORT_UNCERTAIN');
    assert.equal(report.steps.at(-1).exitCode, null);
    assert.equal(report.observedTransportRollback, false);
    assert.equal(report.exitCode, 2);
  }
});

test('Wrangler install gate: fixed ROOT only, Node minimum, returns direct cli.js (read-only checks)', async () => {
  assert.equal(WRANGLER_CLI, path.join(ROOT, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js'));
  assert.ok(path.isAbsolute(WRANGLER_CLI));
  assert.deepEqual(NODE_ARGS, ['--no-warnings']);
  assert.equal(MIN_NODE_MAJOR, 22);
  assert.ok(Number(process.versions.node.split('.')[0]) >= MIN_NODE_MAJOR);
  assert.equal(await verifyWranglerInstall(ROOT), WRANGLER_CLI);
  for (const root of [scratch, path.join(ROOT, '..'), `${ROOT}${path.sep}`, ROOT.toUpperCase() === ROOT ? `${ROOT}x` : ROOT.toUpperCase()]) {
    await assert.rejects(verifyWranglerInstall(root), { code: 'WRANGLER_ROOT_UNEXPECTED' });
  }
  const src = readFileSync(path.join(here, 'd1-tx-probe-run.mjs'), 'utf8');
  const runBody = src.slice(src.indexOf('const run = async'), src.indexOf('const execute ='));
  assert.ok(runBody.indexOf('await verifyWranglerInstall(ROOT)') >= 0, 'install re-verified inside run()');
  assert.ok(runBody.indexOf('await verifyWranglerInstall(ROOT)') < runBody.indexOf('spawn(process.execPath'), 'before spawn');
  assert.ok(runBody.includes('[...NODE_ARGS, cli, ...argsFor(copy)]'));
  assert.ok(!/WRANGLER_BIN|execArgv|NODE_OPTIONS/.test(src.replace(/^\/\/.*$/gm, '')), 'no wrapper/execArgv/NODE_OPTIONS in code');
});

test('missing ownership on inspect is a manual stop without cleanup', async () => {
  const { report, calls } = await runWith({ 'inspect-setup': () => ok(sets([countsRow(0, 0, { marker_owned: 0, marker_step: -1 })], SCHEMA)) });
  stopsAt(calls, 'inspect-setup');
  assert.ok(report.codes.includes('OWNERSHIP_NOT_CONFIRMED_MANUAL_STOP'));
  assert.equal(calls.length, 5);
});

test('classifyFailure: strict known shapes only, fail closed otherwise', () => {
  const f = (stdout, stderr = '', status = 1) => ({ status, signal: null, stdout, stderr });
  assert.deepEqual(classifyFailure(f(apiError('malformed JSON: SQLITE_ERROR [code: 7500]')), 'guard'),
    { class: 'EXPECTED_SQL_ERROR', targetBound: true });
  assert.equal(classifyFailure(f(apiError('malformed JSON')), 'guard').class, 'EXPECTED_SQL_ERROR');
  assert.equal(classifyFailure(f('', apiError(`UNIQUE constraint failed: ${DATA_TABLE}.id`)), 'constraint').class, 'EXPECTED_SQL_ERROR');
  assert.deepEqual(classifyFailure(f(JSON.stringify({ error: { text: 'malformed JSON: SQLITE_ERROR' } })), 'guard'),
    { class: 'EXPECTED_SQL_ERROR', targetBound: false });
  const bad = [
    f(apiError('Authentication error [code: 10000]')),
    f(apiError('malformed JSON', { notes: [{ text: 'Authentication error' }, { text: 'malformed JSON' }] })),
    f(apiError('malformed JSON', { code: 10000 })),
    f(apiError('malformed JSON', { text: QUERY_TEXT.replace(PROBE_DATABASE_ID, 'b8611b82-8067-4153-ae5e-d6a0b94be7a6') })),
    f(apiError('malformed JSON', { meta: {} })),
    f(apiError('malformed JSON', { retryAfterMs: 1000 })),
    f(apiError('malformed JSON', { extra: 1 })),
    f(apiError('malformed JSON', { name: 'ParseError' })),
    f(apiError('Too many requests: malformed JSON')),
    f(apiError('malformed JSON near "x": syntax error')),
    f(apiError('malformed JSON'), apiError('malformed JSON')),
    f(JSON.stringify({ error: { text: 'fetch failed malformed JSON' } })),
    f(JSON.stringify({ error: 'malformed JSON' })),
    f(JSON.stringify({ error: { text: 'malformed JSON' }, extra: 1 })),
    f(`prefix ${apiError('malformed JSON')}`),
    f('', `✘ [ERROR] malformed JSON\n${SECRET}`),
    f(`${apiError('malformed JSON')}${' '.repeat(70000)}x`),
    f(apiError('malformed JSON'), 'Authentication error [code: 10000]'),
    f(apiError('malformed JSON'), 'Too many requests'),
    f('Rate limit exceeded', apiError('malformed JSON')),
    f(JSON.stringify({ error: { text: 'malformed JSON' } }), '▲ [WARNING] x'),
  ];
  assert.equal(classifyFailure(f(apiError('malformed JSON'), ' \n '), 'guard').class, 'EXPECTED_SQL_ERROR');
  assert.equal(classifyFailure({ status: 1, signal: null, stdout: apiError('malformed JSON') }, 'guard').class, 'EXPECTED_SQL_ERROR');
  for (const r of bad) assert.equal(classifyFailure(r, 'guard').class, 'UNEXPECTED_FAILURE');
  assert.equal(classifyFailure(f(apiError('malformed JSON')), 'constraint').class, 'UNEXPECTED_FAILURE');
  assert.equal(classifyFailure({ status: null, signal: 'SIGKILL', stdout: apiError('malformed JSON'), stderr: '' }, 'guard').class, 'TRANSPORT_UNCERTAIN');
  assert.equal(classifyFailure({ error: new Error('x'), status: 1, stdout: apiError('malformed JSON') }, 'guard').class, 'TRANSPORT_UNCERTAIN');
  assert.equal(classifyFailure(undefined, 'guard').class, 'TRANSPORT_UNCERTAIN');
  assert.equal(classifyFailure(f(apiError('malformed JSON'), '', 0), 'guard').class, 'UNEXPECTED_SUCCESS');
  assert.throws(() => classifyFailure(f(''), 'other'), { code: 'CLASSIFIER_KIND_INVALID' });
});

// Fixed diagnostic schema v3: every key and every value must come from these closed sets.
const DIAG_ENUMS = {
  schemaVersion: [3], kind: ['guard', 'constraint', 'invalid'],
  transport: ['unknown', 'missing-result', 'timeout', 'spawn-error', 'signal', 'invalid-status', 'exit-zero', 'exit-nonzero'],
  errorCode: ['none', 'OTHER', 'ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES'],
  stdout: ['unknown', 'missing', 'wrong-type', 'empty', 'oversize', 'not-json', 'json'],
  stderr: ['unknown', 'missing', 'wrong-type', 'empty', 'oversize', 'not-json', 'json'],
  payloadStream: ['none', 'stdout', 'stderr', 'both'], payloadShape: ['none', 'text-wrapper', 'api-error', 'unknown'],
  targetBinding: ['unknown', 'match', 'mismatch', 'missing'], providerCode: ['none', '7500', '9109', '10000', '10001', '10002', 'OTHER'],
  sqlFamily: ['unknown', 'guard', 'owned-unique', 'other'], noteCount: ['zero', 'one', 'multiple', 'invalid'],
  hasUnexpectedKeys: [true, false], hasMeta: [true, false], hasLocation: [true, false], hasRetryAfter: [true, false],
  sqlMessageShape: ['owned-id-unique', 'other', 'unknown'], messageWrapper: ['none', 'D1_ERROR', 'unknown'],
  sqliteSuffix: ['none', 'SQLITE_ERROR', 'SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE', 'unknown'],
  sqliteExtendedCode: ['unknown', 'none', 'SQLITE_CONSTRAINT_PRIMARYKEY'],
  hypothesisOnly: [true], historicalCauseRecovered: [false], evidenceAccepted: [false], authorizesRetry: [false], cleanupAuthorized: [false],
};
function assertDiag(d) {
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.reasonCodes));
  assert.deepEqual(Object.keys(d).sort(), [...Object.keys(DIAG_ENUMS), 'reasonCodes'].sort());
  for (const [k, allowed] of Object.entries(DIAG_ENUMS)) assert.ok(allowed.includes(d[k]), `${k}=${String(d[k])}`);
  assert.ok(Array.isArray(d.reasonCodes) && d.reasonCodes.length <= DIAGNOSTIC_REASON_CODES.length);
  assert.ok(d.reasonCodes.every((c) => DIAGNOSTIC_REASON_CODES.includes(c)));
  assert.equal(new Set(d.reasonCodes).size, d.reasonCodes.length);
  assert.ok(JSON.stringify(d).length < 1024);
}
const diag = (r, kind) => { const d = diagnoseFailure(r, kind); assertDiag(d); return d; };
const res = (stdout, stderr = '', status = 1, extra = {}) => ({ status, signal: null, stdout, stderr, ...extra });
const GOOD_GUARD = 'malformed JSON: SQLITE_ERROR [code: 7500]';
const GOOD_CONSTRAINT = `UNIQUE constraint failed: ${DATA_TABLE}.id: SQLITE_CONSTRAINT [code: 7500]`;

test('diagnoseFailure: table of fixed enum features; classifyFailure acceptance unchanged', () => {
  const cases = [
    // [result, kind, expected classifyFailure class, expected reasonCodes, partial fields]
    [res(apiError(GOOD_GUARD)), 'guard', 'EXPECTED_SQL_ERROR', [], { payloadShape: 'api-error', targetBinding: 'match', providerCode: '7500',
      sqlFamily: 'guard', noteCount: 'one', payloadStream: 'stdout', stdout: 'json', stderr: 'empty' }],
    [res('', apiError(GOOD_CONSTRAINT)), 'constraint', 'EXPECTED_SQL_ERROR', [], { payloadStream: 'stderr', sqlFamily: 'owned-unique' }],
    [res(apiError(GOOD_GUARD)), 'constraint', 'UNEXPECTED_FAILURE', ['MESSAGE_MISMATCH'], { sqlFamily: 'guard' }],
    [res(apiError('Authentication error')), 'guard', 'UNEXPECTED_FAILURE', ['MESSAGE_MISMATCH'], { sqlFamily: 'other', providerCode: '7500' }],
    [res(apiError(GOOD_GUARD, { code: 10000 })), 'guard', 'UNEXPECTED_FAILURE', ['API_CODE_NOT_7500'], { providerCode: '10000', sqlFamily: 'guard' }],
    [res(apiError(GOOD_CONSTRAINT, { code: 10000 })), 'constraint', 'UNEXPECTED_FAILURE', ['API_CODE_NOT_7500'], { providerCode: '10000' }],
    [res(apiError(GOOD_GUARD, { code: 9109 })), 'guard', 'UNEXPECTED_FAILURE', ['API_CODE_NOT_7500'], { providerCode: '9109' }],
    [res(apiError(GOOD_GUARD, { code: 123456789 })), 'guard', 'UNEXPECTED_FAILURE', ['API_CODE_NOT_7500'], { providerCode: 'OTHER' }],
    [res(apiError(GOOD_GUARD, { code: '7500' })), 'guard', 'UNEXPECTED_FAILURE', ['API_CODE_NOT_7500'], { providerCode: 'OTHER' }],
    [res(apiError(GOOD_CONSTRAINT, { meta: {} })), 'constraint', 'UNEXPECTED_FAILURE', ['METADATA_REJECTED'], { hasMeta: true }],
    [res(apiError(GOOD_GUARD, { location: { line: 1 } })), 'guard', 'UNEXPECTED_FAILURE', ['METADATA_REJECTED'], { hasLocation: true }],
    [res(apiError(GOOD_GUARD, { retryAfterMs: 1000 })), 'guard', 'UNEXPECTED_FAILURE', ['METADATA_REJECTED'], { hasRetryAfter: true }],
    [res(apiError(GOOD_GUARD, { accountTag: 'deadbeef' })), 'guard', 'UNEXPECTED_FAILURE', ['METADATA_REJECTED'], {}],
    [res(apiError(GOOD_GUARD, { kind: 'warning' })), 'guard', 'UNEXPECTED_FAILURE', ['METADATA_REJECTED'], {}],
    [res(apiError(GOOD_GUARD, { extra: 1 })), 'guard', 'UNEXPECTED_FAILURE', ['UNEXPECTED_KEYS'], { hasUnexpectedKeys: true }],
    [res(apiError(GOOD_GUARD, { text: QUERY_TEXT.replace(PROBE_DATABASE_ID, 'b8611b82-8067-4153-ae5e-d6a0b94be7a6') })), 'guard',
      'UNEXPECTED_FAILURE', ['TARGET_MISMATCH'], { targetBinding: 'mismatch' }],
    [res(apiError(GOOD_GUARD, { text: undefined })), 'guard', 'UNEXPECTED_FAILURE', ['TARGET_MISMATCH'], { targetBinding: 'missing' }],
    [res(apiError(GOOD_GUARD, { notes: [] })), 'guard', 'UNEXPECTED_FAILURE', ['NOTE_INVALID'], { noteCount: 'zero' }],
    [res(apiError(GOOD_GUARD, { notes: [{ text: 'a' }, { text: GOOD_GUARD }] })), 'guard', 'UNEXPECTED_FAILURE', ['NOTE_INVALID'],
      { noteCount: 'multiple' }],
    [res(apiError(GOOD_GUARD, { notes: 'x' })), 'guard', 'UNEXPECTED_FAILURE', ['NOTE_INVALID'], { noteCount: 'invalid' }],
    [res(apiError(GOOD_GUARD, { notes: [{ text: GOOD_GUARD, x: 1 }] })), 'guard', 'UNEXPECTED_FAILURE', ['NOTE_INVALID'], { noteCount: 'one' }],
    [res(apiError(GOOD_GUARD), 'Authentication error [code: 10000]'), 'guard', 'UNEXPECTED_FAILURE', ['OPPOSITE_STREAM_NONEMPTY'],
      { stderr: 'not-json' }],
    [res('Rate limit exceeded', apiError(GOOD_GUARD)), 'guard', 'UNEXPECTED_FAILURE', ['OPPOSITE_STREAM_NONEMPTY'], { payloadStream: 'stderr' }],
    [res(apiError(GOOD_GUARD), apiError(GOOD_GUARD)), 'guard', 'UNEXPECTED_FAILURE', ['OPPOSITE_STREAM_NONEMPTY'], { payloadStream: 'both' }],
    [res(JSON.stringify({ error: { text: 'malformed JSON' } })), 'guard', 'EXPECTED_SQL_ERROR', ['UNBOUND_TEXT_WRAPPER'],
      { payloadShape: 'text-wrapper', targetBinding: 'missing' }],
    [res(JSON.stringify({ error: { text: 'malformed JSON' }, extra: 1 })), 'guard', 'UNEXPECTED_FAILURE',
      ['UNBOUND_TEXT_WRAPPER', 'UNEXPECTED_KEYS'], { hasUnexpectedKeys: true }],
    [res(JSON.stringify({ error: 'malformed JSON' })), 'guard', 'UNEXPECTED_FAILURE', ['PAYLOAD_SHAPE_UNKNOWN'], { payloadShape: 'unknown' }],
    [res('{ malformed'), 'guard', 'UNEXPECTED_FAILURE', ['NO_ERROR_PAYLOAD'], { stdout: 'not-json' }],
    [res(`${apiError(GOOD_GUARD)}${' '.repeat(70000)}x`), 'guard', 'UNEXPECTED_FAILURE', ['NO_ERROR_PAYLOAD'], { stdout: 'oversize' }],
    [res(JSON.stringify({ error: { text: 'é'.repeat(40000) } })), 'guard', 'UNEXPECTED_FAILURE', ['NO_ERROR_PAYLOAD'], { stdout: 'oversize' }],
    [res(JSON.stringify({ error: { text: 'x'.repeat(5000) } })), 'guard', 'UNEXPECTED_FAILURE', ['UNBOUND_TEXT_WRAPPER', 'NOTE_INVALID'],
      { sqlFamily: 'unknown' }],
    [{ status: 1, signal: null }, 'guard', 'UNEXPECTED_FAILURE', ['NO_ERROR_PAYLOAD'], { stdout: 'missing', stderr: 'missing' }],
    [res(Buffer.from(apiError(GOOD_GUARD))), 'guard', 'UNEXPECTED_FAILURE', ['NO_ERROR_PAYLOAD'], { stdout: 'wrong-type' }],
    [res(apiError(GOOD_GUARD), '', 0), 'guard', 'UNEXPECTED_SUCCESS', ['EXIT_ZERO'], { transport: 'exit-zero' }],
    [{ status: null, signal: 'SIGKILL', stdout: apiError(GOOD_GUARD), stderr: '' }, 'guard', 'TRANSPORT_UNCERTAIN', ['TRANSPORT_UNCERTAIN'],
      { transport: 'signal', errorCode: 'none' }],
    [res(apiError(GOOD_GUARD), '', 1.5), 'guard', 'TRANSPORT_UNCERTAIN', ['TRANSPORT_UNCERTAIN'], { transport: 'invalid-status' }],
    [res('', '', null, { error: Object.assign(new Error(SECRET), { code: 'ETIMEDOUT' }) }), 'guard', 'TRANSPORT_UNCERTAIN',
      ['TRANSPORT_UNCERTAIN'], { transport: 'timeout', errorCode: 'ETIMEDOUT' }],
    [res('', '', null, { error: Object.assign(new Error(SECRET), { code: SECRET }) }), 'guard', 'TRANSPORT_UNCERTAIN',
      ['TRANSPORT_UNCERTAIN'], { transport: 'spawn-error', errorCode: 'OTHER' }],
    [{ error: true, status: null, signal: null }, 'constraint', 'TRANSPORT_UNCERTAIN', ['TRANSPORT_UNCERTAIN'], { transport: 'spawn-error' }],
    [undefined, 'guard', 'TRANSPORT_UNCERTAIN', ['TRANSPORT_UNCERTAIN'], { transport: 'missing-result' }],
  ];
  for (const [r, kind, cls, reasons, fields] of cases) {
    assert.equal(classifyFailure(r, kind).class, cls, `classify ${cls}`);
    const d = diag(r, kind);
    assert.deepEqual(d.reasonCodes, reasons, JSON.stringify(fields));
    for (const [k, v] of Object.entries(fields)) assert.equal(d[k], v, k);
    assert.equal(d.kind, kind);
    assert.deepEqual([d.evidenceAccepted, d.authorizesRetry, d.cleanupAuthorized, d.historicalCauseRecovered, d.hypothesisOnly],
      [false, false, false, false, true]);
    assert.ok(!JSON.stringify(d).includes(SECRET));
  }
  assert.throws(() => classifyFailure(res(''), 'other'), { code: 'CLASSIFIER_KIND_INVALID' }); // classifier contract unchanged
});

test('diagnoseFailure never throws, never invokes getters, never echoes secrets/keys/numbers; bounded on 100 unknown inputs', () => {
  let invoked = 0;
  const getter = { status: 1, signal: null, stderr: '' };
  Object.defineProperty(getter, 'stdout', { enumerable: true, get() { invoked++; throw new Error(SECRET); } });
  const hostile = [
    [getter, 'guard'],
    [new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(SECRET); } }), 'guard'],
    [(() => { const p = Proxy.revocable({}, {}); p.revoke(); return p.proxy; })(), 'constraint'],
    [res(apiError(GOOD_GUARD)), 'other'], [res(apiError(GOOD_GUARD)), undefined], [res(''), Symbol(SECRET)],
    [res(''), { toString() { throw new Error(SECRET); } }], [res(''), '__proto__'], [res(''), 'hasOwnProperty'],
  ];
  for (const [r, kind] of hostile) {
    const d = diag(r, kind);
    assert.deepEqual(d.reasonCodes, ['INPUT_INVALID']);
  }
  assert.equal(invoked, 0, 'getter never invoked');
  // Sentinels in values, key names, numeric strings, notes, error message/code, signal: none may be serialized.
  const NUM = '98765432109876';
  const sentinelInputs = [
    res(apiError(SECRET, { [SECRET]: SECRET, code: Number(NUM), accountTag: SECRET, meta: { [SECRET]: NUM } }), SECRET),
    res(JSON.stringify({ error: { text: SECRET }, [SECRET]: NUM, [`k${NUM}`]: 1 })),
    res(JSON.stringify({ error: { name: 'APIError', text: SECRET, notes: [{ text: NUM }], code: SECRET } }), `{"${SECRET}":${NUM}}`),
    res('', '', null, { error: Object.assign(new Error(SECRET), { code: NUM }), signal: SECRET }),
    { status: NUM, signal: null, stdout: SECRET, stderr: NUM },
  ];
  const outputs = sentinelInputs.map((r) => diag(r, 'guard'));
  const s = JSON.stringify(outputs);
  for (const bad of [SECRET, NUM, 'TOPSECRET', '9876', 'k98']) assert.ok(!s.includes(bad), bad);
  assert.equal(outputs[0].hasUnexpectedKeys, true);
  assert.equal(outputs[1].hasUnexpectedKeys, true);
  assert.equal(outputs[0].providerCode, 'OTHER');
  // 100 deterministic pseudo-random unknown inputs: every output fixed-schema and bounded.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const atoms = [undefined, null, '', ' ', SECRET, NUM, '{', '{}', '[]', '{"error":null}', apiError(GOOD_GUARD), apiError(SECRET, { code: 10001 }),
    JSON.stringify({ error: { text: GOOD_GUARD } }), 1, true, [], {}, 'x'.repeat(70000), `{"error":{"text":"${'é'.repeat(33000)}"}}`];
  let total = 0;
  for (let i = 0; i < 100; i++) {
    const r = rnd(10) === 0 ? atoms[rnd(atoms.length)] : { status: [1, 0, null, -1, NUM, 2.5][rnd(6)], signal: [null, null, 'SIGTERM', SECRET][rnd(4)],
      stdout: atoms[rnd(atoms.length)], stderr: atoms[rnd(atoms.length)], ...(rnd(5) === 0 ? { error: { code: [SECRET, 'ENOENT', 1][rnd(3)] } } : {}) };
    const d = diag(r, ['guard', 'constraint', 'bogus'][rnd(3)]);
    const out = JSON.stringify(d);
    total += out.length;
    assert.ok(!out.includes(SECRET) && !out.includes(NUM));
  }
  assert.ok(total < 100 * 1024);
});

test('full run: failed abort records enum-only diagnostics; acceptance, rollback math and no-retry unchanged', async () => {
  const { report: good } = await runWith();
  assert.equal(good.observedTransportRollback, true);
  assert.ok(good.steps.every((s) => !('diagnostics' in s)), 'no diagnostics on passing steps');
  const cases = [
    ['constraint-abort', () => sqlFail('Authentication error', { code: 10000 }), ['API_CODE_NOT_7500', 'MESSAGE_MISMATCH'], 10],
    ['constraint-abort', () => sqlFail('malformed JSON: SQLITE_ERROR [code: 7500]'), ['MESSAGE_MISMATCH'], 10],
    ['constraint-abort', () => sqlFail(GOOD_CONSTRAINT, { code: 10000 }), ['API_CODE_NOT_7500'], 10],
    ['constraint-abort', () => sqlFail(GOOD_CONSTRAINT, { meta: { x: SECRET }, location: SECRET }), ['METADATA_REJECTED'], 10],
    ['guard-abort', () => sqlFail(GOOD_GUARD, { text: QUERY_TEXT.replace(PROBE_ACCOUNT_ID, 'f'.repeat(32)) }), ['TARGET_MISMATCH'], 8],
    ['guard-abort', () => ({ ...sqlFail(GOOD_GUARD), stderr: `Authentication error ${SECRET}` }), ['OPPOSITE_STREAM_NONEMPTY'], 8],
    ['guard-abort', () => ({ status: 1, signal: null, stdout: `{ ${SECRET}`, stderr: '' }), ['NO_ERROR_PAYLOAD'], 8],
    ['guard-abort', () => ({ status: 1, signal: null, stdout: `${apiError(GOOD_GUARD)}${' '.repeat(70000)}x`, stderr: '' }), ['NO_ERROR_PAYLOAD'], 8],
    ['guard-abort', () => ({ status: 1, signal: null }), ['NO_ERROR_PAYLOAD'], 8],
    ['guard-abort', () => ({ status: null, signal: 'SIGKILL', stdout: apiError(GOOD_GUARD), stderr: '' }), ['TRANSPORT_UNCERTAIN'], 8],
    ['guard-abort', () => { throw Object.assign(new Error(SECRET), { code: SECRET }); }, ['TRANSPORT_UNCERTAIN'], 8],
    ['guard-abort', () => ({ status: 1, signal: null, stdout: JSON.stringify({ error: { text: 'malformed JSON' } }), stderr: '' }),
      ['UNBOUND_TEXT_WRAPPER'], 8],
  ];
  for (const [step, fn, reasons, spawnCount] of cases) {
    const { report, calls } = await runWith({ [step]: fn });
    assert.equal(calls.length, spawnCount);
    assert.equal(calls.filter((c) => c.step === step).length, 1, 'no retry');
    const last = report.steps.at(-1);
    assert.equal(last.passed, false);
    assert.notEqual(last.class, 'EXPECTED_SQL_ERROR');
    assertDiag(last.diagnostics);
    assert.deepEqual(last.diagnostics.reasonCodes, reasons, `${step} ${reasons}`);
    assert.equal(last.diagnostics.evidenceAccepted, false);
    assert.equal(report.observedTransportRollback, false);
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 2);
    assert.equal(report.cleanupAuthorized, false);
    assert.ok(report.steps.slice(0, -1).every((s) => !('diagnostics' in s)));
    noSecret(report);
    // v2: 'SQLITE_*' may appear only as the fixed sqliteSuffix enum (assertDiag); raw message fragments never appear.
    const out = JSON.stringify(report);
    for (const bad of ['Authentication', ': SQLITE', 'constraint failed', '[code', 'D1_ERROR:', 'APIError', 'accountTag', '"notes', '"meta', '"location', PROBE_ACCOUNT_ID]) {
      assert.ok(!out.includes(bad), bad);
    }
  }
});

const OWNED = `UNIQUE constraint failed: ${DATA_TABLE}.id`;
const NEW_KEYS = ['sqlMessageShape', 'sqliteSuffix', 'messageWrapper'];
const pick = (d) => NEW_KEYS.map((k) => d[k]);

test('v2 taxonomy: exact 20-literal cross product, classifier body hash and patterns unchanged, never authority', () => {
  const src = readFileSync(path.join(here, 'd1-tx-probe-run.mjs'), 'utf8').replaceAll('\r\n', '\n');
  const start = src.indexOf('export function classifyFailure');
  assert.equal(sha(src.slice(start, src.indexOf('\n}\n', start) + 3)), '1ea79c1fe5cbdeb88f4c3a767bae1902922e155fc5d6d8aeada4c35d95eeb753');
  assert.deepEqual(Object.keys(SQL_ERROR_PATTERNS), ['guard', 'constraint']);
  assert.equal(SQL_ERROR_PATTERNS.constraint.source, `^UNIQUE constraint failed: ${DATA_TABLE}\\.id(?:: SQLITE_CONSTRAINT)?(?: \\[code: 7500\\])?$`);
  assert.equal(SQL_ERROR_PATTERNS.guard.source, '^malformed JSON(?:: SQLITE_ERROR)?(?: \\[code: 7500\\])?$');
  const suffixes = [['', 'none'], [': SQLITE_ERROR', 'SQLITE_ERROR'], [': SQLITE_CONSTRAINT', 'SQLITE_CONSTRAINT'],
    [': SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_PRIMARYKEY'], [': SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_UNIQUE']];
  const expected = [];
  for (const [pre, wrapper] of [['', 'none'], ['D1_ERROR: ', 'D1_ERROR']]) {
    for (const [suf, suffix] of suffixes) {
      for (const tail of ['', ' [code: 7500]']) expected.push([`${pre}${OWNED}${suf}${tail}`, wrapper, suffix]);
    }
  }
  assert.equal(expected.length, 20);
  assert.deepEqual([...DIAGNOSTIC_TAXONOMY_LITERALS].sort(), expected.map(([m]) => m).sort());
  for (const [m, wrapper, suffix] of expected) {
    const legacy = wrapper === 'none' && ['none', 'SQLITE_CONSTRAINT'].includes(suffix);
    for (const r of [res(apiError(m)), res(JSON.stringify({ error: { text: m } }))]) {
      const bound = r.stdout.includes('APIError');
      assert.deepEqual(classifyFailure(r, 'constraint'), legacy ? { class: 'EXPECTED_SQL_ERROR', targetBound: bound }
        : { class: 'UNEXPECTED_FAILURE', targetBound: false }, m);
      assert.equal(classifyFailure(r, 'guard').class, 'UNEXPECTED_FAILURE');
      const d = diag(r, 'constraint');
      assert.deepEqual(pick(d), ['owned-id-unique', suffix, wrapper], m);
      assert.equal(d.sqlFamily, legacy ? 'owned-unique' : 'other');
      assert.deepEqual(d.reasonCodes, [...(bound ? [] : ['UNBOUND_TEXT_WRAPPER']), ...(legacy ? [] : ['MESSAGE_MISMATCH'])]);
      assert.deepEqual([d.evidenceAccepted, d.authorizesRetry, d.cleanupAuthorized, d.historicalCauseRecovered], [false, false, false, false]);
    }
  }
  assert.deepEqual(pick(diag(res(apiError(GOOD_GUARD)), 'guard')), ['other', 'unknown', 'unknown']);
  assert.deepEqual(pick(diagnoseFailure(undefined, 'bogus')), ['unknown', 'unknown', 'unknown']);
});

test('v2 taxonomy: near-miss literals are other, ambiguous/invalid inputs unknown; legacy fields unchanged, no echo', () => {
  const S = 'RAWSENTINEL';
  const nearMiss = [`UNIQUE constraint failed: other_${S}.id`, `${OWNED.replace('.id', '.ID')}`, OWNED.toLowerCase(),
    OWNED.replace('UNIQUE', 'UNIQUЕ'), `D1_ERROR: D1_ERROR: ${OWNED}`, `D1_ERROR:  ${OWNED}`, `${OWNED}: SQLITE_CONSTRAINT: SQLITE_CONSTRAINT`,
    `${OWNED}: SQLITE_CONSTRAINT_FOREIGNKEY`, `${OWNED}\n`, `${OWNED} `, `\u00a0${OWNED}`, `${OWNED}: SQLITE_CONSTRAINT\u00a0[code: 7500]`,
    `${OWNED} Authentication error ${S}`, `${OWNED}'; DROP TABLE ${S};--`, `${OWNED} https://developers.cloudflare.com/d1/ ${S}`,
    `${OWNED} [code: 7500] [code: 7500]`, `${OWNED} [code: 10000]`, `${OWNED}: sqlite_constraint`, `d1_error: ${OWNED}`];
  for (const m of nearMiss) {
    assert.equal(classifyFailure(res(apiError(m)), 'constraint').class, 'UNEXPECTED_FAILURE', m);
    const d = diag(res(apiError(m)), 'constraint');
    assert.deepEqual(pick(d), ['other', 'unknown', 'unknown'], m);
    assert.equal(d.sqlFamily, 'other');
    assert.deepEqual(d.reasonCodes, ['MESSAGE_MISMATCH']);
    assert.ok(!JSON.stringify(d).includes(S));
  }
  const ambiguous = [
    [res(apiError(OWNED, { notes: [{ text: OWNED }, { text: OWNED }] })), ['NOTE_INVALID'], 'unknown'],
    [res(apiError(OWNED, { notes: [{ text: OWNED, x: 1 }] })), ['NOTE_INVALID'], 'unknown'],
    [res(apiError(OWNED, { notes: [{ text: 7500 }] })), ['NOTE_INVALID'], 'unknown'],
    [res(apiError('x'.repeat(5000))), ['NOTE_INVALID'], 'unknown'],
    [res(apiError('é'.repeat(2100))), ['MESSAGE_MISMATCH'], 'other'], // <= 4096 chars but > 4096 UTF-8 bytes
    [res(apiError(OWNED), apiError(OWNED)), ['OPPOSITE_STREAM_NONEMPTY'], 'owned-unique'],
    [res(apiError(OWNED), `Authentication error ${S}`), ['OPPOSITE_STREAM_NONEMPTY'], 'owned-unique'],
    [res(JSON.stringify({ error: { text: OWNED }, extra: 1 })), ['UNBOUND_TEXT_WRAPPER', 'UNEXPECTED_KEYS'], 'owned-unique'],
    [res(JSON.stringify({ error: { text: OWNED, x: 1 } })), ['PAYLOAD_SHAPE_UNKNOWN'], 'unknown'],
  ];
  // Gate negatives: an EXACT taxonomy literal in an unbound/rejected context still yields all-unknown new fields.
  const PK = `D1_ERROR: ${OWNED}: SQLITE_CONSTRAINT_PRIMARYKEY [code: 7500]`;
  const foreign = QUERY_TEXT.replace(PROBE_DATABASE_ID, 'b8611b82-8067-4153-ae5e-d6a0b94be7a6');
  for (const m of [OWNED, PK]) {
    const mm = m === PK ? ['MESSAGE_MISMATCH'] : []; // legacy sqlFamily 'other' for PK, reasons unchanged
    ambiguous.push(
      [res(apiError(m, { text: foreign })), ['TARGET_MISMATCH', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { text: `${QUERY_TEXT}${S}` })), ['TARGET_MISMATCH', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { text: undefined })), ['TARGET_MISMATCH', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { accountTag: 'f'.repeat(32) })), ['METADATA_REJECTED', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { code: 10000 })), ['API_CODE_NOT_7500', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { code: '7500' })), ['API_CODE_NOT_7500', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { meta: {} })), ['METADATA_REJECTED', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { location: { line: 1 } })), ['METADATA_REJECTED', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { retryAfterMs: 1000 })), ['METADATA_REJECTED', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { kind: 'warning' })), ['METADATA_REJECTED', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { telemetryMessage: true })), ['METADATA_REJECTED', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m, { [S]: 1 })), ['UNEXPECTED_KEYS', ...mm], 'x', 'UNEXPECTED_FAILURE'],
      [res(apiError(m), '', 0), ['EXIT_ZERO'], 'x', 'UNEXPECTED_SUCCESS'],
      [{ status: null, signal: 'SIGTERM', stdout: apiError(m), stderr: '' }, ['TRANSPORT_UNCERTAIN'], 'x', 'TRANSPORT_UNCERTAIN'],
      [{ status: null, signal: null, stdout: apiError(m), stderr: '' }, ['TRANSPORT_UNCERTAIN'], 'x', 'TRANSPORT_UNCERTAIN'],
      [res(apiError(m), '', 1, { error: Object.assign(new Error(S), { code: 'ETIMEDOUT' }) }), ['TRANSPORT_UNCERTAIN'], 'x',
        'TRANSPORT_UNCERTAIN'],
      [res(JSON.stringify({ error: { text: m } }), '', 0), ['EXIT_ZERO'], 'x', 'UNEXPECTED_SUCCESS'],
    );
  }
  for (const [r, reasons, family, cls = 'UNEXPECTED_FAILURE'] of ambiguous) {
    const d = diag(r, 'constraint');
    assert.deepEqual(pick(d), ['unknown', 'unknown', 'unknown'], JSON.stringify(reasons));
    assert.deepEqual(d.reasonCodes, reasons);
    if (family !== 'x') assert.equal(d.sqlFamily, family);
    assert.equal(classifyFailure(r, 'constraint').class, cls);
    const out = JSON.stringify(d);
    for (const bad of [S, ': SQLITE', 'constraint failed', '[code', 'D1_ERROR:', PROBE_ACCOUNT_ID]) assert.ok(!out.includes(bad), bad);
  }
  // Positive control: the same literals in a clean pinned APIError (and the unbound wrapper, shape only) do match.
  assert.deepEqual(pick(diag(res(apiError(PK)), 'constraint')), ['owned-id-unique', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'D1_ERROR']);
  const unbound = diag(res(JSON.stringify({ error: { text: PK } })), 'constraint');
  assert.deepEqual([...pick(unbound), unbound.targetBinding, unbound.evidenceAccepted], ['owned-id-unique', 'SQLITE_CONSTRAINT_PRIMARYKEY',
    'D1_ERROR', 'missing', false]);
});

test('full run: hypothetical PRIMARYKEY message stays failed with v2 suffix diagnostics; no rollback, no retry', async () => {
  const { report, calls } = await runWith({ 'constraint-abort': () => sqlFail(`${OWNED}: SQLITE_CONSTRAINT_PRIMARYKEY [code: 7500]`) });
  assert.equal(calls.length, 10);
  assert.equal(calls.filter((c) => c.step === 'constraint-abort').length, 1, 'no retry');
  const last = report.steps.at(-1);
  assert.deepEqual([last.step, last.class, last.passed, last.targetBound], ['constraint-abort', 'UNEXPECTED_FAILURE', false, false]);
  assertDiag(last.diagnostics);
  assert.deepEqual(pick(last.diagnostics), ['owned-id-unique', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'none']);
  assert.deepEqual([last.diagnostics.schemaVersion, last.diagnostics.sqlFamily, last.diagnostics.evidenceAccepted], [3, 'other', false]);
  assert.equal(last.diagnostics.sqliteExtendedCode, 'none');
  assert.deepEqual(last.diagnostics.reasonCodes, ['MESSAGE_MISMATCH']);
  assert.deepEqual([report.observedTransportRollback, report.ok, report.exitCode, report.cleanupAuthorized], [false, false, 2, false]);
  noSecret(report);
  const out = JSON.stringify(report);
  for (const bad of [': SQLITE', 'constraint failed', '[code', 'D1_ERROR:', 'APIError', '"notes']) assert.ok(!out.includes(bad), bad);
});

const EXT_TAIL = ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)';
const EXT = [['', 'none'], ['D1_ERROR: ', 'D1_ERROR']].flatMap(([pre, w]) => ['', ' [code: 7500]'].map((t) => [`${pre}${OWNED}${EXT_TAIL}${t}`, w]));
const pick4 = (d) => [...pick(d), d.sqliteExtendedCode];

test('v3 extended: exact 4 literals separate from frozen 20; diagnostic only, classifier unchanged, never authority', () => {
  assert.ok(Object.isFrozen(DIAGNOSTIC_TAXONOMY_LITERALS) && Object.isFrozen(DIAGNOSTIC_EXTENDED_LITERALS));
  assert.equal(DIAGNOSTIC_TAXONOMY_LITERALS.length, 20);
  assert.deepEqual([...DIAGNOSTIC_EXTENDED_LITERALS].sort(), EXT.map(([m]) => m).sort());
  assert.ok(DIAGNOSTIC_EXTENDED_LITERALS.every((m) => !DIAGNOSTIC_TAXONOMY_LITERALS.includes(m)));
  for (const m of DIAGNOSTIC_TAXONOMY_LITERALS) { // old 20: extended code 'none', classifier result unchanged
    const r = res(apiError(m));
    const legacy = m.startsWith('UNIQUE') && /\.id(?:: SQLITE_CONSTRAINT)?(?: \[code: 7500\])?$/.test(m);
    assert.deepEqual(classifyFailure(r, 'constraint'), legacy ? { class: 'EXPECTED_SQL_ERROR', targetBound: true }
      : { class: 'UNEXPECTED_FAILURE', targetBound: false }, m);
    assert.equal(diag(r, 'constraint').sqliteExtendedCode, 'none', m);
  }
  for (const [m, w] of EXT) {
    const r = res(apiError(m));
    assert.deepEqual(classifyFailure(r, 'constraint'), { class: 'UNEXPECTED_FAILURE', targetBound: false }, m);
    assert.equal(SQL_ERROR_PATTERNS.constraint.test(m), false);
    const d = diag(r, 'constraint');
    assert.deepEqual(pick4(d), ['owned-id-unique', 'SQLITE_CONSTRAINT', w, 'SQLITE_CONSTRAINT_PRIMARYKEY'], m);
    assert.deepEqual([d.sqlFamily, d.reasonCodes, d.evidenceAccepted, d.authorizesRetry, d.cleanupAuthorized, d.historicalCauseRecovered],
      ['other', ['MESSAGE_MISMATCH'], false, false, false, false]);
    // Unbound {text} wrapper: shape 'other', extended 'unknown' (keeps local-module recognition unchanged).
    assert.deepEqual(pick4(diag(res(JSON.stringify({ error: { text: m } })), 'constraint')), ['other', 'unknown', 'unknown', 'unknown']);
  }
  assert.equal(diagnoseFailure(undefined, 'bogus').sqliteExtendedCode, 'unknown');
  assert.equal(diag(res(apiError(GOOD_GUARD)), 'guard').sqliteExtendedCode, 'unknown');
});

test('v3 extended: near misses other/unknown, rejected contexts all-unknown, no echo', () => {
  const [base, d1] = [`${OWNED}${EXT_TAIL}`, `D1_ERROR: ${OWNED}${EXT_TAIL}`];
  const near = [`D1_ERROR: ${d1}`, `${base}${EXT_TAIL}`, base.replace(DATA_TABLE, MARKER_TABLE), base.replace('.id', '.ID'),
    base.replace('(extended', ' (extended'), ` ${base}`, `${base} `, `${base}\n`, `${base} [code: 10000]`, `${base}: SQLITE_CONSTRAINT`,
    base.replace('PRIMARYKEY)', 'UNIQUE)'), `${base} [code: 7500] [code: 7500]`, base.toLowerCase(), `${d1}RAWSENTINEL`];
  for (const m of near) {
    const d = diag(res(apiError(m)), 'constraint');
    assert.deepEqual(pick4(d), ['other', 'unknown', 'unknown', 'unknown'], m);
    assert.deepEqual([d.sqlFamily, d.reasonCodes], ['other', ['MESSAGE_MISMATCH']]);
    assert.equal(classifyFailure(res(apiError(m)), 'constraint').class, 'UNEXPECTED_FAILURE');
    assert.ok(!JSON.stringify(d).includes('RAWSENTINEL'));
  }
  const foreign = QUERY_TEXT.replace(PROBE_DATABASE_ID, 'b8611b82-8067-4153-ae5e-d6a0b94be7a6');
  for (const r of [res(apiError(d1, { text: foreign })), res(apiError(d1, { meta: {} })), res(apiError(d1, { x: 1 })),
    res(apiError(d1, { code: 10000 })), res(apiError(d1), 'Authentication error'), res(apiError(d1), '', 0),
    { status: null, signal: 'SIGTERM', stdout: apiError(d1), stderr: '' }, res(apiError(d1, { notes: [{ text: d1 }, { text: d1 }] }))]) {
    assert.deepEqual(pick4(diag(r, 'constraint')), ['unknown', 'unknown', 'unknown', 'unknown']);
    assert.notEqual(classifyFailure(r, 'constraint').class, 'EXPECTED_SQL_ERROR');
  }
});

test('full run: actual-local extended format under bound APIError 7500 stays failed; no inspect, retry or cleanup', async () => {
  const { report, calls } = await runWith({ 'constraint-abort': () => sqlFail(`D1_ERROR: ${OWNED}${EXT_TAIL}`) });
  assert.equal(calls.length, 10);
  assert.equal(calls.filter((c) => c.step === 'constraint-abort').length, 1, 'no retry');
  assert.ok(!calls.some((c) => c.step === 'inspect-constraint'), 'no inspect after failure');
  const last = report.steps.at(-1);
  assert.deepEqual([last.step, last.class, last.passed, last.targetBound], ['constraint-abort', 'UNEXPECTED_FAILURE', false, false]);
  assertDiag(last.diagnostics);
  assert.deepEqual(pick4(last.diagnostics), ['owned-id-unique', 'SQLITE_CONSTRAINT', 'D1_ERROR', 'SQLITE_CONSTRAINT_PRIMARYKEY']);
  assert.deepEqual([last.diagnostics.schemaVersion, last.diagnostics.sqlFamily, last.diagnostics.reasonCodes], [3, 'other', ['MESSAGE_MISMATCH']]);
  assert.deepEqual([report.observedTransportRollback, report.ok, report.exitCode, report.cleanupAuthorized], [false, false, 2, false]);
  noSecret(report);
  const out = JSON.stringify(report);
  for (const bad of [': SQLITE', '(extended', 'constraint failed', '[code', 'D1_ERROR:', 'APIError']) assert.ok(!out.includes(bad), bad);
});

test('source never runs cleanup phases, DROP, retries or report files', () => {
  const src = readFileSync(path.join(here, 'd1-tx-probe-run.mjs'), 'utf8');
  assert.ok(!/cleanup-data|cleanup-marker|cleanup-reinspect|final-precondition/.test(src));
  // Comments may describe the no-retry contract; 'retryAfterMs' is the APIError key the classifier REJECTS, and
  // 'authorizesRetry'/'hasRetryAfter' are fixed false/boolean diagnostic field names (not retry logic).
  const code = src.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '').replaceAll('retryAfterMs', '').replaceAll('authorizesRetry', '')
    .replaceAll('hasRetryAfter', '');
  assert.ok(!/retr(y|ies)|attempts?\s*[<+]|while\s*\(|for\s*\(\s*let\s+\w+\s*=\s*0/i.test(code), 'no retry loop in executor code');
  assert.ok(!/writeFileSync|appendFile|console\.(log|error)/.test(src));
  assert.deepEqual([...EXECUTED_PHASES].sort(), ['constraint-abort', 'guard-abort', 'inspect', 'positive', 'precondition', 'setup']);
});
