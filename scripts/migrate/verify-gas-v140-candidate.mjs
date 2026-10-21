import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { ROOT, inspectPersistTree, verifyPrivatePersistence } from './local-store.mjs';
import {
  BASELINE_PACKAGE_SHA256,
  BASELINE_PATH,
  EXPECTED,
  HELPER_FILE,
  HELPER_SHA256,
  RECEIPT_FILE,
  unpatchSource,
} from './prepare-gas-v140.mjs';

export { BASELINE_PACKAGE_SHA256, HELPER_FILE, HELPER_SHA256, RECEIPT_FILE };
export const CUTOVER_HELPER_SHA256 = HELPER_SHA256;
export const DEFAULT_BASELINE_DIR = BASELINE_PATH;
export const EXPECTED_PUBLIC_ENTRIES = EXPECTED.publicFunctions;
export const EXPECTED_BASELINE_FUNCTIONS = EXPECTED.functions;
export const EXPECTED_CANDIDATE_FUNCTIONS = EXPECTED.functions + 1;

const GUARD = 'assertCutoverOpen_';
const GOOGLE = [
  'SpreadsheetApp', 'DriveApp', 'UrlFetchApp', 'Utilities', 'HtmlService', 'ContentService',
  'Logger', 'LockService', 'CacheService', 'Session', 'MailApp', 'GmailApp', 'ScriptApp',
  'DocumentApp', 'CalendarApp', 'FormApp', 'SitesApp', 'Browser',
];

const ALLOWED_ERROR_CODES = new Set([
  'CLI_ARGUMENTS', 'CANDIDATE_PATH_REQUIRED', 'CANDIDATE_PATH_INVALID', 'CANDIDATE_PATH_DISALLOWED_PREFIX',
  'CANDIDATE_PATH_INSIDE_REPO', 'CANDIDATE_PATH_ALIAS', 'DOTFILE_DISALLOWED', 'NON_REGULAR_FILE_DISALLOWED',
  'SNAPSHOT_FILE_COUNT_LIMIT', 'SNAPSHOT_FILE_SIZE_LIMIT', 'SNAPSHOT_TOTAL_SIZE_LIMIT', 'BOM_DISALLOWED',
  'UTF8_DECODING_FAILED', 'CUTOVER_HELPER_MISSING', 'CUTOVER_HELPER_HASH_MISMATCH',
  'CUTOVER_HELPER_DECLARATION_INVALID', 'FILE_COUNT_MISMATCH', 'AST_BASELINE_DECL_MISMATCH',
  'AST_CANDIDATE_DECL_MISMATCH', 'PUBLIC_ENTRY_COUNT_MISMATCH', 'PUBLIC_NAMES_NOT_UNIQUE',
  'PRIVATE_FUNCTION_COUNT_MISMATCH', 'PUBLIC_GUARD_MISSING', 'PRIVATE_GUARD_UNEXPECTED',
  'UNPATCH_RESIDUAL_GUARD', 'UNPATCHED_BYTE_MISMATCH', 'BASELINE_HASH_MISMATCH',
  'NO_PUBLIC_ENTRIES_FOUND', 'VM_FROZEN_FAILED', 'VM_INVALID_STATE_FAILED',
  'VM_SERVICE_UNAVAILABLE_FAILED', 'VM_HELPER_CACHE_DETECTED', 'VM_GATE_LEAK', 'VERIFICATION_FAILED',
  'RECEIPT_FILE_MISSING', 'CANDIDATE_INVENTORY_INVALID',
]);

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function computePackageSha256(files) {
  const pairs = Object.entries(files).map(([rel, content]) => {
    const text = typeof content === 'string' ? content : content.toString('utf8');
    const digest = createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
    return [rel.replace(/\\/g, '/'), digest];
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

export async function assertSafeCandidateDir(target) {
  if (typeof target !== 'string') throw new Error('CANDIDATE_PATH_INVALID');
  // Disallowed prefixes first so Windows-style device/UNC/8.3 paths get the same specific error on every platform
  // (path.isAbsolute is false for them on POSIX).
  if (target.startsWith('\\\\?\\') || target.startsWith('\\\\.\\') || target.startsWith('\\\\') || target.startsWith('//') || target.includes('~')) {
    throw new Error('CANDIDATE_PATH_DISALLOWED_PREFIX');
  }
  if (!path.isAbsolute(target)) throw new Error('CANDIDATE_PATH_INVALID');
  const resolved = path.resolve(target);
  const rootCan = process.platform === 'win32' ? ROOT.toLowerCase() : ROOT;
  const targetCan = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const rel = path.relative(rootCan, targetCan);
  if (!(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) throw new Error('CANDIDATE_PATH_INSIDE_REPO');
  const real = await realpath(resolved);
  if (path.resolve(real).toLowerCase() !== resolved.toLowerCase()) throw new Error('CANDIDATE_PATH_ALIAS');
  const realCan = process.platform === 'win32' ? real.toLowerCase() : real;
  const relReal = path.relative(rootCan, realCan);
  if (!(relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal))) throw new Error('CANDIDATE_PATH_INSIDE_REPO');
  await verifyPrivatePersistence(resolved);
  await inspectPersistTree(resolved, { maxNodes: 100, maxBytes: 10 * 1024 * 1024 });
  return resolved;
}

export async function readSnapshotFiles(dir, { isBaseline = false } = {}) {
  const map = {};
  let totalBytes = 0;
  let fileCount = 0;

  async function walk(currentDir) {
    const entries = await readdir(currentDir);
    for (const name of entries) {
      if (name.startsWith('.')) {
        if (isBaseline && currentDir === dir && name === '.clasp.json') continue;
        throw new Error('DOTFILE_DISALLOWED');
      }
      const full = path.join(currentDir, name);
      const st = await lstat(full);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
        throw new Error('NON_REGULAR_FILE_DISALLOWED');
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        fileCount++;
        if (fileCount > 100) throw new Error('SNAPSHOT_FILE_COUNT_LIMIT');
        if (st.size > 2 * 1024 * 1024) throw new Error('SNAPSHOT_FILE_SIZE_LIMIT');
        totalBytes += st.size;
        if (totalBytes > 10 * 1024 * 1024) throw new Error('SNAPSHOT_TOTAL_SIZE_LIMIT');
        const buf = await readFile(full);
        if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
          throw new Error('BOM_DISALLOWED');
        }
        let text;
        try {
          text = utf8Decoder.decode(buf);
        } catch {
          throw new Error('UTF8_DECODING_FAILED');
        }
        map[path.relative(dir, full).replace(/\\/g, '/')] = text;
      }
    }
  }

  await walk(dir);
  return map;
}

function makeHostile(counters) {
  const trap = () => { counters.hostile++; throw new Error('HOSTILE_ARG_TOUCHED'); };
  return new Proxy(function hostile() {}, {
    get: trap, set: trap, has: trap, apply: trap, construct: trap, ownKeys: trap,
    getOwnPropertyDescriptor: trap, defineProperty: trap, deleteProperty: trap,
  });
}

export function parseAst(filename, source) {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const decls = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const name = stmt.name.text;
      let firstGuard = false;
      if (stmt.body && stmt.body.statements && stmt.body.statements.length > 0) {
        const first = stmt.body.statements[0];
        if (ts.isExpressionStatement(first) && ts.isCallExpression(first.expression)) {
          const expr = first.expression;
          if (ts.isIdentifier(expr.expression) && expr.expression.text === GUARD && expr.arguments.length === 0) {
            firstGuard = true;
          }
        }
      }
      decls.push({ file: filename, name, isPrivate: name.endsWith('_'), firstGuard });
    }
  }
  return decls;
}

export function runCandidateVmChecks(backendSources) {
  const allDecls = [];
  for (const [file, src] of Object.entries(backendSources)) {
    allDecls.push(...parseAst(file, src));
  }
  const publicNames = [...new Set(allDecls.filter((d) => !d.isPrivate).map((d) => d.name))];
  if (publicNames.length === 0) throw new Error('NO_PUBLIC_ENTRIES_FOUND');

  const counters = { google: 0, hostile: 0, propReads: 0, jsonParse: 0, propOther: 0, console: 0 };
  let cutoverState = 'frozen';
  let propsFails = false;

  const sandbox = Object.create(null);

  Object.defineProperty(sandbox, 'console', {
    configurable: true,
    get() { counters.console++; throw new Error('CONSOLE_ACCESS_FORBIDDEN'); },
    set() { counters.console++; throw new Error('CONSOLE_MUTATION_FORBIDDEN'); },
  });

  for (const g of GOOGLE) {
    Object.defineProperty(sandbox, g, {
      configurable: true,
      get() { counters.google++; throw new Error('GOOGLE_ACCESS_FORBIDDEN_' + g); },
      set() { counters.google++; throw new Error('GOOGLE_MUTATION_FORBIDDEN_' + g); },
    });
  }

  const store = {
    getProperty(k) {
      counters.propReads++;
      if (propsFails) throw new Error('PROPERTIES_SERVICE_ERROR');
      return k === 'SIKAP_CUTOVER_STATE' ? cutoverState : null;
    },
  };
  Object.defineProperty(sandbox, 'PropertiesService', {
    configurable: true,
    get() {
      return {
        getScriptProperties: () => new Proxy(store, {
          get(t, p) {
            if (p === 'getProperty') return t.getProperty;
            counters.propOther++;
            throw new Error('PROPERTY_METHOD_FORBIDDEN');
          },
        }),
      };
    },
  });

  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  for (const [file, src] of Object.entries(backendSources)) {
    vm.runInContext(src, ctx, { filename: file, timeout: 1000 });
  }

  ctx.__countParse = () => { counters.jsonParse++; };
  vm.runInContext('(function(orig){ JSON.parse = function(){ __countParse(); return orig.apply(JSON, arguments); }; })(JSON.parse)', ctx);

  const hostileArg = makeHostile(counters);
  ctx.__hostileArg = hostileArg;

  let casesPassed = 0;

  cutoverState = 'frozen';
  propsFails = false;
  for (const name of publicNames) {
    counters.google = 0; counters.hostile = 0; counters.propReads = 0; counters.jsonParse = 0; counters.console = 0;
    let caught = null;
    try {
      vm.runInContext(`globalThis['${name}'](__hostileArg, __hostileArg, __hostileArg)`, ctx, { timeout: 100 });
    } catch (e) {
      caught = e;
    }
    if (counters.hostile !== 0 || counters.google !== 0 || counters.jsonParse !== 0 || counters.console !== 0) {
      throw new Error('VM_GATE_LEAK');
    }
    if (!caught || caught.message !== 'SIKAP_CUTOVER_FROZEN') throw new Error('VM_FROZEN_FAILED');
    if (counters.propReads !== 1) {
      throw new Error('VM_GATE_LEAK');
    }
    casesPassed++;
  }

  cutoverState = 'invalid_state';
  propsFails = false;
  for (const name of publicNames) {
    counters.google = 0; counters.hostile = 0; counters.propReads = 0; counters.jsonParse = 0; counters.console = 0;
    let caughtInvalid = null;
    try {
      vm.runInContext(`globalThis['${name}'](__hostileArg)`, ctx, { timeout: 100 });
    } catch (e) {
      caughtInvalid = e;
    }
    if (counters.hostile !== 0 || counters.google !== 0 || counters.jsonParse !== 0 || counters.console !== 0) {
      throw new Error('VM_GATE_LEAK');
    }
    if (!caughtInvalid || caughtInvalid.message !== 'SIKAP_CUTOVER_STATE_INVALID') throw new Error('VM_INVALID_STATE_FAILED');
    if (counters.propReads !== 1) {
      throw new Error('VM_GATE_LEAK');
    }
    casesPassed++;
  }

  cutoverState = 'frozen';
  propsFails = true;
  for (const name of publicNames) {
    counters.google = 0; counters.hostile = 0; counters.propReads = 0; counters.jsonParse = 0; counters.console = 0;
    let caughtService = null;
    try {
      vm.runInContext(`globalThis['${name}'](__hostileArg)`, ctx, { timeout: 100 });
    } catch (e) {
      caughtService = e;
    }
    if (counters.hostile !== 0 || counters.google !== 0 || counters.jsonParse !== 0 || counters.console !== 0) {
      throw new Error('VM_GATE_LEAK');
    }
    if (!caughtService || caughtService.message !== 'SIKAP_CUTOVER_STATE_UNAVAILABLE') throw new Error('VM_SERVICE_UNAVAILABLE_FAILED');
    casesPassed++;
  }
  propsFails = false;

  counters.google = 0; counters.hostile = 0; counters.propReads = 0; counters.jsonParse = 0; counters.console = 0;
  cutoverState = 'open';
  vm.runInContext('assertCutoverOpen_()', ctx, { timeout: 100 });
  cutoverState = 'frozen';
  let caughtHelper = null;
  try {
    vm.runInContext('assertCutoverOpen_()', ctx, { timeout: 100 });
  } catch (e) {
    caughtHelper = e;
  }
  if (!caughtHelper || caughtHelper.message !== 'SIKAP_CUTOVER_FROZEN') throw new Error('VM_HELPER_CACHE_DETECTED');
  cutoverState = 'open';
  vm.runInContext('assertCutoverOpen_()', ctx, { timeout: 100 });
  casesPassed++;

  return {
    status: 'VM_CHECKS_PASSED',
    publicEntries: publicNames.length,
    casesPassed,
    casesTotal: casesPassed,
    guardPropertyReads: 1,
    runtimeFrozenVerified: false,
    deploymentAuthorized: false,
    authorizesExecution: false,
    remoteAuthorized: false,
    goLiveAuthorized: false,
  };
}

export const verifyVmSources = runCandidateVmChecks;

export function verifySourceSnapshot({ candidateFiles, baselineFiles }) {
  if (!baselineFiles || typeof baselineFiles !== 'object') throw new Error('BASELINE_HASH_MISMATCH');

  for (const name of Object.keys(candidateFiles)) {
    if (path.basename(name).startsWith('.')) throw new Error('DOTFILE_DISALLOWED');
  }

  const helperKey = HELPER_FILE;
  if (!Object.hasOwn(candidateFiles, helperKey)) throw new Error('CUTOVER_HELPER_MISSING');

  const helperHash = createHash('sha256').update(candidateFiles[helperKey], 'utf8').digest('hex');
  if (helperHash !== HELPER_SHA256) throw new Error('CUTOVER_HELPER_HASH_MISMATCH');

  const sourceFiles = {};
  for (const [rel, src] of Object.entries(candidateFiles)) {
    if (rel === helperKey || rel === RECEIPT_FILE) continue;
    sourceFiles[rel] = src;
  }
  const sourceKeys = Object.keys(sourceFiles);
  if (sourceKeys.length !== EXPECTED.files) throw new Error('FILE_COUNT_MISMATCH');

  const allDecls = [];
  const backendCandidate = {};
  for (const [rel, src] of Object.entries(candidateFiles)) {
    if (rel === RECEIPT_FILE) continue;
    if (rel.startsWith('backend/') && (rel.endsWith('.js') || rel.endsWith('.gs'))) {
      backendCandidate[rel] = src;
      allDecls.push(...parseAst(rel, src));
    }
  }

  const helperDecls = allDecls.filter((d) => d.file === helperKey);
  if (helperDecls.length !== 1 || helperDecls[0].name !== GUARD) throw new Error('CUTOVER_HELPER_DECLARATION_INVALID');

  const candidateDecls = allDecls.filter((d) => d.file !== helperKey);
  if (candidateDecls.length !== EXPECTED_BASELINE_FUNCTIONS) throw new Error('AST_BASELINE_DECL_MISMATCH');
  if (allDecls.length !== EXPECTED_CANDIDATE_FUNCTIONS) throw new Error('AST_CANDIDATE_DECL_MISMATCH');

  const publicDecls = candidateDecls.filter((d) => !d.isPrivate);
  const privateDecls = candidateDecls.filter((d) => d.isPrivate);
  if (publicDecls.length !== EXPECTED_PUBLIC_ENTRIES) throw new Error('PUBLIC_ENTRY_COUNT_MISMATCH');

  const uniquePublicNames = new Set(publicDecls.map((d) => d.name));
  if (uniquePublicNames.size !== EXPECTED_PUBLIC_ENTRIES) throw new Error('PUBLIC_NAMES_NOT_UNIQUE');
  if (privateDecls.length !== EXPECTED.privateFunctions) throw new Error('PRIVATE_FUNCTION_COUNT_MISMATCH');
  if (allDecls.filter((d) => d.isPrivate).length !== EXPECTED.privateFunctions + 1) throw new Error('PRIVATE_FUNCTION_COUNT_MISMATCH');

  for (const pub of publicDecls) {
    if (!pub.firstGuard) throw new Error('PUBLIC_GUARD_MISSING');
  }
  for (const priv of privateDecls) {
    if (priv.firstGuard) throw new Error('PRIVATE_GUARD_UNEXPECTED');
  }

  const unpatchedFiles = {};
  for (const [rel, src] of Object.entries(sourceFiles)) {
    if (rel.endsWith('.js')) {
      const u = unpatchSource(src, rel);
      unpatchedFiles[rel] = u.text;
    } else {
      unpatchedFiles[rel] = src;
    }
  }

  const cleanBaseline = {};
  for (const [rel, src] of Object.entries(baselineFiles)) {
    if (rel === '.clasp.json' || path.basename(rel).startsWith('.')) continue;
    cleanBaseline[rel] = src;
  }
  const baselinePackageSha = computePackageSha256(cleanBaseline);
  if (baselinePackageSha !== BASELINE_PACKAGE_SHA256) throw new Error('BASELINE_HASH_MISMATCH');
  for (const [rel, baseSrc] of Object.entries(cleanBaseline)) {
    if (unpatchedFiles[rel] !== baseSrc) throw new Error('UNPATCHED_BYTE_MISMATCH');
  }

  const unpatchedPackageSha = computePackageSha256(unpatchedFiles);
  if (unpatchedPackageSha !== BASELINE_PACKAGE_SHA256) throw new Error('BASELINE_HASH_MISMATCH');

  const vmReport = runCandidateVmChecks(backendCandidate);

  return {
    status: 'SNAPSHOT_PRESERVED',
    publicEntries: EXPECTED_PUBLIC_ENTRIES,
    baselineFunctions: EXPECTED_BASELINE_FUNCTIONS,
    functionsAfter: EXPECTED_CANDIDATE_FUNCTIONS,
    casesPassed: vmReport.casesPassed,
    casesTotal: vmReport.casesTotal,
    guardPropertyReads: 1,
    runtimeFrozenVerified: false,
    deploymentAuthorized: false,
    authorizesExecution: false,
    remoteAuthorized: false,
    goLiveAuthorized: false,
  };
}

export async function verifyGasV140Candidate(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Reflect.ownKeys(options).length !== 1 || !Object.hasOwn(options, 'candidateDir')
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'candidateDir'), 'value')) throw new Error('CLI_ARGUMENTS');
  const { candidateDir } = options;
  const safeCandidate = await assertSafeCandidateDir(candidateDir);
  const candidateFiles = await readSnapshotFiles(safeCandidate, { isBaseline: false });
  if (!Object.hasOwn(candidateFiles, RECEIPT_FILE)) throw new Error('RECEIPT_FILE_MISSING');
  if (Object.keys(candidateFiles).length !== EXPECTED.files + 2) throw new Error('CANDIDATE_INVENTORY_INVALID');

  const safeBaseline = await assertSafeCandidateDir(DEFAULT_BASELINE_DIR);
  const baselineFiles = await readSnapshotFiles(safeBaseline, { isBaseline: true });
  const snapshotReport = verifySourceSnapshot({ candidateFiles, baselineFiles });
  return {
    ...snapshotReport,
    status: 'CANDIDATE_LOCAL_VERIFIED',
  };
}

function sanitizeErrorCode(err) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  if (ALLOWED_ERROR_CODES.has(msg)) return msg;
  return 'VERIFICATION_FAILED';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let candidateDir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--candidate' && args[i + 1] && !args[i + 1].startsWith('--')) {
      candidateDir = args[++i];
    } else {
      console.error(JSON.stringify({ status: 'CANDIDATE_LOCAL_FAILED', reason: 'CLI_ARGUMENTS' }));
      process.exit(1);
    }
  }
  if (!candidateDir) {
    console.error(JSON.stringify({ status: 'CANDIDATE_LOCAL_FAILED', reason: 'CANDIDATE_PATH_REQUIRED' }));
    process.exit(1);
  }
  try {
    const report = await verifyGasV140Candidate({ candidateDir });
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'CANDIDATE_LOCAL_VERIFIED' ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ status: 'CANDIDATE_LOCAL_FAILED', reason: sanitizeErrorCode(err) }));
    process.exit(1);
  }
}
