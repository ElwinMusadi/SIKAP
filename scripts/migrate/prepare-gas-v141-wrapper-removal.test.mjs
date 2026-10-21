// Synthetic-fixture tests for the v141 wrapper-removal builder. Never reads the private v141 source, bundle or
// the v140 baseline; never calls buildWrapperRemoval with a valid private parent (only pre-read failures).
// No network/credentials/clasp/Google. Filesystem tests use test-owned OS temp fixtures that the TEST removes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as mod from './prepare-gas-v141-wrapper-removal.mjs';
import { HELPER_SHA256 as V140_HELPER_SHA256 } from './prepare-gas-v140.mjs';
import { ROOT, sha256 } from './local-store.mjs';

const {
  BUNDLE_BYTES, BUNDLE_SHA256, EXPECTED, EXPECTED_PATHS, HELPER_SHA256, INPUT_PACKAGE_SHA256, MAINTENANCE_INPUT_SHA256,
  MAINTENANCE_OUTPUT_SHA256, OUTPUT_PACKAGE_SHA256, RECEIPT_FILE, REMOVED_SPAN_BYTES, REMOVED_SPAN_SHA256, SOURCE_ROOT, STATUS,
  analyzeGas, buildReceipt, buildWrapperRemoval, checkPathSet, checkRelPath, decodeStrict, eolOf, guardedSetMatchesHandlers, outputPath,
  parseArgs, patchMaintenanceBytes, preparePinnedPackage, rawPackageSha256, readRegularFileOnce, restoreMaintenanceBytes, writeOutputTree,
} = mod;
const code = (c) => (error) => error?.code === c;
const SCRIPT = fileURLToPath(new URL('./prepare-gas-v141-wrapper-removal.mjs', import.meta.url));
const W1 = 'function tmpRevoke() { revokePublicSharing_(); }';
const W2 = 'function tmpCheck()  { checkPublicSharing_(); }';
// Comments mention the wrappers (must be preserved); multibyte text before the span checks byte offsets.
const lines = (eol, mid = [W1, W2, '']) => [
  '// Pemeliharaan — dokumen 📄 é',
  `//        ${W1}`,
  `//        ${W2}`,
  'function revokePublicSharing_() { return 1; }',
  'function checkPublicSharing_() { return 2; }',
  ...mid,
  '/** keep ñ */',
  'function keep_() { return 0; }',
  '',
].join(eol);
const LF = lines('\n'), CRLF = lines('\r\n');
const B = (s) => Buffer.from(s, 'utf8');

test('patchMaintenanceBytes removes exactly decl+EOL+decl+EOL+EOL, preserves comments/EOL, inverse is byte-exact', () => {
  for (const [src, eol] of [[LF, '\n'], [CRLF, '\r\n']]) {
    const input = B(src), copy = Buffer.from(input);
    const r = patchMaintenanceBytes(input);
    const expected = B(src.replace(`${W1}${eol}${W2}${eol}${eol}`, ''));
    assert.ok(r.bytes.equals(expected));
    assert.equal(r.removedByteLength, (eol === '\n' ? REMOVED_SPAN_BYTES : REMOVED_SPAN_BYTES + 3));
    assert.equal(r.removedByteOffset, B(src.slice(0, src.indexOf(`${W1}${eol}${W2}`))).length); // byte, not UTF-16, offset
    assert.notEqual(r.removedByteOffset, src.indexOf(`${W1}${eol}${W2}`));
    assert.equal(r.eol, eol === '\n' ? 'LF' : 'CRLF');
    assert.ok(input.equals(copy), 'input not mutated');
    const removed = input.subarray(r.removedByteOffset, r.removedByteOffset + r.removedByteLength);
    assert.equal(sha256(removed), r.removedSha256);
    assert.ok(restoreMaintenanceBytes(r.bytes, removed, r.removedByteOffset).equals(input));
    const out = r.bytes.toString('utf8');
    assert.equal(out.split(`//        ${W1}`).length, 2, 'comment mention preserved');
    assert.equal(eolOf(out), eol === '\n' ? 'LF' : 'CRLF');
    assert.ok(!out.includes(`\n${W1}`) && !out.includes(`\n${W2}`));
  }
  // Pinned 98-byte span digest corresponds to exactly this text on LF basis.
  assert.equal(sha256(B(`${W1}\n${W2}\n\n`)), REMOVED_SPAN_SHA256);
  assert.equal(B(`${W1}\n${W2}\n\n`).length, REMOVED_SPAN_BYTES);
});

test('patchMaintenanceBytes fails closed on any non-exact wrapper shape; input never mutated', () => {
  const bad = [
    [lines('\n', [W1.replace('{ ', '{ assertCutoverOpen_(); '), W2, '']), 'WRAPPER_SHAPE'], // guarded
    [lines('\n', [W1.replace('revokePublicSharing_()', 'revokePublicSharing_(1)'), W2, '']), 'WRAPPER_SHAPE'],
    [lines('\n', [W1.replace('tmpRevoke()', 'tmpRevoke(a)'), W2, '']), 'WRAPPER_SHAPE'],
    [lines('\n', [W1.replace('revokePublicSharing_();', 'revokePublicSharing_(); return;'), W2, '']), 'WRAPPER_SHAPE'],
    [lines('\n', [W1.replace('revokePublicSharing_', 'checkPublicSharing_'), W2, '']), 'WRAPPER_SHAPE'],
    [lines('\n', [W2, W1, '']), 'WRAPPER_SHAPE'], // order
    [lines('\n', [W1, 'function x_() {}', W2, '']), 'WRAPPER_SHAPE'], // not adjacent
    [lines('\n', [W1, W2]), 'WRAPPER_SPAN'], // no blank separator line
    [lines('\n', [W1, '', W2, '']), 'WRAPPER_SPAN'], // extra separator
    [lines('\n', [`${W1} ${W2}`, '']), 'WRAPPER_SPAN'], // same line
    [lines('\n', [`;${W1}`, W2, '']), 'WRAPPER_SPAN'], // not at line start
    [lines('\n', [W1, W2, '', W1, '']), 'WRAPPER_DUPLICATE'],
    [lines('\n', [W1, '']), 'WRAPPER_SHAPE'], // missing second
    [lines('\n', ['async ' + W1, W2, '']), 'WRAPPER_SHAPE'],
    [LF.replace('keep_() { return 0; }\n', 'keep_() { return 0; }\r\n'), 'EOL_MIXED'],
    [LF.replace('keep_()', 'keep_()\r'), 'EOL_MIXED'], // bare CR
    [`\uFEFF${LF}`, 'MAINTENANCE_ENCODING'],
    [LF.replace('function keep_()', 'function keep_( {'), 'PARSE_ERROR'],
  ];
  for (const [src, c] of bad) {
    const input = B(src), copy = Buffer.from(input);
    assert.throws(() => patchMaintenanceBytes(input), code(c), JSON.stringify(src.slice(150, 330)));
    assert.ok(input.equals(copy));
  }
  assert.throws(() => patchMaintenanceBytes(Buffer.from([0xc3, 0x28])), code('MAINTENANCE_ENCODING'));
  assert.throws(() => patchMaintenanceBytes(LF), code('MAINTENANCE_INVALID'));
  assert.throws(() => restoreMaintenanceBytes(B('a'), B('b'), 5), code('INVERSE_INVALID'));
});

test('eolOf/decodeStrict: pure CRLF or LF only; BOM, invalid UTF-8, bare CR and mixed rejected', () => {
  assert.equal(eolOf('a\nb\n'), 'LF');
  assert.equal(eolOf('a\r\nb\r\n'), 'CRLF');
  assert.equal(eolOf('no-newline'), 'LF');
  for (const s of ['a\r\nb\n', 'a\rb\n', 'a\r']) assert.throws(() => eolOf(s), code('EOL_MIXED'));
  assert.throws(() => decodeStrict(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), code('ENCODING_INVALID'));
  assert.throws(() => decodeStrict(Buffer.from([0xff])), code('ENCODING_INVALID'));
  assert.equal(decodeStrict(B('é\r\n')), 'é\r\n');
});

const gs = (obj) => new Map(Object.entries(obj));
const G = 'assertCutoverOpen_();';
test('analyzeGas: shared-scope counts; rejects aliases, duplicates, executable/string wrapper refs; comments allowed', () => {
  const ok = analyzeGas(gs({
    'backend/A.gs': `// tmpRevoke in a comment is fine\nfunction doGet(e) { ${G} return 1; }\nfunction a_() { var x = function () {}; return x; }\n`,
    'backend/B.gs': `function login(p) {\r\n  ${G}\r\n}\r\nfunction tmpCheck()  { checkPublicSharing_(); }\r\n`,
  }));
  assert.deepEqual([ok.publicFunctions, ok.guardedPublic, ok.privateFunctions], [3, 2, 1]);
  assert.deepEqual(ok.unguardedPublic, ['tmpCheck']);
  assert.deepEqual(ok.guardedNames, ['doGet', 'login']);
  assert.deepEqual(ok.wrapperDecls.map((d) => d.file), ['backend/B.gs']);
  for (const [src, c] of [
    ['var f = function () {};', 'TOPLEVEL_FUNCTION_VALUE'],
    ['var f = () => 1;', 'TOPLEVEL_FUNCTION_VALUE'],
    ['function a_() {}\nvar alias = a_;', 'TOPLEVEL_FUNCTION_VALUE'],
    ['g = function () {};', 'TOPLEVEL_FUNCTION_VALUE'],
    ['this.g = function () {};', 'TOPLEVEL_FUNCTION_VALUE'],
    ['this["g"] = function () {};', 'TOPLEVEL_FUNCTION_VALUE'],
    ['class K {}', 'TOPLEVEL_FUNCTION_VALUE'],
    ['var o = globalThis;', 'GLOBAL_ALIAS'],
    ['function a_() {}\nfunction b_() { a_ = null; }', 'FUNCTION_REASSIGNED'],
    ['function a() {}\nfunction a() {}', 'PUBLIC_DUPLICATE'],
    [`function a_() { ${G} }`, 'PRIVATE_GUARD_UNEXPECTED'],
    ['function x_() { tmpRevoke(); }', 'WRAPPER_REFERENCE'],
    ['var r = { k: tmpCheck };', 'WRAPPER_REFERENCE'],
    ['function x_() { return "tmpRevoke"; }', 'WRAPPER_REFERENCE'],
    ['function x_() { return `a ${1} tmpCheck`; }', 'WRAPPER_REFERENCE'],
    ['function x_() { function tmpRevoke() {} }', 'WRAPPER_REFERENCE'], // nested, not a top-level decl
    ['function a( {', 'PARSE_ERROR'],
  ]) assert.throws(() => analyzeGas(gs({ 'backend/X.gs': src })), code(c), src);
  // Cross-file public duplicate in shared global scope.
  assert.throws(() => analyzeGas(gs({ 'backend/A.gs': 'function p() {}', 'backend/B.gs': 'function p() {}' })), code('PUBLIC_DUPLICATE'));
  assert.throws(() => analyzeGas(gs({ 'frontend/A.html': 'function p() {}' })), code('AST_INPUT_INVALID'));
});

test('guardedSetMatchesHandlers: guarded set must equal API_HANDLERS(doPost) + doGet/doPost/cleanExpiredSessions', () => {
  const files = gs({
    'backend/API.gs': `function doPost(e) {\n  ${G}\n  var API_HANDLERS = { login: login, getX: getX };\n  return API_HANDLERS[e];\n}\n`
      + `function doGet() { ${G} }\nfunction cleanExpiredSessions() { ${G} }\nfunction login() { ${G} }\nfunction getX() { ${G} }\n`,
  });
  const a = analyzeGas(files);
  assert.equal(guardedSetMatchesHandlers(files, a.guardedNames), 2);
  assert.throws(() => guardedSetMatchesHandlers(files, [...a.guardedNames, 'extra']), code('PUBLIC_SET_MISMATCH'));
  assert.throws(() => guardedSetMatchesHandlers(files, a.guardedNames.filter((n) => n !== 'getX')), code('PUBLIC_SET_MISMATCH'));
});

test('path set: exact 42 ASCII relative names; traversal/ADS/reserved/case collision/extra/missing rejected', () => {
  assert.equal(EXPECTED_PATHS.length, EXPECTED.files);
  assert.deepEqual(checkPathSet([...EXPECTED_PATHS].reverse()), EXPECTED_PATHS);
  for (const p of ['../x', 'a/../b', '/abs', 'C:/x', 'a\\b', 'a:b', 'backend/x.gs:ads', 'CON', 'frontend/nul.html', '.clasp.json', 'a/b/c', 'é.gs', 'x.', 'a b'])
    assert.throws(() => checkRelPath(p), code('PATH_INVALID'), p);
  assert.throws(() => checkPathSet([...EXPECTED_PATHS.slice(1), EXPECTED_PATHS[1].toUpperCase()]), code('PATH_CASE_COLLISION'));
  assert.throws(() => checkPathSet([...EXPECTED_PATHS, 'backend/Extra.gs']), code('INVENTORY_MISMATCH'));
  assert.throws(() => checkPathSet(EXPECTED_PATHS.slice(1)), code('INVENTORY_MISMATCH'));
  assert.throws(() => checkPathSet([...EXPECTED_PATHS.slice(1), '.clasp.json']), code('PATH_INVALID'));
});

test('preparePinnedPackage is bound to production pins only: synthetic fixtures cannot pass; package hash basis is raw', () => {
  const fixture = new Map(EXPECTED_PATHS.map((p) => [p, B(p.endsWith('.gs') ? '// x\n' : 'x\n')]));
  assert.throws(() => preparePinnedPackage(fixture), code('INPUT_PACKAGE_MISMATCH'));
  assert.throws(() => preparePinnedPackage(new Map([...fixture].slice(1))), code('INVENTORY_MISMATCH'));
  assert.throws(() => preparePinnedPackage(new Map([...fixture].map(([k, v]) => [k, v.toString()]))), code('INVENTORY_MISMATCH'));
  assert.equal(preparePinnedPackage.length, 1); // no pin/override parameters
  const lf = new Map([['b', B('a\n')], ['a', B('é\n')]]), crlf = new Map([['a', B('é\r\n')], ['b', B('a\r\n')]]);
  assert.notEqual(rawPackageSha256(lf), rawPackageSha256(crlf)); // raw, not LF-normalized
  assert.equal(rawPackageSha256(lf), sha256(B(JSON.stringify([['a', sha256(B('é\n'))], ['b', sha256(B('a\n'))]]))));
});

test('pins are fixed module constants (immutable bindings); receipt has fixed false flags and no paths/source', () => {
  assert.equal(SOURCE_ROOT, path.resolve('C:/Users/elwin/sikap-private/source-v141-20261020'));
  assert.equal(BUNDLE_SHA256, '358df0721272e9529d2fbb825e0560bb272bcb171092f8777f0044573348a527');
  assert.equal(BUNDLE_BYTES, 751809);
  assert.equal(MAINTENANCE_INPUT_SHA256, '8588ef94d63bb1dc17c698e0c7dbb6504686d8bcaf1a06fe01d16caa6db17906');
  assert.equal(MAINTENANCE_OUTPUT_SHA256, '1d46eadf071f6463137ee48387737588ee1d305d3948c3dd3b7958dfaeb21bec');
  assert.equal(INPUT_PACKAGE_SHA256, 'df1dbf9c89c890f83622032336d433c5610a2b1bf02f120af1646077e258c5c6');
  assert.equal(OUTPUT_PACKAGE_SHA256, 'c57e2ba8ba8af790a9a4bccbaa6fbcec9fa96baba5fe71a5d7c0bae171589be9');
  assert.equal(HELPER_SHA256, V140_HELPER_SHA256);
  assert.equal(HELPER_SHA256, '83171e00d283c486455a1a4bf819205cb42d2b8f9c0c2711ced6f51bf0f228c4');
  const ns = mod; // module namespace: bindings are read-only and non-configurable
  for (const k of ['SOURCE_ROOT', 'BUNDLE_SHA256', 'INPUT_PACKAGE_SHA256', 'MAINTENANCE_OUTPUT_SHA256']) {
    assert.equal(Reflect.set(ns, k, 'x'), false);
    assert.throws(() => Object.defineProperty(ns, k, { get: () => 'x' }), TypeError);
    assert.notEqual(ns[k], 'x');
  }
  assert.ok(Object.isFrozen(EXPECTED) && Object.isFrozen(EXPECTED_PATHS));
  const prepared = { counts: { outputFiles: 43 }, inputPairs: [['appsscript.json', 'a'.repeat(64)]], outputPairs: [['appsscript.json', 'a'.repeat(64)]] };
  const receipt = JSON.parse(buildReceipt(prepared).toString('utf8'));
  for (const f of ['readyForPush', 'deployAuthorized', 'pushConfigIncluded', 'remoteAuthorized', 'liveFreezeAuthorized', 'runtimeFrozenVerified', 'goLiveAuthorized'])
    assert.equal(receipt[f], false, f);
  assert.equal(receipt.status, STATUS);
  assert.equal(receipt.status, 'LOCAL_WRAPPER_REMOVAL_PREPARED');
  const text = JSON.stringify(receipt);
  assert.ok(!/[A-Za-z]:[\\/]|sikap-private|function |tmpRevoke|tmpCheck/.test(text), 'no paths/source/wrapper names');
});

// Counts filesystem calls (fs/promises live bindings) and records touched paths.
function spyIo() {
  const calls = [], saved = {};
  for (const name of ['lstat', 'mkdir', 'open', 'readdir', 'realpath', 'stat', 'opendir']) {
    const orig = fsp[name]; saved[name] = orig;
    fsp.default[name] = (...args) => { calls.push([name, String(args[0])]); return orig(...args); };
  }
  syncBuiltinESMExports();
  return { calls, restore() { for (const [k, v] of Object.entries(saved)) fsp.default[k] = v; syncBuiltinESMExports(); } };
}
const touchesSource = (calls) => calls.some(([, p]) => path.resolve(p).toLowerCase().startsWith(SOURCE_ROOT.toLowerCase()));

test('buildWrapperRemoval accepts only {out} as own plain data property; getters never invoked; zero I/O on bad options', async () => {
  let getterCalls = 0;
  const spy = spyIo();
  try {
    for (const bad of [undefined, null, 'C:\\x', [], {}, { outDir: 'C:\\x' }, { out: 'C:\\x', source: 'C:\\y' }, { out: 'C:\\x', force: true },
      Object.assign(Object.create({ z: 1 }), { out: 'C:\\x' }), Object.create(null),
      Object.defineProperty({}, 'out', { get: () => { getterCalls++; return 'C:\\x'; }, enumerable: true }),
      new Proxy({ out: 'C:\\x' }, { ownKeys: () => { getterCalls++; return ['out']; } })]) {
      await assert.rejects(buildWrapperRemoval(bad), (e) => e?.code === 'OPTIONS_INVALID' || e?.code === 'OUT_ABSOLUTE_REQUIRED');
    }
    await assert.rejects(buildWrapperRemoval({ out: 1 }), code('OUT_ABSOLUTE_REQUIRED'));
  } finally { spy.restore(); }
  assert.equal(getterCalls, 0); // no getter/trap invoked
  assert.deepEqual(spy.calls, []);
});

test('output path: repo/cwd/source/v140 baseline/UNC/device/8.3/ADS/reserved rejected lexically before I/O', { skip: process.platform !== 'win32' }, async () => {
  const spy = spyIo();
  try {
    for (const [p, c] of [
      ['relative\\dir', 'OUT_ABSOLUTE_REQUIRED'], ['C:\\tmp\\x\\', 'OUT_ABSOLUTE_REQUIRED'], ['C:\\tmp\\..\\x', 'OUT_ABSOLUTE_REQUIRED'],
      ['C:/tmp/x', 'OUT_ABSOLUTE_REQUIRED'],
      ['\\\\server\\share\\x', 'OUT_PATH_INVALID'], ['\\\\?\\C:\\tmp\\x', 'OUT_PATH_INVALID'], ['\\\\.\\C:\\tmp\\x', 'OUT_PATH_INVALID'],
      ['C:\\PROGRA~1\\x', 'OUT_PATH_INVALID'], ['C:\\tmp\\con', 'OUT_PATH_INVALID'], ['C:\\tmp\\a:stream', 'OUT_PATH_INVALID'], ['C:\\', 'OUT_PATH_INVALID'],
      [path.join(ROOT, 'out'), 'OUT_PATH_INVALID'], [ROOT, 'OUT_PATH_INVALID'], [path.join(process.cwd(), 'k'), 'OUT_PATH_INVALID'],
      [SOURCE_ROOT, 'OUT_PATH_INVALID'], [path.join(SOURCE_ROOT, 'out'), 'OUT_PATH_INVALID'], [path.join(SOURCE_ROOT, 'files', 'x'), 'OUT_PATH_INVALID'],
      [path.dirname(SOURCE_ROOT), 'OUT_PATH_INVALID'], [SOURCE_ROOT.toUpperCase() + '\\X', 'OUT_PATH_INVALID'],
      ['C:\\Users\\elwin\\AppData\\Local\\Temp\\kilo\\sikap-gas-audit-J4AFda\\v140\\out', 'OUT_PATH_INVALID'],
    ]) await assert.rejects(outputPath(p), code(c), p);
  } finally { spy.restore(); }
  assert.deepEqual(spy.calls, []);
});

// Test-owned private fixture parent (Windows: inheritance removed, only current user SID + SYSTEM; POSIX 0700).
function privateFixtureDir(prefix) {
  const dir = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), prefix));
  if (process.platform === 'win32') {
    const sid = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true, timeout: 20000, shell: false }).stdout.trim();
    assert.match(sid, /^S-1-5-21-[0-9-]+$/);
    const r = spawnSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, shell: false });
    assert.equal(r.status, 0, 'fixture ACL setup');
  } else chmodSync(dir, 0o700);
  return dir;
}

test('pre-read failures never touch the private source: existing out, non-private parent, missing parent, linked parent', async () => {
  const parent = privateFixtureDir('sikap-v141-pre-');
  const shared = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'sikap-v141-open-'));
  const spy = spyIo();
  try {
    mkdirSync(path.join(parent, 'exists'));
    await assert.rejects(buildWrapperRemoval({ out: path.join(parent, 'exists') }), code('OUTPUT_EXISTS'));
    await assert.rejects(buildWrapperRemoval({ out: path.join(parent, 'missing', 'out') }), code('PARENT_MISSING'));
    if (process.platform === 'win32') {
      await assert.rejects(buildWrapperRemoval({ out: path.join(shared, 'out') }), code('PARENT_PERMISSIONS'));
      symlinkSync(parent, path.join(shared, 'jn'), 'junction');
      await assert.rejects(buildWrapperRemoval({ out: path.join(shared, 'jn', 'out') }), code('OUT_PATH_INVALID'));
    }
  } finally { spy.restore(); }
  assert.ok(!touchesSource(spy.calls), 'private source untouched');
  assert.ok(!spy.calls.some(([n]) => n === 'mkdir' || n === 'open'), 'nothing created/opened');
  assert.deepEqual(readdirSync(parent), ['exists']);
  rmSync(parent, { recursive: true, force: true });
  rmSync(shared, { recursive: true, force: true });
});

test('readRegularFileOnce rejects hardlinks, symlinks/junction aliases, oversize; reads regular files once', async () => {
  const dir = privateFixtureDir('sikap-v141-read-');
  try {
    const f = path.join(dir, 'a.txt');
    writeFileSync(f, 'abc');
    assert.ok((await readRegularFileOnce(f, 16)).equals(B('abc')));
    await assert.rejects(readRegularFileOnce(f, 2), code('SOURCE_ENTRY_INVALID'));
    linkSync(f, path.join(dir, 'hard.txt'));
    await assert.rejects(readRegularFileOnce(f, 16), code('SOURCE_ENTRY_INVALID')); // nlink 2
    await assert.rejects(readRegularFileOnce(path.join(dir, 'hard.txt'), 16), code('SOURCE_ENTRY_INVALID'));
    mkdirSync(path.join(dir, 'real'));
    writeFileSync(path.join(dir, 'real', 'b.txt'), 'b');
    if (process.platform === 'win32') {
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'jn'), 'junction');
      await assert.rejects(readRegularFileOnce(path.join(dir, 'jn', 'b.txt'), 16), code('SOURCE_ENTRY_INVALID'));
    }
    await assert.rejects(readRegularFileOnce(path.join(dir, 'real'), 16), code('SOURCE_ENTRY_INVALID'));
    await assert.rejects(readRegularFileOnce(path.join(dir, 'none'), 16), code('SOURCE_ENTRY_INVALID'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const wxOpens = () => {
  const order = [], orig = fsp.open;
  fsp.default.open = (file, flags, ...rest) => { if (flags === 'wx') order.push(path.basename(String(file))); return orig(file, flags, ...rest); };
  syncBuiltinESMExports();
  return { order, restore() { fsp.default.open = orig; syncBuiltinESMExports(); } };
};

test('writeOutputTree (synthetic engine): private dirs, wx each file, receipt last, no overwrite, partial left on failure', async () => {
  const parent = privateFixtureDir('sikap-v141-out-');
  try {
    const outputs = new Map([['appsscript.json', B('{}\n')], ['backend/A.gs', B('a\r\n')], ['frontend/I.html', B('<p>é</p>\n')]]);
    const receipt = B('{"r":1}\n');
    const target = path.join(parent, 'pkg');
    const spy = wxOpens();
    let digest;
    try { digest = await writeOutputTree(target, outputs, receipt); } finally { spy.restore(); }
    assert.equal(digest, sha256(receipt));
    assert.equal(spy.order.at(-1).endsWith(RECEIPT_FILE), true);
    assert.equal(spy.order.length, 4);
    assert.deepEqual(readdirSync(target).sort(), ['appsscript.json', 'backend', 'frontend', RECEIPT_FILE].sort());
    for (const [p, b] of outputs) assert.ok(readFileSync(path.join(target, ...p.split('/'))).equals(b), p);
    await assert.rejects(writeOutputTree(target, outputs, receipt), code('OUTPUT_EXISTS'));
    assert.ok(readFileSync(path.join(target, 'backend', 'A.gs')).equals(B('a\r\n')));

    // Planted file right after mkdir: wx refuses (EEXIST); partial output left, planted bytes untouched.
    const race = path.join(parent, 'race'), mk = fsp.mkdir;
    fsp.default.mkdir = async (p, ...rest) => { const r = await mk(p, ...rest); if (p === race) writeFileSync(path.join(race, 'appsscript.json'), 'planted'); return r; };
    syncBuiltinESMExports();
    try { await assert.rejects(writeOutputTree(race, outputs, receipt), (e) => e?.code === 'EEXIST'); }
    finally { fsp.default.mkdir = mk; syncBuiltinESMExports(); }
    assert.equal(readFileSync(path.join(race, 'appsscript.json'), 'utf8'), 'planted');
    assert.ok(!existsSync(path.join(race, RECEIPT_FILE)));

    // Receipt write failure: sources stay, no receipt, no cleanup.
    const fail = path.join(parent, 'fail'), orig = fsp.open;
    fsp.default.open = (file, flags, ...rest) => (flags === 'wx' && String(file).endsWith(RECEIPT_FILE)
      ? Promise.reject(Object.assign(new Error('x'), { code: 'EIO' })) : orig(file, flags, ...rest));
    syncBuiltinESMExports();
    try { await assert.rejects(writeOutputTree(fail, outputs, receipt)); }
    finally { fsp.default.open = orig; syncBuiltinESMExports(); }
    assert.deepEqual(readdirSync(fail).sort(), ['appsscript.json', 'backend', 'frontend']);

    for (const bad of [new Map([['../x', B('a')]]), new Map([[RECEIPT_FILE, B('a')]]), new Map([['a', 'str']])])
      await assert.rejects(writeOutputTree(path.join(parent, 'bad'), bad, receipt));
    assert.ok(!existsSync(path.join(parent, 'bad')));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('CLI: only --out <absolute>; invalid args/overrides and lexically excluded outputs do zero fs/spawn I/O', () => {
  for (const argv of [[], ['--out'], ['--out', 'C:\\x', '--force'], ['--out', '--force'], ['--source', 'C:\\x'], ['--hash', 'ab'],
    ['--source', 'C:\\x', '--out', 'C:\\y'], ['--out', '-x'], ['--force']]) assert.throws(() => parseArgs(argv), code('CLI_ARGUMENTS'), argv.join(' '));
  assert.throws(() => parseArgs(['--out', 'relative/dir']), code('OUT_ABSOLUTE_REQUIRED'));
  const preload = `data:text/javascript,${encodeURIComponent(`
    import * as f from 'node:fs/promises'; import * as c from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    let n = 0; const wrap = (o, k) => { const g = o.default[k]; if (typeof g === 'function') o.default[k] = (...a) => { n++; return g(...a); }; };
    for (const k of Object.keys(f.default)) wrap(f, k);
    for (const k of ['spawnSync','spawn','execFile','execFileSync','exec','execSync','fork']) wrap(c, k);
    syncBuiltinESMExports(); process.on('exit', () => process.stderr.write('IO=' + n));`)}`;
  const run = (args, env = {}) => spawnSync(process.execPath, ['--import', preload, SCRIPT, ...args],
    { encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: ROOT, env: { ...process.env, ...env } });
  for (const args of [['--version', '1'], ['--out', 'rel'], ['--out', 'C:\\x', '--force'], [], ['--source', SOURCE_ROOT, '--out', 'C:\\y']]) {
    const r = run(args, { SIKAP_V141_SOURCE: 'C:\\evil', SIKAP_FORCE: '1' });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(['{"ok":false,"code":"CLI_ARGUMENTS"}\n', '{"ok":false,"code":"OUT_ABSOLUTE_REQUIRED"}\n'].includes(r.stdout), r.stdout);
    assert.equal(r.stderr, 'IO=0');
  }
  for (const out of [path.join(ROOT, `sikap-cli-${process.pid}`), path.join(SOURCE_ROOT, 'out')]) {
    const r = run(['--out', out]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '{"ok":false,"code":"OUT_PATH_INVALID"}\n');
    assert.equal(r.stderr, 'IO=0');
    assert.ok(!existsSync(out));
  }
});
