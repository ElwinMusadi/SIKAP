// Synthetic-fixture tests for the cutover sandbox kit generator. Never reads the private v140 baseline or any
// candidate; no network/credentials/clasp/Google. Only static repo files (pinned helper + harness template) are
// read. The single end-to-end write test uses a fresh OS temp dir that this test (not the generator) removes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as cp from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {
  CASES, ENTRY_NAME, HARNESS_FILE, HELPER_FILE, HELPER_FUNCTION_SHA256, HELPER_RAW_SHA256, HELPER_SOURCE, MANIFEST_KEYS, OUTPUT_FILES,
  PLACEHOLDER, READY_CODE, RECEIPT_FILE, RENDERED_CODE, TEMPLATE_SHA256, TEMPLATE_SOURCE, buildManifest, buildReceipt, buildSandbox,
  helperFunctionSha256, outputPath, parseArgs, renderSandbox, validateTemplate, verifyHelper, verifyManifest,
} from './prepare-gas-cutover-sandbox.mjs';
import { HELPER_SHA256 as V140_HELPER_SHA256 } from './prepare-gas-v140.mjs';
import { ROOT, sha256 } from './local-store.mjs';

const code = (c) => (error) => error?.code === c;
const HELPER = readFileSync(HELPER_SOURCE); // static repo file, no secrets
const NONCE = '0123456789abcdef0123456789abcdef';
const SCRIPT = fileURLToPath(new URL('./prepare-gas-cutover-sandbox.mjs', import.meta.url));
const FIXTURE = [
  '// Synthetic fixture: mentions SpreadsheetApp only inside a comment.',
  `var CUTOVER_SANDBOX_MANIFEST_ = ${PLACEHOLDER};`,
  `function ${ENTRY_NAME}() {`,
  '  var props = PropertiesService.getScriptProperties();',
  "  var live = typeof doGet !== 'undefined' || typeof API_HANDLERS !== 'undefined';",
  '  var own = Object.prototype.hasOwnProperty.call(CUTOVER_SANDBOX_MANIFEST_, \'nonce\');',
  '  var id = ScriptApp.getScriptId();',
  '  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(assertCutoverOpen_), Utilities.Charset.UTF_8);',
  '  var r = { n: 0 };',
  '  for (var i = 0; i < 3; i++) { r.n += standIn_(i); }',
  '  if (typeof assertCutoverOpen_ !== \'function\') throw new Error(\'SANDBOX_HELPER_MISMATCH\');',
  '  Logger.log(JSON.stringify({ ok: !live && own, n: r.n, d: d.length, id: id.length, p: props === null }));',
  '  return r;',
  '}',
  'function standIn_(i) {',
  '  assertCutoverOpen_();',
  '  var count = 0;',
  '  count++;',
  '  return count + i;',
  '}',
  '',
].join('\n');
const render = (templateText = FIXTURE, extra = {}) => renderSandbox({ helperBytes: HELPER, templateText, nonce: NONCE, ...extra });

// Counts filesystem/spawn calls made by the generator (live ESM builtin bindings).
function spyIo() {
  const calls = [], saved = {};
  for (const name of ['lstat', 'mkdir', 'open', 'readdir', 'realpath']) {
    saved[name] = fsp[name];
    const orig = fsp[name];
    fsp.default[name] = (...args) => { calls.push(name); return orig(...args); };
  }
  saved.spawnSync = cp.spawnSync;
  const origSpawn = cp.spawnSync;
  cp.default.spawnSync = (...args) => { calls.push('spawnSync'); return origSpawn(...args); };
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      for (const name of ['lstat', 'mkdir', 'open', 'readdir', 'realpath']) fsp.default[name] = saved[name];
      cp.default.spawnSync = saved.spawnSync;
      syncBuiltinESMExports();
    },
  };
}

test('template pin is the frozen harness hash (board_f5ddbaa8)', () => {
  assert.equal(TEMPLATE_SHA256, 'a24ef1bc1931626218afca3e17c90e8719182c7a55f750453744615f8b5193b3');
  assert.equal(sha256(readFileSync(TEMPLATE_SOURCE)), TEMPLATE_SHA256);
});

test('helper pins: raw bytes equal v140 builder pin; function text hash equals V8 Function#toString; no override', () => {
  assert.equal(HELPER_RAW_SHA256, V140_HELPER_SHA256);
  assert.equal(HELPER_FUNCTION_SHA256, '2fc47ee707278d1ae4580398ba0ef6afea28f210221a4dc79216d71ba07e6dd5');
  const text = verifyHelper(HELPER);
  assert.equal(text, HELPER.toString('utf8'));
  assert.equal(helperFunctionSha256(text), HELPER_FUNCTION_SHA256);
  const ctx = vm.createContext({});
  vm.runInContext(text, ctx); // defines the function only; never called
  const fnText = vm.runInContext(`String(${'assertCutoverOpen_'})`, ctx);
  const decl = ts.createSourceFile('h.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).statements[0];
  assert.equal(fnText, decl.getText());
  for (const [bad, c] of [
    [Buffer.concat([HELPER, Buffer.from('\n')]), 'HELPER_HASH_MISMATCH'],
    [Buffer.from(HELPER.toString('utf8').replace(/\n/g, '\r\n')), 'HELPER_HASH_MISMATCH'],
    [Buffer.from(HELPER.toString('utf8').replace("'open'", "'opem'")), 'HELPER_HASH_MISMATCH'],
    ['not bytes', 'HELPER_HASH_MISMATCH'],
  ]) assert.throws(() => verifyHelper(bad), code(c));
  assert.throws(() => helperFunctionSha256(text.replace(/\n/g, '\r\n')), code('HELPER_INVALID'));
  // A tampered helper passed to the pure renderer is rejected by the same pin (no override path).
  assert.throws(() => render(FIXTURE, { helperBytes: Buffer.concat([HELPER, Buffer.from(' ')]) }), code('HELPER_HASH_MISMATCH'));
});

test('pure render: placeholder replaced once with the exact manifest; helper raw; status is RENDERED only', () => {
  const r = render();
  assert.equal(r.code, RENDERED_CODE);
  assert.notEqual(r.code, READY_CODE);
  assert.equal(r.helperText, HELPER.toString('utf8'));
  assert.equal(r.harnessText, FIXTURE.replace(PLACEHOLDER, JSON.stringify(r.manifest)));
  assert.ok(!r.harnessText.includes('@@') && !r.harnessText.includes('\r'));
  const sf = ts.createSourceFile('h.js', r.harnessText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const init = sf.statements[0].declarationList.declarations[0].initializer;
  const manifest = JSON.parse(init.getText(sf));
  assert.deepEqual(Object.keys(manifest), [...MANIFEST_KEYS]);
  assert.deepEqual(manifest, { kind: 'sikap-cutover-sandbox', version: 1, nonce: NONCE, helperFunctionSha256: HELPER_FUNCTION_SHA256,
    directCases: 43, handlerCases: 40, realV140FeatureValidation: false });
  assert.deepEqual(CASES, { directCases: 43, handlerCases: 40 });
  assert.equal(verifyManifest(manifest), manifest);
  assert.deepEqual(r.counts, { directCases: 43, handlerCases: 40, templateFunctions: 2, templatePublicFunctions: 0 });
  assert.equal(r.hashes.helperRawSha256, HELPER_RAW_SHA256);
  // Manifest tamper: extra/missing/reordered/wrong values all fail.
  for (const bad of [
    { ...manifest, extra: 1 }, { ...manifest, directCases: 42 }, { ...manifest, handlerCases: 41 },
    { ...manifest, realV140FeatureValidation: true }, { ...manifest, nonce: NONCE.toUpperCase() },
    { ...manifest, helperFunctionSha256: '0'.repeat(64) }, { ...manifest, version: 2 }, { ...manifest, kind: 'x' },
    Object.fromEntries(Object.entries(manifest).reverse()), [], null,
  ]) assert.throws(() => verifyManifest(bad), code('MANIFEST_INVALID'));
  for (const n of ['', 'g'.repeat(32), NONCE.slice(1), NONCE.toUpperCase(), `${NONCE}0`, 1]) assert.throws(() => buildManifest(n), code('NONCE_INVALID'));
});

test('pure render accepts only plain {helperBytes, templateText, nonce} data properties', () => {
  const base = { helperBytes: HELPER, templateText: FIXTURE, nonce: NONCE };
  for (const bad of [
    undefined, null, [], 'x', { ...base, extra: 1 }, { helperBytes: HELPER, templateText: FIXTURE },
    { ...base, helperSha256: HELPER_RAW_SHA256 }, { ...base, status: READY_CODE }, Object.assign(Object.create({ x: 1 }), base),
    Object.defineProperty({ helperBytes: HELPER, templateText: FIXTURE }, 'nonce', { get: () => NONCE, enumerable: true }),
  ]) assert.throws(() => renderSandbox(bad), code('OPTIONS_INVALID'));
});

test('template policy rejects public/live/forbidden/aliasing/ID-like constructs', () => {
  const body = (line) => FIXTURE.replace('  return r;\n', `  ${line}\n  return r;\n`);
  const cases = [
    [FIXTURE.replace(PLACEHOLDER, 'null'), 'TEMPLATE_PLACEHOLDER'],
    [`${FIXTURE}// ${PLACEHOLDER}\n`, 'TEMPLATE_PLACEHOLDER'],
    [`${FIXTURE}// @@\n`, 'TEMPLATE_PLACEHOLDER'],
    [FIXTURE.replace(`var CUTOVER_SANDBOX_MANIFEST_ = ${PLACEHOLDER};`, `var X_ = ${PLACEHOLDER};`), 'TEMPLATE_PLACEHOLDER'],
    [FIXTURE.replace(`= ${PLACEHOLDER};`, `= [${PLACEHOLDER}];`), 'TEMPLATE_PLACEHOLDER'],
    [FIXTURE.replace(`= ${PLACEHOLDER};`, `= '${PLACEHOLDER}';`), 'TEMPLATE_PLACEHOLDER'],
    [FIXTURE.replace(/\n/g, '\r\n'), 'TEMPLATE_ENCODING'],
    [`\uFEFF${FIXTURE}`, 'TEMPLATE_ENCODING'],
    [`${FIXTURE}function publicThing() {}\n`, 'TEMPLATE_TOPLEVEL'],
    [`${FIXTURE}function doGet_() {}\nfunction doGet() {}\n`, 'TEMPLATE_TOPLEVEL'],
    [`${FIXTURE}runCutoverSandboxRehearsal_();\n`, 'TEMPLATE_TOPLEVEL'],
    [`${FIXTURE}var other_ = 1;\n`, 'TEMPLATE_TOPLEVEL'],
    [`${FIXTURE}let l_ = 1;\n`, 'TEMPLATE_TOPLEVEL'],
    [FIXTURE.replace(`function ${ENTRY_NAME}()`, 'function renamed_()'), 'TEMPLATE_TOPLEVEL'],
    [`${FIXTURE}function assertCutoverOpen_() {}\n`, 'TEMPLATE_SHADOWING'],
    [`${FIXTURE}function standIn_() {}\n`, 'TEMPLATE_SHADOWING'],
    [body('var JSON = 1;'), 'TEMPLATE_SHADOWING'],
    [body('var doPost = 1;'), 'TEMPLATE_SHADOWING'],
    [body('var x = SpreadsheetApp;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = DriveApp.getFileById(r);'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('UrlFetchApp.fetch(r);'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('LockService.getScriptLock();'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('props.deleteAllProperties();'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('props.setProperties(r, true);'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('PropertiesService.getUserProperties();'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('ScriptApp.newTrigger(r);'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('ScriptApp.getProjectTriggers();'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('ScriptApp.getOAuthToken();'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var t = props.getProjectTriggers;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = eval(r);'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = globalThis;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = r.constructor;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = Function;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = google.script;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = arguments;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = r.prototype;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = \\u0065val;'), 'TEMPLATE_FORBIDDEN_IDENTIFIER'],
    [body('var x = ScriptApp;'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var x = ScriptApp.getService();'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body("var x = ScriptApp['getScriptId'];"), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var x = Utilities.newBlob(r);'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var x = PropertiesService;'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('doGet(r);'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var x = API_HANDLERS.a;'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var f = assertCutoverOpen_;'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var x = unknownGlobal;'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('var o = Object;'), 'TEMPLATE_GLOBAL_FORBIDDEN'],
    [body('assertCutoverOpen_ = 1;'), 'TEMPLATE_GLOBAL_MUTATION'],
    [body('CUTOVER_SANDBOX_MANIFEST_ = {};'), 'TEMPLATE_GLOBAL_MUTATION'],
    [body('CUTOVER_SANDBOX_MANIFEST_.nonce = 1;'), 'TEMPLATE_GLOBAL_MUTATION'],
    [body('JSON.parse = 1;'), 'TEMPLATE_GLOBAL_MUTATION'],
    [body('delete JSON.parse;'), 'TEMPLATE_GLOBAL_MUTATION'],
    [body('Object.defineProperty(JSON, r, {});'), 'TEMPLATE_GLOBAL_MUTATION'],
    [body('Object.assign(CUTOVER_SANDBOX_MANIFEST_, r);'), 'TEMPLATE_GLOBAL_MUTATION'],
    [body('var x = r[String(i)];'), 'TEMPLATE_FORBIDDEN_SYNTAX'],
    [body('var x = this;'), 'TEMPLATE_FORBIDDEN_SYNTAX'],
    [body('var x = `a`;'), 'TEMPLATE_FORBIDDEN_SYNTAX'],
    [body('var f = function* () {};'), 'TEMPLATE_FORBIDDEN_SYNTAX'],
    [body("var x = 'call SpreadsheetApp';"), 'TEMPLATE_FORBIDDEN_TEXT'],
    [body("var x = 'doPost';"), 'TEMPLATE_FORBIDDEN_TEXT'],
    [body("var x = 'https://example.invalid';"), 'TEMPLATE_FORBIDDEN_TEXT'],
    [`${FIXTURE}// owner person@example.org\n`, 'TEMPLATE_FORBIDDEN_TEXT'],
    [`${FIXTURE}// 1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n`, 'TEMPLATE_FORBIDDEN_TEXT'],
    [`${FIXTURE}// 199001012020121001\n`, 'TEMPLATE_FORBIDDEN_TEXT'],
    [`${FIXTURE}// docs.google.com\n`, 'TEMPLATE_FORBIDDEN_TEXT'],
    [`${FIXTURE}function bad_( {\n`, 'TEMPLATE_PARSE_ERROR'],
  ];
  for (const [src, c] of cases) {
    let got;
    try { validateTemplate(src); } catch (error) { got = error.code; }
    assert.equal(got, c, src.split('\n').find((l, i) => l !== FIXTURE.split('\n')[i]) ?? src.slice(-60));
  }
  assert.deepEqual(Object.keys(validateTemplate(FIXTURE)), ['templateSha256', 'templateFunctions', 'templatePublicFunctions']);
  assert.throws(() => validateTemplate('x'.repeat(256 * 1024 + 1)), code('TEMPLATE_INVALID'));
});

test('repo harness template matches the pin, passes the policy and renders without live IDs/URLs', () => {
  const text = readFileSync(TEMPLATE_SOURCE, 'utf8');
  const r = render(text);
  assert.equal(r.counts.templatePublicFunctions, 0);
  assert.equal(r.hashes.templateSha256, TEMPLATE_SHA256);
  assert.ok(!/https?:\/\/|@[a-z0-9-]+\.[a-z]/i.test(r.harnessText));
  assert.equal(r.harnessText.split(JSON.stringify(r.manifest)).length, 2);
});

test('receipt: safe hashes/counts/nonce only, every authority flag false, no paths/IDs/source', () => {
  const r = render();
  const bytes = buildReceipt(r), text = bytes.toString('utf8'), receipt = JSON.parse(text);
  for (const k of ['readyForPush', 'readyForDeploy', 'runtimeFrozenVerified', 'deploymentAuthorized', 'deployAuthorized',
    'remoteAuthorized', 'liveFreezeAuthorized', 'goLiveAuthorized', 'realV140FeatureValidation', 'pushConfigIncluded']) assert.equal(receipt[k], false, k);
  assert.equal(receipt.syntheticOnly, true);
  assert.equal(receipt.nonce, NONCE);
  assert.deepEqual(receipt.files, [[HELPER_FILE, HELPER_RAW_SHA256], [HARNESS_FILE, r.hashes.harnessSha256]]);
  assert.deepEqual(receipt.counts, { outputFiles: 3, directCases: 43, handlerCases: 40, templateFunctions: 2, templatePublicFunctions: 0 });
  assert.ok(!/[A-Za-z]:[\\/]|[\\/]Users[\\/]|function |PropertiesService|scriptId|https?:/i.test(text), 'no paths/source/IDs');
  assert.ok(!text.includes(ROOT) && !text.includes(os.homedir()));
  assert.throws(() => buildReceipt({ ...r, code: READY_CODE }), code('RECEIPT_INVALID'));
  assert.deepEqual([...OUTPUT_FILES], ['Cutover.gs', 'CutoverSandboxHarness.gs', 'cutover-sandbox.receipt.json']);
  assert.ok(!OUTPUT_FILES.some((f) => /appsscript|clasp|package/i.test(f)));
});

test('buildSandbox accepts only {outDir} as a plain data property; bad options do zero I/O', async () => {
  const spy = spyIo();
  try {
    for (const bad of [undefined, null, 'C:/x', [], { out: 'C:/x' }, { outDir: 'C:/x', helperBytes: HELPER },
      { outDir: 'C:/x', templateText: FIXTURE }, { outDir: 'C:/x', nonce: NONCE }, Object.assign(Object.create({ z: 1 }), { outDir: 'C:/x' }),
      Object.defineProperty({}, 'outDir', { get: () => 'C:/x', enumerable: true })]) {
      await assert.rejects(buildSandbox(bad), code('OPTIONS_INVALID'));
    }
    await assert.rejects(buildSandbox({ outDir: 1 }), code('OUT_ABSOLUTE_REQUIRED'));
  } finally { spy.restore(); }
  assert.deepEqual(spy.calls, []);
});

test('output path policy: UNC/device/8.3/reserved/repo/cwd/baseline aliases rejected before I/O', { skip: process.platform !== 'win32' }, async () => {
  const spy = spyIo();
  try {
    for (const [p, c] of [
      ['relative\\dir', 'OUT_ABSOLUTE_REQUIRED'], ['C:\\tmp\\x\\', 'OUT_ABSOLUTE_REQUIRED'], ['C:\\tmp\\..\\x', 'OUT_ABSOLUTE_REQUIRED'],
      ['C:/tmp/x', 'OUT_ABSOLUTE_REQUIRED'],
      ['\\\\server\\share\\x', 'OUT_PATH_INVALID'], ['\\\\?\\C:\\tmp\\x', 'OUT_PATH_INVALID'], ['\\\\.\\C:\\tmp\\x', 'OUT_PATH_INVALID'],
      ['C:\\PROGRA~1\\x', 'OUT_PATH_INVALID'], ['C:\\tmp\\~x', 'OUT_PATH_INVALID'], ['C:\\tmp\\con', 'OUT_PATH_INVALID'],
      ['C:\\tmp\\NUL.txt', 'OUT_PATH_INVALID'], ['C:\\tmp\\x.', 'OUT_PATH_INVALID'], ['C:\\tmp\\x ', 'OUT_PATH_INVALID'],
      ['C:\\tmp\\a:stream', 'OUT_PATH_INVALID'], ['C:\\', 'OUT_PATH_INVALID'],
      [path.join(ROOT, 'out'), 'OUT_PATH_INVALID'], [ROOT, 'OUT_PATH_INVALID'], [path.dirname(ROOT), 'OUT_PATH_INVALID'],
      [ROOT.toUpperCase(), 'OUT_PATH_INVALID'], [path.join(process.cwd(), 'k'), 'OUT_PATH_INVALID'],
      ['C:\\Users\\elwin\\AppData\\Local\\Temp\\kilo\\sikap-gas-audit-J4AFda\\v140\\out', 'OUT_PATH_INVALID'],
      ['C:\\Users\\elwin\\AppData\\Local\\Temp\\kilo\\sikap-gas-audit-J4AFda', 'OUT_PATH_INVALID'],
      ['c:\\users\\ELWIN\\appdata\\local\\temp\\kilo', 'OUT_PATH_INVALID'],
    ]) await assert.rejects(outputPath(p), code(c), p);
  } finally { spy.restore(); }
  assert.deepEqual(spy.calls, []); // all rejected lexically
  const missing = path.join(realpathSync.native(os.tmpdir()), `sikap-missing-${process.pid}-${Date.now()}`, 'kit');
  await assert.rejects(outputPath(missing), code('PARENT_MISSING'));
});

test('CLI: only --out <absolute>; invalid args exit 2 with code-only stdout and zero fs/spawn access', () => {
  for (const argv of [[], ['--out'], ['--out', 'C:\\x', '--force'], ['--out', '--force'], ['--nonce', NONCE], ['--candidate', 'C:\\x'],
    ['--template', 'C:\\x', '--out', 'C:\\y'], ['--out', '-x']]) assert.throws(() => parseArgs(argv), code('CLI_ARGUMENTS'), argv.join(' '));
  assert.throws(() => parseArgs(['--out', 'relative/dir']), code('OUT_ABSOLUTE_REQUIRED'));
  assert.deepEqual(parseArgs(['--out', path.resolve('/abs/kit')]), { outDir: path.resolve('/abs/kit') });
  // Preload counts every fs/promises + child_process call (the generator uses only these; Node's own module
  // loader uses sync fs, so sync APIs are not counted). Prints the count to stderr.
  const preload = `data:text/javascript,${encodeURIComponent(`
    import * as f from 'node:fs/promises'; import * as c from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    let n = 0; const wrap = (o, k) => { const g = o.default[k]; if (typeof g === 'function') o.default[k] = (...a) => { n++; return g(...a); }; };
    for (const k of Object.keys(f.default)) wrap(f, k);
    for (const k of ['spawnSync','spawn','execFile','execFileSync','exec','execSync','fork']) wrap(c, k);
    syncBuiltinESMExports(); process.on('exit', () => process.stderr.write('IO=' + n));`)}`;
  for (const args of [['--version', '1'], ['--out', 'rel'], ['--out', 'C:\\x', '--force'], []]) {
    const r = spawnSync(process.execPath, ['--import', preload, SCRIPT, ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: ROOT });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(['{"ok":false,"code":"CLI_ARGUMENTS"}\n', '{"ok":false,"code":"OUT_ABSOLUTE_REQUIRED"}\n'].includes(r.stdout), r.stdout);
    assert.equal(r.stderr, 'IO=0');
  }
  // Valid shape but inside the repo: exit 1, code only, nothing created.
  const inside = path.join(ROOT, `sikap-cli-${process.pid}`);
  const r = spawnSync(process.execPath, ['--import', preload, SCRIPT, '--out', inside], { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: ROOT });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '{"ok":false,"code":"OUT_PATH_INVALID"}\n');
  assert.equal(r.stderr, 'IO=0');
  assert.ok(!existsSync(inside));
});

// Test-owned fixture parent under the OS temp dir. The TEST (never the generator) makes it private:
// Windows: icacls removes inherited ACEs and grants only the current user SID + SYSTEM (no shell); POSIX: 0700.
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
const wxOpens = () => {
  const order = [], orig = fsp.open;
  fsp.default.open = (file, flags, ...rest) => { if (flags === 'wx') order.push(path.basename(String(file))); return orig(file, flags, ...rest); };
  syncBuiltinESMExports();
  return { order, restore() { fsp.default.open = orig; syncBuiltinESMExports(); } };
};

test('end-to-end private write: ACL-checked parent, exactly 3 files, wx/no overwrite, receipt last, partial output left', async () => {
  assert.ok(typeof TEMPLATE_SHA256 === 'string' && /^[0-9a-f]{64}$/.test(TEMPLATE_SHA256), 'template pin required');
  const parent = privateFixtureDir('sikap-sbx-test-');
  const shared = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'sikap-sbx-open-')); // inherited (non-private) ACL/mode
  try {
    if (process.platform === 'win32') {
      // Non-private parent: rejected by the real ACL check before mkdir; nothing created.
      await assert.rejects(buildSandbox({ outDir: path.join(shared, 'kit') }), code('PARENT_PERMISSIONS'));
      assert.deepEqual(readdirSync(shared), []);
    }
    await assert.rejects(buildSandbox({ outDir: path.join(parent, 'missing', 'kit') }), code('PARENT_MISSING'));

    const outDir = path.join(parent, 'kit');
    const spy = wxOpens();
    let res;
    try { res = await buildSandbox({ outDir }); } finally { spy.restore(); }
    assert.deepEqual(spy.order, [HELPER_FILE, HARNESS_FILE, RECEIPT_FILE]); // receipt last, each exclusive-create
    assert.equal(res.code, READY_CODE);
    assert.deepEqual(readdirSync(outDir).sort(), [...OUTPUT_FILES].sort());
    assert.ok(readFileSync(path.join(outDir, HELPER_FILE)).equals(HELPER));
    const receiptBytes = readFileSync(path.join(outDir, RECEIPT_FILE)), receipt = JSON.parse(receiptBytes);
    const harness = readFileSync(path.join(outDir, HARNESS_FILE), 'utf8');
    assert.ok(/^[0-9a-f]{32}$/.test(receipt.nonce) && harness.includes(`"nonce":"${receipt.nonce}"`));
    assert.equal(harness, readFileSync(TEMPLATE_SOURCE, 'utf8').replace(PLACEHOLDER, JSON.stringify(buildManifest(receipt.nonce))));
    assert.deepEqual([receipt.templateSha256, res.templateSha256, res.harnessSha256, res.receiptSha256],
      [TEMPLATE_SHA256, TEMPLATE_SHA256, sha256(Buffer.from(harness)), sha256(receiptBytes)]);
    assert.equal(res.helperRawSha256, HELPER_RAW_SHA256);
    const out = JSON.stringify(res);
    assert.ok(!out.includes(receipt.nonce) && !out.includes(parent) && !receiptBytes.toString().includes(parent), 'no nonce/path in result');
    if (process.platform !== 'win32') assert.equal(statSync(outDir).mode & 0o777, 0o700);

    // Existing output: refused, nothing overwritten.
    const before = readdirSync(outDir).map((f) => [f, sha256(readFileSync(path.join(outDir, f)))]);
    await assert.rejects(buildSandbox({ outDir }), code('OUTPUT_EXISTS'));
    assert.deepEqual(readdirSync(outDir).map((f) => [f, sha256(readFileSync(path.join(outDir, f)))]), before);

    // Racing file planted right after mkdir: wx refuses to overwrite it; run stops; planted bytes untouched.
    const outRace = path.join(parent, 'kit-race'), mk = fsp.mkdir;
    fsp.default.mkdir = async (p, ...rest) => { const r = await mk(p, ...rest); if (p === outRace) writeFileSync(path.join(outRace, HARNESS_FILE), 'planted'); return r; };
    syncBuiltinESMExports();
    try { await assert.rejects(buildSandbox({ outDir: outRace }), (e) => e?.code === 'EEXIST'); }
    finally { fsp.default.mkdir = mk; syncBuiltinESMExports(); }
    assert.deepEqual(readdirSync(outRace).sort(), [HELPER_FILE, HARNESS_FILE]);
    assert.equal(readFileSync(path.join(outRace, HARNESS_FILE), 'utf8'), 'planted');

    // Receipt write failure: helper + harness stay, no receipt, no cleanup/deletes.
    const outFail = path.join(parent, 'kit-fail'), orig = fsp.open;
    fsp.default.open = (file, flags, ...rest) => (flags === 'wx' && String(file).endsWith(RECEIPT_FILE)
      ? Promise.reject(Object.assign(new Error('x'), { code: 'EIO' })) : orig(file, flags, ...rest));
    syncBuiltinESMExports();
    try { await assert.rejects(buildSandbox({ outDir: outFail })); }
    finally { fsp.default.open = orig; syncBuiltinESMExports(); }
    assert.deepEqual(readdirSync(outFail).sort(), [HELPER_FILE, HARNESS_FILE]);

    // CLI success: stdout is code/hashes/counts only (no nonce, no paths).
    const outCli = path.join(parent, 'kit-cli');
    const r = spawnSync(process.execPath, [SCRIPT, '--out', outCli], { encoding: 'utf8', timeout: 60000, windowsHide: true, cwd: ROOT });
    assert.equal(r.status, 0, r.stdout);
    const printed = JSON.parse(r.stdout), cliReceipt = JSON.parse(readFileSync(path.join(outCli, RECEIPT_FILE), 'utf8'));
    assert.deepEqual(Object.keys(printed).sort(), ['code', 'counts', 'harnessSha256', 'helperFunctionSha256', 'helperRawSha256', 'ok', 'receiptSha256', 'templateSha256']);
    assert.equal(printed.code, READY_CODE);
    assert.ok(!r.stdout.includes(cliReceipt.nonce) && !r.stdout.includes(parent) && !/[A-Za-z]:\\\\|\/tmp\//.test(r.stdout));
    assert.deepEqual(readdirSync(outCli).sort(), [...OUTPUT_FILES].sort());
  } finally { // test-owned fixtures only
    rmSync(parent, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});
