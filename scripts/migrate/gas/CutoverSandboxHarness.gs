// ============================================================
// CutoverSandboxHarness.gs - SYNTHETIC guard rehearsal for the pinned helper
// ============================================================
//
// SYNTHETIC SANDBOX ONLY. Paste into a NEW standalone Apps Script project
// together with the verbatim pinned Cutover.gs helper. Never paste into a
// production, v76, v140 or copied project. No deploy, trigger, library or clasp.
//
// What this proves (when run in Google): the exact pinned assertCutoverOpen_
// text executes in the real Apps Script runtime, re-reads the real Script
// Property SIKAP_CUTOVER_STATE on every call (no cache), returns the fixed
// error codes, and denies before any body work for 43 synthetic direct
// stand-ins and 40 synthetic dispatcher handlers (dispatcher guard + handler
// guard). Stand-in labels are synthetic; this is NOT v140 feature validation,
// NOT full-source verification, NOT a deployment or live-freeze proof.
//
// What it does NOT claim: UNAVAILABLE faults, non-string property values and
// exact property-read counts are local VM evidence only (the real
// PropertiesService global is never replaced). Concurrent executions of this
// harness are not excluded; the operator must run it once at a time.
//
// Services used: PropertiesService (script properties), ScriptApp.getScriptId,
// Utilities.computeDigest, Logger.log. Nothing else.
//
// Property writes happen only through cutoverSandboxWrite_:
//   SIKAP_CUTOVER_SANDBOX_V1 - identity pin, written once on the first run
//                              after every preflight check passed;
//   SIKAP_CUTOVER_STATE      - fixed rehearsal values or delete, only inside
//                              the guarded run, restored to absent in finally.
// No blanket deletion; the operator confirm key and the pin are left in place.
//
// Entry point: runCutoverSandboxRehearsal_() (private). The operator runs it via
// a temporary editor wrapper and deletes the wrapper afterwards. It returns and
// logs exactly one safe summary (fixed codes, counts and booleans only).

var CUTOVER_SANDBOX_MANIFEST_ = /*@@MANIFEST@@*/null;

function cutoverSandboxKeys_() {
  return {
    state: 'SIKAP_CUTOVER_STATE',
    confirm: 'SIKAP_CUTOVER_SANDBOX_CONFIRM',
    pin: 'SIKAP_CUTOVER_SANDBOX_V1'
  };
}

function cutoverSandboxCodes_() {
  return [
    'SANDBOX_MANIFEST_INVALID', 'SANDBOX_LIVE_CODE_PRESENT', 'SANDBOX_HELPER_MISSING',
    'SANDBOX_HELPER_MISMATCH', 'SANDBOX_DIGEST_FAILED', 'SANDBOX_PROPERTIES_UNAVAILABLE',
    'SANDBOX_PROPERTY_KEYS_INVALID', 'SANDBOX_STATE_NOT_ABSENT', 'SANDBOX_CONFIRM_INVALID',
    'SANDBOX_SCRIPT_ID_UNAVAILABLE', 'SANDBOX_PIN_INVALID', 'SANDBOX_PIN_MISMATCH',
    'SANDBOX_PIN_WRITE_FAILED', 'SANDBOX_WRITE_REFUSED', 'SANDBOX_STATE_WRITE_FAILED',
    'SANDBOX_STATE_READBACK_MISMATCH', 'SANDBOX_DISPATCH_UNKNOWN', 'SANDBOX_CASE_FAILED',
    'SANDBOX_NO_CACHE_FAILED', 'SANDBOX_UNEXPECTED_ERROR', 'SANDBOX_RESTORE_FAILED',
    'SANDBOX_STATE_UNEXPECTED_MUTATION'
  ];
}

// Fixed rehearsal values. Absent is exercised separately via delete (null).
function cutoverSandboxStateValues_() {
  return ['open', 'frozen', '', ' ', '\t', 'FROZEN', 'Frozen', 'OPEN', 'Open', ' open', 'open ', 'frozen\n', 'closed'];
}

function cutoverSandboxNoCacheSteps_() {
  return ['open', 'frozen', null, 'frozen', 'Open', 'open', null];
}

function cutoverSandboxFail_(code) {
  var safe = cutoverSandboxCodes_().indexOf(code) >= 0 ? code : 'SANDBOX_UNEXPECTED_ERROR';
  var error = new Error(safe);
  error.sandboxCode = safe;
  throw error;
}

function cutoverSandboxSafeCode_(error) {
  var code = null;
  try {
    code = error && typeof error.sandboxCode === 'string' ? error.sandboxCode : null;
  } catch (ignored) {
    code = null;
  }
  return code !== null && cutoverSandboxCodes_().indexOf(code) >= 0 ? code : 'SANDBOX_UNEXPECTED_ERROR';
}

function cutoverSandboxSha256Hex_(text) {
  var bytes;
  try {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  } catch (e) {
    cutoverSandboxFail_('SANDBOX_DIGEST_FAILED');
  }
  if (!bytes || bytes.length !== 32) cutoverSandboxFail_('SANDBOX_DIGEST_FAILED');
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (Number(bytes[i]) + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function cutoverSandboxIsPlainObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function cutoverSandboxHasExactKeys_(value, expected) {
  var keys = Object.keys(value).sort();
  var want = expected.slice().sort();
  if (keys.length !== want.length) return false;
  for (var i = 0; i < want.length; i++) {
    if (keys[i] !== want[i]) return false;
  }
  return true;
}

function cutoverSandboxManifest_() {
  var m = CUTOVER_SANDBOX_MANIFEST_;
  if (!cutoverSandboxIsPlainObject_(m) || !cutoverSandboxHasExactKeys_(m, [
    'kind', 'version', 'nonce', 'helperFunctionSha256', 'directCases', 'handlerCases', 'realV140FeatureValidation'
  ])) cutoverSandboxFail_('SANDBOX_MANIFEST_INVALID');
  if (m.kind !== 'sikap-cutover-sandbox' || m.version !== 1 ||
    typeof m.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(m.nonce) ||
    typeof m.helperFunctionSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.helperFunctionSha256) ||
    m.directCases !== 43 || m.handlerCases !== 40 || m.realV140FeatureValidation !== false) {
    cutoverSandboxFail_('SANDBOX_MANIFEST_INVALID');
  }
  return { nonce: m.nonce, helperFunctionSha256: m.helperFunctionSha256, directCases: 43, handlerCases: 40 };
}

// Refuse projects that contain live SIKAP public entry points. Identifiers are
// only used as typeof operands; nothing is called or declared.
function cutoverSandboxLiveCodeAbsent_() {
  return typeof doGet === 'undefined' && typeof doPost === 'undefined' &&
    typeof API_HANDLERS === 'undefined' && typeof cleanExpiredSessions === 'undefined' &&
    typeof onOpen === 'undefined' && typeof onEdit === 'undefined';
}

// Exact source text of the pinned helper as seen by the runtime. No
// normalization: any CR or own toString override fails closed.
function cutoverSandboxHelperText_() {
  if (typeof assertCutoverOpen_ !== 'function') cutoverSandboxFail_('SANDBOX_HELPER_MISSING');
  var proto = Object.getPrototypeOf(cutoverSandboxKeys_);
  if (Object.getPrototypeOf(assertCutoverOpen_) !== proto ||
    Object.prototype.hasOwnProperty.call(assertCutoverOpen_, 'toString')) {
    cutoverSandboxFail_('SANDBOX_HELPER_MISMATCH');
  }
  var text = proto.toString.call(assertCutoverOpen_);
  if (typeof text !== 'string' || text.indexOf('\r') >= 0) cutoverSandboxFail_('SANDBOX_HELPER_MISMATCH');
  return text;
}

function cutoverSandboxRead_(store, key) {
  try {
    return store.getProperty(key);
  } catch (e) {
    cutoverSandboxFail_('SANDBOX_PROPERTIES_UNAVAILABLE');
  }
}

function cutoverSandboxListKeys_(store) {
  var raw;
  try {
    raw = store.getKeys();
  } catch (e) {
    cutoverSandboxFail_('SANDBOX_PROPERTIES_UNAVAILABLE');
  }
  if (!raw || typeof raw.length !== 'number' || raw.length > 16) cutoverSandboxFail_('SANDBOX_PROPERTY_KEYS_INVALID');
  var keys = [];
  for (var i = 0; i < raw.length; i++) keys.push(String(raw[i]));
  return keys.sort();
}

function cutoverSandboxScriptIdHash_() {
  var id;
  try {
    id = ScriptApp.getScriptId();
  } catch (e) {
    cutoverSandboxFail_('SANDBOX_SCRIPT_ID_UNAVAILABLE');
  }
  if (typeof id !== 'string' || id.length === 0) cutoverSandboxFail_('SANDBOX_SCRIPT_ID_UNAVAILABLE');
  return cutoverSandboxSha256Hex_(id);
}

function cutoverSandboxPinText_(nonce, scriptIdSha256) {
  return JSON.stringify({ kind: 'sikap-cutover-sandbox-pin', version: 1, nonce: nonce, scriptIdSha256: scriptIdSha256 });
}

function cutoverSandboxCheckPin_(text, nonce, scriptIdSha256) {
  var pin;
  try {
    pin = JSON.parse(text);
  } catch (e) {
    cutoverSandboxFail_('SANDBOX_PIN_INVALID');
  }
  if (!cutoverSandboxIsPlainObject_(pin) || !cutoverSandboxHasExactKeys_(pin, ['kind', 'version', 'nonce', 'scriptIdSha256']) ||
    pin.kind !== 'sikap-cutover-sandbox-pin' || pin.version !== 1 ||
    typeof pin.nonce !== 'string' || typeof pin.scriptIdSha256 !== 'string') {
    cutoverSandboxFail_('SANDBOX_PIN_INVALID');
  }
  if (pin.nonce !== nonce || pin.scriptIdSha256 !== scriptIdSha256) cutoverSandboxFail_('SANDBOX_PIN_MISMATCH');
}

// Every check runs before any property write. Failures throw a fixed code and
// never reach the restore phase, so pre-existing values are never touched.
function cutoverSandboxPreflight_(ctx) {
  var keys = cutoverSandboxKeys_();
  var manifest = cutoverSandboxManifest_();
  if (!cutoverSandboxLiveCodeAbsent_()) cutoverSandboxFail_('SANDBOX_LIVE_CODE_PRESENT');
  if (cutoverSandboxSha256Hex_(cutoverSandboxHelperText_()) !== manifest.helperFunctionSha256) {
    cutoverSandboxFail_('SANDBOX_HELPER_MISMATCH');
  }
  var store;
  try {
    store = PropertiesService.getScriptProperties();
  } catch (e) {
    cutoverSandboxFail_('SANDBOX_PROPERTIES_UNAVAILABLE');
  }
  if (!store) cutoverSandboxFail_('SANDBOX_PROPERTIES_UNAVAILABLE');
  if (cutoverSandboxRead_(store, keys.state) !== null) cutoverSandboxFail_('SANDBOX_STATE_NOT_ABSENT');
  var present = cutoverSandboxListKeys_(store);
  var first = present.length === 1 && present[0] === keys.confirm;
  var repeat = present.length === 2 && present[0] === keys.confirm && present[1] === keys.pin;
  if (!first && !repeat) cutoverSandboxFail_('SANDBOX_PROPERTY_KEYS_INVALID');
  if (cutoverSandboxRead_(store, keys.confirm) !== 'NEW-SYNTHETIC-SANDBOX:' + manifest.nonce) {
    cutoverSandboxFail_('SANDBOX_CONFIRM_INVALID');
  }
  var scriptIdSha256 = cutoverSandboxScriptIdHash_();
  if (repeat) cutoverSandboxCheckPin_(cutoverSandboxRead_(store, keys.pin), manifest.nonce, scriptIdSha256);
  ctx.store = store;
  ctx.firstRun = first;
  ctx.pinText = first ? cutoverSandboxPinText_(manifest.nonce, scriptIdSha256) : null;
  ctx.directCases = manifest.directCases;
  ctx.handlerCases = manifest.handlerCases;
}

// The ONLY place that writes or deletes Script Properties.
function cutoverSandboxWrite_(ctx, key, value) {
  var keys = cutoverSandboxKeys_();
  if (key === keys.pin) {
    if (!ctx.pinWriteAllowed || ctx.pinWrites !== 0 || typeof value !== 'string' || value !== ctx.pinText) {
      cutoverSandboxFail_('SANDBOX_WRITE_REFUSED');
    }
    ctx.pinWriteAllowed = false;
    ctx.pinWrites++;
    try {
      ctx.store.setProperty(key, value);
    } catch (e) {
      cutoverSandboxFail_('SANDBOX_PIN_WRITE_FAILED');
    }
    return;
  }
  if (key !== keys.state || !ctx.stateWritesAllowed) cutoverSandboxFail_('SANDBOX_WRITE_REFUSED');
  if (value !== null && (typeof value !== 'string' || cutoverSandboxStateValues_().indexOf(value) < 0)) {
    cutoverSandboxFail_('SANDBOX_WRITE_REFUSED');
  }
  // Ownership check BEFORE any mutation: the current value must be absent or a
  // value this run itself attempted to write. Readbacks never grant ownership.
  var current = cutoverSandboxRead_(ctx.store, key);
  if (current !== null && ctx.ownedValues.indexOf(current) < 0) cutoverSandboxFail_('SANDBOX_STATE_UNEXPECTED_MUTATION');
  if (value === null) {
    if (current === null) return;
    ctx.stateWrites++;
    // A thrown delete keeps ownership (ambiguous). A completed delete drops it:
    // any value seen afterwards is foreign and is never deleted.
    try {
      ctx.store.deleteProperty(key);
    } catch (e) {
      cutoverSandboxFail_('SANDBOX_STATE_WRITE_FAILED');
    }
    ctx.ownedValues = [];
    return;
  }
  // The attempted value is recorded BEFORE the setter so an ambiguous failure
  // still restores either the previous owned value or the attempted one.
  ctx.stateOwned = true;
  ctx.ownedValues.push(value);
  ctx.stateWrites++;
  try {
    ctx.store.setProperty(key, value);
  } catch (e) {
    cutoverSandboxFail_('SANDBOX_STATE_WRITE_FAILED');
  }
  ctx.ownedValues = [value];
}

function cutoverSandboxExpected_(value) {
  if (value === null || value === 'open') return 'ALLOW';
  if (value === 'frozen') return 'SIKAP_CUTOVER_FROZEN';
  return 'SIKAP_CUTOVER_STATE_INVALID';
}

function cutoverSandboxLabel_(prefix, n) {
  return prefix + (n < 10 ? '0' : '') + n;
}

// Synthetic direct / google.script.run-style stand-in: guard, then body.
function cutoverSandboxMakeDirect_(counters, index) {
  return function () {
    assertCutoverOpen_();
    counters.direct++;
    counters.lastDirect = index;
  };
}

// Synthetic guard-first handler reached through the dispatcher.
function cutoverSandboxMakeHandler_(counters, index) {
  return function () {
    assertCutoverOpen_();
    counters.handler++;
    counters.lastHandler = index;
  };
}

// Synthetic doPost-shaped dispatcher: guard before touching the event.
function cutoverSandboxMakeDispatcher_(counters, handlers) {
  return function (event) {
    assertCutoverOpen_();
    counters.dispatch++;
    var action = event.parameter.action;
    if (!Object.prototype.hasOwnProperty.call(handlers, action)) cutoverSandboxFail_('SANDBOX_DISPATCH_UNKNOWN');
    return handlers[action]();
  };
}

function cutoverSandboxEvent_(counters, action) {
  var event = {};
  Object.defineProperty(event, 'parameter', {
    get: function () {
      counters.eventReads++;
      return { action: action };
    }
  });
  return event;
}

function cutoverSandboxNewCounters_() {
  return { direct: 0, handler: 0, dispatch: 0, eventReads: 0, lastDirect: -1, lastHandler: -1 };
}

function cutoverSandboxResetCounters_(counters) {
  counters.direct = 0;
  counters.handler = 0;
  counters.dispatch = 0;
  counters.eventReads = 0;
  counters.lastDirect = -1;
  counters.lastHandler = -1;
}

function cutoverSandboxStandins_(counters, directCases, handlerCases) {
  var direct = [];
  var handlers = {};
  var labels = [];
  for (var i = 0; i < directCases; i++) direct.push(cutoverSandboxMakeDirect_(counters, i));
  for (var j = 0; j < handlerCases; j++) {
    var label = cutoverSandboxLabel_('syntheticHandler', j + 1);
    labels.push(label);
    handlers[label] = cutoverSandboxMakeHandler_(counters, j);
  }
  return { direct: direct, labels: labels, dispatcher: cutoverSandboxMakeDispatcher_(counters, handlers) };
}

function cutoverSandboxOutcome_(fn, arg) {
  try {
    fn(arg);
    return 'ALLOW';
  } catch (e) {
    var message = null;
    try {
      message = e && typeof e.message === 'string' ? e.message : null;
    } catch (ignored) {
      message = null;
    }
    if (message === 'SIKAP_CUTOVER_FROZEN' || message === 'SIKAP_CUTOVER_STATE_INVALID' ||
      message === 'SIKAP_CUTOVER_STATE_UNAVAILABLE') return message;
    return 'OTHER';
  }
}

// One synthetic call; returns { ok, effects } with denial side effects counted.
function cutoverSandboxProbe_(ctx, standins, kind, index, expected) {
  var c = ctx.counters;
  cutoverSandboxResetCounters_(c);
  var outcome = kind === 'direct'
    ? cutoverSandboxOutcome_(standins.direct[index], undefined)
    : cutoverSandboxOutcome_(standins.dispatcher, cutoverSandboxEvent_(c, standins.labels[index]));
  var effects = c.direct + c.handler + c.dispatch + c.eventReads;
  var ok;
  if (expected !== 'ALLOW') {
    ok = outcome === expected && effects === 0;
  } else if (kind === 'direct') {
    ok = outcome === 'ALLOW' && c.direct === 1 && c.lastDirect === index && effects === 1;
  } else {
    ok = outcome === 'ALLOW' && c.dispatch === 1 && c.eventReads === 1 && c.handler === 1 &&
      c.lastHandler === index && effects === 3;
  }
  return { ok: ok, effects: effects };
}

function cutoverSandboxTally_(report, kind, expected, probe) {
  if (kind === 'direct') report.directChecks++;
  else report.handlerChecks++;
  if (probe.ok) report.checksPassed++;
  else report.checksFailed++;
  if (expected !== 'ALLOW') {
    report.denialChecks++;
    report.denialSideEffects += probe.effects;
  }
}

// Writes one state, reads it back and returns the expected guard outcome for
// the value actually stored, or null when the value could not be exercised.
// A differing readback is only counted; it never grants delete ownership, so
// the next write or the restore stops with SANDBOX_STATE_UNEXPECTED_MUTATION.
function cutoverSandboxApplyState_(ctx, value) {
  var keys = cutoverSandboxKeys_();
  cutoverSandboxWrite_(ctx, keys.state, value);
  var readback = cutoverSandboxRead_(ctx.store, keys.state);
  if (readback !== value) {
    if (value === '' && readback === null) {
      ctx.report.emptyStringReadback = 'null';
    } else {
      ctx.report.readbackMismatches++;
      return null;
    }
  } else if (value === '') {
    ctx.report.emptyStringReadback = 'empty';
  }
  return cutoverSandboxExpected_(readback);
}

function cutoverSandboxRunCase_(ctx, standins, value) {
  var report = ctx.report;
  report.stateCases++;
  var expected = cutoverSandboxApplyState_(ctx, value);
  if (expected === null) return;
  var failedBefore = report.checksFailed;
  for (var i = 0; i < ctx.directCases; i++) {
    cutoverSandboxTally_(report, 'direct', expected, cutoverSandboxProbe_(ctx, standins, 'direct', i, expected));
  }
  for (var j = 0; j < ctx.handlerCases; j++) {
    cutoverSandboxTally_(report, 'handler', expected, cutoverSandboxProbe_(ctx, standins, 'handler', j, expected));
  }
  if (report.checksFailed === failedBefore) report.stateCasesPassed++;
}

// Same closures across state flips: proves the state is re-read per call.
function cutoverSandboxRunNoCache_(ctx, standins) {
  var steps = cutoverSandboxNoCacheSteps_();
  for (var i = 0; i < steps.length; i++) {
    ctx.report.noCacheSteps++;
    var expected = cutoverSandboxApplyState_(ctx, steps[i]);
    if (expected === null) continue;
    var a = cutoverSandboxProbe_(ctx, standins, 'direct', 0, expected);
    var b = cutoverSandboxProbe_(ctx, standins, 'direct', 0, expected);
    var d = cutoverSandboxProbe_(ctx, standins, 'handler', 0, expected);
    if (expected !== 'ALLOW') ctx.report.denialSideEffects += a.effects + b.effects + d.effects;
    if (a.ok && b.ok && d.ok) ctx.report.noCachePassed++;
  }
}

function cutoverSandboxRunCode_(report) {
  if (report.readbackMismatches !== 0) return 'SANDBOX_STATE_READBACK_MISMATCH';
  if (report.checksFailed !== 0 || report.denialSideEffects !== 0 ||
    report.stateCasesPassed !== report.stateCases) return 'SANDBOX_CASE_FAILED';
  if (report.noCachePassed !== report.noCacheSteps) return 'SANDBOX_NO_CACHE_FAILED';
  return 'CUTOVER_SANDBOX_PASSED';
}

// Restores SIKAP_CUTOVER_STATE to absent and verifies it. Deletes only a value
// this run itself wrote or attempted to write (ambiguous setter failure);
// anything else is reported as SANDBOX_STATE_UNEXPECTED_MUTATION, never deleted.
function cutoverSandboxRestore_(ctx) {
  var keys = cutoverSandboxKeys_();
  var current;
  try {
    current = ctx.store.getProperty(keys.state);
  } catch (e) {
    return 'SANDBOX_RESTORE_FAILED';
  }
  if (current === null) {
    ctx.report.stateAbsentAfterVerified = true;
    return null;
  }
  if (!ctx.stateOwned || ctx.ownedValues.indexOf(current) < 0) return 'SANDBOX_STATE_UNEXPECTED_MUTATION';
  try {
    cutoverSandboxWrite_(ctx, keys.state, null);
    current = ctx.store.getProperty(keys.state);
  } catch (e) {
    return 'SANDBOX_RESTORE_FAILED';
  }
  if (current !== null) return 'SANDBOX_RESTORE_FAILED';
  ctx.report.stateAbsentAfterVerified = true;
  return null;
}

function cutoverSandboxGuardedRun_(ctx) {
  var runCode = 'SANDBOX_UNEXPECTED_ERROR';
  var restoreCode = 'SANDBOX_RESTORE_FAILED';
  ctx.stateWritesAllowed = true;
  ctx.report.restorePhaseEntered = true;
  try {
    var standins = cutoverSandboxStandins_(ctx.counters, ctx.directCases, ctx.handlerCases);
    var values = [null].concat(cutoverSandboxStateValues_());
    for (var i = 0; i < values.length; i++) cutoverSandboxRunCase_(ctx, standins, values[i]);
    cutoverSandboxRunNoCache_(ctx, standins);
    runCode = cutoverSandboxRunCode_(ctx.report);
  } catch (e) {
    runCode = cutoverSandboxSafeCode_(e);
  } finally {
    try {
      restoreCode = cutoverSandboxRestore_(ctx);
    } catch (e) {
      restoreCode = 'SANDBOX_RESTORE_FAILED';
    }
    ctx.stateWritesAllowed = false;
  }
  return restoreCode !== null ? restoreCode : runCode;
}

function cutoverSandboxNewReport_() {
  return {
    preflightPassed: false, firstRun: false, pinWritten: false, restorePhaseEntered: false,
    stateAbsentAfterVerified: false, stateCases: 0, stateCasesPassed: 0, directChecks: 0,
    handlerChecks: 0, checksPassed: 0, checksFailed: 0, denialChecks: 0, denialSideEffects: 0,
    noCacheSteps: 0, noCachePassed: 0, readbackMismatches: 0, emptyStringReadback: 'notRun'
  };
}

function cutoverSandboxSummary_(ctx, code) {
  var r = ctx.report;
  var passed = code === 'CUTOVER_SANDBOX_PASSED';
  return {
    kind: 'sikap-cutover-sandbox-report',
    version: 1,
    code: code,
    passed: passed,
    evidenceScope: 'synthetic-guard-rehearsal',
    preflightPassed: r.preflightPassed,
    firstRun: r.firstRun,
    pinWritten: r.pinWritten,
    restorePhaseEntered: r.restorePhaseEntered,
    stateAbsentAfterVerified: r.stateAbsentAfterVerified,
    directCases: 43,
    handlerCases: 40,
    stateCases: r.stateCases,
    stateCasesPassed: r.stateCasesPassed,
    directChecks: r.directChecks,
    handlerChecks: r.handlerChecks,
    checksPassed: r.checksPassed,
    checksFailed: r.checksFailed,
    denialChecks: r.denialChecks,
    denialSideEffects: r.denialSideEffects,
    noCacheSteps: r.noCacheSteps,
    noCachePassed: r.noCachePassed,
    readbackMismatches: r.readbackMismatches,
    emptyStringReadback: r.emptyStringReadback,
    stateWrites: ctx.stateWrites,
    pinWrites: ctx.pinWrites,
    unavailableVerified: false,
    nonStringVerified: false,
    readCountsMeasured: false,
    singleExecutionAssumed: true,
    sandboxRuntimeVerified: passed,
    realV140FeatureValidation: false,
    deploymentAuthorized: false,
    runtimeFrozenVerified: false,
    remoteAuthorized: false,
    goLiveAuthorized: false
  };
}

function runCutoverSandboxRehearsal_() {
  var ctx = {
    report: cutoverSandboxNewReport_(), counters: cutoverSandboxNewCounters_(), store: null,
    firstRun: false, pinText: null, pinWriteAllowed: false, pinWrites: 0,
    stateWritesAllowed: false, stateWrites: 0, stateOwned: false, ownedValues: [],
    directCases: 0, handlerCases: 0
  };
  var code = 'SANDBOX_UNEXPECTED_ERROR';
  try {
    cutoverSandboxPreflight_(ctx);
    ctx.report.preflightPassed = true;
    ctx.report.firstRun = ctx.firstRun;
    if (ctx.firstRun) {
      var keys = cutoverSandboxKeys_();
      ctx.pinWriteAllowed = true;
      cutoverSandboxWrite_(ctx, keys.pin, ctx.pinText);
      if (cutoverSandboxRead_(ctx.store, keys.pin) !== ctx.pinText) cutoverSandboxFail_('SANDBOX_PIN_WRITE_FAILED');
      ctx.report.pinWritten = true;
    }
    code = cutoverSandboxGuardedRun_(ctx);
  } catch (e) {
    code = cutoverSandboxSafeCode_(e);
  }
  var summary = cutoverSandboxSummary_(ctx, code);
  try {
    Logger.log(JSON.stringify(summary));
  } catch (ignored) {
    // Logging failure must not change the returned summary.
  }
  return summary;
}
