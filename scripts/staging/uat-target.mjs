#!/usr/bin/env node
// Phase 9: offline UAT target descriptor validator.
//
// Strictly offline. No network, no Cloudflare API, no wrangler, no environment
// or credential reads, no data import/upload, no report files. It only checks
// that an operator-written private descriptor names an isolated UAT target and
// that it is not bound to known production / old-preview resources.
//
// The report never echoes descriptor values. A passing report is NOT proof of
// Cloudflare Access enforcement or credential scope and does NOT authorize any
// remote action: accessVerified, readyForImport and credentialScopeVerified
// are always false.
//
// Usage: node scripts/staging/uat-target.mjs --descriptor <file.json> --policy <file.json>

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_FILE_BYTES = 64 * 1024;
const MAX_POLICY_LIST = 1000;

// Hardcoded minimum deny-set (from wrangler.toml / workers/cron/wrangler.toml).
// Always unioned with the policy; a policy can only add, never remove.
export const BASELINE_DENY = Object.freeze({
  projectNames: Object.freeze(['sikap', 'sikap-v2']),
  databaseIds: Object.freeze([
    'b8611b82-8067-4153-ae5e-d6a0b94be7a6', // production sikap-db
    '1bd39313-4072-43a7-a183-7544c8264c46', // preview sikap-db-preview
  ]),
  databaseNames: Object.freeze(['sikap-db', 'sikap-db-preview']),
  buckets: Object.freeze(['sikap-files', 'sikap-files-preview', 'sikap-backup', 'sikap-backup-preview']),
});

const RE = Object.freeze({
  accountId: /^[0-9a-f]{32}$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  hex64: /^[0-9a-f]{64}$/,
  uatName: /^sikap-uat(?:-[a-z0-9]+)*$/,
  teamDomain: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/,
  policyName: /^[a-z0-9](?:[a-z0-9-]{0,62})$/,
  hostChars: /^[a-z0-9.*-]+$/,
});

const SECRET_KEY_RE = /(token|secret|passw|credential|api[-_]?key|private|cookie|session|bearer|auth)/i;

const DESCRIPTOR_KEYS = Object.freeze({
  allowed: ['version', 'purpose', 'accountId', 'projectName', 'environment', 'database', 'filesBucket',
    'backupBucket', 'access', 'pepperFingerprint', 'schemaSha256'],
  required: ['version', 'purpose', 'accountId', 'projectName', 'environment', 'database', 'filesBucket',
    'access', 'pepperFingerprint', 'schemaSha256'],
});
const DATABASE_KEYS = Object.freeze({ allowed: ['id', 'name'], required: ['id', 'name'] });
const ACCESS_KEYS = Object.freeze({
  allowed: ['teamDomain', 'audience', 'hostnames'],
  required: ['teamDomain', 'audience', 'hostnames'],
});
const POLICY_LISTS = Object.freeze({
  allowedAccountIds: { code: 'ALLOWED_ACCOUNT_IDS', re: RE.accountId },
  deniedAccountIds: { code: 'DENIED_ACCOUNT_IDS', re: RE.accountId },
  deniedProjectNames: { code: 'DENIED_PROJECT_NAMES', re: RE.policyName },
  deniedDatabaseIds: { code: 'DENIED_DATABASE_IDS', re: RE.uuid },
  deniedBuckets: { code: 'DENIED_BUCKETS', re: RE.policyName },
});
const POLICY_KEYS = Object.freeze({
  allowed: ['version', ...Object.keys(POLICY_LISTS)],
  required: ['version', ...Object.keys(POLICY_LISTS)],
});

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function checkKeys(obj, spec, prefix, codes) {
  for (const k of Object.keys(obj)) {
    if (spec.allowed.includes(k)) continue;
    codes.add(SECRET_KEY_RE.test(k) ? `${prefix}_SECRET_FIELD_FORBIDDEN` : `${prefix}_UNKNOWN_FIELD`);
  }
  for (const k of spec.required) if (!hasOwn(obj, k)) codes.add(`${prefix}_FIELD_MISSING`);
}

const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isUatName = (v, min, max) => isStr(v, max) && v.length >= min && RE.uatName.test(v);
const deniedBy = (set, v) => typeof v === 'string' && (set.has(v) || set.has(v.toLowerCase()));

/** Deterministic JSON: object keys sorted recursively, arrays keep order. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function buildReport(codes, descriptorSha256, accessDeclared) {
  const list = [...codes].sort();
  const report = { ok: list.length === 0, codes: list };
  if (report.ok && descriptorSha256) report.descriptorSha256 = descriptorSha256;
  report.accessDeclared = Boolean(accessDeclared);
  report.accessVerified = false;
  report.readyForImport = false;
  report.credentialScopeVerified = false;
  return report;
}

/**
 * Validate an operator-reviewed policy. Returns { ok, codes, effective } where
 * effective deny-sets always include BASELINE_DENY.
 */
export function validatePolicy(policy) {
  const codes = new Set();
  const lists = {};
  for (const name of Object.keys(POLICY_LISTS)) lists[name] = [];

  if (!isPlainObject(policy)) {
    codes.add('POLICY_NOT_OBJECT');
  } else {
    checkKeys(policy, POLICY_KEYS, 'POLICY', codes);
    if (policy.version !== 1) codes.add('POLICY_VERSION_UNSUPPORTED');
    for (const [name, { code, re }] of Object.entries(POLICY_LISTS)) {
      if (!hasOwn(policy, name)) continue;
      const v = policy[name];
      if (!Array.isArray(v) || v.length > MAX_POLICY_LIST) {
        codes.add(`POLICY_${code}_INVALID`);
        continue;
      }
      const seen = new Set();
      for (const item of v) {
        if (typeof item !== 'string' || !re.test(item)) codes.add(`POLICY_${code}_INVALID`);
        else if (seen.has(item)) codes.add(`POLICY_${code}_DUPLICATE`);
        else seen.add(item);
      }
      lists[name] = [...seen];
    }
    if (Array.isArray(policy.allowedAccountIds) && policy.allowedAccountIds.length === 0) {
      codes.add('POLICY_ALLOWED_ACCOUNT_IDS_EMPTY');
    }
  }

  const ok = codes.size === 0;
  const pick = (name) => (ok ? lists[name] : []);
  const effective = {
    allowedAccountIds: new Set(pick('allowedAccountIds')),
    deniedAccountIds: new Set(pick('deniedAccountIds')),
    deniedProjectNames: new Set([...BASELINE_DENY.projectNames, ...pick('deniedProjectNames')]),
    deniedDatabaseIds: new Set([...BASELINE_DENY.databaseIds, ...pick('deniedDatabaseIds')]),
    deniedDatabaseNames: new Set(BASELINE_DENY.databaseNames),
    deniedBuckets: new Set([...BASELINE_DENY.buckets, ...pick('deniedBuckets')]),
  };
  return { ok, codes: [...codes].sort(), effective };
}

function checkHostnames(hostnames, projectName, projectOk, codes) {
  if (!Array.isArray(hostnames)) {
    codes.add('ACCESS_HOSTNAMES_INVALID');
    return;
  }
  if (hostnames.length !== 2) codes.add('ACCESS_HOSTNAMES_COUNT_INVALID');
  const root = projectOk ? `${projectName}.pages.dev` : null;
  const wildcard = projectOk ? `*.${projectName}.pages.dev` : null;
  for (const h of hostnames) {
    if (!isStr(h, 253) || !RE.hostChars.test(h)) {
      // Rejects schemes, paths, queries, ports, IPv6, backslashes, control chars, uppercase.
      codes.add('ACCESS_HOSTNAME_INVALID');
    } else if (!h.endsWith('.pages.dev')) {
      codes.add('ACCESS_HOSTNAME_CUSTOM_DOMAIN_FORBIDDEN');
    } else if (root && h !== root && h !== wildcard) {
      codes.add('ACCESS_HOSTNAME_NOT_BOUND_TO_PROJECT');
    }
  }
  if (!root) return;
  if (!hostnames.includes(root)) codes.add('ACCESS_HOSTNAME_ROOT_MISSING');
  if (!hostnames.includes(wildcard)) codes.add('ACCESS_HOSTNAME_WILDCARD_MISSING');
  if (hostnames.length === 2 && hostnames[0] === wildcard && hostnames[1] === root) {
    codes.add('ACCESS_HOSTNAMES_ORDER_INVALID');
  }
}

function checkBucket(v, prefix, eff, codes) {
  // R2 bucket names: 3..63 chars; UAT buckets must use the sikap-uat prefix.
  if (!isUatName(v, 3, 63)) codes.add(`${prefix}_INVALID`);
  if (deniedBy(eff.deniedBuckets, v)) codes.add(`${prefix}_DENIED`);
}

/**
 * Pure validation of a version-1 private UAT descriptor against a policy.
 * Never returns raw descriptor values.
 */
export function validateDescriptor(descriptor, policy) {
  const codes = new Set();
  const pol = validatePolicy(policy);
  if (!pol.ok) {
    codes.add('POLICY_INVALID');
    for (const c of pol.codes) codes.add(c);
  }
  const eff = pol.effective;

  if (!isPlainObject(descriptor)) {
    codes.add('DESCRIPTOR_NOT_OBJECT');
    return buildReport(codes, null, false);
  }
  const d = descriptor;
  checkKeys(d, DESCRIPTOR_KEYS, 'DESCRIPTOR', codes);

  if (d.version !== 1) codes.add('DESCRIPTOR_VERSION_UNSUPPORTED');
  if (d.purpose !== 'private-uat') codes.add('PURPOSE_INVALID');
  if (d.environment !== 'uat') codes.add('ENVIRONMENT_INVALID');

  // Account: denied overrides allowed. Same account as production may be
  // allowed explicitly; credential scope stays unverified either way.
  if (!isStr(d.accountId, 32) || !RE.accountId.test(d.accountId)) {
    codes.add('ACCOUNT_ID_INVALID');
  } else if (pol.ok) {
    if (eff.deniedAccountIds.has(d.accountId)) codes.add('ACCOUNT_DENIED');
    else if (!eff.allowedAccountIds.has(d.accountId)) codes.add('ACCOUNT_NOT_ALLOWED');
  }

  // Pages project names are at most 58 chars.
  const projectOk = isUatName(d.projectName, 9, 58);
  if (!projectOk) codes.add('PROJECT_NAME_INVALID');
  if (deniedBy(eff.deniedProjectNames, d.projectName)) codes.add('PROJECT_NAME_DENIED');

  if (!isPlainObject(d.database)) {
    if (hasOwn(d, 'database')) codes.add('DATABASE_INVALID');
  } else {
    checkKeys(d.database, DATABASE_KEYS, 'DATABASE', codes);
    const { id, name } = d.database;
    if (!isStr(id, 36) || !RE.uuid.test(id)) codes.add('DATABASE_ID_INVALID');
    if (deniedBy(eff.deniedDatabaseIds, id)) codes.add('DATABASE_ID_DENIED');
    if (!isUatName(name, 9, 64)) codes.add('DATABASE_NAME_INVALID');
    if (deniedBy(eff.deniedDatabaseNames, name)) codes.add('DATABASE_NAME_DENIED');
  }

  if (hasOwn(d, 'filesBucket')) checkBucket(d.filesBucket, 'FILES_BUCKET', eff, codes);
  if (hasOwn(d, 'backupBucket')) {
    checkBucket(d.backupBucket, 'BACKUP_BUCKET', eff, codes);
    if (typeof d.filesBucket === 'string' && d.filesBucket === d.backupBucket) codes.add('BUCKETS_NOT_DISTINCT');
  }

  let accessDeclared = false;
  if (!isPlainObject(d.access)) {
    if (hasOwn(d, 'access')) codes.add('ACCESS_INVALID');
  } else {
    const before = codes.size;
    checkKeys(d.access, ACCESS_KEYS, 'ACCESS', codes);
    const { teamDomain, audience, hostnames } = d.access;
    if (!isStr(teamDomain, 253) || !RE.teamDomain.test(teamDomain)) codes.add('ACCESS_TEAM_DOMAIN_INVALID');
    // Cloudflare Access Application Audience (AUD) tag: 64 lowercase hex.
    if (!isStr(audience, 64) || !RE.hex64.test(audience)) codes.add('ACCESS_AUDIENCE_INVALID');
    checkHostnames(hostnames, d.projectName, projectOk, codes);
    accessDeclared = codes.size === before;
  }

  // pepperFingerprint / schemaSha256 are format-checked only (64 lowercase hex).
  // This offline tool never sees the pepper or the deployed schema, so it cannot
  // prove either value: they are opaque bindings folded into descriptorSha256.
  // Intended derivation (performed elsewhere, never here): pepperFingerprint =
  // HMAC-SHA256(key = pepper, msg = "sikap-uat:pepper-fingerprint:v1") so the
  // pepper itself is never hashed bare or stored; schemaSha256 = SHA-256 of
  // the applied migrations bundle. A match is always unverified by this tool.
  if (!isStr(d.pepperFingerprint, 64) || !RE.hex64.test(d.pepperFingerprint)) codes.add('PEPPER_FINGERPRINT_INVALID');
  if (!isStr(d.schemaSha256, 64) || !RE.hex64.test(d.schemaSha256)) codes.add('SCHEMA_SHA256_INVALID');

  const sha = codes.size === 0 ? createHash('sha256').update(canonicalJson(d), 'utf8').digest('hex') : null;
  return buildReport(codes, sha, accessDeclared);
}

// Leading pair of separators in any mix: UNC (\\server\share, //server/share,
// \/server, /\server) and Win32 device / long-path namespaces (\\?\, \\.\).
const NETWORK_OR_DEVICE_PREFIX = /^[\\/]{2}/;
// NT object-manager prefix (\??\...), which can also reach UNC targets.
const NT_OBJECT_PREFIX = /^[\\/]\?\?[\\/]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Pure lexical guard: no filesystem access. Applied identically on every
 * platform, before any fs call, so a UNC path can never trigger an SMB
 * connection (and NTLM credential exposure) on Windows. Plain POSIX absolute
 * paths such as /tmp/x.json are allowed. The resolved path is re-checked to
 * catch a UNC current working directory.
 */
export function isSafeLocalPath(filePath, resolve = path.resolve) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) return false;
  if (CONTROL_CHARS.test(filePath)) return false;
  if (NETWORK_OR_DEVICE_PREFIX.test(filePath) || NT_OBJECT_PREFIX.test(filePath)) return false;
  const abs = resolve(filePath);
  return typeof abs === 'string' && !NETWORK_OR_DEVICE_PREFIX.test(abs) && !NT_OBJECT_PREFIX.test(abs);
}

/**
 * Bounded, symlink-free JSON file read. The path is lexically guarded first
 * (see isSafeLocalPath); then every ancestor and the file itself are
 * lstat-checked; Windows junctions report as symbolic links. `io` defaults to
 * node:fs and exists only so tests can prove rejected paths never reach fs.
 */
export function readBoundedJsonFile(filePath, role, io = fs) {
  const fail = (suffix) => ({ ok: false, code: `${role}_${suffix}` });
  if (!isSafeLocalPath(filePath)) return fail('FILE_PATH_INVALID');

  const abs = path.resolve(filePath);
  const { root } = path.parse(abs);
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean);
  let cur = root;
  let lst;
  try {
    for (const part of parts) {
      cur = path.join(cur, part);
      lst = io.lstatSync(cur);
      if (lst.isSymbolicLink()) return fail('FILE_SYMLINK_FORBIDDEN');
    }
  } catch (err) {
    return fail(err && err.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_UNREADABLE');
  }
  if (!lst || !lst.isFile()) return fail('FILE_NOT_REGULAR');
  if (lst.size > MAX_FILE_BYTES) return fail('FILE_TOO_LARGE');
  if (process.platform !== 'win32' && (lst.mode & 0o022) !== 0) return fail('FILE_PERMISSIONS_UNSAFE');

  let fd;
  let bytes;
  try {
    fd = io.openSync(abs, 'r');
    const fst = io.fstatSync(fd);
    if (!fst.isFile()) return fail('FILE_NOT_REGULAR');
    if (fst.dev !== lst.dev || fst.ino !== lst.ino) return fail('FILE_CHANGED');
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = io.readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_FILE_BYTES) return fail('FILE_TOO_LARGE');
    }
    bytes = buf.subarray(0, total);
  } catch {
    return fail('FILE_UNREADABLE');
  } finally {
    if (fd !== undefined) io.closeSync(fd);
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return fail('JSON_INVALID');
  }
}

export function parseCliArgs(argv) {
  const codes = new Set();
  const out = {};
  const flags = { '--descriptor': 'descriptor', '--policy': 'policy' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remote' || (typeof a === 'string' && a.startsWith('--remote='))) {
      codes.add('USAGE_REMOTE_FORBIDDEN');
    } else if (hasOwn(flags, a)) {
      const key = flags[a];
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0 || v.startsWith('--')) {
        codes.add('USAGE_FLAG_VALUE_MISSING');
        continue;
      }
      i++;
      if (hasOwn(out, key)) codes.add('USAGE_DUPLICATE_FLAG');
      else out[key] = v;
    } else {
      codes.add('USAGE_UNKNOWN_ARGUMENT');
    }
  }
  if (!hasOwn(out, 'descriptor')) codes.add('USAGE_DESCRIPTOR_REQUIRED');
  if (!hasOwn(out, 'policy')) codes.add('USAGE_POLICY_REQUIRED');
  return { ok: codes.size === 0, codes: [...codes].sort(), ...out };
}

/** Returns exit code: 0 valid, 1 invalid, 2 usage. Writes one safe JSON line. */
export function runCli(argv, write = (s) => process.stdout.write(s)) {
  let report;
  let exit;
  try {
    const args = parseCliArgs(argv);
    if (!args.ok) {
      report = buildReport(args.codes, null, false);
      exit = 2;
    } else {
      const d = readBoundedJsonFile(args.descriptor, 'DESCRIPTOR');
      const p = readBoundedJsonFile(args.policy, 'POLICY');
      if (!d.ok || !p.ok) {
        report = buildReport([d.code, p.code].filter(Boolean), null, false);
      } else {
        report = validateDescriptor(d.value, p.value);
      }
      exit = report.ok ? 0 : 1;
    }
  } catch {
    report = buildReport(['INTERNAL_ERROR'], null, false);
    exit = 1;
  }
  write(`${JSON.stringify(report)}\n`);
  return exit;
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
