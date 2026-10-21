// SIKAP real-data authorization gate and permit issuer (IN-PROCESS CAPABILITY ONLY).
// Three fixed targets, each with its own issuer, policy digests and permit marker: UAT (below),
// PROD_TARGET (issueRealDataProductionPermit) and REHEARSAL_TARGET (issueRealDataRehearsalPermit,
// synthetic rehearsal only). A descriptor for one target is rejected by the other issuers.
//
// Scope and limits (read before using any output):
//   * Creates an in-process, non-transferable permit for real-data UAT execution only after
//     full local plan byte verification, descriptor pins check, and snapshot/source binding.
//   * Pinned strictly to the isolated UAT target:
//       - account: 04b8b2073be2f1aa21fc6489e0db36f6
//       - D1: sikap-import-uat-20261018, ID: 885b655b-3482-44fc-9d01-56ad0204bb35
//       - R2: sikap-import-uat-20261018-files
//   * Proves no remote network connectivity or cloud authorization; all authority flags remain false.
//   * One-run claim: once claimed by a runner, cannot be claimed again or reused.
//   * Adapters must recheck descriptor binding, nonces/epoch, and expiry for every request.
//   * Public permit object is frozen and redacted (no PII, rows, keys, secrets, or provider text);
//     private validated tables and file manifest are held in a module-private WeakMap.
import { createHash } from 'node:crypto';
import { ARTIFACT_LIMITS, IMPORT_TABLES } from '../migrate/contract.mjs';
import { validatePlan } from '../migrate/apply-local.mjs';
import { SAFETY, ImportCoreError, validateDescriptor } from './core.mjs';
import { LEDGER_DDL_SHA256 } from './ledger-contract.mjs';

export const UAT_APP_SCHEMA_SHA256 = '143fef6ecb05c450c38b697e6524d9c5e12072ef819c95d052fb210f323c7f72';
export const UAT_LEDGER_SCHEMA_SHA256 = LEDGER_DDL_SHA256;

export const GATE_VERSION = 1;

export const UAT_TARGET = Object.freeze({
  accountId: '04b8b2073be2f1aa21fc6489e0db36f6',
  databaseId: '885b655b-3482-44fc-9d01-56ad0204bb35',
  databaseName: 'sikap-import-uat-20261018',
  bucket: 'sikap-import-uat-20261018-files',
  profile: 'real-data',
});
export const REAL_DATA_UAT_TARGET = UAT_TARGET;
const digestTuple = (tuple) => createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
export const UAT_POLICY_SHA256 = digestTuple(['sikap-private-uat-policy', 1, UAT_TARGET, 'no-app-binding', 'no-retry', 'no-cleanup']);
export const UAT_RETENTION_POLICY_SHA256 = digestTuple(['sikap-private-uat-retention', 1, UAT_TARGET, 'no-cleanup', 'manual-review']);

// Production import target (created empty 2026-10-20; the name satisfies the importer's sikap-import-* rule).
// Pinned exactly like the UAT target; a permit for one target is never accepted for the other.
export const PROD_TARGET = Object.freeze({
  accountId: '04b8b2073be2f1aa21fc6489e0db36f6',
  databaseId: 'cd64e75e-ba43-419d-b1e6-d49a2930acf2',
  databaseName: 'sikap-import-prod-20261020',
  bucket: 'sikap-import-prod-20261020-files',
  profile: 'real-data',
});
export const PROD_APP_SCHEMA_SHA256 = UAT_APP_SCHEMA_SHA256; // same pinned migrations 0001..0008
export const PROD_LEDGER_SCHEMA_SHA256 = LEDGER_DDL_SHA256;
export const PROD_POLICY_SHA256 = digestTuple(['sikap-private-prod-policy', 1, PROD_TARGET, 'no-app-binding-during-import', 'no-retry', 'no-cleanup']);
export const PROD_RETENTION_POLICY_SHA256 = digestTuple(['sikap-private-prod-retention', 1, PROD_TARGET, 'no-cleanup', 'manual-review']);
// Synthetic REHEARSAL target (third, fixed). Used only by the orchestrator's synthetic-rehearsal kind
// with synthetic plans and injected fakes. Same allowed account (core ALLOWED_ACCOUNT_IDS) but a
// distinct fixed UUID/name/bucket; non-existence remotely is ASSUMED, never checked. A permit for this
// target is never accepted for UAT or production and vice versa (TARGET_PIN_MISMATCH / POLICY_PIN_MISMATCH).
export const REHEARSAL_TARGET = Object.freeze({
  accountId: '04b8b2073be2f1aa21fc6489e0db36f6',
  databaseId: '7e57ab1e-5e1f-4a1b-8c2d-5e1f5e1f5e1f',
  databaseName: 'sikap-import-rehearsal-synthetic',
  bucket: 'sikap-import-rehearsal-synthetic-files',
  profile: 'real-data',
});
export const REHEARSAL_APP_SCHEMA_SHA256 = UAT_APP_SCHEMA_SHA256;
export const REHEARSAL_LEDGER_SCHEMA_SHA256 = LEDGER_DDL_SHA256;
export const REHEARSAL_POLICY_SHA256 = digestTuple(['sikap-synthetic-rehearsal-policy', 1, REHEARSAL_TARGET, 'synthetic-only', 'no-authority', 'no-retry', 'no-cleanup']);
export const REHEARSAL_RETENTION_POLICY_SHA256 = digestTuple(['sikap-synthetic-rehearsal-retention', 1, REHEARSAL_TARGET, 'no-cleanup', 'synthetic-only']);
const TARGETS = Object.freeze({
  uat: Object.freeze({ target: UAT_TARGET, appSchema: UAT_APP_SCHEMA_SHA256, ledgerSchema: UAT_LEDGER_SCHEMA_SHA256, policy: UAT_POLICY_SHA256, retention: UAT_RETENTION_POLICY_SHA256 }),
  production: Object.freeze({ target: PROD_TARGET, appSchema: PROD_APP_SCHEMA_SHA256, ledgerSchema: PROD_LEDGER_SCHEMA_SHA256, policy: PROD_POLICY_SHA256, retention: PROD_RETENTION_POLICY_SHA256 }),
  rehearsal: Object.freeze({ target: REHEARSAL_TARGET, appSchema: REHEARSAL_APP_SCHEMA_SHA256, ledgerSchema: REHEARSAL_LEDGER_SCHEMA_SHA256, policy: REHEARSAL_POLICY_SHA256, retention: REHEARSAL_RETENTION_POLICY_SHA256 }),
});
const MARKERS = Object.freeze({ uat: 'realDataUat', production: 'realDataProduction', rehearsal: 'realDataRehearsal' });

export const REAL_DATA_GATE_ERROR_CODES = Object.freeze([
  'INPUT_INVALID', 'NOW_INVALID', 'DESCRIPTOR_INVALID', 'DESCRIPTOR_EXPIRED',
  'DESCRIPTOR_TARGET_DENIED', 'TARGET_PIN_MISMATCH', 'PROFILE_MISMATCH', 'PROFILE_BLOCKED',
  'PLAN_BYTES_INVALID', 'PLAN_HASH_MISMATCH', 'PLAN_JSON_INVALID', 'PLAN_BINDING_MISMATCH',
  'PLAN_INVALID', 'PERMIT_INVALID', 'PERMIT_NOT_CLAIMED', 'PERMIT_ALREADY_CLAIMED',
  'PERMIT_SPENT', 'NOW_NOT_MONOTONE', 'SCHEMA_PIN_MISMATCH', 'POLICY_PIN_MISMATCH', 'OBJECT_MANIFEST_MISMATCH', 'INTERNAL',
]);
const CODE_SET = new Set(REAL_DATA_GATE_ERROR_CODES);
const OWN_ERRORS = new WeakSet();

export class RealDataGateError extends Error {
  constructor(code) {
    const safe = typeof code === 'string' && CODE_SET.has(code) ? code : 'INTERNAL';
    super(safe);
    this.name = 'RealDataGateError';
    this.code = safe;
    OWN_ERRORS.add(this);
  }
}

const fail = (code) => { throw new RealDataGateError(code); };
const check = (condition, code) => { if (!condition) fail(code); };

const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const TA_TAG = Reflect.getOwnPropertyDescriptor(TA_PROTO, Symbol.toStringTag).get;
const TA_BYTE_LENGTH = Reflect.getOwnPropertyDescriptor(TA_PROTO, 'byteLength').get;
const TA_BUFFER = Reflect.getOwnPropertyDescriptor(TA_PROTO, 'buffer').get;
const TA_SET = TA_PROTO.set;
const AB_BYTE_LENGTH = Reflect.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function isoMs(value, code = 'NOW_INVALID') {
  check(typeof value === 'string' && ISO.test(value), code);
  const ms = Date.parse(value);
  check(Number.isFinite(ms) && new Date(ms).toISOString() === value, code);
  return ms;
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function plainArgs(value, required, optional = [], code = 'INPUT_INVALID') {
  try {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), code);
    const proto = Object.getPrototypeOf(value);
    check(proto === Object.prototype || proto === null, code);
    const own = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]), out = {};
    check(own.every((k) => typeof k === 'string' && allowed.has(k)) && required.every((k) => own.includes(k)), code);
    for (const key of own) {
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      check(Object.hasOwn(d, 'value') && d.enumerable === true, code);
      out[key] = d.value;
    }
    return out;
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    throw new RealDataGateError(code);
  }
}

const PERMITS = new WeakMap();

// Issues an in-process permit after full plan bytes and descriptor verification.
export function issueRealDataUatPermit(raw) { return issuePermit(raw, 'uat'); }
// Same checks against the pinned production target; only a parent/operator driver may call it.
export function issueRealDataProductionPermit(raw) { return issuePermit(raw, 'production'); }
// Same checks against the fixed synthetic rehearsal target only (permit marker realDataRehearsal).
export function issueRealDataRehearsalPermit(raw) { return issuePermit(raw, 'rehearsal'); }
function issuePermit(raw, which) {
  const T = TARGETS[which];
  const input = plainArgs(raw, ['descriptor', 'planBytes', 'now'], [], 'INPUT_INVALID');
  isoMs(input.now, 'NOW_INVALID');

  let v;
  try {
    v = validateDescriptor(input.descriptor, input.now);
  } catch (error) {
    if (error instanceof ImportCoreError) {
      if (error.code === 'DESCRIPTOR_EXPIRED') fail('DESCRIPTOR_EXPIRED');
      if (error.code === 'NOW_INVALID') fail('NOW_INVALID');
      if (error.code === 'DESCRIPTOR_TARGET_DENIED') fail('DESCRIPTOR_TARGET_DENIED');
    }
    fail('DESCRIPTOR_INVALID');
  }

  const d = v.descriptor;
  check(d.profile === 'real-data', 'PROFILE_MISMATCH');
  check(
    d.accountId === T.target.accountId &&
    d.databaseId === T.target.databaseId &&
    d.databaseName === T.target.databaseName &&
    d.bucket === T.target.bucket,
    'TARGET_PIN_MISMATCH',
  );
  check(d.appSchemaSha256 === T.appSchema && d.ledgerSchemaSha256 === T.ledgerSchema, 'SCHEMA_PIN_MISMATCH');
  check(d.policySha256 === T.policy && d.retentionPolicySha256 === T.retention, 'POLICY_PIN_MISMATCH');

  let planBytes;
  try {
    check(TA_TAG.call(input.planBytes) === 'Uint8Array', 'PLAN_BYTES_INVALID');
    const len = TA_BYTE_LENGTH.call(input.planBytes);
    // ArrayBuffer intrinsic rejects SharedArrayBuffer and Proxy-backed inputs before copying.
    // Copy exactly once: the hash and JSON decoder consume only this private snapshot.
    AB_BYTE_LENGTH.call(TA_BUFFER.call(input.planBytes));
    check(len > 0 && len <= ARTIFACT_LIMITS.exportBytes, 'PLAN_BYTES_INVALID');
    planBytes = new Uint8Array(len);
    TA_SET.call(planBytes, input.planBytes);
  } catch (error) {
    if (OWN_ERRORS.has(error)) throw error;
    fail('PLAN_BYTES_INVALID');
  }

  const planSha = sha256Hex(planBytes);
  check(planSha === d.planSha256, 'PLAN_HASH_MISMATCH');

  let rawPlan;
  try {
    rawPlan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes));
  } catch {
    fail('PLAN_JSON_INVALID');
  }

  check(rawPlan !== null && typeof rawPlan === 'object' && !Array.isArray(rawPlan), 'PLAN_INVALID');
  check(rawPlan.snapshotId === d.snapshotId, 'PLAN_BINDING_MISMATCH');
  check(rawPlan.sourceSha256 === d.sourceSha256, 'PLAN_BINDING_MISMATCH');

  let plan;
  try {
    plan = validatePlan(rawPlan);
  } catch {
    fail('PLAN_INVALID');
  }

  check(Array.isArray(plan.files), 'PLAN_INVALID');

  const fileManifest = [];
  const filesByKey = new Map();
  for (const f of plan.files) {
    const entry = Object.freeze({
      fileId: f.fileId,
      kind: f.kind,
      r2Key: f.r2Key,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
    });
    fileManifest.push(entry);
    filesByKey.set(f.r2Key, entry);
  }

  const privateData = {
    descriptor: deepFreeze({ ...d }),
    targetBindingSha256: v.targetBindingSha256,
    planSha256: d.planSha256,
    sourceSha256: d.sourceSha256,
    snapshotId: d.snapshotId,
    tables: deepFreeze(plan.tables),
    fileManifest: Object.freeze(fileManifest),
    filesByKey,
    issuedAt: input.now,
    claimed: false,
    claimNow: null,
    lastRequestMs: Date.parse(input.now),
    spent: false,
  };

  const permit = Object.freeze({
    permitVersion: GATE_VERSION,
    profile: 'real-data',
    targetBindingSha256: v.targetBindingSha256,
    planSha256: d.planSha256,
    sourceSha256: d.sourceSha256,
    snapshotId: d.snapshotId,
    accountId: d.accountId,
    databaseId: d.databaseId,
    databaseName: d.databaseName,
    bucket: d.bucket,
    expiresAt: d.expiresAt,
    counts: Object.freeze({
      files: fileManifest.length,
      totalFileBytes: plan.expected.totalFileBytes,
      rows: IMPORT_TABLES.reduce((sum, t) => sum + plan.tables[t].length, 0),
      rowsPerTable: Object.freeze(Object.fromEntries(IMPORT_TABLES.map((t) => [t, plan.tables[t].length]))),
    }),
    ...SAFETY,
    ready: false,
    readyForImport: false,
    remoteAuthorized: false,
    transportProven: false,
    authorizesExecution: false,
    [MARKERS[which]]: true,
  });

  PERMITS.set(permit, privateData);
  return permit;
}
export const issueUatPermit = issueRealDataUatPermit;

// Claims the permit once for an execution run. Fails if already claimed or expired.
export function claimPermitForRun(permit, rawOptions) {
  check(permit !== null && typeof permit === 'object' && PERMITS.has(permit), 'PERMIT_INVALID');
  const opts = plainArgs(rawOptions, ['now'], [], 'INPUT_INVALID');
  const nowMs = isoMs(opts.now, 'NOW_INVALID');
  const data = PERMITS.get(permit);
  check(!data.claimed, 'PERMIT_ALREADY_CLAIMED');
  check(!data.spent, 'PERMIT_SPENT');
  check(nowMs >= data.lastRequestMs, 'NOW_NOT_MONOTONE');
  check(nowMs < Date.parse(data.descriptor.expiresAt), 'DESCRIPTOR_EXPIRED');

  data.claimed = true;
  data.claimNow = opts.now;
  data.lastRequestMs = nowMs;

  return Object.freeze({
    descriptor: data.descriptor,
    targetBindingSha256: data.targetBindingSha256,
    tables: data.tables,
    fileManifest: data.fileManifest,
  });
}

// Marks the permit permanently spent after the run ends.
export function finishPermitRun(permit) {
  if (permit !== null && typeof permit === 'object' && PERMITS.has(permit)) {
    const data = PERMITS.get(permit);
    data.spent = true;
  }
}

// Per-request validation called by adapters. Requires active claimed run, non-expired, and matching descriptor.
export function validatePermitRequest(permit, descriptor, now) {
  check(permit !== null && typeof permit === 'object' && PERMITS.has(permit), 'PERMIT_INVALID');
  const data = PERMITS.get(permit);
  check(data.claimed, 'PERMIT_NOT_CLAIMED');
  check(!data.spent, 'PERMIT_SPENT');

  const nowMs = isoMs(now, 'NOW_INVALID');
  check(nowMs >= data.lastRequestMs, 'NOW_NOT_MONOTONE');
  check(nowMs < Date.parse(data.descriptor.expiresAt), 'DESCRIPTOR_EXPIRED');
  let v;
  try { v = validateDescriptor(descriptor, now); } catch (error) {
    if (error instanceof ImportCoreError && error.code === 'DESCRIPTOR_EXPIRED') fail('DESCRIPTOR_EXPIRED');
    fail('DESCRIPTOR_INVALID');
  }
  // Core binding includes ALL target/content/schema/baseline/policy hashes. Compare every
  // frozen descriptor field too: run/owner nonces, epoch and expiry are excluded by core binding.
  check(v.targetBindingSha256 === data.targetBindingSha256 &&
    Object.keys(data.descriptor).every((key) => Object.is(v.descriptor[key], data.descriptor[key])), 'DESCRIPTOR_INVALID');
  data.lastRequestMs = nowMs;
  return Object.freeze({
    descriptor: data.descriptor,
    targetBindingSha256: data.targetBindingSha256,
    tables: data.tables,
    fileManifest: data.fileManifest,
  });
}

export function getPermitTables(permit) {
  check(permit !== null && typeof permit === 'object' && PERMITS.has(permit), 'PERMIT_INVALID');
  return PERMITS.get(permit).tables;
}

export function getPermitManifest(permit) {
  check(permit !== null && typeof permit === 'object' && PERMITS.has(permit), 'PERMIT_INVALID');
  return PERMITS.get(permit).fileManifest;
}

export function getPermitFile(permit, key) {
  check(permit !== null && typeof permit === 'object' && PERMITS.has(permit), 'PERMIT_INVALID');
  return PERMITS.get(permit).filesByKey.get(key) ?? null;
}

// Exact manifest metadata only; the caller/adapter separately hashes its private byte copy.
export function assertPermittedObject(permit, descriptor, now, object) {
  validatePermitRequest(permit, descriptor, now);
  const o = plainArgs(object, ['key', 'sha256', 'mimeType', 'sizeBytes'], [], 'OBJECT_MANIFEST_MISMATCH');
  const file = PERMITS.get(permit).filesByKey.get(o.key);
  check(file !== undefined && file.r2Key === o.key && file.sha256 === o.sha256 &&
    file.mimeType === o.mimeType && Object.is(file.sizeBytes, o.sizeBytes), 'OBJECT_MANIFEST_MISMATCH');
  return file;
}

export function isPermitClaimed(permit) {
  return permit !== null && typeof permit === 'object' && PERMITS.has(permit) ? PERMITS.get(permit).claimed : false;
}

export function isPermitSpent(permit) {
  return permit !== null && typeof permit === 'object' && PERMITS.has(permit) ? PERMITS.get(permit).spent : true;
}
