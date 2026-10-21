// Local-only tests for the one-shot D1 REST adapter. Every fetch is an injected stub; no network,
// no credentials, no env/FS access. Target UUIDs are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { canonicalRow } from '../migrate/apply-local.mjs';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { SQL, SAFETY, CORE_VERSION, TRANSPORT, ImportCoreError, compileChunks, decodeStatement, validateDescriptor } from './core.mjs';
import { createD1RestAdapter, D1AdapterError, D1_ADAPTER_ERROR_CODES, MAX_RESPONSE_BYTES, ADAPTER_VERSION } from './d1-rest.mjs';
import {
  UAT_TARGET, UAT_APP_SCHEMA_SHA256, UAT_LEDGER_SCHEMA_SHA256, UAT_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256,
  issueRealDataUatPermit, claimPermitForRun, finishPermitRun,
} from './real-data-gate.mjs';

const NOW = '2026-10-18T00:00:00.000Z', LATER = '2026-10-18T00:10:00.000Z', CREATED = '2026-10-01T00:00:00.000Z';
const TOKEN = 'synthetic-test-token-0123456789abcdef';
const DB = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${UAT_ACCOUNT}/d1/database/${DB}/query`;
const PII = 'Sintetis "Kutip" \u00e9 \u{1F600} O\'Neil';
const h = (s) => createHash('sha256').update(s).digest('hex');
const descriptor = (over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT, databaseId: DB,
  databaseName: 'sikap-import-synthetic-1', bucket: 'sikap-import-synthetic-1-files', profile: 'synthetic',
  snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: h('ledger'), baselineSha256: h('baseline'), policySha256: h('policy'),
  retentionPolicySha256: h('retention'), runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: '2026-10-18T01:00:00.000Z', ...over,
});
function tables(jenis = 1) {
  const t = Object.fromEntries(IMPORT_TABLES.map((table) => [table, []]));
  for (let k = 1; k <= jenis; k++) t.jenis_dokumen.push(canonicalRow('jenis_dokumen', { id: `DOC-SYN${k}`, nama: `Jenis ${k}`, kategori: 'Sintetis' }, CREATED));
  t.pegawai.push(canonicalRow('pegawai', { id: Number.MAX_SAFE_INTEGER, nip: '199000000000000001', nama: PII, alamat: null }, CREATED));
  return t;
}
const compile = (d = descriptor(), jenis = 1) => compileChunks({ tables: tables(jenis) }, d, { now: NOW });
const EXPIRES = '2026-10-18T01:00:00.000Z';
const UAT_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${UAT_TARGET.accountId}/d1/database/${UAT_TARGET.databaseId}/query`;
function permitFixture({ claim = true } = {}) {
  const plan = {
    format: 'sikap-migration-plan', version: 1, snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
    sourceSha256: h('synthetic source'), createdAt: NOW, sourceReadOnlyDeclared: true, consistent: false, ready: true,
    tables: Object.fromEntries(IMPORT_TABLES.map((t) => [t, []])), files: [],
    expected: { pegawai: 0, akun: 0, arsip: 0, files: 0, totalFileBytes: 0, arsipPerStatus: { Menunggu: 0, Terverifikasi: 0, Ditolak: 0 } }, diagnostics: [],
  };
  const planBytes = Buffer.from(JSON.stringify(plan));
  const d = descriptor({
    ...UAT_TARGET, profile: 'real-data',
    snapshotId: plan.snapshotId, sourceSha256: plan.sourceSha256, planSha256: h(planBytes),
    appSchemaSha256: UAT_APP_SCHEMA_SHA256, ledgerSchemaSha256: UAT_LEDGER_SCHEMA_SHA256,
    baselineSha256: h('baseline'), policySha256: UAT_POLICY_SHA256, retentionPolicySha256: UAT_RETENTION_POLICY_SHA256,
    runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210', epoch: 0, expiresAt: EXPIRES,
  });
  const permit = issueRealDataUatPermit({ descriptor: d, planBytes, now: NOW });
  const claimRecord = claim ? claimPermitForRun(permit, { now: NOW }) : null;
  return { d, permit, claimRecord, plan };
}

function okBody(chunk) {
  const n = chunk.statementCount;
  const result = chunk.batch.map((_, i) => ({ success: true, results: i === 1 || i === n - 1 ? [{ sikap_import_guard: 1 }] : [], meta: { changes: i === 0 || i === n - 2 ? 1 : 0, duration: 0.1 } }));
  return { result, errors: [], messages: [], success: true };
}
const respond = (body, { status = 200, type = 'application/json' } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
function stub(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return typeof reply === 'function' ? reply(init) : reply; };
  return { calls, fetchImpl };
}
const make = (fetchImpl, over = {}) => { const artifact = over.artifact ?? compile(); return { artifact, adapter: createD1RestAdapter({ descriptor: descriptor(), artifact, token: TOKEN, fetchImpl, now: NOW, ...over }) }; };
const codeOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof D1AdapterError); assert.equal(e.message, e.code); assert.ok(D1_ADAPTER_ERROR_CODES.includes(e.code)); return e.code; } return null; };
const noLeak = (value) => {
  const text = JSON.stringify(value);
  for (const secret of [TOKEN, PII, 'Kutip', DB, UAT_ACCOUNT, 'INSERT', 'UPDATE', h('plan'), '0123456789abcdef0123456789abcdef']) assert.ok(!text.includes(secret));
};

test('exact endpoint, fixed headers, documented string-only params decode to typed values; accepted still requires read-back', async () => {
  assert.equal(ADAPTER_VERSION, 2); assert.equal(CORE_VERSION, 2); assert.equal(TRANSPORT, 'd1-rest-json-row-string-param-v2');
  const artifact = compile();
  const chunk = artifact.chunks.find((c) => c.table === 'pegawai');
  const s3 = stub(() => respond(okBody(chunk)));
  const { adapter: a3 } = make(s3.fetchImpl, { artifact });
  const out = await a3.send({ chunk, now: LATER });
  assert.equal(s3.calls.length, 1);
  const { url, init } = s3.calls[0];
  assert.equal(url, ENDPOINT);
  assert.deepEqual(Object.keys(init).sort(), ['body', 'cache', 'headers', 'method', 'redirect', 'signal']);
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
  assert.equal(typeof init.body, 'string');
  const sent = JSON.parse(init.body);
  assert.deepEqual(Object.keys(sent), ['batch']);
  assert.deepEqual(sent, { batch: chunk.batch });
  assert.equal(init.body, JSON.stringify({ batch: chunk.batch }));
  // Wire shape: every statement exactly {sql: string, params: string[]}; guards [] else one string.
  for (const st of sent.batch) {
    assert.deepEqual(Object.keys(st), ['sql', 'params']);
    assert.equal(typeof st.sql, 'string'); assert.ok(Array.isArray(st.params));
    assert.ok(st.params.every((p) => typeof p === 'string'));
    assert.equal(st.params.length, st.sql === SQL.guard ? 0 : 1);
  }
  assert.equal(chunk.parameterCount, sent.batch.reduce((s, st) => s + st.params.length, 0));
  const insert = sent.batch.find((st) => st.sql === SQL.insert.pegawai);
  const decoded = decodeStatement(insert);
  assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.values));
  assert.equal(decoded.kind, 'insert'); assert.equal(decoded.table, 'pegawai');
  assert.ok(decoded.values.includes(PII) && decoded.values.includes(Number.MAX_SAFE_INTEGER) && decoded.values.includes(null));
  assert.equal(insert.params[0], JSON.stringify(decoded.values));
  assert.ok(!insert.params[0].includes('\\u00e9'), 'canonical JSON keeps Unicode literal');
  const claim = decodeStatement(sent.batch[0]);
  assert.equal(claim.kind, 'claim'); assert.equal(claim.table, null); assert.equal(claim.values.at(-1), artifact.chunks[chunk.ordinal - 1].chunkSha256);
  assert.deepEqual(decodeStatement(sent.batch[1]), { kind: 'guard', table: null, values: [] });
  assert.equal(out.status, 'RESPONSE_ACCEPTED'); assert.equal(out.nextAction, 'READBACK_REQUIRED');
  assert.equal(out.halted, true); assert.equal(out.readyForImport, false); assert.equal(out.remoteAuthorized, false);
  assert.equal(out.transportProven, false); assert.equal(out.pilotAllowed, false); assert.equal(out.authorizesRetry, false);
  assert.equal(out.localTestingOnly, true); assert.equal(out.requiresReadBack, true);
  noLeak(out); noLeak(a3.summary()); noLeak(Object.keys(a3));
  assert.deepEqual(Object.keys(a3).sort(), ['send', 'summary']);
  assert.equal(a3.summary().sentCount, 1);
  // One-shot: any second send refused, no second fetch.
  await assert.rejects(a3.send({ chunk: artifact.chunks[chunk.ordinal + 1] ?? chunk, now: LATER }), { code: 'ADAPTER_SPENT' });
  assert.equal(s3.calls.length, 1);
});

test('constructor validation: fetch required, token, timeout, keys, getters, closed codes', () => {
  const base = { descriptor: descriptor(), artifact: compile(), token: TOKEN, fetchImpl: async () => respond({}), now: NOW };
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, fetchImpl: undefined })), 'FETCH_REQUIRED');
  const noFetch = { ...base }; delete noFetch.fetchImpl;
  assert.equal(codeOf(() => createD1RestAdapter(noFetch)), 'INPUT_INVALID');
  for (const token of ['short', 'x'.repeat(4097), `${'a'.repeat(20)}\nX`, `${'a'.repeat(20)} b`, `${'a'.repeat(20)}é`, 12345678901234567890n, null]) {
    const code = codeOf(() => createD1RestAdapter({ ...base, token }));
    assert.equal(code, 'TOKEN_INVALID'); assert.ok(!String(code).includes('aaaa'));
  }
  for (const timeoutMs of [0, 120_001, 1.5, '60000', null]) assert.equal(codeOf(() => createD1RestAdapter({ ...base, timeoutMs })), 'TIMEOUT_INVALID');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, host: 'https://evil.example' })), 'INPUT_INVALID');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, headers: {} })), 'INPUT_INVALID');
  const getter = { ...base }; delete getter.token;
  Object.defineProperty(getter, 'token', { get() { throw new Error('ran'); }, enumerable: true });
  assert.equal(codeOf(() => createD1RestAdapter(getter)), 'INPUT_INVALID');
  assert.equal(codeOf(() => createD1RestAdapter(Object.assign(Object.create({ evil: 1 }), base))), 'INPUT_INVALID');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, [Symbol('x')]: 1 })), 'INPUT_INVALID');
  assert.equal(codeOf(() => createD1RestAdapter(null)), 'INPUT_INVALID');
});

test('real-data profile, denied/foreign descriptor and unknown artifact blocked before any fetch', () => {
  const s = stub(respond({}));
  const base = { artifact: compile(), token: TOKEN, fetchImpl: s.fetchImpl, now: NOW };
  const real = descriptor({ profile: 'real-data' });
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: real, artifact: compile(real) })), 'PROFILE_BLOCKED');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: descriptor({ databaseName: 'sikap-db' }) })), 'DESCRIPTOR_TARGET_DENIED');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: descriptor({ epoch: 1 }) })), 'ARTIFACT_BINDING_MISMATCH');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: descriptor({ databaseId: '4f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' }) })), 'ARTIFACT_BINDING_MISMATCH');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: descriptor({ extra: 1 }) })), 'DESCRIPTOR_INVALID');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: descriptor(), artifact: structuredClone(compile()) })), 'ARTIFACT_UNKNOWN');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: descriptor(), now: '2026-10-18T02:00:00.000Z' })), 'DESCRIPTOR_EXPIRED');
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: descriptor(), now: 'yesterday' })), 'NOW_INVALID');
  assert.equal(s.calls.length, 0);
});

test('send gates: foreign/copied chunk, input keys, expiry and non-monotone now; no fetch, adapter spent', async () => {
  const other = compile();
  const cases = [
    [() => ({ chunk: other.chunks[0], now: LATER }), 'CHUNK_UNKNOWN'],
    [(a) => ({ chunk: structuredClone(a.chunks[0]), now: LATER }), 'CHUNK_UNKNOWN'],
    [(a) => ({ chunk: a.chunks[0], now: LATER, options: {} }), 'INPUT_INVALID'],
    [(a) => ({ chunk: a.chunks[0] }), 'INPUT_INVALID'],
    [(a) => ({ chunk: a.chunks[0], now: '2026-10-17T23:59:59.999Z' }), 'NOW_NOT_MONOTONE'],
    [(a) => ({ chunk: a.chunks[0], now: '2026-10-18T01:00:00.000Z' }), 'DESCRIPTOR_EXPIRED'],
    [(a) => ({ chunk: a.chunks[0], now: 1792290000000 }), 'NOW_INVALID'],
  ];
  for (const [input, code] of cases) {
    const s = stub(respond({}));
    const { artifact, adapter } = make(s.fetchImpl);
    await assert.rejects(adapter.send(input(artifact)), (e) => e instanceof D1AdapterError && e.code === code);
    assert.equal(s.calls.length, 0);
    await assert.rejects(adapter.send({ chunk: artifact.chunks[0], now: LATER }), { code: 'ADAPTER_SPENT' });
    assert.equal(s.calls.length, 0);
    assert.equal(adapter.summary().sentCount, 0);
  }
});

test('seed delete binds every imported jenis id across chunks; descriptor-bound values checked after decode', async () => {
  const artifact = compile(descriptor(), 20);
  const jenisChunks = artifact.chunks.filter((c) => c.table === 'jenis_dokumen');
  assert.ok(jenisChunks.length >= 2, 'jenis spans several chunks');
  const seed = decodeStatement(artifact.chunks[0].batch[2]);
  assert.equal(seed.kind, 'seedDelete'); assert.equal(seed.table, null);
  assert.deepEqual([...seed.values], Array.from({ length: 20 }, (_, k) => `DOC-SYN${k + 1}`));
  assert.ok(artifact.chunks.slice(1).every((c) => c.batch.every((s) => decodeStatement(s).kind !== 'seedDelete')));
  for (const c of artifact.chunks) assert.ok(c.valueCount <= 100 && c.parameterCount <= c.statementCount);
  const s = stub(withChunk(() => {}));
  const { adapter } = make(s.fetchImpl, { artifact });
  assert.equal((await adapter.send({ chunk: jenisChunks[1], now: LATER })).status, 'RESPONSE_ACCEPTED');
  // Same artifact under any other run/owner nonce or plan: decoded CAS values no longer match.
  for (const over of [{ runNonce: '1123456789abcdef0123456789abcdef' }, { ownerNonce: 'eedcba9876543210fedcba9876543210' }, { planSha256: h('other') }]) {
    assert.equal(codeOf(() => createD1RestAdapter({ descriptor: descriptor(over), artifact, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW })), 'ARTIFACT_BINDING_MISMATCH');
  }
  assert.equal(s.calls.length, 1);
});

test('core decoder rejects malformed, non-canonical, typed (v1) and getter statements; hand-built/v1 artifacts unknown', () => {
  const artifact = compile();
  const chunk = artifact.chunks.find((c) => c.table === 'pegawai');
  const claim = chunk.batch[0], insert = chunk.batch[2];
  const raw = insert.params[0], values = JSON.parse(raw);
  const getter = { sql: insert.sql }; Object.defineProperty(getter, 'params', { get() { throw new Error('ran'); }, enumerable: true });
  const holey = [raw]; holey.length = 2;
  const bad = [
    { sql: insert.sql, params: [raw], extra: 1 },
    { sql: insert.sql },
    getter,
    Object.assign(Object.create({ evil: 1 }), { sql: insert.sql, params: [raw] }),
    { sql: `${insert.sql} `, params: [raw] },
    { sql: 'DROP TABLE pegawai', params: [] },
    { sql: SQL.guard, params: [raw] },
    { sql: insert.sql, params: [] },
    { sql: insert.sql, params: [raw, raw] },
    { sql: insert.sql, params: holey },
    { sql: insert.sql, params: [JSON.stringify(values, null, 1)] },
    { sql: insert.sql, params: [` ${raw}`] },
    { sql: insert.sql, params: [JSON.stringify(values.slice(1))] },
    { sql: insert.sql, params: [JSON.stringify([...values, null])] },
    { sql: insert.sql, params: [JSON.stringify(values.map((x) => (typeof x === 'number' ? 1.5 : x)))] },
    { sql: insert.sql, params: [JSON.stringify(values.map((x) => (x === null ? true : x)))] },
    { sql: insert.sql, params: [JSON.stringify(values.map((x) => (x === null ? 2 ** 53 : x)))] },
    { sql: insert.sql, params: [JSON.stringify(values.map((x) => (x === null ? { a: 1 } : x)))] },
    { sql: insert.sql, params: [JSON.stringify(values.map((x) => (x === PII ? 'a\0b' : x)))] },
    { sql: insert.sql, params: [JSON.stringify({ values })] },
    { sql: insert.sql, params: [values] },
    { sql: insert.sql, params: values }, // v1 typed params
    { sql: claim.sql, params: JSON.parse(claim.params[0]) },
    { sql: claim.sql, params: [JSON.parse(claim.params[0]).length] },
  ];
  for (const st of bad) {
    assert.throws(() => decodeStatement(st), (e) => e instanceof ImportCoreError && e.code === 'STATEMENT_INVALID' && !e.message.includes('Sintetis'));
  }
  // Unicode, null and safe integers round-trip through the canonical JSON cell.
  const ok = decodeStatement({ sql: insert.sql, params: [raw] });
  assert.deepEqual([...ok.values], values);
  assert.ok(ok.values.includes(PII) && ok.values.includes(null) && ok.values.includes(Number.MAX_SAFE_INTEGER));
  // Adapter: anything not compiled by this core (copy, hand-built v1-shaped object) is unknown.
  const base = { descriptor: descriptor(), token: TOKEN, fetchImpl: async () => respond({}), now: NOW };
  const v1Shaped = { ...structuredClone(artifact), coreVersion: 1, transport: 'd1-rest-parameterized-batch-candidate-v1' };
  for (const art of [structuredClone(artifact), v1Shaped, { ...artifact }, null]) assert.equal(codeOf(() => createD1RestAdapter({ ...base, artifact: art })), 'ARTIFACT_UNKNOWN');
});

test('artifact chunks are frozen; injected SQL cannot be sent', () => {
  const artifact = compile();
  assert.throws(() => { artifact.chunks[0].batch[0].sql = 'DROP TABLE pegawai'; });
  assert.throws(() => { artifact.chunks[0].batch.push({ sql: 'DROP TABLE x', params: [] }); });
  assert.equal(artifact.chunks[0].batch[0].sql, SQL.claim);
  assert.ok(Object.isFrozen(validateDescriptor(descriptor(), NOW)));
});

async function ambiguous(reply, { reason, category = null, timeoutMs } = {}) {
  const s = stub(reply);
  const artifact = compile();
  const chunk = artifact.chunks[0];
  const { adapter } = make(s.fetchImpl, { artifact, ...(timeoutMs ? { timeoutMs } : {}) });
  const out = await adapter.send({ chunk, now: LATER });
  assert.equal(out.status, 'AMBIGUOUS'); assert.equal(out.halted, true); assert.equal(out.nextAction, 'READBACK_REQUIRED');
  assert.equal(out.authorizesRetry, false); assert.equal(out.readyForImport, false);
  if (reason) assert.equal(out.reason, reason);
  assert.equal(out.httpCategory, category);
  assert.equal(s.calls.length, 1, 'no automatic resend');
  await assert.rejects(adapter.send({ chunk, now: LATER }), { code: 'ADAPTER_SPENT' });
  assert.equal(s.calls.length, 1);
  noLeak(out); noLeak(adapter.summary());
  assert.equal(adapter.summary().outcome, 'AMBIGUOUS');
  return { out, chunk };
}
const withChunk = (mutate) => (init) => {
  const batch = JSON.parse(init.body).batch, n = batch.length;
  const body = okBody({ statementCount: n, batch });
  mutate(body, n);
  return respond(body);
};

test('HTTP 429/401/5xx and redirects halt ambiguous with category only, no echo of error body', async () => {
  const leaky = { success: false, errors: [{ code: 7500, message: `${PII} ${TOKEN}` }], messages: [], result: null };
  await ambiguous(respond(leaky, { status: 429 }), { reason: 'HTTP_STATUS', category: 'RATE_LIMITED' });
  await ambiguous(respond(leaky, { status: 401 }), { reason: 'HTTP_STATUS', category: 'AUTH' });
  const { out } = await ambiguous(respond(leaky, { status: 503 }), { reason: 'HTTP_STATUS', category: 'SERVER' });
  assert.equal(out.httpStatus, 503);
  await ambiguous(respond(leaky, { status: 400 }), { reason: 'HTTP_STATUS', category: 'CLIENT' });
  const redirected = respond({}); Object.defineProperty(redirected, 'redirected', { value: true });
  await ambiguous(redirected, { reason: 'REDIRECTED' });
  const moved = respond({}); Object.defineProperty(moved, 'url', { value: 'https://evil.example/x' });
  await ambiguous(moved, { reason: 'REDIRECTED' });
  await ambiguous({ status: 200 }, { reason: 'CONTENT_TYPE', category: 'SUCCESS' });
  await ambiguous(null, { reason: 'RESPONSE_INVALID' });
});

test('fetch throw and timeout are ambiguous; timers cleaned', async () => {
  await ambiguous(() => { throw new Error(`boom ${TOKEN}`); }, { reason: 'FETCH_FAILED' });
  let signal;
  const hang = (init) => { signal = init.signal; return new Promise(() => {}); };
  const started = Date.now();
  await ambiguous(hang, { reason: 'TIMEOUT', timeoutMs: 30 });
  assert.ok(signal.aborted); assert.ok(Date.now() - started < 5000);
});

test('stalled or oversize streaming body is bounded and halts', async () => {
  const big = new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(256 * 1024).fill(32)); },
  });
  await ambiguous(new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }), { reason: 'BODY_OVERSIZE', category: 'SUCCESS' });
  assert.equal(MAX_RESPONSE_BYTES, 2 * 1024 * 1024);
  const stalled = new ReadableStream({ pull() { return new Promise(() => {}); } });
  await ambiguous(new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } }), { reason: 'TIMEOUT', timeoutMs: 30, category: 'SUCCESS' });
  await ambiguous(respond('{"success":true', {}), { reason: 'BODY_INVALID', category: 'SUCCESS' });
  await ambiguous(respond(okBody({ statementCount: 0, batch: [] }), { type: 'text/html' }), { reason: 'CONTENT_TYPE', category: 'SUCCESS' });
  await ambiguous(new Response(new Uint8Array([0xff, 0xfe]), { status: 200, headers: { 'content-type': 'application/json' } }), { reason: 'BODY_INVALID', category: 'SUCCESS' });
});

test('strict success envelope: count, partial failure, messages, guards, results, meta', async () => {
  const cases = [
    [(b) => { b.result.pop(); }, 'RESULT_COUNT'],
    [(b) => { b.result.push(b.result[2]); }, 'RESULT_COUNT'],
    [(b) => { b.result[2].success = false; }, 'RESULT_INVALID'],
    [(b) => { b.success = false; }, 'ENVELOPE_INVALID'],
    [(b) => { b.messages.push({ message: 'note' }); }, 'ENVELOPE_INVALID'],
    [(b) => { b.errors.push({ code: 1 }); }, 'ENVELOPE_INVALID'],
    [(b) => { b.extra = 1; }, 'ENVELOPE_INVALID'],
    [(b) => { b.result[1].results = [{ sikap_import_guard: 0 }]; }, 'GUARD_INVALID'],
    [(b, n) => { b.result[n - 1].results = []; }, 'GUARD_INVALID'],
    [(b) => { b.result[1].results = [{ sikap_import_guard: 1, x: 1 }]; }, 'GUARD_INVALID'],
    [(b) => { b.result[2].results = [{ nama: PII }]; }, 'RESULT_INVALID'],
    [(b) => { b.result[2].extra = true; }, 'RESULT_INVALID'],
    [(b) => { b.result[0].meta = null; }, 'META_INVALID'],
    [(b) => { b.result[2].meta = [1]; }, 'META_INVALID'],
    [(b) => { b.result[2].meta = { deep: { a: { b: { c: { d: 1 } } } } }; }, 'META_INVALID'],
    [(b, n) => { b.result[n - 2].meta = { changes: 'x'.repeat(1025) }; }, 'META_INVALID'],
    // A plausible meta never rescues a failed guard or non-empty data result.
    [(b) => { b.result[1].results = []; b.result[0].meta.changes = 1; }, 'GUARD_INVALID'],
    [(b, n) => { b.result[n - 3].results = [{ x: 1 }]; b.result[n - 3].meta.changes = 1; }, 'RESULT_INVALID'],
  ];
  for (const [mutate, reason] of cases) await ambiguous(withChunk(mutate), { reason, category: 'SUCCESS' });
  // meta is optional, bounded and advisory: REST meta.changes is cumulative (sqlite3_total_changes),
  // so 0/2/cumulative/absent values are accepted and never treated as commit proof.
  const variants = [
    (b) => { b.result[0].meta.changes = 0; },
    (b, n) => { b.result[n - 2].meta.changes = 2; },
    (b) => { b.result.forEach((r, i) => { r.meta.changes = i + 1; r.meta.total_changes = i + 1; }); },
    (b) => { for (const r of b.result) delete r.meta.changes; },
    (b) => { for (const r of b.result) delete r.meta; },
  ];
  for (const mutate of variants) {
    const s = stub(withChunk(mutate));
    const { artifact, adapter } = make(s.fetchImpl);
    const out = await adapter.send({ chunk: artifact.chunks[0], now: LATER });
    assert.equal(out.status, 'RESPONSE_ACCEPTED'); assert.equal(out.nextAction, 'READBACK_REQUIRED');
    assert.equal(out.requiresReadBack, true); assert.equal(out.transportProven, false); assert.equal(out.authorizesRetry, false);
    assert.equal(s.calls.length, 1);
    noLeak(out);
  }
});

// Stream whose underlying cancel() is spied; optional fixed chunks then stays open.
function spyBody(chunks = [], { close = false } = {}) {
  const spy = { cancelled: 0 };
  const queue = [...chunks];
  const stream = new ReadableStream({
    pull(c) { if (queue.length) c.enqueue(queue.shift()); else if (close) c.close(); else return new Promise(() => {}); return undefined; },
    cancel() { spy.cancelled++; },
  });
  return { spy, response: (status = 200, type = 'application/json') => new Response(stream, { status, headers: { 'content-type': type } }) };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('concurrent sends: exactly one fetch; late fetch after timeout has its body cancelled', async () => {
  let resolveFetch;
  const s = stub(() => new Promise((r) => { resolveFetch = r; }));
  const { artifact, adapter } = make(s.fetchImpl, { timeoutMs: 20 });
  const chunk = artifact.chunks[0];
  const results = await Promise.allSettled([adapter.send({ chunk, now: LATER }), adapter.send({ chunk, now: LATER }), adapter.send({ chunk, now: LATER })]);
  assert.equal(s.calls.length, 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'ADAPTER_SPENT'));
  const out = results.find((r) => r.status === 'fulfilled').value;
  assert.equal(out.status, 'AMBIGUOUS'); assert.equal(out.reason, 'TIMEOUT'); assert.equal(out.nextAction, 'READBACK_REQUIRED');
  const late = spyBody([new TextEncoder().encode(JSON.stringify(okBody(chunk)))]);
  resolveFetch(late.response());
  await tick();
  assert.equal(late.spy.cancelled, 1, 'late body discarded, never read');
  assert.equal(adapter.summary().outcome, 'AMBIGUOUS'); assert.equal(s.calls.length, 1);
  // Late rejection after timeout is swallowed (no unhandled rejection).
  let rejectFetch;
  const s2 = stub(() => new Promise((_, j) => { rejectFetch = j; }));
  const { adapter: a2, artifact: art2 } = make(s2.fetchImpl, { timeoutMs: 20 });
  assert.equal((await a2.send({ chunk: art2.chunks[0], now: LATER })).reason, 'TIMEOUT');
  rejectFetch(new Error(TOKEN)); await tick();
});

test('early exits (503, redirect, content-type) cancel the unread body; oversize cancels before parse', async () => {
  for (const [make503, reason] of [
    [(b) => b.response(503), 'HTTP_STATUS'],
    [(b) => b.response(200, 'text/html'), 'CONTENT_TYPE'],
    [(b) => { const r = b.response(); Object.defineProperty(r, 'redirected', { value: true }); return r; }, 'REDIRECTED'],
  ]) {
    const b = spyBody([new TextEncoder().encode(`{"leak":"${TOKEN}"}`)]);
    await ambiguous(make503(b), { reason, category: reason === 'REDIRECTED' ? null : reason === 'HTTP_STATUS' ? 'SERVER' : 'SUCCESS' });
    await tick();
    assert.equal(b.spy.cancelled, 1, reason);
  }
  // Invalid JSON prefix followed by oversize: the cap fires first, so no parse is attempted.
  const piece = new Uint8Array(512 * 1024).fill(0x7b);
  const big = spyBody([new TextEncoder().encode('not-json'), piece, piece, piece, piece, piece]);
  await ambiguous(big.response(), { reason: 'BODY_OVERSIZE', category: 'SUCCESS' });
  await tick();
  assert.equal(big.spy.cancelled, 1);
  // Throwing/hanging cancel on the body cannot block or throw out of send.
  const evil = respond({}, { status: 500 });
  Object.defineProperty(evil, 'body', { value: { locked: false, cancel() { throw new Error(TOKEN); } } });
  await ambiguous(evil, { reason: 'HTTP_STATUS', category: 'SERVER' });
  const hang = respond({}, { status: 500 });
  Object.defineProperty(hang, 'body', { value: { locked: false, cancel: () => new Promise(() => {}) } });
  await ambiguous(hang, { reason: 'HTTP_STATUS', category: 'SERVER' });
});

test('expiry and binding use the frozen validated descriptor, not the mutable caller object', async () => {
  const d = descriptor();
  const s = stub(withChunk(() => {}));
  const artifact = compile();
  const adapter = createD1RestAdapter({ descriptor: d, artifact, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW });
  d.expiresAt = '2026-10-18T03:00:00.000Z'; d.profile = 'real-data'; d.databaseId = '4f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  await assert.rejects(adapter.send({ chunk: artifact.chunks[0], now: '2026-10-18T01:30:00.000Z' }), { code: 'DESCRIPTOR_EXPIRED' });
  assert.equal(s.calls.length, 0);
  const s2 = stub(withChunk(() => {}));
  const d2 = descriptor();
  const a2 = createD1RestAdapter({ descriptor: d2, artifact, token: TOKEN, fetchImpl: s2.fetchImpl, now: NOW });
  d2.databaseId = '4f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b'; d2.profile = 'real-data';
  assert.equal((await a2.send({ chunk: artifact.chunks[0], now: LATER })).status, 'RESPONSE_ACCEPTED');
  assert.equal(s2.calls[0].url, ENDPOINT);
});

test('core safety flags remain false; module has no env/fs/global fetch/child process usage', async () => {
  for (const key of Object.keys(SAFETY)) if (key !== 'proofRequired') assert.equal(SAFETY[key], false);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./d1-rest.mjs', import.meta.url), 'utf8');
  for (const bad of [/process\.env/, /node:fs/, /child_process/, /globalThis\.fetch/, /[^.\w]fetch\(/, /console\./, /\bretry\(/i]) assert.doesNotMatch(src, bad);
  assert.ok(src.includes("redirect: 'error'") && src.includes("cache: 'no-store'"));
});

test('permit guards: real-data missing/forged/unclaimed/spent and synthetic+permit reject with ZERO fetch', () => {
  const s = stub(respond({}));
  const f = permitFixture();
  const artifact = compileChunks({ tables: f.claimRecord.tables }, f.d, { now: NOW });
  const base = { descriptor: f.d, artifact, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW };

  assert.equal(codeOf(() => createD1RestAdapter(base)), 'PROFILE_BLOCKED');
  for (const fake of [null, {}, { ...f.permit }, structuredClone(f.permit)]) {
    assert.equal(codeOf(() => createD1RestAdapter({ ...base, permit: fake })), fake === null ? 'PROFILE_BLOCKED' : 'PERMIT_INVALID');
  }
  const unclaimed = permitFixture({ claim: false });
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, descriptor: unclaimed.d, artifact: compileChunks({ tables: unclaimed.plan.tables }, unclaimed.d, { now: NOW }), permit: unclaimed.permit })), 'PERMIT_INVALID');
  finishPermitRun(f.permit);
  assert.equal(codeOf(() => createD1RestAdapter({ ...base, permit: f.permit })), 'PERMIT_INVALID');
  const synth = descriptor({ profile: 'synthetic' });
  const fresh = permitFixture();
  assert.equal(codeOf(() => createD1RestAdapter({ descriptor: synth, artifact: compile(synth), token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: fresh.permit })), 'INPUT_INVALID');
  assert.equal(s.calls.length, 0);
  finishPermitRun(fresh.permit);
});

test('permit expiry, full descriptor binding, stale time, finish before queued send and arbitrary artifact reject with ZERO fetch', async () => {
  const s = stub(respond({}));
  const f = permitFixture();
  const artifact = compileChunks({ tables: f.claimRecord.tables }, f.d, { now: NOW });

  assert.equal(codeOf(() => createD1RestAdapter({ descriptor: f.d, artifact, token: TOKEN, fetchImpl: s.fetchImpl, now: EXPIRES, permit: f.permit })), 'DESCRIPTOR_EXPIRED');
  for (const over of [
    { databaseId: DB }, { databaseName: 'sikap-import-other' }, { bucket: 'sikap-import-other-files' },
    { snapshotId: '8a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' }, { sourceSha256: h('foreign-source') },
    { planSha256: h('foreign-plan') }, { appSchemaSha256: h('foreign-app') },
    { ledgerSchemaSha256: h('foreign-ledger') }, { policySha256: h('foreign-policy') },
    { retentionPolicySha256: h('foreign-retention') }, { runNonce: 'a'.repeat(32) },
    { ownerNonce: 'b'.repeat(32) }, { epoch: 1 }, { expiresAt: '2026-10-18T01:30:00.000Z' },
  ]) {
    assert.equal(codeOf(() => createD1RestAdapter({ descriptor: descriptor({ ...f.d, ...over }), artifact, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: f.permit })), 'PERMIT_INVALID', Object.keys(over)[0]);
  }

  // Arbitrary fake artifact not matching permit tables: rejected ARTIFACT_BINDING_MISMATCH
  const fakeTables = tables(1);
  const fakeArtifact = compileChunks({ tables: fakeTables }, f.d, { now: NOW });
  assert.equal(codeOf(() => createD1RestAdapter({ descriptor: f.d, artifact: fakeArtifact, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: f.permit })), 'ARTIFACT_BINDING_MISMATCH');

  const adapter = createD1RestAdapter({ descriptor: f.d, artifact, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: f.permit });
  const chunk = artifact.chunks[0];
  await assert.rejects(adapter.send({ chunk, now: '2026-10-17T23:59:59.999Z' }), { code: 'NOW_NOT_MONOTONE' });
  assert.equal(s.calls.length, 0);
  await assert.rejects(adapter.send({ chunk, now: LATER }), { code: 'ADAPTER_SPENT' });
  assert.equal(s.calls.length, 0);

  const f2 = permitFixture();
  const a2 = compileChunks({ tables: f2.claimRecord.tables }, f2.d, { now: NOW });
  const adapter2 = createD1RestAdapter({ descriptor: f2.d, artifact: a2, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: f2.permit });
  await assert.rejects(adapter2.send({ chunk: a2.chunks[0], now: EXPIRES }), { code: 'DESCRIPTOR_EXPIRED' });
  assert.equal(s.calls.length, 0);

  const f3 = permitFixture();
  const a3 = compileChunks({ tables: f3.claimRecord.tables }, f3.d, { now: NOW });
  const adapter3 = createD1RestAdapter({ descriptor: f3.d, artifact: a3, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: f3.permit });
  finishPermitRun(f3.permit);
  await assert.rejects(adapter3.send({ chunk: a3.chunks[0], now: LATER }), { code: 'PERMIT_INVALID' });
  assert.equal(s.calls.length, 0);

  // Synchronous finish before queued microtask dispatch: halts ambiguous FETCH_FAILED with zero fetch
  const f4 = permitFixture();
  const a4 = compileChunks({ tables: f4.claimRecord.tables }, f4.d, { now: NOW });
  const adapter4 = createD1RestAdapter({ descriptor: f4.d, artifact: a4, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: f4.permit });
  const sendPromise = adapter4.send({ chunk: a4.chunks[0], now: LATER });
  finishPermitRun(f4.permit);
  const out4 = await sendPromise;
  assert.equal(out4.status, 'AMBIGUOUS');
  assert.equal(out4.reason, 'FETCH_FAILED');
  assert.equal(adapter4.summary().sentCount, 0);
  assert.equal(s.calls.length, 0);
  await assert.rejects(adapter4.send({ chunk: a4.chunks[0], now: LATER }), { code: 'ADAPTER_SPENT' });
  assert.equal(s.calls.length, 0);

  finishPermitRun(f.permit);
  finishPermitRun(f2.permit);
});

test('issued claimed permit: stage artifacts from permit.tables via claim record, exact UAT endpoint and RESPONSE_ACCEPTED', async () => {
  const f = permitFixture();
  const artifact = compileChunks({ tables: f.claimRecord.tables }, f.d, { now: NOW });
  const chunk = artifact.chunks[0];
  const s = stub(() => respond(okBody(chunk)));
  const adapter = createD1RestAdapter({ descriptor: f.d, artifact, token: TOKEN, fetchImpl: s.fetchImpl, now: NOW, permit: f.permit });

  const out = await adapter.send({ chunk, now: LATER });
  assert.equal(s.calls.length, 1);
  const { url, init } = s.calls[0];
  assert.equal(url, UAT_ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
  assert.equal(init.body, JSON.stringify({ batch: chunk.batch }));

  assert.equal(out.status, 'RESPONSE_ACCEPTED');
  assert.equal(out.nextAction, 'READBACK_REQUIRED');
  assert.equal(out.halted, true);
  assert.equal(out.readyForImport, false);
  assert.equal(out.remoteAuthorized, false);
  assert.equal(out.transportProven, false);
  assert.equal(out.pilotAllowed, false);
  assert.equal(out.authorizesRetry, false);
  assert.equal(out.localTestingOnly, true);
  assert.equal(out.requiresReadBack, true);

  noLeak(out);
  noLeak(adapter.summary());
  assert.equal(adapter.summary().sentCount, 1);

  await assert.rejects(adapter.send({ chunk, now: LATER }), { code: 'ADAPTER_SPENT' });
  assert.equal(s.calls.length, 1);
  finishPermitRun(f.permit);
});
