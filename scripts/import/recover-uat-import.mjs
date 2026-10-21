// Fixed-target private UAT RECOVERY operator (ordinal-0 file recovery). Importing performs no I/O.
// PERMANENTLY RETIRED: executeUatRecovery() and the CLI always return STOPPED_RETIRED/DRIVER_RETIRED with
// zero I/O (see RETIRED_RESULT). Everything below is historical evidence only.
// Parent/operator ONLY, after independent review and the user's explicit recovery authorization:
//   node scripts/import/recover-uat-import.mjs --check-only  (reads PRIVATE plan + 66 files; no auth/HTTP)
//   node scripts/import/recover-uat-import.mjs               (one-shot recovery; no retry/cleanup)
// Scope: the target already holds the setup schema, seeded references, the bootstrap run row at state 0
// and part of the manifest objects from the stopped run. This driver NEVER resets, sets up, bootstraps,
// deletes, overwrites, advances or resumes an ordinal. It sends NO DDL/INSERT itself: before IMPORT it
// issues exactly ONE static read-only D1 batch (schema, references, 13 operational counts, journal count,
// run row, 7 baseline tables, foreign_key_check). The descriptor reuses the receipt's runNonce/ownerNonce,
// epoch 0 and a fresh 2h expiry (expiresAt and nonces are not part of the core target binding), and the
// recomputed targetBindingSha256 must equal the receipt. Only then is a fresh in-process permit issued and
// runner.runPrivateUatRecovery called: it re-GETs every manifest object, reuses exact matches and uploads
// a missing one create-only (If-None-Match:*), all before its first D1 send. No R2 request happens here.
// Timeout: MAX_RUNNER_TIMEOUT_MS (60s) per request, chosen to reduce avoidable timeouts after the original
// 30s file-55 stop (cause not proven). It is a policy, not a retry; body caps are unchanged. Any failure,
// including expired credentials, stops and retains state; there is no automatic refresh, retry or cleanup.
// recoveryRun:true reflects the user-authorized context only; every authority/ready flag stays false.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_LIMITS, IMPORT_TABLES } from '../migrate/contract.mjs';
import { EMPTY_TABLES, readVerifiedFile, validatePlan } from '../migrate/apply-local.mjs';
import { isMain, readBoundedPlan, splitMigration } from '../migrate/local-store.mjs';
import { COLUMNS, LEDGER, PRIMARY, compileChunks, validateDescriptor } from './core.mjs';
import { LEDGER_DDL_SHA256, LEDGER_SQL_FILE, validateLedgerSql } from './ledger-contract.mjs';
import { SCHEMA_QUERY } from './d1-readback.mjs';
import { UAT_TARGET, UAT_APP_SCHEMA_SHA256, UAT_LEDGER_SCHEMA_SHA256, UAT_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256, issueRealDataUatPermit, getPermitTables } from './real-data-gate.mjs';
import * as runner from './synthetic-runner.mjs';

export const TARGET = Object.freeze({ accountId: '04b8b2073be2f1aa21fc6489e0db36f6', databaseId: '885b655b-3482-44fc-9d01-56ad0204bb35',
  databaseName: 'sikap-import-uat-20261018', bucket: 'sikap-import-uat-20261018-files', profile: 'real-data' });
export const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${TARGET.accountId}/d1/database/${TARGET.databaseId}/query`;
const ROOT = new URL('../../', import.meta.url);
const PLAN_PATH = 'C:/Users/elwin/sikap-private/dry-run-sumber-nyata/plan-uat-20261018/plan.sikap-plan.json';
const FILES_ROOT = 'C:/Users/elwin/sikap-private/dry-run-sumber-nyata/snapshot-039d8212-44e9-43b5-b48b-aff9d3dff27f/files';
const SNAPSHOT = '039d8212-44e9-43b5-b48b-aff9d3dff27f';
const PLAN_SHA256 = '3e078341888fc457da4bdceab304c896c677124083e352ecbe885f4ff174a12b';
const OAUTH_PATH = 'C:\\Users\\elwin\\AppData\\Roaming\\xdg.config\\.wrangler\\config\\default.toml';
const PENDING = '0000000000000000000000000000000000000000000000000000000000000000';
const TIMEOUT_MS = runner.MAX_RUNNER_TIMEOUT_MS, MAX_RESPONSE_BYTES = 1024 * 1024, MAX_REQUEST_BYTES = 128 * 1024, MAX_REQUESTS = 1200;
const MIN_CREDENTIAL_TTL_MS = 15 * 60 * 1000, DESCRIPTOR_TTL_MS = 2 * 60 * 60 * 1000;
const CHECK_ONLY_NONCES = Object.freeze({ runNonce: 'a'.repeat(32), ownerNonce: 'b'.repeat(32) }); // compile-only, never sent
const EXPECTED = Object.freeze({ pegawai: 46, akun: 46, arsip: 63, files: 66, totalFileBytes: 44_162_297 });
const WARNING_COUNTS = Object.freeze({ NON_ATOMIC_SNAPSHOT: 1, OWNER_REQUIREMENT_MATRIX: 11,
  CUSTOM_JENIS_OPTIONAL: 1, NORMALIZED_PANGKAT: 6, NORMALIZED_UNIT: 10,
  NORMALIZED_PENDIDIKAN: 10, PLACEHOLDER_PANGKAT: 4, MISSING_HISTORIC_LOG_ACTOR: 31 });
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
// SHA-256 of LF-normalized modules. Parent replaces PENDING after review; PENDING fails closed.
const MODULE_PINS = Object.freeze([
  ['scripts/import/core.mjs', '3f85c5d4b2038d6b689556c7ff857b6d4cb31cab6f82d6302c2f4f7c2e09d520'],
  ['scripts/import/d1-rest.mjs', '657c16bdbeff0b2e220e58c1722b040f6a7f093e4df43266cb8859396cf57e4c'],
  ['scripts/import/d1-readback.mjs', '27fa0e4d4157c3a18c7d0c204db08535c69a319c9f9ec5fdb7d953bd86a6939b'],
  ['scripts/import/r2-s3.mjs', 'ced68c6192a2407b7cae3e39a68288ec84f365fafef88ba0a712c0083a36c2fd'],
  ['scripts/import/real-data-gate.mjs', 'ef29ff522865c2e3061f3e4fa5643daa6b46ca316620355c0e2d24be67af8fe9'],
  ['scripts/import/synthetic-runner.mjs', 'dad10c37d2583d4e852dde13991fa23a7f47f438aac0eae5c4c52699e23979f8'],
  ['scripts/import/ledger-contract.mjs', 'fdfbd5d58dcc91a2f29d427c3f21ab3cef7e261b90f5767664c9fb1245b5fc16'],
  ['scripts/migrate/local-store.mjs', 'a6852f3020c164646ffde4aaf4fbc37973d5953a82c4bb99b7ed24c54033622b'],
  ['scripts/migrate/apply-local.mjs', '9ae67c4e31af3f4f1f627835e88f2b2ce0d404e76999f821af92a1e1210061ec'],
  ['scripts/migrate/normalize.mjs', '6cb008d07b8366ec4c4e777624df8d70bccd1881e945211aaa0eacc391344c90'],
  ['scripts/migrate/contract.mjs', '3678235bd07cbc3eb8eebd0a35c5ef8c0807426a33bd967436777761285bebc6'],
  ['scripts/staging/uat-constants.mjs', 'b260c3f17a794ab0b44eb11dd32c6aeb23e9816a148f7f68e5c1aff6cf1eb5a7'],
]);
const CONFIG_FILES = ['wrangler.toml', 'workers/cron/wrangler.toml', 'ops/uat-app/wrangler.toml', 'ops/uat/wrangler.toml', 'ops/tx-probe/wrangler.toml'];
const REFS = [
  { table: 'ref_pangkat_golongan', columns: ['kode', 'nama', 'jenis_asn', 'urutan', 'aktif'], order: ['kode'] },
  { table: 'ref_unit_organisasi', columns: ['id', 'nama', 'aktif'], order: ['id'] },
  { table: 'ref_pendidikan', columns: ['kode', 'nama', 'urutan'], order: ['kode'] },
  ...['jenis_dokumen', 'jenis_dokumen_wajib'].map((table) => ({ table, columns: COLUMNS[table], order: PRIMARY[table] })),
];
const select = (columns, table, order) => `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order.join(', ')}`;
const BASELINE_QUERIES = IMPORT_TABLES.map((t) => select(COLUMNS[t], t, PRIMARY[t]));
const REF_QUERIES = REFS.map((r) => select(r.columns, r.table, r.order));
const COUNT_QUERIES = [...EMPTY_TABLES, LEDGER.journalTable].map((t) => `SELECT count(*) AS n FROM ${t}`);
const RUN_QUERY = select(LEDGER.runColumns, LEDGER.runTable, ['id']);
// The only pre-IMPORT D1 body: static, read-only, byte-exact (enforced by the fetch gate).
const PREFLIGHT_SQL = Object.freeze([SCHEMA_QUERY.sql, ...REF_QUERIES, ...COUNT_QUERIES, RUN_QUERY, ...BASELINE_QUERIES, 'PRAGMA foreign_key_check']);
const PREFLIGHT_BODY = JSON.stringify({ batch: PREFLIGHT_SQL.map((sql) => ({ sql, params: [] })) });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/, HEX32 = /^[0-9a-f]{32}$/, SHA = /^[0-9a-f]{64}$/;
const obj = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v, required, optional = []) => obj(v) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k)) && required.every((k) => Object.hasOwn(v, k));
class Stop { constructor(code) { this.code = code; } }
const need = (ok, code) => { if (!ok) throw new Stop(code); };
const quiet = (fn) => { try { const p = fn(); p?.catch?.(() => {}); } catch { /* discard only */ } };
const schemaHash = (rows) => sha256(JSON.stringify([...rows].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((r) => [r.type, r.name, r.tbl_name, r.sql])));
const rowArrays = (rows, columns) => rows.map((r) => { need(keys(r, columns), 'ROW_SHAPE'); return columns.map((c) => r[c]); });
const baselineOf = (table, rows) => { rowArrays(rows, COLUMNS[table]); return rows.map((row) => Object.fromEntries(COLUMNS[table].map((col) => [col, row[col]]))); };

function staticCheck() {
  need(JSON.stringify(TARGET) === JSON.stringify(UAT_TARGET), 'TARGET_PIN_MISMATCH');
  need(UAT_APP_SCHEMA_SHA256 === '143fef6ecb05c450c38b697e6524d9c5e12072ef819c95d052fb210f323c7f72' && UAT_LEDGER_SCHEMA_SHA256 === LEDGER_DDL_SHA256, 'SCHEMA_PIN_MISMATCH');
  const names = readdirSync(new URL('migrations/', ROOT)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  need(JSON.stringify(names) === JSON.stringify(MIGRATION_PINS.map((p) => p[0])), 'MIGRATION_SET_MISMATCH');
  const statements = [];
  for (const [name, pin] of MIGRATION_PINS) {
    const sql = readFileSync(new URL(`migrations/${name}`, ROOT), 'utf8');
    need(!sql.includes('\r') && sha256(sql) === pin, 'MIGRATION_HASH_MISMATCH');
    statements.push(...splitMigration(sql));
  }
  need(sha256(JSON.stringify(['sikap-app-migrations', 1, MIGRATION_PINS])) === UAT_APP_SCHEMA_SHA256, 'APP_SCHEMA_PIN_MISMATCH');
  const ddl = readFileSync(new URL(LEDGER_SQL_FILE, ROOT), 'utf8');
  need(validateLedgerSql(ddl).valid === true, 'LEDGER_HASH_MISMATCH');
  statements.push(...splitMigration(ddl.replace(/\r\n/g, '\n')));
  need(statements.length === 67, 'SETUP_COUNT_MISMATCH'); // local in-memory derivation only, never sent
  for (const [file, pin] of MODULE_PINS) {
    need(pin !== PENDING, 'RUNTIME_PIN_PENDING');
    need(sha256(readFileSync(new URL(file, ROOT), 'utf8').replace(/\r\n/g, '\n')) === pin, 'MODULE_PIN_MISMATCH');
  }
  need(typeof runner.runPrivateUatRecovery === 'function' && runner.MAX_RUNNER_TIMEOUT_MS === 60_000 &&
    /^[a-f0-9]{64}$/.test(runner.UAT_EXPECTED_SCHEMA_SHA256) && runner.UAT_EXPECTED_SCHEMA_SHA256 !== PENDING, 'RUNNER_PIN_PENDING');
  need(Buffer.byteLength(PREFLIGHT_BODY) <= MAX_REQUEST_BYTES, 'PREFLIGHT_BODY_SIZE');
  for (const file of CONFIG_FILES) {
    const text = readFileSync(new URL(file, ROOT), 'utf8');
    need(!text.includes(TARGET.databaseId) && !text.includes(TARGET.databaseName) && !text.includes(TARGET.bucket), 'APP_BINDING_PRESENT');
  }
  return statements;
}

async function loadPrivate(options, ctx) {
  const planBytes = await options.readPlanBytes();
  need(planBytes instanceof Uint8Array && planBytes.byteLength > 0 && planBytes.byteLength <= ARTIFACT_LIMITS.exportBytes && sha256(planBytes) === PLAN_SHA256, 'PLAN_HASH_MISMATCH');
  let plan;
  try { plan = validatePlan(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes))); } catch { throw new Stop('PLAN_INVALID'); }
  need(plan.snapshotId === SNAPSHOT && plan.sourceReadOnlyDeclared === true && plan.consistent === false && plan.ready === true, 'PLAN_SCOPE_MISMATCH');
  need(Object.keys(EXPECTED).every((k) => plan.expected[k] === EXPECTED[k]) && plan.files.filter((f) => f.kind === 'photo').length === 3 && plan.files.filter((f) => f.kind === 'document').length === 63, 'PLAN_COUNTS_MISMATCH');
  const warnings = {};
  for (const d of plan.diagnostics) { need(d.severity === 'warning' && Object.hasOwn(WARNING_COUNTS, d.code), 'PLAN_WARNING_DENIED'); warnings[d.code] = (warnings[d.code] ?? 0) + 1; }
  need(Object.keys(WARNING_COUNTS).every((k) => warnings[k] === WARNING_COUNTS[k]) && plan.diagnostics.length === 74, 'PLAN_WARNING_MISMATCH');
  const objects = []; let total = 0;
  for (const file of plan.files) {
    total += file.sizeBytes;
    need(total <= 64 * 1024 * 1024 && file.sizeBytes <= ARTIFACT_LIMITS.fileBytes, 'FILES_BUDGET');
    const bytes = await options.readFileBytes(Object.freeze({ ...file }));
    need(bytes instanceof Uint8Array && bytes.byteLength === file.sizeBytes && sha256(bytes) === file.sha256, 'FILE_INTEGRITY');
    objects.push({ key: file.r2Key, bytes, mimeType: file.mimeType, sha256: file.sha256 });
    ctx.filesVerified++;
  }
  need(total === EXPECTED.totalFileBytes && ctx.filesVerified === 66, 'FILES_COUNT_MISMATCH');
  ctx.fileBytesVerified = total;
  return { planBytes, plan, objects };
}

// In-memory schema/reference/baseline derivation from the exact pinned SQL (outbound denied, no persistence).
async function expectedDatabase(statements) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };', outboundService: () => new Response(null, { status: 403 }),
    log: new Log(LogLevel.NONE), cf: false, telemetry: { enabled: false }, d1Persist: false, d1Databases: { DB: 'sikap-recovery-driver-memory' } }));
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of statements) await db.prepare(sql).run();
    const schema = (await db.prepare(SCHEMA_QUERY.sql).all()).results;
    need(schemaHash(schema) === runner.UAT_EXPECTED_SCHEMA_SHA256, 'LOCAL_SCHEMA_MISMATCH');
    const refs = [];
    for (let i = 0; i < REF_QUERIES.length; i++) refs.push(rowArrays((await db.prepare(REF_QUERIES[i]).all()).results, REFS[i].columns));
    const baseline = {};
    for (let i = 0; i < IMPORT_TABLES.length; i++) baseline[IMPORT_TABLES[i]] = baselineOf(IMPORT_TABLES[i], (await db.prepare(BASELINE_QUERIES[i]).all()).results);
    return { schemaSha256: schemaHash(schema), refs, baseline };
  } finally { await mf.dispose(); }
}

// Only oauth_token/expiration_time and two dotenv names are extracted. No eval, shell, process.env or echo.
async function readCredentials() {
  const oauth = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedPlan(OAUTH_PATH, 64 * 1024));
  const pickOAuth = (key) => {
    const matches = [...oauth.matchAll(new RegExp(`^${key}[ \\t]*=[ \\t]*"([^"\\\\\\r\\n]*)"[ \\t\\r]*$`, 'gm'))];
    need(matches.length === 1, 'CREDENTIAL_FORMAT'); return matches[0][1];
  };
  const dotenv = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedPlan(fileURLToPath(new URL('.dev.vars', ROOT)), 64 * 1024));
  const pickDotenv = (key) => {
    const found = dotenv.split(/\r?\n/).filter((line) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`).test(line));
    need(found.length === 1, 'CREDENTIAL_FORMAT');
    const value = found[0].slice(found[0].indexOf('=') + 1).trim();
    const m = /^(?:"([^"\\\r\n]*)"|'([^'\r\n]*)'|([^\s#'"\\]+))[ \t]*(?:#.*)?$/.exec(value);
    need(m !== null, 'CREDENTIAL_FORMAT'); return m[1] ?? m[2] ?? m[3];
  };
  return { token: pickOAuth('oauth_token'), expiresAt: pickOAuth('expiration_time'),
    accessKeyId: pickDotenv('R2_ACCESS_KEY_ID'), secretAccessKey: pickDotenv('R2_SECRET_ACCESS_KEY') };
}

// PREFLIGHT: exactly one D1 POST whose body is PREFLIGHT_BODY; no R2. IMPORT: D1 POST (runner adapters)
// and R2 GET/create-only PUT to the 66 manifest URLs with exact sizes. Everything else is blocked.
function fetchGate(fetchImpl, ctx, objects) {
  const sizes = new Map(objects.map((o) => [`https://${TARGET.accountId}.r2.cloudflarestorage.com/${TARGET.bucket}/${o.key}`, o.bytes.byteLength]));
  return (url, init) => {
    const post = url === ENDPOINT && init?.method === 'POST' && typeof init.body === 'string' && Buffer.byteLength(init.body) <= MAX_REQUEST_BYTES;
    const d1 = post && (ctx.phase === 'IMPORT' || (ctx.phase === 'PREFLIGHT' && !ctx.preflightSent && init.body === PREFLIGHT_BODY));
    const r2 = ctx.phase === 'IMPORT' && sizes.has(url) && (init?.method === 'GET' || (init?.method === 'PUT' &&
      init.headers?.['if-none-match'] === '*' && init.body instanceof Uint8Array && init.body.byteLength === sizes.get(url)));
    if ((!d1 && !r2) || init?.redirect !== 'error' || ctx.requests >= MAX_REQUESTS) { ctx.blockedRequests++; return Promise.reject(new Error('BLOCKED')); }
    ctx.requests++;
    if (ctx.phase === 'PREFLIGHT') ctx.preflightSent = true;
    else if (d1 || init.method === 'PUT') ctx.writeCapableRequests++; // IMPORT D1 includes runner read-backs
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
async function preflightRead(ctx) {
  const json = await withResponse(ctx, ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${ctx.credential.token}`, 'Content-Type': 'application/json' }, body: PREFLIGHT_BODY }, readJson);
  need(keys(json, ['result', 'errors', 'messages', 'success']) && json.success === true && Array.isArray(json.errors) && json.errors.length === 0 && Array.isArray(json.messages) && json.messages.length === 0 && Array.isArray(json.result) && json.result.length === PREFLIGHT_SQL.length, 'HTTP_ENVELOPE');
  return json.result.map((r) => {
    need(keys(r, ['success', 'results'], ['meta']) && r.success === true && Array.isArray(r.results) && r.results.length <= 1000, 'HTTP_RESULT'); return r.results;
  });
}
// Exact stopped-run receipt at state 0. Nonces are only accepted as syntax-valid lowercase hex.
function receiptOf(rows) {
  need(rows.length === 1 && keys(rows[0], LEDGER.runColumns), 'RECEIPT_MISSING');
  const r = rows[0];
  need(r.id === 1 && typeof r.run_nonce === 'string' && HEX32.test(r.run_nonce) && typeof r.owner_nonce === 'string' && HEX32.test(r.owner_nonce) &&
    r.run_nonce !== r.owner_nonce && r.epoch === 0 && typeof r.target_binding_sha256 === 'string' && SHA.test(r.target_binding_sha256) &&
    r.plan_sha256 === PLAN_SHA256 && r.stage === 0 && r.cursor === 0 && r.ordinal === 0 && r.claim_seq === 0 && r.last_chunk_sha256 === null && r.complete === 0, 'RECEIPT_STATE_MISMATCH');
  return r;
}
function descriptorFor(plan, baseline, nonces, now) {
  return { format: 'sikap-remote-import-descriptor', version: 1, ...TARGET, snapshotId: plan.snapshotId, sourceSha256: plan.sourceSha256,
    planSha256: PLAN_SHA256, appSchemaSha256: UAT_APP_SCHEMA_SHA256, ledgerSchemaSha256: UAT_LEDGER_SCHEMA_SHA256,
    baselineSha256: runner.hashBaseline(baseline), policySha256: UAT_POLICY_SHA256, retentionPolicySha256: UAT_RETENTION_POLICY_SHA256,
    runNonce: nonces.runNonce, ownerNonce: nonces.ownerNonce, epoch: 0, expiresAt: new Date(Date.parse(now) + DESCRIPTOR_TTL_MS).toISOString() };
}
function permitFor(artifacts, baseline, nonces) {
  const now = new Date().toISOString(), descriptor = descriptorFor(artifacts.plan, baseline, nonces, now);
  const v = validateDescriptor(descriptor, now);
  const permit = issueRealDataUatPermit({ descriptor, planBytes: artifacts.planBytes, now });
  need(permit.targetBindingSha256 === v.targetBindingSha256, 'BINDING_MISMATCH');
  compileChunks({ tables: getPermitTables(permit) }, descriptor, { now }); // deterministic limit check, no I/O
  return { permit, targetBindingSha256: v.targetBindingSha256 };
}

async function execute(ctx, options) {
  ctx.phase = 'STATIC_CHECK'; const statements = staticCheck();
  ctx.phase = 'PRIVATE_VALIDATION'; const artifacts = await loadPrivate(options, ctx);
  ctx.phase = 'LOCAL_EXPECTED'; const expected = await expectedDatabase(statements);
  if (options.checkOnly) { permitFor(artifacts, expected.baseline, CHECK_ONLY_NONCES); ctx.phase = 'DONE'; return 'CHECK_ONLY_OK'; }
  ctx.phase = 'CREDENTIAL'; ctx.credential = await options.readCredential();
  const c = ctx.credential;
  need(typeof c?.token === 'string' && c.token.length >= 20 && c.token.length <= 4096 && TOKEN.test(c.token) &&
    typeof c.accessKeyId === 'string' && /^[A-Za-z0-9]{16,128}$/.test(c.accessKeyId) && typeof c.secretAccessKey === 'string' && /^[\x21-\x7e]{16,128}$/.test(c.secretAccessKey), 'CREDENTIAL_INVALID');
  need(typeof c.expiresAt === 'string' && Number.isFinite(Date.parse(c.expiresAt)) && Date.parse(c.expiresAt) - Date.now() >= MIN_CREDENTIAL_TTL_MS, 'CREDENTIAL_EXPIRED');
  ctx.fetch = fetchGate(options.fetchImpl, ctx, artifacts.objects);
  ctx.phase = 'PREFLIGHT';
  const rows = await preflightRead(ctx);
  let i = 0; const next = () => rows[i++];
  const schema = next(); rowArrays(schema, SCHEMA_QUERY.columns);
  need(schemaHash(schema) === expected.schemaSha256, 'REMOTE_SCHEMA_MISMATCH'); ctx.schemaObserved = true;
  for (let r = 0; r < REFS.length; r++) need(JSON.stringify(rowArrays(next(), REFS[r].columns)) === JSON.stringify(expected.refs[r]), 'REFERENCE_CONTENT_MISMATCH');
  ctx.referencesObserved = true;
  for (let q = 0; q < COUNT_QUERIES.length; q++) { const n = next(); need(n.length === 1 && keys(n[0], ['n']) && n[0].n === 0, 'OPERATIONAL_ROWS_PRESENT'); }
  ctx.operationalEmptyObserved = true; ctx.journalEmptyObserved = true;
  const receipt = receiptOf(next()); ctx.receiptObserved = true;
  const baseline = Object.fromEntries(IMPORT_TABLES.map((t) => [t, baselineOf(t, next())]));
  need(JSON.stringify(baseline) === JSON.stringify(expected.baseline), 'BASELINE_MISMATCH');
  need(next().length === 0 && i === rows.length, 'FOREIGN_KEY_VIOLATION'); ctx.baselineObserved = true;
  ctx.phase = 'PERMIT';
  const { permit, targetBindingSha256 } = permitFor(artifacts, expected.baseline, { runNonce: receipt.run_nonce, ownerNonce: receipt.owner_nonce });
  need(targetBindingSha256 === receipt.target_binding_sha256, 'RECEIPT_BINDING_MISMATCH'); ctx.receiptBindingMatched = true;
  ctx.phase = 'IMPORT';
  const report = await runner.runPrivateUatRecovery({ permit, objects: artifacts.objects, baseline, d1Token: c.token,
    r2AccessKeyId: c.accessKeyId, r2SecretAccessKey: c.secretAccessKey, d1FetchImpl: ctx.fetch, r2FetchImpl: ctx.fetch,
    nowProvider: () => new Date().toISOString(), timeoutMs: TIMEOUT_MS });
  ctx.runnerReport = report;
  need(report?.status === 'COMPLETE_UAT_RECONCILED', 'RUNNER_STOPPED'); ctx.phase = 'DONE'; return 'COMPLETE_UAT_RECONCILED';
}
function summary(ctx, status, code) {
  return { targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: ctx.phase, status, code, httpStatus: ctx.httpStatus,
    requests: ctx.requests, blockedRequests: ctx.blockedRequests, writeCapableRequests: ctx.writeCapableRequests,
    filesVerified: ctx.filesVerified, fileBytesVerified: ctx.fileBytesVerified, schemaObserved: ctx.schemaObserved, referencesObserved: ctx.referencesObserved,
    operationalEmptyObserved: ctx.operationalEmptyObserved, journalEmptyObserved: ctx.journalEmptyObserved, receiptObserved: ctx.receiptObserved,
    baselineObserved: ctx.baselineObserved, receiptBindingMatched: ctx.receiptBindingMatched,
    priorPartialStateRetained: true, manualRecoveryRequired: status !== 'COMPLETE_UAT_RECONCILED' && status !== 'CHECK_ONLY_OK',
    ...(ctx.runnerReport ? { runnerReport: ctx.runnerReport } : {}), recoveryRun: true,
    ready: false, readyForImport: false, readyProduction: false, remoteAuthorized: false, transportProven: false, authorizesExecution: false,
    authorizesRetry: false, authorizesResume: false, completeFlagSet: false, appBindingAllowed: false, appOpened: false, deployed: false,
    productionVerified: false, cleanupAttempted: false, resetAttempted: false, setupAttempted: false, bootstrapAttempted: false,
    wholeBucketEmptyProven: false, snapshotConsistent: false, uatOnly: true };
}
// PERMANENTLY RETIRED (unconditional). The exported API and the CLI return this fixed result before
// any options access, static check, file read, credential read or fetch. There is no flag, env or option to
// re-enable it and pins are not refreshed. The historical bodies below are kept only as unreachable evidence.
export const RETIRED_RESULT = Object.freeze({ targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: 'RETIRED',
  status: 'STOPPED_RETIRED', code: 'DRIVER_RETIRED', httpStatus: null, requests: 0, blockedRequests: 0, writeCapableRequests: 0,
  retired: true, recoveryRun: false, ready: false, readyForImport: false, readyProduction: false, remoteAuthorized: false,
  authorizesExecution: false, authorizesRetry: false, authorizesResume: false, uatOnly: true });
export async function executeUatRecovery() { return { ...RETIRED_RESULT }; }
let active = false;
// Historical callable API (unreachable evidence; not exported). All five dependencies were required.
async function historicExecuteUatRecovery(options) {
  const ctx = { phase: 'ARGS', httpStatus: null, requests: 0, blockedRequests: 0, writeCapableRequests: 0, preflightSent: false, filesVerified: 0, fileBytesVerified: 0,
    schemaObserved: false, referencesObserved: false, operationalEmptyObserved: false, journalEmptyObserved: false, receiptObserved: false,
    baselineObserved: false, receiptBindingMatched: false, runnerReport: null, credential: null };
  const required = ['readCredential', 'fetchImpl', 'checkOnly', 'readPlanBytes', 'readFileBytes'];
  if (!keys(options, required) || Reflect.ownKeys(options).some((k) => typeof k !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, k), 'value'))) return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
  const o = { ...options };
  if (typeof o.checkOnly !== 'boolean' || !['readCredential', 'fetchImpl', 'readPlanBytes', 'readFileBytes'].every((k) => typeof o[k] === 'function')) return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
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
  const result = invalid ? { status: 'STOPPED_ARGS', code: 'CLI_ARGUMENTS' } : await historicExecuteUatRecovery({
    checkOnly: argv.length === 1, readCredential: readCredentials, fetchImpl: globalThis.fetch,
    readPlanBytes: () => readBoundedPlan(PLAN_PATH, ARTIFACT_LIMITS.exportBytes),
    readFileBytes: (file) => readVerifiedFile(FILES_ROOT, file),
  });
  process.exitCode = invalid ? 2 : ['CHECK_ONLY_OK', 'COMPLETE_UAT_RECONCILED'].includes(result.status) ? 0 : 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
// Retired CLI: every argv (including --check-only) stops non-zero; no real dependency is invoked.
if (isMain(import.meta.url)) {
  process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(RETIRED_RESULT)}\n`);
}
