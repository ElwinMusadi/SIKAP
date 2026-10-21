// Offline unit tests for verify-gas-v140-candidate.mjs using pure synthetic fixtures.
// Never reads the private baseline directory, never accesses clasp, and performs no remote I/O.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import {
  BASELINE_PACKAGE_SHA256,
  CUTOVER_HELPER_SHA256,
  HELPER_FILE,
  RECEIPT_FILE,
  assertSafeCandidateDir,
  computePackageSha256,
  parseAst,
  runCandidateVmChecks,
  verifySourceSnapshot,
  verifyVmSources,
  verifyGasV140Candidate,
} from './verify-gas-v140-candidate.mjs';

const HELPER_SRC = readFileSync(new URL('../../legacy-gas/src/backend/Cutover.gs', import.meta.url), 'utf8');

test('filesystem verifier rejects baseline overrides and getters before any I/O', async () => {
  for (const options of [undefined, {}, { candidateDir: 'unused', baselineDir: 'override' },
    Object.defineProperty({}, 'candidateDir', { get() { throw new Error('GETTER_EXECUTED'); }, enumerable: true })]) {
    await assert.rejects(() => verifyGasV140Candidate(options), { message: 'CLI_ARGUMENTS' });
  }
});

test('runCandidateVmChecks / verifyVmSources: validates all states on synthetic public & private functions', () => {
  const backendSources = {
    [HELPER_FILE]: HELPER_SRC,
    'backend/Api.js': [
      'function doGet(e) {',
      '  assertCutoverOpen_();',
      '  return "ok";',
      '}',
      'function doPost(e) {',
      '  assertCutoverOpen_();',
      '  return "ok";',
      '}',
      'function _formatDate_(d) {',
      '  return d;',
      '}',
    ].join('\n'),
  };

  const rep = runCandidateVmChecks(backendSources);
  assert.equal(rep.status, 'VM_CHECKS_PASSED');
  assert.equal(rep.publicEntries, 2);
  assert.equal(rep.casesPassed, 7); // 2 frozen + 2 invalid + 2 unavailable + 1 nocache
  assert.equal(rep.casesTotal, 7);
  assert.equal(rep.guardPropertyReads, 1);
  assert.equal(rep.runtimeFrozenVerified, false);
  assert.equal(rep.deploymentAuthorized, false);
  assert.equal(rep.authorizesExecution, false);
  assert.equal(rep.remoteAuthorized, false);
  assert.equal(rep.goLiveAuthorized, false);

  const repAlias = verifyVmSources(backendSources);
  assert.deepEqual(repAlias, rep);
});

test('runCandidateVmChecks: fails closed on hostile argument or Google service leak before guard', () => {
  const leakyArgSources = {
    [HELPER_FILE]: HELPER_SRC,
    'backend/LeakyArg.js': [
      'function doLeakArg(e) {',
      '  var x = e.parameter;',
      '  assertCutoverOpen_();',
      '  return x;',
      '}',
    ].join('\n'),
  };
  assert.throws(() => runCandidateVmChecks(leakyArgSources), (err) => err?.message === 'VM_GATE_LEAK');

  const leakyGoogleSources = {
    [HELPER_FILE]: HELPER_SRC,
    'backend/LeakyGoogle.js': [
      'function doLeakGoogle(e) {',
      '  SpreadsheetApp.getActive();',
      '  assertCutoverOpen_();',
      '}',
    ].join('\n'),
  };
  assert.throws(() => runCandidateVmChecks(leakyGoogleSources), (err) => err?.message === 'VM_GATE_LEAK');

  const leakyConsoleSources = {
    [HELPER_FILE]: HELPER_SRC,
    'backend/LeakyConsole.js': [
      'function doLeakConsole(e) {',
      '  console.log("hello");',
      '  assertCutoverOpen_();',
      '}',
    ].join('\n'),
  };
  assert.throws(() => runCandidateVmChecks(leakyConsoleSources), (err) => err?.message === 'VM_GATE_LEAK');
});

test('parseAst: correctly classifies public vs private functions and checks first guard', () => {
  const src = [
    'function publicOne() { assertCutoverOpen_(); return 1; }',
    'function publicMissing() { return 2; }',
    'function privateOne_() { return 3; }',
    'function privateGuarded_() { assertCutoverOpen_(); return 4; }',
  ].join('\n');

  const decls = parseAst('backend/Test.js', src);
  assert.equal(decls.length, 4);

  const p1 = decls.find((d) => d.name === 'publicOne');
  assert.ok(p1 && !p1.isPrivate && p1.firstGuard);

  const pm = decls.find((d) => d.name === 'publicMissing');
  assert.ok(pm && !pm.isPrivate && !pm.firstGuard);

  const pr1 = decls.find((d) => d.name === 'privateOne_');
  assert.ok(pr1 && pr1.isPrivate && !pr1.firstGuard);

  const prg = decls.find((d) => d.name === 'privateGuarded_');
  assert.ok(prg && prg.isPrivate && prg.firstGuard);
});

test('verifySourceSnapshot: rejects missing helper, invalid helper hash, and missing baseline files', () => {
  assert.throws(
    () => verifySourceSnapshot({ candidateFiles: {}, baselineFiles: null }),
    (err) => err?.message === 'BASELINE_HASH_MISMATCH',
  );

  const missingHelper = {
    'cutover-candidate.receipt.json': '{}',
  };
  assert.throws(
    () => verifySourceSnapshot({ candidateFiles: missingHelper, baselineFiles: {} }),
    (err) => err?.message === 'CUTOVER_HELPER_MISSING',
  );

  const badHelper = {
    [HELPER_FILE]: 'function assertCutoverOpen_() { return 1; }',
    'cutover-candidate.receipt.json': '{}',
  };
  assert.throws(
    () => verifySourceSnapshot({ candidateFiles: badHelper, baselineFiles: {} }),
    (err) => err?.message === 'CUTOVER_HELPER_HASH_MISMATCH',
  );
});

test('verifySourceSnapshot: fails closed on baseline package hash mismatch before VM execution', () => {
  // Construct 41 synthetic candidate source files + helper + receipt with exactly 43 public + 70 private functions
  const candidateFiles = {
    [HELPER_FILE]: HELPER_SRC,
    [RECEIPT_FILE]: '{"status":"synthetic"}',
    'appsscript.json': '{"timeZone":"Asia/Jakarta"}\n',
  };
  for (let i = 1; i <= 29; i++) {
    candidateFiles[`frontend/View_${i}.html`] = `<div>View ${i}</div>\n`;
  }

  // 43 public functions and 70 private functions distributed across 11 files
  const baselineFiles = {
    'appsscript.json': candidateFiles['appsscript.json'],
  };
  for (let i = 1; i <= 29; i++) {
    baselineFiles[`frontend/View_${i}.html`] = candidateFiles[`frontend/View_${i}.html`];
  }

  let pubIdx = 0;
  let privIdx = 0;
  for (let f = 1; f <= 11; f++) {
    const pubCount = f <= 10 ? 4 : 3; // 10*4 + 3 = 43
    const privCount = f <= 4 ? 7 : 6; // 4*7 + 7*6 = 70
    const candLines = [];
    const baseLines = [];
    for (let p = 0; p < pubCount; p++) {
      pubIdx++;
      candLines.push(`function pub_${pubIdx}() {\n  assertCutoverOpen_();\n  return ${pubIdx};\n}`);
      baseLines.push(`function pub_${pubIdx}() {\n  return ${pubIdx};\n}`);
    }
    for (let pr = 0; pr < privCount; pr++) {
      privIdx++;
      candLines.push(`function priv_${privIdx}_() {\n  return ${privIdx};\n}`);
      baseLines.push(`function priv_${privIdx}_() {\n  return ${privIdx};\n}`);
    }
    candidateFiles[`backend/Module_${f}.js`] = `${candLines.join('\n')}\n`;
    baselineFiles[`backend/Module_${f}.js`] = `${baseLines.join('\n')}\n`;
  }

  // Baseline package hash of synthetic files is not equal to BASELINE_PACKAGE_SHA256 (c99c...)
  assert.throws(
    () => verifySourceSnapshot({ candidateFiles, baselineFiles }),
    (err) => err?.message === 'BASELINE_HASH_MISMATCH',
  );
});

test('assertSafeCandidateDir: rejects invalid, relative, device/UNC, 8.3 short name, and inside-repo paths', async () => {
  await assert.rejects(() => assertSafeCandidateDir(path.resolve('..candidate-inside-repo')), { message: 'CANDIDATE_PATH_INSIDE_REPO' });
  await assert.rejects(
    () => assertSafeCandidateDir('relative/path'),
    (err) => err?.message === 'CANDIDATE_PATH_INVALID',
  );

  await assert.rejects(
    () => assertSafeCandidateDir('\\\\?\\C:\\temp\\candidate'),
    (err) => err?.message === 'CANDIDATE_PATH_DISALLOWED_PREFIX',
  );

  await assert.rejects(
    () => assertSafeCandidateDir('\\\\server\\share\\candidate'),
    (err) => err?.message === 'CANDIDATE_PATH_DISALLOWED_PREFIX',
  );

  await assert.rejects(
    () => assertSafeCandidateDir('//server/share/candidate'),
    (err) => err?.message === 'CANDIDATE_PATH_DISALLOWED_PREFIX',
  );

  await assert.rejects(
    () => assertSafeCandidateDir('C:\\temp\\test~1\\candidate'),
    (err) => err?.message === 'CANDIDATE_PATH_DISALLOWED_PREFIX',
  );

  await assert.rejects(
    () => assertSafeCandidateDir(process.cwd()),
    (err) => err?.message === 'CANDIDATE_PATH_INSIDE_REPO',
  );
});

test('computePackageSha256: produces deterministic hash for LF-normalized sorted entries', () => {
  assert.equal(typeof BASELINE_PACKAGE_SHA256, 'string');
  assert.equal(BASELINE_PACKAGE_SHA256.length, 64);
  assert.equal(typeof CUTOVER_HELPER_SHA256, 'string');
  assert.equal(CUTOVER_HELPER_SHA256.length, 64);

  const filesA = {
    'backend/B.js': 'function b() {\r\n  return 2;\r\n}\r\n',
    'backend/A.js': 'function a() {\n  return 1;\n}\n',
  };
  const filesB = {
    'backend/A.js': 'function a() {\r\n  return 1;\r\n}\r\n',
    'backend/B.js': 'function b() {\n  return 2;\n}\n',
  };

  const shaA = computePackageSha256(filesA);
  const shaB = computePackageSha256(filesB);
  assert.equal(shaA, shaB);
  assert.equal(typeof shaA, 'string');
  assert.equal(shaA.length, 64);
});
