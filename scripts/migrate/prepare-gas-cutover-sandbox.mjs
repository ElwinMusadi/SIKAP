// Local-only generator for a SYNTHETIC Apps Script cutover-gate sandbox kit.
// Node built-ins + existing `typescript` dev dependency (AST parsing only). It never runs clasp, never
// evaluates template/helper code, performs no network/remote I/O and never reads credentials/env secrets.
// It reads ONLY two static repo files: the pinned helper legacy-gas/src/backend/Cutover.gs and the harness
// template scripts/migrate/gas/CutoverSandboxHarness.gs. It never reads the private v140 baseline or any
// candidate, and the kit contains no live source, names or IDs: only 43 direct + 40 handler synthetic
// stand-ins defined by the harness itself. Importing this module does no I/O.
// Output (CLI/buildSandbox only) is a NEW private directory outside the repo/cwd/baseline holding exactly:
// Cutover.gs (raw pinned bytes), CutoverSandboxHarness.gs (rendered) and the receipt, written last with
// exclusive create. No appsscript.json/.clasp*/package/workflow file is written, so nothing is pushable as-is.
// Partial output after mkdir is left in place (no cleanup/deletes). The only spawn is the existing read-only
// ACL check (verifyPrivatePersistence) on Windows.
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {
  MigrationError, ROOT, canonicalPath, check, isMain, noLinks, persistencePath, readBoundedHandle, safeCode, sha256,
  verifyPrivatePersistence,
} from './local-store.mjs';

export const HELPER_SOURCE = path.join(ROOT, 'legacy-gas', 'src', 'backend', 'Cutover.gs');
export const TEMPLATE_SOURCE = path.join(ROOT, 'scripts', 'migrate', 'gas', 'CutoverSandboxHarness.gs');
// Same raw pin as prepare-gas-v140.mjs HELPER_SHA256 (asserted equal in tests; not imported to keep this
// module free of any baseline constants/readers).
export const HELPER_RAW_SHA256 = '83171e00d283c486455a1a4bf819205cb42d2b8f9c0c2711ced6f51bf0f228c4';
// sha256(UTF-8 of TS FunctionDeclaration#getText() of assertCutoverOpen_) == V8 String(assertCutoverOpen_).
export const HELPER_FUNCTION_SHA256 = '2fc47ee707278d1ae4580398ba0ef6afea28f210221a4dc79216d71ba07e6dd5';
// Frozen harness template pin (coordinated with the harness owner). Production build requires an exact match.
export const TEMPLATE_SHA256 = 'a24ef1bc1931626218afca3e17c90e8719182c7a55f750453744615f8b5193b3';
// Lexical-only (never read): output must not be inside/around the private v140 audit baseline.
const BASELINE_DIR = 'C:/Users/elwin/AppData/Local/Temp/kilo/sikap-gas-audit-J4AFda/v140';

export const GUARD_NAME = 'assertCutoverOpen_';
export const PLACEHOLDER = '/*@@MANIFEST@@*/null';
export const MANIFEST_VAR = 'CUTOVER_SANDBOX_MANIFEST_';
export const ENTRY_NAME = 'runCutoverSandboxRehearsal_';
export const HELPER_FILE = 'Cutover.gs';
export const HARNESS_FILE = 'CutoverSandboxHarness.gs';
export const RECEIPT_FILE = 'cutover-sandbox.receipt.json';
export const OUTPUT_FILES = Object.freeze([HELPER_FILE, HARNESS_FILE, RECEIPT_FILE]);
export const MANIFEST_KEYS = Object.freeze(['kind', 'version', 'nonce', 'helperFunctionSha256', 'directCases', 'handlerCases', 'realV140FeatureValidation']);
export const CASES = Object.freeze({ directCases: 43, handlerCases: 40 });
export const RENDERED_CODE = 'SANDBOX_TEMPLATE_RENDERED';
export const READY_CODE = 'SANDBOX_HARNESS_READY_LOCAL';
const LIMITS = Object.freeze({ helperBytes: 64 * 1024, templateBytes: 256 * 1024 });
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const utf8 = (text) => Buffer.from(text, 'utf8');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---- Template policy (narrow, static, defense in depth; the template hash pin is the primary control) ----
const ALLOWED_GLOBALS = new Set(['JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Error', 'TypeError', 'RangeError',
  'Math', 'Date', 'RegExp', 'isFinite', 'isNaN', 'parseInt']);
const VALUE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity']);
const MEMBER_ONLY = Object.freeze({
  PropertiesService: ['getScriptProperties'], ScriptApp: ['getScriptId'],
  Utilities: ['computeDigest', 'DigestAlgorithm', 'Charset'], Logger: ['log'],
});
const TYPEOF_ONLY = new Set(['doGet', 'doPost', 'API_HANDLERS', 'cleanExpiredSessions', 'onOpen', 'onEdit']);
const FORBIDDEN = new Set([
  'eval', 'globalThis', 'Reflect', 'Proxy', 'Function', 'constructor', '__proto__', 'prototype', 'google', 'require', 'arguments',
  'SpreadsheetApp', 'DriveApp', 'UrlFetchApp', 'MailApp', 'GmailApp', 'DocumentApp', 'SlidesApp', 'FormApp', 'CalendarApp',
  'HtmlService', 'ContentService', 'LockService', 'CacheService', 'Session', 'Jdbc', 'Browser', 'Drive', 'Sheets', 'XmlService',
  'Charts', 'Maps', 'LanguageApp', 'GroupsApp', 'ContactsApp', 'People', 'AdminDirectory', 'BigQuery', 'Gmail',
  'setProperties', 'deleteAllProperties', 'getUserProperties', 'getDocumentProperties', 'getOAuthToken', 'getIdentityToken',
  'newTrigger', 'getProjectTriggers', 'getUserTriggers', 'deleteTrigger', 'getService', 'invalidateAuth',
  'openById', 'openByUrl', 'getFileById', 'getFolderById', 'fetch', 'fetchAll', 'doOptions', 'onInstall', 'onFormSubmit', 'onChange',
]);
const RESERVED = new Set([...ALLOWED_GLOBALS, ...VALUE_GLOBALS, ...Object.keys(MEMBER_ONLY), ...TYPEOF_ONLY, GUARD_NAME]);
const STRING_WORDS = new RegExp(`(?:^|[^A-Za-z0-9_$])(?:${[...FORBIDDEN, ...Object.keys(MEMBER_ONLY), ...TYPEOF_ONLY].join('|')})(?![A-Za-z0-9_$])`);
const OBJECT_MUTATORS = new Set(['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf', 'freeze', 'seal', 'preventExtensions']);
const REJECT_KINDS = new Set([ts.SyntaxKind.ThisKeyword, ts.SyntaxKind.SuperKeyword, ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TaggedTemplateExpression, ts.SyntaxKind.WithStatement,
  ts.SyntaxKind.ImportKeyword, ts.SyntaxKind.ImportDeclaration, ts.SyntaxKind.ExportDeclaration, ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.DebuggerStatement, ts.SyntaxKind.MetaProperty,
  ts.SyntaxKind.PrivateIdentifier, ts.SyntaxKind.YieldExpression, ts.SyntaxKind.AwaitExpression]);
const ARITH = new Set([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.PercentToken]);

function decode(bytes, code) {
  check(bytes instanceof Uint8Array, code);
  let text;
  try { text = decoder.decode(bytes); } catch { throw new MigrationError(code); }
  check(utf8(text).equals(Buffer.from(bytes)) && !text.startsWith('\uFEFF') && !text.includes('\r'), code);
  return text;
}
function parse(text, file, code) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  check(sf.parseDiagnostics.length === 0, code);
  return sf;
}
const unwrap = (n) => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n; };
const rootOf = (n) => { n = unwrap(n); while (n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))) n = unwrap(n.expression); return n; };
const isAssignOp = (k) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
const plainOptions = (value, keys, code) => {
  check(!!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, code);
  const own = Reflect.ownKeys(value);
  check(own.length === keys.length && keys.every((k) => own.includes(k)), code);
  for (const k of keys) check('value' in Object.getOwnPropertyDescriptor(value, k), code); // data props only, no getters
  return Object.fromEntries(keys.map((k) => [k, value[k]]));
};

// Pure. Exact pinned helper bytes (no override): one private FunctionDeclaration, no CR, function-text pin.
export function helperFunctionSha256(text) {
  check(typeof text === 'string' && !text.includes('\r'), 'HELPER_INVALID');
  const fns = parse(text, HELPER_FILE, 'HELPER_INVALID').statements.filter((s) => ts.isFunctionDeclaration(s) && s.name?.text === GUARD_NAME);
  check(fns.length === 1, 'HELPER_INVALID');
  return sha256(utf8(fns[0].getText()));
}
export function verifyHelper(bytes) {
  check(bytes instanceof Uint8Array && sha256(bytes) === HELPER_RAW_SHA256, 'HELPER_HASH_MISMATCH');
  const text = decode(bytes, 'HELPER_INVALID');
  const [only, ...rest] = parse(text, HELPER_FILE, 'HELPER_INVALID').statements;
  check(!rest.length && only && ts.isFunctionDeclaration(only) && only.name?.text === GUARD_NAME && !only.modifiers?.length, 'HELPER_INVALID');
  check(helperFunctionSha256(text) === HELPER_FUNCTION_SHA256, 'HELPER_FUNCTION_MISMATCH');
  return text;
}

// Pure. Validates the harness template against the agreed narrow policy; returns safe counts only.
export function validateTemplate(text) {
  check(typeof text === 'string' && utf8(text).length <= LIMITS.templateBytes, 'TEMPLATE_INVALID');
  check(!text.startsWith('\uFEFF') && !text.includes('\r'), 'TEMPLATE_ENCODING');
  const at = text.indexOf(PLACEHOLDER);
  check(at >= 0 && text.indexOf(PLACEHOLDER, at + 1) < 0 && text.split('@@').length === 3, 'TEMPLATE_PLACEHOLDER');
  check(!/https?:\/\/|google\.com|googleapis/i.test(text), 'TEMPLATE_FORBIDDEN_TEXT');
  check(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/.test(text), 'TEMPLATE_FORBIDDEN_TEXT');
  check(!/\d{9,}/.test(text), 'TEMPLATE_FORBIDDEN_TEXT');
  for (const t of text.match(/[A-Za-z0-9_-]{25,}/g) ?? []) check(t === 'realV140FeatureValidation' || !(/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t)), 'TEMPLATE_FORBIDDEN_TEXT');
  const sf = parse(text, HARNESS_FILE, 'TEMPLATE_PARSE_ERROR');

  // Top level: private function declarations + exactly the manifest var with the placeholder initializer.
  const topLevel = [];
  let manifestVars = 0;
  for (const s of sf.statements) {
    if (ts.isFunctionDeclaration(s)) {
      check(s.name && s.body && !s.modifiers?.length && !s.asteriskToken && s.name.text.endsWith('_'), 'TEMPLATE_TOPLEVEL');
      topLevel.push(s.name.text);
      continue;
    }
    check(ts.isVariableStatement(s) && !s.modifiers?.length && (s.declarationList.flags & ts.NodeFlags.BlockScoped) === 0
      && s.declarationList.declarations.length === 1, 'TEMPLATE_TOPLEVEL');
    const d = s.declarationList.declarations[0], init = d.initializer;
    check(ts.isIdentifier(d.name) && (d.name.text === MANIFEST_VAR || !text.slice(d.getStart(sf), d.end).includes(PLACEHOLDER)), 'TEMPLATE_PLACEHOLDER');
    check(d.name.text === MANIFEST_VAR, 'TEMPLATE_TOPLEVEL');
    check(init && init.kind === ts.SyntaxKind.NullKeyword
      && init.end === at + PLACEHOLDER.length && init.getStart(sf) === at + PLACEHOLDER.length - 4
      && text.slice(d.name.end, at).trim() === '=', 'TEMPLATE_PLACEHOLDER');
    manifestVars++; topLevel.push(MANIFEST_VAR);
  }
  check(manifestVars === 1 && topLevel.filter((n) => n === ENTRY_NAME).length === 1, 'TEMPLATE_TOPLEVEL');

  // Declared names (flat; no scoping): must never shadow reserved globals or duplicate a top-level name.
  const declared = new Map();
  const declare = (n) => { if (ts.isIdentifier(n)) declared.set(n.text, (declared.get(n.text) ?? 0) + 1); else ts.forEachChild(n, (c) => { if (ts.isBindingElement(c)) declare(c.name); else declare(c); }); };
  const collect = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) declare(n.name);
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) declare(n.name);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  for (const name of declared.keys()) check(!RESERVED.has(name) && !FORBIDDEN.has(name), 'TEMPLATE_SHADOWING');
  for (const name of topLevel) check(declared.get(name) === 1, 'TEMPLATE_SHADOWING');
  const topSet = new Set(topLevel);
  const mutableRootOk = (target) => { const r = rootOf(target); return !!r && ts.isIdentifier(r) && declared.has(r.text) && !topSet.has(r.text); };

  const visit = (n) => {
    check(!REJECT_KINDS.has(n.kind), 'TEMPLATE_FORBIDDEN_SYNTAX');
    if (ts.isCallExpression(n)) check(n.expression.kind !== ts.SyntaxKind.ImportKeyword, 'TEMPLATE_FORBIDDEN_SYNTAX');
    if (ts.isFunctionLike(n)) check(!n.asteriskToken && !n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword), 'TEMPLATE_FORBIDDEN_SYNTAX');
    if (ts.isStringLiteral(n) || ts.isRegularExpressionLiteral(n)) check(!STRING_WORDS.test(n.text), 'TEMPLATE_FORBIDDEN_TEXT');
    if (ts.isBinaryExpression(n) && isAssignOp(n.operatorToken.kind)) {
      const left = unwrap(n.left);
      check(!ts.isObjectLiteralExpression(left) && !ts.isArrayLiteralExpression(left) && mutableRootOk(left), 'TEMPLATE_GLOBAL_MUTATION');
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
      && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) check(mutableRootOk(n.operand), 'TEMPLATE_GLOBAL_MUTATION');
    if (ts.isDeleteExpression(n)) check(mutableRootOk(n.expression), 'TEMPLATE_GLOBAL_MUTATION');
    if (ts.isElementAccessExpression(n)) {
      const a = unwrap(n.argumentExpression);
      const simple = (x) => ts.isIdentifier(x) || ts.isNumericLiteral(x) || ts.isPropertyAccessExpression(x);
      check(simple(a) || ts.isStringLiteral(a) || (ts.isBinaryExpression(a) && ARITH.has(a.operatorToken.kind) && simple(unwrap(a.left)) && simple(unwrap(a.right))), 'TEMPLATE_FORBIDDEN_SYNTAX');
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
      && n.expression.expression.text === 'Object' && OBJECT_MUTATORS.has(n.expression.name.text)) {
      check(n.arguments.length > 0 && mutableRootOk(n.arguments[0]), 'TEMPLATE_GLOBAL_MUTATION');
    }
    if (ts.isIdentifier(n)) checkIdentifier(n, sf, declared);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { templateSha256: sha256(utf8(text)), templateFunctions: topLevel.length - 1, templatePublicFunctions: 0 };
}

function checkIdentifier(n, sf, declared) {
  const name = ts.idText(n), p = n.parent;
  check(n.getText(sf) === name, 'TEMPLATE_FORBIDDEN_IDENTIFIER'); // no unicode-escaped identifiers
  // Read-only `Object.prototype` (e.g. hasOwnProperty.call) is the only permitted use of `prototype`.
  if (name === 'prototype' && ts.isPropertyAccessExpression(p) && p.name === n && ts.isIdentifier(p.expression)
    && p.expression.text === 'Object' && !declared.has('Object')) return;
  check(!FORBIDDEN.has(name), 'TEMPLATE_FORBIDDEN_IDENTIFIER');
  // Non-reference positions: member names, object keys, labels.
  if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
    || ((ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) && p.label === n)
    || (ts.isBindingElement(p) && p.propertyName === n)) return;
  if (declared.has(name)) return;
  if (VALUE_GLOBALS.has(name)) return;
  if (ALLOWED_GLOBALS.has(name)) { // no aliasing: member root, callee, `new` target or instanceof RHS only
    check((ts.isPropertyAccessExpression(p) && p.expression === n) || ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n)
      || (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword), 'TEMPLATE_GLOBAL_FORBIDDEN');
    return;
  }
  if (Object.hasOwn(MEMBER_ONLY, name)) {
    check(ts.isPropertyAccessExpression(p) && p.expression === n && MEMBER_ONLY[name].includes(p.name.text), 'TEMPLATE_GLOBAL_FORBIDDEN');
    return;
  }
  if (TYPEOF_ONLY.has(name)) { check(ts.isTypeOfExpression(p) && p.expression === n, 'TEMPLATE_GLOBAL_FORBIDDEN'); return; }
  if (name === GUARD_NAME) {
    check((ts.isCallExpression(p) && (p.expression === n || p.arguments.includes(n))) || (ts.isTypeOfExpression(p) && p.expression === n), 'TEMPLATE_GLOBAL_FORBIDDEN');
    return;
  }
  throw new MigrationError('TEMPLATE_GLOBAL_FORBIDDEN');
}

// Pure manifest helpers. Key order is fixed; the harness checks the exact key set and types.
export function buildManifest(nonce) {
  check(typeof nonce === 'string' && HEX(32).test(nonce), 'NONCE_INVALID');
  return Object.freeze({ kind: 'sikap-cutover-sandbox', version: 1, nonce, helperFunctionSha256: HELPER_FUNCTION_SHA256,
    directCases: CASES.directCases, handlerCases: CASES.handlerCases, realV140FeatureValidation: false });
}
export function verifyManifest(value) {
  check(!!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'MANIFEST_INVALID');
  const keys = Object.keys(value);
  check(keys.length === MANIFEST_KEYS.length && MANIFEST_KEYS.every((k, i) => keys[i] === k), 'MANIFEST_INVALID');
  check(typeof value.nonce === 'string' && HEX(32).test(value.nonce)
    && JSON.stringify(value) === JSON.stringify(buildManifest(value.nonce)), 'MANIFEST_INVALID');
  return value;
}

// Pure render of exactly-pinned helper + a template (synthetic fixtures allowed). It can never yield the
// ready status: that is produced only by buildSandbox after the template pin, privacy and write checks.
export function renderSandbox(options) {
  const { helperBytes, templateText, nonce } = plainOptions(options, ['helperBytes', 'templateText', 'nonce'], 'OPTIONS_INVALID');
  const helperText = verifyHelper(helperBytes);
  const t = validateTemplate(templateText);
  const manifest = buildManifest(nonce);
  const json = JSON.stringify(manifest), at = templateText.indexOf(PLACEHOLDER);
  const harness = templateText.slice(0, at) + json + templateText.slice(at + PLACEHOLDER.length);
  const sf = parse(harness, HARNESS_FILE, 'RENDER_INVALID');
  const decl = sf.statements.filter(ts.isVariableStatement).flatMap((s) => s.declarationList.declarations).filter((d) => ts.isIdentifier(d.name) && d.name.text === MANIFEST_VAR);
  check(decl.length === 1 && ts.isObjectLiteralExpression(decl[0].initializer) && decl[0].initializer.getText(sf) === json
    && !harness.includes('@@') && !harness.includes('\r'), 'RENDER_INVALID');
  verifyManifest(JSON.parse(decl[0].initializer.getText(sf)));
  const helperBuf = Buffer.from(helperBytes), harnessBuf = utf8(harness);
  return Object.freeze({
    code: RENDERED_CODE, manifest, helperText, harnessText: harness,
    hashes: Object.freeze({ helperRawSha256: sha256(helperBuf), helperFunctionSha256: HELPER_FUNCTION_SHA256, templateSha256: t.templateSha256, harnessSha256: sha256(harnessBuf) }),
    counts: Object.freeze({ ...CASES, templateFunctions: t.templateFunctions, templatePublicFunctions: t.templatePublicFunctions }),
  });
}

// Pure receipt: safe hashes/counts/nonce only. No paths, script IDs, source, names or property values.
export function buildReceipt(rendered) {
  check(rendered && rendered.code === RENDERED_CODE, 'RECEIPT_INVALID');
  const { hashes, counts, manifest } = rendered;
  return utf8(`${JSON.stringify({
    kind: 'sikap-cutover-sandbox-receipt', receiptVersion: 1, manifestKind: manifest.kind, manifestVersion: manifest.version,
    nonce: manifest.nonce, helperRawSha256: hashes.helperRawSha256, helperFunctionSha256: hashes.helperFunctionSha256,
    templateSha256: hashes.templateSha256, harnessSha256: hashes.harnessSha256,
    files: [[HELPER_FILE, hashes.helperRawSha256], [HARNESS_FILE, hashes.harnessSha256]],
    counts: { outputFiles: OUTPUT_FILES.length, ...counts },
    helperNote: 'Cutover.gs is the exact pinned prototype helper (raw bytes verbatim). Its header comment describes guarding every top-level backend function; this kit contains no backend or v140 functions, only synthetic stand-ins defined by the harness.',
    syntheticOnly: true, pushConfigIncluded: false, readyForPush: false, readyForDeploy: false, runtimeFrozenVerified: false,
    deploymentAuthorized: false, deployAuthorized: false, remoteAuthorized: false, liveFreezeAuthorized: false,
    goLiveAuthorized: false, realV140FeatureValidation: false,
  }, null, 2)}\n`);
}

// ---- Filesystem (CLI) path ----
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
async function readRepoFile(file, maxBytes, code) {
  try { await noLinks(file); check((await lstat(file)).isFile(), code); return await readFileBounded(file, maxBytes, code); }
  catch (error) { throw error instanceof MigrationError ? new MigrationError(code) : new MigrationError(code); }
}
const exists = async (target) => {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const outside = (base, target) => {
  const rel = path.relative(canonicalPath(path.resolve(base)), canonicalPath(target));
  const back = path.relative(canonicalPath(target), canonicalPath(path.resolve(base)));
  const out = (r) => r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
  return rel !== '' && out(rel) && out(back); // neither inside nor an ancestor
};
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// Lexical + resolved path policy: absolute normalized, no UNC/device/ADS/8.3 `~`/reserved names, parent exists
// and resolves to itself (no link/junction/short-name aliasing), outside repo, cwd and the baseline (both ways).
export async function outputPath(out) {
  check(typeof out === 'string' && out.length < 260 && path.isAbsolute(out) && path.resolve(out) === out, 'OUT_ABSOLUTE_REQUIRED');
  check(!/^[\\/]{2}/.test(out) && !out.includes('\0'), 'OUT_PATH_INVALID');
  const { root } = path.parse(out), segments = out.slice(root.length).split(path.sep);
  check(process.platform !== 'win32' || /^[A-Za-z]:\\$/.test(root), 'OUT_PATH_INVALID');
  check(segments.length >= 1 && segments.every((s) => s && s !== '.' && s !== '..' && !s.includes('~') && !/[<>:"|?*/\\]/.test(s)
    && ![...s].some((c) => c.charCodeAt(0) < 0x20) && !/[. ]$/.test(s) && !WIN_RESERVED.test(s)), 'OUT_PATH_INVALID');
  for (const base of [ROOT, process.cwd(), BASELINE_DIR]) check(outside(base, out), 'OUT_PATH_INVALID'); // lexical, before any I/O
  let target;
  try { target = await persistencePath(out); } catch { throw new MigrationError('OUT_PATH_INVALID'); }
  const parent = path.dirname(target);
  let real;
  try { real = await realpath(parent); } catch (error) { if (error.code === 'ENOENT') throw new MigrationError('PARENT_MISSING'); throw new MigrationError('OUT_PATH_INVALID'); }
  check(canonicalPath(real) === canonicalPath(parent), 'OUT_PATH_INVALID');
  for (const base of [ROOT, process.cwd(), BASELINE_DIR]) check(outside(base, real) && outside(base, target), 'OUT_PATH_INVALID');
  return target;
}
async function writeNew(file, bytes) {
  const handle = await open(file, 'wx', 0o600); // exclusive create: never overwrites
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  check((await readFileBounded(file, LIMITS.templateBytes * 2, 'OUTPUT_VERIFY_FAILED')).equals(bytes), 'OUTPUT_VERIFY_FAILED');
}

// Only entry point that writes. Accepts exactly one plain data property {outDir}; the helper, template, nonce,
// pins and status cannot be overridden by callers.
export async function buildSandbox(options) {
  const { outDir } = plainOptions(options, ['outDir'], 'OPTIONS_INVALID');
  check(typeof outDir === 'string', 'OUT_ABSOLUTE_REQUIRED');
  check(typeof TEMPLATE_SHA256 === 'string' && HEX(64).test(TEMPLATE_SHA256), 'TEMPLATE_PIN_MISSING');
  const target = await outputPath(outDir);
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  const parent = path.dirname(target);
  await verifyPrivate(parent, 'PARENT_PERMISSIONS'); // before any read or mkdir

  const helperBytes = await readRepoFile(HELPER_SOURCE, LIMITS.helperBytes, 'HELPER_INVALID');
  const templateBytes = await readRepoFile(TEMPLATE_SOURCE, LIMITS.templateBytes, 'TEMPLATE_INVALID');
  check(sha256(templateBytes) === TEMPLATE_SHA256, 'TEMPLATE_HASH_MISMATCH');
  const rendered = renderSandbox({ helperBytes, templateText: decode(templateBytes, 'TEMPLATE_ENCODING'), nonce: randomBytes(16).toString('hex') });
  check(rendered.hashes.templateSha256 === TEMPLATE_SHA256, 'TEMPLATE_HASH_MISMATCH');
  const receipt = buildReceipt(rendered);
  const outputs = [[HELPER_FILE, Buffer.from(helperBytes)], [HARNESS_FILE, utf8(rendered.harnessText)]];

  // From here on artifacts are private and left in place on failure (no cleanup, no deletes).
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  await verifyPrivate(parent, 'PARENT_PERMISSIONS');
  try { await mkdir(target, { mode: 0o700 }); } // non-recursive
  catch (error) { if (error.code === 'EEXIST') throw new MigrationError('OUTPUT_EXISTS'); throw new MigrationError('OUTPUT_CREATE_FAILED'); }
  await noLinks(target);
  check(canonicalPath(await realpath(target)) === canonicalPath(target), 'OUT_PATH_INVALID');
  await verifyPrivate(target, 'OUTPUT_PERMISSIONS', { exactMode: 0o700 });
  for (const [name, bytes] of outputs) await writeNew(path.join(target, name), bytes);
  await writeNew(path.join(target, RECEIPT_FILE), receipt); // receipt last
  const names = (await readdir(target)).sort();
  check(names.length === OUTPUT_FILES.length && [...OUTPUT_FILES].sort().every((n, i) => names[i] === n), 'OUTPUT_VERIFY_FAILED');
  return { code: READY_CODE, ...rendered.hashes, receiptSha256: sha256(receipt), counts: { outputFiles: OUTPUT_FILES.length, ...rendered.counts } };
}

export function parseArgs(argv) {
  check(Array.isArray(argv) && argv.length === 2 && argv[0] === '--out' && typeof argv[1] === 'string' && !argv[1].startsWith('-'), 'CLI_ARGUMENTS');
  check(path.isAbsolute(argv[1]) && path.resolve(argv[1]) === argv[1], 'OUT_ABSOLUTE_REQUIRED');
  return { outDir: argv[1] };
}

if (isMain(import.meta.url)) {
  // stdout: code, hashes and counts only (no nonce, paths or raw errors).
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { print({ ok: false, code: safeCode(error) }); process.exitCode = 2; }
  if (args) {
    try { print({ ok: true, ...(await buildSandbox(args)) }); }
    catch (error) { print({ ok: false, code: safeCode(error) }); process.exitCode = 1; }
  }
}
