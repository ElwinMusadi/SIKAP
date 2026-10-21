// R2 S3 single-object adapter: synthetic probe or permit-bound UAT. One conditional PUT + one GET.
//
// Scope and limits (read before using any output):
//   * Profile guard: descriptor must pass core validateDescriptor (static denylist, allowed account,
//     sikap-import-* bucket, expiry). Real-data requires an active claimed real-data-gate permit,
//     pinned to the isolated UAT target and exact immutable manifest entry. Synthetic rejects permits.
//     It is NOT a plan-row importer. Accepted keys (matched exactly, never normalized/rewritten):
//       Legacy keys below are synthetic-only; real-data accepts only canonical manifest keys.
//       - legacy probe keys `migration/<snapshotId>/objects/<64hex>.(pdf|jpg|jpeg|png|webp)`;
//       - transform-canonical keys `migration/<snapshotId>/(document|photo)/<fileId>-<64hex>.(pdf|jpg|png|webp)`
//         (fileId = migrate/normalize DRIVE_ID, ext = MIME_EXT[mime], 64hex must equal the declared
//         sha256 and the bytes, photo never PDF). Kind is derived from the key only; R2 cannot know
//         the row kind, so the only kind rule enforced here is "photo is not PDF".
//     Key characters are all SigV4-unreserved, so the canonical URI equals the per-segment encoding.
//   * No defaults for I/O: fetchImpl is REQUIRED (no global fetch), `now` is an explicit ISO string
//     (no clock), credentials are explicit args (no env). No SDK, no dependencies (node:crypto SigV4).
//   * Endpoint is fixed: https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>, region auto,
//     service s3, path-style. No endpoint override, proxy or redirect (redirect:'error'; any
//     redirected/foreign response URL is untrusted).
//   * Credentials live in this closure only; never returned, serialized or put in error text.
//     Errors are closed codes (message === code). Results carry counts, statuses and booleans only.
//   * Each instance sends at most ONE transfer (locked synchronously before any await). Never
//     retries, never DELETE/HEAD/LIST/create-bucket. PUT uses If-None-Match:* (R2 evaluates it
//     atomically; 412 => CONFLICT, no overwrite, no GET). GET runs ONLY after PUT 200/201.
//     Any other PUT outcome (timeout, network, 429, 5xx, other) is HALT_AMBIGUOUS with
//     requiresReadBack:true: the write may or may not exist; a later read-back is a caller decision.
//   * Integrity is checked locally: SHA-256 of the exact bytes (x-amz-content-sha256 signed payload
//     hash), then read-back size + SHA-256 + MIME base. R2 checksum/ETag semantics are not relied on.
//     A verified read-back proves the bytes at the key, not ownership (ownershipProven:false).
//   * Every output: ready/readyForImport/remoteAuthorized/transportProof/authorizesRetry/
//     productionVerified false, proofRequired/localTestingOnly true. Tested only with stubs.
//   * LIMITATION: real R2 rejects clock skew (~15 min) so `now` must be the true current time;
//     PUT and GET revalidate the permit and are signed with the SAME supplied `now`. This does not
//     prove wall-clock freshness after an await; the parent runner checks its clock independently.
//     Token rotation/expiry is external. Not production-proven.
import { createHash, createHmac } from 'node:crypto';
import { SAFETY, ImportCoreError, validateDescriptor } from './core.mjs';
import { validatePermitRequest, getPermitFile } from './real-data-gate.mjs';

export const R2_ADAPTER_VERSION = 2;
export const MAX_OBJECT_BYTES = 5 * 1024 * 1024;
export const MAX_TIMEOUT_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const R2_REGION = 'auto';
export const R2_SERVICE = 's3';
export const R2_OUTCOMES = Object.freeze(['OBJECT_VERIFIED_SYNTHETIC', 'OBJECT_VERIFIED_UAT', 'CONFLICT', 'HALT_AMBIGUOUS', 'INTEGRITY_MISMATCH']);
export const R2_ERROR_CODES = Object.freeze([
  'INPUT_INVALID', 'NOW_INVALID', 'DESCRIPTOR_INVALID', 'DESCRIPTOR_EXPIRED', 'PROFILE_DENIED', 'PERMIT_INVALID', 'CREDENTIALS_INVALID',
  'FETCH_REQUIRED', 'TIMEOUT_INVALID', 'KEY_INVALID', 'BYTES_INVALID', 'MIME_INVALID', 'SHA256_INVALID',
  'SHA256_MISMATCH', 'HALTED', 'INTERNAL',
]);
const FLAGS = Object.freeze({
  ...SAFETY, ready: false, proofRequired: true, remoteAuthorized: false, transportProof: false, localTestingOnly: true,
  authorizesRetry: false, productionVerified: false, ownershipProven: false, deleteAttempted: false, syntheticOnly: true,
});
// Allowed object types (existing archive contract, server/lib/file-sniff.ts): magic bytes per MIME.
const MAGIC = Object.freeze({
  'application/pdf': [0x25, 0x50, 0x44, 0x46, 0x2d],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
});
// Same rule as apply-local magic(): 'RIFF' + LE uint32 (length - 8) + 'WEBP'.
const isWebp = (b) => b.byteLength >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 && ((b[4] | (b[5] << 8) | (b[6] << 16)) + b[7] * 0x1000000) + 8 === b.byteLength;
const ALLOWED_MIME = new Set([...Object.keys(MAGIC), 'image/webp']);
const magicOk = (bytes, mime) => (mime === 'image/webp' ? isWebp(bytes) : MAGIC[mime].every((byte, i) => bytes[i] === byte));
const LEGACY_EXT_MIME = Object.freeze({ pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
// Inverse of migrate/normalize MIME_EXT (one extension per MIME); static copy keeps this module dependency-free.
const CANONICAL_EXT_MIME = Object.freeze({ pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
const LEGACY_TAIL = /^objects\/[0-9a-f]{64}\.(pdf|jpg|jpeg|png|webp)$/;
// fileId class/bounds === migrate/normalize DRIVE_ID (/^[A-Za-z0-9_-]{10,200}$/).
const CANONICAL_TAIL = /^(document|photo)\/([A-Za-z0-9_-]{10,200})-([0-9a-f]{64})\.(pdf|jpg|png|webp)$/;
const MAX_KEY_CHARS = 512;
const SHA = /^[0-9a-f]{64}$/;
const ACCESS_KEY = /^[A-Za-z0-9]{16,128}$/;
const SECRET_KEY = /^[\x21-\x7e]{16,128}$/;
const PATH = /^\/[a-z0-9-]+\/[A-Za-z0-9/._-]+$/;
// Pure exact key-tail classification. null = not an accepted key. sha256 null = legacy (opaque name).
function parseKeyTail(tail) {
  const legacy = LEGACY_TAIL.exec(tail);
  if (legacy !== null) return { kind: 'legacy', sha256: null, mimeType: LEGACY_EXT_MIME[legacy[1]] };
  const c = CANONICAL_TAIL.exec(tail);
  if (c === null) return null;
  const mimeType = CANONICAL_EXT_MIME[c[4]];
  if (c[1] === 'photo' && mimeType === 'application/pdf') return null;
  return { kind: c[1], sha256: c[3], mimeType };
}
const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const EMPTY_SHA256 = sha256Hex(new Uint8Array(0));
const TIMEOUT = Symbol('timeout');
const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TA_TAG = Reflect.getOwnPropertyDescriptor(TA_PROTO, Symbol.toStringTag).get;
const TA_BYTE_LENGTH = Reflect.getOwnPropertyDescriptor(TA_PROTO, 'byteLength').get;
const TA_SET = TA_PROTO.set;

const CODE_SET = new Set(R2_ERROR_CODES);
const OWN_ERRORS = new WeakSet();
// Closed-code error: message === code; never carries input values, credentials or response data.
export class R2AdapterError extends Error {
  constructor(code) {
    const safe = typeof code === 'string' && CODE_SET.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'R2AdapterError';
    this.code = safe;
    OWN_ERRORS.add(this);
  }
}
const fail = (code) => { throw new R2AdapterError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
function toSafe(error) {
  if (OWN_ERRORS.has(error)) return error;
  try {
    if (error instanceof ImportCoreError) {
      const code = error.code;
      if (code === 'NOW_INVALID' || code === 'DESCRIPTOR_EXPIRED') return new R2AdapterError(code);
      if (typeof code === 'string' && code.startsWith('DESCRIPTOR_')) return new R2AdapterError('DESCRIPTOR_INVALID');
    }
  } catch { /* fall through */ }
  return new R2AdapterError('INTERNAL');
}
const guarded = (fn) => (...args) => { try { return fn(...args); } catch (error) { throw toSafe(error); } };
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
// Snapshot own enumerable DATA properties (no getters run, no symbols/inherited/extra keys).
function snapshot(value, required, optional, code) {
  try {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), code);
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, code);
    const allowed = new Set([...required, ...optional]);
    const out = {};
    for (const key of Reflect.ownKeys(value)) {
      check(typeof key === 'string' && allowed.has(key), code);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      check(descriptor !== undefined && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true, code);
      out[key] = descriptor.value;
    }
    check(required.every((key) => Object.hasOwn(out, key)), code);
    return out;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    throw new R2AdapterError(code);
  }
}

// AWS Signature Version 4 (header auth, single-chunk signed payload). Pure; exported for static
// published-vector tests. canonicalUri must already be URI-encoded; header names lowercase; no query.
export function signV4({ method, canonicalUri, headers, payloadSha256, amzDate, region, service, accessKeyId, secretAccessKey }) {
  const names = Object.keys(headers).sort();
  check(names.every((name) => name === name.toLowerCase()), 'INTERNAL');
  const canonicalHeaders = names.map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadSha256].join('\n');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  let key = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  for (const part of [region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signedHeaders, signature };
}
const toAmzDate = (iso) => `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;

// Bound one request (fetch + body handling) by a deadline. The race bounds stubs/clients that
// ignore abort; the late settlement is always handled (no unhandled rejection); timer always cleared.
function bounded(timeoutMs, run) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(TIMEOUT); }, timeoutMs);
  });
  const settled = run(controller.signal).then((value) => ({ ok: true, value }), () => ({ ok: false }));
  return Promise.race([settled, deadline]).finally(() => {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  });
}
function responseInfo(res, expectedUrl) {
  try {
    const status = res.status, url = res.url;
    const valid = Number.isSafeInteger(status) && status >= 100 && status <= 599;
    const trusted = valid && res.redirected !== true && (url === undefined || url === '' || url === expectedUrl) && !(status >= 300 && status < 400);
    return { status: valid ? status : null, trusted };
  } catch { return { status: null, trusted: false }; }
}
function quietCancel(target) {
  try {
    const pending = target?.cancel?.();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch { /* ignore */ }
}
// Read at most `limit` bytes; stop (and cancel) as soon as more arrive. Abort cancels the reader.
async function readBounded(res, limit, signal) {
  let body;
  try { body = res.body; } catch { return { error: true }; }
  if (body === null) return { bytes: new Uint8Array(0) };
  if (!body || typeof body.getReader !== 'function') return { error: true };
  if (signal.aborted) { quietCancel(body); return { error: true }; }
  let reader;
  try { reader = body.getReader(); } catch { return { error: true }; }
  const onAbort = () => quietCancel(reader);
  signal.addEventListener('abort', onAbort, { once: true });
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { error: true };
      if (done) break;
      let part; // intrinsic slots + private copy: a chunk cannot fake its length or mutate later
      try {
        check(TA_TAG.call(value) === 'Uint8Array', 'INTERNAL');
        total += TA_BYTE_LENGTH.call(value);
        if (total <= limit) { part = new Uint8Array(TA_BYTE_LENGTH.call(value)); TA_SET.call(part, value); }
      } catch { quietCancel(reader); return { error: true }; }
      if (total > limit) { quietCancel(reader); return { oversize: true }; }
      parts.push(part);
    }
  } catch { quietCancel(reader); return { error: true }; } finally {
    signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return { bytes };
}

export const createR2S3Adapter = guarded((raw) => {
  const input = snapshot(raw, ['descriptor', 'accessKeyId', 'secretAccessKey', 'fetchImpl', 'now'], ['timeoutMs', 'permit'], 'INPUT_INVALID');
  check(typeof input.fetchImpl === 'function', 'FETCH_REQUIRED');
  const { descriptor: d } = validateDescriptor(input.descriptor, input.now);
  const realData = d.profile === 'real-data';
  const flags = realData ? Object.freeze({ ...FLAGS, syntheticOnly: false }) : FLAGS;
  if (realData) check(Object.hasOwn(input, 'permit'), 'PROFILE_DENIED');
  else check(!Object.hasOwn(input, 'permit'), 'INPUT_INVALID');
  // Only the gate recognizes issued capabilities; never trust fields on the public permit object.
  const checkPermit = (now) => {
    if (!realData) return;
    try { validatePermitRequest(input.permit, d, now); } catch { fail('PERMIT_INVALID'); }
  };
  checkPermit(input.now);
  const { accessKeyId, secretAccessKey, fetchImpl } = input;
  check(typeof accessKeyId === 'string' && ACCESS_KEY.test(accessKeyId) && typeof secretAccessKey === 'string' &&
    SECRET_KEY.test(secretAccessKey) && accessKeyId !== secretAccessKey, 'CREDENTIALS_INVALID');
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS, 'TIMEOUT_INVALID');
  const createdMs = Date.parse(input.now);
  const host = `${d.accountId}.r2.cloudflarestorage.com`;
  const keyPrefix = `migration/${d.snapshotId}/`;
  let used = false, inFlight = false, fetchCount = 0, lastOutcome = null, lastReason = null;

  const readArgs = (rawArgs) => {
    const a = snapshot(rawArgs, ['key', 'bytes', 'mimeType', 'sha256', 'now'], [], 'INPUT_INVALID');
    validateDescriptor(d, a.now); // supplied-time expiry/target check (NOW_INVALID / DESCRIPTOR_EXPIRED)
    check(Date.parse(a.now) >= createdMs, 'NOW_INVALID');
    checkPermit(a.now);
    check(typeof a.mimeType === 'string' && ALLOWED_MIME.has(a.mimeType), 'MIME_INVALID');
    check(typeof a.key === 'string' && a.key.length <= MAX_KEY_CHARS && a.key.startsWith(keyPrefix), 'KEY_INVALID');
    const parsed = parseKeyTail(a.key.slice(keyPrefix.length));
    check(parsed !== null && parsed.mimeType === a.mimeType && (!realData || parsed.kind !== 'legacy'), 'KEY_INVALID');
    let entry = null;
    if (realData) {
      try { entry = getPermitFile(input.permit, a.key); } catch { fail('PERMIT_INVALID'); }
      check(entry !== null && Object.isFrozen(entry) && entry.r2Key === a.key && entry.sha256 === a.sha256 &&
        entry.mimeType === a.mimeType && Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes > 0 &&
        entry.sizeBytes <= MAX_OBJECT_BYTES, 'PERMIT_INVALID');
    }
    // Intrinsic typed-array slots only (no instanceof/byteLength getters: subclasses/Proxies cannot lie).
    let bytes; // private copy: hashed bytes === sent bytes
    try {
      check(TA_TAG.call(a.bytes) === 'Uint8Array', 'BYTES_INVALID');
      const length = TA_BYTE_LENGTH.call(a.bytes);
      check(length > 0 && length <= MAX_OBJECT_BYTES, 'BYTES_INVALID');
      bytes = new Uint8Array(length);
      TA_SET.call(bytes, a.bytes);
    } catch { fail('BYTES_INVALID'); }
    if (realData) check(bytes.byteLength === entry.sizeBytes, 'PERMIT_INVALID');
    check(magicOk(bytes, a.mimeType), 'MIME_INVALID');
    check(typeof a.sha256 === 'string' && SHA.test(a.sha256), 'SHA256_INVALID');
    check(parsed.sha256 === null || parsed.sha256 === a.sha256, 'KEY_INVALID'); // canonical filename sha === declared
    check(sha256Hex(bytes) === a.sha256, 'SHA256_MISMATCH');
    return { key: a.key, bytes, mimeType: a.mimeType, sha256: a.sha256, now: a.now };
  };
  const signed = (method, key, payloadSha256, extra, now) => {
    const canonicalUri = `/${d.bucket}/${key}`;
    check(PATH.test(canonicalUri) && !canonicalUri.includes('..') && !canonicalUri.includes('//'), 'KEY_INVALID');
    const amzDate = toAmzDate(now);
    const headers = { ...extra, 'x-amz-content-sha256': payloadSha256, 'x-amz-date': amzDate };
    const { authorization } = signV4({ method, canonicalUri, headers: { ...headers, host }, payloadSha256, amzDate, region: R2_REGION, service: R2_SERVICE, accessKeyId, secretAccessKey });
    return { url: `https://${host}${canonicalUri}`, headers: { ...headers, authorization } };
  };
  const send = (req, init, handle) => bounded(timeoutMs, async (signal) => {
    fetchCount++;
    const res = await fetchImpl(req.url, { method: init.method, headers: req.headers, ...(init.body ? { body: init.body } : {}), cache: 'no-store', redirect: 'error', signal });
    if (signal.aborted) { quietCancel(res?.body); throw new R2AdapterError('INTERNAL'); } // late response after timeout
    return handle(res, signal);
  });

  const execute = async (rawArgs, s) => {
    const a = readArgs(rawArgs);
    const put = signed('PUT', a.key, a.sha256, { 'content-type': a.mimeType, 'if-none-match': '*' }, a.now);
    const get = signed('GET', a.key, EMPTY_SHA256, {}, a.now);
    checkPermit(a.now); // dispatch gate, same supplied timestamp as signing
    s.bytesSent = a.bytes.byteLength;
    s.putSent = true;
    const p = await send(put, { method: 'PUT', body: a.bytes }, (res) => {
      const info = responseInfo(res, put.url);
      quietCancel(res?.body);
      return info;
    });
    if (p === TIMEOUT) return ['HALT_AMBIGUOUS', 'PUT_TIMEOUT'];
    if (!p.ok) return ['HALT_AMBIGUOUS', 'PUT_NETWORK_ERROR'];
    s.putStatus = p.value.status;
    if (!p.value.trusted) return ['HALT_AMBIGUOUS', 'PUT_RESPONSE_UNTRUSTED'];
    if (p.value.status === 412) return ['CONFLICT', 'PRECONDITION_FAILED'];
    if (p.value.status !== 200 && p.value.status !== 201) return ['HALT_AMBIGUOUS', 'PUT_STATUS'];
    checkPermit(a.now); // the claimed run may have ended while PUT was pending
    s.getSent = true;
    const g = await send(get, { method: 'GET' }, async (res, signal) => {
      const info = responseInfo(res, get.url);
      if (!info.trusted || info.status !== 200) { quietCancel(res?.body); return { info }; }
      let mime;
      try { mime = res.headers.get('content-type'); } catch { mime = null; }
      return { info, mime, read: await readBounded(res, a.bytes.byteLength, signal) };
    });
    if (g === TIMEOUT) return ['HALT_AMBIGUOUS', 'GET_TIMEOUT'];
    if (!g.ok) return ['HALT_AMBIGUOUS', 'GET_NETWORK_ERROR'];
    const { info, mime, read } = g.value;
    s.getStatus = info.status;
    if (!info.trusted) return ['HALT_AMBIGUOUS', 'GET_RESPONSE_UNTRUSTED'];
    if (info.status !== 200) return ['HALT_AMBIGUOUS', 'GET_STATUS'];
    if (read.error) return ['HALT_AMBIGUOUS', 'GET_STREAM_ERROR'];
    s.mimeMatches = typeof mime === 'string' && mime.split(';')[0].trim().toLowerCase() === a.mimeType;
    if (read.oversize) {
      Object.assign(s, { sizeMatches: false, sha256Matches: false });
      return ['INTEGRITY_MISMATCH', 'READBACK_OVERSIZE'];
    }
    s.bytesObserved = read.bytes.byteLength;
    s.sizeMatches = read.bytes.byteLength === a.bytes.byteLength;
    s.sha256Matches = s.sizeMatches && sha256Hex(read.bytes) === a.sha256 && Buffer.from(read.bytes).equals(Buffer.from(a.bytes));
    if (s.sizeMatches && s.sha256Matches && s.mimeMatches) return [realData ? 'OBJECT_VERIFIED_UAT' : 'OBJECT_VERIFIED_SYNTHETIC', 'READBACK_MATCHED'];
    return ['INTEGRITY_MISMATCH', 'READBACK_MISMATCH'];
  };

  // At most one transfer per instance. The lock is taken synchronously before validation or any
  // await; a rejected input also consumes the instance (create a new one to try again).
  const transfer = (rawArgs) => {
    if (used) return Promise.reject(new R2AdapterError('HALTED'));
    used = true;
    inFlight = true;
    const s = { putSent: false, getSent: false, putStatus: null, getStatus: null, bytesSent: 0, bytesObserved: null, sizeMatches: null, sha256Matches: null, mimeMatches: null };
    return execute(rawArgs, s).then(
      ([outcome, reason]) => ({ outcome, reason }),
      (error) => {
        if (!s.putSent) throw toSafe(error);
        return { outcome: 'HALT_AMBIGUOUS', reason: 'INTERNAL_AFTER_SEND' }; // never hide a sent write
      },
    ).then(({ outcome, reason }) => {
      lastOutcome = outcome;
      lastReason = reason;
      const syntheticVerified = outcome === 'OBJECT_VERIFIED_SYNTHETIC';
      const uatVerified = outcome === 'OBJECT_VERIFIED_UAT';
      return deepFreeze({
        adapterVersion: R2_ADAPTER_VERSION, outcome, reason, ...s, fetchCount, objectVerifiedSynthetic: syntheticVerified,
        ...(realData ? { objectVerifiedUat: uatVerified } : {}),
        halted: true, requiresReadBack: outcome === 'HALT_AMBIGUOUS', operatorDecisionRequired: !syntheticVerified && !uatVerified, ...flags,
      });
    }).finally(() => { inFlight = false; });
  };

  // Public-safe: counts, enums and flags only (no key, hashes, ids, headers or credentials).
  const summary = guarded((...rest) => {
    check(rest.length === 0, 'INPUT_INVALID');
    return deepFreeze({
      adapterVersion: R2_ADAPTER_VERSION, profile: d.profile, used, inFlight, fetchCount, lastOutcome, lastReason,
      timeoutMs, maxObjectBytes: MAX_OBJECT_BYTES, region: R2_REGION, ...flags,
    });
  });

  return Object.freeze({ transfer, summary });
});
