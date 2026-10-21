// Synthetic-fixture tests for the v140 candidate builder. Never reads the private baseline,
// never calls buildCandidate/readBaselineManifest, no network/credentials/clasp.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_PACKAGE_SHA256, HELPER_FILE, HELPER_SHA256, HELPER_SOURCE, eolOf, guardText, handlerNames, isPublicName,
  normalizeLf, packageSha256, parseArgs, patchSource, rawPairs, unpatchSource, verifyCandidate, verifyHelper,
} from './prepare-gas-v140.mjs';

const code = (c) => (error) => error?.code === c;
const G = guardText('\n');
// 2 public (doGet, _formatDate: leading but no trailing `_`) + 1 private (helper_), multibyte before offsets.
const FIXTURE = [
  '// Ringkasan — dokumen 📄 pegawai',
  'var API_HANDLERS = { ping: function () { return 1; } };',
  'function doGet(e) { // keep me',
  '  return "ñ" + helper_(e);',
  '}',
  'function helper_(x) { return x; }',
  '/* 🧪 */ function _formatDate(d) {}',
  '',
].join('\n');
const EXPECTED = FIXTURE
  .replace('function doGet(e) {', `function doGet(e) {${G}`)
  .replace('function _formatDate(d) {', `function _formatDate(d) {${G}`);

test('patchSource inserts exactly one guard per public function, preserving every other byte', () => {
  const p = patchSource(FIXTURE, 'backend/A.js');
  assert.equal(p.text, EXPECTED);
  assert.deepEqual(p.publicNames, ['doGet', '_formatDate']);
  assert.deepEqual(p.privateNames, ['helper_']);
  assert.equal(p.text.split(G).length - 1, 2);
  assert.match(p.text, /function helper_\(x\) \{ return x; \}/);
  assert.match(p.text, new RegExp(`function doGet\\(e\\) \\{${G.replace(/[()]/g, '\\$&')} // keep me`));
  const u = unpatchSource(p.text, 'backend/A.js');
  assert.equal(u.text, FIXTURE);
  assert.deepEqual([u.publicCount, u.privateCount], [2, 1]);
  assert.equal(patchSource('// none\n', 'x.js').text, '// none\n');
  assert.ok(isPublicName('_formatDate') && isPublicName('doPost') && !isPublicName('a_') && !isPublicName('_b_'));
});

test('CRLF files keep raw bytes and CRLF guard line; mixed/lone-CR EOL fails closed', () => {
  const crlf = FIXTURE.replace(/\n/g, '\r\n');
  const p = patchSource(crlf, 'backend/A.js');
  assert.equal(p.text, EXPECTED.replace(/\n/g, '\r\n'));
  assert.ok(p.text.includes(guardText('\r\n')) && !/[^\r]\n/.test(p.text));
  assert.equal(unpatchSource(p.text, 'backend/A.js').text, crlf);
  assert.equal(eolOf(crlf), '\r\n');
  assert.throws(() => unpatchSource(p.text.replace(guardText('\r\n'), G), 'backend/A.js'), code('EOL_MIXED'));
  for (const bad of ['a\r\nb\n', 'a\rb\n']) assert.throws(() => patchSource(bad, 'x.js'), code('EOL_MIXED'));
  assert.notDeepEqual(rawPairs(new Map([['a', crlf]])), rawPairs(new Map([['a', FIXTURE]])));
});

test('patchSource fails closed on exposed values, collisions, duplicates and directives', () => {
  for (const [src, c] of [
    ['var f = function () {};', 'TOPLEVEL_FUNCTION_VALUE'],
    ['const f = (a) => a;', 'TOPLEVEL_FUNCTION_VALUE'],
    ['g = function () {};', 'TOPLEVEL_FUNCTION_VALUE'],
    ['class K {}', 'TOPLEVEL_FUNCTION_VALUE'],
    ['var K = class {};', 'TOPLEVEL_FUNCTION_VALUE'],
    ['function a() {}\nfunction a() {}', 'PUBLIC_DUPLICATE'],
    ['function a() { assertCutoverOpen_(); }', 'GUARD_COLLISION'],
    ['function assertCutoverOpen_() {}', 'GUARD_COLLISION'],
    ['function a() { "use strict"; }', 'FUNCTION_INVALID'],
    ['function a( {', 'PARSE_ERROR'],
  ]) assert.throws(() => patchSource(src, 'backend/X.js'), code(c), src);
  // Duplicate PRIVATE names are preserved (v140 style), not rejected.
  assert.equal(patchSource('function d_() {}\nfunction d_() {}\n', 'x.js').text, 'function d_() {}\nfunction d_() {}\n');
});

test('unpatchSource rejects any candidate that is not exactly baseline + expected guards', () => {
  const ok = patchSource(FIXTURE, 'a.js').text;
  for (const bad of [
    FIXTURE, // missing guards
    ok.replace(`_formatDate(d) {${G}`, '_formatDate(d) {\n assertCutoverOpen_();'), // altered guard bytes
    ok.replace('function helper_(x) {', `function helper_(x) {${G}`), // guard injected in private helper
    ok.replace(`doGet(e) {${G}`, 'doGet(e) {\n  if (0) {}\n  assertCutoverOpen_();'), // guard not first statement
    ok.replace(`doGet(e) {${G}`, 'doGet(e) {\n  assertCutoverOpen_(1);'),
  ]) assert.throws(() => unpatchSource(bad, 'a.js'), code(bad === ok.replace('function helper_(x) {', `function helper_(x) {${G}`) ? 'CANDIDATE_INVALID' : 'UNPATCH_MISMATCH'));
});

test('verifyCandidate requires exact byte reconstruction, unchanged non-JS files and the exact helper', () => {
  const helper = verifyHelper(readFileSync(HELPER_SOURCE)); // static repo file, no secrets
  const original = new Map([['backend/A.js', FIXTURE], ['backend/B.js', 'function b_() {}\nfunction doPost(e) { var x = 1; }\n'],
    ['frontend/Index.html', '<p>ok</p>\n'], ['appsscript.json', '{}\n']]);
  const build = () => new Map([...[...original].map(([k, v]) => [k, k.endsWith('.js') ? patchSource(v, k).text : v]), [HELPER_FILE, helper]]);
  const v = verifyCandidate(original, build(), helper);
  assert.deepEqual([v.publicFunctions, v.privateFunctions, v.functions], [3, 2, 5]);
  assert.deepEqual(v.coverage['backend/B.js'], { publicFunctions: ['doPost'], privateFunctions: 1 });
  const tamper = [
    (c) => c.set('backend/B.js', c.get('backend/B.js').replace('function b_() {}', 'function b_() { return 1; }')),
    (c) => c.set('backend/B.js', c.get('backend/B.js').replace('b_()', 'c_()')),
    (c) => c.set('backend/A.js', c.get('backend/A.js').replace('// keep me', '// changed')),
    (c) => c.set('frontend/Index.html', '<p>x</p>\n'),
    (c) => c.set(HELPER_FILE, `${helper}// x\n`),
    (c) => c.set('backend/Extra.js', 'function z() {}\n'),
    (c) => c.delete('appsscript.json'),
  ];
  for (const t of tamper) { const c = build(); t(c); assert.throws(() => verifyCandidate(original, c, helper)); }
  const dup = new Map(original).set('backend/C.js', 'function doPost() {}\n');
  const dupCandidate = new Map([...[...dup].map(([k, x]) => [k, k.endsWith('.js') ? patchSource(x, k).text : x]), [HELPER_FILE, helper]]);
  assert.throws(() => verifyCandidate(dup, dupCandidate, helper), code('PUBLIC_DUPLICATE'));
});

test('handlerNames reads only the single API_HANDLERS var nested in top-level doPost', () => {
  const api = (body, extra = '') => new Map([['backend/API.js', `function doPost(e) {\n  try {\n    ${body}\n    var h = API_HANDLERS[e.action];\n  } catch (x) {}\n}\n${extra}`],
    ['backend/Auth.js', 'function login(p) {}\nfunction getX(p) {}\n'], ['frontend/I.html', 'API_HANDLERS\n']]);
  assert.deepEqual(handlerNames(api("var API_HANDLERS = { login: login, 'getX': getX };")), ['login', 'getX']);
  for (const [body, extra] of [
    ['var API_HANDLERS = { login: login };', 'var API_HANDLERS = {};\n'], // also top-level
    ['var API_HANDLERS = { login: login };', 'function f_() { var API_HANDLERS = {}; }\n'], // shadow elsewhere
    ['var API_HANDLERS = { login: login }; API_HANDLERS = {};', ''], // reassignment
    ['', 'var API_HANDLERS = { login: login };\n'], // top-level only: no fallback
    ['', 'function doGet() { var API_HANDLERS = { login: login }; }\n'], // wrong function
    ['function inner() { var API_HANDLERS = { login: login }; }', ''], // nested function, not doPost body
    ['var API_HANDLERS = { a: function () {} };', ''],
    ['var API_HANDLERS = { a: login, b: login };', ''], // duplicate value
    ['var API_HANDLERS = { a: login, a: getX };', ''], // duplicate key
    ['var API_HANDLERS = { [k]: login };', ''],
    ['var API_HANDLERS = mk();', ''],
    ['', ''],
  ]) assert.throws(() => handlerNames(api(body, extra)), code('HANDLERS_INVALID'), body + extra);
});

test('helper is pinned private-only; package hash is LF-normalized and fixed', () => {
  const bytes = readFileSync(HELPER_SOURCE);
  assert.equal(verifyHelper(bytes), bytes.toString('utf8'));
  assert.throws(() => verifyHelper(Buffer.concat([bytes, Buffer.from('\n')])), code('HELPER_HASH_MISMATCH'));
  assert.equal(HELPER_SHA256, '83171e00d283c486455a1a4bf819205cb42d2b8f9c0c2711ced6f51bf0f228c4');
  assert.equal(BASELINE_PACKAGE_SHA256, 'c99c38cf22b92b3359e3b4f9e0d7c2bfc349895faad315e588060d4b17986bba');
  const lf = new Map([['b/x.js', 'a\nb\n'], ['a.html', 'é\n']]);
  const crlf = new Map([['a.html', 'é\r\n'], ['b/x.js', 'a\r\nb\r\n']]);
  assert.equal(packageSha256(crlf), packageSha256(lf));
  assert.equal(normalizeLf('a\r\nb\r'), 'a\nb\r');
  assert.notEqual(packageSha256(new Map([['a.html', 'é \n'], ['b/x.js', 'a\nb\n']])), packageSha256(lf));
});

test('CLI accepts only --out <absolute>; bad args exit before any private I/O', () => {
  for (const argv of [[], ['--out'], ['--baseline', 'C:/x'], ['--out', 'C:/x', '--force'], ['--out', '--force']]) {
    assert.throws(() => parseArgs(argv), code('CLI_ARGUMENTS'));
  }
  assert.throws(() => parseArgs(['--out', 'relative/dir']), code('OUT_ABSOLUTE_REQUIRED'));
  const script = fileURLToPath(new URL('./prepare-gas-v140.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, '--version', '1'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(r.status, 2);
  assert.deepEqual(JSON.parse(r.stdout), { ok: false, code: 'CLI_ARGUMENTS' });
});
