// Local-only retirement tests for scripts/import/recover-uat-import.mjs.
// The recovery driver is PERMANENTLY and unconditionally retired: executeUatRecovery() returns the fixed
// STOPPED_RETIRED / DRIVER_RETIRED result before touching options, static checks, files, credentials or fetch.
// Isolation: never reads the private plan/credentials, never fetches, never spawns the CLI. CLI retirement is
// proven statically from the module source text (repository file only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeUatRecovery, RETIRED_RESULT, TARGET, ENDPOINT } from './recover-uat-import.mjs';

const APPROVED_ACCOUNT = '04b8b2073be2f1aa21fc6489e0db36f6';
const APPROVED_DB = '885b655b-3482-44fc-9d01-56ad0204bb35';
const EXPECTED_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${APPROVED_ACCOUNT}/d1/database/${APPROVED_DB}/query`;
const SOURCE = readFileSync(new URL('./recover-uat-import.mjs', import.meta.url), 'utf8');

const sentinel = () => {
  const counters = { calls: 0, traps: 0 };
  const fn = (name) => () => { counters.calls += 1; assert.fail(`${name} must never be invoked`); };
  const options = { readCredential: fn('readCredential'), fetchImpl: fn('fetchImpl'), readPlanBytes: fn('readPlanBytes'), readFileBytes: fn('readFileBytes'), checkOnly: true };
  const trap = () => { counters.traps += 1; throw new Error('options must never be accessed'); };
  const proxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
  const getters = {};
  for (const key of Object.keys(options)) Object.defineProperty(getters, key, { enumerable: true, get: trap });
  return { counters, options, proxy, getters };
};
const assertRetired = (res) => {
  assert.deepEqual(res, { ...RETIRED_RESULT });
  assert.equal(res.status, 'STOPPED_RETIRED');
  assert.equal(res.code, 'DRIVER_RETIRED');
  assert.equal(res.requests, 0);
  assert.equal(res.writeCapableRequests, 0);
  assert.notEqual(res, RETIRED_RESULT, 'caller receives a copy');
};

test('module exports fixed target and endpoint (historic constants retained)', () => {
  assert.ok(Object.isFrozen(TARGET));
  assert.deepEqual({ ...TARGET }, { accountId: APPROVED_ACCOUNT, databaseId: APPROVED_DB, databaseName: 'sikap-import-uat-20261018',
    bucket: 'sikap-import-uat-20261018-files', profile: 'real-data' });
  assert.equal(ENDPOINT, EXPECTED_ENDPOINT);
});

test('RETIRED_RESULT is frozen with every authority flag false', () => {
  assert.ok(Object.isFrozen(RETIRED_RESULT));
  assert.equal(RETIRED_RESULT.retired, true);
  assert.equal(RETIRED_RESULT.recoveryRun, false);
  assert.equal(RETIRED_RESULT.phase, 'RETIRED');
  for (const k of ['ready', 'readyForImport', 'readyProduction', 'remoteAuthorized', 'authorizesExecution', 'authorizesRetry', 'authorizesResume']) assert.equal(RETIRED_RESULT[k], false, k);
});

test('every input returns STOPPED_RETIRED with zero dependency calls', async () => {
  const s = sentinel();
  for (const input of [undefined, null, {}, 42, s.options, { ...s.options, checkOnly: false }, { ...s.options, force: true }, { [Symbol('x')]: true }]) {
    assertRetired(await executeUatRecovery(input));
  }
  assert.equal(s.counters.calls, 0);
});

test('getter and proxy sentinels are never touched (retirement precedes options access)', async () => {
  const s = sentinel();
  assertRetired(await executeUatRecovery(s.getters));
  assertRetired(await executeUatRecovery(s.proxy));
  assert.equal(s.counters.traps, 0);
  assert.equal(s.counters.calls, 0);
});

test('concurrent calls are all retired (no busy gate, no execution)', async () => {
  const s = sentinel();
  const results = await Promise.all([executeUatRecovery(s.options), executeUatRecovery(s.options), executeUatRecovery(s.proxy)]);
  results.forEach(assertRetired);
  assert.equal(s.counters.calls + s.counters.traps, 0);
});

test('CLI is statically retired: single isMain block writes RETIRED_RESULT, historic paths unreachable, no override', () => {
  assert.equal(SOURCE.match(/isMain\(/g).length, 1);
  assert.match(SOURCE, /if \(isMain\(import\.meta\.url\)\) \{\n {2}process\.exitCode = 1;\n {2}process\.stdout\.write\(`\$\{JSON\.stringify\(RETIRED_RESULT\)\}\\n`\);\n\}\n?$/);
  assert.match(SOURCE, /export async function executeUatRecovery\(\) \{ return \{ \.\.\.RETIRED_RESULT \}; \}/);
  assert.equal(SOURCE.match(/historicCli\(/g).length, 1, 'historicCli is declared only, never called');
  assert.equal(SOURCE.match(/historicExecuteUatRecovery\(/g).length, 2, 'historic API referenced only by historicCli');
  const code = SOURCE.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /process\.env|--force|RE_?ENABLE|ALLOW_RETIRED/i);
});
