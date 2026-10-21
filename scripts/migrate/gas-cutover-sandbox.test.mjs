// Offline-only VM tests for scripts/migrate/gas/CutoverSandboxHarness.gs.
// The EXACT pinned helper legacy-gas/src/backend/Cutover.gs is loaded verbatim
// next to a locally rendered harness. Every Google service is a synthetic mock:
// no network, Google, clasp, deploy, credentials or private baseline is used.
// Stand-in labels are synthetic (43 direct / 40 handlers); this is not v140
// feature validation. Read counts, UNAVAILABLE and non-string values are proven
// here through the mock only; the harness never claims them in Google.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const HELPER_PATH = new URL('../../legacy-gas/src/backend/Cutover.gs', import.meta.url);
const HARNESS_PATH = new URL('./gas/CutoverSandboxHarness.gs', import.meta.url);
const HELPER = readFileSync(HELPER_PATH, 'utf8');
const TEMPLATE = readFileSync(HARNESS_PATH, 'utf8');
const HELPER_RAW_SHA256 = '83171e00d283c486455a1a4bf819205cb42d2b8f9c0c2711ced6f51bf0f228c4';
const HELPER_FUNCTION_SHA256 = '2fc47ee707278d1ae4580398ba0ef6afea28f210221a4dc79216d71ba07e6dd5';
const PLACEHOLDER = '/*@@MANIFEST@@*/null';
const STATE = 'SIKAP_CUTOVER_STATE';
const CONFIRM = 'SIKAP_CUTOVER_SANDBOX_CONFIRM';
const PIN = 'SIKAP_CUTOVER_SANDBOX_V1';
const NONCE = '0123456789abcdef0123456789abcdef';
const SCRIPT_ID = 'synthetic-sandbox-script-id-0001';
const OTHER_SCRIPT_ID = 'synthetic-sandbox-script-id-0002';
const STATE_VALUES = ['open', 'frozen', '', ' ', '\t', 'FROZEN', 'Frozen', 'OPEN', 'Open', ' open', 'open ', 'frozen\n', 'closed'];
const FORBIDDEN_SERVICES = [
  'SpreadsheetApp', 'DriveApp', 'UrlFetchApp', 'DocumentApp', 'SlidesApp', 'FormApp', 'CalendarApp', 'HtmlService',
  'ContentService', 'MailApp', 'GmailApp', 'LockService', 'CacheService', 'Session', 'Jdbc', 'CardService',
  'Browser', 'console', 'google',
];
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
const manifest = (over = {}) => ({
  kind: 'sikap-cutover-sandbox', version: 1, nonce: NONCE, helperFunctionSha256: HELPER_FUNCTION_SHA256,
  directCases: 43, handlerCases: 40, realV140FeatureValidation: false, ...over,
});
const render = (m = manifest()) => TEMPLATE.replace(PLACEHOLDER, JSON.stringify(m));
const confirmValue = (nonce = NONCE) => 'NEW-SYNTHETIC-SANDBOX:' + nonce;
const pinText = (scriptId = SCRIPT_ID, nonce = NONCE) =>
  JSON.stringify({ kind: 'sikap-cutover-sandbox-pin', version: 1, nonce, scriptIdSha256: sha(scriptId) });

// Expected totals for a full passing run (14 state cases incl. absent, 7 no-cache steps).
const STATE_CASES = 1 + STATE_VALUES.length;
const DENIED_CASES = STATE_CASES - 2;
const EXPECTED_STATE_READS = 1 /* preflight */ + 2 * STATE_CASES /* ownership pre-read + readback */
  + 2 * (43 + 80) + DENIED_CASES * (43 + 40)
  + 2 * 7 /* no-cache pre-read + readback */ + 4 * 4 + 3 * 3 /* no-cache probes */ + 1 /* restore */;

function setup(options = {}) {
  const props = new Map(Object.entries(options.properties ?? { [CONFIRM]: confirmValue() }));
  const ops = [];
  const logs = [];
  const counters = { forbidden: 0, forbiddenNames: [], stateReads: 0, sets: 0, deletes: 0, setIndex: 0, readFaults: 0 };
  let scriptId = options.scriptId ?? SCRIPT_ID;
  const store = {
    getKeys() {
      ops.push(['getKeys']);
      if (options.getKeysThrows) throw new Error('SECRET keys failure ' + scriptId);
      return [...props.keys()];
    },
    getProperty(key) {
      ops.push(['get', key]);
      if (key === STATE) {
        counters.stateReads++;
        if (options.onStateRead) options.onStateRead(counters.stateReads, props);
        if (options.stateReadFault && options.stateReadFault(counters.stateReads)) {
          counters.readFaults++;
          throw new Error('SECRET read failure ' + scriptId);
        }
      }
      return props.has(key) ? props.get(key) : null;
    },
    setProperty(key, value) {
      counters.sets++;
      counters.setIndex++;
      ops.push(['set', key, value]);
      if (options.onSet) {
        const r = options.onSet({ key, value, index: counters.setIndex, props });
        if (r === 'throw') throw new Error('SECRET set failure ' + scriptId);
        if (r === 'storeThenThrow') { props.set(key, value); throw new Error('SECRET ambiguous ' + scriptId); }
      }
      if (options.emptyAsNull && value === '') props.delete(key);
      else props.set(key, options.trimValues ? value.trim() || value : value);
      return store;
    },
    deleteProperty(key) {
      counters.deletes++;
      ops.push(['delete', key]);
      if (options.onDelete && options.onDelete({ key, props }) === 'throw') throw new Error('SECRET delete failure');
      if (!options.deleteNoop) props.delete(key);
      return store;
    },
  };
  const guardedStore = new Proxy(store, {
    get(target, prop) {
      if (Object.hasOwn(target, prop)) return target[prop];
      ops.push(['forbidden-store', String(prop)]);
      throw new Error('STORE_METHOD_FORBIDDEN ' + String(prop));
    },
  });
  const sandbox = {
    PropertiesService: {
      getScriptProperties() {
        if (options.propertiesThrow) throw new Error('SECRET authorization ' + scriptId);
        return guardedStore;
      },
    },
    ScriptApp: {
      getScriptId() {
        if (options.scriptIdThrows) throw new Error('SECRET script id failure');
        return scriptId;
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(algorithm, value, charset) {
        assert.equal(algorithm, 'SHA_256');
        assert.equal(charset, 'UTF_8');
        assert.equal(typeof value, 'string');
        return [...createHash('sha256').update(value, 'utf8').digest()].map((b) => (b > 127 ? b - 256 : b));
      },
    },
    Logger: {
      log(value) {
        if (options.loggerThrows) throw new Error('SECRET logger');
        logs.push(String(value));
      },
    },
    ...(options.globals ?? {}),
  };
  for (const name of FORBIDDEN_SERVICES) {
    Object.defineProperty(sandbox, name, {
      configurable: true,
      get() {
        counters.forbidden++;
        counters.forbiddenNames.push(name);
        throw new Error('GOOGLE_SERVICE_FORBIDDEN ' + name);
      },
    });
  }
  const ctx = vm.createContext(sandbox);
  if (options.helper !== null) vm.runInContext(options.helper ?? HELPER, ctx, { filename: 'Cutover.gs' });
  vm.runInContext(options.harness ?? render(options.manifest), ctx, { filename: 'CutoverSandboxHarness.gs' });
  return {
    ctx, props, ops, logs, counters,
    setScriptId: (id) => { scriptId = id; },
    run: () => plain(ctx.runCutoverSandboxRehearsal_()),
    writes: () => ops.filter((o) => o[0] === 'set' || o[0] === 'delete'),
  };
}

const SUMMARY_KEYS = [
  'kind', 'version', 'code', 'passed', 'evidenceScope', 'preflightPassed', 'firstRun', 'pinWritten',
  'restorePhaseEntered', 'stateAbsentAfterVerified', 'directCases', 'handlerCases', 'stateCases', 'stateCasesPassed',
  'directChecks', 'handlerChecks', 'checksPassed', 'checksFailed', 'denialChecks', 'denialSideEffects', 'noCacheSteps',
  'noCachePassed', 'readbackMismatches', 'emptyStringReadback', 'stateWrites', 'pinWrites', 'unavailableVerified',
  'nonStringVerified', 'readCountsMeasured', 'singleExecutionAssumed', 'sandboxRuntimeVerified',
  'realV140FeatureValidation', 'deploymentAuthorized', 'runtimeFrozenVerified', 'remoteAuthorized', 'goLiveAuthorized',
];

function assertSafe(env, summary) {
  assert.deepEqual(Object.keys(summary).sort(), [...SUMMARY_KEYS].sort(), 'fixed summary shape');
  for (const [k, v] of Object.entries(summary)) {
    assert.ok(['boolean', 'number', 'string'].includes(typeof v), `${k} scalar`);
    if (typeof v === 'string') assert.match(v, /^[A-Za-z0-9_-]{1,64}$/, `${k} fixed token`);
  }
  for (const flag of ['realV140FeatureValidation', 'deploymentAuthorized', 'runtimeFrozenVerified', 'remoteAuthorized',
    'goLiveAuthorized', 'unavailableVerified', 'nonStringVerified', 'readCountsMeasured']) {
    assert.equal(summary[flag], false, `${flag} always false`);
  }
  assert.equal(summary.sandboxRuntimeVerified, summary.passed);
  assert.equal(summary.singleExecutionAssumed, true);
  assert.equal(env.logs.length, 1, 'exactly one log line');
  assert.deepEqual(JSON.parse(env.logs[0]), summary, 'logged summary equals returned summary');
  for (const secret of [SCRIPT_ID, OTHER_SCRIPT_ID, sha(SCRIPT_ID), sha(OTHER_SCRIPT_ID), NONCE, 'SECRET', 'NEW-SYNTHETIC',
    'stack', 'Error', '@', 'scriptIdSha256', 'syntheticHandler']) {
    assert.ok(!env.logs[0].includes(secret), `log must not contain ${secret}`);
  }
  assert.equal(env.counters.forbidden, 0, `no forbidden service access (${env.counters.forbiddenNames})`);
  assert.ok(!env.ops.some((o) => o[0] === 'forbidden-store'), 'only allowed store methods');
}

function assertRefused(env, summary, code) {
  assert.equal(summary.code, code);
  assert.equal(summary.passed, false);
  assert.equal(summary.preflightPassed, false);
  assert.equal(summary.restorePhaseEntered, false);
  assert.equal(summary.stateWrites, 0);
  assert.equal(summary.pinWrites, 0);
  assert.deepEqual(env.writes(), [], `${code}: zero property writes`);
  assertSafe(env, summary);
}

// ---------------------------------------------------------------- static

const SF = ts.createSourceFile('CutoverSandboxHarness.gs', TEMPLATE, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function walk(node, visit, parents = []) {
  visit(node, parents);
  ts.forEachChild(node, (child) => walk(child, visit, [...parents, node]));
}

function enclosingFunction(parents) {
  const fn = [...parents].reverse().find((p) => ts.isFunctionDeclaration(p) && p.parent === SF);
  return fn ? fn.name.text : null;
}

test('pinned helper is exact and its function-text hash matches the agreed manifest value', () => {
  assert.equal(createHash('sha256').update(readFileSync(HELPER_PATH)).digest('hex'), HELPER_RAW_SHA256);
  assert.ok(!HELPER.includes('\r'));
  const hsf = ts.createSourceFile('Cutover.gs', HELPER, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(hsf.statements.length, 1);
  assert.equal(sha(hsf.statements[0].getText(hsf)), HELPER_FUNCTION_SHA256);
  const ctx = vm.createContext({});
  vm.runInContext(HELPER, ctx);
  assert.equal(sha(String(ctx.assertCutoverOpen_)), HELPER_FUNCTION_SHA256, 'V8 toString equals AST text');
});

test('static: template text, placeholder and top-level declarations are private', () => {
  assert.ok(!TEMPLATE.includes('\r'), 'LF only');
  assert.notEqual(TEMPLATE.charCodeAt(0), 0xfeff, 'no BOM');
  assert.equal(TEMPLATE.split(PLACEHOLDER).length, 2, 'placeholder exactly once');
  assert.equal(TEMPLATE.split('@@').length, 3, '@@ only in placeholder');
  assert.ok(TEMPLATE.includes('\nvar CUTOVER_SANDBOX_MANIFEST_ = /*@@MANIFEST@@*/null;\n'));
  assert.doesNotMatch(TEMPLATE, /https?:\/\/|googleapis|google\.com|[\w.-]+@[\w-]+\.[\w.]+/);
  const vars = SF.statements.filter(ts.isVariableStatement);
  const fns = SF.statements.filter(ts.isFunctionDeclaration);
  assert.equal(vars.length, 1);
  assert.equal(vars[0].declarationList.declarations.length, 1);
  assert.equal(vars[0].declarationList.declarations[0].name.text, 'CUTOVER_SANDBOX_MANIFEST_');
  assert.equal(vars[0].declarationList.declarations[0].initializer.kind, ts.SyntaxKind.NullKeyword);
  assert.equal(SF.statements.length, vars.length + fns.length, 'no other top-level statements');
  const names = fns.map((f) => f.name.text);
  assert.ok(names.length > 10);
  assert.equal(new Set(names).size, names.length, 'no duplicate declarations');
  for (const name of names) assert.match(name, /^[A-Za-z][A-Za-z0-9]*_$/, `${name} private`);
  assert.equal(names.filter((n) => n === 'runCutoverSandboxRehearsal_').length, 1);
  for (const banned of ['assertCutoverOpen_', 'doGet', 'doPost', 'cleanExpiredSessions', 'onOpen', 'onEdit']) {
    assert.ok(!names.includes(banned), `${banned} not declared`);
  }
});

test('static AST: centralized writes, allowed services only, no forbidden constructs', () => {
  const memberUse = [];
  const typeofOnly = new Set(['doGet', 'doPost', 'API_HANDLERS', 'cleanExpiredSessions', 'onOpen', 'onEdit']);
  const services = new Set(['PropertiesService', 'ScriptApp', 'Utilities', 'Logger']);
  const forbiddenIds = new Set([...FORBIDDEN_SERVICES, 'eval', 'Function', 'globalThis', 'Reflect', 'Proxy', 'this',
    'arguments', 'require', 'setProperties', 'deleteAllProperties', 'getUserProperties', 'getDocumentProperties',
    'newTrigger', 'getProjectTriggers', 'deleteTrigger', 'openById', 'openByUrl', 'getFileById', 'getFolderById',
    'fetch', 'getOAuthToken', '__proto__', 'constructor']);
  walk(SF, (node, parents) => {
    assert.ok(!ts.isTemplateExpression(node) && !ts.isNoSubstitutionTemplateLiteral(node), 'no template literals');
    assert.ok(!ts.isWithStatement(node), 'no with');
    assert.ok(node.kind !== ts.SyntaxKind.ThisKeyword, 'no this');
    if (ts.isIdentifier(node)) {
      const text = node.text;
      assert.ok(!forbiddenIds.has(text), `forbidden identifier ${text}`);
      const parent = node.parent;
      if (typeofOnly.has(text)) assert.ok(ts.isTypeOfExpression(parent), `${text} only as typeof operand`);
      if (services.has(text)) {
        assert.ok(ts.isPropertyAccessExpression(parent) && parent.expression === node, `${text} member-only`);
        memberUse.push([text + '.' + parent.name.text, enclosingFunction(parents)]);
      }
      if (text === 'assertCutoverOpen_') {
        assert.ok(ts.isCallExpression(parent) || ts.isTypeOfExpression(parent), 'helper only called/passed/typeof');
      }
      if (['setProperty', 'deleteProperty'].includes(text)) {
        assert.equal(enclosingFunction(parents), 'cutoverSandboxWrite_', `${text} only in cutoverSandboxWrite_`);
      }
      if (text === 'getKeys') assert.equal(enclosingFunction(parents), 'cutoverSandboxListKeys_');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      const root = (n) => (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) ? root(n.expression) : n);
      const r = root(left);
      assert.ok(!(ts.isIdentifier(r) && ['CUTOVER_SANDBOX_MANIFEST_', 'assertCutoverOpen_', 'JSON', 'Object',
        'PropertiesService', 'ScriptApp', 'Utilities', 'Logger'].includes(r.text)), 'no global reassignment');
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      assert.ok(!services.has(node.expression.text), 'no computed service access');
    }
  });
  const allowed = new Set(['PropertiesService.getScriptProperties', 'ScriptApp.getScriptId', 'Utilities.computeDigest',
    'Utilities.DigestAlgorithm', 'Utilities.Charset', 'Logger.log']);
  for (const [use] of memberUse) assert.ok(allowed.has(use), `service member ${use} allowed`);
  assert.deepEqual(memberUse.filter(([u]) => u === 'Logger.log').map(([, f]) => f), ['runCutoverSandboxRehearsal_']);
  assert.deepEqual(memberUse.filter(([u]) => u === 'ScriptApp.getScriptId').map(([, f]) => f), ['cutoverSandboxScriptIdHash_']);
  assert.deepEqual(memberUse.filter(([u]) => u === 'PropertiesService.getScriptProperties').map(([, f]) => f),
    ['cutoverSandboxPreflight_']);
  // String literals never name a forbidden service.
  walk(SF, (node) => {
    if (ts.isStringLiteral(node)) {
      for (const id of FORBIDDEN_SERVICES) assert.ok(!new RegExp('\\b' + id + '\\b').test(node.text), `literal ${id}`);
    }
  });
});

// --------------------------------------------------------------- runtime

test('first run: pin written once after preflight, all states pass, state restored absent', () => {
  const env = setup();
  const s = env.run();
  assert.equal(s.code, 'CUTOVER_SANDBOX_PASSED', JSON.stringify(s));
  assert.equal(s.passed, true);
  assert.equal(s.sandboxRuntimeVerified, true);
  assert.equal(s.evidenceScope, 'synthetic-guard-rehearsal');
  assert.equal(s.preflightPassed, true);
  assert.equal(s.firstRun, true);
  assert.equal(s.pinWritten, true);
  assert.equal(s.pinWrites, 1);
  assert.equal(s.restorePhaseEntered, true);
  assert.equal(s.stateAbsentAfterVerified, true);
  assert.equal(s.stateCases, STATE_CASES);
  assert.equal(s.stateCasesPassed, STATE_CASES);
  assert.equal(s.directChecks, STATE_CASES * 43);
  assert.equal(s.handlerChecks, STATE_CASES * 40);
  assert.equal(s.checksPassed, STATE_CASES * 83);
  assert.equal(s.checksFailed, 0);
  assert.equal(s.denialChecks, DENIED_CASES * 83);
  assert.equal(s.denialSideEffects, 0);
  assert.equal(s.noCacheSteps, 7);
  assert.equal(s.noCachePassed, 7);
  assert.equal(s.readbackMismatches, 0);
  assert.equal(s.emptyStringReadback, 'empty');
  assert.equal(s.stateWrites, 20, 'initial absent case is read-only (no unowned delete)');
  assertSafe(env, s);
  // Pin is the first write, written exactly once, only after every preflight read.
  const writes = env.writes();
  assert.deepEqual(writes[0], ['set', PIN, pinText()]);
  assert.deepEqual(writes[1], ['set', STATE, 'open'], 'no delete before the run owns a value');
  assert.equal(writes.filter((w) => w[1] === PIN).length, 1);
  assert.ok(writes.slice(1).every((w) => w[1] === STATE), 'all later writes target state only');
  const firstWriteAt = env.ops.findIndex((o) => o[0] === 'set');
  const preflight = env.ops.slice(0, firstWriteAt).map((o) => o.join(':'));
  assert.deepEqual(preflight, ['get:' + STATE, 'getKeys', 'get:' + CONFIRM]);
  for (const w of writes) if (w[0] === 'set' && w[1] === STATE) assert.ok(STATE_VALUES.includes(w[2]));
  assert.deepEqual([...env.props.keys()].sort(), [CONFIRM, PIN].sort(), 'no blanket deletion, state absent');
  assert.equal(env.props.get(CONFIRM), confirmValue());
  // Independent mock-measured read count (harness itself reports readCountsMeasured:false).
  assert.equal(env.counters.stateReads, EXPECTED_STATE_READS);
});

test('repeat run: pin verified, no pin rewrite, same result', () => {
  const env = setup({ properties: { [CONFIRM]: confirmValue(), [PIN]: pinText() } });
  const s = env.run();
  assert.equal(s.code, 'CUTOVER_SANDBOX_PASSED');
  assert.equal(s.firstRun, false);
  assert.equal(s.pinWritten, false);
  assert.equal(s.pinWrites, 0);
  assert.ok(env.writes().every((w) => w[1] === STATE));
  assert.equal(env.props.get(PIN), pinText());
  assert.ok(!env.props.has(STATE));
  assertSafe(env, s);
  // Two consecutive runs on the same project.
  const again = setup({ properties: Object.fromEntries(env.props) });
  assert.equal(again.run().code, 'CUTOVER_SANDBOX_PASSED');
});

test('preflight refusals perform zero writes and never enter restore', () => {
  const live = (name) => ({ globals: { [name]: name === 'API_HANDLERS' ? {} : function live() {} } });
  const cases = [
    ['SANDBOX_MANIFEST_INVALID', { harness: TEMPLATE }],
    ['SANDBOX_MANIFEST_INVALID', { manifest: manifest({ extra: 1 }) }],
    ['SANDBOX_MANIFEST_INVALID', { manifest: manifest({ directCases: 42 }) }],
    ['SANDBOX_MANIFEST_INVALID', { manifest: manifest({ handlerCases: 41 }) }],
    ['SANDBOX_MANIFEST_INVALID', { manifest: manifest({ realV140FeatureValidation: true }) }],
    ['SANDBOX_MANIFEST_INVALID', { manifest: manifest({ nonce: NONCE.toUpperCase() }) }],
    ['SANDBOX_MANIFEST_INVALID', { manifest: manifest({ helperFunctionSha256: 'x'.repeat(64) }) }],
    ['SANDBOX_MANIFEST_INVALID', { manifest: manifest({ kind: 'other' }) }],
    ...['doGet', 'doPost', 'API_HANDLERS', 'cleanExpiredSessions', 'onOpen', 'onEdit']
      .map((n) => ['SANDBOX_LIVE_CODE_PRESENT', live(n)]),
    ['SANDBOX_HELPER_MISSING', { helper: null }],
    ['SANDBOX_HELPER_MISMATCH', { helper: HELPER.replace("var key = 'SIKAP_CUTOVER_STATE';", "var key  = 'SIKAP_CUTOVER_STATE';") }],
    ['SANDBOX_HELPER_MISMATCH', { helper: HELPER.replace(/\n/g, '\r\n') }],
    ['SANDBOX_HELPER_MISMATCH', { manifest: manifest({ helperFunctionSha256: sha('other') }) }],
    ['SANDBOX_PROPERTIES_UNAVAILABLE', { propertiesThrow: true }],
    ['SANDBOX_PROPERTIES_UNAVAILABLE', { getKeysThrows: true }],
    ['SANDBOX_STATE_NOT_ABSENT', { properties: { [CONFIRM]: confirmValue(), [STATE]: 'open' } }],
    ['SANDBOX_STATE_NOT_ABSENT', { properties: { [CONFIRM]: confirmValue(), [STATE]: 'frozen' } }],
    ['SANDBOX_STATE_NOT_ABSENT', { properties: { [CONFIRM]: confirmValue(), [PIN]: pinText(), [STATE]: '' } }],
    ['SANDBOX_PROPERTY_KEYS_INVALID', { properties: {} }],
    ['SANDBOX_PROPERTY_KEYS_INVALID', { properties: { [CONFIRM]: confirmValue(), OTHER_KEY: 'x' } }],
    ['SANDBOX_PROPERTY_KEYS_INVALID', { properties: { [PIN]: pinText() } }],
    ['SANDBOX_PROPERTY_KEYS_INVALID', { properties: { [CONFIRM]: confirmValue(), [PIN]: pinText(), OTHER_KEY: 'x' } }],
    ['SANDBOX_CONFIRM_INVALID', { properties: { [CONFIRM]: confirmValue('f'.repeat(32)) } }],
    ['SANDBOX_CONFIRM_INVALID', { properties: { [CONFIRM]: NONCE } }],
    ['SANDBOX_CONFIRM_INVALID', { properties: { [CONFIRM]: confirmValue() + ' ' } }],
    ['SANDBOX_SCRIPT_ID_UNAVAILABLE', { scriptIdThrows: true }],
    ['SANDBOX_PIN_MISMATCH', { properties: { [CONFIRM]: confirmValue(), [PIN]: pinText(OTHER_SCRIPT_ID) } }],
    ['SANDBOX_PIN_MISMATCH', { properties: { [CONFIRM]: confirmValue(), [PIN]: pinText(SCRIPT_ID, 'e'.repeat(32)) } }],
    ['SANDBOX_PIN_INVALID', { properties: { [CONFIRM]: confirmValue(), [PIN]: '{not json' } }],
    ['SANDBOX_PIN_INVALID', { properties: { [CONFIRM]: confirmValue(), [PIN]: JSON.stringify({ kind: 'x' }) } }],
  ];
  for (const [code, options] of cases) {
    const env = setup(options);
    const before = new Map(env.props);
    const s = env.run();
    assertRefused(env, s, code);
    assert.deepEqual(env.props, before, `${code}: properties unchanged`);
  }
});

test('script ID pin: a pinned project refuses a different script ID with zero writes', () => {
  const first = setup();
  assert.equal(first.run().code, 'CUTOVER_SANDBOX_PASSED');
  const copied = setup({ properties: Object.fromEntries(first.props), scriptId: OTHER_SCRIPT_ID });
  assertRefused(copied, copied.run(), 'SANDBOX_PIN_MISMATCH');
});

test('Google null handling for empty string is recorded and stays consistent', () => {
  const env = setup({ emptyAsNull: true });
  const s = env.run();
  assert.equal(s.code, 'CUTOVER_SANDBOX_PASSED');
  assert.equal(s.emptyStringReadback, 'null');
  assert.equal(s.denialChecks, (DENIED_CASES - 1) * 83, 'empty string exercised as absent');
  assertSafe(env, s);
});

test('foreign readback never grants ownership: no overwrite, no delete, no pass', () => {
  const env = setup({ trimValues: true });
  const s = env.run();
  assert.equal(s.code, 'SANDBOX_STATE_UNEXPECTED_MUTATION');
  assert.equal(s.passed, false);
  assert.equal(s.sandboxRuntimeVerified, false);
  assert.equal(s.readbackMismatches, 1);
  assert.equal(s.stateAbsentAfterVerified, false);
  assert.equal(env.props.get(STATE), 'open', 'differing stored value left for the operator');
  const writes = env.writes();
  assert.deepEqual(writes.at(-1), ['set', STATE, ' open'], 'nothing written after the mismatch');
  assert.ok(!writes.some((w) => w[0] === 'delete'));
  assertSafe(env, s);
});

test('concurrent foreign value between cases: stop before overwrite, never delete', () => {
  // Limitation: a foreign write of the exact value this run owns ('open' here) is indistinguishable.
  for (const foreign of ['frozen', 'Open', 'maintenance']) {
    let injected = false;
    const env = setup({
      onStateRead: (n, props) => {
        // Inject after case "open" probes finished (preflight 1 + absent 2+83 + open pre-read/readback 2 + 123 probes).
        if (!injected && n === 1 + 2 + 83 + 2 + 123) { props.set(STATE, foreign); injected = true; }
      },
    });
    const s = env.run();
    assert.ok(injected);
    assert.equal(s.code, 'SANDBOX_STATE_UNEXPECTED_MUTATION', foreign);
    assert.equal(env.props.get(STATE), foreign, `${foreign}: not overwritten or deleted`);
    assert.deepEqual(env.writes().slice(1), [['set', STATE, 'open']], `${foreign}: no write after mutation`);
    assert.equal(s.stateAbsentAfterVerified, false);
    assertSafe(env, s);
  }
  // Foreign value appearing after the final owned delete is never deleted by restore.
  let reads = 0;
  const late = setup({ onStateRead: (n, props) => { reads = n; if (n === EXPECTED_STATE_READS) props.set(STATE, 'open'); } });
  const s = late.run();
  assert.equal(reads, EXPECTED_STATE_READS, 'restore performed exactly one read and no delete');
  assert.equal(s.code, 'SANDBOX_STATE_UNEXPECTED_MUTATION');
  assert.equal(late.props.get(STATE), 'open', 'value equal to an earlier owned value is still not deleted');
  assert.equal(late.writes().at(-1)[0], 'delete', 'last write is the owned no-cache delete, not a restore delete');
  assertSafe(late, s);
});

test('harness detects a caching or non-denying helper (no false pass)', () => {
  const caching = 'var cached_ = undefined;\nfunction assertCutoverOpen_() {\n  if (cached_ === undefined) cached_ = '
    + "PropertiesService.getScriptProperties().getProperty('SIKAP_CUTOVER_STATE');\n  if (cached_ === null || cached_ === 'open') return;\n"
    + "  throw new Error(cached_ === 'frozen' ? 'SIKAP_CUTOVER_FROZEN' : 'SIKAP_CUTOVER_STATE_INVALID');\n}";
  const fnText = caching.slice(caching.indexOf('function'));
  const env = setup({ helper: caching, manifest: manifest({ helperFunctionSha256: sha(fnText) }) });
  const s = env.run();
  assert.notEqual(s.code, 'CUTOVER_SANDBOX_PASSED');
  assert.equal(s.passed, false);
  assert.ok(!env.props.has(STATE));
  const lax = 'function assertCutoverOpen_() {\n  return;\n}';
  const env2 = setup({ helper: lax, manifest: manifest({ helperFunctionSha256: sha(lax) }) });
  const s2 = env2.run();
  assert.equal(s2.code, 'SANDBOX_CASE_FAILED');
  assert.ok(s2.checksFailed > 0);
  assert.ok(!env2.props.has(STATE));
  assertSafe(env2, s2);
});

test('unexpected middle failure is sanitized and state is restored absent', () => {
  for (const mode of ['throw', 'storeThenThrow']) {
    const env = setup({ onSet: ({ key, index }) => (key === STATE && index === 6 ? mode : undefined) });
    const s = env.run();
    assert.equal(s.code, 'SANDBOX_STATE_WRITE_FAILED', mode);
    assert.equal(s.passed, false);
    assert.equal(s.stateAbsentAfterVerified, true);
    assert.ok(!env.props.has(STATE), `${mode}: restored`);
    assert.equal(env.writes().at(-1)[0], 'delete');
    assertSafe(env, s);
  }
  // Property read fault during cases: helper fails closed, harness reports failure, restores.
  const env = setup({ stateReadFault: (n) => n === 200 });
  const s = env.run();
  assert.equal(env.counters.readFaults, 1);
  assert.ok(['SANDBOX_CASE_FAILED', 'SANDBOX_PROPERTIES_UNAVAILABLE'].includes(s.code));
  assert.equal(s.stateAbsentAfterVerified, true);
  assert.ok(!env.props.has(STATE));
  assertSafe(env, s);
});

test('restore failure has priority over run failure and is never reported as restored', () => {
  const failDelete = setup({
    onSet: ({ key, index }) => (key === STATE && index === 4 ? 'throw' : undefined),
    // Only the restore delete (state present) fails; the absent-case delete succeeds.
    onDelete: ({ props }) => (props.has(STATE) ? 'throw' : undefined),
  });
  const s1 = failDelete.run();
  assert.equal(s1.code, 'SANDBOX_RESTORE_FAILED', 'restore failure outranks SANDBOX_STATE_WRITE_FAILED');
  assert.equal(s1.stateAbsentAfterVerified, false);
  assert.equal(failDelete.props.get(STATE), 'frozen', 'left for manual operator removal');
  assertSafe(failDelete, s1);
  // A delete that silently does nothing: the surviving value is no longer owned,
  // so it is reported (never re-deleted) and outranks any run result.
  const noop = setup({ deleteNoop: true });
  const s2 = noop.run();
  assert.equal(s2.code, 'SANDBOX_STATE_UNEXPECTED_MUTATION');
  assert.equal(s2.passed, false);
  assert.equal(s2.stateAbsentAfterVerified, false);
  assert.ok(noop.props.has(STATE));
  assertSafe(noop, s2);
  const readFail = setup({
    onSet: ({ key, index }) => (key === STATE && index === 4 ? 'throw' : undefined),
    stateReadFault: (n) => n > 5,
  });
  const s3 = readFail.run();
  assert.equal(s3.code, 'SANDBOX_RESTORE_FAILED');
  assertSafe(readFail, s3);
});

test('foreign state value is never deleted (unexpected mutation)', () => {
  const env = setup({
    onSet: ({ key, index, props }) => {
      if (key === STATE && index === 5) { props.set(STATE, 'foreign-maintenance'); return 'throw'; }
      return undefined;
    },
  });
  const s = env.run();
  assert.equal(s.code, 'SANDBOX_STATE_UNEXPECTED_MUTATION');
  assert.equal(env.props.get(STATE), 'foreign-maintenance', 'not deleted');
  assert.equal(s.stateAbsentAfterVerified, false);
  assertSafe(env, s);
});

test('logger failure does not change the returned summary', () => {
  const env = setup({ loggerThrows: true });
  const s = plain(env.ctx.runCutoverSandboxRehearsal_());
  assert.equal(s.code, 'CUTOVER_SANDBOX_PASSED');
  assert.equal(env.logs.length, 0);
});

test('write helper refuses keys/values outside the fixed allowlist', () => {
  const env = setup();
  const c = env.ctx;
  const ctx = { store: c.PropertiesService.getScriptProperties(), pinWriteAllowed: false, pinWrites: 0, pinText: 'x',
    stateWritesAllowed: false, stateWrites: 0, stateOwned: false, ownedValues: [] };
  const code = (fn) => { try { fn(); return 'none'; } catch (e) { return e.message; } };
  assert.equal(code(() => c.cutoverSandboxWrite_(ctx, STATE, 'open')), 'SANDBOX_WRITE_REFUSED', 'state outside run');
  assert.equal(code(() => c.cutoverSandboxWrite_(ctx, PIN, 'x')), 'SANDBOX_WRITE_REFUSED', 'pin not allowed');
  assert.equal(code(() => c.cutoverSandboxWrite_(ctx, CONFIRM, null)), 'SANDBOX_WRITE_REFUSED', 'confirm never');
  ctx.stateWritesAllowed = true;
  for (const v of ['maintenance', 'paused', 'x'.repeat(10), 0, false, {}, undefined]) {
    assert.equal(code(() => c.cutoverSandboxWrite_(ctx, STATE, v)), 'SANDBOX_WRITE_REFUSED', String(v));
  }
  assert.equal(code(() => c.cutoverSandboxWrite_(ctx, 'OTHER', 'open')), 'SANDBOX_WRITE_REFUSED');
  ctx.pinWriteAllowed = true;
  assert.equal(code(() => c.cutoverSandboxWrite_(ctx, PIN, 'y')), 'SANDBOX_WRITE_REFUSED', 'pin text must match');
  assert.equal(code(() => c.cutoverSandboxWrite_(ctx, PIN, 'x')), 'none');
  assert.equal(code(() => c.cutoverSandboxWrite_(ctx, PIN, 'x')), 'SANDBOX_WRITE_REFUSED', 'pin once');
  assert.deepEqual(env.writes(), [['set', PIN, 'x']]);
});

// ------------------------------------- local mock-only evidence (never claimed in Google)

test('mock-only: direct=1 read, dispatcher=2 reads allowed / 1 read denied, zero denial effects', () => {
  const env = setup();
  const c = env.ctx;
  const counters = c.cutoverSandboxNewCounters_();
  const standins = c.cutoverSandboxStandins_(counters, 43, 40);
  assert.equal(standins.direct.length, 43);
  assert.equal(standins.labels.length, 40);
  assert.ok(standins.labels.every((l) => /^syntheticHandler\d\d$/.test(l)));
  const measure = (state, fn) => {
    if (state === null) env.props.delete(STATE); else env.props.set(STATE, state);
    c.cutoverSandboxResetCounters_(counters);
    const before = env.counters.stateReads;
    let message = 'ALLOW';
    try { fn(); } catch (e) { message = e.message; }
    return { reads: env.counters.stateReads - before, message, effects: counters.direct + counters.handler + counters.dispatch + counters.eventReads };
  };
  for (const state of [null, 'open']) {
    for (let i = 0; i < 43; i++) assert.deepEqual(measure(state, () => standins.direct[i]()), { reads: 1, message: 'ALLOW', effects: 1 });
    for (const label of standins.labels) {
      assert.deepEqual(measure(state, () => standins.dispatcher(c.cutoverSandboxEvent_(counters, label))),
        { reads: 2, message: 'ALLOW', effects: 3 });
    }
  }
  for (const [state, code] of [['frozen', 'SIKAP_CUTOVER_FROZEN'], ['FROZEN', 'SIKAP_CUTOVER_STATE_INVALID'],
    ['', 'SIKAP_CUTOVER_STATE_INVALID'], [' open', 'SIKAP_CUTOVER_STATE_INVALID'], [0, 'SIKAP_CUTOVER_STATE_INVALID'],
    [false, 'SIKAP_CUTOVER_STATE_INVALID'], [undefined, 'SIKAP_CUTOVER_STATE_INVALID'], [{}, 'SIKAP_CUTOVER_STATE_INVALID']]) {
    for (let i = 0; i < 43; i++) assert.deepEqual(measure(state, () => standins.direct[i]()), { reads: 1, message: code, effects: 0 });
    for (const label of standins.labels) {
      assert.deepEqual(measure(state, () => standins.dispatcher(c.cutoverSandboxEvent_(counters, label))),
        { reads: 1, message: code, effects: 0 });
    }
  }
  env.props.delete(STATE);
});

test('mock-only: UNAVAILABLE fails closed before any stand-in effect', () => {
  let fail = true;
  const env = setup({ stateReadFault: () => fail });
  const c = env.ctx;
  const counters = c.cutoverSandboxNewCounters_();
  const standins = c.cutoverSandboxStandins_(counters, 43, 40);
  for (let i = 0; i < 43; i++) assert.throws(() => standins.direct[i](), { message: 'SIKAP_CUTOVER_STATE_UNAVAILABLE' });
  for (const label of standins.labels) {
    assert.throws(() => standins.dispatcher(c.cutoverSandboxEvent_(counters, label)), { message: 'SIKAP_CUTOVER_STATE_UNAVAILABLE' });
  }
  assert.deepEqual({ ...counters }, { direct: 0, handler: 0, dispatch: 0, eventReads: 0, lastDirect: -1, lastHandler: -1 });
  fail = false;
  standins.direct[0]();
  assert.equal(counters.direct, 1, 'recovers on next read (no cache)');
});

test('stand-in factory functions are guard-first', () => {
  for (const name of ['cutoverSandboxMakeDirect_', 'cutoverSandboxMakeHandler_', 'cutoverSandboxMakeDispatcher_']) {
    const decl = SF.statements.find((s) => ts.isFunctionDeclaration(s) && s.name.text === name);
    const ret = decl.body.statements[0];
    assert.ok(ts.isReturnStatement(ret) && ts.isFunctionExpression(ret.expression), name);
    const first = ret.expression.body.statements[0];
    assert.ok(ts.isExpressionStatement(first) && ts.isCallExpression(first.expression)
      && first.expression.expression.text === 'assertCutoverOpen_' && first.expression.arguments.length === 0, `${name} guard first`);
  }
});
