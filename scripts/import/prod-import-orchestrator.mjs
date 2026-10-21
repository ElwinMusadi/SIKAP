// Shared import orchestrator for the fixed PRODUCTION driver and its synthetic rehearsal seam.
//
// Exactly two kinds, both running the SAME code path:
//   * 'production'           : target = PROD_TARGET, pins/plan facts ONLY from prod-import-pins.mjs
//                              (all PENDING => fails closed), issuer issueRealDataProductionPermit,
//                              success COMPLETE_PROD_RECONCILED.
//   * 'synthetic-rehearsal'  : target = REHEARSAL_TARGET (fixed third target in the gate), caller
//                              supplies synthetic plan facts + module pins only, issuer
//                              issueRealDataRehearsalPermit, success COMPLETE_SYNTHETIC_REHEARSAL,
//                              productionImport:false, syntheticRehearsal:true.
// There is NO caller target/endpoint/descriptor/timeout/TTL field. Rehearsal config can never select or
// supply the production target, production pins or the production issuer. Every authority flag is false.
//
// No default I/O: no global fetch, env, private paths or wall clock in this module, and no direct child-process
// API. Note: the Miniflare package (dynamic import, in-memory expected schema, d1Persist:false, outbound 403)
// may itself start a LOCAL workerd process; that is local-only and performs no remote I/O.
// Every read, the fetch transport and the clock (`now`) are explicit injected functions. Only the
// run-prod-import.mjs CLI block wires real I/O. The repository root for static checks is fixed.
//
// Synthetic-rehearsal I/O contract: callers MUST inject fakes (in-memory D1/R2, synthetic credential). The
// orchestrator cannot prove an injected function is not a real transport; no CLI wires this kind, and its
// fixed target UUID is not creatable, so a mis-wired real fetch reaches only a read-only EMPTY_CHECK there.
//
// Local binding inventory is LOCAL-ONLY evidence (repo files); it is NOT proof of remote bindings,
// Pages/Workers dashboard configuration or absence of other writers.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_LIMITS, IMPORT_TABLES } from '../migrate/contract.mjs';
import { EMPTY_TABLES, validatePlan } from '../migrate/apply-local.mjs';
import { splitMigration } from '../migrate/local-store.mjs';
import { COLUMNS, ImportCoreError, LEDGER, MAX_DESCRIPTOR_TTL_MS, PRIMARY, compileChunks, validateDescriptor } from './core.mjs';
import { LEDGER_DDL_SHA256, LEDGER_SQL_FILE, validateLedgerSql } from './ledger-contract.mjs';
import { ENDPOINT_ORIGIN, ENDPOINT_PATH } from './d1-rest.mjs';
import { SCHEMA_QUERY } from './d1-readback.mjs';
import { R2_REGION, R2_SERVICE, signV4 } from './r2-s3.mjs';
import {
  PROD_TARGET, PROD_APP_SCHEMA_SHA256, PROD_LEDGER_SCHEMA_SHA256, PROD_POLICY_SHA256, PROD_RETENTION_POLICY_SHA256,
  REHEARSAL_TARGET, REHEARSAL_APP_SCHEMA_SHA256, REHEARSAL_LEDGER_SCHEMA_SHA256, REHEARSAL_POLICY_SHA256, REHEARSAL_RETENTION_POLICY_SHA256,
  UAT_TARGET, RealDataGateError, issueRealDataProductionPermit, issueRealDataRehearsalPermit, getPermitTables,
} from './real-data-gate.mjs';
import * as runner from './synthetic-runner.mjs';
import * as PINS from './prod-import-pins.mjs';

const ROOT = new URL('../../', import.meta.url);
const PENDING = PINS.PENDING;
// Per-request timeout for EVERY request class (D1, R2 PUT/GET). The run window is budgeted worst-case
// (B x TIMEOUT_MS + margin <= descriptor cap), so a smaller timeout is the only knob that shortens it without
// raising any cap, limit or chunk size. 15 s is ~3.7x the measured time to upload the largest manifest object
// (4.98 MB took ~4 s at ~1.2 MB/s, 2026-10-20) and far above D1 batch latency. A request that still exceeds
// it stops fail-closed (ambiguous/halt), exactly like a 30 s timeout would. Historical plan: B=807 -> 3.4 h.
export const TIMEOUT_MS = 15_000;
// A credential that outlives the run by much more than the window is residual risk; the owner must mint a
// short-lived token (see MIGRATION_PLAN credential design), so anything longer is refused before any HTTP.
export const MAX_CREDENTIAL_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const MAX_REQUESTS = 1000;
export const SETUP_STATEMENTS = 67;
// Local margins: CPU for per-chunk recompile/readback compare and clock skew. Unmeasured remotely.
export const LOCAL_MARGIN_MS = 5 * 60 * 1000;
export const CREDENTIAL_MARGIN_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024, MAX_REQUEST_BYTES = 128 * 1024;
export const ORCHESTRATOR_MODES = Object.freeze(['import', 'check-only', 'describe-plan', 'print-pins']);
export const KINDS = Object.freeze(['production', 'synthetic-rehearsal']);
// Fixed codes an injected reader may surface (anything else becomes OPERATION_FAILED; raw errors never escape).
export const READER_ERROR_CODES = Object.freeze(['PRIVATE_PERMISSIONS', 'PLAN_READ_FAILED', 'FILE_READ_FAILED', 'CREDENTIAL_PERMISSIONS', 'CREDENTIAL_READ_FAILED', 'CREDENTIAL_FORMAT']);

// Frozen per-kind configuration. Nothing here is caller-supplied; the rehearsal kind's pins come from
// the request only after validation, and its target/issuer/status are fixed below.
const PROFILES = Object.freeze({
  production: Object.freeze({
    target: PROD_TARGET, appSchema: PROD_APP_SCHEMA_SHA256, ledgerSchema: PROD_LEDGER_SCHEMA_SHA256,
    policy: PROD_POLICY_SHA256, retention: PROD_RETENTION_POLICY_SHA256, issue: issueRealDataProductionPermit,
    success: 'COMPLETE_PROD_RECONCILED', productionImport: true, syntheticRehearsal: false,
    marker: 'realDataProduction', foreignMarkers: Object.freeze(['realDataRehearsal', 'realDataUat']),
  }),
  'synthetic-rehearsal': Object.freeze({
    target: REHEARSAL_TARGET, appSchema: REHEARSAL_APP_SCHEMA_SHA256, ledgerSchema: REHEARSAL_LEDGER_SCHEMA_SHA256,
    policy: REHEARSAL_POLICY_SHA256, retention: REHEARSAL_RETENTION_POLICY_SHA256, issue: issueRealDataRehearsalPermit,
    success: 'COMPLETE_SYNTHETIC_REHEARSAL', productionImport: false, syntheticRehearsal: true,
    marker: 'realDataRehearsal', foreignMarkers: Object.freeze(['realDataProduction', 'realDataUat']),
  }),
});
// Defence in depth: the three gate targets must be pairwise distinct on every identifying field.
const distinct = (a, b) => a.databaseId !== b.databaseId && a.databaseName !== b.databaseName && a.bucket !== b.bucket;
if (!distinct(PROD_TARGET, REHEARSAL_TARGET) || !distinct(UAT_TARGET, REHEARSAL_TARGET) || !distinct(UAT_TARGET, PROD_TARGET)) throw new Error('TARGET_PINS_OVERLAP');

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
const REFS = [
  { table: 'ref_pangkat_golongan', columns: ['kode', 'nama', 'jenis_asn', 'urutan', 'aktif'], order: ['kode'] },
  { table: 'ref_unit_organisasi', columns: ['id', 'nama', 'aktif'], order: ['id'] },
  { table: 'ref_pendidikan', columns: ['kode', 'nama', 'urutan'], order: ['kode'] },
  ...['jenis_dokumen', 'jenis_dokumen_wajib'].map((table) => ({ table, columns: COLUMNS[table], order: PRIMARY[table] })),
];
const select = (columns, table, order) => `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order.join(', ')}`;
const BASELINE_QUERIES = IMPORT_TABLES.map((t) => select(COLUMNS[t], t, PRIMARY[t]));
const REF_QUERIES = REFS.map((r) => select(r.columns, r.table, r.order));
const COUNT_QUERIES = [...EMPTY_TABLES, LEDGER.runTable, LEDGER.journalTable].map((t) => `SELECT count(*) AS n FROM ${t}`);
const EMPTY_SQL = "SELECT count(*) AS user_objects FROM sqlite_master WHERE substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_'";
const BOOTSTRAP_SQL = `INSERT INTO ${LEDGER.runTable} (${LEDGER.runColumns.join(', ')}) VALUES (${LEDGER.runColumns.map((_, i) => `json_extract(?1, '$[${i}]')`).join(', ')})`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EMPTY_SHA = sha256(new Uint8Array(0));
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA = /^[0-9a-f]{64}$/;
const obj = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v, required, optional = []) => obj(v) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k)) && required.every((k) => Object.hasOwn(v, k));
class Stop { constructor(code) { this.code = code; } }
const need = (ok, code) => { if (!ok) throw new Stop(code); };
const quiet = (fn) => { try { const p = fn(); p?.catch?.(() => {}); } catch { /* discard only */ } };
const schemaHash = (rows) => sha256(JSON.stringify([...rows].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((r) => [r.type, r.name, r.tbl_name, r.sql])));
const rowArrays = (rows, columns) => rows.map((r) => { need(keys(r, columns), 'ROW_SHAPE'); return columns.map((c) => r[c]); });
const lf = (file) => readFileSync(new URL(file, ROOT), 'utf8').replace(/\r\n/g, '\n');
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const k of Object.keys(value)) deepFreeze(value[k]); }
  return value;
}
const endpointFor = (target) => `${ENDPOINT_ORIGIN}${ENDPOINT_PATH(target.accountId, target.databaseId)}`;

// Own enumerable DATA properties only (getters never run, symbols rejected), exact keys. Returns a copy.
function plain(value, required, optional = []) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'OPTIONS_INVALID');
  const proto = Object.getPrototypeOf(value);
  need(proto === Object.prototype || proto === null, 'OPTIONS_INVALID');
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    need(typeof key === 'string' && (required.includes(key) || optional.includes(key)), 'OPTIONS_INVALID');
    const d = Reflect.getOwnPropertyDescriptor(value, key);
    need(Object.hasOwn(d, 'value') && d.enumerable === true, 'OPTIONS_INVALID');
    out[key] = d.value;
  }
  need(required.every((k) => Object.hasOwn(out, k)), 'OPTIONS_INVALID');
  return out;
}
// Deep plain JSON-like snapshot (no getters/symbols/non-plain objects), bounded depth/size; frozen copy.
function plainData(value, depth = 0) {
  need(depth <= 4, 'OPTIONS_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { need(Number.isSafeInteger(value) && value >= 0, 'OPTIONS_INVALID'); return value; }
  if (Array.isArray(value)) {
    need(Object.getPrototypeOf(value) === Array.prototype, 'OPTIONS_INVALID');
    const len = Reflect.getOwnPropertyDescriptor(value, 'length').value;
    need(len <= 256 && Reflect.ownKeys(value).length === len + 1, 'OPTIONS_INVALID');
    return Object.freeze(Array.from({ length: len }, (_, i) => {
      const d = Reflect.getOwnPropertyDescriptor(value, String(i));
      need(d !== undefined && Object.hasOwn(d, 'value') && d.enumerable === true, 'OPTIONS_INVALID');
      return plainData(d.value, depth + 1);
    }));
  }
  const o = plain(value, [], Reflect.ownKeys(value).filter((k) => typeof k === 'string'));
  need(Object.keys(o).length <= 64, 'OPTIONS_INVALID');
  return Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, plainData(v, depth + 1)])));
}

// ---------------------------------------------------------------------------------------------
// Local binding inventory (LOCAL-ONLY). Bounded repo walk, fixed root, no symlink/junction follow.
// Skips node_modules/.git/.worktrees and .wrangler/state|tmp (local dev state) by NAME; every other
// directory is walked for config FILE NAMES only. Contents are read only for the exact allowlisted
// config files. Discovered config set must equal the reviewed allowlist exactly.
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees']);
const SKIP_WRANGLER_STATE = new Set(['state', 'tmp']);
const CONFIG_NAME = /^wrangler\.(toml|json|jsonc)$/i;
export const INVENTORY_MAX_NODES = 20_000;
export const INVENTORY_MAX_DEPTH = 12;
// `root` is a URL or absolute path. Production always passes the fixed repo ROOT; tests pass temp dirs.
export function scanBindingInventory(root, allowlist, target) {
  const rootPath = root instanceof URL ? fileURLToPath(root) : root;
  need(typeof rootPath === 'string' && path.isAbsolute(rootPath), 'CONFIG_INVENTORY_UNREADABLE');
  const found = []; let nodes = 0;
  const walk = (rel, depth) => {
    need(depth <= INVENTORY_MAX_DEPTH, 'CONFIG_INVENTORY_LIMIT');
    let entries;
    try { entries = readdirSync(path.join(rootPath, ...rel), { withFileTypes: true }); } catch { throw new Stop('CONFIG_INVENTORY_UNREADABLE'); }
    for (const e of entries) {
      need(++nodes <= INVENTORY_MAX_NODES, 'CONFIG_INVENTORY_LIMIT');
      const parts = [...rel, e.name];
      const parent = rel.length ? rel[rel.length - 1] : '';
      if (e.isDirectory() && (SKIP_DIRS.has(e.name) || (parent === '.wrangler' && SKIP_WRANGLER_STATE.has(e.name)))) continue;
      let st;
      try { st = lstatSync(path.join(rootPath, ...parts)); } catch { throw new Stop('CONFIG_INVENTORY_UNREADABLE'); }
      need(!st.isSymbolicLink() && !e.isSymbolicLink(), 'CONFIG_INVENTORY_LINK');
      if (st.isDirectory()) { walk(parts, depth + 1); continue; }
      if (!st.isFile()) continue;
      const deployConfig = e.name.toLowerCase() === 'config.json' && parent.toLowerCase() === 'deploy' && rel.length >= 2 && rel[rel.length - 2].toLowerCase() === '.wrangler';
      if (CONFIG_NAME.test(e.name) || deployConfig) found.push(parts.join('/'));
    }
  };
  walk([], 0);
  found.sort();
  const expected = [...allowlist].sort();
  need(JSON.stringify(found) === JSON.stringify(expected), 'CONFIG_INVENTORY_MISMATCH');
  for (const file of expected) {
    let text;
    try { text = readFileSync(path.join(rootPath, ...file.split('/')), 'utf8'); } catch { throw new Stop('CONFIG_INVENTORY_UNREADABLE'); }
    const lower = text.toLowerCase();
    need(![target.databaseId, target.databaseName, target.bucket].some((v) => lower.includes(v.toLowerCase())), 'APP_BINDING_PRESENT');
  }
  return Object.freeze({ configFiles: expected.length, localOnly: true, remoteBindingProof: false });
}

// ---------------------------------------------------------------------------------------------
// Request budget (exact, from the actual workflow; happy path is the maximum):
//   driver: empty check 1 + object absence F + setup S(67) + target check 1 + bootstrap 1
//   runner: initial readback 1 + (PUT+GET) 2F + per chunk (pre-read, send, post-read) 3C + final GET F + final readback 1
//   B = S + 5 + 4F + 3C. A D1-ambiguous chunk costs pre+send+ONE observation (=3) then stops; an R2 halt
//   costs <= 2 then stops; so every stop path is <= B. The fetch gate cap is exactly B.
export function requestBudget(files, chunks) {
  need(Number.isSafeInteger(files) && files >= 0 && Number.isSafeInteger(chunks) && chunks >= 1, 'BUDGET_INPUT_INVALID');
  return SETUP_STATEMENTS + 5 + 4 * files + 3 * chunks;
}
export const requiredWindowMs = (budget) => budget * TIMEOUT_MS + LOCAL_MARGIN_MS;

// ---------------------------------------------------------------------------------------------
function staticCheck(ctx, pins) {
  need(PROD_APP_SCHEMA_SHA256 === '143fef6ecb05c450c38b697e6524d9c5e12072ef819c95d052fb210f323c7f72' && PROD_LEDGER_SCHEMA_SHA256 === LEDGER_DDL_SHA256 &&
    ctx.profile.appSchema === PROD_APP_SCHEMA_SHA256 && ctx.profile.ledgerSchema === LEDGER_DDL_SHA256, 'SCHEMA_PIN_MISMATCH');
  const names = readdirSync(new URL('migrations/', ROOT)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  need(JSON.stringify(names) === JSON.stringify(MIGRATION_PINS.map((p) => p[0])), 'MIGRATION_SET_MISMATCH');
  const statements = [];
  for (const [name, pin] of MIGRATION_PINS) {
    const sql = readFileSync(new URL(`migrations/${name}`, ROOT), 'utf8');
    need(!sql.includes('\r') && sha256(sql) === pin, 'MIGRATION_HASH_MISMATCH');
    statements.push(...splitMigration(sql));
  }
  need(sha256(JSON.stringify(['sikap-app-migrations', 1, MIGRATION_PINS])) === PROD_APP_SCHEMA_SHA256, 'APP_SCHEMA_PIN_MISMATCH');
  const ddl = readFileSync(new URL(LEDGER_SQL_FILE, ROOT), 'utf8');
  need(validateLedgerSql(ddl).valid === true, 'LEDGER_HASH_MISMATCH');
  statements.push(...splitMigration(ddl.replace(/\r\n/g, '\n')));
  need(statements.length === SETUP_STATEMENTS && statements.every((sql) => Buffer.byteLength(JSON.stringify({ sql, params: [] })) <= MAX_REQUEST_BYTES), 'SETUP_COUNT_MISMATCH');
  // Production target AND the rehearsal target must be absent from every local deployment config.
  ctx.inventory = scanBindingInventory(ROOT, PINS.CONFIG_FILES, PROD_TARGET);
  scanBindingInventory(ROOT, PINS.CONFIG_FILES, REHEARSAL_TARGET);
  // Module pins (runtime code binding) are required for every mode except print-pins.
  need(pins.modules.length === PINS.MODULE_FILES.length && pins.modules.every(([f], i) => f === PINS.MODULE_FILES[i]), 'MODULE_PIN_SET_MISMATCH');
  for (const [file, pin] of pins.modules) {
    need(pin !== PENDING, 'RUNTIME_PIN_PENDING');
    need(sha256(lf(file)) === pin, 'MODULE_PIN_MISMATCH');
  }
  need(typeof runner.runPrivateUatImport === 'function' && SHA.test(runner.UAT_EXPECTED_SCHEMA_SHA256), 'RUNNER_PIN_PENDING');
  return statements;
}
function planFactsCheck(facts) {
  need(facts.planSha256 !== PENDING && facts.snapshotId !== null && facts.expected !== null && facts.warningCounts !== null && facts.diagnosticsTotal !== null, 'PLAN_PIN_PENDING');
  need(!Object.hasOwn(facts.warningCounts, 'PENDING_REVIEW'), 'WARNING_REVIEW_PENDING');
}

async function loadPrivate(ctx, io, facts, pinned) {
  const planBytes = await io.readPlanBytes();
  need(planBytes instanceof Uint8Array && planBytes.byteLength > 0 && planBytes.byteLength <= ARTIFACT_LIMITS.exportBytes, 'PLAN_BYTES_INVALID');
  const planCopy = new Uint8Array(planBytes);
  const planSha256 = sha256(planCopy);
  if (pinned) need(planSha256 === facts.planSha256, 'PLAN_HASH_MISMATCH');
  let plan;
  try { plan = validatePlan(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planCopy))); } catch { throw new Stop('PLAN_INVALID'); }
  need(plan.sourceReadOnlyDeclared === true && plan.consistent === false && plan.ready === true, 'PLAN_SCOPE_MISMATCH');
  const warnings = {};
  for (const d of plan.diagnostics) { need(d.severity === 'warning', 'PLAN_WARNING_DENIED'); warnings[d.code] = (warnings[d.code] ?? 0) + 1; }
  if (pinned) {
    need(plan.snapshotId === facts.snapshotId, 'PLAN_SCOPE_MISMATCH');
    const e = facts.expected;
    // Exact key sets (order-independent) at both levels, then exact values.
    const sameKeys = (a, b) => obj(a) && obj(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(b).every((k) => Object.hasOwn(a, k));
    need(sameKeys(e, plan.expected) && sameKeys(e.arsipPerStatus, plan.expected.arsipPerStatus) &&
      Object.keys(plan.expected).every((k) => k === 'arsipPerStatus'
        ? Object.keys(plan.expected.arsipPerStatus).every((s) => e.arsipPerStatus[s] === plan.expected.arsipPerStatus[s])
        : e[k] === plan.expected[k]), 'PLAN_COUNTS_MISMATCH');
    need(Object.keys(warnings).every((k) => Object.hasOwn(facts.warningCounts, k)) && Object.keys(facts.warningCounts).every((k) => warnings[k] === facts.warningCounts[k]) && plan.diagnostics.length === facts.diagnosticsTotal, 'PLAN_WARNING_MISMATCH');
  }
  const objects = []; let total = 0;
  for (const file of plan.files) {
    total += file.sizeBytes;
    need(total <= runner.MAX_TOTAL_OBJECT_BYTES && file.sizeBytes <= ARTIFACT_LIMITS.fileBytes, 'FILES_BUDGET');
    const bytes = await io.readFileBytes(Object.freeze({ ...file }));
    need(bytes instanceof Uint8Array && bytes.byteLength === file.sizeBytes && sha256(bytes) === file.sha256, 'FILE_INTEGRITY');
    objects.push({ key: file.r2Key, bytes: new Uint8Array(bytes), mimeType: file.mimeType, sha256: file.sha256 });
    ctx.filesVerified++;
  }
  need(total === plan.expected.totalFileBytes && ctx.filesVerified === plan.expected.files && ctx.filesVerified === plan.files.length, 'FILES_COUNT_MISMATCH');
  ctx.fileBytesVerified = total;
  ctx.facts = { snapshotId: plan.snapshotId, planSha256, expected: plan.expected, warningCounts: warnings, diagnosticsTotal: plan.diagnostics.length,
    photos: plan.files.filter((f) => f.kind === 'photo').length, documents: plan.files.filter((f) => f.kind === 'document').length };
  return { planBytes: planCopy, plan, objects };
}

// In-memory reference/schema derivation from the exact pinned SQL; no private rows or persistence.
async function expectedDatabase(statements) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };', outboundService: () => new Response(null, { status: 403 }),
    log: new Log(LogLevel.NONE), cf: false, telemetry: { enabled: false }, d1Persist: false, d1Databases: { DB: 'sikap-import-driver-memory' } }));
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of statements) await db.prepare(sql).run();
    const schema = (await db.prepare(SCHEMA_QUERY.sql).all()).results;
    need(schemaHash(schema) === runner.UAT_EXPECTED_SCHEMA_SHA256, 'LOCAL_SCHEMA_MISMATCH');
    const refs = [];
    for (let i = 0; i < REF_QUERIES.length; i++) refs.push(rowArrays((await db.prepare(REF_QUERIES[i]).all()).results, REFS[i].columns));
    const baseline = {};
    for (let i = 0; i < IMPORT_TABLES.length; i++) {
      const table = IMPORT_TABLES[i];
      const rows = (await db.prepare(BASELINE_QUERIES[i]).all()).results;
      rowArrays(rows, COLUMNS[table]);
      baseline[table] = rows.map((row) => Object.fromEntries(COLUMNS[table].map((col) => [col, row[col]])));
    }
    return { schemaSha256: schemaHash(schema), refs, baseline };
  } finally { await mf.dispose(); }
}

// Injected clock only. Canonical ISO, non-decreasing.
function clock(ctx) {
  let now;
  try { now = ctx.io.now(); } catch { throw new Stop('NOW_INVALID'); }
  need(typeof now === 'string' && ISO.test(now) && new Date(Date.parse(now)).toISOString() === now, 'NOW_INVALID');
  need(ctx.lastNowMs === null || Date.parse(now) >= ctx.lastNowMs, 'NOW_NOT_MONOTONE');
  ctx.lastNowMs = Date.parse(now);
  return now;
}

function fetchGate(ctx, objects) {
  const T = ctx.profile.target, endpoint = endpointFor(T), fetchImpl = ctx.io.fetchImpl;
  const urls = new Set(objects.map((o) => `https://${T.accountId}.r2.cloudflarestorage.com/${T.bucket}/${o.key}`));
  return (url, init) => {
    const d1 = url === endpoint && init?.method === 'POST' && typeof init.body === 'string' && Buffer.byteLength(init.body) <= MAX_REQUEST_BYTES;
    const r2 = urls.has(url) && (init?.method === 'GET' || (init?.method === 'PUT' && ctx.phase === 'IMPORT' &&
      init.headers?.['if-none-match'] === '*' && init.body instanceof Uint8Array && init.body.byteLength <= ARTIFACT_LIMITS.fileBytes));
    if ((!d1 && !r2) || init?.redirect !== 'error' || ctx.requests >= ctx.requestBudget) { ctx.blockedRequests++; return Promise.reject(new Error('BLOCKED')); }
    ctx.requests++;
    if ((d1 && !['EMPTY_CHECK', 'TARGET_CHECK'].includes(ctx.phase)) || init.method === 'PUT') ctx.writeAttempts++;
    return fetchImpl(url, init);
  };
}
async function withResponse(ctx, url, init, consume) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Stop('HTTP_TIMEOUT')), { once: true }));
  aborted.catch(() => {});
  let response, pending;
  try {
    pending = Promise.resolve().then(() => ctx.fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal }));
    try { response = await Promise.race([pending, aborted]); } catch (error) { throw error instanceof Stop ? error : new Stop('HTTP_FAILED'); }
    need(response && response.redirected !== true && (!response.url || response.url === url), 'HTTP_UNTRUSTED');
    ctx.httpStatus = Number.isSafeInteger(response.status) ? response.status : null;
    return await Promise.race([consume(response, controller.signal), aborted]);
  } finally {
    clearTimeout(timer); quiet(() => response?.body?.cancel());
    pending?.then((late) => { if (late !== response) quiet(() => late?.body?.cancel()); }, () => {});
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
async function d1(ctx, queries, single = false) {
  const body = JSON.stringify(single ? queries[0] : { batch: queries });
  const json = await withResponse(ctx, endpointFor(ctx.profile.target), { method: 'POST', headers: { Authorization: `Bearer ${ctx.credential.token}`, 'Content-Type': 'application/json' }, body }, readJson);
  need(keys(json, ['result', 'errors', 'messages', 'success']) && json.success === true && Array.isArray(json.errors) && json.errors.length === 0 && Array.isArray(json.messages) && json.messages.length === 0 && Array.isArray(json.result) && json.result.length === queries.length, 'HTTP_ENVELOPE');
  return json.result.map((r) => {
    need(keys(r, ['success', 'results'], ['meta']) && r.success === true && Array.isArray(r.results) && r.results.length <= 1000, 'HTTP_RESULT'); return r.results;
  });
}
const queriesFor = (sqls) => sqls.map((sql) => ({ sql, params: [] }));
async function absentObjects(ctx, objects) {
  const T = ctx.profile.target, host = `${T.accountId}.r2.cloudflarestorage.com`;
  for (const o of objects) {
    const canonicalUri = `/${T.bucket}/${o.key}`, url = `https://${host}${canonicalUri}`, now = clock(ctx);
    const amzDate = `${now.slice(0, 4)}${now.slice(5, 7)}${now.slice(8, 10)}T${now.slice(11, 13)}${now.slice(14, 16)}${now.slice(17, 19)}Z`;
    const headers = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': EMPTY_SHA };
    const signed = signV4({ method: 'GET', canonicalUri, headers, payloadSha256: EMPTY_SHA, amzDate, region: R2_REGION, service: R2_SERVICE,
      accessKeyId: ctx.credential.accessKeyId, secretAccessKey: ctx.credential.secretAccessKey });
    await withResponse(ctx, url, { method: 'GET', headers: { ...headers, authorization: signed.authorization } }, async (response) => {
      quiet(() => response.body?.cancel()); // no provider text/foreign bytes read
      need(response.status === 404, response.status === 200 ? 'R2_DESTINATION_CONFLICT' : 'R2_ABSENCE_UNPROVEN');
    });
    ctx.destinationsAbsent++;
  }
}
function descriptorFor(ctx, plan, planSha256, baseline, now, expiresAt, nonces) {
  const P = ctx.profile;
  return { format: 'sikap-remote-import-descriptor', version: 1, ...P.target, snapshotId: plan.snapshotId, sourceSha256: plan.sourceSha256,
    planSha256, appSchemaSha256: P.appSchema, ledgerSchemaSha256: P.ledgerSchema,
    baselineSha256: runner.hashBaseline(baseline), policySha256: P.policy, retentionPolicySha256: P.retention,
    runNonce: nonces.run, ownerNonce: nonces.owner, epoch: 0, expiresAt };
}
const nonce = () => randomUUID().replace(/-/g, '');
// The permit must carry exactly this kind's marker and target; a foreign permit kind can never pass.
function assertPermitKind(ctx, permit) {
  const P = ctx.profile;
  need(permit?.[P.marker] === true && P.foreignMarkers.every((m) => !Object.hasOwn(permit, m)) &&
    permit.databaseId === P.target.databaseId && permit.databaseName === P.target.databaseName && permit.bucket === P.target.bucket, 'PERMIT_KIND_MISMATCH');
}

async function execute(ctx, request) {
  const { mode, pins } = request;
  ctx.phase = 'STATIC_CHECK';
  if (mode === 'print-pins') {
    // Local fixed-repo reads only. Self-sources are printed for the reviewer to record; never enforced.
    ctx.pins = PINS.MODULE_FILES.map((file) => [file, sha256(lf(file))]);
    ctx.selfSources = PINS.SELF_SOURCES.map((file) => [file, sha256(lf(file))]);
    ctx.phase = 'DONE'; return 'PINS_PRINTED';
  }
  const statements = staticCheck(ctx, pins); ctx.setupStatements.planned = statements.length;
  const pinned = mode !== 'describe-plan';
  if (pinned) planFactsCheck(pins.planFacts);
  ctx.phase = 'PRIVATE_VALIDATION'; const artifacts = await loadPrivate(ctx, request.io, pins.planFacts, pinned);
  if (mode === 'describe-plan') { ctx.phase = 'DONE'; return 'PLAN_DESCRIBED'; }
  ctx.phase = 'LOCAL_EXPECTED'; const expected = await expectedDatabase(statements);
  // Provisional compile (max-TTL descriptor, fixed now) only to count chunks; nonces do not affect boundaries.
  ctx.phase = 'BUDGET';
  const planNow = clock(ctx);
  const nonces = { run: nonce(), owner: nonce() };
  const provisional = descriptorFor(ctx, artifacts.plan, ctx.facts.planSha256, expected.baseline, planNow, new Date(Date.parse(planNow) + MAX_DESCRIPTOR_TTL_MS).toISOString(), nonces);
  validateDescriptor(provisional, planNow);
  const chunks = compileChunks({ tables: artifacts.plan.tables }, provisional, { now: planNow }).chunkCount;
  ctx.chunks = chunks;
  ctx.requestBudget = requestBudget(artifacts.objects.length, chunks);
  ctx.requiredWindowMs = requiredWindowMs(ctx.requestBudget);
  need(ctx.requestBudget <= MAX_REQUESTS, 'REQUEST_BUDGET_EXCEEDED');
  need(ctx.requiredWindowMs <= MAX_DESCRIPTOR_TTL_MS - CREDENTIAL_MARGIN_MS, 'RUN_WINDOW_EXCEEDS_CAP');
  if (mode === 'check-only') {
    const permit = ctx.profile.issue({ descriptor: provisional, planBytes: artifacts.planBytes, now: planNow });
    assertPermitKind(ctx, permit);
    compileChunks({ tables: getPermitTables(permit) }, provisional, { now: planNow });
    ctx.phase = 'DONE'; return 'CHECK_ONLY_OK';
  }

  ctx.phase = 'CREDENTIAL';
  // Snapshot once into a frozen private copy BEFORE validation: exact 5 own enumerable DATA keys, no symbols,
  // extras or accessors (getters are never invoked). Only this snapshot is used for the window, descriptor
  // and every request header, so later mutation of the reader-owned object has no effect.
  const rawCredential = await request.io.readCredential();
  let c;
  try { c = Object.freeze(plain(rawCredential, ['token', 'expiresAt', 'accessKeyId', 'secretAccessKey', 'r2ExpiresAt'])); } catch { throw new Stop('CREDENTIAL_INVALID'); }
  ctx.credential = c;
  need(typeof c.token === 'string' && c.token.length >= 20 && c.token.length <= 4096 && TOKEN.test(c.token) &&
    typeof c.accessKeyId === 'string' && /^[A-Za-z0-9]{16,128}$/.test(c.accessKeyId) && typeof c.secretAccessKey === 'string' && /^[\x21-\x7e]{16,128}$/.test(c.secretAccessKey), 'CREDENTIAL_INVALID');
  // Strict UTC instants only: Date.parse alone accepts zone-less/partial strings, and a local time mislabelled
  // as UTC would silently shift the real expiry (mid-run 401 after writes). BOTH credentials must be dated:
  // the D1 token and the R2 key each expire on their own and either one halts the run mid-write.
  const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  need(typeof c.expiresAt === 'string' && INSTANT.test(c.expiresAt) && Number.isFinite(Date.parse(c.expiresAt)) &&
    typeof c.r2ExpiresAt === 'string' && INSTANT.test(c.r2ExpiresAt) && Number.isFinite(Date.parse(c.r2ExpiresAt)), 'CREDENTIAL_INVALID');
  // Window: descriptor expiry = min(now + core max, earliest credential expiry - timeout - margin). The credential
  // therefore outlives the descriptor by >= one timeout + margin, and the descriptor must cover the window.
  const now = clock(ctx), nowMs = Date.parse(now), credMs = Math.min(Date.parse(c.expiresAt), Date.parse(c.r2ExpiresAt));
  const expiresMs = Math.min(nowMs + MAX_DESCRIPTOR_TTL_MS, credMs - TIMEOUT_MS - CREDENTIAL_MARGIN_MS);
  ctx.credentialRemainingMs = Math.max(0, credMs - nowMs);
  ctx.runWindowMs = Math.max(0, expiresMs - nowMs);
  // Each credential is capped on its own (the later expiry bounds residual risk; the earlier one bounds the window).
  need(Math.max(Date.parse(c.expiresAt), Date.parse(c.r2ExpiresAt)) - nowMs <= MAX_CREDENTIAL_LIFETIME_MS, 'CREDENTIAL_LIFETIME_TOO_LONG');
  need(expiresMs - nowMs >= ctx.requiredWindowMs, 'CREDENTIAL_WINDOW_INSUFFICIENT');
  const descriptor = descriptorFor(ctx, artifacts.plan, ctx.facts.planSha256, expected.baseline, now, new Date(expiresMs).toISOString(), nonces);
  validateDescriptor(descriptor, now);
  const permit = ctx.profile.issue({ descriptor, planBytes: artifacts.planBytes, now });
  assertPermitKind(ctx, permit);
  need(compileChunks({ tables: getPermitTables(permit) }, descriptor, { now }).chunkCount === chunks, 'CHUNK_COUNT_DRIFT');
  ctx.fetch = fetchGate(ctx, artifacts.objects);

  ctx.phase = 'EMPTY_CHECK'; const empty = (await d1(ctx, queriesFor([EMPTY_SQL])))[0];
  need(empty.length === 1 && keys(empty[0], ['user_objects']) && empty[0].user_objects === 0, 'TARGET_NOT_EMPTY'); ctx.targetEmptyObserved = true;
  ctx.phase = 'OBJECT_ABSENCE'; await absentObjects(ctx, artifacts.objects);
  ctx.phase = 'SETUP';
  for (const sql of statements) { const rows = await d1(ctx, [{ sql, params: [] }], true); need(rows[0].length === 0, 'SETUP_ROWS'); ctx.setupStatements.applied++; }
  ctx.phase = 'TARGET_CHECK';
  const rows = await d1(ctx, queriesFor([SCHEMA_QUERY.sql, ...REF_QUERIES, ...COUNT_QUERIES, ...BASELINE_QUERIES, 'PRAGMA foreign_key_check']));
  rowArrays(rows[0], SCHEMA_QUERY.columns);
  need(schemaHash(rows[0]) === expected.schemaSha256, 'REMOTE_SCHEMA_MISMATCH'); ctx.schemaObserved = true;
  for (let i = 0; i < REFS.length; i++) need(JSON.stringify(rowArrays(rows[i + 1], REFS[i].columns)) === JSON.stringify(expected.refs[i]), 'REFERENCE_CONTENT_MISMATCH');
  ctx.referencesObserved = true;
  const offset = 1 + REFS.length;
  for (let i = 0; i < COUNT_QUERIES.length; i++) need(rows[offset + i].length === 1 && keys(rows[offset + i][0], ['n']) && rows[offset + i][0].n === 0, 'OPERATIONAL_ROWS_PRESENT');
  need(rows[rows.length - 1].length === 0, 'FOREIGN_KEY_VIOLATION'); ctx.operationalEmptyObserved = true;
  const baseline = Object.fromEntries(IMPORT_TABLES.map((t, i) => {
    const r = rows[offset + COUNT_QUERIES.length + i]; rowArrays(r, COLUMNS[t]); return [t, r.map((row) => Object.fromEntries(COLUMNS[t].map((col) => [col, row[col]])))];
  }));
  need(JSON.stringify(baseline) === JSON.stringify(expected.baseline), 'BASELINE_MISMATCH');
  ctx.phase = 'BOOTSTRAP';
  const state0 = [1, descriptor.runNonce, descriptor.ownerNonce, 0, permit.targetBindingSha256, ctx.facts.planSha256, 0, 0, 0, 0, null, 0];
  const boot = await d1(ctx, [{ sql: BOOTSTRAP_SQL, params: [JSON.stringify(state0)] }], true); need(boot[0].length === 0, 'BOOTSTRAP_ROWS');
  ctx.phase = 'IMPORT';
  const report = await runner.runPrivateUatImport({ permit, objects: artifacts.objects, baseline, d1Token: c.token,
    r2AccessKeyId: c.accessKeyId, r2SecretAccessKey: c.secretAccessKey, d1FetchImpl: ctx.fetch, r2FetchImpl: ctx.fetch,
    nowProvider: () => clock(ctx), timeoutMs: TIMEOUT_MS });
  ctx.runnerReport = report;
  // The shared runner names its real-data success COMPLETE_UAT_RECONCILED for EVERY real-data permit
  // (UAT, production or rehearsal); the orchestrator maps it to the kind's own fixed status.
  need(report?.status === 'COMPLETE_UAT_RECONCILED', 'RUNNER_STOPPED');
  need(ctx.requests === ctx.requestBudget, 'REQUEST_COUNT_MISMATCH');
  ctx.phase = 'DONE'; return ctx.profile.success;
}

const OK = ['CHECK_ONLY_OK', 'COMPLETE_PROD_RECONCILED', 'COMPLETE_SYNTHETIC_REHEARSAL', 'PLAN_DESCRIBED', 'PINS_PRINTED'];
const NO_PROFILE = Object.freeze({ target: Object.freeze({ databaseName: null, databaseId: null }), productionImport: false, syntheticRehearsal: false });
function summary(ctx, status, code) {
  const P = ctx.profile ?? NO_PROFILE;
  return deepFreeze({ kind: ctx.kind, targetName: P.target.databaseName, targetId: P.target.databaseId, phase: ctx.phase, status, code, httpStatus: ctx.httpStatus,
    setupStatements: { ...ctx.setupStatements }, requests: ctx.requests, requestBudget: ctx.requestBudget, chunks: ctx.chunks,
    requiredWindowMs: ctx.requiredWindowMs, runWindowMs: ctx.runWindowMs, credentialRemainingMs: ctx.credentialRemainingMs,
    blockedRequests: ctx.blockedRequests, writeAttempts: ctx.writeAttempts,
    filesVerified: ctx.filesVerified, fileBytesVerified: ctx.fileBytesVerified, destinationsAbsent: ctx.destinationsAbsent,
    targetEmptyObserved: ctx.targetEmptyObserved, schemaObserved: ctx.schemaObserved, referencesObserved: ctx.referencesObserved, operationalEmptyObserved: ctx.operationalEmptyObserved,
    residuesRetained: ctx.writeAttempts > 0, manualRecoveryRequired: !OK.includes(status) && ctx.writeAttempts > 0,
    ...(ctx.inventory ? { bindingInventory: ctx.inventory } : {}),
    ...(ctx.pins ? { modulePins: ctx.pins, selfSources: ctx.selfSources, selfSourcesEnforced: false } : {}),
    ...(ctx.facts && status === 'PLAN_DESCRIBED' ? { planFacts: ctx.facts } : {}),
    ...(ctx.runnerReport ? { runnerReport: ctx.runnerReport } : {}),
    ready: false, readyForImport: false, remoteAuthorized: false, transportProven: false, authorizesExecution: false,
    authorizesRetry: false, authorizesResume: false, completeFlagSet: false, appBindingAllowed: false, appOpened: false, deployed: false,
    productionVerified: false, cleanupAttempted: false, wholeBucketEmptyProven: false, snapshotConsistent: false, credentialRefreshed: false,
    remoteBindingProof: false, tokenScopeVerified: false,
    productionImport: P.productionImport, syntheticRehearsal: P.syntheticRehearsal });
}

// Validates the request; returns frozen { kind, mode, io, pins } or throws Stop('OPTIONS_INVALID').
function validateRequest(raw, ctx) {
  const r = plain(raw, ['kind', 'mode', 'io'], ['rehearsal']);
  need(typeof r.kind === 'string' && KINDS.includes(r.kind), 'OPTIONS_INVALID');
  ctx.kind = r.kind; ctx.profile = PROFILES[r.kind];
  need(typeof r.mode === 'string' && ORCHESTRATOR_MODES.includes(r.mode), 'OPTIONS_INVALID');
  const io = Object.freeze(plain(r.io, ['readPlanBytes', 'readFileBytes', 'readCredential', 'fetchImpl', 'now']));
  need(Object.values(io).every((f) => typeof f === 'function'), 'OPTIONS_INVALID');
  let pins;
  if (r.kind === 'production') {
    need(!Object.hasOwn(r, 'rehearsal'), 'OPTIONS_INVALID');
    // Deep frozen snapshot: once pinned, nested expected/warningCounts objects cannot be mutated at runtime.
    pins = { modules: PINS.MODULE_PINS, planFacts: plainData(PINS.PLAN_FACTS) };
  } else {
    need(Object.hasOwn(r, 'rehearsal'), 'OPTIONS_INVALID');
    const reh = plain(r.rehearsal, ['planFacts', 'modulePins']);
    const facts = plainData(reh.planFacts);
    need(keys(facts, ['snapshotId', 'planSha256', 'expected', 'warningCounts', 'diagnosticsTotal']), 'OPTIONS_INVALID');
    const modules = plainData(reh.modulePins);
    need(Array.isArray(modules) && modules.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' && SHA.test(p[1])), 'OPTIONS_INVALID');
    // A rehearsal may never reuse the reviewed production plan identity.
    need(PINS.PLAN_FACTS.planSha256 === PENDING || facts.planSha256 !== PINS.PLAN_FACTS.planSha256, 'OPTIONS_INVALID');
    pins = { modules, planFacts: facts };
  }
  return Object.freeze({ kind: r.kind, mode: r.mode, io, pins: Object.freeze(pins) });
}

let active = false;
// Never throws; returns a frozen public-safe summary (counts, codes, booleans; no secrets/rows/paths).
export async function orchestrateImport(rawRequest) {
  const ctx = { kind: null, profile: null, phase: 'ARGS', httpStatus: null, setupStatements: { planned: 0, applied: 0 }, requests: 0, requestBudget: null, chunks: null,
    requiredWindowMs: null, runWindowMs: null, credentialRemainingMs: null, blockedRequests: 0, writeAttempts: 0,
    filesVerified: 0, fileBytesVerified: 0, destinationsAbsent: 0, targetEmptyObserved: false, schemaObserved: false, referencesObserved: false, operationalEmptyObserved: false,
    runnerReport: null, credential: null, facts: null, pins: null, selfSources: null, inventory: null, io: null, lastNowMs: null, fetch: null };
  let request;
  try { request = validateRequest(rawRequest, ctx); } catch { return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID'); }
  if (active) return summary(ctx, 'STOPPED_BUSY', 'BUSY');
  active = true; ctx.io = request.io;
  try { return summary(ctx, await execute(ctx, request), null); }
  catch (error) {
    let code = 'OPERATION_FAILED';
    if (error instanceof Stop) code = error.code;
    else if (error instanceof RealDataGateError) code = `GATE_${error.code}`;
    else if (error instanceof ImportCoreError) code = `CORE_${error.code}`;
    else { try { if (READER_ERROR_CODES.includes(error?.code)) code = error.code; } catch { /* fixed code only */ } }
    return summary(ctx, `STOPPED_${ctx.phase}`, code);
  }
  finally { ctx.credential = null; ctx.fetch = null; ctx.io = null; active = false; }
}
