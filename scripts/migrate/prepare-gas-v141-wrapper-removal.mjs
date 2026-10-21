// Local-only builder: removes the two unguarded public Maintenance wrappers from the pinned private v141 copy.
// Node built-ins + existing `typescript` dev dependency (AST parsing only). Never runs clasp, never evaluates
// GAS source, no network/remote/env-secret access. Importing this module does no I/O.
// Root of trust: the fixed private bundle (exact byte length + SHA-256 pin, hashed BEFORE JSON parsing) whose
// 42 payloads must equal the 42 raw files under files/ byte-for-byte, plus the in-memory raw package pin over
// those 42 files. Bundle metadata/PROVENANCE are never authority and never copied. No CLI/env/option can change
// the source root or any pin: the only input is `--out <absolute new dir>`.
// Output (buildWrapperRemoval/CLI only): a NEW private directory outside the repo/cwd/source/v140 baseline with
// the 42 files mirrored (41 raw byte-identical incl. appsscript.json; Maintenance minus the exact pinned
// 98-byte LF span) and wrapper-removal.receipt.json written last. Every file is exclusive-create (wx); partial
// output is left in place (no cleanup). No .clasp*/push config/bundle/provenance is written. stdout/receipt
// carry codes, counts and hashes only: never source text, span offsets, absolute paths or bundle IDs.
// The only spawn is the existing read-only Windows ACL check (verifyPrivatePersistence).
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import ts from 'typescript';
import {
  MigrationError, ROOT, canonicalPath, check, isMain, noLinks, persistencePath, readBoundedHandle, safeCode, sha256,
  verifyPrivatePersistence,
} from './local-store.mjs';
import { BASELINE_PATH as V140_BASELINE_PATH, ENTRY_POINTS, GUARD_NAME, HELPER_SHA256, handlerNames, verifyHelper } from './prepare-gas-v140.mjs';

export { ENTRY_POINTS, GUARD_NAME, HELPER_SHA256 };
export const VERSION = 141;
export const SOURCE_ROOT = path.resolve('C:/Users/elwin/sikap-private/source-v141-20261020'); // fixed, never an argument
export const SOURCE_FILES_DIR = 'files';
export const BUNDLE_FILE = 'v141-bundle.json';
export const BUNDLE_BYTES = 751809;
export const BUNDLE_SHA256 = '358df0721272e9529d2fbb825e0560bb272bcb171092f8777f0044573348a527';
// sha256(UTF-8 JSON.stringify([[relPath, rawSha256(bytes)], ...] sorted by UTF-16 code unit)). Raw basis, no EOL
// normalization. Computed in memory from the 42 pinned files; output pin = same with Maintenance replaced.
export const INPUT_PACKAGE_SHA256 = 'df1dbf9c89c890f83622032336d433c5610a2b1bf02f120af1646077e258c5c6';
export const OUTPUT_PACKAGE_SHA256 = 'c57e2ba8ba8af790a9a4bccbaa6fbcec9fa96baba5fe71a5d7c0bae171589be9';
export const MAINTENANCE_FILE = 'backend/Maintenance.gs';
export const HELPER_FILE = 'backend/Cutover.gs';
export const MAINTENANCE_INPUT_SHA256 = '8588ef94d63bb1dc17c698e0c7dbb6504686d8bcaf1a06fe01d16caa6db17906';
export const MAINTENANCE_OUTPUT_SHA256 = '1d46eadf071f6463137ee48387737588ee1d305d3948c3dd3b7958dfaeb21bec';
export const REMOVED_SPAN_SHA256 = '78dd352a2837deb9dfea6cbecbcc0e29558984b1d85dfc346fc66e0e08caa181';
export const REMOVED_SPAN_BYTES = 98;
export const RECEIPT_FILE = 'wrapper-removal.receipt.json';
export const STATUS = 'LOCAL_WRAPPER_REMOVAL_PREPARED';
export const WRAPPERS = Object.freeze([Object.freeze(['tmpRevoke', 'revokePublicSharing_']), Object.freeze(['tmpCheck', 'checkPublicSharing_'])]);
export const EXPECTED = Object.freeze({
  files: 42, gs: 12, html: 29, json: 1, crlf: 37, lf: 5, handlers: 40,
  before: Object.freeze({ publicFunctions: 45, guardedPublic: 43, privateFunctions: 71 }),
  after: Object.freeze({ publicFunctions: 43, guardedPublic: 43, privateFunctions: 71 }),
});
const HTML = ['CSS', 'Component_Header', 'Component_Loading', 'Component_LogoutModal', 'Component_Sidebar', 'Component_Toast', 'Index',
  'JS_Api', 'JS_App', 'JS_ArsipDokumen', 'JS_Auth', 'JS_DashboardAdmin', 'JS_LogAktivitas', 'JS_MasterDataPegawai', 'JS_Pengaturan',
  'JS_PengaturanSistem', 'JS_Router', 'JS_VerifikasiDokumen', 'View_ArsipDokumen', 'View_DashboardAdmin', 'View_DashboardPegawai',
  'View_ForceChangePassword', 'View_LogAktivitas', 'View_Login', 'View_MasterDataPegawai', 'View_Pengaturan', 'View_PengaturanSistem',
  'View_ProfilPegawai', 'View_VerifikasiDokumen'];
const GS = ['API', 'Admin', 'Auth', 'Backup', 'Cutover', 'Database', 'Dokumen', 'Main', 'Maintenance', 'Pegawai', 'Utils', 'WhatsApp'];
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const EXPECTED_PATHS = Object.freeze(['appsscript.json', ...GS.map((n) => `backend/${n}.gs`), ...HTML.map((n) => `frontend/${n}.html`)].sort(byCodeUnit));
const LIMITS = Object.freeze({ fileBytes: 512 * 1024, totalBytes: 4 * 1024 * 1024, bundleBytes: 2 * 1024 * 1024, nodes: 64, depth: 2 });
const FALSE_FLAGS = Object.freeze({
  readyForPush: false, deployAuthorized: false, pushConfigIncluded: false, remoteAuthorized: false, liveFreezeAuthorized: false,
  runtimeFrozenVerified: false, goLiveAuthorized: false, deployed: false, versionCreated: false, remoteOperations: false,
  googleIdentityVerified: false,
});
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8 = (text) => Buffer.from(text, 'utf8');
const WRAPPER_WORD = new RegExp(`(?<![A-Za-z0-9_$])(?:${WRAPPERS.map(([n]) => n).join('|')})(?![A-Za-z0-9_$])`);

// ---------------- Pure helpers ----------------
export function decodeStrict(bytes, code = 'ENCODING_INVALID') {
  check(bytes instanceof Uint8Array, code);
  check(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), code);
  let text;
  try { text = decoder.decode(bytes); } catch { throw new MigrationError(code); }
  check(utf8(text).equals(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)), code);
  return text;
}
// Per-file EOL: pure CRLF or pure LF (or no line break at all => 'LF'); bare CR or mixed fails closed.
export function eolOf(text) {
  check(typeof text === 'string', 'EOL_INVALID');
  const crlf = (text.match(/\r\n/g) ?? []).length, lf = (text.match(/\n/g) ?? []).length, cr = (text.match(/\r/g) ?? []).length;
  check(cr === crlf && (crlf === 0 || crlf === lf), 'EOL_MIXED');
  return crlf ? 'CRLF' : 'LF';
}
const eolText = (kind) => (kind === 'CRLF' ? '\r\n' : '\n');

// ASCII relative path, `/` separator, no traversal/absolute/drive/ADS/reserved/dot/trailing dot-space segments.
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(\..*)?$/i;
export function checkRelPath(rel) {
  check(typeof rel === 'string' && rel.length > 0 && rel.length <= 128 && /^[\x21-\x7e]+$/.test(rel), 'PATH_INVALID');
  const segs = rel.split('/');
  check(segs.length <= LIMITS.depth && segs.every((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) && !s.includes('..')
    && !/[. ]$/.test(s) && !RESERVED.test(s)), 'PATH_INVALID');
  return rel;
}
export function checkPathSet(paths) {
  check(Array.isArray(paths), 'INVENTORY_MISMATCH');
  paths.forEach(checkRelPath);
  const lower = new Set(paths.map((p) => p.toLowerCase()));
  check(lower.size === paths.length, 'PATH_CASE_COLLISION');
  const sorted = [...paths].sort(byCodeUnit);
  check(sorted.length === EXPECTED_PATHS.length && sorted.every((p, i) => p === EXPECTED_PATHS[i]), 'INVENTORY_MISMATCH');
  return sorted;
}
export const rawPairs = (files) => [...files].map(([p, bytes]) => [p, sha256(bytes)]).sort((a, b) => byCodeUnit(a[0], b[0]));
export const rawPackageSha256 = (files) => sha256(utf8(JSON.stringify(rawPairs(files))));

function parse(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  check(sf.parseDiagnostics.length === 0, 'PARSE_ERROR');
  return sf;
}
const unwrap = (n) => { while (n && ts.isParenthesizedExpression(n)) n = n.expression; return n; };
const isAssign = (n) => !!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
const isGlobalObj = (n) => !!n && (n.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(n) && n.text === 'globalThis'));
const globalTarget = (n) => { n = unwrap(n); return !!n && (ts.isIdentifier(n)
  || ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isGlobalObj(unwrap(n.expression)))); };
const isFirstGuard = (stmt) => {
  const call = stmt && ts.isExpressionStatement(stmt) ? stmt.expression : null;
  return !!call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === GUARD_NAME
    && call.arguments.length === 0 && !call.typeArguments && !call.questionDotToken;
};

// Pure AST over all .gs files with one shared global scope. Rejects any top-level way to expose a callable
// other than a plain function declaration (function/class values, aliases of declared functions, global
// property assignments), public duplicates, and any executable/string reference to the wrapper names.
export function analyzeGas(gsFiles) {
  check(gsFiles instanceof Map && gsFiles.size > 0, 'AST_INPUT_INVALID');
  const parsed = [...gsFiles].sort((a, b) => byCodeUnit(a[0], b[0])).map(([file, text]) => {
    check(/^backend\/[^/]+\.gs$/.test(file) && typeof text === 'string', 'AST_INPUT_INVALID');
    return { file, sf: parse(text, file) };
  });
  const decls = [];
  for (const { file, sf } of parsed) {
    for (const s of sf.statements) {
      check(!ts.isClassDeclaration(s) && !ts.isImportDeclaration(s) && !ts.isExportDeclaration(s) && !ts.isExportAssignment(s), 'TOPLEVEL_FUNCTION_VALUE');
      if (!ts.isFunctionDeclaration(s)) continue;
      check(s.name && s.body && !s.modifiers?.length && !s.asteriskToken, 'FUNCTION_INVALID');
      decls.push({ file, name: s.name.text, isPublic: !s.name.text.endsWith('_'), guarded: isFirstGuard(s.body.statements[0]), node: s });
    }
  }
  const fnNames = new Set(decls.map((d) => d.name));
  const fnValue = (node) => { let n = unwrap(node); while (isAssign(n)) n = unwrap(n.right);
    return !!n && (ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isClassExpression(n) || (ts.isIdentifier(n) && fnNames.has(n.text))); };
  for (const { sf } of parsed) {
    for (const s of sf.statements) {
      if (ts.isVariableStatement(s)) check(!s.declarationList.declarations.some((d) => fnValue(d.initializer)), 'TOPLEVEL_FUNCTION_VALUE');
      if (ts.isExpressionStatement(s)) {
        for (let n = unwrap(s.expression); isAssign(n); n = unwrap(n.right)) check(!(globalTarget(n.left) && fnValue(n.right)), 'TOPLEVEL_FUNCTION_VALUE');
      }
    }
    const visit = (n) => {
      // Shared global scope: a declared function name is never rebound anywhere; `globalThis` is never used.
      check(!(ts.isIdentifier(n) && n.text === 'globalThis'), 'GLOBAL_ALIAS');
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const left = unwrap(n.left);
        check(!(ts.isIdentifier(left) && fnNames.has(left.text)), 'FUNCTION_REASSIGNED');
      }
      if (ts.isIdentifier(n) && WRAPPER_WORD.test(n.text)) {
        check(ts.isFunctionDeclaration(n.parent) && n.parent.name === n && ts.isSourceFile(n.parent.parent), 'WRAPPER_REFERENCE');
      }
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
        && WRAPPER_WORD.test(n.text)) throw new MigrationError('WRAPPER_REFERENCE');
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const pub = decls.filter((d) => d.isPublic), priv = decls.filter((d) => !d.isPublic);
  check(new Set(pub.map((d) => d.name)).size === pub.length, 'PUBLIC_DUPLICATE');
  check(!priv.some((d) => d.guarded), 'PRIVATE_GUARD_UNEXPECTED');
  const unguarded = pub.filter((d) => !d.guarded);
  return Object.freeze({
    publicFunctions: pub.length, guardedPublic: pub.length - unguarded.length, privateFunctions: priv.length,
    unguardedPublic: Object.freeze(unguarded.map((d) => d.name).sort(byCodeUnit)),
    guardedNames: Object.freeze(pub.filter((d) => d.guarded).map((d) => d.name).sort(byCodeUnit)),
    wrapperDecls: Object.freeze(decls.filter((d) => WRAPPER_WORD.test(d.name)).map((d) => Object.freeze({ file: d.file, name: d.name }))),
  });
}
// Handler whitelist (single `var API_HANDLERS` in top-level doPost) via the reviewed v140 reader; explicit
// `.gs` -> `.js` key mapping only because that reader selects files by `.js` suffix. No text is changed.
export function guardedSetMatchesHandlers(gsFiles, guardedNames) {
  const handlers = handlerNames(new Map([...gsFiles].map(([k, v]) => [k.replace(/\.gs$/, '.js'), v])));
  const expected = new Set([...handlers, ...ENTRY_POINTS]);
  check(expected.size === handlers.length + ENTRY_POINTS.length && expected.size === guardedNames.length
    && guardedNames.every((n) => expected.has(n)), 'PUBLIC_SET_MISMATCH');
  return handlers.length;
}

// Pure byte patch. Input must contain exactly the two adjacent, unguarded, zero-param top-level wrapper
// declarations (each body = sole zero-arg call of its expected private helper), starting at a line start,
// separated by one EOL and followed by one blank line. Removes exactly `decl1 EOL decl2 EOL EOL` (98 bytes for
// the pinned LF file). Comments are never touched. The input buffer is never mutated; the result is verified by
// re-parse and by byte-exact inverse reinsertion. Offsets are byte offsets (TS positions are UTF-16).
export function patchMaintenanceBytes(input) {
  check(Buffer.isBuffer(input), 'MAINTENANCE_INVALID');
  const original = Buffer.from(input); // private copy; input untouched on any path
  const text = decodeStrict(original, 'MAINTENANCE_ENCODING');
  const eol = eolText(eolOf(text));
  const sf = parse(text, MAINTENANCE_FILE);
  const st = sf.statements;
  const idx = WRAPPERS.map(([name]) => st.findIndex((s) => ts.isFunctionDeclaration(s) && s.name?.text === name));
  check(idx[0] >= 0 && idx[1] === idx[0] + 1, 'WRAPPER_SHAPE');
  check(st.filter((s) => ts.isFunctionDeclaration(s) && WRAPPER_WORD.test(s.name?.text ?? '')).length === 2, 'WRAPPER_DUPLICATE');
  const nodes = idx.map((i) => st[i]);
  nodes.forEach((n, k) => {
    const body = n.body?.statements ?? [], call = body[0] && ts.isExpressionStatement(body[0]) ? body[0].expression : null;
    check(!n.modifiers?.length && !n.asteriskToken && n.parameters.length === 0 && body.length === 1 && !isFirstGuard(body[0])
      && call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === WRAPPERS[k][1]
      && call.arguments.length === 0 && !call.typeArguments && !call.questionDotToken, 'WRAPPER_SHAPE');
  });
  const [a, d] = nodes, start = a.getStart(sf), sep = text.slice(a.end, d.getStart(sf));
  check(start === 0 || text.slice(start - eol.length, start) === eol, 'WRAPPER_SPAN');
  check(sep === eol && text.slice(d.end, d.end + 2 * eol.length) === eol + eol, 'WRAPPER_SPAN');
  const end = d.end + 2 * eol.length;
  const removedText = text.slice(start, end);
  check(removedText === `${a.getText(sf)}${eol}${d.getText(sf)}${eol}${eol}`, 'WRAPPER_SPAN');
  const byteStart = Buffer.byteLength(text.slice(0, start), 'utf8'), byteLength = Buffer.byteLength(removedText, 'utf8');
  const removed = original.subarray(byteStart, byteStart + byteLength);
  check(removed.every((b) => b < 0x80) && removed.toString('latin1') === removedText, 'WRAPPER_SPAN');
  const rsf = parse(removedText, 'removed.js');
  check(rsf.statements.length === 2 && rsf.statements.every((s, k) => ts.isFunctionDeclaration(s) && s.name?.text === WRAPPERS[k][0]), 'WRAPPER_SPAN');
  const bytes = Buffer.concat([original.subarray(0, byteStart), original.subarray(byteStart + byteLength)]);
  const out = decodeStrict(bytes, 'MAINTENANCE_ENCODING');
  check(eolText(eolOf(out)) === eol, 'EOL_MIXED');
  const osf = parse(out, MAINTENANCE_FILE);
  check(osf.statements.length === st.length - 2 && !osf.statements.some((s) => ts.isFunctionDeclaration(s) && WRAPPER_WORD.test(s.name?.text ?? '')), 'WRAPPER_SPAN');
  check(restoreMaintenanceBytes(bytes, removed, byteStart).equals(original), 'INVERSE_MISMATCH');
  return Object.freeze({ bytes, removedByteOffset: byteStart, removedByteLength: byteLength, removedSha256: sha256(removed), eol: eolOf(text) });
}
// Pure inverse: reinsert the removed bytes at the byte offset.
export function restoreMaintenanceBytes(patched, removed, offset) {
  check(Buffer.isBuffer(patched) && Buffer.isBuffer(removed) && Number.isInteger(offset) && offset >= 0 && offset <= patched.length, 'INVERSE_INVALID');
  return Buffer.concat([patched.subarray(0, offset), removed, patched.subarray(offset)]);
}

// Pure full-package transform against the PRODUCTION pins (fixtures cannot pass; no pin parameters).
export function preparePinnedPackage(input) {
  check(input instanceof Map, 'INVENTORY_MISMATCH');
  checkPathSet([...input.keys()]);
  check([...input.values()].every((b) => Buffer.isBuffer(b)), 'INVENTORY_MISMATCH');
  check(rawPackageSha256(input) === INPUT_PACKAGE_SHA256, 'INPUT_PACKAGE_MISMATCH');
  const texts = new Map(), eols = { CRLF: 0, LF: 0 };
  for (const [p, b] of input) { const t = decodeStrict(b); eols[eolOf(t)]++; texts.set(p, t); }
  check(eols.CRLF === EXPECTED.crlf && eols.LF === EXPECTED.lf, 'EOL_COUNT_MISMATCH');
  verifyHelper(input.get(HELPER_FILE)); // raw pin 83171e00..., sole private assertCutoverOpen_ declaration
  for (const [p, t] of texts) if (!p.endsWith('.gs')) check(!WRAPPER_WORD.test(t), 'WRAPPER_REFERENCE'); // HTML RPC / manifest
  const gs = (m) => new Map([...m].filter(([p]) => p.endsWith('.gs')));
  const before = analyzeGas(gs(texts));
  check(before.publicFunctions === EXPECTED.before.publicFunctions && before.guardedPublic === EXPECTED.before.guardedPublic
    && before.privateFunctions === EXPECTED.before.privateFunctions, 'AST_COUNT_MISMATCH');
  check(JSON.stringify(before.unguardedPublic) === JSON.stringify(WRAPPERS.map(([n]) => n).sort(byCodeUnit))
    && before.wrapperDecls.length === 2 && before.wrapperDecls.every((d) => d.file === MAINTENANCE_FILE), 'UNGUARDED_SET_MISMATCH');
  check(guardedSetMatchesHandlers(gs(texts), before.guardedNames) === EXPECTED.handlers, 'HANDLER_COUNT_MISMATCH');

  const m = input.get(MAINTENANCE_FILE);
  check(sha256(m) === MAINTENANCE_INPUT_SHA256, 'MAINTENANCE_INPUT_MISMATCH');
  const patch = patchMaintenanceBytes(m);
  check(patch.removedByteLength === REMOVED_SPAN_BYTES && patch.removedSha256 === REMOVED_SPAN_SHA256, 'REMOVED_SPAN_MISMATCH');
  check(sha256(patch.bytes) === MAINTENANCE_OUTPUT_SHA256, 'MAINTENANCE_OUTPUT_MISMATCH');
  const output = new Map([...input].map(([p, b]) => [p, p === MAINTENANCE_FILE ? patch.bytes : b]));
  const outTexts = new Map([...output].map(([p, b]) => [p, decodeStrict(b)]));
  const after = analyzeGas(gs(outTexts));
  check(after.publicFunctions === EXPECTED.after.publicFunctions && after.guardedPublic === EXPECTED.after.guardedPublic
    && after.privateFunctions === EXPECTED.after.privateFunctions && after.unguardedPublic.length === 0 && after.wrapperDecls.length === 0, 'AST_COUNT_MISMATCH');
  check(guardedSetMatchesHandlers(gs(outTexts), after.guardedNames) === EXPECTED.handlers, 'HANDLER_COUNT_MISMATCH');
  check(JSON.stringify(after.guardedNames) === JSON.stringify(before.guardedNames), 'PUBLIC_SET_MISMATCH');
  const changed = [...output].filter(([p, b]) => !b.equals(input.get(p))).map(([p]) => p);
  check(changed.length === 1 && changed[0] === MAINTENANCE_FILE, 'UNEXPECTED_CHANGE');
  check(rawPackageSha256(output) === OUTPUT_PACKAGE_SHA256, 'OUTPUT_PACKAGE_MISMATCH');
  const counts = Object.freeze({
    inputFiles: input.size, outputSourceFiles: output.size, outputFiles: output.size + 1, changedFiles: 1, unchangedFiles: output.size - 1,
    gs: EXPECTED.gs, html: EXPECTED.html, json: EXPECTED.json, eolCrlf: eols.CRLF, eolLf: eols.LF, handlers: EXPECTED.handlers,
    before: Object.freeze({ publicFunctions: before.publicFunctions, guardedPublic: before.guardedPublic, privateFunctions: before.privateFunctions, unguardedPublic: before.unguardedPublic.length }),
    after: Object.freeze({ publicFunctions: after.publicFunctions, guardedPublic: after.guardedPublic, privateFunctions: after.privateFunctions, unguardedPublic: 0 }),
    removedBytes: patch.removedByteLength,
  });
  return Object.freeze({ output, counts, inputPairs: rawPairs(input), outputPairs: rawPairs(output) });
}

export function buildReceipt(prepared) {
  const { counts, inputPairs, outputPairs } = prepared;
  return utf8(`${JSON.stringify({
    kind: 'sikap-gas-v141-wrapper-removal', receiptVersion: 1, version: VERSION, status: STATUS,
    provenance: 'LOCAL_PINNED', googleProvenance: 'ATTESTED',
    inputBundleSha256: BUNDLE_SHA256, inputBundleBytes: BUNDLE_BYTES,
    packageBasis: 'sha256(UTF-8 JSON.stringify([[relPath, sha256(raw bytes)]...] sorted by UTF-16 code unit)); raw bytes, no EOL normalization',
    inputPackageSha256: INPUT_PACKAGE_SHA256, outputPackageSha256: OUTPUT_PACKAGE_SHA256,
    inputRawFiles: inputPairs, outputRawFiles: outputPairs, changedFiles: [MAINTENANCE_FILE],
    maintenance: { inputSha256: MAINTENANCE_INPUT_SHA256, outputSha256: MAINTENANCE_OUTPUT_SHA256, removedBytes: REMOVED_SPAN_BYTES,
      removedSpanSha256: REMOVED_SPAN_SHA256, removed: 'two unguarded public wrapper declarations + one separator EOL + one blank line', commentsPreserved: true,
      inverseByteExact: true, eol: 'LF' },
    helperFile: HELPER_FILE, helperSha256: HELPER_SHA256, counts,
    lineEndings: 'preserved-per-file (raw bytes copied verbatim)', manifestIncluded: true, manifestUnchanged: true,
    scope: 'local file transform only; not uploaded, versioned or deployed', ...FALSE_FLAGS,
  }, null, 2)}\n`);
}

// ---------------- Filesystem (CLI) path ----------------
async function verifyPrivate(target, code, { exactMode } = {}) {
  let stat;
  try { stat = await lstat(target); } catch { throw new MigrationError(code); }
  check(stat.isDirectory() && !stat.isSymbolicLink(), code);
  if (process.platform === 'win32') {
    try { await verifyPrivatePersistence(target); } catch { throw new MigrationError(code); } // read-only ACL check
  } else {
    check(stat.uid === process.getuid() && (exactMode === undefined ? (stat.mode & 0o077) === 0 : (stat.mode & 0o777) === exactMode), code);
  }
}
// realpath must resolve to the requested path itself (case-insensitive on win32): no link/junction/8.3 alias.
const sameReal = (real, requested) => canonicalPath(real) === canonicalPath(requested);
// Reads one regular file exactly once: no link/reparse alias, nlink 1, handle identity (dev/ino/size) equal to
// the pre-open lstat, bounded size.
export async function readRegularFileOnce(abs, maxBytes, code = 'SOURCE_ENTRY_INVALID') {
  check(typeof abs === 'string' && path.isAbsolute(abs) && Number.isInteger(maxBytes) && maxBytes > 0, code);
  let st;
  try { st = await lstat(abs, { bigint: true }); } catch { throw new MigrationError(code); }
  check(!st.isSymbolicLink() && st.isFile() && st.nlink === 1n && st.size <= BigInt(maxBytes), code);
  let real;
  try { real = await realpath(abs); } catch { throw new MigrationError(code); }
  check(sameReal(real, abs), code);
  let handle;
  try { handle = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw new MigrationError(code); }
  try {
    const fst = await handle.stat({ bigint: true });
    check(fst.isFile() && fst.nlink === 1n && fst.dev === st.dev && fst.ino === st.ino && fst.size === st.size, code);
    let bytes;
    try { bytes = await readBoundedHandle(handle, maxBytes); } catch { throw new MigrationError(code); }
    check(BigInt(bytes.length) === st.size, code);
    return bytes;
  } finally { await handle.close(); }
}
async function listDir(abs, code) {
  let st;
  try { st = await lstat(abs); } catch { throw new MigrationError(code); }
  check(st.isDirectory() && !st.isSymbolicLink(), code);
  try { check(sameReal(await realpath(abs), abs), code); return (await readdir(abs)).sort(byCodeUnit); }
  catch { throw new MigrationError(code); }
}

// Reads the fixed private source. Bundle hashed before parse; 42 files read once each and compared 1:1 with
// the bundle payloads. Returns raw Buffers only.
async function readPinnedSource() {
  try { await noLinks(SOURCE_ROOT); } catch { throw new MigrationError('SOURCE_LINK'); }
  await verifyPrivate(SOURCE_ROOT, 'SOURCE_PERMISSIONS');
  const filesDir = path.join(SOURCE_ROOT, SOURCE_FILES_DIR);
  await verifyPrivate(filesDir, 'SOURCE_PERMISSIONS');
  const bundleBytes = await readRegularFileOnce(path.join(SOURCE_ROOT, BUNDLE_FILE), LIMITS.bundleBytes, 'BUNDLE_INVALID');
  check(bundleBytes.length === BUNDLE_BYTES && sha256(bundleBytes) === BUNDLE_SHA256, 'BUNDLE_HASH_MISMATCH');
  let bundle;
  try { bundle = JSON.parse(decodeStrict(bundleBytes, 'BUNDLE_INVALID')); } catch { throw new MigrationError('BUNDLE_INVALID'); }
  check(bundle && typeof bundle === 'object' && !Array.isArray(bundle) && bundle.gasVersion === VERSION && Array.isArray(bundle.files)
    && bundle.files.length === EXPECTED.files, 'BUNDLE_INVALID');
  const payload = new Map();
  for (const f of bundle.files) {
    check(f && typeof f === 'object' && Object.getPrototypeOf(f) === Object.prototype && Object.keys(f).sort().join() === 'content,eol,name'
      && typeof f.name === 'string' && typeof f.content === 'string' && (f.eol === 'LF' || f.eol === 'CRLF'), 'BUNDLE_INVALID');
    checkRelPath(f.name);
    check(!payload.has(f.name), 'BUNDLE_INVALID');
    check(eolOf(f.content) === f.eol, 'BUNDLE_EOL_MISMATCH');
    payload.set(f.name, utf8(f.content));
  }
  checkPathSet([...payload.keys()]);

  // Tree walk with caps: exact expected names only, no dot/extra entries, directories never links.
  const files = new Map(), dirs = new Set(EXPECTED_PATHS.filter((p) => p.includes('/')).map((p) => p.split('/')[0]));
  let nodes = 0, total = 0;
  for (const name of await listDir(filesDir, 'SOURCE_INVENTORY')) {
    check(++nodes <= LIMITS.nodes, 'SOURCE_LIMIT');
    checkRelPath(name);
    const abs = path.join(filesDir, name);
    if (dirs.has(name)) {
      for (const child of await listDir(abs, 'SOURCE_INVENTORY')) {
        check(++nodes <= LIMITS.nodes, 'SOURCE_LIMIT');
        const rel = checkRelPath(`${name}/${child}`);
        check(EXPECTED_PATHS.includes(rel), 'SOURCE_INVENTORY');
        files.set(rel, await readRegularFileOnce(path.join(abs, child), LIMITS.fileBytes));
        total += files.get(rel).length; check(total <= LIMITS.totalBytes, 'SOURCE_LIMIT');
      }
    } else {
      check(EXPECTED_PATHS.includes(name), 'SOURCE_INVENTORY');
      files.set(name, await readRegularFileOnce(abs, LIMITS.fileBytes));
      total += files.get(name).length; check(total <= LIMITS.totalBytes, 'SOURCE_LIMIT');
    }
  }
  checkPathSet([...files.keys()]);
  for (const [p, b] of files) check(payload.get(p).equals(b), 'BUNDLE_CONTENT_MISMATCH');
  return files;
}

const outside = (base, target) => {
  const rel = path.relative(canonicalPath(path.resolve(base)), canonicalPath(target));
  const back = path.relative(canonicalPath(target), canonicalPath(path.resolve(base)));
  const out = (r) => r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
  return rel !== '' && out(rel) && out(back); // neither inside nor an ancestor
};
const EXCLUDED_BASES = () => [ROOT, process.cwd(), SOURCE_ROOT, V140_BASELINE_PATH];
// Absolute normalized, no UNC/device/ADS/8.3 `~`/reserved names; lexical exclusion before any I/O; parent must
// exist and resolve to itself (no link/junction/short-name aliasing).
export async function outputPath(out) {
  check(typeof out === 'string' && out.length < 200 && path.isAbsolute(out) && path.resolve(out) === out, 'OUT_ABSOLUTE_REQUIRED');
  check(!/^[\\/]{2}/.test(out) && !out.includes('\0'), 'OUT_PATH_INVALID');
  const { root } = path.parse(out), segments = out.slice(root.length).split(path.sep);
  check(process.platform !== 'win32' || /^[A-Za-z]:\\$/.test(root), 'OUT_PATH_INVALID');
  check(segments.length >= 1 && segments.every((s) => s && s !== '.' && s !== '..' && !s.includes('~') && !/[<>:"|?*/\\]/.test(s)
    && ![...s].some((c) => c.charCodeAt(0) < 0x20) && !/[. ]$/.test(s) && !RESERVED.test(s)), 'OUT_PATH_INVALID');
  for (const base of EXCLUDED_BASES()) check(outside(base, out), 'OUT_PATH_INVALID');
  let target;
  try { target = await persistencePath(out); } catch { throw new MigrationError('OUT_PATH_INVALID'); }
  const parent = path.dirname(target);
  let real;
  try { real = await realpath(parent); } catch (error) { throw new MigrationError(error?.code === 'ENOENT' ? 'PARENT_MISSING' : 'OUT_PATH_INVALID'); }
  check(canonicalPath(real) === canonicalPath(parent), 'OUT_PATH_INVALID');
  for (const base of EXCLUDED_BASES()) check(outside(base, real) && outside(base, target), 'OUT_PATH_INVALID');
  return target;
}
const exists = async (target) => {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw new MigrationError('OUT_PATH_INVALID'); }
};
async function writeNew(file, bytes) {
  const handle = await open(file, 'wx', 0o600); // exclusive create: never overwrites
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  check((await readRegularFileOnce(file, LIMITS.fileBytes, 'OUTPUT_VERIFY_FAILED')).equals(bytes), 'OUTPUT_VERIFY_FAILED');
}
// Write engine (no source access, no pins): creates `target` (must not exist) under a private parent, private
// subdirectories, every file wx + readback, receipt last. Partial output is left in place on failure.
export async function writeOutputTree(target, outputs, receipt) {
  check(typeof target === 'string' && outputs instanceof Map && Buffer.isBuffer(receipt), 'OUTPUT_INVALID');
  for (const [p, b] of outputs) { checkRelPath(p); check(Buffer.isBuffer(b) && p !== RECEIPT_FILE, 'OUTPUT_INVALID'); }
  const parent = path.dirname(target);
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  await verifyPrivate(parent, 'PARENT_PERMISSIONS');
  try { await mkdir(target, { mode: 0o700 }); } // non-recursive
  catch (error) { throw new MigrationError(error?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_CREATE_FAILED'); }
  await noLinks(target);
  check(canonicalPath(await realpath(target)) === canonicalPath(target), 'OUT_PATH_INVALID');
  await verifyPrivate(target, 'OUTPUT_PERMISSIONS', { exactMode: 0o700 });
  const sub = [...new Set([...outputs.keys()].filter((p) => p.includes('/')).map((p) => p.split('/')[0]))].sort(byCodeUnit);
  for (const d of sub) {
    const abs = path.join(target, d);
    try { await mkdir(abs, { mode: 0o700 }); } catch { throw new MigrationError('OUTPUT_CREATE_FAILED'); }
    await verifyPrivate(abs, 'OUTPUT_PERMISSIONS', { exactMode: 0o700 });
  }
  for (const [p, b] of [...outputs].sort((a, b) => byCodeUnit(a[0], b[0]))) await writeNew(path.join(target, ...p.split('/')), b);
  await writeNew(path.join(target, RECEIPT_FILE), receipt); // receipt last
  return sha256(receipt);
}

// Only production entry point. Accepts exactly one own plain data property {out}; nothing else is overridable.
export async function buildWrapperRemoval(options) {
  check(!!options && typeof options === 'object' && !isProxy(options) && Object.getPrototypeOf(options) === Object.prototype, 'OPTIONS_INVALID');
  const keys = Reflect.ownKeys(options), desc = keys.length === 1 && keys[0] === 'out' ? Object.getOwnPropertyDescriptor(options, 'out') : null;
  check(!!desc && Object.hasOwn(desc, 'value'), 'OPTIONS_INVALID');
  const out = desc.value;
  check(typeof out === 'string', 'OUT_ABSOLUTE_REQUIRED');
  const target = await outputPath(out);
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  await verifyPrivate(path.dirname(target), 'PARENT_PERMISSIONS'); // before any private source access

  const prepared = preparePinnedPackage(await readPinnedSource());
  const receipt = buildReceipt(prepared);
  const receiptSha256 = await writeOutputTree(target, prepared.output, receipt);
  const names = [...(await readdir(target))].sort(byCodeUnit);
  check(names.join() === [...new Set([RECEIPT_FILE, ...EXPECTED_PATHS.map((p) => p.split('/')[0])])].sort(byCodeUnit).join(), 'OUTPUT_VERIFY_FAILED');
  return Object.freeze({
    code: STATUS, inputBundleSha256: BUNDLE_SHA256, inputPackageSha256: INPUT_PACKAGE_SHA256, outputPackageSha256: OUTPUT_PACKAGE_SHA256,
    maintenanceInputSha256: MAINTENANCE_INPUT_SHA256, maintenanceOutputSha256: MAINTENANCE_OUTPUT_SHA256,
    removedSpanSha256: REMOVED_SPAN_SHA256, helperSha256: HELPER_SHA256, receiptSha256, counts: prepared.counts,
  });
}

export function parseArgs(argv) {
  check(Array.isArray(argv) && argv.length === 2 && argv[0] === '--out' && typeof argv[1] === 'string' && !argv[1].startsWith('-'), 'CLI_ARGUMENTS');
  check(path.isAbsolute(argv[1]) && path.resolve(argv[1]) === argv[1], 'OUT_ABSOLUTE_REQUIRED');
  return { out: argv[1] };
}

if (isMain(import.meta.url)) {
  // stdout: code, hashes and counts only (no paths, offsets, source or raw errors).
  const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { print({ ok: false, code: safeCode(error) }); process.exitCode = 2; }
  if (args) {
    try { print({ ok: true, ...(await buildWrapperRemoval(args)) }); }
    catch (error) { print({ ok: false, code: safeCode(error) }); process.exitCode = 1; }
  }
}
