import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBE_CONFIG_PATH, PROBE_ACCOUNT_ID, PROBE_DATABASE_NAME, PROBE_DATABASE_ID, PROBE_BINDING, PROBE_COMPATIBILITY_DATE,
  PROBE_CONFIG_SHA256, PROBE_TARGET, TARGET_SAFETY, validateProbeConfig,
} from './d1-tx-probe-target.mjs';
import { PROBE_DB_NAME, ProbeKitError, validateProbeTarget } from './d1-tx-probe-kit.mjs';
import { BASELINE_DENY } from './uat-target.mjs';
import { UAT_ACCOUNT, UAT_DB } from './uat-constants.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const RAW = readFileSync(path.join(root, PROBE_CONFIG_PATH), 'utf8');
const CONFIG = RAW.replaceAll('\r\n', '\n');
const SOURCE = readFileSync(path.join(here, 'd1-tx-probe-target.mjs'), 'utf8');
const SECRET = 'TOPSECRET-cf-token-should-never-echo';
const code = (expected) => (e) => e instanceof ProbeKitError && e.code === expected && e.message === expected && !String(e.stack).includes(SECRET);
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

test('pinned constants equal the approved probe database and pass the kit target check', () => {
  assert.equal(PROBE_ACCOUNT_ID, '04b8b2073be2f1aa21fc6489e0db36f6');
  assert.equal(PROBE_ACCOUNT_ID, UAT_ACCOUNT);
  assert.equal(PROBE_DATABASE_NAME, 'sikap-uat-tx-probe');
  assert.equal(PROBE_DATABASE_NAME, PROBE_DB_NAME);
  assert.equal(PROBE_DATABASE_ID, '95f86a58-578b-44ac-9016-8472522e8be4');
  assert.equal(PROBE_BINDING, 'PROBE_DB');
  assert.equal(PROBE_COMPATIBILITY_DATE, '2026-10-17');
  assert.equal(PROBE_CONFIG_SHA256, 'e1e7808f45fae903feb1f66da48bb45e6d169553c19dcd13c9d67972a1cc7ad3');
  assert.ok(Object.isFrozen(PROBE_TARGET) && Object.isFrozen(TARGET_SAFETY));
  assert.equal(validateProbeTarget({ ...PROBE_TARGET }).valid, true);
  for (const denied of [...BASELINE_DENY.databaseIds, UAT_DB]) assert.notEqual(PROBE_DATABASE_ID, denied);
  for (const denied of [...BASELINE_DENY.databaseNames, 'sikap-uat-db']) assert.notEqual(PROBE_DATABASE_NAME, denied);
});

test('local config digest matches the pin and the report authorizes nothing', () => {
  assert.equal(sha(CONFIG), PROBE_CONFIG_SHA256);
  const r = validateProbeConfig(RAW);
  assert.ok(Object.isFrozen(r));
  assert.equal(r.valid, true); assert.equal(r.configHashMatches, true); assert.equal(r.descriptorSyntaxValid, true);
  assert.equal(r.binding, PROBE_BINDING); assert.equal(r.configSha256, PROBE_CONFIG_SHA256);
  for (const [k, v] of Object.entries(TARGET_SAFETY)) { assert.equal(v, false, k); assert.equal(r[k], false, k); }
  assert.deepEqual(Object.keys(r).filter((k) => r[k] === true).sort(), ['configHashMatches', 'descriptorSyntaxValid', 'valid']);
  assert.ok(!JSON.stringify(r).includes(PROBE_DATABASE_ID) && !JSON.stringify(r).includes(PROBE_ACCOUNT_ID), 'no echo');
  assert.equal(validateProbeConfig(CONFIG.replaceAll('\n', '\r\n')).valid, true, 'CRLF checkout normalizes to the same pin');
});

test('config file is config-only: exact keys, one binding, no app/preview/prod/UAT resources', () => {
  const lines = CONFIG.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  assert.deepEqual(lines, [
    'name = "sikap-uat-tx-probe"', 'compatibility_date = "2026-10-17"', 'account_id = "04b8b2073be2f1aa21fc6489e0db36f6"',
    '[[d1_databases]]', 'binding = "PROBE_DB"', 'database_name = "sikap-uat-tx-probe"',
    'database_id = "95f86a58-578b-44ac-9016-8472522e8be4"',
  ]);
  const body = lines.join('\n');
  for (const forbidden of ['main', 'pages_build_output_dir', 'route', 'triggers', 'crons', 'r2_buckets', '[vars]', '[env',
    'preview_database_id', 'migrations_dir', 'workers_dev', 'compatibility_flags']) assert.ok(!body.includes(forbidden), forbidden);
  for (const id of [...BASELINE_DENY.databaseIds, UAT_DB]) assert.ok(!CONFIG.includes(id), 'no prod/preview/UAT database id');
  for (const n of [...BASELINE_DENY.databaseNames, 'sikap-uat-db', ...BASELINE_DENY.buckets]) assert.ok(!body.includes(`"${n}"`), n);
});

test('any source change, extra binding, vars, env or injection is rejected without echo', () => {
  const swap = (a, b) => CONFIG.replace(a, b);
  const mutations = [
    swap(PROBE_DATABASE_ID, '95f86a58-578b-44ac-9016-8472522e8be5'),
    swap(PROBE_DATABASE_ID, UAT_DB), swap(PROBE_DATABASE_ID, BASELINE_DENY.databaseIds[0]), swap(PROBE_DATABASE_ID, BASELINE_DENY.databaseIds[1]),
    swap(PROBE_DATABASE_ID, PROBE_DATABASE_ID.toUpperCase()),
    swap('database_name = "sikap-uat-tx-probe"', 'database_name = "sikap-db"'),
    swap('database_name = "sikap-uat-tx-probe"', 'database_name = "sikap-db-preview"'),
    swap('database_name = "sikap-uat-tx-probe"', 'database_name = "sikap-uat-db"'),
    swap('binding = "PROBE_DB"', 'binding = "DB"'), swap(PROBE_ACCOUNT_ID, 'ffffffffffffffffffffffffffffffff'),
    swap('2026-10-17', '2026-10-18'),
    `${CONFIG}\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "sikap-uat-db"\ndatabase_id = "${UAT_DB}"\n`,
    `${CONFIG}preview_database_id = "${BASELINE_DENY.databaseIds[1]}"\n`,
    `${CONFIG}\n[vars]\nTOKEN = "${SECRET}"\n`,
    `${CONFIG}\n[env.production]\nname = "sikap"\n`,
    `${CONFIG}\n[[r2_buckets]]\nbinding = "FILES"\nbucket_name = "sikap-files"\n`,
    `main = "worker.js"\n${CONFIG}`, `${CONFIG}\n[triggers]\ncrons = ["* * * * *"]\n`,
    swap(PROBE_DATABASE_ID, `${PROBE_DATABASE_ID}"; DROP TABLE pegawai; --`),
    swap('sikap-uat-tx-probe"\ncompat', `sikap-uat-tx-probe' OR 1=1 --"\ncompat`),
    swap('# Isolated', `# ${SECRET}`), `${CONFIG}\n`, CONFIG.trimEnd(), ` ${CONFIG}`, `\uFEFF${CONFIG}`,
    CONFIG.replaceAll('\n', '\r'),
  ];
  for (const text of mutations) {
    assert.notEqual(text, CONFIG);
    assert.throws(() => validateProbeConfig(text), (e) => code('CONFIG_HASH_MISMATCH')(e) || code('CONFIG_INVALID')(e));
  }
  for (const bad of [undefined, null, 42, '', {}, [CONFIG], Buffer.from(CONFIG), 'x'.repeat(5000)]) {
    assert.throws(() => validateProbeConfig(bad), code('CONFIG_INVALID'));
  }
});

test('module is pure: no CLI, spawn, network, file system, env or dynamic import', () => {
  const imports = [...SOURCE.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./d1-tx-probe-kit.mjs', 'node:crypto']);
  const src = SOURCE.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*')
    && !l.trimStart().startsWith('/**')).map((l) => l.replace(/ \/\/ .*$/, '')).join('\n');
  for (const pattern of [/child_process/, /node:fs|['"]fs['"]/, /node:(net|http|https|dns|tls|os|path)/, /process\./, /\bfetch\(/,
    /import\(/, /readFile|writeFile|spawn|exec\(|execFile|wrangler d1/, /process\.argv|import\.meta\.main/]) {
    assert.doesNotMatch(src, pattern, String(pattern));
  }
});
