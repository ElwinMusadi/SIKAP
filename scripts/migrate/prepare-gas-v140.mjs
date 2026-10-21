// Local-only builder for a guarded Apps Script v140 cutover candidate.
// Node built-ins + existing `typescript` dev dependency (AST parsing only). It never runs clasp,
// never evaluates baseline code, performs no network/remote I/O and never reads credentials.
// The fixed private baseline is read ONLY by buildCandidate() (CLI); importing this module does no I/O.
// Output is a NEW private directory outside the repo: the 41 baseline sources with raw bytes/EOL kept,
// one guard line in each of the 43 public top-level functions, backend/Cutover.js helper, and a receipt
// written last. No .clasp.json/.claspignore/.clasprc, package or workflow file is ever written, so no push
// target is configured automatically. Partial output after mkdir is left in place (no cleanup/deletes).
// The only spawn is the existing read-only ACL check (verifyPrivatePersistence) on Windows.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {
  MigrationError, ROOT, canonicalPath, check, isMain, noLinks, persistencePath, readBoundedHandle, safeCode, sha256,
  verifyPrivatePersistence,
} from './local-store.mjs';

export const VERSION = 140;
export const BASELINE_PATH = 'C:/Users/elwin/AppData/Local/Temp/kilo/sikap-gas-audit-J4AFda/v140';
export const BASELINE_PACKAGE_SHA256 = 'c99c38cf22b92b3359e3b4f9e0d7c2bfc349895faad315e588060d4b17986bba';
export const HELPER_SHA256 = '83171e00d283c486455a1a4bf819205cb42d2b8f9c0c2711ced6f51bf0f228c4';
export const HELPER_SOURCE = path.join(ROOT, 'legacy-gas', 'src', 'backend', 'Cutover.gs');
export const HELPER_FILE = 'backend/Cutover.js';
export const RECEIPT_FILE = 'cutover-candidate.receipt.json';
export const GUARD_NAME = 'assertCutoverOpen_';
export const EXPECTED = Object.freeze({ files: 41, js: 11, html: 29, json: 1, functions: 113, publicFunctions: 43, privateFunctions: 70 });
export const LIMITS = Object.freeze({ files: 100, fileBytes: 2 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 });
const CLASP_INPUT = '.clasp.json'; // tolerated in the clone root, never opened, never copied
const safeName = (name) => /^[^\\/:*?"<>|]+$/.test(name) && ![...name].some((c) => c.charCodeAt(0) < 0x20);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Apps Script hides names ending in `_` from google.script.run; everything else is public.
export const isPublicName = (name) => !name.endsWith('_');
export const normalizeLf = (text) => text.replace(/\r\n/g, '\n');
const utf8 = (text) => Buffer.from(text, 'utf8');
const byPath = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
// Audit package method: [relPath, sha256(LF UTF-8)] pairs sorted by path, sha256(JSON.stringify(pairs)).
export const filePairs = (files) => [...files].map(([p, text]) => [p, sha256(utf8(normalizeLf(text)))]).sort(byPath);
export const packageSha256 = (files) => sha256(utf8(JSON.stringify(filePairs(files))));
// Raw (non-normalized) per-file digests: proves byte identity, which the LF package pin cannot.
export const rawPairs = (files) => [...files].map(([p, text]) => [p, sha256(utf8(text))]).sort(byPath);

function decode(bytes, code) {
  let text;
  try { text = decoder.decode(bytes); } catch { throw new MigrationError(code); }
  check(utf8(text).equals(Buffer.from(bytes)), code);
  return text;
}
function parse(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  check(sf.parseDiagnostics.length === 0, 'PARSE_ERROR');
  return sf;
}
const unwrap = (n) => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n; };
const isAssign = (n) => !!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
function functionValue(node) {
  let n = unwrap(node);
  while (isAssign(n)) n = unwrap(n.right);
  return !!n && (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isClassExpression(n));
}
// Global binding target: bare identifier or this./globalThis. property (not e.g. API_HANDLERS.x).
const globalTarget = (n) => { n = unwrap(n); return !!n && (ts.isIdentifier(n) || (ts.isPropertyAccessExpression(n)
  && (n.expression.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'globalThis')))); };
function exposesGlobal(expr) {
  for (let n = unwrap(expr); isAssign(n); n = unwrap(n.right)) if (globalTarget(n.left) && functionValue(n.right)) return true;
  return false;
}
const isDirective = (s) => !!s && ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression);

// Root function declarations only; any other top-level way to expose a callable fails closed.
function declarations(sf) {
  const out = [];
  for (const s of sf.statements) {
    check(!ts.isClassDeclaration(s) && !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s) && !ts.isExportAssignment(s), 'TOPLEVEL_FUNCTION_VALUE');
    if (ts.isVariableStatement(s)) check(!s.declarationList.declarations.some((d) => functionValue(d.initializer)), 'TOPLEVEL_FUNCTION_VALUE');
    if (ts.isExpressionStatement(s)) check(!exposesGlobal(s.expression), 'TOPLEVEL_FUNCTION_VALUE');
    if (!ts.isFunctionDeclaration(s)) continue;
    check(s.name && s.body && !s.modifiers?.length && !s.asteriskToken, 'FUNCTION_INVALID');
    const isPublic = isPublicName(s.name.text);
    check(!isPublic || !isDirective(s.body.statements[0]), 'FUNCTION_INVALID'); // guard would break a directive prologue
    out.push({ name: s.name.text, isPublic, body: s.body, at: s.body.getStart(sf) + 1 });
  }
  return out;
}

// Per-file line ending: all CRLF or all LF (no lone CR, no mix). The guard reuses the file's EOL so
// raw bytes and EOL style are preserved; baseline text is never normalized for output.
export function eolOf(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length, lf = (text.match(/\n/g) ?? []).length, cr = (text.match(/\r/g) ?? []).length;
  check(cr === crlf && (crlf === 0 || crlf === lf), 'EOL_MIXED');
  return crlf ? '\r\n' : '\n';
}
export const guardText = (eol) => `${eol}  ${GUARD_NAME}();`;

// Pure: inserts guardText(eol) right after `{` of every public root function (reverse offset order;
// TS positions are UTF-16 indices, matching String#slice). All other bytes/comments are preserved.
export function patchSource(source, file) {
  check(typeof source === 'string' && typeof file === 'string', 'CANDIDATE_INVALID');
  check(!source.includes(GUARD_NAME), 'GUARD_COLLISION');
  const guard = guardText(eolOf(source));
  const decls = declarations(parse(source, file));
  const pub = decls.filter((d) => d.isPublic);
  check(new Set(pub.map((d) => d.name)).size === pub.length, 'PUBLIC_DUPLICATE');
  let text = source;
  for (const d of [...pub].sort((a, b) => b.at - a.at)) text = text.slice(0, d.at) + guard + text.slice(d.at);
  check(unpatchSource(text, file).text === source, 'UNPATCH_MISMATCH');
  return Object.freeze({ text, publicNames: pub.map((d) => d.name), privateNames: decls.filter((d) => !d.isPublic).map((d) => d.name) });
}

// Pure inverse from the candidate AST: every public body must start with exactly the guard text and
// the guard call must be its first statement; private bodies must not. Removes only those insertions.
export function unpatchSource(candidate, file) {
  check(typeof candidate === 'string', 'CANDIDATE_INVALID');
  const eol = eolOf(candidate), guard = guardText(eol);
  const sf = parse(candidate, file);
  const decls = declarations(sf), cuts = [];
  for (const d of decls) {
    const first = d.body.statements[0], call = first && ts.isExpressionStatement(first) ? first.expression : null;
    const guarded = !!call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === GUARD_NAME;
    if (!d.isPublic) { check(!guarded, 'CANDIDATE_INVALID'); continue; }
    check(guarded && call.arguments.length === 0 && !call.typeArguments && !call.questionDotToken
      && candidate.slice(d.at, d.at + guard.length) === guard
      && first.getStart(sf) === d.at + eol.length + 2 && first.end === d.at + guard.length, 'UNPATCH_MISMATCH');
    cuts.push(d.at);
  }
  let text = candidate;
  for (const at of cuts.sort((a, b) => b - a)) text = text.slice(0, at) + text.slice(at + guard.length);
  check(!text.includes(GUARD_NAME), 'UNPATCH_MISMATCH');
  return { text, publicCount: cuts.length, privateCount: decls.length - cuts.length };
}

// Baseline public set must equal the API_HANDLERS identifier values plus the fixed GAS entry points.
// The whitelist is a local `var API_HANDLERS = {...}` inside top-level doPost; any other binding of
// that name anywhere in the backend AST (shadowing, global, param, function) fails closed.
export const ENTRY_POINTS = Object.freeze(['doGet', 'doPost', 'cleanExpiredSessions']);
export function handlerNames(files) {
  const decls = [];
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text === 'API_HANDLERS' && n.parent?.name === n && !ts.isPropertyAssignment(n.parent)
      && !ts.isPropertyAccessExpression(n.parent)) decls.push(n.parent);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && ts.isIdentifier(unwrap(n.left)) && unwrap(n.left).text === 'API_HANDLERS') decls.push(n); // reassignment fails closed
    ts.forEachChild(n, visit);
  };
  for (const [file, text] of files) if (file.endsWith('.js')) visit(parse(text, file));
  check(decls.length === 1 && ts.isVariableDeclaration(decls[0]), 'HANDLERS_INVALID');
  const d = decls[0];
  let fn = d.parent;
  while (fn && !ts.isFunctionLike(fn) && !ts.isSourceFile(fn)) fn = fn.parent;
  check(fn && ts.isFunctionDeclaration(fn) && fn.name?.text === 'doPost' && ts.isSourceFile(fn.parent), 'HANDLERS_INVALID');
  check(d.initializer && ts.isObjectLiteralExpression(d.initializer), 'HANDLERS_INVALID');
  const keys = [], names = [];
  for (const p of d.initializer.properties) {
    check((ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
      || ts.isShorthandPropertyAssignment(p), 'HANDLERS_INVALID');
    keys.push(p.name.text); names.push(ts.isShorthandPropertyAssignment(p) ? p.name.text : p.initializer.text);
  }
  check(new Set(keys).size === keys.length && new Set(names).size === names.length, 'HANDLERS_INVALID');
  return names;
}

export function verifyHelper(bytes) {
  check(sha256(bytes) === HELPER_SHA256, 'HELPER_HASH_MISMATCH');
  const text = decode(bytes, 'HELPER_INVALID');
  const [only, ...rest] = parse(text, HELPER_FILE).statements;
  check(!rest.length && only && ts.isFunctionDeclaration(only) && only.name?.text === GUARD_NAME && !isPublicName(GUARD_NAME), 'HELPER_INVALID');
  return text;
}

// Pure: candidate = original files unchanged except .js (exact unpatch) + the exact helper file.
export function verifyCandidate(original, candidate, helperText) {
  check(original instanceof Map && candidate instanceof Map && typeof helperText === 'string', 'CANDIDATE_INVALID');
  check(![...original.keys()].some((k) => k.toLowerCase() === HELPER_FILE.toLowerCase()), 'GUARD_COLLISION');
  check(candidate.size === original.size + 1 && candidate.get(HELPER_FILE) === helperText, 'CANDIDATE_INVALID');
  const coverage = {}, names = new Set();
  let publicFunctions = 0, privateFunctions = 0;
  for (const file of [...original.keys()].sort()) {
    const text = original.get(file), patched = candidate.get(file);
    check(typeof patched === 'string', 'CANDIDATE_INVALID');
    if (!file.endsWith('.js')) { check(patched === text, 'CANDIDATE_INVALID'); continue; }
    check(unpatchSource(patched, file).text === text, 'UNPATCH_MISMATCH');
    const p = patchSource(text, file);
    check(p.text === patched, 'UNPATCH_MISMATCH');
    for (const n of p.publicNames) { check(!names.has(n), 'PUBLIC_DUPLICATE'); names.add(n); }
    coverage[file] = { publicFunctions: [...p.publicNames], privateFunctions: p.privateNames.length };
    publicFunctions += p.publicNames.length; privateFunctions += p.privateNames.length;
  }
  return { publicFunctions, privateFunctions, functions: publicFunctions + privateFunctions, coverage };
}

async function verifyPrivate(target, code, { exactMode } = {}) {
  const stat = await lstat(target);
  check(stat.isDirectory() && !stat.isSymbolicLink(), code);
  if (process.platform === 'win32') {
    try { await verifyPrivatePersistence(target); } catch { throw new MigrationError(code); } // read-only ACL check
  } else {
    check(stat.uid === process.getuid() && (exactMode === undefined ? (stat.mode & 0o077) === 0 : (stat.mode & 0o777) === exactMode), code);
  }
}
async function readFileBounded(file, maxBytes, code) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return await readBoundedHandle(handle, maxBytes); } catch (error) { throw error instanceof MigrationError ? new MigrationError(code) : error; }
  finally { await handle.close(); }
}
const exists = async (target) => {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

// Reads the fixed private baseline only. Rejects links/special/dot entries (except an unread root
// .clasp.json), enforces limits before reading, and binds every file to the immutable package hash.
export async function readBaselineManifest() {
  const root = path.resolve(BASELINE_PATH);
  let stat;
  try { await noLinks(root); stat = await lstat(root); }
  catch (error) { throw new MigrationError(error instanceof MigrationError ? 'BASELINE_SYMLINK' : error.code === 'ENOENT' ? 'BASELINE_MISSING' : 'BASELINE_UNREADABLE'); }
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'BASELINE_SPECIAL_FILE');
  await verifyPrivate(root, 'BASELINE_PERMISSIONS');
  const files = new Map(), queue = [''];
  let total = 0, nodes = 0;
  while (queue.length) {
    const rel = queue.pop();
    for (const name of (await readdir(path.join(root, ...rel.split('/').filter(Boolean)))).sort()) {
      check(++nodes <= LIMITS.files * 2, 'BASELINE_LIMIT');
      const relPath = rel ? `${rel}/${name}` : name, abs = path.join(root, ...relPath.split('/'));
      const st = await lstat(abs);
      check(!st.isSymbolicLink(), 'BASELINE_SYMLINK');
      if (name.startsWith('.')) { check(relPath === CLASP_INPUT && st.isFile(), 'BASELINE_DOT_ENTRY'); continue; }
      check(safeName(name), 'BASELINE_INVENTORY');
      if (st.isDirectory()) { queue.push(relPath); continue; }
      check(st.isFile(), 'BASELINE_SPECIAL_FILE');
      check(files.size < LIMITS.files && st.size <= LIMITS.fileBytes && total + st.size <= LIMITS.totalBytes, 'BASELINE_LIMIT');
      const bytes = await readFileBounded(abs, LIMITS.fileBytes, 'BASELINE_LIMIT'); // read exactly once
      total += bytes.length; check(total <= LIMITS.totalBytes, 'BASELINE_LIMIT');
      const text = decode(bytes, 'BASELINE_ENCODING');
      check(!text.startsWith('\uFEFF'), 'BASELINE_ENCODING');
      eolOf(text);
      files.set(relPath, text); // raw text kept; LF normalization is used only for the package pin
    }
  }
  check(packageSha256(files) === BASELINE_PACKAGE_SHA256, 'BASELINE_HASH_MISMATCH');
  return { files, packageSha256: BASELINE_PACKAGE_SHA256 };
}

// Output path: no device/UNC prefixes or 8.3 `~` segments; the existing parent must resolve to itself
// (no junction/reparse/short-name aliasing) before the lexical outside-repo checks apply.
async function outputPath(out) {
  check(typeof out === 'string' && path.isAbsolute(out) && path.resolve(out) === out, 'OUT_ABSOLUTE_REQUIRED');
  check(!/^[\\/]{2}/.test(out) && !out.split(/[\\/]/).some((s) => s.includes('~')), 'OUT_PATH_INVALID');
  const target = await persistencePath(out);
  const parent = path.dirname(target);
  let real;
  try { real = await realpath(parent); } catch (error) { if (error.code === 'ENOENT') throw new MigrationError('PARENT_MISSING'); throw error; }
  check(canonicalPath(real) === canonicalPath(parent), 'OUT_PATH_INVALID');
  for (const base of [ROOT, BASELINE_PATH]) {
    const rel = path.relative(canonicalPath(path.resolve(base)), canonicalPath(target));
    check(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel), 'OUT_PATH_INVALID');
  }
  return target;
}

function checkInventory(files) {
  const keys = [...files.keys()], js = keys.filter((k) => /^backend\/[^/]+\.js$/.test(k)), html = keys.filter((k) => k.endsWith('.html'));
  check(keys.length === EXPECTED.files && js.length === EXPECTED.js && html.length === EXPECTED.html && files.has('appsscript.json')
    && keys.every((k) => js.includes(k) || html.includes(k) || k === 'appsscript.json'), 'BASELINE_INVENTORY');
}
async function writeNew(file, bytes) {
  const handle = await open(file, 'wx', 0o600); // exclusive create: never overwrites
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  check((await readFileBounded(file, LIMITS.fileBytes, 'OUTPUT_VERIFY_FAILED')).equals(bytes), 'OUTPUT_VERIFY_FAILED');
}

export async function buildCandidate({ out } = {}) {
  const target = await outputPath(out); // outside repo/baseline, no link/reparse aliasing in ancestry
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  await verifyPrivate(path.dirname(target), 'PARENT_PERMISSIONS'); // before any baseline read or mkdir

  await noLinks(HELPER_SOURCE);
  const helperText = verifyHelper(await readFileBounded(HELPER_SOURCE, 65536, 'HELPER_INVALID'));
  const { files } = await readBaselineManifest();
  checkInventory(files);
  const publicSet = new Set([...handlerNames(files), ...ENTRY_POINTS]);
  const candidate = new Map();
  for (const file of [...files.keys()].sort()) candidate.set(file, file.endsWith('.js') ? patchSource(files.get(file), file).text : files.get(file));
  check(![...files.keys()].some((k) => k.toLowerCase() === HELPER_FILE.toLowerCase()), 'GUARD_COLLISION');
  candidate.set(HELPER_FILE, helperText);
  const v = verifyCandidate(files, candidate, helperText);
  check(v.functions === EXPECTED.functions && v.publicFunctions === EXPECTED.publicFunctions && v.privateFunctions === EXPECTED.privateFunctions, 'COUNT_MISMATCH');
  const guarded = Object.values(v.coverage).flatMap((c) => c.publicFunctions);
  check(publicSet.size === guarded.length && guarded.every((n) => publicSet.has(n)), 'PUBLIC_SET_MISMATCH');
  const outputs = [...candidate].map(([p, text]) => [p, utf8(text)]);
  const totalBytes = outputs.reduce((n, [, b]) => n + b.length, 0);
  check(outputs.length + 1 <= LIMITS.files && outputs.every(([, b]) => b.length <= LIMITS.fileBytes) && totalBytes <= LIMITS.totalBytes, 'OUTPUT_LIMIT');
  const targetPackageSha256 = packageSha256(candidate);
  const changed = [...files.keys()].filter((k) => candidate.get(k) !== files.get(k)).sort();
  const counts = {
    baselineFiles: files.size, candidateFiles: candidate.size, outputFiles: candidate.size + 1, changedFiles: changed.length,
    unchangedFiles: files.size - changed.length, functions: v.functions, publicFunctions: v.publicFunctions,
    privateFunctions: v.privateFunctions, guardsInserted: v.publicFunctions,
  };
  const receipt = utf8(`${JSON.stringify({
    kind: 'sikap-gas-cutover-candidate', receiptVersion: 1, version: VERSION,
    baselinePackageSha256: BASELINE_PACKAGE_SHA256, baselineRawFiles: rawPairs(files),
    helperFile: HELPER_FILE, helperSha256: HELPER_SHA256,
    helperNote: 'Helper bytes copied verbatim (pinned hash). Its header comment says every top-level function is guarded; in this candidate only the 43 public functions are guarded and the 70 private functions are unchanged.',
    targetPackageSha256, targetFiles: filePairs(candidate), targetRawFiles: rawPairs(candidate), changedFiles: changed,
    counts, coverage: v.coverage, lineEndings: 'preserved-per-file', guardPlacement: 'first statement of each public root function',
    pushConfigIncluded: false, readyForPush: false, deployed: false, remoteOperations: false,
  }, null, 2)}\n`);
  check(totalBytes + receipt.length <= LIMITS.totalBytes && !candidate.has(RECEIPT_FILE), 'OUTPUT_LIMIT');

  // From here on artifacts are private and left in place on failure (no cleanup, no deletes).
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new MigrationError('OUTPUT_EXISTS'); throw error; }
  await noLinks(target);
  check(canonicalPath(await realpath(target)) === canonicalPath(target), 'OUT_PATH_INVALID');
  await verifyPrivate(target, 'OUTPUT_PERMISSIONS', { exactMode: 0o700 });
  const dirs = [...new Set(outputs.flatMap(([p]) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort();
  for (const dir of dirs) {
    const abs = path.join(target, ...dir.split('/'));
    await mkdir(abs, { mode: 0o700 });
    await verifyPrivate(abs, 'OUTPUT_PERMISSIONS');
  }
  for (const [p, bytes] of outputs) await writeNew(path.join(target, ...p.split('/')), bytes);
  await writeNew(path.join(target, RECEIPT_FILE), receipt); // receipt last
  return { version: VERSION, baselinePackageSha256: BASELINE_PACKAGE_SHA256, helperSha256: HELPER_SHA256, targetPackageSha256, receiptSha256: sha256(receipt), counts };
}

export function parseArgs(argv) {
  check(Array.isArray(argv) && argv.length === 2 && argv[0] === '--out' && typeof argv[1] === 'string' && !argv[1].startsWith('--'), 'CLI_ARGUMENTS');
  check(path.isAbsolute(argv[1]) && path.resolve(argv[1]) === argv[1], 'OUT_ABSOLUTE_REQUIRED');
  return { out: argv[1] };
}

if (isMain(import.meta.url)) {
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { print({ ok: false, code: safeCode(error) }); process.exitCode = 2; }
  if (args) {
    try { print({ ok: true, code: 'CANDIDATE_READY', ...(await buildCandidate(args)) }); }
    catch (error) { print({ ok: false, code: safeCode(error) }); process.exitCode = 1; }
  }
}
