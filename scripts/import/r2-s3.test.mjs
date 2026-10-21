// Synthetic specimens only, including permit-bound real-data profile tests. All fetches are stubs:
// no network, real credentials, environment, filesystem writes or real data. No real R2 proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { createHash, createHmac } from 'node:crypto';
import { UAT_ACCOUNT } from '../staging/uat-constants.mjs';
import { createR2S3Adapter, signV4, R2AdapterError, MAX_OBJECT_BYTES, R2_ADAPTER_VERSION, R2_OUTCOMES, R2_ERROR_CODES } from './r2-s3.mjs';
import { syntheticFixture } from '../migrate/fixture.mjs';
import { transformExport } from '../migrate/transform.mjs';
import {
  issueRealDataUatPermit, claimPermitForRun, finishPermitRun, getPermitFile, getPermitManifest,
  UAT_TARGET, UAT_APP_SCHEMA_SHA256, UAT_LEDGER_SCHEMA_SHA256, UAT_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256,
} from './real-data-gate.mjs';

const NOW = '2026-10-18T00:00:00.000Z';
const LATER = '2026-10-18T00:30:00.000Z';
const EXPIRES = '2026-10-18T01:00:00.000Z';
const SNAP = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const BUCKET = 'sikap-import-synthetic-1-files';
const ACCESS = 'SYNTHACCESSKEYID0001';
const SECRET = 'SYNTHETIC-SECRET/not+a+real+key+0001';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const h = (data) => createHash('sha256').update(data).digest('hex');
const descriptor = (over = {}) => ({
  format: 'sikap-remote-import-descriptor', version: 1, accountId: UAT_ACCOUNT,
  databaseId: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', databaseName: 'sikap-import-synthetic-1', bucket: BUCKET,
  profile: 'synthetic', snapshotId: SNAP, sourceSha256: h('source'), planSha256: h('plan'),
  appSchemaSha256: h('app'), ledgerSchemaSha256: h('ledger'), baselineSha256: h('baseline'), policySha256: h('policy'),
  retentionPolicySha256: h('retention'), runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210',
  epoch: 0, expiresAt: EXPIRES, ...over,
});
const PDF = () => new Uint8Array(Buffer.from('%PDF-1.4\n% synthetic r2 probe\n%%EOF\n'));
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const OPAQUE = h('opaque-client-id-1');
const KEY = `migration/${SNAP}/objects/${OPAQUE}.pdf`;
const URL_ = `https://${UAT_ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/${KEY}`;
const args = (over = {}) => { const bytes = over.bytes ?? PDF(); return { key: KEY, bytes, mimeType: 'application/pdf', sha256: 'sha256' in over ? over.sha256 : h(bytes), now: LATER, ...over }; };

// Stub fetch: records calls; each response is produced by the next handler in the queue.
function stub(...handlers) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    const next = handlers[calls.length - 1];
    if (!next) throw new Error('unexpected fetch');
    return next(url, init);
  };
  return { calls, fetchImpl };
}
const ok = (status = 200) => () => Promise.resolve(new Response(null, { status }));
const body = (bytes, type = 'application/pdf', status = 200) => () => Promise.resolve(new Response(bytes, { status, headers: { 'content-type': type } }));
function streamed(chunks, { stall = false, error = false, type = 'application/pdf' } = {}) {
  const state = { cancelled: false };
  const handler = () => Promise.resolve(new Response(new ReadableStream({
    start(c) { for (const part of chunks) c.enqueue(part); if (error) c.error(new Error('stream boom')); else if (!stall) c.close(); },
    pull() { return stall ? new Promise(() => {}) : undefined; },
    cancel() { state.cancelled = true; },
  }), { status: 200, headers: { 'content-type': type } }));
  return { state, handler };
}
const make = (fetchImpl, over = {}) => createR2S3Adapter({ descriptor: descriptor(), accessKeyId: ACCESS, secretAccessKey: SECRET, fetchImpl, now: NOW, timeoutMs: 20, ...over });
const codeOf = async (promiseOrFn) => {
  try { await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn); } catch (error) {
    assert.ok(error instanceof R2AdapterError, String(error?.name));
    assert.equal(error.message, error.code);
    assert.ok(!String(error.stack).includes(SECRET));
    return error.code;
  }
  return null;
};
const assertFlags = (out) => {
  for (const key of ['ready', 'readyForImport', 'remoteAuthorized', 'transportProof', 'authorizesRetry', 'productionVerified', 'ownershipProven', 'deleteAttempted', 'authorizesExecution']) assert.equal(out[key], false, key);
  for (const key of ['proofRequired', 'localTestingOnly', 'syntheticOnly']) assert.equal(out[key], true, key);
  assert.ok(Object.isFrozen(out));
};
const assertNoSecrets = (out) => {
  const text = JSON.stringify(out) + inspect(out, { depth: 5 });
  for (const bad of [SECRET, ACCESS, UAT_ACCOUNT, SNAP, BUCKET, OPAQUE, 'migration/', 'Signature', 'AWS4']) assert.ok(!text.includes(bad), bad);
  assert.doesNotMatch(text, /[0-9a-f]{32}/);
};
// Independent test-side SigV4 reference (canonical request rebuilt from the recorded request).
function referenceAuth(call, payloadSha256) {
  const url = new URL(call.url);
  const headers = { ...call.init.headers, host: url.host };
  delete headers.authorization;
  const names = Object.keys(headers).sort();
  const canonical = `${call.init.method}\n${url.pathname}\n\n${names.map((n) => `${n}:${headers[n]}\n`).join('')}\n${names.join(';')}\n${payloadSha256}`;
  const date = headers['x-amz-date'], day = date.slice(0, 8), scope = `${day}/auto/s3/aws4_request`;
  const hmac = (k, d) => createHmac('sha256', k).update(d).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, day), 'auto'), 's3'), 'aws4_request');
  const sig = createHmac('sha256', key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${h(canonical)}`).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${ACCESS}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
}

test('static: only crypto + core + gate imports; no global fetch, env, clock, fs, spawn or logging', () => {
  const source = readFileSync(new URL('./r2-s3.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/ .*$/gm, '');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./core.mjs', './real-data-gate.mjs', 'node:crypto']);
  for (const bad of [/[^.\w]fetch\(/, /globalThis/, /process\./, /Date\.now/, /new Date\(/, /require\(/, /import\(/, /console\./, /Math\.random/, /eval\(/, /setInterval/, /DELETE|HEAD|LIST/, /endpoint\s*[:=]/i, /proxy/i]) assert.doesNotMatch(source, bad);
});

test('signV4 matches AWS published S3 SigV4 vectors (GET object, PUT object)', () => {
  const secretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', accessKeyId = 'AKIAIOSFODNN7EXAMPLE';
  const base = { amzDate: '20130524T000000Z', region: 'us-east-1', service: 's3', accessKeyId, secretAccessKey };
  const get = signV4({ ...base, method: 'GET', canonicalUri: '/test.txt', payloadSha256: EMPTY, headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' } });
  assert.equal(get.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(get.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
  const payload = h('Welcome to Amazon S3.');
  assert.equal(payload, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  const put = signV4({ ...base, method: 'PUT', canonicalUri: '/test%24file.text', payloadSha256: payload, headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': payload, 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' } });
  assert.equal(put.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  assert.ok(put.authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;`));
  assert.ok(!put.authorization.includes(secretAccessKey));
});

test('happy path: one conditional PUT + one signed GET, exact headers, bytes verified, safe output', async () => {
  const bytes = PDF();
  const s = stub(ok(200), body(PDF()));
  const adapter = make(s.fetchImpl);
  assert.ok(Object.isFrozen(adapter));
  assert.deepEqual(Object.keys(adapter).sort(), ['summary', 'transfer']);
  const pending = adapter.transfer(args({ bytes }));
  bytes.fill(0); // caller mutation after the call cannot change hashed/sent bytes
  const out = await pending;
  assert.equal(out.outcome, 'OBJECT_VERIFIED_SYNTHETIC');
  assert.equal(out.objectVerifiedSynthetic, true);
  assert.deepEqual([out.putStatus, out.getStatus, out.fetchCount, out.bytesSent, out.bytesObserved], [200, 200, 2, PDF().length, PDF().length]);
  assert.deepEqual([out.sizeMatches, out.sha256Matches, out.mimeMatches, out.requiresReadBack], [true, true, true, false]);
  assertFlags(out);
  assertNoSecrets(out);
  const [put, get] = s.calls;
  for (const call of [put, get]) {
    assert.equal(call.url, URL_);
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.equal(call.init.headers['x-amz-date'], '20261018T003000Z');
    assert.ok(!('host' in call.init.headers));
    assert.ok(!JSON.stringify(call.init.headers).includes(SECRET));
  }
  assert.equal(put.init.method, 'PUT');
  assert.deepEqual(Object.keys(put.init.headers).sort(), ['authorization', 'content-type', 'if-none-match', 'x-amz-content-sha256', 'x-amz-date']);
  assert.equal(put.init.headers['if-none-match'], '*');
  assert.equal(put.init.headers['content-type'], 'application/pdf');
  assert.equal(put.init.headers['x-amz-content-sha256'], h(PDF()));
  assert.deepEqual(Buffer.from(put.init.body), Buffer.from(PDF()));
  assert.equal(put.init.headers.authorization, referenceAuth(put, h(PDF())));
  assert.match(put.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=SYNTHACCESSKEYID0001\/20261018\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(get.init.method, 'GET');
  assert.equal(get.init.body, undefined);
  assert.deepEqual(Object.keys(get.init.headers).sort(), ['authorization', 'x-amz-content-sha256', 'x-amz-date']);
  assert.equal(get.init.headers['x-amz-content-sha256'], EMPTY);
  assert.equal(get.init.headers.authorization, referenceAuth(get, EMPTY));
  const summary = adapter.summary();
  assertFlags(summary);
  assertNoSecrets(summary);
  assert.deepEqual([summary.used, summary.inFlight, summary.fetchCount, summary.lastOutcome], [true, false, 2, 'OBJECT_VERIFIED_SYNTHETIC']);
  assert.ok(!inspect(adapter, { depth: 5, showHidden: true }).includes(SECRET));
  assert.equal(await codeOf(adapter.transfer(args())), 'HALTED');
  assert.equal(s.calls.length, 2);
});

test('PNG with chunked read-back and content-type parameters verifies', async () => {
  const png = PNG();
  const r = streamed([png.slice(0, 5), png.slice(5)], { type: 'image/png; charset=binary' });
  const s = stub(ok(201), r.handler);
  const out = await make(s.fetchImpl).transfer(args({ key: `migration/${SNAP}/objects/${OPAQUE}.png`, bytes: png, mimeType: 'image/png', sha256: h(png) }));
  assert.equal(out.outcome, 'OBJECT_VERIFIED_SYNTHETIC');
  assert.equal(out.putStatus, 201);
});

test('construction guards: synthetic profile, denylist, fetchImpl, credentials, timeout, strict keys', async () => {
  const s = stub();
  const base = { descriptor: descriptor(), accessKeyId: ACCESS, secretAccessKey: SECRET, fetchImpl: s.fetchImpl, now: NOW };
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, descriptor: descriptor({ profile: 'real-data' }) })), 'PROFILE_DENIED');
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, descriptor: descriptor({ bucket: 'sikap-files' }) })), 'DESCRIPTOR_INVALID');
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, descriptor: descriptor({ accountId: 'a'.repeat(32) }) })), 'DESCRIPTOR_INVALID');
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, now: EXPIRES })), 'DESCRIPTOR_EXPIRED');
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, fetchImpl: undefined })), 'FETCH_REQUIRED');
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, secretAccessKey: 'short' })), 'CREDENTIALS_INVALID');
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, accessKeyId: 'bad key with spaces!' })), 'CREDENTIALS_INVALID');
  for (const timeoutMs of [0, 60_001, 1.5, '20']) assert.equal(await codeOf(() => createR2S3Adapter({ ...base, timeoutMs })), 'TIMEOUT_INVALID');
  assert.equal(await codeOf(() => createR2S3Adapter({ ...base, endpoint: 'https://evil.example' })), 'INPUT_INVALID');
  const getter = { ...base };
  Object.defineProperty(getter, 'fetchImpl', { get: () => s.fetchImpl, enumerable: true });
  assert.equal(await codeOf(() => createR2S3Adapter(getter)), 'INPUT_INVALID');
  assert.equal(s.calls.length, 0);
});

test('invalid transfer args fail with ZERO fetch (hash, date, key, mime, size, shape)', async () => {
  const big = new Uint8Array(MAX_OBJECT_BYTES + 1); big.set(PDF());
  const cases = [
    [args({ sha256: h('other') }), 'SHA256_MISMATCH'],
    [args({ sha256: h(PDF()).toUpperCase() }), 'SHA256_INVALID'],
    [args({ now: EXPIRES }), 'DESCRIPTOR_EXPIRED'],
    [args({ now: '2026-10-17T23:59:59.000Z' }), 'NOW_INVALID'],
    [args({ now: '2026-10-18T00:30:00Z' }), 'NOW_INVALID'],
    // WEBP is now an allowed MIME (canonical contract); a webp MIME on a .pdf key is a key/MIME mismatch.
    [args({ mimeType: 'image/webp' }), 'KEY_INVALID'],
    [args({ mimeType: 'image/gif' }), 'MIME_INVALID'],
    [args({ mimeType: 'image/png' }), 'KEY_INVALID'],
    [args({ bytes: PNG(), sha256: h(PNG()) }), 'MIME_INVALID'],
    [args({ bytes: new Uint8Array(0), sha256: EMPTY }), 'BYTES_INVALID'],
    [args({ bytes: big, sha256: h(big) }), 'BYTES_INVALID'],
    [args({ bytes: Buffer.from(PDF()).toString('latin1') }), 'BYTES_INVALID'],
    [args({ bytes: new Proxy(PDF(), {}), sha256: h(PDF()) }), 'BYTES_INVALID'],
    [args({ bytes: new DataView(PDF().buffer), sha256: h(PDF()) }), 'BYTES_INVALID'],
    [args({ bytes: new (class extends Uint8Array { get byteLength() { return 5; } })(big.length).fill(0x25), sha256: h(PDF()) }), 'BYTES_INVALID'],
    [{ ...args(), extra: 1 }, 'INPUT_INVALID'],
    [{ key: KEY }, 'INPUT_INVALID'],
  ];
  const badKeys = [
    `migration/${h('x').slice(0, 8)}-3e2f-4a1b-9c8d-7e6f5a4b3c2d/objects/${OPAQUE}.pdf`, `migration/${SNAP}/objects/../${OPAQUE}.pdf`,
    `migration/${SNAP}/objects/${OPAQUE}.pdf?x=1`, `migration/${SNAP}/objects/${OPAQUE}.pdf#f`, `migration/${SNAP}\\objects\\${OPAQUE}.pdf`,
    `migration/${SNAP}/objects/${OPAQUE}%2e.pdf`, `migration/${SNAP}/objects/${OPAQUE.toUpperCase()}.pdf`, `migration/${SNAP}/objects/${OPAQUE}.PDF`,
    `migration/${SNAP}/files/${OPAQUE}.pdf`, `migration/${SNAP}/objects/Nama Pegawai.pdf`, `migration/${SNAP}//objects/${OPAQUE}.pdf`,
    `/migration/${SNAP}/objects/${OPAQUE}.pdf`, `migration/${SNAP}/objects/${OPAQUE.slice(1)}.pdf`, `migration/${SNAP}/objects/${OPAQUE}.pdf.exe`,
  ];
  for (const key of badKeys) cases.push([args({ key }), 'KEY_INVALID']);
  for (const [input, code] of cases) {
    const s = stub();
    const adapter = make(s.fetchImpl);
    assert.equal(await codeOf(adapter.transfer(input)), code, code);
    assert.equal(s.calls.length, 0);
    assert.equal(adapter.summary().used, true); // a rejected input consumes the instance
    assert.equal(await codeOf(adapter.transfer(args())), 'HALTED');
    assert.equal(s.calls.length, 0);
  }
});

// Transform-canonical keys: migration/<snap>/(document|photo)/<fileId>-<sha>.<ext>.
const FILE_ID = '1AbC_dEf-GhIjKlMnOp';
const WEBP = (pad = 6) => {
  const out = new Uint8Array(12 + pad);
  out.set([0x52, 0x49, 0x46, 0x46]); new DataView(out.buffer).setUint32(4, out.length - 8, true); out.set([0x57, 0x45, 0x42, 0x50], 8);
  for (let i = 12; i < out.length; i++) out[i] = i;
  return out;
};
const canonicalKey = (kind, bytes, ext, id = FILE_ID) => `migration/${SNAP}/${kind}/${id}-${h(bytes)}.${ext}`;
const cArgs = (kind, bytes, mimeType, ext, over = {}) => ({ key: canonicalKey(kind, bytes, ext), bytes, mimeType, sha256: h(bytes), now: LATER, ...over });

test('canonical document/photo WEBP keys: one signed conditional PUT + signed GET, body matched', async () => {
  for (const kind of ['document', 'photo']) {
    const bytes = WEBP();
    const key = canonicalKey(kind, bytes, 'webp');
    const s = stub(ok(200), body(WEBP(), 'image/webp'));
    const out = await make(s.fetchImpl).transfer(cArgs(kind, bytes, 'image/webp', 'webp'));
    assert.equal(out.outcome, 'OBJECT_VERIFIED_SYNTHETIC', kind);
    assert.deepEqual([out.fetchCount, out.sizeMatches, out.sha256Matches, out.mimeMatches], [2, true, true, true]);
    assertFlags(out);
    assertNoSecrets(out);
    const [put, get] = s.calls;
    const url = `https://${UAT_ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/${key}`;
    assert.deepEqual([put.url, get.url, put.init.method, get.init.method], [url, url, 'PUT', 'GET']);
    assert.equal(new URL(put.url).pathname, `/${BUCKET}/${key}`); // already canonical, no re-encoding
    assert.deepEqual([put.init.headers['if-none-match'], put.init.headers['content-type']], ['*', 'image/webp']);
    assert.deepEqual(Buffer.from(put.init.body), Buffer.from(WEBP()));
    assert.equal(put.init.headers.authorization, referenceAuth(put, h(WEBP())));
    assert.equal(get.init.headers.authorization, referenceAuth(get, EMPTY));
  }
  const png = PNG();
  const s = stub(ok(201), body(PNG(), 'image/png'));
  assert.equal((await make(s.fetchImpl).transfer(cArgs('photo', png, 'image/png', 'png'))).outcome, 'OBJECT_VERIFIED_SYNTHETIC');
  const pdf = PDF();
  const s2 = stub(ok(200), body(PDF()));
  assert.equal((await make(s2.fetchImpl).transfer(cArgs('document', pdf, 'application/pdf', 'pdf'))).outcome, 'OBJECT_VERIFIED_SYNTHETIC');
  const legacyWebp = WEBP();
  const s3 = stub(ok(200), body(WEBP(), 'image/webp'));
  const legacy = await make(s3.fetchImpl).transfer(args({ key: `migration/${SNAP}/objects/${OPAQUE}.webp`, bytes: legacyWebp, mimeType: 'image/webp', sha256: h(legacyWebp) }));
  assert.equal(legacy.outcome, 'OBJECT_VERIFIED_SYNTHETIC');
});

test('canonical key contract violations fail with ZERO fetch (hash name, photo PDF, RIFF, kind, id, traversal)', async () => {
  const webp = WEBP(), pdf = PDF(), jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
  const badRiffSize = WEBP(); badRiffSize[4] ^= 1;
  const badMagic = WEBP(); badMagic[11] = 0x51;
  const shortRiff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 3, 0, 0, 0, 0x57, 0x45, 0x42]);
  const cases = [
    [cArgs('document', webp, 'image/webp', 'webp', { key: canonicalKey('document', pdf, 'webp') }), 'KEY_INVALID'], // filename sha != declared
    [cArgs('document', webp, 'image/webp', 'webp', { sha256: h(pdf) }), 'KEY_INVALID'],
    [cArgs('document', webp, 'image/webp', 'webp', { key: canonicalKey('document', pdf, 'webp'), sha256: h(pdf) }), 'SHA256_MISMATCH'], // name+declared agree, bytes differ
    [cArgs('photo', pdf, 'application/pdf', 'pdf'), 'KEY_INVALID'], // photo is never PDF
    [cArgs('document', badRiffSize, 'image/webp', 'webp'), 'MIME_INVALID'],
    [cArgs('photo', badMagic, 'image/webp', 'webp'), 'MIME_INVALID'],
    [cArgs('photo', shortRiff, 'image/webp', 'webp'), 'MIME_INVALID'],
    [cArgs('document', pdf, 'image/webp', 'webp'), 'MIME_INVALID'],
    [cArgs('document', webp, 'image/png', 'webp'), 'KEY_INVALID'],
    [cArgs('photo', jpg, 'image/jpeg', 'jpeg'), 'KEY_INVALID'], // canonical ext is MIME_EXT (jpg) only
  ];
  const k = (tail) => `migration/${SNAP}/${tail}`, sha = h(webp);
  const badKeys = [
    k(`files/${FILE_ID}-${sha}.webp`), k(`Document/${FILE_ID}-${sha}.webp`), k(`document/short-${sha}.webp`),
    k(`document/${'a'.repeat(201)}-${sha}.webp`), k(`document/${FILE_ID}.x-${sha}.webp`), k(`document/${FILE_ID}%2F-${sha}.webp`),
    k(`document/../${FILE_ID}-${sha}.webp`), k(`document/${FILE_ID}/x-${sha}.webp`), k(`document\\${FILE_ID}-${sha}.webp`),
    k(`document/${FILE_ID}-${sha}.webp?x=1`), k(`document/${FILE_ID}-${sha.toUpperCase()}.webp`), k(`document/${FILE_ID}-${sha}.WEBP`),
    k(`document/${FILE_ID}-${sha.slice(1)}.webp`), k(`document/${FILE_ID}-${sha}.webp.exe`), k(`document/Ä${FILE_ID}-${sha}.webp`),
    k(`document//${FILE_ID}-${sha}.webp`), k(`document/${FILE_ID} -${sha}.webp`), `migration/${SNAP.replace('7a', '8a')}/document/${FILE_ID}-${sha}.webp`,
  ];
  for (const key of badKeys) cases.push([cArgs('document', webp, 'image/webp', 'webp', { key }), 'KEY_INVALID']);
  for (const [input, code] of cases) {
    const s = stub();
    assert.equal(await codeOf(make(s.fetchImpl).transfer(input)), code, `${code} ${input.key}`);
    assert.equal(s.calls.length, 0);
  }
  // Boundary: 10- and 200-char fileIds are accepted.
  for (const id of ['a'.repeat(10), 'Z'.repeat(200)]) {
    const s = stub(ok(200), body(WEBP(), 'image/webp'));
    const out = await make(s.fetchImpl).transfer(cArgs('photo', webp, 'image/webp', 'webp', { key: canonicalKey('photo', webp, 'webp', id) }));
    assert.equal(out.outcome, 'OBJECT_VERIFIED_SYNTHETIC', String(id.length));
  }
});

test('concurrent transfer: second call HALTED synchronously before any await; one PUT only', async () => {
  let release;
  const s = stub(() => new Promise((resolve) => { release = resolve; }), body(PDF()));
  const adapter = make(s.fetchImpl, { timeoutMs: 1000 });
  const first = adapter.transfer(args());
  const second = adapter.transfer(args());
  assert.equal(await codeOf(second), 'HALTED');
  assert.equal(adapter.summary().inFlight, true);
  assert.equal(s.calls.length, 1);
  release(new Response(null, { status: 200 }));
  assert.equal((await first).outcome, 'OBJECT_VERIFIED_SYNTHETIC');
  assert.equal(s.calls.length, 2);
});

test('412 precondition: CONFLICT, no GET, no overwrite, no retry', async () => {
  const s = stub(ok(412));
  const out = await make(s.fetchImpl).transfer(args());
  assert.deepEqual([out.outcome, out.reason, out.getSent, out.fetchCount, out.requiresReadBack], ['CONFLICT', 'PRECONDITION_FAILED', false, 1, false]);
  assertFlags(out);
});

test('PUT ambiguity (429/5xx/other/network/redirect/foreign URL) halts without GET or retry', async () => {
  const redirected = () => { const r = new Response(null, { status: 200 }); Object.defineProperty(r, 'redirected', { value: true }); return Promise.resolve(r); };
  const foreign = () => { const r = new Response(null, { status: 200 }); Object.defineProperty(r, 'url', { value: 'https://evil.example/x' }); return Promise.resolve(r); };
  const cases = [
    [ok(429), 'PUT_STATUS'], [ok(500), 'PUT_STATUS'], [ok(503), 'PUT_STATUS'], [ok(204), 'PUT_STATUS'], [ok(403), 'PUT_STATUS'],
    [() => Promise.reject(new TypeError('fetch failed: redirect')), 'PUT_NETWORK_ERROR'], [() => { throw new Error(SECRET); }, 'PUT_NETWORK_ERROR'],
    [redirected, 'PUT_RESPONSE_UNTRUSTED'], [foreign, 'PUT_RESPONSE_UNTRUSTED'], [ok(302), 'PUT_RESPONSE_UNTRUSTED'],
  ];
  for (const [handler, reason] of cases) {
    const s = stub(handler);
    const out = await make(s.fetchImpl).transfer(args());
    assert.deepEqual([out.outcome, out.reason, out.requiresReadBack, out.getSent, s.calls.length], ['HALT_AMBIGUOUS', reason, true, false, 1], reason);
    assertFlags(out);
    assertNoSecrets(out);
  }
});

test('PUT timeout: bounded even if the stub ignores abort; abort listener fires; no GET', async () => {
  for (const honours of [false, true]) {
    let aborted = false;
    const s = stub((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; if (honours) reject(new DOMException('aborted', 'AbortError')); });
    }));
    const started = performance.now();
    const out = await make(s.fetchImpl).transfer(args());
    assert.ok(performance.now() - started < 1000);
    assert.deepEqual([out.outcome, out.reason, out.requiresReadBack, s.calls.length, aborted], ['HALT_AMBIGUOUS', 'PUT_TIMEOUT', true, 1, true]);
  }
});

test('late PUT response after timeout is cancelled and ignored', async () => {
  let resolveLate;
  const r = streamed([new Uint8Array([1])], { stall: true });
  const s = stub(() => new Promise((resolve) => { resolveLate = resolve; }));
  const out = await make(s.fetchImpl).transfer(args());
  assert.equal(out.reason, 'PUT_TIMEOUT');
  resolveLate(await r.handler());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.state.cancelled, true);
  assert.equal(s.calls.length, 1);
});

test('read-back mismatches: wrong bytes/MIME/size/oversize -> INTEGRITY_MISMATCH; stream faults -> HALT_AMBIGUOUS', async () => {
  const wrong = PDF(); wrong[wrong.length - 2] ^= 1;
  const longer = new Uint8Array([...PDF(), 0x0a]);
  const shorter = PDF().slice(0, -1);
  const integrity = [
    [body(wrong), 'READBACK_MISMATCH', { sizeMatches: true, sha256Matches: false, mimeMatches: true }],
    [body(PDF(), 'text/html'), 'READBACK_MISMATCH', { sizeMatches: true, sha256Matches: true, mimeMatches: false }],
    [body(PDF(), ''), 'READBACK_MISMATCH', { mimeMatches: false }],
    [body(shorter), 'READBACK_MISMATCH', { sizeMatches: false, sha256Matches: false }],
  ];
  for (const [handler, reason, expect] of integrity) {
    const s = stub(ok(200), handler);
    const out = await make(s.fetchImpl).transfer(args());
    assert.deepEqual([out.outcome, out.reason, s.calls.length, out.objectVerifiedSynthetic], ['INTEGRITY_MISMATCH', reason, 2, false]);
    for (const [key, value] of Object.entries(expect)) assert.equal(out[key], value, key);
    assertFlags(out);
  }
  const over = streamed([PDF(), new Uint8Array([0x0a]), new Uint8Array(1024)]);
  const s1 = stub(ok(200), over.handler);
  const o1 = await make(s1.fetchImpl).transfer(args());
  assert.deepEqual([o1.outcome, o1.reason, over.state.cancelled], ['INTEGRITY_MISMATCH', 'READBACK_OVERSIZE', true]);
  const s1b = stub(ok(200), body(longer));
  assert.equal((await make(s1b.fetchImpl).transfer(args())).reason, 'READBACK_OVERSIZE');
  const broken = streamed([PDF().slice(0, 4)], { error: true });
  const s2 = stub(ok(200), broken.handler);
  const o2 = await make(s2.fetchImpl).transfer(args());
  assert.deepEqual([o2.outcome, o2.reason, o2.requiresReadBack], ['HALT_AMBIGUOUS', 'GET_STREAM_ERROR', true]);
  for (const [handler, reason] of [[ok(404), 'GET_STATUS'], [ok(500), 'GET_STATUS'], [() => Promise.reject(new TypeError('x')), 'GET_NETWORK_ERROR']]) {
    const s = stub(ok(200), handler);
    const out = await make(s.fetchImpl).transfer(args());
    assert.deepEqual([out.outcome, out.reason, s.calls.length], ['HALT_AMBIGUOUS', reason, 2]);
  }
});

test('GET stalled body: timeout cancels the reader, no third request', async () => {
  const stall = streamed([PDF().slice(0, 3)], { stall: true });
  const s = stub(ok(200), stall.handler);
  const out = await make(s.fetchImpl).transfer(args());
  assert.deepEqual([out.outcome, out.reason, s.calls.length], ['HALT_AMBIGUOUS', 'GET_TIMEOUT', 2]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stall.state.cancelled, true);
});

test('late GET response after timeout is cancelled and ignored; no third request', async () => {
  let resolveLate;
  const late = streamed([PDF()], { stall: true });
  const s = stub(ok(200), () => new Promise((resolve) => { resolveLate = resolve; }));
  const out = await make(s.fetchImpl).transfer(args());
  assert.deepEqual([out.outcome, out.reason, out.getSent, s.calls.length], ['HALT_AMBIGUOUS', 'GET_TIMEOUT', true, 2]);
  resolveLate(await late.handler());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.state.cancelled, true);
  assert.equal(s.calls.length, 2);
});

test('hardening: fake byteLength / non-Uint8Array stream chunks and inherited arg keys are rejected', async () => {
  class Liar extends Uint8Array { get byteLength() { return 1; } }
  const fake = new Liar(PDF().length + 64).fill(0x25); // claims 1 byte, really oversize
  const r1 = streamed([fake], { stall: true }); // open stream: adapter must cancel it itself
  const o1 = await make(stub(ok(200), r1.handler).fetchImpl).transfer(args());
  assert.deepEqual([o1.outcome, o1.reason, r1.state.cancelled], ['INTEGRITY_MISMATCH', 'READBACK_OVERSIZE', true]);
  const r2 = streamed([new Uint16Array(4)], { stall: true });
  const o2 = await make(stub(ok(200), r2.handler).fetchImpl).transfer(args());
  assert.deepEqual([o2.outcome, o2.reason, r2.state.cancelled], ['HALT_AMBIGUOUS', 'GET_STREAM_ERROR', true]);
  const s = stub();
  const inherited = Object.assign(Object.create({ now: LATER }), { ...args() });
  delete inherited.now;
  assert.equal(await codeOf(make(s.fetchImpl).transfer(inherited)), 'INPUT_INVALID');
  const withSymbol = { ...args(), [Symbol('x')]: 1 };
  assert.equal(await codeOf(make(s.fetchImpl).transfer(withSymbol)), 'INPUT_INVALID');
  assert.equal(s.calls.length, 0);
});

// Pure public synthetic source transformed in memory. No private plan or production test helper.
function permitFixture({ claim = true } = {}) {
  const fixture = syntheticFixture();
  const plan = transformExport(fixture.snapshot, { pepper: 'synthetic-r2-permit-test-pepper', salt: Buffer.alloc(32, 0x71) });
  assert.equal(plan.ready, true);
  const planBytes = new Uint8Array(Buffer.from(JSON.stringify(plan)));
  const d = descriptor({
    ...UAT_TARGET, snapshotId: plan.snapshotId, sourceSha256: plan.sourceSha256, planSha256: h(planBytes),
    appSchemaSha256: UAT_APP_SCHEMA_SHA256, ledgerSchemaSha256: UAT_LEDGER_SCHEMA_SHA256,
    policySha256: UAT_POLICY_SHA256, retentionPolicySha256: UAT_RETENTION_POLICY_SHA256,
  });
  const permit = issueRealDataUatPermit({ descriptor: d, planBytes, now: NOW });
  if (claim) claimPermitForRun(permit, { now: NOW });
  const objects = getPermitManifest(permit).map((f) => ({
    key: f.r2Key, bytes: new Uint8Array(fixture.files.find((source) => source.fileId === f.fileId && source.kind === f.kind).bytes),
    mimeType: f.mimeType, sha256: f.sha256, now: LATER,
  }));
  return { d, permit, objects };
}
const assertUatFlags = (out) => {
  for (const key of ['ready', 'readyForImport', 'remoteAuthorized', 'transportProof', 'authorizesRetry', 'productionVerified', 'ownershipProven', 'deleteAttempted', 'authorizesExecution', 'syntheticOnly']) assert.equal(out[key], false, key);
  for (const key of ['proofRequired', 'localTestingOnly']) assert.equal(out[key], true, key);
  assert.ok(Object.isFrozen(out));
  assertNoSecrets(out);
};

test('permit guards: real-data missing/forged/unclaimed/spent and synthetic+permit reject with ZERO fetch', async () => {
  const { d, permit } = permitFixture();
  const s = stub();
  assert.equal(await codeOf(() => make(s.fetchImpl, { descriptor: d })), 'PROFILE_DENIED');
  for (const invalid of [undefined, null, {}, Object.freeze({ ...permit }), new Proxy(permit, {})]) {
    assert.equal(await codeOf(() => make(s.fetchImpl, { descriptor: d, permit: invalid })), 'PERMIT_INVALID');
  }
  const unclaimed = permitFixture({ claim: false });
  assert.equal(await codeOf(() => make(s.fetchImpl, { descriptor: unclaimed.d, permit: unclaimed.permit })), 'PERMIT_INVALID');
  finishPermitRun(permit);
  assert.equal(await codeOf(() => make(s.fetchImpl, { descriptor: d, permit })), 'PERMIT_INVALID');
  for (const value of [undefined, null, {}, permit]) {
    assert.equal(await codeOf(() => make(s.fetchImpl, { permit: value })), 'INPUT_INVALID');
  }
  assert.equal(s.calls.length, 0);
});

test('permit expiry, full descriptor binding and run finish at transfer entry reject with ZERO fetch', async () => {
  const { d, permit, objects } = permitFixture();
  const s = stub();
  assert.equal(await codeOf(() => make(s.fetchImpl, { descriptor: d, permit, now: EXPIRES })), 'DESCRIPTOR_EXPIRED');
  const changes = [
    { databaseId: descriptor().databaseId }, { databaseName: 'sikap-import-other' }, { bucket: 'sikap-import-other-files' },
    { snapshotId: SNAP }, { sourceSha256: h('foreign-source') }, { planSha256: h('foreign-plan') },
    { appSchemaSha256: h('foreign-app') }, { ledgerSchemaSha256: h('foreign-ledger') },
    { baselineSha256: h('foreign-baseline') }, { policySha256: h('foreign-policy') }, { retentionPolicySha256: h('foreign-retention') },
    { runNonce: 'a'.repeat(32) }, { ownerNonce: 'b'.repeat(32) }, { epoch: 1 }, { expiresAt: '2026-10-18T01:30:00.000Z' },
  ];
  for (const change of changes) {
    assert.equal(await codeOf(() => make(s.fetchImpl, { descriptor: { ...d, ...change }, permit })), 'PERMIT_INVALID', Object.keys(change)[0]);
  }
  const expired = make(s.fetchImpl, { descriptor: d, permit });
  assert.equal(await codeOf(expired.transfer({ ...objects[0], now: EXPIRES })), 'DESCRIPTOR_EXPIRED');
  const ended = make(s.fetchImpl, { descriptor: d, permit });
  finishPermitRun(permit);
  assert.equal(await codeOf(ended.transfer(objects[0])), 'PERMIT_INVALID');
  assert.equal(s.calls.length, 0);
});

test('issued claimed permit: exact immutable manifest uses signed conditional PUT + GET and UAT-only success', async () => {
  const { d, permit, objects } = permitFixture();
  assert.equal(R2_ADAPTER_VERSION, 2);
  assert.ok(Object.isFrozen(R2_OUTCOMES) && R2_OUTCOMES.includes('OBJECT_VERIFIED_UAT'));
  assert.ok(Object.isFrozen(R2_ERROR_CODES) && R2_ERROR_CODES.includes('PERMIT_INVALID'));
  assert.ok(Object.isFrozen(getPermitManifest(permit)));
  let fetches = 0;
  for (const object of objects) {
    const entry = getPermitFile(permit, object.key);
    assert.ok(Object.isFrozen(entry));
    const expectedBytes = new Uint8Array(object.bytes);
    const s = stub(ok(201), body(expectedBytes, object.mimeType));
    const adapter = make(s.fetchImpl, { descriptor: d, permit, now: LATER });
    const pending = adapter.transfer(object);
    object.bytes.fill(0); // private copy must be what gets hashed and sent
    const out = await pending;
    assert.deepEqual([out.outcome, out.reason, out.objectVerifiedSynthetic, out.objectVerifiedUat], ['OBJECT_VERIFIED_UAT', 'READBACK_MATCHED', false, true]);
    assert.deepEqual([out.fetchCount, out.bytesSent, out.bytesObserved, out.putStatus, out.getStatus], [2, entry.sizeBytes, entry.sizeBytes, 201, 200]);
    assert.deepEqual([out.sizeMatches, out.sha256Matches, out.mimeMatches, out.requiresReadBack, out.operatorDecisionRequired], [true, true, true, false, false]);
    assertUatFlags(out);
    const [put, get] = s.calls;
    assert.deepEqual(s.calls.map((call) => call.init.method), ['PUT', 'GET']);
    const url = `https://${UAT_TARGET.accountId}.r2.cloudflarestorage.com/${UAT_TARGET.bucket}/${entry.r2Key}`;
    assert.equal(put.url, url);
    assert.equal(get.url, url);
    assert.deepEqual([put.init.headers['if-none-match'], put.init.headers['content-type']], ['*', entry.mimeType]);
    assert.deepEqual(Buffer.from(put.init.body), Buffer.from(expectedBytes));
    assert.equal(put.init.headers.authorization, referenceAuth(put, entry.sha256));
    assert.equal(get.init.headers.authorization, referenceAuth(get, EMPTY));
    assert.equal(put.init.headers['x-amz-date'], get.init.headers['x-amz-date']);
    const summary = adapter.summary();
    assert.equal(summary.profile, 'real-data');
    assert.equal(summary.lastOutcome, 'OBJECT_VERIFIED_UAT');
    assertUatFlags(summary);
    const text = JSON.stringify(out) + JSON.stringify(summary) + inspect(adapter, { depth: 5, showHidden: true });
    for (const forbidden of [entry.fileId, entry.r2Key, entry.sha256, d.planSha256, SECRET, ACCESS]) assert.ok(!text.includes(forbidden));
    fetches += s.calls.length;
  }
  assert.equal(objects.length, 3);
  assert.equal(fetches, 6);
  finishPermitRun(permit);
});

test('permit manifest: foreign/legacy keys, hash/MIME/actual size/bytes mismatches reject with ZERO fetch', async () => {
  const { d, permit, objects } = permitFixture();
  const object = objects.find((o) => o.mimeType === 'application/pdf');
  const differentBytes = new Uint8Array(object.bytes); differentBytes[differentBytes.length - 1] ^= 1;
  const cases = [
    [{ ...object, key: object.key.replace('synthetic_doc_000001', 'foreign_doc_000001') }, 'PERMIT_INVALID'],
    [{ ...object, key: `migration/${d.snapshotId}/objects/${object.sha256}.pdf` }, 'KEY_INVALID'],
    [{ ...object, sha256: h('not-in-manifest') }, 'PERMIT_INVALID'],
    [{ ...object, mimeType: 'image/png' }, 'KEY_INVALID'],
    [{ ...object, bytes: new Uint8Array([...object.bytes, 0]) }, 'PERMIT_INVALID'],
    [{ ...object, bytes: differentBytes }, 'SHA256_MISMATCH'],
  ];
  for (const [input, expected] of cases) {
    const s = stub();
    assert.equal(await codeOf(make(s.fetchImpl, { descriptor: d, permit, now: LATER }).transfer(input)), expected);
    assert.equal(s.calls.length, 0);
  }
  finishPermitRun(permit);
});

test('permit finished during PUT blocks GET; preserves sent-write ambiguity and never retries', async () => {
  const { d, permit, objects } = permitFixture();
  const s = stub(() => { finishPermitRun(permit); return Promise.resolve(new Response(null, { status: 200 })); });
  const out = await make(s.fetchImpl, { descriptor: d, permit }).transfer(objects[0]);
  assert.deepEqual([out.outcome, out.reason, out.putSent, out.getSent, out.fetchCount, out.requiresReadBack], ['HALT_AMBIGUOUS', 'INTERNAL_AFTER_SEND', true, false, 1, true]);
  assert.deepEqual(s.calls.map((call) => call.init.method), ['PUT']);
  assertUatFlags(out);
});
