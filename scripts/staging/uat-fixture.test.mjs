import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLocalStore, ROOT, splitMigration, verifyPrivatePersistence } from '../migrate/local-store.mjs';
import {
  AUDIT_ACTION, AUDIT_DESCRIPTION, EMPTY_TABLES, FILES, FIXTURE_ACCOUNTS, PURPOSE,
  hashPassword, isCanonicalPepper, parseArgs, prepareUatFixture, writeUatFixture,
} from './uat-fixture.mjs';

const PEPPER = Buffer.alloc(32, 7).toString('base64'); // synthetic test pepper
const NOW = new Date('2026-10-17T05:43:47.123Z');
const BASE_TEMP = path.join(tmpdir(), process.platform === 'win32' ? 'kilo' : 'sikap-uat-fixture-tests');

// Test-only: make a NEW empty scratch directory private (mirrors scripts/migrate/pipeline.test.mjs).
const WIN_ACL_SCRIPT = "$ErrorActionPreference='Stop'; try { $p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; " +
  "if((Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count -ne 0){exit 2}; " +
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; " +
  "$a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); " +
  "$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); " +
  "Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch { exit 2 }";
async function privateTemp(t) {
  await mkdir(BASE_TEMP, { recursive: true });
  const temp = await mkdtemp(path.join(BASE_TEMP, 'sikap-uat-fixture-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_ACL_SCRIPT, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, timeout: 10000, env: { ...process.env, SIKAP_SYNTHETIC_TEST_DIRECTORY: temp } });
    assert.equal(r.status, 0, 'private test dir ACL setup failed');
  } else {
    const { chmod } = await import('node:fs/promises');
    await chmod(temp, 0o700);
  }
  return temp;
}
const errorCode = (code) => (error) => error?.code === code;

function nodeVerify(password, stored, pepper) {
  const [prefix, iter, salt, hash] = stored.split('$');
  assert.equal(prefix, 'pbkdf2-sha256');
  assert.equal(iter, '10000');
  assert.equal(Buffer.from(salt, 'base64').length, 16);
  const input = createHmac('sha256', Buffer.from(pepper, 'utf8')).update(password, 'utf8').digest();
  return pbkdf2Sync(input, Buffer.from(salt, 'base64'), 10000, 32, 'sha256').toString('base64') === hash;
}
const hashesIn = (sql) => [...sql.matchAll(/'(pbkdf2-sha256\$[^']+)'/g)].map((m) => m[1]);

async function runSql(db, sql) {
  const results = [];
  for (const statement of splitMigration(sql)) results.push(await db.prepare(statement).all());
  return results;
}
const count = async (db, table) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;

test('pepper validation and hash vector match server format', async () => {
  assert.equal(isCanonicalPepper(PEPPER), true);
  for (const bad of ['', 'short', `${PEPPER}x`, PEPPER.replace(/=$/, ''), Buffer.alloc(31).toString('base64'), Buffer.alloc(32).toString('hex')]) {
    assert.equal(isCanonicalPepper(bad), false);
  }
  // Fixed cross-check vector; this exact string is verified by server verifyPassword in workerd in
  // test/uat-fixture.test.ts. test/uat-fixture-crypto.test.ts (lead) verifies a separate Node vector.
  assert.equal(await hashPassword('Synthetic-Vector-Pass_0123456789', PEPPER, Buffer.alloc(16, 5)),
    'pbkdf2-sha256$10000$BQUFBQUFBQUFBQUFBQUFBQ==$sShNSD5hTZ7wlcCDnnyH/qIsI8vPhtDiI+LVb4BDXEY=');
  // Literal UTF-8 pepper key, not base64-decoded.
  const stored = await hashPassword('Synthetic-Vector-Pass_0123456789', PEPPER, Buffer.alloc(16, 5));
  assert.equal(nodeVerify('Synthetic-Vector-Pass_0123456789', stored, PEPPER), true);
  const decodedInput = createHmac('sha256', Buffer.from(PEPPER, 'base64')).update('Synthetic-Vector-Pass_0123456789').digest();
  assert.notEqual(pbkdf2Sync(decodedInput, Buffer.alloc(16, 5), 10000, 32, 'sha256').toString('base64'), stored.split('$')[3]);
});

test('prepareUatFixture: random independent passwords, valid hashes, no PII, guarded SQL', async () => {
  const { sql, credentials, summary } = await prepareUatFixture({ pepper: PEPPER, now: NOW });
  assert.deepEqual(summary, { purpose: PURPOSE, accounts: 3, admins: 1, pegawai: 2, pns: 2, pppk: 1, statements: 5, defaultPasswords: 0 });
  assert.equal(credentials.accounts.length, 3);
  const passwords = credentials.accounts.map((a) => a.password);
  assert.equal(new Set(passwords).size, 3);
  for (const [i, a] of credentials.accounts.entries()) {
    assert.match(a.password, /^[A-Za-z0-9_-]{32}$/); // randomBytes(24) base64url
    assert.ok(!a.password.includes(a.nip.slice(-6)));
    assert.equal(a.nip, FIXTURE_ACCOUNTS[i].nip);
    assert.match(a.nip, /^\d{18}$/);
    assert.match(a.nama, /^SINTETIS UAT (ADMIN|PNS|PPPK)$/);
  }
  assert.deepEqual(credentials.accounts.map((a) => a.nip), ['190001012000019991', '190002022000029992', '190003032000039993']);
  assert.match(credentials.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const hashes = hashesIn(sql);
  assert.equal(new Set(hashes).size, 3);
  for (const [i, pw] of passwords.entries()) {
    assert.ok(hashes.some((h) => nodeVerify(pw, h, PEPPER)), `hash for account ${i}`);
    assert.ok(!sql.includes(pw), 'password must not appear in SQL');
  }
  const body = splitMigration(sql).join('\n'); // comments stripped
  assert.doesNotMatch(body, /\b(DELETE|UPDATE|DROP|ALTER|REPLACE|UPSERT|ON CONFLICT|PRAGMA|ATTACH)\b/i);
  assert.doesNotMatch(body, /\b(nik|email|no_hp|foto_r2_key)\b/i);
  assert.equal(splitMigration(sql).length, 5);
  for (const t of EMPTY_TABLES) assert.ok(sql.includes(`(SELECT count(*) FROM ${t}) = 0`), t);
  assert.ok(sql.includes("json(CASE WHEN"));
  assert.ok(sql.includes(credentials.runId) && sql.includes(NOW.toISOString()));
  // Two runs differ in passwords, salts and run id.
  const other = await prepareUatFixture({ pepper: PEPPER, now: NOW });
  assert.notEqual(other.credentials.runId, credentials.runId);
  assert.ok(other.credentials.accounts.every((a, i) => a.password !== passwords[i]));
});

test('prepareUatFixture rejects bad inputs and weak injected passwords', async () => {
  await assert.rejects(prepareUatFixture({ pepper: 'x', now: NOW }), errorCode('PEPPER_INVALID'));
  await assert.rejects(prepareUatFixture({ pepper: PEPPER, now: new Date(NaN) }), errorCode('NOW_INVALID'));
  await assert.rejects(prepareUatFixture({ pepper: PEPPER, now: NOW, randomPassword: () => '019991' }), errorCode('PASSWORD_WEAK'));
  await assert.rejects(prepareUatFixture({ pepper: PEPPER, now: NOW, randomPassword: () => '12345678901234567890123' }), errorCode('PASSWORD_WEAK'));
  await assert.rejects(prepareUatFixture({ pepper: PEPPER, now: NOW, randomPassword: () => 'Same-Password-For-All-0001' }), errorCode('PASSWORD_WEAK'));
  await assert.rejects(prepareUatFixture({ pepper: PEPPER, now: NOW, randomBytes: () => Buffer.alloc(16) }), errorCode('RANDOM_INVALID'));
});

test('parseArgs accepts only --out --pepper-file --purpose synthetic-uat', () => {
  const out = path.resolve(BASE_TEMP, 'o'), pf = path.resolve(BASE_TEMP, 'p');
  assert.deepEqual(parseArgs(['--out', out, '--pepper-file', pf, '--purpose', PURPOSE]), { out, pepperFile: pf, purpose: PURPOSE });
  for (const argv of [
    ['--out', out, '--pepper-file', pf],
    ['--out', out, '--pepper-file', pf, '--purpose', 'production'],
    ['--out', out, '--pepper-file', pf, '--purpose', PURPOSE, '--remote'],
    ['--out', out, '--pepper-file', pf, '--purpose', PURPOSE, '--database', 'x'],
    ['--out', out, '--out', out, '--pepper-file', pf, '--purpose', PURPOSE],
    ['--out', 'relative', '--pepper-file', pf, '--purpose', PURPOSE],
  ]) assert.throws(() => parseArgs(argv), (e) => ['CLI_ARGUMENTS', 'PURPOSE_INVALID', 'PATH_ABSOLUTE_REQUIRED'].includes(e.code));
});

test('writeUatFixture rejects repo/.wrangler/existing outputs and bad pepper files', async (t) => {
  const temp = await privateTemp(t);
  const pepperFile = path.join(temp, 'pepper.txt');
  await writeFile(pepperFile, `${PEPPER}\n`, { mode: 0o600 });
  const base = { pepperFile, purpose: PURPOSE };
  await assert.rejects(writeUatFixture({ ...base, out: path.join(ROOT, 'uat-out') }), errorCode('OUT_IN_REPO'));
  await assert.rejects(writeUatFixture({ ...base, out: ROOT }), errorCode('PERSIST_DEDICATED_REQUIRED'));
  await assert.rejects(writeUatFixture({ pepperFile: path.join(ROOT, '.dev.vars'), purpose: PURPOSE, out: path.join(temp, 'x') }), errorCode('PEPPER_FILE_INVALID'));
  await assert.rejects(writeUatFixture({ ...base, out: path.join(temp, '.wrangler', 'x') }), errorCode('PERSIST_DEDICATED_REQUIRED'));
  await assert.rejects(writeUatFixture({ ...base, out: temp }), errorCode('OUTPUT_EXISTS'));
  await assert.rejects(writeUatFixture({ ...base, out: path.join(temp, 'missing', 'x') }), errorCode('PARENT_MISSING'));
  await assert.rejects(writeUatFixture({ ...base, purpose: 'other', out: path.join(temp, 'x') }), errorCode('PURPOSE_INVALID'));
  const badPepper = path.join(temp, 'bad.txt');
  await writeFile(badPepper, 'not-a-pepper', { mode: 0o600 });
  await assert.rejects(writeUatFixture({ pepperFile: badPepper, purpose: PURPOSE, out: path.join(temp, 'x') }), errorCode('PEPPER_INVALID'));
  await assert.rejects(writeUatFixture({ pepperFile: path.join(temp, 'nope.txt'), purpose: PURPOSE, out: path.join(temp, 'x') }), errorCode('PEPPER_FILE_INVALID'));
  await assert.rejects(lstat(path.join(temp, 'x')), { code: 'ENOENT' }); // nothing created on failure
});

test('CLI writes private files, prints counts only, and the SQL executes against migrated D1', { timeout: 120000 }, async (t) => {
  const temp = await privateTemp(t);
  const pepperFile = path.join(temp, 'pepper.txt');
  await writeFile(pepperFile, PEPPER, { mode: 0o600 });
  const out = path.join(temp, 'fixture-out');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'staging', 'uat-fixture.mjs'), '--out', out, '--pepper-file', pepperFile, '--purpose', PURPOSE],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000, shell: false });
  assert.equal(cli.status, 0, cli.stdout);
  const report = JSON.parse(cli.stdout);
  assert.deepEqual(report, { ok: true, code: 'UAT_FIXTURE_READY', purpose: PURPOSE, accounts: 3, admins: 1, pegawai: 2, pns: 2, pppk: 1, statements: 5, defaultPasswords: 0, files: 2 });
  assert.equal(cli.stderr, '');
  const credentials = JSON.parse(await readFile(path.join(out, FILES.credentials), 'utf8'));
  const sql = await readFile(path.join(out, FILES.sql), 'utf8');
  for (const a of credentials.accounts) assert.ok(!cli.stdout.includes(a.password) && !cli.stdout.includes(a.nip));
  if (process.platform !== 'win32') {
    assert.equal((await lstat(out)).mode & 0o777, 0o700);
    for (const f of Object.values(FILES)) assert.equal((await lstat(path.join(out, f))).mode & 0o777, 0o600);
  } else {
    // Read-only Get-Acl proof on the directory AND each secret file (owner = current user, no other Allow entries).
    await verifyPrivatePersistence(out);
    for (const f of Object.values(FILES)) await verifyPrivatePersistence(path.join(out, f));
  }
  // Re-run into the same out dir is refused (never overwrites).
  const again = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'staging', 'uat-fixture.mjs'), '--out', out, '--pepper-file', pepperFile, '--purpose', PURPOSE],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000, shell: false });
  assert.equal(again.status, 1);
  assert.deepEqual(JSON.parse(again.stdout), { ok: false, code: 'OUTPUT_EXISTS' });

  // Execute statement-by-statement (CLI-like, non-atomic) on a freshly migrated isolated D1.
  const store = await openLocalStore(path.join(temp, 'd1-a'));
  try {
    const { db } = store;
    const results = await runSql(db, sql);
    assert.equal(results.length, 5);
    assert.deepEqual(results[4].results[0], { fixture_pegawai: 3, fixture_akun: 3, fixture_audit: 1 });
    const rows = (await db.prepare(`SELECT p.nip, p.nama, p.role, p.status_akun, p.status_kepegawaian, p.pangkat_kode, p.unit_id, p.nik, p.email, p.no_hp, p.foto_r2_key,
      p.deleted_at, a.password_hash, a.is_default_password, a.failed_attempts FROM pegawai p JOIN akun a ON a.pegawai_id = p.id ORDER BY p.nip`).all()).results;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => [r.nip, r.nama, r.role, r.status_akun, r.status_kepegawaian, r.pangkat_kode, r.unit_id]), [
      ['190001012000019991', 'SINTETIS UAT ADMIN', 'Admin', 'Aktif', 'PNS', 'III/a', 1],
      ['190002022000029992', 'SINTETIS UAT PNS', 'Pegawai', 'Aktif', 'PNS', 'III/a', 2],
      ['190003032000039993', 'SINTETIS UAT PPPK', 'Pegawai', 'Aktif', 'PPPK', 'PPPK-IX', 3],
    ]);
    for (const r of rows) {
      assert.deepEqual([r.nik, r.email, r.no_hp, r.foto_r2_key, r.deleted_at, r.is_default_password, r.failed_attempts], [null, null, null, null, null, 0, 0]);
      const account = credentials.accounts.find((a) => a.nip === r.nip);
      assert.equal(nodeVerify(account.password, r.password_hash, PEPPER), true);
      assert.equal(nodeVerify(r.nip.slice(-6), r.password_hash, PEPPER), false);
    }
    const audit = (await db.prepare('SELECT actor_id, actor_nip, actor_nama, actor_role, action, target_type, target_id, description, result FROM log_aktivitas').all()).results;
    assert.deepEqual(audit, [{ actor_id: null, actor_nip: null, actor_nama: 'SYSTEM', actor_role: 'SYSTEM', action: AUDIT_ACTION, target_type: 'SYSTEM',
      target_id: credentials.runId, description: AUDIT_DESCRIPTION, result: 'SUCCESS' }]);
    for (const t2 of ['sesi', 'arsip_dokumen', 'pengajuan_perubahan', 'notifikasi_outbox', 'backup_job', 'r2_purge_queue', 'rate_limit']) assert.equal(await count(db, t2), 0, t2);

    // Re-running the same SQL (or a fresh fixture) aborts on the guard and changes nothing.
    await assert.rejects(db.prepare(splitMigration(sql)[0]).all(), /malformed JSON/i);
    const fresh = await prepareUatFixture({ pepper: PEPPER, now: new Date('2026-10-18T00:00:00.000Z') });
    for (const statement of splitMigration(fresh.sql).slice(1, 4)) await db.prepare(statement).run(); // even if the guard were skipped
    assert.equal(await count(db, 'pegawai'), 3);
    assert.equal(await count(db, 'akun'), 3);
    assert.equal(await count(db, 'log_aktivitas'), 1);
    const after = (await db.prepare('SELECT a.password_hash FROM akun a JOIN pegawai p ON p.id = a.pegawai_id ORDER BY p.nip').all()).results;
    assert.deepEqual(after.map((r) => r.password_hash), rows.map((r) => r.password_hash));
  } finally { await store.close(); }
});

// Independent WebCrypto verification (same primitives workerd exposes).
async function webVerify(password, stored, pepper) {
  const [, iter, salt, hash] = stored.split('$');
  const subtle = globalThis.crypto.subtle, enc = new TextEncoder();
  const hk = await subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const input = await subtle.sign('HMAC', hk, enc.encode(password));
  const pk = await subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Buffer.from(salt, 'base64'), iterations: Number(iter) }, pk, 256);
  return Buffer.from(bits).toString('base64') === hash;
}
const batchOf = (db, sql) => db.batch(splitMigration(sql).map((s) => db.prepare(s)));
async function snapshot(db) {
  const out = {};
  for (const t of [...EMPTY_TABLES, 'ref_unit_organisasi', 'ref_pangkat_golongan', 'pengaturan']) out[t] = await count(db, t);
  out.hashes = (await db.prepare('SELECT a.pegawai_id, a.password_hash FROM akun a ORDER BY a.pegawai_id').all()).results;
  return out;
}

test('D1 batch: pristine target creates 3 accounts + audit atomically; second run is rejected without overwrite', { timeout: 120000 }, async (t) => {
  const temp = await privateTemp(t);
  const store = await openLocalStore(path.join(temp, 'd1-batch-ok'));
  try {
    const { db } = store;
    // EMPTY_TABLES must cover every application table in the migrated schema except seed/reference tables.
    const SEED = ['ref_pangkat_golongan', 'ref_unit_organisasi', 'ref_pendidikan', 'jenis_dokumen', 'jenis_dokumen_wajib', 'pengaturan'];
    const META = ['migration_schema', 'migration_receipt', 'd1_migrations'];
    const tables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all())
      .results.map((r) => r.name).filter((n) => !SEED.includes(n) && !META.includes(n));
    assert.deepEqual(tables, [...EMPTY_TABLES].sort());
    for (const s of SEED) assert.ok((await count(db, s)) > 0 || s === 'jenis_dokumen_wajib', `seed ${s}`);
    const pristine = await snapshot(db);
    for (const table of EMPTY_TABLES) assert.equal(pristine[table], 0, table);
    const { sql, credentials } = await prepareUatFixture({ pepper: PEPPER, now: NOW });
    const results = await batchOf(db, sql);
    assert.equal(results.length, 5);
    assert.deepEqual(results[0].results, [{ uat_fixture_empty_target_guard: '1' }]);
    assert.deepEqual(results.slice(1, 4).map((r) => r.meta.changes), [3, 3, 1]);
    assert.deepEqual(results[4].results, [{ fixture_pegawai: 3, fixture_akun: 3, fixture_audit: 1 }]);

    const rows = (await db.prepare(`SELECT p.*, a.password_hash, a.is_default_password, a.failed_attempts, a.locked_until, a.last_login_at
      FROM pegawai p JOIN akun a ON a.pegawai_id = p.id ORDER BY p.nip`).all()).results;
    assert.equal(rows.length, 3);
    const nullable = ['nik', 'no_hp', 'email', 'alamat', 'foto_r2_key', 'tempat_lahir', 'tanggal_lahir', 'jenis_kelamin', 'agama',
      'pendidikan_kode', 'status_pernikahan', 'golongan_darah', 'tmt_pangkat', 'tmt_jabatan', 'deleted_at', 'deleted_by', 'purge_after',
      'locked_until', 'last_login_at'];
    for (const r of rows) {
      for (const field of nullable) assert.equal(r[field], null, `${r.nip}.${field}`);
      assert.equal(r.is_default_password, 0);
      assert.equal(r.failed_attempts, 0);
      assert.equal(r.status_akun, 'Aktif');
      assert.equal(r.created_at, NOW.toISOString());
      const account = credentials.accounts.find((a) => a.nip === r.nip);
      assert.equal(await webVerify(account.password, r.password_hash, PEPPER), true, `webcrypto ${r.nip}`);
      assert.equal(nodeVerify(account.password, r.password_hash, PEPPER), true, `node ${r.nip}`);
      assert.equal(await webVerify(r.nip.slice(-6), r.password_hash, PEPPER), false);
    }
    assert.deepEqual(rows.map((r) => [r.role, r.status_kepegawaian, r.pangkat_kode, r.unit_id]),
      [['Admin', 'PNS', 'III/a', 1], ['Pegawai', 'PNS', 'III/a', 2], ['Pegawai', 'PPPK', 'PPPK-IX', 3]]);
    // No WhatsApp target can exist: outbox empty and no pegawai has a phone number.
    assert.equal((await db.prepare('SELECT count(*) AS n FROM pegawai WHERE no_hp IS NOT NULL OR email IS NOT NULL').first()).n, 0);
    assert.equal(await count(db, 'notifikasi_outbox'), 0);
    assert.equal(await count(db, 'sesi'), 0);
    const audit = (await db.prepare('SELECT action, target_id, description, actor_nip FROM log_aktivitas').all()).results;
    assert.deepEqual(audit, [{ action: AUDIT_ACTION, target_id: credentials.runId, description: AUDIT_DESCRIPTION, actor_nip: null }]);

    // Second run (same SQL and a fresh fixture): guard throws, batch rolls back, nothing changes.
    const before = await snapshot(db);
    await assert.rejects(batchOf(db, sql), /malformed JSON/i);
    const fresh = await prepareUatFixture({ pepper: PEPPER, now: new Date('2026-10-20T00:00:00.000Z') });
    await assert.rejects(batchOf(db, fresh.sql), /malformed JSON/i);
    assert.deepEqual(await snapshot(db), before);
  } finally { await store.close(); }
});

test('D1 batch: any non-empty application table or missing reference rejects with nothing changed', { timeout: 120000 }, async (t) => {
  const temp = await privateTemp(t);
  const store = await openLocalStore(path.join(temp, 'd1-batch-reject'));
  try {
    const { db } = store;
    const { sql } = await prepareUatFixture({ pepper: PEPPER, now: NOW });
    const pristine = await snapshot(db);
    const attempt = async (label) => {
      const before = await snapshot(db);
      await assert.rejects(batchOf(db, sql), /malformed JSON/i, label);
      assert.deepEqual(await snapshot(db), before, label);
    };
    // One synthetic row per table class that needs no parent rows.
    const fillers = {
      rate_limit: "INSERT INTO rate_limit (key, window_start, count) VALUES ('synthetic', '2026-01-01T00:00:00.000Z', 1)",
      log_aktivitas: "INSERT INTO log_aktivitas (ts, action, result) VALUES ('2026-01-01T00:00:00.000Z', 'SYNTHETIC', 'SUCCESS')",
      notifikasi_outbox: "INSERT INTO notifikasi_outbox (target, template, params, created_at) VALUES ('0', 'test', '{}', '2026-01-01T00:00:00.000Z')",
      pegawai: "INSERT INTO pegawai (nip, nama) VALUES ('190009092000099999', 'SINTETIS LAIN')",
      arsip_dokumen_riwayat: "INSERT INTO arsip_dokumen_riwayat (arsip_id, versi, aksi, created_at) VALUES (1, 1, 'UPLOAD', '2026-01-01T00:00:00.000Z')",
    };
    for (const [table, insert] of Object.entries(fillers)) {
      await db.prepare(insert).run();
      await attempt(`non-empty ${table}`);
      await db.prepare(`DELETE FROM ${table}`).run(); // test removes only its own synthetic row
    }
    for (const [label, broken, restore] of [
      ['inactive unit 3', 'UPDATE ref_unit_organisasi SET aktif = 0 WHERE id = 3', 'UPDATE ref_unit_organisasi SET aktif = 1 WHERE id = 3'],
      ['inactive PPPK-IX', "UPDATE ref_pangkat_golongan SET aktif = 0 WHERE kode = 'PPPK-IX'", "UPDATE ref_pangkat_golongan SET aktif = 1 WHERE kode = 'PPPK-IX'"],
    ]) {
      await db.prepare(broken).run();
      await attempt(label);
      await db.prepare(restore).run();
    }
    await db.prepare("INSERT INTO ref_unit_organisasi (id, nama) VALUES (99, 'Unit Sintetis Sementara')").run();
    await db.prepare('UPDATE ref_unit_organisasi SET id = 98 WHERE id = 2').run(); // unit 2 missing
    await attempt('missing unit 2');
    await db.prepare('UPDATE ref_unit_organisasi SET id = 2 WHERE id = 98').run();
    await db.prepare('DELETE FROM ref_unit_organisasi WHERE id = 99').run();
    assert.deepEqual(await snapshot(db), pristine);
    // Restored pristine target accepts the same fixture.
    const results = await batchOf(db, sql);
    assert.deepEqual(results[4].results, [{ fixture_pegawai: 3, fixture_akun: 3, fixture_audit: 1 }]);
  } finally { await store.close(); }
});

test('guard aborts on non-empty target or missing references; partial runs are not resumed', { timeout: 120000 }, async (t) => {
  const temp = await privateTemp(t);
  const store = await openLocalStore(path.join(temp, 'd1-b'));
  try {
    const { db } = store;
    const { sql } = await prepareUatFixture({ pepper: PEPPER, now: NOW });
    const [guard, insertPegawai, insertAkun, insertAudit] = splitMigration(sql);

    // Any non-seed row (here: one rate_limit row) aborts the guard and blocks every insert.
    await db.prepare("INSERT INTO rate_limit (key, window_start, count) VALUES ('synthetic', '2026-01-01T00:00:00.000Z', 1)").run();
    await assert.rejects(db.prepare(guard).all(), /malformed JSON/i);
    for (const s of [insertPegawai, insertAkun, insertAudit]) await db.prepare(s).run();
    assert.equal(await count(db, 'pegawai'), 0);
    await db.prepare("DELETE FROM rate_limit WHERE key = 'synthetic'").run(); // test cleanup of its own row only

    // Missing/inactive reference unit aborts.
    await db.prepare('UPDATE ref_unit_organisasi SET aktif = 0 WHERE id = 3').run();
    await assert.rejects(db.prepare(guard).all(), /malformed JSON/i);
    await db.prepare(insertPegawai).run();
    assert.equal(await count(db, 'pegawai'), 0);
    await db.prepare('UPDATE ref_unit_organisasi SET aktif = 1 WHERE id = 3').run();

    // Partial run: pegawai inserted, then stop. A new run must not complete or overwrite.
    await db.prepare(guard).all();
    await db.prepare(insertPegawai).run();
    assert.equal(await count(db, 'pegawai'), 3);
    const other = await prepareUatFixture({ pepper: PEPPER, now: new Date('2026-10-19T00:00:00.000Z') });
    const otherStatements = splitMigration(other.sql);
    await assert.rejects(db.prepare(otherStatements[0]).all(), /malformed JSON/i);
    for (const s of otherStatements.slice(1, 4)) await db.prepare(s).run();
    assert.equal(await count(db, 'akun'), 0, 'other run must not attach accounts to a previous run');
    assert.equal(await count(db, 'log_aktivitas'), 0);
    // The original run's remaining statements still complete consistently.
    await db.prepare(insertAkun).run();
    await db.prepare(insertAudit).run();
    assert.equal(await count(db, 'akun'), 3);
    assert.equal(await count(db, 'log_aktivitas'), 1);
  } finally { await store.close(); }
});
