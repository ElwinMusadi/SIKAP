// Local-only retirement tests for scripts/import/run-approved-proof.mjs.
// The proof driver is PERMANENTLY and unconditionally retired: executeApprovedProof() returns the fixed
// STOPPED_RETIRED / DRIVER_RETIRED result before touching options (whose historic defaults were the real
// OAuth reader and globalThis.fetch), static checks, files, credentials or fetch.
// Isolation: never reads credentials, never fetches, never spawns the CLI. CLI retirement is proven
// statically from the module source text (repository file only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeApprovedProof, RETIRED_RESULT, TARGET, ENDPOINT } from './run-approved-proof.mjs';

const APPROVED_ACCOUNT = '04b8b2073be2f1aa21fc6489e0db36f6';
const APPROVED_DB = 'e54f0a4a-27b3-412d-9ad0-ea8dd2c7b6c1';
const EXPECTED_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${APPROVED_ACCOUNT}/d1/database/${APPROVED_DB}/query`;
const SOURCE = readFileSync(new URL('./run-approved-proof.mjs', import.meta.url), 'utf8');

const sentinel = () => {
  const counters = { calls: 0, traps: 0 };
  const fn = (name) => () => { counters.calls += 1; assert.fail(`${name} must never be invoked`); };
  const options = { readCredential: fn('readCredential'), fetchImpl: fn('fetchImpl'), checkOnly: true };
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
  assert.equal(res.mutatingRequests, 0);
  assert.notEqual(res, RETIRED_RESULT, 'caller receives a copy');
};

test('module exports fixed target and endpoint (historic constants retained)', () => {
  assert.ok(Object.isFrozen(TARGET));
  assert.deepEqual({ ...TARGET }, { accountId: APPROVED_ACCOUNT, databaseId: APPROVED_DB, databaseName: 'sikap-import-proof-20261018',
    bucket: 'sikap-import-proof-20261018-files' });
  assert.equal(ENDPOINT, EXPECTED_ENDPOINT);
});

test('RETIRED_RESULT is frozen, reports no residue and every authority flag false', () => {
  assert.ok(Object.isFrozen(RETIRED_RESULT));
  assert.equal(RETIRED_RESULT.retired, true);
  assert.equal(RETIRED_RESULT.phase, 'RETIRED');
  assert.equal(RETIRED_RESULT.syntheticRowsMayRemain, false);
  assert.equal(RETIRED_RESULT.manualRecoveryRequired, false);
  for (const k of ['ready', 'remoteAuthorized', 'authorizesExecution', 'authorizesRetry']) assert.equal(RETIRED_RESULT[k], false, k);
});

test('default call (no options, historic real-I/O defaults) and every input return STOPPED_RETIRED', async () => {
  const s = sentinel();
  assertRetired(await executeApprovedProof());
  for (const input of [undefined, null, {}, 42, s.options, { ...s.options, checkOnly: false }, { ...s.options, force: true }, { [Symbol('x')]: true }]) {
    assertRetired(await executeApprovedProof(input));
  }
  assert.equal(s.counters.calls, 0);
});

test('getter and proxy sentinels are never touched (retirement precedes options access)', async () => {
  const s = sentinel();
  assertRetired(await executeApprovedProof(s.getters));
  assertRetired(await executeApprovedProof(s.proxy));
  assert.equal(s.counters.traps, 0);
  assert.equal(s.counters.calls, 0);
});

test('CLI is statically retired: single isMain block writes RETIRED_RESULT, historic paths unreachable, no override', () => {
  assert.equal(SOURCE.match(/isMain\(/g).length, 1);
  assert.match(SOURCE, /if \(isMain\(import\.meta\.url\)\) \{\n {2}process\.exitCode = 1;\n {2}process\.stdout\.write\(`\$\{JSON\.stringify\(RETIRED_RESULT\)\}\\n`\);\n\}\n?$/);
  assert.match(SOURCE, /export async function executeApprovedProof\(\) \{ return \{ \.\.\.RETIRED_RESULT \}; \}/);
  assert.equal(SOURCE.match(/historicCli\(/g).length, 1, 'historicCli is declared only, never called');
  assert.equal(SOURCE.match(/historicExecuteApprovedProof\(/g).length, 2, 'historic API referenced only by historicCli');
  const code = SOURCE.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /process\.env|--force|RE_?ENABLE|ALLOW_RETIRED/i);
});
