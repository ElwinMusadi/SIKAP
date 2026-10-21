// Local-only retirement tests for scripts/import/reset-approved-uat.mjs.
// The destructive DROP TABLE reset of the old UAT target (885b655b...) is PERMANENTLY and unconditionally
// retired: executeReset() returns the fixed STOPPED_RETIRED / DRIVER_RETIRED result before touching options,
// static checks, files, credentials or fetch. The historic 4-request protocol tests were removed with it.
// Isolation: never reads credentials, never fetches, never spawns the CLI. CLI retirement is proven
// statically from the module source text (repository file only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeReset, RETIRED_RESULT } from './reset-approved-uat.mjs';

const SOURCE = readFileSync(new URL('./reset-approved-uat.mjs', import.meta.url), 'utf8');

const sentinel = () => {
  const counters = { calls: 0, traps: 0 };
  const fn = (name) => () => { counters.calls += 1; assert.fail(`${name} must never be invoked`); };
  const options = { readCredential: fn('readCredential'), fetchImpl: fn('fetchImpl'), checkOnly: false };
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
  assert.equal(res.dropSent, false);
  assert.notEqual(res, RETIRED_RESULT, 'caller receives a copy');
};

test('RETIRED_RESULT is frozen, names the old UAT target and reports no drop/authority', () => {
  assert.ok(Object.isFrozen(RETIRED_RESULT));
  assert.equal(RETIRED_RESULT.targetId, '885b655b-3482-44fc-9d01-56ad0204bb35');
  assert.equal(RETIRED_RESULT.targetName, 'sikap-import-uat-20261018');
  assert.equal(RETIRED_RESULT.retired, true);
  for (const k of ['dropSent', 'dropConfirmed', 'manualReviewRequired', 'r2Touched', 'retryAttempted', 'authorizesRetry', 'importAuthorized']) assert.equal(RETIRED_RESULT[k], false, k);
});

test('every input (incl. checkOnly true/false) returns STOPPED_RETIRED with zero dependency calls', async () => {
  const s = sentinel();
  for (const input of [undefined, null, {}, 42, s.options, { ...s.options, checkOnly: true }, { ...s.options, force: true }, { [Symbol('x')]: true }]) {
    assertRetired(await executeReset(input));
  }
  assert.equal(s.counters.calls, 0);
});

test('getter and proxy sentinels are never touched (retirement precedes options access)', async () => {
  const s = sentinel();
  assertRetired(await executeReset(s.getters));
  assertRetired(await executeReset(s.proxy));
  assert.equal(s.counters.traps, 0);
  assert.equal(s.counters.calls, 0);
});

test('CLI is statically retired: single isMain block writes RETIRED_RESULT, historic paths unreachable, no override', () => {
  assert.equal(SOURCE.match(/isMain\(/g).length, 1);
  assert.match(SOURCE, /if \(isMain\(import\.meta\.url\)\) \{\n {2}process\.exitCode = 1;\n {2}process\.stdout\.write\(`\$\{JSON\.stringify\(RETIRED_RESULT\)\}\\n`\);\n\}\n?$/);
  assert.match(SOURCE, /export async function executeReset\(\) \{ return \{ \.\.\.RETIRED_RESULT \}; \}/);
  assert.equal(SOURCE.match(/historicCli\(/g).length, 1, 'historicCli is declared only, never called');
  assert.equal(SOURCE.match(/historicExecuteReset\(/g).length, 2, 'historic API referenced only by historicCli');
  const code = SOURCE.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /process\.env|--force|RE_?ENABLE|ALLOW_RETIRED/i);
});
