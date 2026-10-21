// SIKAP APPROVED single-target synthetic proof OPERATOR DRIVER (one fixed remote target only).
// PERMANENTLY RETIRED: executeApprovedProof() and the CLI always return STOPPED_RETIRED/DRIVER_RETIRED
// with zero I/O (see RETIRED_RESULT). The usage below is historical evidence only.
//
//   node scripts/import/run-approved-proof.mjs              one-shot remote run (reads OAuth, HTTP)
//   node scripts/import/run-approved-proof.mjs --check-only static pins only (no credential, no HTTP)
//
// Scope and limits:
//   * Target is a module constant (account/database/name/bucket); no argv, env or config input. The
//     identity is bound only by the exact endpoint URL (parent created/verified the id; no GET here).
//   * Order, each gate stops on the first unexpected result (no retry, resume, fallback or cleanup):
//     static pins -> OAuth read -> wire probe (exact read-only batch) -> empty-target check (read-only)
//     -> setup (pinned migrations 0001..0008 + pinned ledger DDL, one {sql, params:[]} per statement)
//     -> baseline (7 static SELECTs) -> descriptor/manifest build -> run-row bootstrap -> 11-step proof.
//     A rerun stops at the empty-target check before any mutation.
//   * Credential: Wrangler OAuth file at an explicit constant path, read only after the static gate,
//     only oauth_token + expiration_time are extracted; expired/near-expiry fails closed (no reauth).
//     The token lives in memory only; it is never printed, returned or logged.
//   * Every request passes one gate: POST to the exact endpoint, redirect:'error', bounded body,
//     fixed request budget. Responses: 30 s deadline, 1 MiB cap, JSON content type, strict envelope.
//   * Output: one JSON summary of codes/counts/flags; diagnostics carry key names/types, counts and
//     numeric provider error codes only (no provider text, SQL, params, rows, nonces, token, paths).
//   * Synthetic rows and schema remain on the target after any outcome (manual review; no cleanup).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { isMain, splitMigration } from '../migrate/local-store.mjs';
import { COLUMNS, LEDGER, PRIMARY, validateDescriptor } from './core.mjs';
import { LEDGER_DDL_SHA256, LEDGER_SQL_FILE, validateLedgerSql } from './ledger-contract.mjs';
import { PROOF_STEPS, buildD1V2Proof, proofScenarioSha256, runD1V2Proof } from './d1-v2-proof.mjs';

export const TARGET = Object.freeze({
  accountId: '04b8b2073be2f1aa21fc6489e0db36f6', databaseId: 'e54f0a4a-27b3-412d-9ad0-ea8dd2c7b6c1',
  databaseName: 'sikap-import-proof-20261018', bucket: 'sikap-import-proof-20261018-files',
});
export const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${TARGET.accountId}/d1/database/${TARGET.databaseId}/query`;
const CREDENTIAL_PATH = 'C:\\Users\\elwin\\AppData\\Roaming\\xdg.config\\.wrangler\\config\\default.toml';
const ROOT = new URL('../../', import.meta.url);
const TIMEOUT_MS = 30_000, MAX_RESPONSE_BYTES = 1024 * 1024, MAX_REQUEST_BYTES = 128 * 1024;
const MIN_CREDENTIAL_TTL_MS = 15 * 60 * 1000, DESCRIPTOR_TTL_MS = 60 * 60 * 1000;
const MIGRATION_PINS = Object.freeze([
  ['0001_init.sql', 'bb47096b7f68350cb5040c5d8fd4060bd2315dc0f32e493f641ac9276b2bd171'],
  ['0002_seed_reference.sql', 'f0d7c90d8e8ccf7e265bdb3753038c7be6cdbf5761f8e97516a25738f1099f0b'],
  ['0003_versi_uploaded_by.sql', 'de85d455cb9e4799040d477f15758e77c9089acabfee442f4ccded0f8b0ebdf8'],
  ['0004_riwayat_integrity.sql', '1513436a4d98c15c3c06d400020b3c8f8f188455b945cea3011d15011fa2c736'],
  ['0005_outbox_leases.sql', 'd98771fb386f5a1ef32c811976d477a3edda86d114cd9f8f0e4d4cd79ab47ba0'],
  ['0006_admin_jenis.sql', '56073c4d59e6c49336e91cde0735c7eb7b4701022650de385c8b453a88ae73f3'],
  ['0007_r2_purge_queue.sql', '422fd699b2cbdec06f039725769aaf7e49b9a134680996141089756f579a1701'],
  ['0008_backup_jobs.sql', 'cd7c04c559a3eb67aab26737ff3216ce490b40da60066933c9be570f471cbbd3'],
]);
// SHA-256 of LF-normalized module text; current runtime must match reviewed maintenance pins.
// Historical remote proof used driver 0386ac2c99e2990f09f8d888606c2e2aad1ddbb555233cb25009d402aaad1255
// and runner f05ea08aa42a789b4bbe6571739d4696092e9fd1e71007635bcac2de2473481b. No remote rerun accompanies this pin refresh.
const MODULE_PINS = Object.freeze([
  ['scripts/import/d1-v2-proof.mjs', '6ecc44f3b1d7d43e113de899db4d28e8116abc646c1c7358ccf12b8c4d3e2466'],
  ['scripts/import/core.mjs', '3f85c5d4b2038d6b689556c7ff857b6d4cb31cab6f82d6302c2f4f7c2e09d520'],
  ['scripts/import/d1-rest.mjs', 'ec67df176ce09ba9aeaa2992b271b31a1dbd779d6facc61a920a2da4892e97bd'],
  ['scripts/import/d1-readback.mjs', 'a4237657ef77a1ac5611d6f265950d8fcfaecc0f3089818794633ab9d082aa48'],
  ['scripts/import/ledger-contract.mjs', 'fdfbd5d58dcc91a2f29d427c3f21ab3cef7e261b90f5767664c9fb1245b5fc16'],
  ['scripts/import/synthetic-runner.mjs', 'cfb569b6a97cec4a544f11b53b3f932f520d89d6be26ec93c7355d40bd973756'],
  ['scripts/migrate/local-store.mjs', 'a6852f3020c164646ffde4aaf4fbc37973d5953a82c4bb99b7ed24c54033622b'],
]);
const APP_SCHEMA_SHA256 = '143fef6ecb05c450c38b697e6524d9c5e12072ef819c95d052fb210f323c7f72';
const SETUP_STATEMENT_COUNT = 67;
const PROBE_BODY = JSON.stringify({ batch: [{ sql: 'SELECT 1 AS proof_wire', params: [] }] });
const EMPTY_BODY = JSON.stringify({ batch: [{ sql: "SELECT count(*) AS user_objects FROM sqlite_master WHERE substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_'", params: [] }] });
const BASELINE_BODY = JSON.stringify({ batch: IMPORT_TABLES.map((t) => ({ sql: `SELECT ${COLUMNS[t].join(', ')} FROM ${t} ORDER BY ${PRIMARY[t].join(', ')}`, params: [] })) });
const BOOTSTRAP_SQL = `INSERT INTO ${LEDGER.runTable} (${LEDGER.runColumns.join(', ')}) VALUES (${LEDGER.runColumns.map((_, i) => `json_extract(?1, '$[${i}]')`).join(', ')})`;
const MAX_REQUESTS = 2 + SETUP_STATEMENT_COUNT + 1 + 1 + (1 + 2 * PROOF_STEPS.length);
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const JSON_TYPE = /^application\/json\s*(;.*)?$/i;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
class Stop { constructor(status, code) { this.status = status; this.code = code; } }
const need = (ok, status, code) => { if (!ok) throw new Stop(status, code); };
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const exactKeys = (o, keys, optional = []) => isObj(o) && Object.keys(o).every((k) => keys.includes(k) || optional.includes(k)) && keys.every((k) => Object.hasOwn(o, k));
// Same bound as d1-rest/d1-readback meta validation (shape only, never reflected).
function boundedJson(v, depth) {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 1024;
  if (depth >= 4 || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.length <= 32 && v.every((x) => boundedJson(x, depth + 1));
  const keys = Object.keys(v);
  return Object.getPrototypeOf(v) === Object.prototype && keys.length <= 32 && keys.every((k) => boundedJson(v[k], depth + 1));
}
const cellOk = (v) => v === null || (Number.isSafeInteger(v) && !Object.is(v, -0)) || (typeof v === 'string' && !v.includes('\0') && v.isWellFormed());
function quiet(fn) { try { const p = fn(); if (p && typeof p.then === 'function') p.then(undefined, () => {}); } catch { /* ignore */ } }

// ---- static gate (no credential, no HTTP) ----
function staticCheck(now) {
  try {
    const names = readdirSync(new URL('migrations/', ROOT)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
    need(JSON.stringify(names) === JSON.stringify(MIGRATION_PINS.map((p) => p[0])), 'STOPPED_STATIC_CHECK', 'MIGRATION_SET_MISMATCH');
    const statements = [];
    for (const [name, pin] of MIGRATION_PINS) {
      const text = readFileSync(new URL(`migrations/${name}`, ROOT), 'utf8');
      need(!text.includes('\r') && sha256(text) === pin, 'STOPPED_STATIC_CHECK', 'MIGRATION_HASH_MISMATCH');
      statements.push(...splitMigration(text));
    }
    need(sha256(JSON.stringify(['sikap-app-migrations', 1, MIGRATION_PINS])) === APP_SCHEMA_SHA256, 'STOPPED_STATIC_CHECK', 'APP_SCHEMA_PIN_MISMATCH');
    const ddl = readFileSync(new URL(LEDGER_SQL_FILE, ROOT), 'utf8');
    need(validateLedgerSql(ddl).valid === true, 'STOPPED_STATIC_CHECK', 'LEDGER_HASH_MISMATCH');
    statements.push(...splitMigration(ddl.replace(/\r\n/g, '\n')));
    need(statements.length === SETUP_STATEMENT_COUNT && statements.every((s) => Buffer.byteLength(JSON.stringify({ sql: s, params: [] })) <= MAX_REQUEST_BYTES), 'STOPPED_STATIC_CHECK', 'SETUP_COUNT_MISMATCH');
    for (const [file, pin] of MODULE_PINS) {
      need(sha256(readFileSync(new URL(file, ROOT), 'utf8').replace(/\r\n/g, '\n')) === pin, 'STOPPED_STATIC_CHECK', 'MODULE_PIN_MISMATCH');
    }
    const h = sha256('sikap-approved-proof-static-target-check');
    try { validateDescriptor(descriptorFor({ baselineSha256: h, scenarioSha256: h, nowMs: Date.parse(now) }), now); } catch { need(false, 'STOPPED_STATIC_CHECK', 'TARGET_DENIED'); }
    return Object.freeze(statements);
  } catch (error) { if (error instanceof Stop) throw error; throw new Stop('STOPPED_STATIC_CHECK', 'STATIC_READ_FAILED'); }
}

function descriptorFor({ baselineSha256, scenarioSha256, nowMs }) {
  let runNonce, ownerNonce;
  do { runNonce = randomBytes(16).toString('hex'); ownerNonce = randomBytes(16).toString('hex'); } while (runNonce === ownerNonce || !/[^0]/.test(runNonce) || !/[^0]/.test(ownerNonce));
  return {
    format: 'sikap-remote-import-descriptor', version: 1, ...TARGET, profile: 'synthetic', snapshotId: randomUUID(),
    sourceSha256: sha256(JSON.stringify(['sikap-approved-proof-source', 1, 'synthetic-fixture', scenarioSha256])),
    planSha256: scenarioSha256, appSchemaSha256: APP_SCHEMA_SHA256, ledgerSchemaSha256: LEDGER_DDL_SHA256, baselineSha256,
    policySha256: sha256(JSON.stringify(['sikap-approved-proof-policy', 1, TARGET, 'probe-empty-setup-baseline-bootstrap-proof', 'no-retry', 'no-cleanup'])),
    retentionPolicySha256: sha256(JSON.stringify(['sikap-approved-proof-retention', 1, 'synthetic-rows-remain-manual-review'])),
    runNonce, ownerNonce, epoch: 0, expiresAt: new Date(nowMs + DESCRIPTOR_TTL_MS).toISOString(),
  };
}

// ---- credential (explicit protected path; only on a real run, after the static gate) ----
async function readWranglerOAuth() {
  const st = await lstat(CREDENTIAL_PATH);
  if (!st.isFile() || st.size > 64 * 1024) throw new Error('CREDENTIAL');
  const text = await readFile(CREDENTIAL_PATH, 'utf8');
  const pick = (key) => {
    const found = [...text.matchAll(new RegExp(`^${key}[ \\t]*=[ \\t]*"([^"\\\\\\r\\n]*)"[ \\t\\r]*$`, 'gm'))];
    if (found.length !== 1) throw new Error('CREDENTIAL');
    return found[0][1];
  };
  return { token: pick('oauth_token'), expiresAt: pick('expiration_time') };
}

// ---- transport (every request through the gate) ----
function gate(fetchImpl, ctx) {
  return (url, init) => {
    if (url !== ENDPOINT || init?.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string' ||
      Buffer.byteLength(init.body, 'utf8') > MAX_REQUEST_BYTES || ctx.requests >= MAX_REQUESTS) {
      ctx.blockedRequests++;
      return Promise.reject(new Error('BLOCKED'));
    }
    ctx.requests++;
    return Promise.resolve().then(() => fetchImpl(url, init));
  };
}
async function readCapped(body, signal) {
  if (!body || typeof body.getReader !== 'function') return 'BODY_INVALID';
  const reader = body.getReader(), parts = [], onAbort = () => quiet(() => reader.cancel());
  let total = 0;
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return 'TIMEOUT';
      if (done) break;
      if (!(value instanceof Uint8Array)) { quiet(() => reader.cancel()); return 'BODY_INVALID'; }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { quiet(() => reader.cancel()); return 'BODY_OVERSIZE'; }
      parts.push(value);
    }
  } catch { return signal.aborted ? 'TIMEOUT' : 'BODY_INVALID'; } finally {
    signal.removeEventListener('abort', onAbort);
    quiet(() => reader.releaseLock());
  }
  return Buffer.concat(parts);
}
async function post(ctx, body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('TIMEOUT')), { once: true }));
  aborted.catch(() => {});
  let response = null, pending = null;
  try {
    try {
      pending = ctx.fetch(ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
        body, redirect: 'error', cache: 'no-store', signal: controller.signal });
      response = await Promise.race([pending, aborted]);
    } catch { return { status: null, code: controller.signal.aborted ? 'TIMEOUT' : 'FETCH_FAILED' }; }
    if (response === null || typeof response !== 'object') return { status: null, code: 'RESPONSE_INVALID' };
    const status = Number.isSafeInteger(response.status) ? response.status : null;
    if (response.redirected === true || (response.url && response.url !== ENDPOINT)) return { status, code: 'REDIRECTED' };
    const type = response.headers?.get?.('content-type');
    if (typeof type !== 'string' || !JSON_TYPE.test(type)) return { status, code: 'CONTENT_TYPE' };
    const bytes = await readCapped(response.body, controller.signal);
    response = null;
    if (typeof bytes === 'string') return { status, code: bytes };
    let json;
    try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return { status, code: 'BODY_INVALID' }; }
    return { status, json, code: status !== null && status >= 200 && status <= 299 ? null : 'HTTP_STATUS' };
  } finally {
    clearTimeout(timer);
    if (response !== null) quiet(() => response.body?.cancel?.());
    // A response settling after the deadline is discarded unread.
    pending?.then((late) => { if (controller.signal.aborted && late !== response) quiet(() => late?.body?.cancel?.()); }, () => {});
  }
}
// Strict envelope (same contract as d1-rest/d1-readback): returns per-statement row arrays or null.
function envelope(json, n) {
  if (!exactKeys(json, ['result', 'errors', 'messages', 'success']) || json.success !== true || !Array.isArray(json.errors) || json.errors.length !== 0 ||
    !Array.isArray(json.messages) || json.messages.length !== 0 || !Array.isArray(json.result) || json.result.length !== n) return null;
  const out = [];
  for (const r of json.result) {
    if (!exactKeys(r, ['success', 'results'], ['meta']) || r.success !== true || !Array.isArray(r.results)) return null;
    if (Object.hasOwn(r, 'meta') && !(isObj(r.meta) && boundedJson(r.meta, 0))) return null;
    out.push(r.results);
  }
  return out;
}
// Sanitized shape only: key names/types, counts, numeric error codes. Never text or values.
function diagnose(res) {
  const j = res.json, keys = (o) => (isObj(o) ? Object.keys(o).filter((k) => /^[A-Za-z_]{1,32}$/.test(k)).sort().slice(0, 16).map((k) => `${k}:${typeOf(o[k])}`) : null);
  const errors = Array.isArray(j?.errors) ? j.errors : [];
  return {
    httpStatus: res.status ?? null, code: res.code ?? null, topKeys: keys(j), success: typeof j?.success === 'boolean' ? j.success : null,
    errorsCount: Array.isArray(j?.errors) ? j.errors.length : null, errorCodes: errors.slice(0, 10).map((e) => e?.code).filter(Number.isSafeInteger),
    messagesCount: Array.isArray(j?.messages) ? j.messages.length : null, resultType: isObj(j) ? typeOf(j.result) : null,
    resultLength: Array.isArray(j?.result) ? j.result.length : null, firstResultKeys: Array.isArray(j?.result) ? keys(j.result[0]) : null,
    firstRowsLength: Array.isArray(j?.result?.[0]?.results) ? j.result[0].results.length : null,
  };
}
async function call(ctx, body, n, failStatus) {
  const res = await post(ctx, body);
  ctx.httpStatus = res.status ?? null;
  const rows = res.code === null ? envelope(res.json, n) : null;
  if (rows === null) {
    ctx.diagnostic = diagnose(res);
    const auth = res.status === 401 || res.status === 403;
    throw new Stop(auth ? 'STOPPED_AUTH' : failStatus, auth ? 'HTTP_AUTH' : res.code ?? 'ENVELOPE_INVALID');
  }
  return { rows, res };
}

// ---- flow ----
async function execute(ctx, options) {
  ctx.phase = 'STATIC_CHECK';
  const statements = staticCheck(new Date().toISOString());
  ctx.setupStatements.planned = statements.length;
  if (options.checkOnly) return 'CHECK_ONLY_OK';

  ctx.phase = 'CREDENTIAL';
  let credential;
  try { credential = await options.readCredential(); } catch { throw new Stop('STOPPED_CREDENTIAL', 'CREDENTIAL_UNAVAILABLE'); }
  const token = credential?.token, expiresMs = typeof credential?.expiresAt === 'string' ? Date.parse(credential.expiresAt) : NaN;
  need(typeof token === 'string' && token.length >= 20 && token.length <= 4096 && TOKEN.test(token), 'STOPPED_CREDENTIAL', 'CREDENTIAL_INVALID');
  need(Number.isFinite(expiresMs) && expiresMs - Date.now() >= MIN_CREDENTIAL_TTL_MS, 'STOPPED_CREDENTIAL', 'CREDENTIAL_EXPIRED');
  ctx.token = token;
  ctx.fetch = gate(options.fetchImpl, ctx);

  ctx.phase = 'WIRE_PROBE';
  const probe = await call(ctx, PROBE_BODY, 1, 'STOPPED_WIRE_INCOMPATIBLE');
  const p = probe.rows[0];
  if (!(p.length === 1 && exactKeys(p[0], ['proof_wire']) && p[0].proof_wire === 1)) {
    ctx.diagnostic = diagnose(probe.res);
    throw new Stop('STOPPED_WIRE_INCOMPATIBLE', 'PROBE_ROW_MISMATCH');
  }
  ctx.wireContractObserved = true;

  ctx.phase = 'EMPTY_CHECK';
  const empty = (await call(ctx, EMPTY_BODY, 1, 'STOPPED_RESPONSE_INVALID')).rows[0];
  need(empty.length === 1 && exactKeys(empty[0], ['user_objects']) && Number.isSafeInteger(empty[0].user_objects), 'STOPPED_RESPONSE_INVALID', 'EMPTY_CHECK_SHAPE');
  need(empty[0].user_objects === 0, 'STOPPED_TARGET_NOT_EMPTY', 'USER_OBJECTS_PRESENT');
  ctx.targetEmptyObserved = true;

  ctx.phase = 'SETUP';
  for (const sql of statements) {
    ctx.mutatingRequests++;
    const { rows } = await call(ctx, JSON.stringify({ sql, params: [] }), 1, 'STOPPED_SETUP_FAILED');
    need(rows[0].length === 0, 'STOPPED_SETUP_FAILED', 'SETUP_ROWS_UNEXPECTED');
    ctx.setupStatements.applied++;
  }

  ctx.phase = 'BASELINE';
  const tables = (await call(ctx, BASELINE_BODY, IMPORT_TABLES.length, 'STOPPED_BASELINE_INVALID')).rows;
  const baseline = Object.fromEntries(IMPORT_TABLES.map((t, i) => [t, tables[i].map((row) => {
    need(exactKeys(row, COLUMNS[t]) && COLUMNS[t].every((c) => cellOk(row[c])), 'STOPPED_BASELINE_INVALID', 'BASELINE_ROW_INVALID');
    return Object.fromEntries(COLUMNS[t].map((c) => [c, row[c]]));
  })]));

  ctx.phase = 'BUILD';
  let manifest;
  try {
    const { baselineSha256, scenarioSha256 } = proofScenarioSha256({ baseline });
    const now = new Date().toISOString();
    manifest = buildD1V2Proof({ descriptor: descriptorFor({ baselineSha256, scenarioSha256, nowMs: Date.parse(now) }), baseline, now });
  } catch (error) { throw new Stop('STOPPED_BUILD_FAILED', typeof error?.code === 'string' ? error.code : 'INTERNAL'); }

  ctx.phase = 'BOOTSTRAP';
  const d = manifest.descriptor;
  const runRow = [1, d.runNonce, d.ownerNonce, d.epoch, manifest.targetBindingSha256, d.planSha256, 0, 0, 0, 0, null, 0];
  ctx.mutatingRequests++;
  const boot = await call(ctx, JSON.stringify({ sql: BOOTSTRAP_SQL, params: [JSON.stringify(runRow)] }), 1, 'STOPPED_BOOTSTRAP_FAILED');
  need(boot.rows[0].length === 0, 'STOPPED_BOOTSTRAP_FAILED', 'BOOTSTRAP_ROWS_UNEXPECTED');

  ctx.phase = 'PROOF';
  const report = await runD1V2Proof({ manifest, token, fetchImpl: ctx.fetch, nowProvider: () => new Date().toISOString(), timeoutMs: TIMEOUT_MS });
  ctx.proofReport = report;
  ctx.mutatingRequests += Number.isSafeInteger(report?.counts?.sends) ? report.counts.sends : 0;
  ctx.phase = 'DONE';
  if (report?.status !== 'SYNTHETIC_PROOF_OBSERVED') throw new Stop(typeof report?.status === 'string' ? report.status : 'STOPPED_INTERNAL', report?.reason ?? 'INTERNAL');
  return 'SYNTHETIC_PROOF_OBSERVED';
}

function summary(ctx, status, code) {
  const ok = status === 'CHECK_ONLY_OK' || status === 'SYNTHETIC_PROOF_OBSERVED';
  return {
    targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: ctx.phase, status, code,
    httpStatus: ctx.httpStatus, wireContractObserved: ctx.wireContractObserved, targetEmptyObserved: ctx.targetEmptyObserved,
    setupStatements: { ...ctx.setupStatements }, requests: ctx.requests, mutatingRequests: ctx.mutatingRequests,
    blockedRequests: ctx.blockedRequests, syntheticRowsMayRemain: ctx.mutatingRequests > 0,
    manualRecoveryRequired: !ok && ctx.mutatingRequests > 0,
    ...(ctx.diagnostic ? { diagnostic: ctx.diagnostic } : {}), ...(ctx.proofReport ? { proofReport: ctx.proofReport } : {}),
  };
}

// PERMANENTLY RETIRED (unconditional). The exported API and the CLI return this fixed result before
// any options access, static check, file read, credential read or fetch (the historical body defaulted
// to the real OAuth reader and globalThis.fetch). There is no flag, env or option to re-enable it and pins
// are not refreshed. The historical bodies below are kept only as unreachable evidence.
export const RETIRED_RESULT = Object.freeze({ targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: 'RETIRED',
  status: 'STOPPED_RETIRED', code: 'DRIVER_RETIRED', httpStatus: null, requests: 0, mutatingRequests: 0, blockedRequests: 0,
  syntheticRowsMayRemain: false, manualRecoveryRequired: false, retired: true, ready: false, remoteAuthorized: false,
  authorizesExecution: false, authorizesRetry: false });
export async function executeApprovedProof() { return { ...RETIRED_RESULT }; }
let active = false;
// Historical callable API (unreachable evidence; not exported).
async function historicExecuteApprovedProof(options = {}) {
  const ctx = { phase: 'ARGS', httpStatus: null, wireContractObserved: false, targetEmptyObserved: false, setupStatements: { planned: 0, applied: 0 },
    requests: 0, mutatingRequests: 0, blockedRequests: 0, diagnostic: null, proofReport: null, token: null, fetch: null };
  const allowed = ['readCredential', 'fetchImpl', 'checkOnly'];
  if (!isObj(options) || !Object.keys(options).every((k) => allowed.includes(k))) return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
  const o = { readCredential: options.readCredential ?? readWranglerOAuth, fetchImpl: options.fetchImpl ?? globalThis.fetch, checkOnly: options.checkOnly ?? false };
  if (typeof o.readCredential !== 'function' || typeof o.fetchImpl !== 'function' || typeof o.checkOnly !== 'boolean') return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
  if (active) return summary(ctx, 'STOPPED_BUSY', 'BUSY');
  active = true;
  try {
    return summary(ctx, await execute(ctx, o), null);
  } catch (error) {
    return error instanceof Stop ? summary(ctx, error.status, error.code) : summary(ctx, 'STOPPED_INTERNAL', 'INTERNAL');
  } finally { ctx.token = null; active = false; }
}

// Historical CLI wiring (unreachable evidence; never called).
// eslint-disable-next-line no-unused-vars
async function historicCli() {
  const argv = process.argv.slice(2);
  let result;
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check-only')) {
    result = { targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: 'ARGS', status: 'STOPPED_ARGS', code: 'CLI_ARGUMENTS' };
    process.exitCode = 2;
  } else {
    result = await historicExecuteApprovedProof({ checkOnly: argv.length === 1 });
    process.exitCode = result.status === 'CHECK_ONLY_OK' || result.status === 'SYNTHETIC_PROOF_OBSERVED' ? 0 : 1;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
// Retired CLI: every argv (including --check-only) stops non-zero; no real dependency is invoked.
if (isMain(import.meta.url)) {
  process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(RETIRED_RESULT)}\n`);
}
