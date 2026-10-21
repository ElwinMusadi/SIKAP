// One-shot reset of the PARTIAL 0001 prefix in the fixed UAT D1 database. Importing performs no I/O.
// PERMANENTLY RETIRED: executeReset() and the CLI always return STOPPED_RETIRED/DRIVER_RETIRED with zero
// I/O (see RETIRED_RESULT). The usage below is historical evidence only:
// Parent/operator ONLY, after independent review:
//   node scripts/import/reset-approved-uat.mjs --check-only  (static pins/allowlist/order; no auth/HTTP)
//   node scripts/import/reset-approved-uat.mjs               (GET info, read-only preflight, ONE drop batch, ONE verify)
// No args/env/target overrides. No retry, no DROP DATABASE, no D1 create/delete, no R2 access. Database UUID retained.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isMain, readBoundedPlan, splitMigration } from '../migrate/local-store.mjs';
import { UAT_TARGET } from './real-data-gate.mjs';

const TARGET = Object.freeze({ accountId: '04b8b2073be2f1aa21fc6489e0db36f6', databaseId: '885b655b-3482-44fc-9d01-56ad0204bb35', databaseName: 'sikap-import-uat-20261018' });
const INFO_URL = `https://api.cloudflare.com/client/v4/accounts/${TARGET.accountId}/d1/database/${TARGET.databaseId}`;
const ENDPOINT = `${INFO_URL}/query`;
const ROOT = new URL('../../', import.meta.url);
const MIGRATION = ['0001_init.sql', 'bb47096b7f68350cb5040c5d8fd4060bd2315dc0f32e493f641ac9276b2bd171'];
const OAUTH_PATH = 'C:\\Users\\elwin\\AppData\\Roaming\\xdg.config\\.wrangler\\config\\default.toml';
const TIMEOUT_MS = 30_000, MAX_RESPONSE_BYTES = 1024 * 1024, MIN_CREDENTIAL_TTL_MS = 10 * 60 * 1000, MAX_REQUESTS = 4;
const TABLES = Object.freeze(['akun', 'arsip_dokumen', 'jenis_dokumen', 'jenis_dokumen_wajib', 'pegawai', 'rate_limit', 'ref_pangkat_golongan', 'ref_pendidikan', 'ref_unit_organisasi', 'sesi']);
const INDEXES = Object.freeze(['idx_akun_default_pw', 'idx_arsip_jenis', 'idx_arsip_purge', 'idx_arsip_status', 'idx_pegawai_nama', 'idx_pegawai_purge',
  'idx_pegawai_status', 'idx_rate_limit_window', 'idx_sesi_expires', 'idx_sesi_pegawai', 'idx_wajib_status']);
const DROP_ORDER = Object.freeze(['sesi', 'arsip_dokumen', 'akun', 'jenis_dokumen_wajib', 'pegawai', 'jenis_dokumen', 'ref_pangkat_golongan', 'ref_unit_organisasi', 'ref_pendidikan', 'rate_limit']);
const INVENTORY_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name";
const q = (sql) => ({ sql, params: [] });
const PREFLIGHT = [q(INVENTORY_SQL), ...TABLES.map((t) => q(`SELECT count(*) AS n FROM ${t}`))];
const DROPS = DROP_ORDER.map((t) => q(`DROP TABLE ${t}`));
const BODIES = Object.freeze({ PREFLIGHT: JSON.stringify({ batch: PREFLIGHT }), DROP: JSON.stringify({ batch: DROPS }), INVENTORY: JSON.stringify({ batch: [q(INVENTORY_SQL)] }) });
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// Exact text compare (SQLite stores the CREATE text as sent); only outer whitespace/trailing semicolon ignored.
const canon = (s) => s.trim().replace(/;$/, '').trim();
const obj = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v, required, optional = []) => obj(v) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k)) && required.every((k) => Object.hasOwn(v, k));
class Stop { constructor(code) { this.code = code; } }
const need = (ok, code) => { if (!ok) throw new Stop(code); };
const quiet = (fn) => { try { const p = fn(); p?.catch?.(() => {}); } catch { /* discard only */ } };
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Expected objects = the exact first 21 statements of pinned 0001 (the observed partial prefix).
function staticCheck() {
  need(sameList(TARGET, { accountId: UAT_TARGET.accountId, databaseId: UAT_TARGET.databaseId, databaseName: UAT_TARGET.databaseName }), 'TARGET_PIN_MISMATCH');
  const sql = readFileSync(new URL(`migrations/${MIGRATION[0]}`, ROOT), 'utf8');
  need(!sql.includes('\r') && sha256(sql) === MIGRATION[1], 'MIGRATION_HASH_MISMATCH');
  const prefix = splitMigration(sql).slice(0, TABLES.length + INDEXES.length), expected = new Map();
  for (const s of prefix) {
    const t = /^CREATE TABLE ([a-z_]+) \(/.exec(s), i = /^CREATE INDEX ([a-z_]+)\s+ON ([a-z_]+)\(/.exec(s);
    need((t || i) && !expected.has((t ?? i)[1]), 'PREFIX_PARSE');
    expected.set((t ?? i)[1], { type: t ? 'table' : 'index', tbl_name: t ? t[1] : i[2], sql: canon(s) });
  }
  const names = (type) => [...expected].filter(([, v]) => v.type === type).map(([k]) => k).sort();
  need(sameList(names('table'), TABLES) && sameList(names('index'), INDEXES) && sameList([...DROP_ORDER].sort(), TABLES), 'ALLOWLIST_MISMATCH');
  need(INDEXES.every((n) => TABLES.includes(expected.get(n).tbl_name)), 'INDEX_PARENT_MISMATCH');
  // FK graph: every referenced table must be dropped strictly after its referencing table.
  for (const [pos, table] of DROP_ORDER.entries()) {
    for (const [, ref] of expected.get(table).sql.matchAll(/REFERENCES ([a-z_]+)\(/g)) need(DROP_ORDER.indexOf(ref) > pos, 'DROP_ORDER_FK');
  }
  need(DROPS.every((d, k) => d.sql === `DROP TABLE ${DROP_ORDER[k]}`) && !BODIES.DROP.includes('IF EXISTS'), 'DROP_SHAPE');
  return expected;
}

async function readCredentials() {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedPlan(OAUTH_PATH, 64 * 1024));
  const pick = (key) => {
    const m = [...text.matchAll(new RegExp(`^${key}[ \\t]*=[ \\t]*"([^"\\\\\\r\\n]*)"[ \\t\\r]*$`, 'gm'))];
    need(m.length === 1, 'CREDENTIAL_FORMAT'); return m[0][1];
  };
  return { token: pick('oauth_token'), expiresAt: pick('expiration_time') };
}

function fetchGate(fetchImpl, ctx) {
  return (url, init) => {
    const get = url === INFO_URL && init?.method === 'GET' && init.body === undefined && ctx.phase === 'TARGET_INFO';
    const post = url === ENDPOINT && init?.method === 'POST' && typeof init.body === 'string' &&
      ((ctx.phase === 'PREFLIGHT' && init.body === BODIES.PREFLIGHT) || (ctx.phase === 'DROP' && init.body === BODIES.DROP && !ctx.dropSent) ||
       (['OBSERVE', 'VERIFY'].includes(ctx.phase) && init.body === BODIES.INVENTORY));
    if ((!get && !post) || init?.redirect !== 'error' || ctx.requests >= MAX_REQUESTS) { ctx.blockedRequests++; return Promise.reject(new Error('BLOCKED')); }
    ctx.requests++; if (ctx.phase === 'DROP') ctx.dropSent = true;
    return fetchImpl(url, init);
  };
}
async function withResponse(ctx, url, init, consume) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Stop('HTTP_TIMEOUT')), { once: true }));
  aborted.catch(() => {});
  let response, pending;
  try {
    pending = ctx.fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal });
    response = await Promise.race([pending, aborted]);
    need(response && response.redirected !== true && (!response.url || response.url === url), 'HTTP_UNTRUSTED');
    ctx.httpStatus = Number.isSafeInteger(response.status) ? response.status : null;
    return await Promise.race([consume(response, controller.signal), aborted]);
  } finally {
    clearTimeout(timer); quiet(() => response?.body?.cancel());
    pending?.then((late) => { if (controller.signal.aborted) quiet(() => late?.body?.cancel()); }, () => {});
  }
}
async function readJson(response, signal) {
  need(response.status >= 200 && response.status <= 299, response.status === 401 || response.status === 403 ? 'HTTP_AUTH' : 'HTTP_STATUS');
  need(/^application\/json\s*(;.*)?$/i.test(response.headers?.get?.('content-type') ?? ''), 'HTTP_CONTENT_TYPE');
  need(response.body && typeof response.body.getReader === 'function', 'HTTP_BODY');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const cancel = () => quiet(() => reader.cancel()); signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      need(!signal.aborted, 'HTTP_TIMEOUT'); if (done) break;
      need(value instanceof Uint8Array, 'HTTP_BODY'); size += value.byteLength;
      need(size <= MAX_RESPONSE_BYTES, 'HTTP_BODY_OVERSIZE'); chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new Stop('HTTP_JSON'); }
  } finally { signal.removeEventListener('abort', cancel); cancel(); quiet(() => reader.releaseLock()); }
}
const auth = (ctx) => ({ Authorization: `Bearer ${ctx.credential.token}` });
async function d1(ctx, body, count) {
  const json = await withResponse(ctx, ENDPOINT, { method: 'POST', headers: { ...auth(ctx), 'Content-Type': 'application/json' }, body }, readJson);
  need(keys(json, ['result', 'errors', 'messages', 'success']) && json.success === true && Array.isArray(json.errors) && json.errors.length === 0 &&
    Array.isArray(json.messages) && json.messages.length === 0 && Array.isArray(json.result) && json.result.length === count, 'HTTP_ENVELOPE');
  return json.result.map((r) => { need(keys(r, ['success', 'results'], ['meta']) && r.success === true && Array.isArray(r.results) && r.results.length <= 1000, 'HTTP_RESULT'); return r.results; });
}
const inventoryRows = (rows) => rows.map((r) => { need(keys(r, ['type', 'name', 'tbl_name', 'sql']) && ['type', 'name', 'tbl_name'].every((k) => typeof r[k] === 'string'), 'INVENTORY_SHAPE'); return r; });

async function execute(ctx, options) {
  ctx.phase = 'STATIC_CHECK'; const expected = staticCheck();
  if (options.checkOnly) { ctx.phase = 'DONE'; return 'CHECK_ONLY_OK'; }
  ctx.phase = 'CREDENTIAL'; ctx.credential = await options.readCredential();
  const c = ctx.credential;
  need(keys(c, ['token', 'expiresAt']) && typeof c.token === 'string' && c.token.length >= 20 && c.token.length <= 4096 && TOKEN.test(c.token), 'CREDENTIAL_INVALID');
  need(typeof c.expiresAt === 'string' && Number.isFinite(Date.parse(c.expiresAt)) && Date.parse(c.expiresAt) - Date.now() >= MIN_CREDENTIAL_TTL_MS, 'CREDENTIAL_EXPIRED');
  ctx.fetch = fetchGate(options.fetchImpl, ctx);
  ctx.phase = 'TARGET_INFO';
  const info = await withResponse(ctx, INFO_URL, { method: 'GET', headers: auth(ctx) }, readJson);
  need(obj(info) && info.success === true && Array.isArray(info.errors) && info.errors.length === 0 && obj(info.result) &&
    info.result.uuid === TARGET.databaseId && info.result.name === TARGET.databaseName, 'TARGET_IDENTITY_MISMATCH');
  ctx.targetIdentityObserved = true;
  ctx.phase = 'PREFLIGHT';
  const rows = await d1(ctx, BODIES.PREFLIGHT, PREFLIGHT.length), inventory = inventoryRows(rows[0]);
  ctx.preflight.tables = inventory.filter((r) => r.type === 'table').length; ctx.preflight.indexes = inventory.filter((r) => r.type === 'index').length;
   need(inventory.length === expected.size && new Set(inventory.map((r) => r.name)).size === expected.size && inventory.every((r) => { const e = expected.get(r.name); return e && e.type === r.type && e.tbl_name === r.tbl_name && typeof r.sql === 'string' && canon(r.sql) === e.sql; }), 'INVENTORY_MISMATCH');
  for (let k = 1; k < rows.length; k++) {
    need(rows[k].length === 1 && keys(rows[k][0], ['n']) && Number.isSafeInteger(rows[k][0].n), 'COUNT_SHAPE');
    ctx.preflight.rowsTotal += rows[k][0].n;
  }
  need(ctx.preflight.rowsTotal === 0 && rows.slice(1).every((r) => r[0].n === 0), 'ROWS_PRESENT'); ctx.preflightVerified = true;
  ctx.phase = 'DROP';
  let dropError = null;
  try { const res = await d1(ctx, BODIES.DROP, DROPS.length); need(res.every((r) => r.length === 0), 'DROP_ROWS'); ctx.dropConfirmed = true; }
  catch (error) { dropError = error instanceof Stop ? error.code : 'OPERATION_FAILED'; }
  ctx.phase = dropError ? 'OBSERVE' : 'VERIFY';
  let remaining = null;
  try { remaining = inventoryRows((await d1(ctx, BODIES.INVENTORY, 1))[0]).length; } catch { /* reported as null below */ }
  ctx.remainingUserObjects = remaining;
  if (dropError) { ctx.dropErrorCode = dropError; throw new Stop('DROP_AMBIGUOUS'); }
  need(remaining !== null, 'VERIFY_UNOBSERVED'); need(remaining === 0, 'RESET_INCOMPLETE');
  ctx.phase = 'DONE'; return 'RESET_VERIFIED';
}
function summary(ctx, status, code) {
  return { targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: ctx.phase, status, code, dropErrorCode: ctx.dropErrorCode, httpStatus: ctx.httpStatus,
    requests: ctx.requests, blockedRequests: ctx.blockedRequests, targetIdentityObserved: ctx.targetIdentityObserved, preflight: { ...ctx.preflight },
    preflightVerified: ctx.preflightVerified, dropStatementsPlanned: DROPS.length, dropSent: ctx.dropSent, dropConfirmed: ctx.dropConfirmed,
    remainingUserObjects: ctx.remainingUserObjects, manualReviewRequired: ctx.dropSent && status !== 'RESET_VERIFIED',
    databaseRetained: true, r2Touched: false, retryAttempted: false, authorizesRetry: false, importAuthorized: false };
}
// PERMANENTLY RETIRED (unconditional): destructive DROP TABLE reset of the old UAT target. The exported API
// and the CLI return this fixed result before any options access, static check, file read, credential read
// or fetch. No flag, env or option re-enables it. Historical bodies below are unreachable evidence only.
export const RETIRED_RESULT = Object.freeze({ targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: 'RETIRED',
  status: 'STOPPED_RETIRED', code: 'DRIVER_RETIRED', httpStatus: null, requests: 0, blockedRequests: 0, dropSent: false,
  dropConfirmed: false, manualReviewRequired: false, databaseRetained: true, r2Touched: false, retryAttempted: false,
  authorizesRetry: false, importAuthorized: false, retired: true });
export async function executeReset() { return { ...RETIRED_RESULT }; }
let active = false;
// Historical callable API (unreachable evidence; not exported). Required all three explicit dependencies.
async function historicExecuteReset(options) {
  const ctx = { phase: 'ARGS', httpStatus: null, requests: 0, blockedRequests: 0, targetIdentityObserved: false, preflight: { tables: 0, indexes: 0, rowsTotal: 0 },
    preflightVerified: false, dropSent: false, dropConfirmed: false, dropErrorCode: null, remainingUserObjects: null, credential: null, fetch: null };
  const allowed = ['readCredential', 'fetchImpl', 'checkOnly'];
  if (!keys(options, allowed) || Reflect.ownKeys(options).some((k) => typeof k !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, k), 'value'))) return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
  const o = { ...options };
  if (typeof o.checkOnly !== 'boolean' || typeof o.readCredential !== 'function' || typeof o.fetchImpl !== 'function') return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
  if (active) return summary(ctx, 'STOPPED_BUSY', 'BUSY'); active = true;
  try { return summary(ctx, await execute(ctx, o), null); }
  catch (error) { return summary(ctx, `STOPPED_${ctx.phase}`, error instanceof Stop ? error.code : 'OPERATION_FAILED'); }
  finally { ctx.credential = null; ctx.fetch = null; active = false; }
}
// Historical CLI wiring (unreachable evidence; never called).
// eslint-disable-next-line no-unused-vars
async function historicCli() {
  const argv = process.argv.slice(2);
  const invalid = argv.length > 1 || (argv.length === 1 && argv[0] !== '--check-only');
  const result = invalid ? { status: 'STOPPED_ARGS', code: 'CLI_ARGUMENTS' } : await historicExecuteReset({ checkOnly: argv.length === 1, readCredential: readCredentials, fetchImpl: globalThis.fetch });
  process.exitCode = invalid ? 2 : ['CHECK_ONLY_OK', 'RESET_VERIFIED'].includes(result.status) ? 0 : 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
// Retired CLI: every argv (including --check-only) stops non-zero; no real dependency is invoked.
if (isMain(import.meta.url)) {
  process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(RETIRED_RESULT)}\n`);
}
