// Fixed-target PRODUCTION import operator (target: sikap-import-prod-20261020). Importing this module performs no I/O.
// Parent/operator ONLY, after independent review AND an explicit gate-E approval from the data owner:
//   node scripts/import/run-prod-import.mjs --print-module-pins  (hashes of pinned modules + self-sources; local repo reads only)
//   node scripts/import/run-prod-import.mjs --describe-plan      (requires module pins; reads PRIVATE plan + files; counts only; no auth/HTTP)
//   node scripts/import/run-prod-import.mjs --check-only         (full local validation incl. pins, budget and window; no auth/HTTP)
//   node scripts/import/run-prod-import.mjs --import-production  (one-shot remote import; no retry/cleanup/refresh)
// No arguments, unknown or extra arguments => exit 2 before any read. No target/path/hash/force/env options.
// No app binding, deployment, receipt file, or complete-flag update.
// All logic lives in prod-import-orchestrator.mjs (kind 'production'); pins come only from
// prod-import-pins.mjs, where every module/plan pin is PENDING and fails closed until reviewed.
// R2 preflight proves only the manifest destinations absent, NOT whole-bucket emptiness.
// Credential design (20 Oct 2026): the wrangler OAuth token (~1h) can never cover the budgeted window
// (B x 15s + margin, ~3.5h for B=807), so it is NOT used. The owner mints a dedicated short-lived Cloudflare
// API token (Account > D1 > Edit; expiry <= 12h) and an R2 API token scoped to the single production files
// bucket (Object Read & Write), writes them to the private credentials.env (D1_API_TOKEN,
// D1_API_TOKEN_EXPIRES_AT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) and revokes both right after the run.
// Token scope/expiry are NOT verifiable from here: D1 tokens cannot be limited to one database (residual risk).
import { lstat, readdir } from 'node:fs/promises';
import { ARTIFACT_LIMITS } from '../migrate/contract.mjs';
import { readVerifiedFile } from '../migrate/apply-local.mjs';
import { isMain, readBoundedPlan, verifyPrivatePersistence } from '../migrate/local-store.mjs';
import { ENDPOINT_ORIGIN, ENDPOINT_PATH } from './d1-rest.mjs';
import { PROD_TARGET } from './real-data-gate.mjs';
import { orchestrateImport } from './prod-import-orchestrator.mjs';
import * as PINS from './prod-import-pins.mjs';

export const TARGET = PROD_TARGET;
export const ENDPOINT = `${ENDPOINT_ORIGIN}${ENDPOINT_PATH(TARGET.accountId, TARGET.databaseId)}`;
export const PLAN_FACTS = PINS.PLAN_FACTS;
export const MODULE_FILES = PINS.MODULE_FILES;
export const SELF_SOURCES = PINS.SELF_SOURCES;
export const CLI_MODES = Object.freeze({ '--print-module-pins': 'print-pins', '--describe-plan': 'describe-plan', '--check-only': 'check-only', '--import-production': 'import' });

const MODES = Object.freeze(['import', 'check-only', 'describe-plan', 'print-pins']);
const OPTION_KEYS = Object.freeze(['readCredential', 'fetchImpl', 'mode', 'readPlanBytes', 'readFileBytes', 'now']);
// Fixed-shape stop for argument errors (same public flags as the orchestrator summary).
const argsStop = (code) => Object.freeze({ kind: 'production', targetName: TARGET.databaseName, targetId: TARGET.databaseId, phase: 'ARGS', status: 'STOPPED_ARGS', code,
  requests: 0, writeAttempts: 0, setupStatements: Object.freeze({ planned: 0, applied: 0 }),
  ready: false, readyForImport: false, remoteAuthorized: false, transportProven: false, authorizesExecution: false,
  completeFlagSet: false, appBindingAllowed: false, deployed: false, cleanupAttempted: false, productionImport: true, syntheticRehearsal: false });

// Callable API (requires explicit dependencies; no defaults). Always kind 'production': target, pins,
// plan facts and issuer cannot be changed by the caller. `now` is an explicit injected clock.
export async function executeProductionImport(options) {
  let o;
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return argsStop('OPTIONS_INVALID');
    const proto = Object.getPrototypeOf(options);
    if (proto !== Object.prototype && proto !== null) return argsStop('OPTIONS_INVALID');
    const own = Reflect.ownKeys(options);
    if (own.length !== OPTION_KEYS.length || !own.every((k) => typeof k === 'string' && OPTION_KEYS.includes(k))) return argsStop('OPTIONS_INVALID');
    o = {};
    for (const k of own) {
      const d = Reflect.getOwnPropertyDescriptor(options, k);
      if (!Object.hasOwn(d, 'value') || d.enumerable !== true) return argsStop('OPTIONS_INVALID');
      o[k] = d.value;
    }
  } catch { return argsStop('OPTIONS_INVALID'); }
  if (typeof o.mode !== 'string' || !MODES.includes(o.mode) || !['readCredential', 'fetchImpl', 'readPlanBytes', 'readFileBytes', 'now'].every((k) => typeof o[k] === 'function')) return argsStop('OPTIONS_INVALID');
  return orchestrateImport({ kind: 'production', mode: o.mode,
    io: { readPlanBytes: o.readPlanBytes, readFileBytes: o.readFileBytes, readCredential: o.readCredential, fetchImpl: o.fetchImpl, now: o.now } });
}

// ------------------------------- CLI-only real I/O below ---------------------------------------
const PRIVATE_ROOT = 'C:/Users/elwin/sikap-private/prod-import';
const PLAN_DIR = `${PRIVATE_ROOT}/plan-final`;
const PLAN_PATH = `${PLAN_DIR}/plan.sikap-plan.json`;
const FILES_ROOT = `${PRIVATE_ROOT}/snapshot-final/files`;
const DOTENV_PATH = `${PRIVATE_ROOT}/credentials.env`;

class ReaderError extends Error { constructor(code) { super(code); this.code = code; } }
// Read-only privacy check. Windows: existing verifyPrivatePersistence (owner = current user; Allow ACEs only
// for user/SYSTEM/Administrators). POSIX: owner uid + no group/other bits (never chmod). Fixed codes only.
async function assertPrivate(target, kind, code) {
  try {
    const st = await lstat(target);
    if (st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile())) throw new Error();
    if (process.platform === 'win32') await verifyPrivatePersistence(target);
    else if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Error();
  } catch { throw new ReaderError(code); }
}
async function readPlanBytes() {
  for (const [p, kind] of [[PRIVATE_ROOT, 'dir'], [PLAN_DIR, 'dir'], [PLAN_PATH, 'file']]) await assertPrivate(p, kind, 'PRIVATE_PERMISSIONS');
  try { return await readBoundedPlan(PLAN_PATH, ARTIFACT_LIMITS.exportBytes); } catch { throw new ReaderError('PLAN_READ_FAILED'); }
}
let filesChecked = false;
async function readFileBytes(file) {
  if (!filesChecked) {
    await assertPrivate(FILES_ROOT, 'dir', 'PRIVATE_PERMISSIONS');
    try { await readdir(FILES_ROOT); } catch { throw new ReaderError('FILE_READ_FAILED'); }
    filesChecked = true;
  }
  try { return await readVerifiedFile(FILES_ROOT, file); } catch { throw new ReaderError('FILE_READ_FAILED'); }
}
// Pure parser (exported for tests; no I/O). Only these five names are extracted, each EXACTLY once; commented
// lines never match; no eval, interpolation, shell, process.env or echo. Failures are the fixed code
// CREDENTIAL_FORMAT and never carry a value, key text or line content.
export function parseCredentialEnv(text) {
  if (typeof text !== 'string') throw new ReaderError('CREDENTIAL_FORMAT');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const pick = (key) => {
    const found = lines.filter((line) => new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`).test(line));
    if (found.length !== 1) throw new ReaderError('CREDENTIAL_FORMAT');
    const value = found[0].slice(found[0].indexOf('=') + 1).trim();
    const m = /^(?:"([^"\\\r\n]*)"|'([^'\r\n]*)'|([^\s#'"\\]+))[ \t]*(?:#.*)?$/.exec(value);
    if (m === null) throw new ReaderError('CREDENTIAL_FORMAT');
    return m[1] ?? m[2] ?? m[3];
  };
  return { token: pick('D1_API_TOKEN'), expiresAt: pick('D1_API_TOKEN_EXPIRES_AT'),
    accessKeyId: pick('R2_ACCESS_KEY_ID'), secretAccessKey: pick('R2_SECRET_ACCESS_KEY'), r2ExpiresAt: pick('R2_ACCESS_KEY_EXPIRES_AT') };
}
async function readCredential() {
  // Parent directory first (order-independent privacy), then the file itself.
  await assertPrivate(PRIVATE_ROOT, 'dir', 'CREDENTIAL_PERMISSIONS');
  await assertPrivate(DOTENV_PATH, 'file', 'CREDENTIAL_PERMISSIONS');
  let dotenv;
  try {
    dotenv = new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedPlan(DOTENV_PATH, 64 * 1024));
  } catch { throw new ReaderError('CREDENTIAL_READ_FAILED'); }
  return parseCredentialEnv(dotenv);
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const valid = argv.length === 1 && Object.hasOwn(CLI_MODES, argv[0]);
  const result = !valid ? argsStop('CLI_ARGUMENTS') : await executeProductionImport({
    mode: CLI_MODES[argv[0]], readCredential, fetchImpl: globalThis.fetch, readPlanBytes, readFileBytes, now: () => new Date().toISOString(),
  });
  process.exitCode = !valid ? 2 : ['CHECK_ONLY_OK', 'COMPLETE_PROD_RECONCILED', 'PLAN_DESCRIBED', 'PINS_PRINTED'].includes(result.status) ? 0 : 1;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
