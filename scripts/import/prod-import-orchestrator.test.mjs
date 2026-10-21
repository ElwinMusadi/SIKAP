// Unit tests for scripts/import/prod-import-orchestrator.mjs. Synthetic data, injected fakes and temp dirs only:
// no private plan, credential, OAuth file, network, Wrangler or remote call. Full happy-path/fault HTTP flows
// live in prod-import-rehearsal.integration.test.mjs (separate owner); this file covers arguments, kind
// isolation, PENDING production stops, binding inventory, budget/window preflight and redaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import {
  orchestrateImport, scanBindingInventory, requestBudget, requiredWindowMs, TIMEOUT_MS, MAX_REQUESTS, SETUP_STATEMENTS,
  LOCAL_MARGIN_MS, CREDENTIAL_MARGIN_MS, MAX_CREDENTIAL_LIFETIME_MS, INVENTORY_MAX_DEPTH, KINDS, ORCHESTRATOR_MODES,
} from './prod-import-orchestrator.mjs';
import { MAX_DESCRIPTOR_TTL_MS } from './core.mjs';
import { PROD_TARGET, REHEARSAL_TARGET, UAT_TARGET } from './real-data-gate.mjs';
import * as PINS from './prod-import-pins.mjs';

const h = (bytes) => createHash('sha256').update(bytes).digest('hex');
const lf = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const GOOD_PINS = () => PINS.MODULE_FILES.map((f) => [f, h(lf(f))]);
const BASE = '2026-10-20T00:00:00.000Z';
const TOKEN = `SYNTHETIC-TEST-TOKEN-${'a'.repeat(24)}`, SECRET = 'SyntheticSecretValue0123456789';

function counters() { return { cred: 0, fetch: 0, plan: 0, file: 0 }; }
function io(c, over = {}) {
  let t = Date.parse(BASE);
  return {
    readPlanBytes: async () => { c.plan++; assert.fail('plan must not be read'); },
    readFileBytes: async () => { c.file++; assert.fail('file must not be read'); },
    readCredential: async () => { c.cred++; assert.fail('credential must not be read'); },
    fetchImpl: async () => { c.fetch++; assert.fail('network must not be used'); },
    now: () => new Date(t += 1000).toISOString(),
    ...over,
  };
}
const zero = { cred: 0, fetch: 0, plan: 0, file: 0 };

function syntheticPlan({ logRows = 0, withFile = false } = {}) {
  const plan = {
    format: 'sikap-migration-plan', version: 1, snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
    sourceSha256: h('synthetic source'), createdAt: BASE, sourceReadOnlyDeclared: true, consistent: false, ready: true,
    tables: Object.fromEntries(IMPORT_TABLES.map((t) => [t, []])), files: [],
    expected: { pegawai: 0, akun: 0, arsip: 0, files: 0, totalFileBytes: 0, arsipPerStatus: { Menunggu: 0, Terverifikasi: 0, Ditolak: 0 } },
    diagnostics: [{ severity: 'warning', sheet: 'Synthetic', rowNumber: 1, code: 'NON_ATOMIC_SNAPSHOT' }],
  };
  for (let i = 1; i <= logRows; i++) plan.tables.log_aktivitas.push({ id: i, ts: BASE, action: 'SYN_EVENT', result: 'SUCCESS' });
  let fileBytes = null;
  if (withFile) {
    fileBytes = Buffer.from('%PDF-synthetic');
    const sha = h(fileBytes);
    const file = { fileId: 'synthetic_file', kind: 'document', r2Key: `migration/${plan.snapshotId}/document/synthetic_file-${sha}.pdf`, mimeType: 'application/pdf', sizeBytes: fileBytes.length, sha256: sha };
    plan.files = [file];
    plan.tables.jenis_dokumen = [{ id: 'DOC-KTP', nama: 'Synthetic document', kategori: 'Synthetic' }];
    plan.tables.pegawai = [{ id: 1, nip: '990000000000000001', nama: 'Synthetic employee' }];
    plan.tables.akun = [{ pegawai_id: 1, password_hash: `legacy-wrap$10000$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`, is_default_password: 0 }];
    plan.tables.arsip_dokumen = [{ id: 1, pegawai_id: 1, jenis_dokumen_id: 'DOC-KTP', status: 'Menunggu', r2_key: file.r2Key, file_name: 'synthetic.pdf', mime_type: file.mimeType, size_bytes: fileBytes.length, sha256: sha, uploaded_at: BASE }];
    Object.assign(plan.expected, { pegawai: 1, akun: 1, arsip: 1, files: 1, totalFileBytes: fileBytes.length, arsipPerStatus: { Menunggu: 1, Terverifikasi: 0, Ditolak: 0 } });
  }
  const bytes = Buffer.from(JSON.stringify(plan));
  const facts = { snapshotId: plan.snapshotId, planSha256: h(bytes), expected: plan.expected, warningCounts: { NON_ATOMIC_SNAPSHOT: 1 }, diagnosticsTotal: 1 };
  return { plan, bytes, facts, fileBytes };
}
const rehearsal = (facts, modulePins = GOOD_PINS()) => ({ planFacts: facts, modulePins });
const credential = (expiresAt, r2ExpiresAt = expiresAt) => ({ token: TOKEN, expiresAt, accessKeyId: 'SYNTHETICKEYID0001', secretAccessKey: SECRET, r2ExpiresAt });

test('exported constants match the documented budget/window contract', () => {
  assert.deepEqual([...KINDS], ['production', 'synthetic-rehearsal']);
  assert.deepEqual([...ORCHESTRATOR_MODES], ['import', 'check-only', 'describe-plan', 'print-pins']);
  assert.equal(SETUP_STATEMENTS, 67); assert.equal(MAX_REQUESTS, 1000); assert.equal(TIMEOUT_MS, 15_000);
  assert.equal(MAX_CREDENTIAL_LIFETIME_MS, 12 * 60 * 60 * 1000);
  // Historical real-plan shape (66 files, 157 chunks): B = 807, which MUST now fit under the 4 h cap with margin,
  // while the cap itself, the request cap and the margins stay unchanged.
  const historical = requestBudget(66, 157);
  assert.equal(historical, 807);
  assert.ok(requiredWindowMs(historical) <= MAX_DESCRIPTOR_TTL_MS - CREDENTIAL_MARGIN_MS, String(requiredWindowMs(historical)));
  assert.ok(requiredWindowMs(920) <= MAX_DESCRIPTOR_TTL_MS - CREDENTIAL_MARGIN_MS && requiredWindowMs(921) > MAX_DESCRIPTOR_TTL_MS - CREDENTIAL_MARGIN_MS);
  assert.equal(CREDENTIAL_MARGIN_MS, 5 * 60 * 1000); assert.equal(LOCAL_MARGIN_MS, 5 * 60 * 1000);
  assert.equal(requestBudget(0, 7), 67 + 5 + 21);
  assert.equal(requestBudget(3, 10), 72 + 12 + 30);
  for (const [f, c] of [[-1, 7], [0, 0], [1.5, 7], [0, '7']]) assert.throws(() => requestBudget(f, c), (e) => e.code === 'BUDGET_INPUT_INVALID');
  assert.equal(requiredWindowMs(100), 100 * TIMEOUT_MS + LOCAL_MARGIN_MS);
  assert.equal(MAX_DESCRIPTOR_TTL_MS, 4 * 60 * 60 * 1000);
});

test('request shape is validated before any I/O: kinds, modes, io, rehearsal block', async () => {
  const c = counters();
  const f = syntheticPlan();
  const okReh = rehearsal(f.facts);
  const getterIo = io(c); Object.defineProperty(getterIo, 'now', { get: () => () => BASE, enumerable: true });
  const getterReq = { kind: 'production', mode: 'check-only', io: io(c) }; Object.defineProperty(getterReq, 'mode', { get: () => 'check-only', enumerable: true });
  const bad = [
    undefined, null, [], 'production', {},
    { kind: 'prod', mode: 'check-only', io: io(c) },
    { kind: 'production', mode: 'force', io: io(c) },
    { kind: 'production', mode: 'check-only', io: io(c), rehearsal: okReh },
    { kind: 'production', mode: 'check-only', io: io(c), target: REHEARSAL_TARGET },
    { kind: 'synthetic-rehearsal', mode: 'check-only', io: io(c) },
    { kind: 'synthetic-rehearsal', mode: 'check-only', io: io(c), rehearsal: { ...okReh, target: PROD_TARGET } },
    { kind: 'synthetic-rehearsal', mode: 'check-only', io: io(c), rehearsal: { planFacts: { ...f.facts, target: PROD_TARGET }, modulePins: GOOD_PINS() } },
    { kind: 'synthetic-rehearsal', mode: 'check-only', io: io(c), rehearsal: { planFacts: f.facts, modulePins: [['x', 'nothex']] } },
    { kind: 'synthetic-rehearsal', mode: 'check-only', io: io(c), rehearsal: { planFacts: f.facts, modulePins: 'pins' } },
    { kind: 'production', mode: 'check-only', io: { ...io(c), extra: () => {} } },
    { kind: 'production', mode: 'check-only', io: (() => { const x = io(c); delete x.now; return x; })() },
    { kind: 'production', mode: 'check-only', io: { ...io(c), fetchImpl: 'fetch' } },
    { kind: 'production', mode: 'check-only', io: getterIo },
    getterReq,
    { kind: 'production', mode: 'check-only', io: io(c), [Symbol('x')]: 1 },
    new Proxy({ kind: 'production', mode: 'check-only', io: io(c) }, { getOwnPropertyDescriptor() { throw new Error('trap'); } }),
  ];
  for (const req of bad) {
    const r = await orchestrateImport(req);
    assert.equal(r.status, 'STOPPED_ARGS'); assert.equal(r.code, 'OPTIONS_INVALID');
    assert.equal(r.requests, 0); assert.equal(r.writeAttempts, 0);
    assert.ok(Object.isFrozen(r));
  }
  assert.deepEqual(c, zero);
});

test('production kind with the reviewed pins passes the static check, then stops at the private plan with zero credential/HTTP', async () => {
  for (const mode of ['import', 'check-only', 'describe-plan']) {
    const c = counters();
    const r = await orchestrateImport({ kind: 'production', mode, io: io(c) });
    assert.equal(r.status, 'STOPPED_PRIVATE_VALIDATION'); assert.notEqual(r.code, 'RUNTIME_PIN_PENDING'); assert.notEqual(r.code, 'PLAN_PIN_PENDING');
    assert.equal(r.kind, 'production'); assert.equal(r.targetId, PROD_TARGET.databaseId); assert.equal(r.targetName, PROD_TARGET.databaseName);
    assert.equal(r.productionImport, true); assert.equal(r.syntheticRehearsal, false);
    assert.equal(c.cred, 0); assert.equal(c.fetch, 0); assert.equal(r.requests, 0); assert.equal(r.writeAttempts, 0);
  }
});

test('synthetic rehearsal: module pin set/value/PENDING and plan-fact PENDING all stop before the plan is read', async () => {
  const f = syntheticPlan();
  const cases = [
    [GOOD_PINS().slice(1), f.facts, 'MODULE_PIN_SET_MISMATCH'],
    [GOOD_PINS().map(([p], i) => [p, i === 0 ? h('tampered') : h(lf(p))]), f.facts, 'MODULE_PIN_MISMATCH'],
    [GOOD_PINS().map(([p]) => [p, PINS.PENDING]), f.facts, 'RUNTIME_PIN_PENDING'],
    [GOOD_PINS(), { ...f.facts, planSha256: PINS.PENDING }, 'PLAN_PIN_PENDING'],
    [GOOD_PINS(), { ...f.facts, expected: null }, 'PLAN_PIN_PENDING'],
    [GOOD_PINS(), { ...f.facts, warningCounts: { PENDING_REVIEW: 1 } }, 'WARNING_REVIEW_PENDING'],
  ];
  for (const [modulePins, facts, code] of cases) {
    const c = counters();
    const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'check-only', io: io(c), rehearsal: { planFacts: facts, modulePins } });
    assert.equal(r.code, code); assert.match(r.status, /^STOPPED_/);
    assert.equal(r.targetId, REHEARSAL_TARGET.databaseId); assert.equal(r.productionImport, false); assert.equal(r.syntheticRehearsal, true);
    assert.deepEqual(c, zero);
  }
});

test('synthetic rehearsal describe-plan returns counts only; plan hash/count/warning mismatches stop before credential', async () => {
  const f = syntheticPlan({ withFile: true });
  const c = counters();
  const reader = { readPlanBytes: async () => { c.plan++; return f.bytes; }, readFileBytes: async () => { c.file++; return f.fileBytes; } };
  const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'describe-plan', io: io(c, reader), rehearsal: rehearsal(f.facts) });
  assert.equal(r.status, 'PLAN_DESCRIBED');
  assert.equal(r.planFacts.planSha256, f.facts.planSha256); assert.equal(r.planFacts.documents, 1); assert.equal(r.filesVerified, 1);
  assert.deepEqual({ ...c }, { cred: 0, fetch: 0, plan: 1, file: 1 });
  const json = JSON.stringify(r);
  for (const leak of ['"nip"', 'Synthetic employee', 'legacy-wrap', 'rowNumber', '990000000000000001']) assert.ok(!json.includes(leak), leak);
  for (const [facts, code] of [
    [{ ...f.facts, planSha256: h('other') }, 'PLAN_HASH_MISMATCH'],
    [{ ...f.facts, snapshotId: '8a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' }, 'PLAN_SCOPE_MISMATCH'],
    [{ ...f.facts, expected: { ...f.facts.expected, pegawai: 2 } }, 'PLAN_COUNTS_MISMATCH'],
    [{ ...f.facts, warningCounts: { NON_ATOMIC_SNAPSHOT: 2 } }, 'PLAN_WARNING_MISMATCH'],
  ]) {
    const c2 = counters();
    const r2 = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'check-only', io: io(c2, { readPlanBytes: async () => f.bytes, readFileBytes: async () => f.fileBytes }), rehearsal: rehearsal(facts) });
    assert.equal(r2.status, 'STOPPED_PRIVATE_VALIDATION'); assert.equal(r2.code, code);
    assert.equal(c2.cred, 0); assert.equal(c2.fetch, 0);
  }
  const bad = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'describe-plan', io: io(counters(), { readPlanBytes: async () => f.bytes, readFileBytes: async () => Buffer.from('%PDF-synthetiX') }), rehearsal: rehearsal(f.facts) });
  assert.equal(bad.code, 'FILE_INTEGRITY');
});

test('synthetic rehearsal check-only computes exact budget/window and issues only a rehearsal permit (no credential/HTTP)', async () => {
  const f = syntheticPlan({ withFile: true });
  const c = counters();
  const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'check-only',
    io: io(c, { readPlanBytes: async () => f.bytes, readFileBytes: async () => f.fileBytes }), rehearsal: rehearsal(f.facts) });
  assert.equal(r.status, 'CHECK_ONLY_OK', JSON.stringify(r));
  assert.ok(Number.isSafeInteger(r.chunks) && r.chunks >= 7);
  assert.equal(r.requestBudget, SETUP_STATEMENTS + 5 + 4 * 1 + 3 * r.chunks);
  assert.equal(r.requiredWindowMs, r.requestBudget * TIMEOUT_MS + LOCAL_MARGIN_MS);
  assert.equal(r.requests, 0); assert.equal(r.writeAttempts, 0); assert.equal(c.cred, 0); assert.equal(c.fetch, 0);
  assert.equal(r.targetId, REHEARSAL_TARGET.databaseId); assert.equal(r.productionImport, false); assert.equal(r.syntheticRehearsal, true);
  assert.notEqual(r.status, 'COMPLETE_PROD_RECONCILED');
});

test('budget > 1000 stops REQUEST_BUDGET_EXCEEDED and budget window > cap stops RUN_WINDOW_EXCEEDS_CAP, before credential', async () => {
  const run = async (logRows) => {
    const f = syntheticPlan({ logRows });
    const c = counters();
    const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'import', io: io(c, { readPlanBytes: async () => f.bytes }), rehearsal: rehearsal(f.facts) });
    assert.equal(c.cred, 0); assert.equal(c.fetch, 0); assert.equal(r.requests, 0);
    assert.equal(r.status, 'STOPPED_BUDGET');
    assert.equal(r.requestBudget, requestBudget(0, r.chunks));
    return r;
  };
  const big = await run(2500);
  assert.ok(big.requestBudget > MAX_REQUESTS); assert.equal(big.code, 'REQUEST_BUDGET_EXCEEDED');
  // 15 s timeout: window cap is exceeded only for B > 920 (B x 15 s + 5 min > 4 h - 5 min); 1400 log rows give B = 930.
  const mid = await run(1400);
  assert.ok(mid.requestBudget <= MAX_REQUESTS && mid.requiredWindowMs > MAX_DESCRIPTOR_TTL_MS - CREDENTIAL_MARGIN_MS, JSON.stringify(mid));
  assert.equal(mid.code, 'RUN_WINDOW_EXCEEDS_CAP');
});

test('credential window: short-lived credential stops CREDENTIAL_WINDOW_INSUFFICIENT before HTTP; invalid shape rejected; values redacted', async () => {
  const f = syntheticPlan();
  const go = async (cred) => {
    const c = counters();
    const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'import',
      io: io(c, { readPlanBytes: async () => f.bytes, readCredential: async () => { c.cred++; return cred; } }), rehearsal: rehearsal(f.facts) });
    assert.equal(c.fetch, 0); assert.equal(r.requests, 0); assert.equal(r.writeAttempts, 0); assert.equal(c.cred, 1);
    const json = JSON.stringify(r);
    assert.ok(!json.includes(TOKEN) && !json.includes(SECRET) && !json.includes('SYNTHETICKEYID0001'));
    return r;
  };
  const short = await go(credential(new Date(Date.parse(BASE) + 30 * 60 * 1000).toISOString()));
  assert.equal(short.status, 'STOPPED_CREDENTIAL'); assert.equal(short.code, 'CREDENTIAL_WINDOW_INSUFFICIENT');
  assert.ok(short.requiredWindowMs > short.runWindowMs);
  assert.equal(short.requestBudget, requestBudget(0, short.chunks));
  for (const bad of [null, { ...credential(BASE), extra: 1 }, { ...credential(BASE), token: 'short' }, { ...credential(BASE), expiresAt: 'never' }, { ...credential(BASE), secretAccessKey: 'x' }]) {
    const r = await go(bad);
    assert.equal(r.code, 'CREDENTIAL_INVALID');
  }
  // Strict UTC instants for BOTH expiries (zone-less/partial/offset strings rejected), and the EARLIER of the two
  // governs the window: an R2 key that expires first must stop the run before any HTTP.
  const ok3h = new Date(Date.parse(BASE) + 3 * 60 * 60 * 1000).toISOString();
  for (const badInstant of ['2026-10-18T03:00:00', '2026-10-18 03:00:00Z', '2026-10-18T03:00:00+07:00', '12', '2026-10-18', '']) {
    assert.equal((await go(credential(badInstant))).code, 'CREDENTIAL_INVALID');
    assert.equal((await go(credential(ok3h, badInstant))).code, 'CREDENTIAL_INVALID');
  }
  const noR2 = { ...credential(ok3h) }; delete noR2.r2ExpiresAt;
  assert.equal((await go(noR2)).code, 'CREDENTIAL_INVALID');
  const r2Short = await go(credential(ok3h, new Date(Date.parse(BASE) + 30 * 60 * 1000).toISOString()));
  assert.equal(r2Short.code, 'CREDENTIAL_WINDOW_INSUFFICIENT');
  const r2Long = await go(credential(ok3h, new Date(Date.parse(BASE) + 13 * 60 * 60 * 1000).toISOString()));
  assert.equal(r2Long.status, 'STOPPED_CREDENTIAL'); assert.equal(r2Long.code, 'CREDENTIAL_LIFETIME_TOO_LONG');
  // A credential that lives longer than 12 h is refused before any HTTP (short-lived token policy).
  const longLived = await go(credential(new Date(Date.parse(BASE) + 13 * 60 * 60 * 1000).toISOString()));
  assert.equal(longLived.status, 'STOPPED_CREDENTIAL'); assert.equal(longLived.code, 'CREDENTIAL_LIFETIME_TOO_LONG');
  // The injected clock advances between reads, so test just above the cap with a margin of a minute.
  const aboveCap = await go(credential(new Date(Date.parse(BASE) + 12 * 60 * 60 * 1000 + 60 * 1000).toISOString()));
  assert.equal(aboveCap.code, 'CREDENTIAL_LIFETIME_TOO_LONG');
});

test('credential is snapshotted before validation: accessors/symbols/extras rejected without running getters', async () => {
  const f = syntheticPlan();
  let getterCalls = 0;
  const valid = () => credential(new Date(Date.parse(BASE) + 3 * 60 * 60 * 1000).toISOString());
  const withGetter = valid(); Object.defineProperty(withGetter, 'token', { get: () => { getterCalls++; return TOKEN; }, enumerable: true });
  const hiddenKey = valid(); Object.defineProperty(hiddenKey, 'token', { value: TOKEN, enumerable: false });
  // Count only credential-field reads (promise resolution itself probes `then` on any awaited object).
  const CRED_KEYS = new Set(['token', 'expiresAt', 'accessKeyId', 'secretAccessKey']);
  const proxied = new Proxy(valid(), { get: (t, k) => { if (CRED_KEYS.has(k)) getterCalls++; return t[k]; } });
  for (const bad of [withGetter, hiddenKey, { ...valid(), [Symbol('x')]: 1 }, Object.assign(Object.create({ inherited: 1 }), valid()), { ...valid(), extra: 'x' }]) {
    const c = counters();
    const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'import',
      io: io(c, { readPlanBytes: async () => f.bytes, readCredential: async () => bad }), rehearsal: rehearsal(f.facts) });
    assert.equal(r.status, 'STOPPED_CREDENTIAL'); assert.equal(r.code, 'CREDENTIAL_INVALID');
    assert.equal(c.fetch, 0); assert.equal(r.requests, 0);
  }
  // A data-only Proxy is copied through property descriptors: its `get` trap never runs (stopped at the first fake fetch).
  const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'import',
    io: io(counters(), { readPlanBytes: async () => f.bytes, readCredential: async () => proxied, fetchImpl: async () => { throw new Error('offline'); } }), rehearsal: rehearsal(f.facts) });
  assert.equal(r.status, 'STOPPED_EMPTY_CHECK'); assert.equal(r.code, 'HTTP_FAILED');
  assert.equal(getterCalls, 0);
});

test('reader-retained credential mutation after the snapshot never changes request headers or the window', async () => {
  const f = syntheticPlan();
  const raw = credential(new Date(Date.parse(BASE) + 3 * 60 * 60 * 1000).toISOString());
  const seen = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    // The reader still holds `raw`: mutate every field mid-run.
    Object.assign(raw, { token: `MUTATED-TOKEN-${'b'.repeat(30)}`, expiresAt: BASE, accessKeyId: 'MUTATEDKEYID00001', secretAccessKey: 'MutatedSecretValue0123456789' });
    if (seen.length === 1) return json({ success: true, errors: [], messages: [], result: [{ success: true, results: [{ user_objects: 0 }] }] });
    return json({ success: false }, 500); // first setup statement: stop deterministically
  };
  const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'import',
    io: io(counters(), { readPlanBytes: async () => f.bytes, readCredential: async () => raw, fetchImpl }), rehearsal: rehearsal(f.facts) });
  assert.equal(r.status, 'STOPPED_SETUP'); assert.equal(r.code, 'HTTP_STATUS');
  assert.equal(seen.length, 2); assert.equal(r.requests, 2);
  assert.deepEqual(seen, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  assert.ok(r.runWindowMs > 2 * 60 * 60 * 1000); // computed from the snapshot expiry, not the mutated one
  assert.equal(r.manualRecoveryRequired, true); assert.equal(r.writeAttempts, 1);
  const out = JSON.stringify(r);
  for (const secret of [TOKEN, SECRET, 'MUTATED', 'Mutated']) assert.ok(!out.includes(secret));
});

test('injected reader errors map to fixed codes only; raw error text and paths never escape', async () => {
  const f = syntheticPlan();
  const raw = 'C:/Users/someone/private/plan.json secret-detail';
  for (const [thrown, code] of [
    [Object.assign(new Error(raw), { code: 'PRIVATE_PERMISSIONS' }), 'PRIVATE_PERMISSIONS'],
    [Object.assign(new Error(raw), { code: 'ENOENT' }), 'OPERATION_FAILED'],
    [new Error(raw), 'OPERATION_FAILED'],
    [raw, 'OPERATION_FAILED'],
  ]) {
    const r = await orchestrateImport({ kind: 'synthetic-rehearsal', mode: 'describe-plan', io: io(counters(), { readPlanBytes: async () => { throw thrown; } }), rehearsal: rehearsal(f.facts) });
    assert.equal(r.status, 'STOPPED_PRIVATE_VALIDATION'); assert.equal(r.code, code);
    assert.ok(!JSON.stringify(r).includes('secret-detail'));
  }
});

test('binding inventory: exact allowlist, missing/extra/deploy config, link and depth fail closed; skipped dirs ignored', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sikap-inv-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const allow = ['wrangler.toml', 'ops/a/wrangler.toml'];
  const make = (name, files) => {
    const root = path.join(tmp, name);
    for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); }
    return root;
  };
  const base = { 'wrangler.toml': 'name = "x"\n', 'ops/a/wrangler.toml': 'name = "y"\n', 'src/index.js': 'export {}\n' };
  const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code; } };
  const ok = make('ok', { ...base, 'node_modules/p/wrangler.toml': 'x', '.git/wrangler.toml': 'x', '.worktrees/w/wrangler.json': 'x', '.wrangler/state/wrangler.toml': 'x', '.wrangler/tmp/wrangler.jsonc': 'x' });
  assert.deepEqual(scanBindingInventory(ok, allow, PROD_TARGET), { configFiles: 2, localOnly: true, remoteBindingProof: false });
  assert.equal(code(() => scanBindingInventory(make('missing', { 'wrangler.toml': 'x' }), allow, PROD_TARGET)), 'CONFIG_INVENTORY_MISMATCH');
  assert.equal(code(() => scanBindingInventory(make('extra', { ...base, 'dist/wrangler.jsonc': '{}' }), allow, PROD_TARGET)), 'CONFIG_INVENTORY_MISMATCH');
  assert.equal(code(() => scanBindingInventory(make('json', { ...base, 'workers/z/WRANGLER.JSON': '{}' }), allow, PROD_TARGET)), 'CONFIG_INVENTORY_MISMATCH');
  assert.equal(code(() => scanBindingInventory(make('deploy', { ...base, '.wrangler/deploy/config.json': '{}' }), allow, PROD_TARGET)), 'CONFIG_INVENTORY_MISMATCH');
  for (const value of [PROD_TARGET.databaseId.toUpperCase(), PROD_TARGET.databaseName, PROD_TARGET.bucket]) {
    assert.equal(code(() => scanBindingInventory(make(`bind-${h(value).slice(0, 8)}`, { ...base, 'ops/a/wrangler.toml': `[[env.prod.d1_databases]]\nid = "${value}"\n` }), allow, PROD_TARGET)), 'APP_BINDING_PRESENT');
  }
  assert.equal(code(() => scanBindingInventory(make('rehearsal-bind', { ...base, 'wrangler.toml': `bucket_name = "${REHEARSAL_TARGET.bucket}"\n` }), allow, REHEARSAL_TARGET)), 'APP_BINDING_PRESENT');
  let deep = ''; for (let i = 0; i <= INVENTORY_MAX_DEPTH + 1; i++) deep += `d${i}/`;
  assert.equal(code(() => scanBindingInventory(make('deep', { ...base, [`${deep}x.txt`]: 'x' }), allow, PROD_TARGET)), 'CONFIG_INVENTORY_LIMIT');
  const linked = make('linked', base);
  let linkMade = true;
  try { symlinkSync(path.join(linked, 'src'), path.join(linked, 'junction'), 'junction'); } catch { linkMade = false; }
  if (linkMade) assert.equal(code(() => scanBindingInventory(linked, allow, PROD_TARGET)), 'CONFIG_INVENTORY_LINK');
  assert.equal(code(() => scanBindingInventory('relative/root', allow, PROD_TARGET)), 'CONFIG_INVENTORY_UNREADABLE');
});

test('actual repository inventory equals the reviewed 5-file allowlist and contains no prod/rehearsal binding (local only)', () => {
  const root = new URL('../../', import.meta.url);
  assert.equal(PINS.CONFIG_FILES.length, 5);
  for (const target of [PROD_TARGET, REHEARSAL_TARGET]) assert.deepEqual(scanBindingInventory(root, PINS.CONFIG_FILES, target), { configFiles: 5, localOnly: true, remoteBindingProof: false });
});

test('orchestrator source has no default I/O, env, wall clock, private paths or production override path', () => {
  // Drop comments and the in-memory Miniflare worker script literal (its `fetch()` handler never runs outbound).
  const source = lf('scripts/import/prod-import-orchestrator.mjs').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    .replace("'export default { fetch() { return new Response(null, { status: 404 }); } };'", "'WORKER'");
  for (const pattern of [/globalThis/, /process\./, /Date\.now/, /new Date\(\)/, /child_process/, /sikap-private/, /credentials\.env/, /\.wrangler\\\\config/, /eval\(/, /new Function/, /(^|[^.\w])fetch\(/m]) assert.doesNotMatch(source, pattern);
  // the only transport call goes through the budget-capped gate (ctx.fetch) wrapping the injected io.fetchImpl
  assert.equal((source.match(/[^.\w]fetchImpl\(/g) ?? []).length, 1);
  // production pins can only come from the pins module; the rehearsal kind never selects the production issuer/status
  assert.match(source, /pins = \{ modules: PINS\.MODULE_PINS, planFacts: plainData\(PINS\.PLAN_FACTS\) \}/);
  assert.equal((source.match(/issueRealDataProductionPermit/g) ?? []).length, 2); // import + production profile
  assert.equal((source.match(/'COMPLETE_PROD_RECONCILED'/g) ?? []).length, 2); // production profile + OK list
  for (const t of [PROD_TARGET, UAT_TARGET, REHEARSAL_TARGET]) assert.ok(!source.includes(t.databaseId));
});
