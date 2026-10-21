// Local-only retirement tests for scripts/import/verify-uat-import.mjs.
// The read-only post-import verifier of the old UAT target is PERMANENTLY and unconditionally retired:
// executeVerification() returns the fixed STOPPED_RETIRED / DRIVER_RETIRED result before touching options,
// the private plan, local simulation, credentials or fetch (D1 POST / R2 GET).
// Isolation: never reads the private plan/credentials, never fetches, never spawns the CLI. CLI retirement is
// proven statically from the module source text (repository file only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeVerification, RETIRED_RESULT } from './verify-uat-import.mjs';

const SOURCE = readFileSync(new URL('./verify-uat-import.mjs', import.meta.url), 'utf8');

const sentinel = () => {
  const counters = { calls: 0, traps: 0 };
  const fn = (name) => () => { counters.calls += 1; assert.fail(`${name} must never be invoked`); };
  const options = { readPlanBytes: fn('readPlanBytes'), readCredential: fn('readCredential'), fetchImpl: fn('fetchImpl'), checkOnly: false };
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
  assert.equal(res.blockedRequests, 0);
  assert.equal(res.writeAttempts, 0);
  assert.notEqual(res, RETIRED_RESULT, 'caller receives a copy');
};

test('RETIRED_RESULT is frozen, names the old UAT target, all counters zero and authority flags false', () => {
  assert.ok(Object.isFrozen(RETIRED_RESULT));
  assert.equal(RETIRED_RESULT.targetId, '885b655b-3482-44fc-9d01-56ad0204bb35');
  assert.equal(RETIRED_RESULT.targetName, 'sikap-import-uat-20261018');
  assert.equal(RETIRED_RESULT.phase, 'RETIRED');
  assert.equal(RETIRED_RESULT.retired, true);
  assert.equal(RETIRED_RESULT.uatOnly, true);
  for (const k of ['d1Compared', 'wholeBucketVerified', 'readyForProduction', 'remoteAuthorized', 'authorizesExecution', 'authorizesRetry',
    'completeFlagSet', 'appBindingAllowed', 'cleanupAttempted']) assert.equal(RETIRED_RESULT[k], false, k);
});

test('every input (incl. checkOnly true/false) returns STOPPED_RETIRED with zero dependency calls', async () => {
  const s = sentinel();
  assertRetired(await executeVerification());
  for (const input of [undefined, null, {}, 42, s.options, { ...s.options, checkOnly: true }, { ...s.options, force: true }, { [Symbol('x')]: true }]) {
    assertRetired(await executeVerification(input));
  }
  assert.equal(s.counters.calls, 0);
});

test('getter and proxy sentinels are never touched (retirement precedes options access)', async () => {
  const s = sentinel();
  assertRetired(await executeVerification(s.getters));
  assertRetired(await executeVerification(s.proxy));
  assert.equal(s.counters.traps, 0);
  assert.equal(s.counters.calls, 0);
});

test('concurrent calls are all retired (no busy gate, no execution)', async () => {
  const s = sentinel();
  const results = await Promise.all([executeVerification(s.options), executeVerification(s.options), executeVerification(s.proxy)]);
  results.forEach(assertRetired);
  assert.equal(s.counters.calls + s.counters.traps, 0);
});

test('CLI is statically retired: single isMain block writes RETIRED_RESULT, historic paths unreachable, no override', () => {
  assert.equal(SOURCE.match(/isMain\(/g).length, 1);
  assert.match(SOURCE, /if \(isMain\(import\.meta\.url\)\) \{\n {2}process\.exitCode = 1;\n {2}process\.stdout\.write\(`\$\{JSON\.stringify\(RETIRED_RESULT\)\}\\n`\);\n\}\n?$/);
  assert.match(SOURCE, /export async function executeVerification\(\) \{ return \{ \.\.\.RETIRED_RESULT \}; \}/);
  assert.equal(SOURCE.match(/historicCli\(/g).length, 1, 'historicCli is declared only, never called');
  assert.equal(SOURCE.match(/historicExecuteVerification\(/g).length, 2, 'historic API referenced only by historicCli');
  const code = SOURCE.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /process\.env|--force|RE_?ENABLE|ALLOW_RETIRED/i);
});
