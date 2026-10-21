// Local-only tests for the D1 read-back reader. Every fetch is an injected stub; no network,
// no credentials, no env/FS access (except reading this module's own source). Target UUIDs synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { COLUMNS, LEDGER, SAFETY } from './core.mjs';
import { createD1Readback, ReadbackError, READBACK_ERROR_CODES, READBACK_QUERIES, SCHEMA_QUERY, MAX_RESPONSE_BYTES } from './d1-readback.mjs';
import {
  UAT_TARGET, UAT_APP_SCHEMA_SHA256, UAT_LEDGER_SCHEMA_SHA256, UAT_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256,
  issueRealDataUatPermit, claimPermitForRun, finishPermitRun,
} from './real-data-gate.mjs';

const NOW = '2026-10-18T00:00:00.000Z', LATER = '2026-10-18T00:10:00.000Z';
const TOKEN = 'synthetic-test-token-0123456789abcdef';
const DB = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${UAT_ACCOUNT}/d1/database/${DB}/query`;
const UNI = 'Sintetis "Kutip" \u00e9 \u{1F600} O\'Neil';
const h = (s) => createHash('sha256').update(s).digest('hex');
const descriptor = (over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT, databaseId: DB,
  databaseName: 'sikap-import-synthetic-1', bucket: 'sikap-import-synthetic-1-files', profile: 'synthetic',
  snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: h('ledger'), baselineSha256: h('baseline'), policySha256: h('policy'),
  retentionPolicySha256: h('retention'), runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: '2026-10-18T01:00:00.000Z', ...over,
});
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
const row = (columns, fill) => Object.fromEntries(columns.map((c, i) => [c, fill(c, i)]));
function okBody(n = 9) {
  const result = READBACK_QUERIES.map(() => ({ success: true, results: [], meta: { duration: 0.1, rows_read: 0 } }));
  result[0].results = [row(LEDGER.runColumns, (c, i) => (c === 'last_chunk_sha256' ? null : i))];
  // Reversed key order in the response: output must still be canonical column order.
  result[4].results = [Object.fromEntries(Object.entries(row(COLUMNS.pegawai, (c, i) => (c === 'nama' ? UNI : c === 'alamat' ? null : i))).reverse())];
  if (n === 10) result.push({ success: true, results: [{ type: 'table', name: 'pegawai', tbl_name: 'pegawai', sql: 'CREATE TABLE pegawai (id INTEGER)' }, { type: 'index', name: 'sqlite_autoindex_x_1', tbl_name: 'x', sql: null }] });
  return { result, errors: [], messages: [], success: true };
}
const respond = (body, { status = 200, type = 'application/json' } = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
function stub(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return typeof reply === 'function' ? reply(init) : reply; };
  return { calls, fetchImpl };
}
const make = (fetchImpl, over = {}) => createD1Readback({ descriptor: descriptor(), token: TOKEN, fetchImpl, ...over });
const noLeak = (value, extra = []) => {
  const text = `${value?.message ?? ''} ${value?.code ?? ''} ${JSON.stringify(value)}`;
  for (const secret of [TOKEN, UNI, 'Kutip', DB, UAT_ACCOUNT, 'SELECT', ...extra]) assert.ok(!text.includes(secret));
};
async function rejectsWith(reader, code, { now = LATER, extra = [] } = {}) {
  await assert.rejects(reader.read({ now }), (e) => {
    assert.ok(e instanceof ReadbackError); assert.equal(e.code, code); assert.equal(e.message, code);
    assert.ok(READBACK_ERROR_CODES.includes(e.code)); noLeak(e, extra); return true;
  });
  await assert.rejects(reader.read({ now }), { code: 'HALTED' }); // any failure halts permanently
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('fixed endpoint/headers; read-only static SELECT batch; no caller SQL; schema optional tenth', async () => {
  const s = stub(() => respond(okBody()));
  const reader = make(s.fetchImpl);
  assert.deepEqual(Object.keys(reader), ['read']); assert.ok(Object.isFrozen(reader));
  await reader.read({ now: LATER });
  const { url, init } = s.calls[0];
  assert.equal(url, ENDPOINT);
  assert.deepEqual(Object.keys(init).sort(), ['body', 'cache', 'headers', 'method', 'redirect', 'signal']);
  assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
  const { batch } = JSON.parse(init.body);
  assert.equal(batch.length, 9);
  assert.equal(batch[0].sql, `SELECT ${LEDGER.runColumns.join(', ')} FROM ${LEDGER.runTable} ORDER BY id`);
  assert.equal(batch[1].sql, `SELECT ${LEDGER.journalColumns.join(', ')} FROM ${LEDGER.journalTable} ORDER BY run_nonce, ordinal`);
  assert.equal(batch[4].sql, `SELECT ${COLUMNS.pegawai.join(', ')} FROM pegawai ORDER BY id`);
  assert.equal(batch[3].sql, `SELECT ${COLUMNS.jenis_dokumen_wajib.join(', ')} FROM jenis_dokumen_wajib ORDER BY jenis_dokumen_id, status_kepegawaian`);
  for (const st of batch) {
    assert.deepEqual(Object.keys(st), ['sql', 'params']); assert.deepEqual(st.params, []);
    assert.match(st.sql, /^SELECT [a-z_0-9, ]+ FROM [a-z_0-9]+ ORDER BY [a-z_0-9, ]+$/);
    assert.doesNotMatch(st.sql, /\b(UPDATE|INSERT|DELETE|DROP|CREATE|ALTER|REPLACE|PRAGMA|ATTACH)\b|;/i);
  }
  assert.ok(!init.body.includes(UNI) && !init.body.includes(DB));
  const s2 = stub(() => respond(okBody(10)));
  const out = await make(s2.fetchImpl, { includeSchema: true }).read({ now: LATER });
  const b2 = JSON.parse(s2.calls[0].init.body).batch;
  assert.equal(b2.length, 10); assert.equal(b2[9].sql, SCHEMA_QUERY.sql);
  assert.doesNotMatch(b2[9].sql, /\b(UPDATE|INSERT|DELETE|DROP|CREATE)\b|;/i);
  assert.equal(out.schema.length, 2); assert.equal(out.schema[1].sql, null);
  for (const extra of [{ sql: 'DELETE FROM pegawai' }, { tables: ['pegawai'] }, { where: 'id=1' }, { includeSchema: 'yes' }]) {
    assert.throws(() => make(s.fetchImpl, extra), { code: 'INPUT_INVALID' });
  }
});

test('full private rows: Unicode/null preserved, canonical column order, safety flags, frozen', async () => {
  const s = stub(() => respond(okBody()));
  const out = await make(s.fetchImpl).read({ now: LATER });
  assert.equal(out.private, true); assert.equal(out.identityVerified, false); assert.equal(out.transportProven, false);
  for (const [k, v] of Object.entries(SAFETY)) assert.equal(out[k], v);
  assert.ok(!('schema' in out));
  assert.deepEqual(Object.keys(out.tables), IMPORT_TABLES);
  assert.equal(out.run.length, 1); assert.deepEqual(Object.keys(out.run[0]), LEDGER.runColumns);
  assert.equal(out.run[0].last_chunk_sha256, null);
  const p = out.tables.pegawai[0];
  assert.deepEqual(Object.keys(p), COLUMNS.pegawai);
  assert.equal(p.nama, UNI); assert.equal(p.alamat, null); assert.equal(p.id, 0);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.tables) && Object.isFrozen(out.tables.pegawai) && Object.isFrozen(p));
  assert.ok(!JSON.stringify(out).includes(TOKEN));
  // Sequential successful reads allowed; non-monotone now halts.
  const reader = make(stub(() => respond(okBody())).fetchImpl);
  await reader.read({ now: NOW }); await reader.read({ now: LATER });
  await rejectsWith(reader, 'NOW_NOT_MONOTONE', { now: NOW });
});

test('strict envelope/result count/row keys/values fail closed with code only', async () => {
  const big = 'x'.repeat(64 * 1024 + 1);
  const cases = [
    [(b) => { b.result.pop(); }, 'RESULT_COUNT'],
    [(b) => { b.result.push(b.result[2]); }, 'RESULT_COUNT'],
    [(b) => { b.success = false; }, 'ENVELOPE_INVALID'],
    [(b) => { b.messages.push({ message: UNI }); }, 'ENVELOPE_INVALID'],
    [(b) => { b.errors.push({ code: 1, message: TOKEN }); }, 'ENVELOPE_INVALID'],
    [(b) => { b.extra = 1; }, 'ENVELOPE_INVALID'],
    [(b) => { b.result[2].success = false; }, 'RESULT_INVALID'],
    [(b) => { b.result[2].extra = UNI; }, 'RESULT_INVALID'],
    [(b) => { b.result[2].meta = { deep: { a: { b: { c: { d: 1 } } } } }; }, 'META_INVALID'],
    [(b) => { b.result[0].results.push(b.result[0].results[0]); }, 'ROW_LIMIT'],
    [(b) => { delete b.result[4].results[0].nama; }, 'ROW_INVALID'],
    [(b) => { b.result[4].results[0].secret = UNI; }, 'ROW_INVALID'],
    [(b) => { b.result[4].results[0].nama = `${UNI}\0`; }, 'VALUE_INVALID'],
    [(b) => { b.result[4].results[0].nama = big; }, 'VALUE_INVALID'],
    [(b) => { b.result[4].results[0].id = 1.5; }, 'VALUE_INVALID'],
    [(b) => { b.result[4].results[0].id = 2 ** 53; }, 'VALUE_INVALID'],
    [(b) => { b.result[4].results[0].id = true; }, 'VALUE_INVALID'],
    [(b) => { b.result[4].results[0].nama = { v: UNI }; }, 'VALUE_INVALID'],
  ];
  for (const [mutate, code] of cases) {
    const body = okBody(); mutate(body);
    const s = stub(() => respond(body));
    await rejectsWith(make(s.fetchImpl), code);
    assert.equal(s.calls.length, 1, 'no retry');
  }
});

test('inputs: getters/extra keys/token/fetch/profile/expiry denied with zero fetch calls', async () => {
  const s = stub(() => respond(okBody()));
  const base = { descriptor: descriptor(), token: TOKEN, fetchImpl: s.fetchImpl };
  assert.throws(() => createD1Readback({ ...base, fetchImpl: undefined }), { code: 'FETCH_REQUIRED' });
  for (const token of ['short', `${'a'.repeat(20)}\nX`, null]) assert.throws(() => createD1Readback({ ...base, token }), { code: 'TOKEN_INVALID' });
  for (const timeoutMs of [0, 120_001, 1.5, '60000']) assert.throws(() => createD1Readback({ ...base, timeoutMs }), { code: 'TIMEOUT_INVALID' });
  const getter = { ...base }; delete getter.token;
  Object.defineProperty(getter, 'token', { get() { throw new Error(TOKEN); }, enumerable: true });
  assert.throws(() => createD1Readback(getter), { code: 'INPUT_INVALID' });
  assert.throws(() => createD1Readback({ ...base, descriptor: descriptor({ profile: 'real-data' }) }), { code: 'PROFILE_BLOCKED' });
  const dget = descriptor(); Object.defineProperty(dget, 'profile', { get() { return 'synthetic'; }, enumerable: true });
  assert.throws(() => createD1Readback({ ...base, descriptor: dget }), { code: 'DESCRIPTOR_INVALID' });
  await rejectsWith(make(s.fetchImpl, { descriptor: descriptor({ databaseName: 'sikap-db' }) }), 'DESCRIPTOR_TARGET_DENIED');
  await rejectsWith(make(s.fetchImpl, { descriptor: descriptor({ extra: 1 }) }), 'DESCRIPTOR_INVALID');
  await rejectsWith(make(s.fetchImpl), 'DESCRIPTOR_EXPIRED', { now: '2026-10-18T01:00:00.000Z' });
  await rejectsWith(make(s.fetchImpl), 'NOW_INVALID', { now: 'yesterday' });
  const r = make(s.fetchImpl);
  await assert.rejects(r.read({ now: LATER, sql: 'DELETE FROM pegawai' }), { code: 'INPUT_INVALID' });
  await assert.rejects(r.read({ now: LATER }), { code: 'HALTED' });
  // Frozen snapshot: caller mutation after create is ignored.
  const d = descriptor(); const r2 = make(s.fetchImpl, { descriptor: d });
  d.profile = 'real-data'; d.databaseId = '4f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b'; d.expiresAt = '2026-10-18T03:00:00.000Z';
  assert.equal(s.calls.length, 0);
  await r2.read({ now: LATER });
  assert.equal(s.calls[0].url, ENDPOINT);
});

test('HTTP/redirect/content-type/fetch errors: closed code, provider text never echoed, body cancelled', async () => {
  const leaky = { success: false, errors: [{ code: 7500, message: `${UNI} ${TOKEN} provider-secret` }], messages: [], result: null };
  for (const status of [400, 401, 429, 503]) await rejectsWith(make(stub(() => respond(leaky, { status })).fetchImpl), 'HTTP_STATUS', { extra: ['provider-secret', String(status)] });
  await rejectsWith(make(stub(() => respond(okBody(), { type: 'text/html' })).fetchImpl), 'CONTENT_TYPE');
  const moved = respond(okBody()); Object.defineProperty(moved, 'url', { value: 'https://evil.example/x' });
  await rejectsWith(make(stub(moved).fetchImpl), 'REDIRECTED');
  await rejectsWith(make(stub(() => { throw new Error(`boom ${TOKEN} provider-secret`); }).fetchImpl), 'FETCH_FAILED', { extra: ['provider-secret'] });
  await rejectsWith(make(stub(() => respond('{"success":true')).fetchImpl), 'BODY_INVALID');
  let cancelled = 0;
  const open = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode(TOKEN)); return new Promise(() => {}); }, cancel() { cancelled++; } });
  await rejectsWith(make(stub(new Response(open, { status: 503, headers: { 'content-type': 'application/json' } })).fetchImpl), 'HTTP_STATUS');
  await tick();
  assert.equal(cancelled, 1);
});

test('stream oversize, stalled body timeout, late fetch body cancelled', async () => {
  let cancelled = 0;
  const big = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024).fill(32)); }, cancel() { cancelled++; } });
  await rejectsWith(make(stub(new Response(big, { status: 200, headers: { 'content-type': 'application/json' } })).fetchImpl), 'BODY_OVERSIZE');
  assert.equal(MAX_RESPONSE_BYTES, 8 * 1024 * 1024); assert.equal(cancelled, 1);
  const stalled = new ReadableStream({ pull() { return new Promise(() => {}); } });
  await rejectsWith(make(stub(new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } })).fetchImpl, { timeoutMs: 30 }), 'TIMEOUT');
  let resolveFetch, signal;
  const s = stub((init) => { signal = init.signal; return new Promise((r) => { resolveFetch = r; }); }); // ignores abort
  await rejectsWith(make(s.fetchImpl, { timeoutMs: 20 }), 'TIMEOUT');
  assert.ok(signal.aborted);
  let lateCancelled = 0;
  resolveFetch(new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { lateCancelled++; } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await tick();
  assert.equal(lateCancelled, 1); assert.equal(s.calls.length, 1);
});

// Custom (non-native) response/reader: chunks may lie about byteLength, be Proxies, or be mutated later.
function customBody(chunks, { onRead } = {}) {
  const spy = { reads: 0, cancelled: 0 };
  const queue = [...chunks];
  const reader = {
    read: async () => { spy.reads++; onRead?.(spy.reads); return queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }; },
    cancel: async () => { spy.cancelled++; }, releaseLock() {},
  };
  return { spy, response: { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader: () => reader } } };
}

test('stream chunks: intrinsic byte length, Proxy/custom types rejected, private copy of bytes', async () => {
  class Liar extends Uint8Array { get byteLength() { return 1; } }
  const fake = customBody([new Liar(MAX_RESPONSE_BYTES + 1).fill(32), new Uint8Array(1)]);
  await rejectsWith(make(stub(fake.response).fetchImpl), 'BODY_OVERSIZE');
  assert.equal(fake.spy.cancelled, 1); assert.equal(fake.spy.reads, 1, 'no further reads after oversize');
  const leak = new TextEncoder().encode(`{"leak":"${TOKEN}"}`);
  for (const bad of [new Proxy(leak, {}), { byteLength: 5, 0: 123 }, Buffer.from(leak).buffer, new Uint16Array(4)]) {
    const b = customBody([bad]);
    await rejectsWith(make(stub(b.response).fetchImpl), 'BODY_INVALID');
    assert.equal(b.spy.cancelled, 1);
  }
  // Chunk mutated by the source after it was handed over: the reader parsed its private copy.
  const bytes = new TextEncoder().encode(JSON.stringify(okBody()));
  const m = customBody([bytes], { onRead: (n) => { if (n === 2) bytes.fill(0x20); } });
  const out = await make(stub(m.response).fetchImpl).read({ now: LATER });
  assert.equal(out.tables.pegawai[0].nama, UNI);
});

test('concurrent read rejects BUSY with a single fetch; instance then halts', async () => {
  let resolveFetch;
  const s = stub(() => new Promise((r) => { resolveFetch = r; }));
  const reader = make(s.fetchImpl);
  const first = reader.read({ now: LATER });
  await assert.rejects(reader.read({ now: LATER }), { code: 'BUSY' });
  await tick();
  resolveFetch(respond(okBody()));
  assert.equal((await first).private, true);
  assert.equal(s.calls.length, 1);
  await assert.rejects(reader.read({ now: LATER }), { code: 'HALTED' });
  assert.equal(s.calls.length, 1);
});

test('module source: no env/fs/global fetch/console/mutating SQL', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./d1-readback.mjs', import.meta.url), 'utf8');
  for (const bad of [/process\.env/, /node:fs/, /child_process/, /globalThis\.fetch/, /[^.\w]fetch\(/, /console\./, /\b(UPDATE|INSERT|DELETE|DROP|ALTER)\b/]) assert.doesNotMatch(src, bad);
  for (const q of [...READBACK_QUERIES, SCHEMA_QUERY]) assert.ok(Object.isFrozen(q) && Object.isFrozen(q.columns));
});

test('permit guards: real-data missing/forged/unclaimed/spent and synthetic+permit reject with ZERO fetch', async () => {
  const s = stub(() => respond(okBody()));
  const f = permitFixture();
  const base = { descriptor: f.d, token: TOKEN, fetchImpl: s.fetchImpl };

  assert.throws(() => createD1Readback(base), { code: 'PROFILE_BLOCKED' });
  for (const fake of [null, {}, { ...f.permit }, structuredClone(f.permit)]) {
    assert.throws(() => createD1Readback({ ...base, permit: fake }), { code: 'PERMIT_INVALID' });
  }
  const unclaimed = permitFixture({ claim: false });
  assert.throws(() => createD1Readback({ ...base, descriptor: unclaimed.d, permit: unclaimed.permit }), { code: 'PERMIT_INVALID' });
  finishPermitRun(f.permit);
  assert.throws(() => createD1Readback({ ...base, permit: f.permit }), { code: 'PERMIT_INVALID' });
  const synth = descriptor({ profile: 'synthetic' });
  const fresh = permitFixture();
  assert.throws(() => createD1Readback({ descriptor: synth, token: TOKEN, fetchImpl: s.fetchImpl, permit: fresh.permit }), { code: 'INPUT_INVALID' });
  assert.equal(s.calls.length, 0);
  finishPermitRun(fresh.permit);
});

test('permit expiry, full descriptor binding, stale time and finish BEFORE queued read dispatch reject with ZERO fetch', async () => {
  const s = stub(() => respond(okBody()));
  const f = permitFixture();

  const expiredReader = make(s.fetchImpl, { descriptor: f.d, permit: f.permit });
  await rejectsWith(expiredReader, 'DESCRIPTOR_EXPIRED', { now: EXPIRES });
  assert.equal(s.calls.length, 0);

  for (const over of [
    { databaseId: DB }, { databaseName: 'sikap-import-other' }, { bucket: 'sikap-import-other-files' },
    { snapshotId: '8a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d' }, { sourceSha256: h('foreign-source') },
    { planSha256: h('foreign-plan') }, { appSchemaSha256: h('foreign-app') },
    { ledgerSchemaSha256: h('foreign-ledger') }, { policySha256: h('foreign-policy') },
    { retentionPolicySha256: h('foreign-retention') }, { runNonce: 'a'.repeat(32) },
    { ownerNonce: 'b'.repeat(32) }, { epoch: 1 }, { expiresAt: '2026-10-18T01:30:00.000Z' },
  ]) {
    const fMismatch = permitFixture();
    const badReader = make(s.fetchImpl, { descriptor: descriptor({ ...fMismatch.d, ...over }), permit: fMismatch.permit });
    await rejectsWith(badReader, 'PERMIT_INVALID');
    assert.equal(s.calls.length, 0);
    finishPermitRun(fMismatch.permit);
  }

  const f2 = permitFixture();
  const s2 = stub(() => respond(okBody()));
  const reader2 = make(s2.fetchImpl, { descriptor: f2.d, permit: f2.permit });
  await reader2.read({ now: NOW });
  assert.equal(s2.calls.length, 1);
  await rejectsWith(reader2, 'NOW_NOT_MONOTONE', { now: '2026-10-17T23:59:59.999Z' });
  assert.equal(s2.calls.length, 1);
  finishPermitRun(f2.permit);

  // Finished before invocation
  const f3 = permitFixture();
  const s3 = stub(() => respond(okBody()));
  const reader3 = make(s3.fetchImpl, { descriptor: f3.d, permit: f3.permit });
  finishPermitRun(f3.permit);
  await rejectsWith(reader3, 'PERMIT_INVALID');
  assert.equal(s3.calls.length, 0);

  // Synchronous finish before queued fetch dispatch
  const f4 = permitFixture();
  const s4 = stub(() => respond(okBody()));
  const reader4 = make(s4.fetchImpl, { descriptor: f4.d, permit: f4.permit });
  const readPromise = reader4.read({ now: LATER });
  finishPermitRun(f4.permit);
  await assert.rejects(readPromise, { code: 'PERMIT_INVALID' });
  assert.equal(s4.calls.length, 0);

  finishPermitRun(f.permit);
});

test('issued claimed permit: exact UAT endpoint, read queries stub safe envelope counts, private rows and safety flags', async () => {
  const f = permitFixture();
  const s = stub(() => respond(okBody(10)));
  const reader = make(s.fetchImpl, { descriptor: f.d, permit: f.permit, includeSchema: true });

  const out = await reader.read({ now: LATER });
  assert.equal(s.calls.length, 1);
  const { url, init } = s.calls[0];
  assert.equal(url, UAT_ENDPOINT);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual(init.headers, { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });

  const { batch } = JSON.parse(init.body);
  assert.equal(batch.length, 10);
  assert.equal(batch[0].sql, `SELECT ${LEDGER.runColumns.join(', ')} FROM ${LEDGER.runTable} ORDER BY id`);
  assert.equal(batch[1].sql, `SELECT ${LEDGER.journalColumns.join(', ')} FROM ${LEDGER.journalTable} ORDER BY run_nonce, ordinal`);
  assert.equal(batch[4].sql, `SELECT ${COLUMNS.pegawai.join(', ')} FROM pegawai ORDER BY id`);
  assert.equal(batch[9].sql, SCHEMA_QUERY.sql);

  assert.equal(out.private, true);
  assert.equal(out.identityVerified, false);
  assert.equal(out.transportProven, false);
  for (const [k, v] of Object.entries(SAFETY)) assert.equal(out[k], v);
  assert.deepEqual(Object.keys(out.tables), IMPORT_TABLES);
  assert.equal(out.run.length, 1);
  assert.equal(out.schema.length, 2);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.tables));
  assert.ok(!JSON.stringify(out).includes(TOKEN));

  finishPermitRun(f.permit);
  await rejectsWith(reader, 'PERMIT_INVALID');
  assert.equal(s.calls.length, 1);
});
