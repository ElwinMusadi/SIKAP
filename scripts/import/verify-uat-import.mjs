// Independent READ-ONLY post-import reconciliation for the fixed private UAT target. Importing this
// module performs no I/O. PERMANENTLY RETIRED: executeVerification() and the CLI always return
// STOPPED_RETIRED/DRIVER_RETIRED with zero I/O (see RETIRED_RESULT). The usage below is historical evidence:
//   node scripts/import/verify-uat-import.mjs --check-only  (private plan + local simulation; no auth/HTTP)
//   node scripts/import/verify-uat-import.mjs               (1 static read-only D1 POST + 66 R2 GETs)
// No target/path/env/SQL overrides. No SQL mutation, PUT, DELETE, list, retry, cleanup or app binding.
// Expected state is rebuilt locally: pinned migrations + ledger DDL in in-memory Miniflare, then
// the same compiled chunks (current core) bound to the run/owner/epoch read from the remote ledger.
// Output is counts/labels/closed codes only: never rows, keys, nonces, credentials or provider text.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_LIMITS } from '../migrate/contract.mjs';
import { EMPTY_TABLES, validatePlan } from '../migrate/apply-local.mjs';
import { isMain, readBoundedPlan, splitMigration } from '../migrate/local-store.mjs';
import { LEDGER, compileChunks, validateDescriptor } from './core.mjs';
import { LEDGER_SQL_FILE, validateLedgerSql } from './ledger-contract.mjs';
import { READBACK_QUERIES, SCHEMA_QUERY } from './d1-readback.mjs';
import { R2_REGION, R2_SERVICE, signV4 } from './r2-s3.mjs';
import { UAT_TARGET, UAT_APP_SCHEMA_SHA256, UAT_LEDGER_SCHEMA_SHA256, UAT_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256 } from './real-data-gate.mjs';
import { UAT_EXPECTED_SCHEMA_SHA256, hashBaseline } from './synthetic-runner.mjs';

const TARGET = Object.freeze({ accountId: '04b8b2073be2f1aa21fc6489e0db36f6', databaseId: '885b655b-3482-44fc-9d01-56ad0204bb35',
  databaseName: 'sikap-import-uat-20261018', bucket: 'sikap-import-uat-20261018-files', profile: 'real-data' });
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${TARGET.accountId}/d1/database/${TARGET.databaseId}/query`;
const R2_HOST = `${TARGET.accountId}.r2.cloudflarestorage.com`;
const ROOT = new URL('../../', import.meta.url);
const PLAN_PATH = 'C:/Users/elwin/sikap-private/dry-run-sumber-nyata/plan-uat-20261018/plan.sikap-plan.json';
const SNAPSHOT = '039d8212-44e9-43b5-b48b-aff9d3dff27f';
const PLAN_SHA256 = '3e078341888fc457da4bdceab304c896c677124083e352ecbe885f4ff174a12b';
const OAUTH_PATH = 'C:\\Users\\elwin\\AppData\\Roaming\\xdg.config\\.wrangler\\config\\default.toml';
const TIMEOUT_MS = 30_000, MAX_D1_RESPONSE_BYTES = 8 * 1024 * 1024, MAX_ROWS = ARTIFACT_LIMITS.rows, MIN_CREDENTIAL_TTL_MS = 5 * 60 * 1000;
const EXPECTED = Object.freeze({ pegawai: 46, akun: 46, arsip: 63, files: 66, totalFileBytes: 44_162_297 });
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
const select = (columns, table, order) => `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order.join(', ')}`;
const REFS = [['ref_pangkat_golongan', ['kode', 'nama', 'jenis_asn', 'urutan', 'aktif'], ['kode']], ['ref_unit_organisasi', ['id', 'nama', 'aktif'], ['id']], ['ref_pendidikan', ['kode', 'nama', 'urutan'], ['kode']],
  ['pengaturan', ['key', 'value', 'is_secret', 'updated_by'], ['key']]]; // updated_at is a wall-clock default: excluded
// Fixed read-only query list; the D1 request body is this exact precomputed string.
const QUERIES = Object.freeze([
  { label: 'schema', kind: 'schema', columns: SCHEMA_QUERY.columns, sql: SCHEMA_QUERY.sql },
  ...READBACK_QUERIES.map((q) => ({ label: q.key === 'run' ? 'ledger_run' : q.key === 'journal' ? 'ledger_journal' : q.key, kind: ['run', 'journal'].includes(q.key) ? q.key : 'table', columns: q.columns, sql: q.sql })),
  ...REFS.map(([table, columns, order]) => ({ label: table, kind: 'ref', columns, sql: select(columns, table, order) })),
  ...EMPTY_TABLES.map((table) => ({ label: `count:${table}`, kind: 'count', columns: ['n'], sql: `SELECT count(*) AS n FROM ${table}` })),
  { label: 'foreign_key_check', kind: 'fk', columns: null, sql: 'PRAGMA foreign_key_check' },
]);
const BODY = JSON.stringify({ batch: QUERIES.map((q) => ({ sql: q.sql, params: [] })) });
const BOOTSTRAP_SQL = `INSERT INTO ${LEDGER.runTable} (${LEDGER.runColumns.join(', ')}) VALUES (${LEDGER.runColumns.map((_, i) => `json_extract(?1, '$[${i}]')`).join(', ')})`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const EMPTY_SHA = sha256(new Uint8Array(0));
const TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/, HEX32 = /^[0-9a-f]{32}$/, SHA = /^[0-9a-f]{64}$/;
const KEY = new RegExp(`^migration/${SNAPSHOT}/(document|photo)/[A-Za-z0-9_-]{1,200}-[0-9a-f]{64}\\.(pdf|jpg|png|webp)$`);
const obj = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v, required, optional = []) => obj(v) && Object.keys(v).every((k) => required.includes(k) || optional.includes(k)) && required.every((k) => Object.hasOwn(v, k));
class Stop { constructor(code) { this.code = code; } }
const need = (ok, code) => { if (!ok) throw new Stop(code); };
const quiet = (fn) => { try { const p = fn(); p?.catch?.(() => {}); } catch { /* discard only */ } };
const schemaHash = (rows) => sha256(JSON.stringify([...rows].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((r) => [r.type, r.name, r.tbl_name, r.sql])));
// Sorted canonical JSON row arrays in fixed column order; exact key set per row.
const canon = (rows, columns) => rows.map((r) => { need(keys(r, columns), 'ROW_SHAPE'); return JSON.stringify(columns.map((c) => r[c])); }).sort();
const hasDup = (sorted) => sorted.some((v, i) => i > 0 && v === sorted[i - 1]);

function staticCheck() {
  need(JSON.stringify(TARGET) === JSON.stringify(UAT_TARGET), 'TARGET_PIN_MISMATCH');
  need(UAT_EXPECTED_SCHEMA_SHA256 === '0b3e09660faa6e2e3f585fa6e4817dbf9dbdc944276f065b3bb44452cf375802', 'SCHEMA_PIN_MISMATCH');
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
  need(statements.length === 67, 'SETUP_COUNT_MISMATCH');
  return statements;
}

async function loadPlan(options) {
  const planBytes = await options.readPlanBytes();
  need(planBytes instanceof Uint8Array && planBytes.byteLength > 0 && planBytes.byteLength <= ARTIFACT_LIMITS.exportBytes && sha256(planBytes) === PLAN_SHA256, 'PLAN_HASH_MISMATCH');
  let plan;
  try { plan = validatePlan(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes))); } catch { throw new Stop('PLAN_INVALID'); }
  need(plan.snapshotId === SNAPSHOT && plan.ready === true && Object.keys(EXPECTED).every((k) => plan.expected[k] === EXPECTED[k]), 'PLAN_SCOPE_MISMATCH');
  need(plan.files.length === EXPECTED.files && plan.files.every((f) => KEY.test(f.r2Key) && f.sizeBytes <= ARTIFACT_LIMITS.fileBytes) &&
    new Set(plan.files.map((f) => f.r2Key)).size === EXPECTED.files && plan.files.reduce((s, f) => s + f.sizeBytes, 0) === EXPECTED.totalFileBytes, 'PLAN_FILES_MISMATCH');
  return plan;
}

// In-memory only (d1Persist false, outbound blocked): DDL + seeds, bootstrap row, every compiled
// chunk exactly as the runner sends it, then the same read queries. No permit/adapter involved.
// `ledger.ordinal` (null = all) applies only the committed chunk prefix the remote receipt claims.
async function simulate(statements, plan, ledger) {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };', outboundService: () => new Response(null, { status: 403 }),
    log: new Log(LogLevel.NONE), cf: false, telemetry: { enabled: false }, d1Persist: false, d1Databases: { DB: 'sikap-import-verify-memory' } }));
  try {
    const db = await mf.getD1Database('DB');
    for (const sql of statements) await db.prepare(sql).run();
    need(schemaHash((await db.prepare(SCHEMA_QUERY.sql).all()).results) === UAT_EXPECTED_SCHEMA_SHA256, 'LOCAL_SCHEMA_MISMATCH');
    const baseline = {};
    for (const q of QUERIES.filter((x) => x.kind === 'table')) baseline[q.label] = (await db.prepare(q.sql).all()).results.map((r) => Object.fromEntries(q.columns.map((c) => [c, r[c]])));
    const now = new Date().toISOString();
    // Compile-only descriptor: expiry is local, never an authority; the binding is checked below.
    const descriptor = { format: 'sikap-remote-import-descriptor', version: 1, ...TARGET, snapshotId: plan.snapshotId, sourceSha256: plan.sourceSha256,
      planSha256: PLAN_SHA256, appSchemaSha256: UAT_APP_SCHEMA_SHA256, ledgerSchemaSha256: UAT_LEDGER_SCHEMA_SHA256, baselineSha256: hashBaseline(baseline),
      policySha256: UAT_POLICY_SHA256, retentionPolicySha256: UAT_RETENTION_POLICY_SHA256, runNonce: ledger.runNonce, ownerNonce: ledger.ownerNonce,
      epoch: ledger.epoch, expiresAt: new Date(Date.parse(now) + 60 * 60 * 1000).toISOString() };
    let binding, artifact;
    try { binding = validateDescriptor(descriptor, now).targetBindingSha256; artifact = compileChunks({ tables: plan.tables }, descriptor, { now }); } catch { throw new Stop('LOCAL_COMPILE_FAILED'); }
    const applied = ledger.ordinal ?? artifact.chunkCount;
    need(Number.isSafeInteger(applied) && applied >= 0 && applied <= artifact.chunkCount, 'LEDGER_ORDINAL_INVALID');
    const state0 = [1, ledger.runNonce, ledger.ownerNonce, ledger.epoch, binding, PLAN_SHA256, 0, 0, 0, 0, null, 0];
    try {
      await db.prepare(BOOTSTRAP_SQL).bind(JSON.stringify(state0)).run();
      for (const chunk of artifact.chunks.slice(0, applied)) await db.batch(chunk.batch.map((s) => db.prepare(s.sql).bind(...s.params)));
    } catch { throw new Stop('LOCAL_APPLY_FAILED'); }
    const results = [];
    for (const q of QUERIES) results.push((await db.prepare(q.sql).all()).results);
    need(results[QUERIES.length - 1].length === 0, 'LOCAL_FOREIGN_KEY_VIOLATION');
    return { binding, chunkCount: artifact.chunkCount, applied, results };
  } finally { await mf.dispose(); }
}

// Only these four names are extracted. No eval, interpolation, shell, process.env or echo.
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
    const m = /^(?:"([^"\\\r\n]*)"|'([^'\r\n]*)'|([^\s#'"\\]+))[ \t]*(?:#.*)?$/.exec(found[0].slice(found[0].indexOf('=') + 1).trim());
    need(m !== null, 'CREDENTIAL_FORMAT'); return m[1] ?? m[2] ?? m[3];
  };
  return { token: pickOAuth('oauth_token'), expiresAt: pickOAuth('expiration_time'), accessKeyId: pickDotenv('R2_ACCESS_KEY_ID'), secretAccessKey: pickDotenv('R2_SECRET_ACCESS_KEY') };
}

// Exactly one D1 POST with the fixed body and one GET per manifest URL; everything else is blocked.
function fetchGate(fetchImpl, ctx, urls) {
  const used = new Set();
  return (url, init) => {
    const d1 = url === ENDPOINT && init?.method === 'POST' && init.body === BODY;
    const r2 = urls.has(url) && init?.method === 'GET' && init.body === undefined;
    if ((!d1 && !r2) || used.has(url) || init.redirect !== 'error') { ctx.blockedRequests++; return Promise.reject(new Error('BLOCKED')); }
    used.add(url); ctx.requests++;
    return fetchImpl(url, init);
  };
}
async function withResponse(ctx, url, init, consume) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Stop('TIMEOUT')), { once: true }));
  aborted.catch(() => {});
  let response, pending;
  try {
    pending = ctx.fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal });
    try { response = await Promise.race([pending, aborted]); } catch (error) { throw error instanceof Stop ? error : new Stop('FETCH_FAILED'); }
    need(response && response.redirected !== true && (!response.url || response.url === url), 'UNTRUSTED_RESPONSE');
    return await Promise.race([consume(response, controller.signal), aborted]);
  } finally {
    clearTimeout(timer); controller.abort(); quiet(() => response?.body?.cancel());
    pending?.then((late) => { if (late !== response) quiet(() => late?.body?.cancel()); }, () => {});
  }
}
const OVERSIZE = Symbol('oversize');
async function readCapped(body, limit, signal) {
  need(body && typeof body.getReader === 'function', 'BODY_INVALID');
  const reader = body.getReader(), chunks = []; let size = 0;
  const cancel = () => quiet(() => reader.cancel()); signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      need(!signal.aborted, 'TIMEOUT'); if (done) break;
      need(value instanceof Uint8Array, 'BODY_INVALID'); size += value.byteLength;
      if (size > limit) return OVERSIZE;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', cancel); cancel(); quiet(() => reader.releaseLock()); }
}
async function readD1(ctx) {
  const json = await withResponse(ctx, ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${ctx.credential.token}`, 'Content-Type': 'application/json' }, body: BODY }, async (res, signal) => {
    need(res.status >= 200 && res.status <= 299, res.status === 401 || res.status === 403 ? 'HTTP_AUTH' : 'HTTP_STATUS');
    need(/^application\/json\s*(;.*)?$/i.test(res.headers?.get?.('content-type') ?? ''), 'HTTP_CONTENT_TYPE');
    const bytes = await readCapped(res.body, MAX_D1_RESPONSE_BYTES, signal);
    need(bytes !== OVERSIZE, 'HTTP_BODY_OVERSIZE');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Stop('HTTP_JSON'); }
  });
  need(keys(json, ['result', 'errors', 'messages', 'success']) && json.success === true && Array.isArray(json.errors) && json.errors.length === 0 &&
    Array.isArray(json.messages) && json.messages.length === 0 && Array.isArray(json.result) && json.result.length === QUERIES.length, 'HTTP_ENVELOPE');
  return json.result.map((r) => { need(keys(r, ['success', 'results'], ['meta']) && r.success === true && Array.isArray(r.results) && r.results.length <= MAX_ROWS, 'HTTP_RESULT'); return r.results; });
}
function ledgerOf(rows) {
  need(rows.length === 1 && keys(rows[0], LEDGER.runColumns), 'LEDGER_RUN_MISSING');
  const r = rows[0];
  need(r.id === 1 && r.complete === 0 && r.plan_sha256 === PLAN_SHA256 && typeof r.run_nonce === 'string' && HEX32.test(r.run_nonce) &&
    typeof r.owner_nonce === 'string' && HEX32.test(r.owner_nonce) && Number.isSafeInteger(r.epoch) && r.epoch >= 0 && typeof r.target_binding_sha256 === 'string' && SHA.test(r.target_binding_sha256), 'LEDGER_RUN_INVALID');
  need(Number.isSafeInteger(r.ordinal) && r.ordinal >= 0, 'LEDGER_RUN_INVALID');
  return { runNonce: r.run_nonce, ownerNonce: r.owner_nonce, epoch: r.epoch, ordinal: r.ordinal, binding: r.target_binding_sha256 };
}
async function getFile(ctx, file) {
  const canonicalUri = `/${TARGET.bucket}/${file.r2Key}`, url = `https://${R2_HOST}${canonicalUri}`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const headers = { 'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': amzDate };
  const { authorization } = signV4({ method: 'GET', canonicalUri, headers: { ...headers, host: R2_HOST }, payloadSha256: EMPTY_SHA, amzDate, region: R2_REGION, service: R2_SERVICE,
    accessKeyId: ctx.credential.accessKeyId, secretAccessKey: ctx.credential.secretAccessKey });
  try {
    return await withResponse(ctx, url, { method: 'GET', headers: { ...headers, authorization } }, async (res, signal) => {
      if (res.status === 401 || res.status === 403) throw new Stop('R2_AUTH');
      if (res.status !== 200) return res.status === 404 ? 'OBJECT_MISSING' : 'GET_STATUS';
      const mime = res.headers?.get?.('content-type');
      if (typeof mime !== 'string' || mime.split(';')[0].trim().toLowerCase() !== file.mimeType) return 'MIME_MISMATCH';
      const bytes = await readCapped(res.body, file.sizeBytes, signal);
      if (bytes === OVERSIZE || bytes.byteLength !== file.sizeBytes) return 'SIZE_MISMATCH';
      return sha256(bytes) === file.sha256 ? null : 'SHA_MISMATCH';
    });
  } catch (error) {
    if (error instanceof Stop && error.code === 'R2_AUTH') throw error;
    return error instanceof Stop && ['TIMEOUT', 'FETCH_FAILED', 'UNTRUSTED_RESPONSE', 'BODY_INVALID'].includes(error.code) ? `GET_${error.code}` : 'GET_FAILED';
  }
}

function compare(ctx, remote, local) {
  need(remote[0].length <= 1000, 'SCHEMA_ROWS');
  canon(remote[0], SCHEMA_QUERY.columns);
  ctx.schemaVerified = schemaHash(remote[0]) === UAT_EXPECTED_SCHEMA_SHA256;
  if (!ctx.schemaVerified) ctx.queryMismatches.push('schema');
  ctx.foreignKeyViolations = remote[QUERIES.length - 1].length;
  if (ctx.foreignKeyViolations !== 0) ctx.queryMismatches.push('foreign_key_check');
  QUERIES.forEach((q, i) => {
    if (q.kind === 'schema' || q.kind === 'fk') return;
    const a = canon(remote[i], q.columns), b = canon(local[i], q.columns);
    if (q.kind === 'table' || q.kind === 'run' || q.kind === 'journal') ctx.rows[q.label] = { observed: a.length, expected: b.length };
    if (q.kind === 'count') ctx.operationalCounts[q.label.slice(6)] = { observed: remote[i][0]?.n ?? null, expected: local[i][0]?.n ?? null };
    if (hasDup(a) || a.length !== b.length || a.some((v, k) => v !== b[k])) ctx.queryMismatches.push(q.label);
  });
}

async function execute(ctx, options) {
  ctx.phase = 'STATIC_CHECK'; const statements = staticCheck();
  ctx.phase = 'PLAN'; const plan = await loadPlan(options);
  if (options.checkOnly) {
    ctx.phase = 'LOCAL';
    const nonce = () => randomUUID().replace(/-/g, '');
    ctx.chunkCount = (await simulate(statements, plan, { runNonce: nonce(), ownerNonce: nonce(), epoch: 0 })).chunkCount;
    ctx.phase = 'DONE'; return 'CHECK_ONLY_OK';
  }
  ctx.phase = 'CREDENTIAL'; ctx.credential = await options.readCredential();
  const c = ctx.credential;
  need(typeof c?.token === 'string' && c.token.length >= 20 && c.token.length <= 4096 && TOKEN.test(c.token) &&
    typeof c.accessKeyId === 'string' && /^[A-Za-z0-9]{16,128}$/.test(c.accessKeyId) && typeof c.secretAccessKey === 'string' && /^[\x21-\x7e]{16,128}$/.test(c.secretAccessKey), 'CREDENTIAL_INVALID');
  need(typeof c.expiresAt === 'string' && Number.isFinite(Date.parse(c.expiresAt)) && Date.parse(c.expiresAt) - Date.now() >= MIN_CREDENTIAL_TTL_MS, 'CREDENTIAL_EXPIRED');
  ctx.fetch = fetchGate(options.fetchImpl, ctx, new Set(plan.files.map((f) => `https://${R2_HOST}/${TARGET.bucket}/${f.r2Key}`)));
  // D1 failures are recorded (closed code) and do not skip the independent R2 inventory below.
  try {
    ctx.phase = 'D1_READ'; const remote = await readD1(ctx);
    ctx.phase = 'LEDGER'; const ledger = ledgerOf(remote[1]); ctx.ledgerOrdinal = ledger.ordinal;
    ctx.phase = 'LOCAL'; const local = await simulate(statements, plan, ledger);
    need(local.binding === ledger.binding, 'TARGET_BINDING_MISMATCH'); ctx.chunkCount = local.chunkCount;
    ctx.phase = 'COMPARE'; compare(ctx, remote, local.results); ctx.d1Compared = true;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    ctx.d1Code = `${ctx.phase}:${error.code}`;
  }
  ctx.phase = 'R2_READ';
  for (const file of plan.files) {
    const problem = await getFile(ctx, file);
    if (problem === null) ctx.files.verified++; else { ctx.files.mismatched++; ctx.files.codes[problem] = (ctx.files.codes[problem] ?? 0) + 1; }
  }
  ctx.phase = 'DONE';
  const d1Exact = ctx.d1Compared && ctx.queryMismatches.length === 0 && ctx.schemaVerified;
  ctx.allChunksCommitted = d1Exact && ctx.ledgerOrdinal === ctx.chunkCount;
  if (ctx.allChunksCommitted && ctx.files.verified === EXPECTED.files) return 'UAT_IMPORT_VERIFIED';
  // INCOMPLETE = D1 exactly equals the committed prefix its own ledger claims, but not the full plan.
  return d1Exact && !ctx.allChunksCommitted ? 'UAT_IMPORT_INCOMPLETE' : 'UAT_IMPORT_MISMATCH';
}
function summary(ctx, status, code) {
  return { targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: ctx.phase, status, code, d1Code: ctx.d1Code, d1Compared: ctx.d1Compared,
    chunkCount: ctx.chunkCount, ledgerOrdinal: ctx.ledgerOrdinal, allChunksCommitted: ctx.allChunksCommitted, rows: ctx.rows, operationalCounts: ctx.operationalCounts, schemaVerified: ctx.schemaVerified, foreignKeyViolations: ctx.foreignKeyViolations,
    queryMismatches: [...ctx.queryMismatches], files: { expected: EXPECTED.files, ...ctx.files, codes: { ...ctx.files.codes } },
    requests: ctx.requests, blockedRequests: ctx.blockedRequests, writeAttempts: 0,
    readOnly: true, wholeBucketVerified: false, readyForProduction: false, remoteAuthorized: false, authorizesExecution: false,
    authorizesRetry: false, completeFlagSet: false, appBindingAllowed: false, cleanupAttempted: false, uatOnly: true };
}
// PERMANENTLY RETIRED (unconditional). The exported API and the CLI return this fixed result before
// any options access, plan read, local simulation, credential read or fetch (D1/R2). There is no flag, env or
// option to re-enable it and pins are not refreshed. The historical bodies below are unreachable evidence only.
export const RETIRED_RESULT = Object.freeze({ targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: 'RETIRED',
  status: 'STOPPED_RETIRED', code: 'DRIVER_RETIRED', requests: 0, blockedRequests: 0, writeAttempts: 0, d1Compared: false,
  retired: true, readOnly: true, wholeBucketVerified: false, readyForProduction: false, remoteAuthorized: false, authorizesExecution: false,
  authorizesRetry: false, completeFlagSet: false, appBindingAllowed: false, cleanupAttempted: false, uatOnly: true });
export async function executeVerification() { return { ...RETIRED_RESULT }; }
let active = false;
// Historical callable API (unreachable evidence; not exported). Required every dependency explicitly.
async function historicExecuteVerification(options) {
  const ctx = { phase: 'ARGS', d1Code: null, d1Compared: false, chunkCount: null, ledgerOrdinal: null, allChunksCommitted: false, rows: {}, operationalCounts: {}, schemaVerified: false, foreignKeyViolations: null, queryMismatches: [],
    files: { verified: 0, mismatched: 0, codes: {} }, requests: 0, blockedRequests: 0, credential: null, fetch: null };
  const allowed = ['checkOnly', 'readPlanBytes', 'readCredential', 'fetchImpl'];
  if (!keys(options, allowed) || Reflect.ownKeys(options).some((k) => typeof k !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, k), 'value'))) return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
  const o = { ...options };
  if (typeof o.checkOnly !== 'boolean' || !['readPlanBytes', 'readCredential', 'fetchImpl'].every((k) => typeof o[k] === 'function')) return summary(ctx, 'STOPPED_ARGS', 'OPTIONS_INVALID');
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
  const result = invalid ? { status: 'STOPPED_ARGS', code: 'CLI_ARGUMENTS' } : await historicExecuteVerification({ checkOnly: argv.length === 1,
    readPlanBytes: () => readBoundedPlan(PLAN_PATH, ARTIFACT_LIMITS.exportBytes), readCredential: readCredentials, fetchImpl: globalThis.fetch });
  process.exitCode = invalid ? 2 : ['CHECK_ONLY_OK', 'UAT_IMPORT_VERIFIED'].includes(result.status) ? 0 : 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
// Retired CLI: every argv (including --check-only) stops non-zero; no real dependency is invoked.
if (isMain(import.meta.url)) {
  process.exitCode = 1;
  process.stdout.write(`${JSON.stringify(RETIRED_RESULT)}\n`);
}
