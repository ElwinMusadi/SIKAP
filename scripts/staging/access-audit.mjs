#!/usr/bin/env node
// Read-only, anonymous Cloudflare Access probe for SIKAP staging Pages hosts.
//
// Scope (deliberately narrow):
// - Sends anonymous HEAD requests (no cookies, no auth headers, no credentials)
//   to /login, /api/auth/me and /api/health on operator-listed *.pages.dev hosts
//   of ONE non-production Pages project.
// - Never follows redirects, never reads response bodies, never reads Set-Cookie,
//   never calls the Cloudflare API / control plane, never touches data.
// - Custom domains are NOT probed; they must be checked manually.
//
// It is NOT a global privacy proof. `readyForImport` is always false: the tool
// cannot verify every historical deployment URL, Access allow policies, server
// side Access JWT validation, private bindings (D1/R2), or disabled cron/mail.
//
// Source facts the report relies on (Cloudflare docs):
// - Pages "Enable access policy" (project settings) protects preview deployments
//   (*.<project>.pages.dev) only, not <project>.pages.dev or custom domains;
//   those need their own Access application.
//   This tool therefore REQUIRES <project>.pages.dev in the inventory.
// - Unauthenticated browser requests to an Access-protected hostname are
//   redirected to https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?...
//   Only that host-bound form counts; a hostless /cdn-cgi/access/login is unproven.
// - Access may also answer 403 without a redirect (e.g. block); that is not
//   proof of a challenge and is reported as unproven.

import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASELINE_DENY, isSafeLocalPath, readBoundedJsonFile } from './uat-target.mjs';

export const TOOL = 'sikap-staging-access-audit';
export const REPORT_SCHEMA = 'sikap.staging-access-audit/v1';
export const PROBE_PATHS = Object.freeze(['/login', '/api/auth/me', '/api/health']);
export const CHALLENGE_STATUSES = Object.freeze([302, 303, 307]);
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_INVENTORY_BYTES = 65_536;
export const MAX_HOSTS = 100;
export const MAX_PATH_ARG_LENGTH = 4096;
export const OUTSTANDING_REQUIREMENTS = Object.freeze([
  'CONTROL_PLANE_HOST_INVENTORY',
  'AUTHORIZED_AND_DENIED_USER_TEST',
  'PRIVATE_BINDINGS',
  'NOTIFICATION_AND_CRON_DISABLED',
  'SERVER_ACCESS_JWT_VALIDATION',
]);

export const RESULT_CHALLENGED = 'CHALLENGED';
export const RESULT_UNPROVEN = 'UNPROTECTED_OR_UNPROVEN';

// Shared baseline deny-set (production + old preview projects); never probed.
const DENIED_PROJECTS = Object.freeze([...BASELINE_DENY.projectNames]);
const PRODUCTION_HOSTS = Object.freeze([
  'sikap.uptdpenda-kupang.web.id',
  ...DENIED_PROJECTS.map((name) => `${name}.pages.dev`),
]);
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const LABEL_RE = new RegExp(`^${LABEL}$`);
// Pages project names: lowercase alphanumerics and dashes, max 58 chars.
const PROJECT_RE = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
const TEAM_DOMAIN_RE = new RegExp(`^${LABEL}\\.cloudflareaccess\\.com$`);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const INVENTORY_KEYS = new Set([
  'version',
  'project',
  'teamDomain',
  'hosts',
  'inventoryComplete',
  'checkedAt',
  'operatorDeclared',
]);

const BOUNDARY_NOTES = Object.freeze([
  'Probes only the listed *.pages.dev hosts of one Pages project with anonymous HEAD requests; not a global privacy proof.',
  'inventoryComplete and the branch/hash host list are operator declarations and are not verified by this tool (no control-plane calls).',
  'Pages native "Enable access policy" covers preview deployments only; <project>.pages.dev (required in the inventory) and custom domains need explicit Access applications.',
  'Only a 302/303/307 to https://<teamDomain>/cdn-cgi/access/login/<probed host> counts as a challenge.',
  'Custom domains are not probed; verify their Access protection manually.',
  'A 403 without an Access login redirect is reported as unproven, never as a pass.',
  'readyForImport is always false; see outstandingRequirements.',
]);

// ---------------------------------------------------------------------------
// Inventory validation
// ---------------------------------------------------------------------------

export function isProductionHost(host) {
  return PRODUCTION_HOSTS.some((prod) => host === prod || host.endsWith(`.${prod}`));
}

export function hostError(host, project) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) return 'HOST_SYNTAX';
  if (host.includes('*')) return 'HOST_WILDCARD';
  // Plain lowercase DNS only: rejects schemes, ports, paths, credentials,
  // IPv6 literals, whitespace, uppercase and trailing dots.
  if (/[^a-z0-9.-]/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    return 'HOST_SYNTAX';
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host.split('.').at(-1))) {
    return 'HOST_IP_LITERAL';
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'HOST_LOCALHOST';
  if (isProductionHost(host)) return 'PRODUCTION_HOST_REJECTED';
  if (!host.split('.').every((label) => LABEL_RE.test(label))) return 'HOST_SYNTAX';
  const root = `${project}.pages.dev`;
  if (host === root) return null;
  if (host.endsWith(`.${root}`)) {
    const prefix = host.slice(0, -(root.length + 1));
    if (LABEL_RE.test(prefix)) return null;
  }
  return 'HOST_NOT_PROJECT_PAGES_DEV';
}

export function validateInventory(raw) {
  const errors = [];
  const fail = (code, field) => errors.push(field === undefined ? { code } : { code, field });

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ code: 'INVENTORY_NOT_OBJECT' }] };
  }
  for (const key of Object.keys(raw)) {
    if (!INVENTORY_KEYS.has(key)) fail('UNKNOWN_FIELD', 'inventory');
  }
  if (raw.version !== 1) fail('VERSION_UNSUPPORTED', 'version');

  const project = raw.project;
  let projectOk = false;
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) {
    fail('PROJECT_INVALID', 'project');
  } else if (DENIED_PROJECTS.includes(project)) {
    fail('PRODUCTION_PROJECT_REJECTED', 'project');
  } else {
    projectOk = true;
  }

  if (typeof raw.teamDomain !== 'string' || !TEAM_DOMAIN_RE.test(raw.teamDomain)) {
    fail('TEAM_DOMAIN_INVALID', 'teamDomain');
  }

  if (typeof raw.inventoryComplete !== 'boolean') fail('INVENTORY_COMPLETE_NOT_BOOLEAN', 'inventoryComplete');

  if (raw.checkedAt !== undefined) {
    if (
      typeof raw.checkedAt !== 'string' ||
      raw.checkedAt.length > 64 ||
      !ISO_RE.test(raw.checkedAt) ||
      Number.isNaN(Date.parse(raw.checkedAt))
    ) {
      fail('CHECKED_AT_INVALID', 'checkedAt');
    }
  }
  if (raw.operatorDeclared !== undefined && typeof raw.operatorDeclared !== 'boolean') {
    fail('OPERATOR_DECLARED_NOT_BOOLEAN', 'operatorDeclared');
  }

  const hosts = raw.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0) {
    fail('HOSTS_EMPTY_OR_INVALID', 'hosts');
  } else if (hosts.length > MAX_HOSTS) {
    fail('HOSTS_TOO_MANY', 'hosts');
  } else {
    const seen = new Set();
    hosts.forEach((host, index) => {
      const field = `hosts[${index}]`;
      if (typeof host === 'string' && seen.has(host)) {
        fail('HOST_DUPLICATE', field);
        return;
      }
      seen.add(host);
      // Production/syntax checks do not depend on the project being valid.
      const code = hostError(host, projectOk ? project : '\u0000invalid');
      if (code && !(code === 'HOST_NOT_PROJECT_PAGES_DEV' && !projectOk)) fail(code, field);
    });
    // Pages native Access covers previews only, so the production-like root
    // alias of the staging project must always be probed explicitly.
    if (projectOk && !hosts.includes(`${project}.pages.dev`)) fail('ROOT_PAGES_DEV_HOST_REQUIRED', 'hosts');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    inventory: {
      version: 1,
      project,
      teamDomain: raw.teamDomain,
      hosts: [...hosts],
      inventoryComplete: raw.inventoryComplete,
      checkedAt: raw.checkedAt ?? null,
      operatorDeclared: raw.operatorDeclared ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

export function isAccessLoginLocation(location, host, teamDomain) {
  if (typeof location !== 'string' || location.length === 0 || location.length > 8192) return false;
  if (Array.from(location).some((ch) => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127 || ch === '\\')) return false;
  let url;
  try {
    url = new URL(location); // absolute only; relative Locations are rejected
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.hostname !== teamDomain || url.port !== '' || url.username !== '' || url.password !== '') return false;
  // Host-bound only: bare /cdn-cgi/access/login(/) does not prove which
  // application challenged, so it is treated as unproven.
  return url.pathname === `/cdn-cgi/access/login/${host}`;
}

export function classifyResponse(status, location, { host, teamDomain }) {
  if (CHALLENGE_STATUSES.includes(status)) {
    if (!location) return { result: RESULT_UNPROVEN, reason: 'REDIRECT_WITHOUT_LOCATION' };
    return isAccessLoginLocation(location, host, teamDomain)
      ? { result: RESULT_CHALLENGED, reason: 'ACCESS_LOGIN_REDIRECT' }
      : { result: RESULT_UNPROVEN, reason: 'REDIRECT_NOT_ACCESS_LOGIN' };
  }
  if (status >= 300 && status < 400) return { result: RESULT_UNPROVEN, reason: 'REDIRECT_STATUS_NOT_ACCEPTED' };
  if (status === 403) return { result: RESULT_UNPROVEN, reason: 'FORBIDDEN_WITHOUT_CHALLENGE' };
  return { result: RESULT_UNPROVEN, reason: 'DIRECT_RESPONSE' };
}

async function probeOne(fetchImpl, host, probePath, teamDomain, timeoutMs) {
  const base = { host, path: probePath };
  let response;
  try {
    response = await fetchImpl(`https://${host}${probePath}`, {
      method: 'HEAD',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err && typeof err === 'object' ? err.name : '';
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
    return { ...base, status: null, result: RESULT_UNPROVEN, reason };
  }

  const status = Number.isInteger(response?.status) ? response.status : null;
  let location;
  try {
    location = response?.headers?.get?.('location') ?? null; // only header ever read
  } catch {
    location = null;
  }
  try {
    await response?.body?.cancel?.(); // release without reading
  } catch {
    // ignore
  }

  if (response?.redirected === true) {
    return { ...base, status, result: RESULT_UNPROVEN, reason: 'REDIRECT_WAS_FOLLOWED' };
  }
  if (response?.type === 'opaqueredirect') {
    return { ...base, status, result: RESULT_UNPROVEN, reason: 'OPAQUE_REDIRECT' };
  }
  if (status === null || status < 100 || status > 599) {
    return { ...base, status: null, result: RESULT_UNPROVEN, reason: 'INVALID_RESPONSE' };
  }
  return { ...base, status, ...classifyResponse(status, location, { host, teamDomain }) };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function errorReport(code, details, now = () => new Date()) {
  const report = {
    schema: REPORT_SCHEMA,
    tool: TOOL,
    generatedAt: now().toISOString(),
    ok: false,
    error: { code },
    readyForImport: false,
    anonymousChallengesPassed: false,
  };
  if (Array.isArray(details) && details.length > 0) report.error.details = details;
  return report;
}

export async function auditInventory(rawInventory, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const validation = validateInventory(rawInventory);
  if (!validation.ok) {
    return { exitCode: 2, report: errorReport('INVENTORY_INVALID', validation.errors, now) };
  }
  if (typeof fetchImpl !== 'function') {
    return { exitCode: 2, report: errorReport('FETCH_UNAVAILABLE', undefined, now) };
  }

  const inv = validation.inventory;
  const startedAt = now().toISOString();
  const probes = [];
  for (const host of inv.hosts) {
    for (const probePath of PROBE_PATHS) {
      // Sequential on purpose: low volume against staging.
      probes.push(await probeOne(fetchImpl, host, probePath, inv.teamDomain, timeoutMs));
    }
  }
  const finishedAt = now().toISOString();

  const challenged = probes.filter((p) => p.result === RESULT_CHALLENGED).length;
  const reasons = {};
  for (const p of probes) reasons[p.reason] = (reasons[p.reason] ?? 0) + 1;
  const anonymousChallengesPassed = probes.length > 0 && challenged === probes.length;
  const inventoryComplete = inv.inventoryComplete === true;
  const exitCode = anonymousChallengesPassed && inventoryComplete ? 0 : 2;
  const exitReason = !anonymousChallengesPassed
    ? 'ANONYMOUS_CHALLENGE_NOT_PROVEN'
    : !inventoryComplete
      ? 'INVENTORY_NOT_DECLARED_COMPLETE'
      : 'LISTED_PROBES_CHALLENGED_AND_INVENTORY_DECLARED_COMPLETE';

  const rootHost = `${inv.project}.pages.dev`;
  const warnings = ['CUSTOM_DOMAINS_NOT_PROBED', 'INVENTORY_COMPLETENESS_NOT_VERIFIED'];

  return {
    exitCode,
    report: {
      schema: REPORT_SCHEMA,
      tool: TOOL,
      generatedAt: finishedAt,
      ok: true,
      project: inv.project,
      teamDomain: inv.teamDomain,
      readyForImport: false,
      readyForImportReason: 'ALWAYS_FALSE_TOOL_CANNOT_VERIFY_FULL_PRIVACY_BOUNDARY',
      anonymousChallengesPassed,
      inventoryDeclaration: {
        inventoryComplete,
        declaredNotVerified: true,
        checkedAt: inv.checkedAt,
        operatorDeclared: inv.operatorDeclared,
      },
      exitCode,
      exitReason,
      scope: {
        method: 'HEAD',
        paths: [...PROBE_PATHS],
        hosts: [...inv.hosts],
        rootPagesDevHostListed: inv.hosts.includes(rootHost),
        customHostsProbed: false,
        redirectsFollowed: false,
        credentialsSent: false,
        responseBodiesRead: false,
      },
      evidence: {
        startedAt,
        finishedAt,
        totalProbes: probes.length,
        challenged,
        unprotectedOrUnproven: probes.length - challenged,
        reasons,
      },
      probes,
      warnings,
      outstandingRequirements: [...OUTSTANDING_REQUIREMENTS],
      boundary: [...BOUNDARY_NOTES],
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Rejected before any fs call: empty/oversized/NUL, and any path starting with
// two separators (UNC \\server\share, //server/share, device \\?\ \\.\ //?/ ,
// and ///x), which could trigger SMB/network or raw-device access on Windows.
export function validPathArg(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PATH_ARG_LENGTH &&
    !value.includes('\0') &&
    !/^[\\/]{2}/.test(value)
  );
}

export function parseArgs(argv) {
  const details = [];
  const out = { inventory: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '--inventory' && arg !== '--out') {
      details.push({ code: 'UNKNOWN_ARGUMENT', index: i });
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      details.push({ code: 'MISSING_VALUE', index: i });
      continue;
    }
    i += 1;
    if (out[key] !== null) {
      details.push({ code: 'DUPLICATE_ARGUMENT', index: i - 1 });
      continue;
    }
    if (!validPathArg(value)) {
      details.push({ code: 'INVALID_PATH', index: i });
      continue;
    }
    out[key] = value;
  }
  if (out.inventory === null && !details.some((d) => d.code !== 'UNKNOWN_ARGUMENT')) {
    details.push({ code: 'MISSING_INVENTORY' });
  }
  if (out.inventory && out.out && path.resolve(out.inventory) === path.resolve(out.out)) {
    details.push({ code: 'OUT_EQUALS_INVENTORY' });
  }
  return details.length > 0 ? { ok: false, details } : { ok: true, ...out };
}

class CodedError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Codes readBoundedJsonFile (uat-target.mjs) can return for role INVENTORY.
const INVENTORY_READ_CODES = new Set([
  'INVENTORY_FILE_PATH_INVALID',
  'INVENTORY_FILE_SYMLINK_FORBIDDEN',
  'INVENTORY_FILE_NOT_FOUND',
  'INVENTORY_FILE_UNREADABLE',
  'INVENTORY_FILE_NOT_REGULAR',
  'INVENTORY_FILE_TOO_LARGE',
  'INVENTORY_FILE_PERMISSIONS_UNSAFE',
  'INVENTORY_FILE_CHANGED',
  'INVENTORY_JSON_INVALID',
]);

/**
 * Reuses the shared bounded reader: 64 KiB cap, lstat on every ancestor and
 * the file (symlinks/junctions rejected), fstat dev/inode match, strict UTF-8.
 */
export function readInventoryFile(filePath) {
  if (!validPathArg(filePath)) throw new CodedError('INVENTORY_FILE_PATH_INVALID');
  let result;
  try {
    result = readBoundedJsonFile(filePath, 'INVENTORY');
  } catch {
    throw new CodedError('INVENTORY_FILE_UNREADABLE');
  }
  if (result?.ok === true) return result.value;
  throw new CodedError(INVENTORY_READ_CODES.has(result?.code) ? result.code : 'INVENTORY_FILE_UNREADABLE');
}

async function assertNoSymlinkAncestors(dir) {
  const abs = path.resolve(dir);
  const { root } = path.parse(abs);
  let cur = root;
  for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      throw new CodedError(err?.code === 'ENOENT' ? 'OUTPUT_PARENT_NOT_FOUND' : 'OUTPUT_WRITE_FAILED');
    }
    if (st.isSymbolicLink()) throw new CodedError('OUTPUT_PATH_SYMLINK_FORBIDDEN');
    if (!st.isDirectory()) throw new CodedError('OUTPUT_PARENT_NOT_DIRECTORY');
  }
}

export async function writeReportExclusive(filePath, report) {
  if (!validPathArg(filePath) || !isSafeLocalPath(filePath)) throw new CodedError('OUTPUT_PATH_INVALID');
  await assertNoSymlinkAncestors(path.dirname(path.resolve(filePath)));
  let fh;
  try {
    fh = await open(filePath, 'wx', 0o600); // never overwrites; 0600 where the OS honours it
  } catch (err) {
    throw new CodedError(err?.code === 'EEXIST' ? 'OUTPUT_EXISTS' : 'OUTPUT_WRITE_FAILED');
  }
  try {
    await fh.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    throw new CodedError('OUTPUT_WRITE_FAILED');
  } finally {
    await fh.close().catch(() => {});
  }
}

const writeJson = (stream, value) => stream.write(`${JSON.stringify(value, null, 2)}\n`);

export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? (() => new Date());
  try {
    const args = parseArgs(argv);
    if (!args.ok) {
      writeJson(stderr, errorReport('CLI_ARGUMENTS', args.details, now));
      return 2;
    }
    let raw;
    try {
      raw = readInventoryFile(args.inventory);
    } catch (err) {
      writeJson(stderr, errorReport(err instanceof CodedError ? err.code : 'INVENTORY_FILE_UNREADABLE', undefined, now));
      return 2;
    }
    const { exitCode, report } = await auditInventory(raw, deps);
    if (!report.ok) {
      writeJson(stderr, report);
      return exitCode;
    }
    if (args.out) {
      try {
        await writeReportExclusive(args.out, report);
      } catch (err) {
        writeJson(stderr, errorReport(err instanceof CodedError ? err.code : 'OUTPUT_WRITE_FAILED', undefined, now));
        return 2;
      }
      writeJson(stdout, {
        ok: true,
        reportWritten: true,
        anonymousChallengesPassed: report.anonymousChallengesPassed,
        inventoryComplete: report.inventoryDeclaration.inventoryComplete,
        readyForImport: false,
        exitCode,
      });
    } else {
      writeJson(stdout, report);
    }
    return exitCode;
  } catch {
    writeJson(stderr, errorReport('INTERNAL_ERROR', undefined, now)); // no stack/message
    return 2;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
