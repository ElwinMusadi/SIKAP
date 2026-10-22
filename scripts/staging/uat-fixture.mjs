#!/usr/bin/env node
// Phase 9: synthetic UAT account fixture generator (offline, Node built-ins only).
//
// Produces, into a NEW private directory outside the repository:
//   fixture.sikap-import.sql        guarded SQL that creates exactly 3 synthetic accounts
//   credentials.sikap-fixture.json  the 3 random passwords (private, never printed)
// It never invokes Wrangler, never touches the network, never reads app/cloud config,
// and never changes ACLs/modes/owners of existing paths. The operator reviews the SQL
// and runs it against the isolated UAT database manually.
//
// SQL contract:
//   * Never DELETE/UPDATE. Inserts only, each statement self-guarded.
//   * Statement 1 aborts (json('') -> malformed JSON) unless the application tables
//     are empty (seed tables excepted) and the referenced units/ranks exist.
//   * Not atomic: a CLI may execute statements one by one. If a run stops part-way the
//     fixture is NOT resumable; every later run is rejected by the empty-target guard
//     and the target needs manual recovery (this tool never clears data).
//
// Usage: node scripts/staging/uat-fixture.mjs --out <new private dir> --pepper-file <private file> --purpose synthetic-uat

import { randomBytes as nodeRandomBytes, webcrypto } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  MigrationError, ROOT, canonicalPath, check, isMain, noLinks, persistencePath, readBoundedHandle, safeCode, verifyPrivatePersistence,
} from '../migrate/local-store.mjs';

export const PURPOSE = 'synthetic-uat';
export const ITERATIONS = 10_000; // AUTH_POLICY.pbkdf2Iterations
export const FILES = Object.freeze({ sql: 'fixture.sikap-import.sql', credentials: 'credentials.sikap-fixture.json' });
export const AUDIT_ACTION = 'FIXTURE_UAT_CREATE';
export const AUDIT_DESCRIPTION = 'Created 3 synthetic UAT accounts, no PII';
const MAX_PEPPER_FILE = 1024;

// Deliberate synthetic identities: invalid gender digit (9), year 1900, no real names.
export const FIXTURE_ACCOUNTS = Object.freeze([
  Object.freeze({ label: 'admin', nip: '190001012000019991', nama: 'SINTETIS UAT ADMIN', role: 'Admin', status: 'PNS', pangkat: 'III/a', unitId: 1 }),
  Object.freeze({ label: 'pns', nip: '190002022000029992', nama: 'SINTETIS UAT PNS', role: 'Pegawai', status: 'PNS', pangkat: 'III/a', unitId: 2 }),
  Object.freeze({ label: 'pppk', nip: '190003032000039993', nama: 'SINTETIS UAT PPPK', role: 'Pegawai', status: 'PPPK', pangkat: 'PPPK-IX', unitId: 3 }),
]);
const JABATAN = 'Jabatan Sintetis UAT';
const JENIS_JABATAN = 'Pelaksana';

// Every application table except reference/seed tables (ref_*, jenis_dokumen*, pengaturan).
// kunci_api (0009): a pristine target must not already hold integration API keys.
export const EMPTY_TABLES = Object.freeze([
  'pegawai', 'akun', 'sesi', 'rate_limit', 'arsip_dokumen', 'arsip_dokumen_versi', 'arsip_dokumen_riwayat',
  'pengajuan_perubahan', 'log_aktivitas', 'notifikasi_outbox', 'backup_job', 'backup_part', 'r2_purge_queue',
  'kunci_api',
]);

const encoder = new TextEncoder();
const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

export function isCanonicalPepper(pepper) {
  if (typeof pepper !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(pepper)) return false;
  const bytes = Buffer.from(pepper, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === pepper;
}

// Identical to server/lib/crypto.ts hashPassword: the pepper is used as its literal
// UTF-8 string bytes (NOT base64-decoded) as the HMAC key.
export async function hashPassword(password, pepper, salt) {
  const hmacKey = await webcrypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const peppered = await webcrypto.subtle.sign('HMAC', hmacKey, encoder.encode(password));
  const key = await webcrypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${ITERATIONS}$${Buffer.from(salt).toString('base64')}$${Buffer.from(bits).toString('base64')}`;
}

function uuidFrom(bytes) {
  const b = Buffer.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const nipList = FIXTURE_ACCOUNTS.map((a) => q(a.nip)).join(', ');
const emptyGuard = EMPTY_TABLES.map((t) => `(SELECT count(*) FROM ${t}) = 0`).join('\n    AND ');
const refGuard = [
  '(SELECT count(*) FROM ref_unit_organisasi WHERE aktif = 1 AND id IN (1, 2, 3)) = 3',
  "(SELECT count(*) FROM ref_pangkat_golongan WHERE aktif = 1 AND ((kode = 'III/a' AND jenis_asn = 'PNS') OR (kode = 'PPPK-IX' AND jenis_asn = 'PPPK'))) = 2",
].join('\n    AND ');
// Rows of this run only: fixed NIP + fixed name + this run's unique timestamp.
const runRows = (alias, stamp) => `${alias}.created_at = ${q(stamp)} AND ${alias}.nip IN (${nipList}) AND ${alias}.nama = CASE ${alias}.nip ${
  FIXTURE_ACCOUNTS.map((a) => `WHEN ${q(a.nip)} THEN ${q(a.nama)}`).join(' ')} END`;

export function buildSql({ stamp, runId, hashes }) {
  const otherEmpty = EMPTY_TABLES.filter((t) => t !== 'pegawai' && t !== 'akun').map((t) => `(SELECT count(*) FROM ${t}) = 0`).join('\n    AND ');
  const hashCase = (alias) => `CASE ${alias}.nip ${FIXTURE_ACCOUNTS.map((a, i) => `WHEN ${q(a.nip)} THEN ${q(hashes[i])}`).join(' ')} END`;
  const rows = FIXTURE_ACCOUNTS.map((a) => `SELECT ${q(a.nip)} AS nip, ${q(a.nama)} AS nama, ${q(a.role)} AS role, 'Aktif' AS status_akun, ${
    q(a.status)} AS status_kepegawaian, ${q(a.pangkat)} AS pangkat_kode, ${q(JABATAN)} AS jabatan, ${q(JENIS_JABATAN)} AS jenis_jabatan, ${
    a.unitId} AS unit_id, ${q(stamp)} AS created_at, ${q(stamp)} AS updated_at`).join('\n  UNION ALL ');
  const statements = [
    // 1. Abort guard: json('') raises "malformed JSON" unless the target is empty and refs exist.
    `SELECT json(CASE WHEN ${emptyGuard}\n    AND ${refGuard}\n  THEN '1' ELSE '' END) AS uat_fixture_empty_target_guard`,
    // 2. Pegawai (NIK/email/no_hp/foto stay NULL). Self-guarded: no-op on a non-empty target.
    `INSERT INTO pegawai (nip, nama, role, status_akun, status_kepegawaian, pangkat_kode, jabatan, jenis_jabatan, unit_id, created_at, updated_at)
SELECT f.nip, f.nama, f.role, f.status_akun, f.status_kepegawaian, f.pangkat_kode, f.jabatan, f.jenis_jabatan, f.unit_id, f.created_at, f.updated_at
FROM (${rows}) AS f
WHERE ${emptyGuard}
    AND ${refGuard}`,
    // 3. Akun only for this run's 3 rows, only while no account exists at all (never overwrites).
    `INSERT INTO akun (pegawai_id, password_hash, is_default_password, failed_attempts, locked_until, password_changed_at)
SELECT p.id, ${hashCase('p')}, 0, 0, NULL, ${q(stamp)}
FROM pegawai p
WHERE ${runRows('p', stamp)}
    AND (SELECT count(*) FROM pegawai) = 3
    AND (SELECT count(*) FROM pegawai x WHERE ${runRows('x', stamp)}) = 3
    AND (SELECT count(*) FROM akun) = 0
    AND ${otherEmpty}`,
    // 4. Audit only when exactly these 3 rows carry this run's hashes.
    `INSERT INTO log_aktivitas (ts, actor_id, actor_nip, actor_nama, actor_role, action, target_type, target_id, description, result, ip)
SELECT ${q(stamp)}, NULL, NULL, 'SYSTEM', 'SYSTEM', ${q(AUDIT_ACTION)}, 'SYSTEM', ${q(runId)}, ${q(AUDIT_DESCRIPTION)}, 'SUCCESS', NULL
WHERE (SELECT count(*) FROM pegawai) = 3
    AND (SELECT count(*) FROM akun) = 3
    AND (SELECT count(*) FROM akun a JOIN pegawai p ON p.id = a.pegawai_id
         WHERE ${runRows('p', stamp)} AND a.is_default_password = 0 AND a.password_hash = ${hashCase('p')}) = 3
    AND (SELECT count(*) FROM log_aktivitas) = 0`,
    // 5. Aggregated result (counts only).
    `SELECT (SELECT count(*) FROM pegawai p WHERE ${runRows('p', stamp)}) AS fixture_pegawai,
  (SELECT count(*) FROM akun a JOIN pegawai p ON p.id = a.pegawai_id WHERE ${runRows('p', stamp)}) AS fixture_akun,
  (SELECT count(*) FROM log_aktivitas WHERE action = ${q(AUDIT_ACTION)} AND target_id = ${q(runId)}) AS fixture_audit`,
  ];
  const header = [
    '-- GENERATED by scripts/staging/uat-fixture.mjs for an EMPTY, isolated UAT database only.',
    '-- Creates 3 synthetic accounts (no PII). Inserts only; never DELETE/UPDATE.',
    '-- Not atomic and not resumable: on partial failure stop and recover manually; never re-run.',
  ];
  return { sql: `${header.join('\n')}\n${statements.map((s) => `${s};`).join('\n\n')}\n`, statements: statements.length };
}

export async function prepareUatFixture({ pepper, now, randomPassword, randomBytes } = {}) {
  check(isCanonicalPepper(pepper), 'PEPPER_INVALID');
  check(now instanceof Date && Number.isFinite(now.getTime()), 'NOW_INVALID');
  const rand = randomBytes ?? nodeRandomBytes;
  const nextPassword = randomPassword ?? (() => nodeRandomBytes(24).toString('base64url'));
  const stamp = now.toISOString();
  const passwords = FIXTURE_ACCOUNTS.map(() => nextPassword());
  for (const [i, pw] of passwords.entries()) {
    check(typeof pw === 'string' && pw.length >= 20 && pw.length <= 128 && /^[\x21-\x7e]+$/.test(pw) && !/^\d+$/.test(pw)
      && !pw.includes(FIXTURE_ACCOUNTS[i].nip.slice(-6)), 'PASSWORD_WEAK');
  }
  check(new Set(passwords).size === passwords.length, 'PASSWORD_WEAK');
  const salts = FIXTURE_ACCOUNTS.map(() => Buffer.from(rand(16)));
  check(salts.every((s) => s.length === 16) && new Set(salts.map((s) => s.toString('hex'))).size === salts.length, 'RANDOM_INVALID');
  const nonce = Buffer.from(rand(16));
  check(nonce.length === 16, 'RANDOM_INVALID');
  const runId = uuidFrom(nonce);
  const hashes = [];
  for (const [i, pw] of passwords.entries()) hashes.push(await hashPassword(pw, pepper, salts[i]));
  const { sql, statements } = buildSql({ stamp, runId, hashes });
  const credentials = {
    purpose: PURPOSE, createdAt: stamp, runId,
    accounts: FIXTURE_ACCOUNTS.map((a, i) => ({ label: a.label, nip: a.nip, nama: a.nama, role: a.role, statusKepegawaian: a.status, password: passwords[i] })),
  };
  const summary = {
    purpose: PURPOSE, accounts: 3, admins: 1, pegawai: 2, pns: 2, pppk: 1, statements, defaultPasswords: 0,
  };
  return { sql, credentials, summary };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    check(arg === '--out' || arg === '--pepper-file' || arg === '--purpose', 'CLI_ARGUMENTS');
    const key = arg.slice(2);
    check(!Object.hasOwn(options, key) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'CLI_ARGUMENTS');
    options[key] = argv[++i];
  }
  check(options.out !== undefined && options['pepper-file'] !== undefined && options.purpose !== undefined, 'CLI_ARGUMENTS');
  check(options.purpose === PURPOSE, 'PURPOSE_INVALID');
  for (const value of [options.out, options['pepper-file']]) check(path.isAbsolute(value) && path.resolve(value) === value, 'PATH_ABSOLUTE_REQUIRED');
  return { out: options.out, pepperFile: options['pepper-file'], purpose: options.purpose };
}

// Read-only privacy check (Windows: ACL read via shared helper; POSIX: owner/mode only, no chmod).
async function verifyPrivate(target, code, { exactMode, file = false } = {}) {
  const stat = await lstat(target);
  check(!stat.isSymbolicLink() && (file ? stat.isFile() : stat.isDirectory()), code);
  if (process.platform === 'win32') {
    try { await verifyPrivatePersistence(target); } catch { throw new MigrationError(code); }
  } else {
    check(stat.uid === process.getuid(), code);
    check(exactMode === undefined ? (stat.mode & 0o077) === 0 : (stat.mode & 0o777) === exactMode, code);
  }
}
// persistencePath rejects the repo root, its ancestors and .wrangler; also reject paths inside the repo.
async function outsideRepo(value, code) {
  const target = await persistencePath(value);
  const fromRoot = path.relative(canonicalPath(ROOT), canonicalPath(target));
  check(fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot), code);
  return target;
}
const exists = async (target) => {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

async function readPepper(pepperFile) {
  let target;
  try { target = await outsideRepo(pepperFile, 'PEPPER_FILE_INVALID'); } catch { throw new MigrationError('PEPPER_FILE_INVALID'); }
  try {
    await verifyPrivate(path.dirname(target), 'PEPPER_FILE_PERMISSIONS');
    await verifyPrivate(target, 'PEPPER_FILE_PERMISSIONS', { file: true });
  } catch (error) { if (error.code === 'ENOENT') throw new MigrationError('PEPPER_FILE_INVALID'); throw error; }
  let bytes;
  try {
    const before = await lstat(target, { bigint: true });
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      // The opened handle must still be the same regular, link-free file that passed the privacy check.
      await noLinks(target);
      const opened = await handle.stat({ bigint: true });
      check(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino, 'PEPPER_FILE_INVALID');
      bytes = await readBoundedHandle(handle, MAX_PEPPER_FILE);
    } finally { await handle.close(); }
  } catch { throw new MigrationError('PEPPER_FILE_INVALID'); }
  const pepper = bytes.toString('utf8').replace(/\r?\n$/, '');
  check(isCanonicalPepper(pepper), 'PEPPER_INVALID');
  return pepper;
}

export async function writeUatFixture({ out, pepperFile, purpose }, deps = {}) {
  check(purpose === PURPOSE, 'PURPOSE_INVALID');
  check(typeof out === 'string' && path.isAbsolute(out) && path.resolve(out) === out, 'PATH_ABSOLUTE_REQUIRED');
  check(typeof pepperFile === 'string' && path.isAbsolute(pepperFile) && path.resolve(pepperFile) === pepperFile, 'PATH_ABSOLUTE_REQUIRED');
  const target = await outsideRepo(out, 'OUT_IN_REPO'); // outside repo, not .wrangler, no symlinks
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  const parent = path.dirname(target);
  try { await verifyPrivate(parent, 'PARENT_PERMISSIONS'); }
  catch (error) { if (error.code === 'ENOENT') throw new MigrationError('PARENT_MISSING'); throw error; }
  const pepper = await readPepper(pepperFile);
  const fixture = await prepareUatFixture({ pepper, now: deps.now ?? new Date(), randomPassword: deps.randomPassword, randomBytes: deps.randomBytes });

  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new MigrationError('OUTPUT_EXISTS'); throw error; }
  const created = [];
  try {
    await noLinks(target);
    await verifyPrivate(target, 'OUTPUT_PERMISSIONS', { exactMode: 0o700 });
    for (const [name, value] of [[FILES.sql, fixture.sql], [FILES.credentials, `${JSON.stringify(fixture.credentials, null, 2)}\n`]]) {
      const file = path.join(target, name);
      const handle = await open(file, 'wx', 0o600); // exclusive create: never overwrites
      created.push(file);
      try { await handle.writeFile(value, 'utf8'); } finally { await handle.close(); }
      const stat = await lstat(file);
      check(stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600), 'OUTPUT_PERMISSIONS');
      await noLinks(file);
      await verifyPrivate(file, 'OUTPUT_PERMISSIONS', { file: true, exactMode: 0o600 }); // Windows: read-only ACL check
    }
    return { ...fixture.summary, files: created.length };
  } catch (error) {
    // Remove only what this run created; skip cleanup if the directory was swapped for a link.
    let linked = false;
    try { await noLinks(target); } catch { linked = true; }
    if (!linked) {
      for (const file of created.reverse()) { try { if ((await lstat(file)).isFile()) await unlink(file); } catch { /* best effort */ } }
      try { await rmdir(target); } catch { /* best effort */ }
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = await writeUatFixture(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, code: 'UAT_FIXTURE_READY', ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: safeCode(error) })}\n`);
    process.exitCode = 1;
  }
}
