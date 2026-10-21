// Pin for the ONE known, user-approved D1 transaction-probe database. NOT a generic validator.
//
// Pure: constants plus a text check. No CLI, no process spawn, no executor, no network, no file
// system and no environment access. The caller supplies the config text (ops/tx-probe/wrangler.toml).
// A matching config proves only that the local text equals the reviewed, pinned bytes. It does NOT
// prove the database exists, that the UUID belongs to it, or that it is empty, and it authorizes no
// remote call, SQL (not even SELECT), deploy or cleanup. Control-plane identity is a separate check.
import { createHash } from 'node:crypto';
import { PROBE_DB_NAME, ProbeKitError, validateProbeTarget } from './d1-tx-probe-kit.mjs';

export const PROBE_CONFIG_PATH = 'ops/tx-probe/wrangler.toml'; // informational; never read here
export const PROBE_ACCOUNT_ID = '04b8b2073be2f1aa21fc6489e0db36f6';
export const PROBE_DATABASE_NAME = 'sikap-uat-tx-probe';
export const PROBE_DATABASE_ID = '95f86a58-578b-44ac-9016-8472522e8be4';
export const PROBE_BINDING = 'PROBE_DB';
export const PROBE_COMPATIBILITY_DATE = '2026-10-17';
// sha256 of the UTF-8 config text after CRLF -> LF normalization. Any byte change breaks the pin.
export const PROBE_CONFIG_SHA256 = 'e1e7808f45fae903feb1f66da48bb45e6d169553c19dcd13c9d67972a1cc7ad3';
export const PROBE_TARGET = Object.freeze({
  accountId: PROBE_ACCOUNT_ID, databaseName: PROBE_DATABASE_NAME, databaseId: PROBE_DATABASE_ID,
});
const MAX_CONFIG_BYTES = 4096;

export const TARGET_SAFETY = Object.freeze({
  existenceVerified: false, identityVerified: false, emptinessVerified: false,
  remoteExecuted: false, remoteVerified: false, remoteAuthorized: false, authorizesExecution: false,
  sqlAuthorized: false, deployAuthorized: false, cleanupAuthorized: false, transactionAtomicityVerified: false,
  readyForImport: false,
});

const fail = (code) => { throw new ProbeKitError(code); };
if (PROBE_DATABASE_NAME !== PROBE_DB_NAME) fail('PIN_INCONSISTENT');
validateProbeTarget({ ...PROBE_TARGET }); // pinned constants must pass the kit's denylist at load

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Strict line descriptor of the pinned layout: only these keys, one [[d1_databases]] table, plain
// double-quoted values without escapes. Runs only after the exact hash already matched.
const TOP_KEYS = ['name', 'compatibility_date', 'account_id'];
const DB_KEYS = ['binding', 'database_name', 'database_id'];
const LINE_RE = /^([a-z_]+) = "([A-Za-z0-9._-]+)"$/;

function describe(text) {
  const top = {}, db = {};
  let section = top, tables = 0;
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('# ')) continue;
    if (line === '[[d1_databases]]') { if (++tables !== 1) fail('CONFIG_SYNTAX_INVALID'); section = db; continue; }
    const m = line.match(LINE_RE);
    const allowed = section === top ? TOP_KEYS : DB_KEYS;
    if (!m || !allowed.includes(m[1]) || Object.hasOwn(section, m[1])) fail('CONFIG_SYNTAX_INVALID');
    section[m[1]] = m[2];
  }
  if (tables !== 1 || TOP_KEYS.some((k) => !Object.hasOwn(top, k)) || DB_KEYS.some((k) => !Object.hasOwn(db, k))) fail('CONFIG_SYNTAX_INVALID');
  return { top, db };
}

/**
 * Validates caller-supplied config text against the exact pin. Throws ProbeKitError(code) without
 * echoing input. Returns a frozen report; every authorization/verification flag is false.
 */
export function validateProbeConfig(text) {
  if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) fail('CONFIG_INVALID');
  const normalized = text.replaceAll('\r\n', '\n');
  if (normalized.includes('\r')) fail('CONFIG_INVALID');
  if (sha256(normalized) !== PROBE_CONFIG_SHA256) fail('CONFIG_HASH_MISMATCH');
  const { top, db } = describe(normalized);
  if (top.name !== PROBE_DATABASE_NAME || top.compatibility_date !== PROBE_COMPATIBILITY_DATE
    || db.binding !== PROBE_BINDING) fail('CONFIG_DESCRIPTOR_MISMATCH');
  validateProbeTarget({ accountId: top.account_id, databaseName: db.database_name, databaseId: db.database_id });
  if (top.account_id !== PROBE_ACCOUNT_ID || db.database_name !== PROBE_DATABASE_NAME || db.database_id !== PROBE_DATABASE_ID) {
    fail('CONFIG_DESCRIPTOR_MISMATCH');
  }
  return Object.freeze({ valid: true, configHashMatches: true, descriptorSyntaxValid: true,
    configSha256: PROBE_CONFIG_SHA256, binding: PROBE_BINDING, ...TARGET_SAFETY });
}
