// ============================================================
// Cutover.gs — Fail-closed maintenance gate for the legacy runtime
// ============================================================
//
// PREPARATION ONLY. This file adds a read-only gate; it never writes
// properties, exposes no setter, no HTTP/public endpoint and no trigger.
//
// Contract (Script Property `SIKAP_CUTOVER_STATE`, read on EVERY call,
// never cached, no auto-expiry, no auto-thaw):
//   absent (null) or exactly 'open'  -> allowed
//   exactly 'frozen'                 -> throws Error('SIKAP_CUTOVER_FROZEN')
//   any other value ('' / whitespace / 'FROZEN' / 'Open' / non-string)
//                                    -> throws Error('SIKAP_CUTOVER_STATE_INVALID')
//   PropertiesService missing/denied/failing
//                                    -> throws Error('SIKAP_CUTOVER_STATE_UNAVAILABLE')
// Errors carry only the fixed code: no raw property value, no cause, no logging.
//
// Every top-level backend function calls `assertCutoverOpen_();` as its first
// statement, so google.script.run, doGet, doPost, the doPost whitelist and
// editor-run helpers are denied before any Sheets/Drive/UrlFetch/Utilities
// access. The trailing underscore keeps this helper private (not callable via
// google.script.run). It must not call any other backend function.
//
// LIMITS: this denies NEW calls only. It does not abort executions already in
// flight, does not take a LockService lock, and does not stop external
// Sheets/Drive editors, time-driven triggers or older deployed versions. The
// operator must pause those writers and drain in-flight executions for the
// maximum execution window before any final export. A frozen doPost throws
// outside its JSON try/catch, so callers get the Apps Script error transport
// instead of a JSON body; that is the intended maintenance response.

function assertCutoverOpen_() {
  var key = 'SIKAP_CUTOVER_STATE';
  var state;
  try {
    state = PropertiesService.getScriptProperties().getProperty(key);
  } catch (e) {
    throw new Error('SIKAP_CUTOVER_STATE_UNAVAILABLE');
  }
  if (state === null || state === 'open') return;
  if (state === 'frozen') throw new Error('SIKAP_CUTOVER_FROZEN');
  throw new Error('SIKAP_CUTOVER_STATE_INVALID');
}
