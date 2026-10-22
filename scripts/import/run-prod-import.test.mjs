// Local safety tests for scripts/import/run-prod-import.mjs (thin production entry, pins PENDING).
// Never reads a private plan, credentials, OAuth token or the network: every dependency is a throwing stub.
// The CLI is spawned only for argument-error cases that stop before any read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeProductionImport, parseCredentialEnv, TARGET, ENDPOINT, PLAN_FACTS, MODULE_FILES, SELF_SOURCES, CLI_MODES } from './run-prod-import.mjs';
import { PROD_TARGET, UAT_TARGET, REHEARSAL_TARGET } from './real-data-gate.mjs';
import * as PINS from './prod-import-pins.mjs';
import { IMPORT_SCHEMA_SKIP } from './historical-schema.mjs';

const h = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lf = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const counters = () => ({ cred: 0, fetch: 0, plan: 0, file: 0, now: 0 });
function options(c, over = {}) {
  return {
    readCredential: async () => { c.cred++; assert.fail('credential must not be read'); },
    fetchImpl: async () => { c.fetch++; assert.fail('network must not be used'); },
    readPlanBytes: async () => { c.plan++; assert.fail('plan must not be read'); },
    readFileBytes: async () => { c.file++; assert.fail('file must not be read'); },
    now: () => { c.now++; return '2026-10-20T00:00:00.000Z'; },
    mode: 'check-only', ...over,
  };
}
const zero = { cred: 0, fetch: 0, plan: 0, file: 0, now: 0 };

test('exports the frozen production target equal to the gate pin and a matching endpoint', () => {
  assert.equal(TARGET, PROD_TARGET);
  assert.ok(Object.isFrozen(TARGET));
  assert.equal(TARGET.profile, 'real-data');
  assert.match(TARGET.databaseName, /^sikap-import-prod-/);
  assert.equal(ENDPOINT, `https://api.cloudflare.com/client/v4/accounts/${TARGET.accountId}/d1/database/${TARGET.databaseId}/query`);
  for (const other of [UAT_TARGET, REHEARSAL_TARGET]) { assert.notEqual(TARGET.databaseId, other.databaseId); assert.notEqual(TARGET.bucket, other.bucket); }
});

test('all plan facts and every runtime module pin are PENDING; entry re-exports the pins module', () => {
  assert.equal(PLAN_FACTS, PINS.PLAN_FACTS); assert.equal(MODULE_FILES, PINS.MODULE_FILES); assert.equal(SELF_SOURCES, PINS.SELF_SOURCES);
  assert.equal(PLAN_FACTS.snapshotId, 'c7d62229-c808-4972-a6c3-975e8927dd15'); assert.equal(PLAN_FACTS.diagnosticsTotal, 74);
  assert.deepEqual(PLAN_FACTS.expected, { pegawai: 46, akun: 46, arsip: 63, files: 66, totalFileBytes: 44162297, arsipPerStatus: { Menunggu: 1, Terverifikasi: 59, Ditolak: 3 } });
  assert.equal(Object.values(PLAN_FACTS.warningCounts).reduce((a, b) => a + b, 0), 74);
  assert.match(PLAN_FACTS.planSha256, /^[0-9a-f]{64}$/); assert.notEqual(PLAN_FACTS.planSha256, PINS.PENDING);
  assert.ok(Object.isFrozen(PLAN_FACTS) && Object.isFrozen(PLAN_FACTS.expected) && Object.isFrozen(PLAN_FACTS.warningCounts) && Object.isFrozen(MODULE_FILES) && Object.isFrozen(PINS.MODULE_PINS));
  for (const [file, pin] of PINS.MODULE_PINS) { assert.match(pin, /^[0-9a-f]{64}$/); assert.equal(pin, h(lf(file))); }
  assert.deepEqual(PINS.MODULE_PINS.map(([f]) => f), [...MODULE_FILES]);
  for (const self of SELF_SOURCES) assert.ok(!MODULE_FILES.includes(self));
  assert.ok(MODULE_FILES.includes('scripts/staging/uat-constants.mjs'));
  assert.ok(MODULE_FILES.includes('scripts/import/prod-import-orchestrator.mjs'));
});

test('MODULE_FILES equals the transitive relative-import closure of the entry minus self-sources', () => {
  const seen = new Set(), queue = ['scripts/import/run-prod-import.mjs'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = lf(file);
    for (const m of text.matchAll(/(?:^import\s[^;]*?from\s+|import\()\s*'(\.{1,2}\/[^']+)'/gm)) {
      queue.push(new URL(m[1], new URL(`file:///${file}`)).pathname.slice(1));
    }
  }
  const closure = [...seen].filter((f) => !SELF_SOURCES.includes(f)).sort();
  assert.deepEqual(closure, [...MODULE_FILES].sort());
  // pins module must have no imports at all
  assert.doesNotMatch(lf('scripts/import/prod-import-pins.mjs'), /^\s*import\s/m);
});

test('options are strictly validated before any I/O (now is required)', async () => {
  const c = counters();
  const base = options(c);
  const getter = { ...base }; Object.defineProperty(getter, 'mode', { get: () => 'check-only', enumerable: true });
  const symbol = { ...base, [Symbol('x')]: 1 };
  for (const bad of [undefined, null, {}, 'check-only', [], { ...base, extra: 1 }, { ...base, mode: 'import-now' }, { ...base, mode: true }, { ...base, mode: undefined },
    ...Object.keys(base).map((k) => { const o = { ...base }; delete o[k]; return o; }), getter, symbol, { ...base, fetchImpl: null }, { ...base, now: 'x' },
    { ...base, kind: 'synthetic-rehearsal' }, { ...base, rehearsal: {} }, { ...base, target: REHEARSAL_TARGET }, new Proxy({ ...base }, { ownKeys() { throw new Error('trap'); } })]) {
    const r = await executeProductionImport(bad);
    assert.equal(r.status, 'STOPPED_ARGS'); assert.equal(r.code, 'OPTIONS_INVALID');
    assert.equal(r.requests, 0); assert.equal(r.writeAttempts, 0); assert.equal(r.productionImport, true);
  }
  assert.deepEqual(c, zero);
});

test('check-only, import and describe-plan pass the pinned static check, then stop at the (stubbed) private plan, before credential, clock or HTTP', { skip: IMPORT_SCHEMA_SKIP }, async () => {
  for (const mode of ['check-only', 'import', 'describe-plan']) {
    const c = counters();
    const r = await executeProductionImport(options(c, { mode }));
    assert.equal(r.status, 'STOPPED_PRIVATE_VALIDATION');
    assert.notEqual(r.code, 'RUNTIME_PIN_PENDING'); assert.notEqual(r.code, 'PLAN_PIN_PENDING');
    assert.equal(r.kind, 'production'); assert.equal(r.targetId, PROD_TARGET.databaseId);
    assert.equal(r.requests, 0); assert.equal(r.writeAttempts, 0); assert.equal(r.setupStatements.applied, 0);
    assert.equal(c.cred, 0); assert.equal(c.fetch, 0); assert.equal(c.now, 0);
    assert.deepEqual(r.bindingInventory, { configFiles: 5, localOnly: true, remoteBindingProof: false });
    for (const key of ['ready', 'readyForImport', 'remoteAuthorized', 'authorizesExecution', 'completeFlagSet', 'appBindingAllowed', 'deployed', 'cleanupAttempted', 'syntheticRehearsal', 'remoteBindingProof', 'tokenScopeVerified', 'credentialRefreshed']) assert.equal(r[key], false);
    assert.equal(r.productionImport, true);
  }
});

test('print-module-pins reads local modules only, includes self-sources (not enforced), never touches plan, credential or network', async () => {
  const c = counters();
  const r = await executeProductionImport(options(c, { mode: 'print-pins' }));
  assert.equal(r.status, 'PINS_PRINTED');
  assert.deepEqual(r.modulePins.map(([f]) => f), [...MODULE_FILES]);
  for (const [file, pin] of r.modulePins) assert.equal(pin, h(lf(file)));
  assert.deepEqual(r.selfSources.map(([f]) => f), [...SELF_SOURCES]);
  for (const [file, pin] of r.selfSources) assert.equal(pin, h(lf(file)));
  assert.equal(r.selfSourcesEnforced, false);
  assert.deepEqual(c, zero);
});

test('parseCredentialEnv: exact five names once each, comments ignored, BOM/CRLF/quotes handled, errors carry no value', () => {
  const TOKEN = 'SYNTH-D1-TOKEN-' + 'a'.repeat(30), KEYID = 'SYNTHKEYID0000001', SECRET = 'SYNTH/secret+value=0001', EXP = '2026-10-21T06:00:00Z';
  const body = [`D1_API_TOKEN=${TOKEN}`, `D1_API_TOKEN_EXPIRES_AT=${EXP}`, `R2_ACCESS_KEY_ID=${KEYID}`, `R2_SECRET_ACCESS_KEY=${SECRET}`, `R2_ACCESS_KEY_EXPIRES_AT=${EXP}`];
  const want = { token: TOKEN, expiresAt: EXP, accessKeyId: KEYID, secretAccessKey: SECRET, r2ExpiresAt: EXP };
  assert.deepEqual(parseCredentialEnv(body.join('\n')), want);
  assert.deepEqual(parseCredentialEnv('﻿' + body.join('\r\n') + '\r\n'), want);               // BOM + CRLF
  assert.deepEqual(parseCredentialEnv(body.map((l) => `export ${l}`).join('\n')), want);           // export prefix
  assert.deepEqual(parseCredentialEnv(body.map((l) => l.replace('=', '="') + '"').join('\n')), want); // double quotes
  assert.deepEqual(parseCredentialEnv(body.map((l) => l.replace('=', "='") + "'").join('\n')), want);  // single quotes
  assert.deepEqual(parseCredentialEnv(['# D1_API_TOKEN=commented', ...body, '  # R2_ACCESS_KEY_ID=also commented'].join('\n')), want);
  assert.deepEqual(parseCredentialEnv(body.map((l) => l + '   # trailing comment').join('\n')), want);
  const fails = (text) => { try { parseCredentialEnv(text); return 'no-throw'; } catch (e) { return e; } };
  const cases = {
    duplicate: [...body, `D1_API_TOKEN=${TOKEN}`].join('\n'),
    missingR2Expiry: body.slice(0, 4).join('\n'),
    missingToken: body.slice(1).join('\n'),
    emptyValue: body.map((l) => (l.startsWith('R2_SECRET_ACCESS_KEY') ? 'R2_SECRET_ACCESS_KEY=' : l)).join('\n'),
    spaceInValue: body.map((l) => (l.startsWith('D1_API_TOKEN=') ? 'D1_API_TOKEN=two words' : l)).join('\n'),
    unterminatedQuote: body.map((l) => (l.startsWith('R2_ACCESS_KEY_ID') ? 'R2_ACCESS_KEY_ID="oops' : l)).join('\n'),
    notString: undefined,
  };
  for (const [name, text] of Object.entries(cases)) {
    const e = fails(text);
    assert.notEqual(e, 'no-throw', name);
    assert.equal(e.code, 'CREDENTIAL_FORMAT', name);
    const shown = `${e.message}|${e.code}|${e.stack ?? ''}`;
    for (const secret of [TOKEN, KEYID, SECRET, 'two words', 'oops']) assert.ok(!shown.includes(secret), `${name} leaked a value`);
  }
});

test('concurrent runs are rejected as busy', async () => {
  const first = executeProductionImport(options(counters(), { mode: 'print-pins' }));
  const second = await executeProductionImport(options(counters(), { mode: 'print-pins' }));
  assert.equal((await first).status, 'PINS_PRINTED');
  assert.ok(['STOPPED_BUSY', 'PINS_PRINTED'].includes(second.status));
  assert.equal((await executeProductionImport(options(counters(), { mode: 'print-pins' }))).status, 'PINS_PRINTED');
});

test('CLI: no arguments, unknown, extra or legacy flags exit 2 before any read', () => {
  const entry = fileURLToPath(new URL('./run-prod-import.mjs', import.meta.url));
  for (const argv of [[], ['--import'], ['--force'], ['--import-production', '--check-only'], ['--check-only', '--target=x'], ['import']]) {
    const r = spawnSync(process.execPath, [entry, ...argv], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
    assert.equal(r.status, 2, JSON.stringify(argv));
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 'STOPPED_ARGS'); assert.equal(out.code, 'CLI_ARGUMENTS'); assert.equal(out.requests, 0);
  }
  assert.deepEqual(Object.keys(CLI_MODES).sort(), ['--check-only', '--describe-plan', '--import-production', '--print-module-pins']);
  assert.ok(Object.isFrozen(CLI_MODES));
});

test('source stays closed: no env/shell/force, single fetch wiring in the CLI block, rehearsal unreachable', () => {
  const source = lf('scripts/import/run-prod-import.mjs').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  for (const pattern of [/process\.env/, /child_process/, /885b655b/, /sikap-import-uat/, /eval\(/, /new Function/, /--force/, /synthetic-rehearsal/, /issueRealData/, /REHEARSAL/, /rehearsal:/]) assert.doesNotMatch(source, pattern);
  assert.equal((source.match(/globalThis\.fetch/g) ?? []).length, 1);
  assert.ok(source.indexOf('globalThis.fetch') > source.indexOf('if (isMain(import.meta.url))'));
  assert.match(source, /kind: 'production'/);
  assert.equal((source.match(/kind:/g) ?? []).length, 2); // orchestrate call + argsStop literal
  assert.match(source, /verifyPrivatePersistence/);
});
