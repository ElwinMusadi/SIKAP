// Offline-only VM tests for legacy-gas/src/backend/Cutover.gs and the
// first-statement `assertCutoverOpen_();` gate in every legacy backend function.
// No Google services, network, clasp, deployment or property writes are used:
// every Google binding is a counting accessor that throws, except a read-only
// PropertiesService mock that only answers getProperty.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const BACKEND = new URL('../../legacy-gas/src/backend/', import.meta.url);
const FILES = readdirSync(BACKEND).filter((f) => f.endsWith('.gs')).sort();
const SOURCES = Object.fromEntries(FILES.map((f) => [f, readFileSync(new URL(f, BACKEND), 'utf8')]));
const KEY = 'SIKAP_CUTOVER_STATE';
const GUARD = 'assertCutoverOpen_';
const GOOGLE = [
  'SpreadsheetApp', 'DriveApp', 'UrlFetchApp', 'Utilities', 'HtmlService', 'ContentService', 'Logger',
  'LockService', 'CacheService', 'Session', 'MailApp', 'GmailApp', 'ScriptApp', 'DocumentApp',
  'CalendarApp', 'FormApp', 'SitesApp', 'Browser', 'console',
];

// Top-level declarations are written at column 0 in these sources (one per line).
const DECLS = FILES.flatMap((file) =>
  [...SOURCES[file].matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => ({ file, name: m[1], index: m.index })),
);
const GUARDED = DECLS.filter((d) => d.name !== GUARD);
const RUNTIME_NAMES = [...new Set(GUARDED.map((d) => d.name))];

function stripLeadingComments(text) {
  let s = text;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('//')) s = t.slice(t.indexOf('\n') + 1 || t.length);
    else if (t.startsWith('/*')) s = t.slice(t.indexOf('*/') + 2);
    else return t;
  }
}

function setup({ state = null, props = 'ok', services = {} } = {}) {
  const counters = { google: 0, googleNames: [], hostile: 0, propReads: [], propOther: 0, jsonParse: 0 };
  const sandbox = {};
  for (const name of GOOGLE) {
    if (services[name]) {
      sandbox[name] = services[name];
      continue;
    }
    Object.defineProperty(sandbox, name, {
      configurable: true,
      get() {
        counters.google++;
        counters.googleNames.push(name);
        throw new Error('GOOGLE_ACCESS_FORBIDDEN_' + name);
      },
    });
  }
  const store = {
    getProperty(key) {
      counters.propReads.push(key);
      if (props === 'getPropertyThrows') throw new Error('raw provider detail SECRET');
      return typeof state === 'function' ? state() : state;
    },
  };
  const guardedStore = new Proxy(store, {
    get(target, prop) {
      if (prop === 'getProperty') return target.getProperty;
      counters.propOther++;
      throw new Error('PROPERTY_METHOD_FORBIDDEN');
    },
  });
  if (props !== 'missing') {
    Object.defineProperty(sandbox, 'PropertiesService', {
      configurable: true,
      get() {
        if (props === 'accessorThrows') throw new Error('denied SECRET');
        return {
          getScriptProperties() {
            if (props === 'getScriptPropertiesThrows') throw new Error('Authorization required SECRET');
            if (props === 'nullStore') return null;
            return guardedStore;
          },
        };
      },
    });
  }
  const ctx = vm.createContext(sandbox);
  for (const file of FILES) vm.runInContext(SOURCES[file], ctx, { filename: file });
  const realParse = vm.runInContext('JSON.parse', ctx);
  ctx.__countParse = () => counters.jsonParse++;
  vm.runInContext('(function(p){ JSON.parse = function(){ __countParse(); return p.apply(JSON, arguments); }; })(JSON.parse)', ctx);
  void realParse;
  return { ctx, counters, setState: (v) => { state = v; } };
}

function hostile(counters) {
  const trap = () => { counters.hostile++; throw new Error('HOSTILE_ARG_TOUCHED'); };
  return new Proxy(function hostileArg() {}, {
    get: trap, has: trap, ownKeys: trap, getPrototypeOf: trap, apply: trap, construct: trap,
    getOwnPropertyDescriptor: trap, set: trap, defineProperty: trap, deleteProperty: trap,
  });
}

function hostileEvent(counters) {
  const e = {};
  for (const k of ['parameter', 'parameters', 'postData', 'queryString', 'contentLength', 'pathInfo']) {
    Object.defineProperty(e, k, { get() { counters.hostile++; return { action: 'login', contents: '{"nip":"1"}' }; } });
  }
  return e;
}

function callCode(fn, args) {
  try {
    const value = fn(...args);
    return { threw: false, value };
  } catch (err) {
    return { threw: true, err };
  }
}

function assertClosed(result, code, counters, label) {
  assert.equal(result.threw, true, `${label}: must throw`);
  const err = result.err;
  assert.equal(Object.prototype.toString.call(err), '[object Error]', `${label}: Error object`);
  assert.equal(err.name, 'Error', label);
  assert.equal(err.message, code, `${label}: exact closed code`);
  assert.equal(err.cause, undefined, `${label}: no cause`);
  assert.deepEqual(Object.keys(err), [], `${label}: no extra fields`);
  assert.doesNotMatch(String(err.stack || ''), /SECRET|FROZEN_RAW/, `${label}: no raw detail`);
  assert.equal(counters.google, 0, `${label}: no Google access (${counters.googleNames.join(',')})`);
  assert.equal(counters.hostile, 0, `${label}: hostile args untouched`);
  assert.equal(counters.jsonParse, 0, `${label}: nothing parsed`);
  assert.equal(counters.propOther, 0, `${label}: no property write/other method`);
}

function reset(counters) {
  counters.google = 0; counters.googleNames.length = 0; counters.hostile = 0;
  counters.propReads.length = 0; counters.propOther = 0; counters.jsonParse = 0;
}

function invokeAll(env, code, { expectReads = true } = {}) {
  for (const name of RUNTIME_NAMES) {
    reset(env.counters);
    const fn = env.ctx[name];
    assert.equal(typeof fn, 'function', name);
    const args = name === 'doPost' || name === 'doGet'
      ? [hostileEvent(env.counters)]
      : Array.from({ length: 8 }, () => hostile(env.counters));
    assertClosed(callCode(fn, args), code, env.counters, name);
    if (expectReads) assert.deepEqual(env.counters.propReads, [KEY], `${name}: exactly one state read`);
  }
}

// ---------------------------------------------------------------- static

test('static: every top-level function starts with the guard; Cutover helper is sole exception', () => {
  assert.ok(FILES.includes('Cutover.gs'));
  assert.equal(DECLS.filter((d) => d.name === GUARD).length, 1);
  assert.equal(DECLS.find((d) => d.name === GUARD).file, 'Cutover.gs');
  assert.equal(GUARDED.length, 122, 'pinned declaration count (update deliberately when adding functions)');
  for (const { file, name, index } of GUARDED) {
    const src = SOURCES[file];
    const open = src.indexOf('{', index);
    const first = stripLeadingComments(src.slice(open + 1));
    assert.ok(first.startsWith(GUARD + '();'), `${file}:${name} first statement must be ${GUARD}();`);
  }
  // No other ways to define top-level functions that would escape the gate.
  for (const file of FILES) {
    assert.doesNotMatch(SOURCES[file], /^(var|let|const)\s+[\w$]+\s*=\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/m, file);
    assert.doesNotMatch(SOURCES[file], /^(async\s+function|class\s)/m, file);
  }
});

test('static: Cutover.gs is read-only, private and self-contained', () => {
  const src = SOURCES['Cutover.gs'];
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.equal([...code.matchAll(/\bfunction\b/g)].length, 1);
  for (const banned of [
    'setProperty', 'setProperties', 'deleteProperty', 'deleteAllProperties', 'doGet', 'doPost', 'Logger', 'console',
    'CacheService', 'LockService', 'ScriptApp', 'UrlFetchApp', 'SpreadsheetApp', 'DriveApp', 'HtmlService',
    'ContentService', 'getUserProperties', 'getDocumentProperties', 'setTimeout', 'Date',
  ]) assert.ok(!code.includes(banned), `Cutover.gs must not reference ${banned}`);
  const body = code.slice(code.indexOf('{'));
  const calls = new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  assert.deepEqual([...calls].sort(), ['Error', 'catch', 'getProperty', 'getScriptProperties', 'if'].sort());
  // No top-level executable statements: only the declaration and comments.
  assert.equal(code.replace(/function assertCutoverOpen_\(\) \{[\s\S]*\n\}\n?/, '').trim(), '');
  // The state key is referenced only by the guard; nothing writes it.
  for (const file of FILES) {
    if (file !== 'Cutover.gs') assert.ok(!SOURCES[file].includes(KEY), `${file} must not reference ${KEY}`);
  }
});

test('static: doPost whitelist handlers are all guarded top-level functions', () => {
  const api = SOURCES['API.gs'];
  const block = api.slice(api.indexOf('var API_HANDLERS = {'), api.indexOf('};', api.indexOf('var API_HANDLERS = {')));
  const pairs = [...block.matchAll(/^\s*([\w$]+):\s*([\w$]+),?\s*$/gm)];
  assert.equal(pairs.length, 38);
  for (const [, key, value] of pairs) {
    assert.equal(key, value);
    assert.ok(GUARDED.some((d) => d.name === value), `${value} guarded`);
  }
  const doPost = api.slice(api.indexOf('function doPost'));
  assert.ok(doPost.indexOf(GUARD + '();') < doPost.indexOf('try {'), 'doPost guard sits outside the JSON try/catch');
});

// --------------------------------------------------------------- runtime

test('VM context exposes exactly the enumerated top-level functions', () => {
  const env = setup();
  const fnKeys = Object.keys(env.ctx).filter((k) => {
    const d = Object.getOwnPropertyDescriptor(env.ctx, k);
    return d && 'value' in d && typeof d.value === 'function' && !k.startsWith('__');
  });
  assert.deepEqual(fnKeys.sort(), [...RUNTIME_NAMES, GUARD].sort());
  assert.equal(RUNTIME_NAMES.length, 121, '122 guarded declarations, _formatDate declared twice');
  assert.equal(env.counters.google, 0, 'loading performs no Google access');
  assert.deepEqual(env.counters.propReads, [], 'loading performs no property read');
});

test('frozen: every function throws SIKAP_CUTOVER_FROZEN before any Google/argument access', () => {
  invokeAll(setup({ state: 'frozen' }), 'SIKAP_CUTOVER_FROZEN');
});

test('invalid values fail closed with SIKAP_CUTOVER_STATE_INVALID (no normalization)', () => {
  const values = ['', ' ', '\t', 'FROZEN', 'Frozen', 'OPEN', 'Open', ' open', 'open ', 'frozen\n', 'closed',
    'true', 'false', '0', 'null', 'undefined', 'paused', undefined, 0, false, {}];
  for (const v of values) {
    const env = setup({ state: () => v });
    for (const name of ['doPost', 'doGet', 'login', 'formatNikForDisplay', '_createTempAdminSession', 'adminBackupFull']) {
      reset(env.counters);
      const args = name.startsWith('do') ? [hostileEvent(env.counters)] : [hostile(env.counters), hostile(env.counters)];
      assertClosed(callCode(env.ctx[name], args), 'SIKAP_CUTOVER_STATE_INVALID', env.counters, `${JSON.stringify(v)}:${name}`);
    }
  }
  invokeAll(setup({ state: 'FROZEN' }), 'SIKAP_CUTOVER_STATE_INVALID');
});

test('property service unavailable fails closed without fallback or raw detail', () => {
  for (const props of ['missing', 'accessorThrows', 'getScriptPropertiesThrows', 'nullStore', 'getPropertyThrows']) {
    const env = setup({ state: 'open', props });
    invokeAll(env, 'SIKAP_CUTOVER_STATE_UNAVAILABLE', { expectReads: false });
    reset(env.counters);
    const r = callCode(env.ctx.doPost, [hostileEvent(env.counters)]);
    assertClosed(r, 'SIKAP_CUTOVER_STATE_UNAVAILABLE', env.counters, props);
    assert.doesNotMatch(r.err.message, /SECRET|open/);
  }
});

test('doPost: every whitelisted action is rejected while frozen without parsing the body', () => {
  const env = setup({ state: 'frozen' });
  const api = SOURCES['API.gs'];
  const block = api.slice(api.indexOf('var API_HANDLERS = {'), api.indexOf('};', api.indexOf('var API_HANDLERS = {')));
  const actions = [...block.matchAll(/^\s*([\w$]+):/gm)].map((m) => m[1]);
  assert.equal(actions.length, 38);
  for (const action of actions) {
    reset(env.counters);
    const e = {};
    let touched = 0;
    Object.defineProperty(e, 'parameter', { get() { touched++; return { action }; } });
    Object.defineProperty(e, 'postData', { get() { touched++; return { contents: '{"token":"t","nip":"1","password":"p"}' }; } });
    assertClosed(callCode(env.ctx.doPost, [e]), 'SIKAP_CUTOVER_FROZEN', env.counters, action);
    assert.equal(touched, 0, `${action}: request never read`);
    // Direct google.script.run style call is gated too.
    reset(env.counters);
    assertClosed(callCode(env.ctx[action], [hostile(env.counters), hostile(env.counters)]), 'SIKAP_CUTOVER_FROZEN', env.counters, `direct ${action}`);
  }
});

test('state is re-read on every call: no caching, no auto-thaw', () => {
  const env = setup({ state: 'open' });
  const call = () => callCode(env.ctx.formatNikForDisplay, ["'3171"]);
  assert.deepEqual(call(), { threw: false, value: '3171' });
  env.setState('frozen');
  assertClosed(call(), 'SIKAP_CUTOVER_FROZEN', env.counters, 'frozen after open');
  assertClosed(call(), 'SIKAP_CUTOVER_FROZEN', env.counters, 'still frozen');
  env.setState(null);
  assert.deepEqual(call(), { threw: false, value: '3171' });
  env.setState('frozen ');
  assertClosed(call(), 'SIKAP_CUTOVER_STATE_INVALID', env.counters, 'invalid after absent');
  env.setState('open');
  assert.deepEqual(call(), { threw: false, value: '3171' });
  assert.equal(env.counters.propReads.length, 6);
  assert.ok(env.counters.propReads.every((k) => k === KEY));
});

// -------------------------------------------- open/absent: contracts unchanged

function contentServiceMock() {
  return {
    MimeType: { JSON: 'application/json' },
    createTextOutput(text) {
      const out = { text, mime: null, setMimeType(m) { out.mime = m; return out; } };
      return out;
    },
  };
}

for (const state of ['open', null]) {
  test(`state ${JSON.stringify(state)}: pure helpers and validation contracts are unchanged`, () => {
    const env = setup({ state });
    const c = env.ctx;
    assert.equal(c.formatPhoneForStorage('+628123456789'), "'08123456789");
    assert.equal(c.formatPhoneForDisplay("'628123456789"), '08123456789');
    assert.equal(c.isValidPhoneNumber('08123456789'), true);
    assert.equal(c.isValidEmail('bad@'), false);
    assert.equal(c.escapeFormula('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(c.unescapeFormula("'=x"), '=x');
    assert.equal(c.formatNikForStorage(' 123 '), "'123");
    assert.equal(c.getDefaultPassword('199001012020121001'), '121001');
    assert.equal(c._mapPegawaiRowToObject(null), null);
    assert.equal(c._getColIdx(['A', 'Nama'], 'Nama', 9), 1);
    assert.equal(c.isNikDuplicate('', 'x'), false);
    assert.equal(c.validateSession(''), null);
    assert.deepEqual(JSON.parse(JSON.stringify(c.login('', ''))), { success: false, message: 'NIP dan Password harus diisi.' });
    assert.equal(env.counters.google, 0);
    assert.ok(env.counters.propReads.length > 0 && env.counters.propReads.every((k) => k === KEY));
    assert.equal(env.counters.propOther, 0);
  });

  test(`state ${JSON.stringify(state)}: doPost JSON contract unchanged`, () => {
    const env = setup({ state, services: { ContentService: contentServiceMock() } });
    const missing = env.ctx.doPost({ parameter: {} });
    assert.equal(missing.mime, 'application/json');
    assert.deepEqual(JSON.parse(missing.text), { success: false, message: "Parameter 'action' tidak ditemukan." });
    const unknown = env.ctx.doPost({ parameter: { action: 'eval' } });
    assert.deepEqual(JSON.parse(unknown.text), { success: false, message: "Action 'eval' tidak didukung atau tidak diizinkan." });
    const badJson = env.ctx.doPost({ parameter: { action: 'login' }, postData: { contents: '{' } });
    assert.deepEqual(JSON.parse(badJson.text), { success: false, message: 'Payload JSON tidak valid.' });
    const login = env.ctx.doPost({ parameter: { action: 'login' }, postData: { contents: '{}' } });
    assert.deepEqual(JSON.parse(login.text), { success: false, message: 'NIP dan Password harus diisi.' });
    assert.equal(env.counters.google, 0);
  });

  test(`state ${JSON.stringify(state)}: doGet still serves the SPA template`, () => {
    const calls = [];
    const chain = new Proxy({}, { get: (_, p) => (...a) => { calls.push([p, ...a]); return chain; } });
    const html = {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createTemplateFromFile(f) { calls.push(['createTemplateFromFile', f]); return chain; },
    };
    const env = setup({ state, services: { HtmlService: html } });
    assert.equal(env.ctx.doGet({}), chain);
    assert.deepEqual(calls[0], ['createTemplateFromFile', 'frontend/Index']);
    assert.deepEqual(calls.at(-1), ['setXFrameOptionsMode', 'ALLOWALL']);
  });
}
