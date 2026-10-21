import nodeTest from 'node:test';
const test = (name, options, callback) => typeof options === 'function' ? nodeTest(name, { timeout: 60000 }, options) : nodeTest(name, { ...options, timeout: 60000 }, callback);
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyLocal, loadArtifacts, validatePlan } from './apply-local.mjs';
import { reconcileLocal } from './reconcile.mjs';
import { inspectPersistTree, openLocalStore, parseArgs, persistencePath, readBoundedHandle, readBoundedPlan, ROOT, sha256, verifyPrivatePersistence } from './local-store.mjs';
import { IMPORT_TABLES, PLAN_FORMAT } from './contract.mjs';

// Invented identities and inert bytes only. No production/source export is read.
async function fixture(t, employees = 1) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sikap-local-runner-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    // Explicit fixture setup only: protect this brand-new empty synthetic directory.
    // The production runner never changes Windows ACLs or relaxes its verification.
    const script = "$ErrorActionPreference='Stop'; try { $p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; if((Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count -ne 0){exit 2}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch {exit 2}";
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { shell: false, windowsHide: true, timeout: 10000, encoding: 'utf8', env: { ...process.env, SIKAP_SYNTHETIC_TEST_DIRECTORY: temp } });
    assert.equal(result.status, 0, 'Private synthetic fixture setup failed');
  }
  const filesDir = path.join(temp, 'files');
  await mkdir(filesDir);
  const bytes = Buffer.from('%PDF-1.7\nSynthetic local migration fixture\n%%EOF');
  const snapshotId = 'a3d2cbf1-83c2-4e8d-9029-fdbd2bcb4d14';
  const file = { fileId: 'synthetic_file', kind: 'document', r2Key: '', mimeType: 'application/pdf', sizeBytes: bytes.length, sha256: sha256(bytes) };
  file.r2Key = `migration/${snapshotId}/document/${file.fileId}-${file.sha256}.pdf`;
  const tables = Object.fromEntries(IMPORT_TABLES.map((name) => [name, []]));
  tables.jenis_dokumen = [{ id: 'DOC-KTP', nama: 'Synthetic document', kategori: 'Dokumen Pribadi', aktif: 1, urutan: 1, max_size_bytes: 5242880 }];
  tables.jenis_dokumen_wajib = [{ jenis_dokumen_id: 'DOC-KTP', status_kepegawaian: 'PNS' }];
  for (let id = 1; id <= employees; id++) {
    tables.pegawai.push({ id, nip: String(990000000000000000n + BigInt(id)), nama: `Synthetic ${id}`, role: id === 1 ? 'Admin' : 'Pegawai', status_akun: 'Aktif', status_kepegawaian: 'PNS', pangkat_kode: 'III/a', unit_id: 1, pendidikan_kode: 'S1', foto_r2_key: null });
    tables.akun.push({ pegawai_id: id, password_hash: `legacy-wrap$10000$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`, is_default_password: 0 });
  }
  tables.arsip_dokumen = [{ id: 1, pegawai_id: 1, jenis_dokumen_id: 'DOC-KTP', status: 'Menunggu', r2_key: file.r2Key, file_name: 'synthetic.pdf', mime_type: file.mimeType, size_bytes: file.sizeBytes, sha256: file.sha256, uploaded_at: '2026-10-01T00:00:00.000Z', uploaded_by: 1, versi: 1 }];
  tables.arsip_dokumen_riwayat = [{ id: 1, arsip_id: 1, pegawai_id: 1, jenis_dokumen_id: 'DOC-KTP', versi: 1, aksi: 'UPLOAD', status: 'Menunggu', actor_id: 1, created_at: '2026-10-01T00:00:00.000Z' }];
  tables.log_aktivitas = [{ id: 1, ts: '2026-10-01T00:00:00.000Z', actor_id: 1, action: 'SYNTHETIC_IMPORT', result: 'SUCCESS' }];
  const plan = { format: PLAN_FORMAT, version: 1, snapshotId, sourceSha256: sha256('synthetic source'), createdAt: '2026-10-01T00:00:00.000Z', sourceReadOnlyDeclared: true, consistent: false, ready: true, tables, files: [file], expected: { pegawai: employees, akun: employees, arsip: 1, files: 1, totalFileBytes: bytes.length, arsipPerStatus: { Menunggu: 1, Terverifikasi: 0, Ditolak: 0 } }, diagnostics: [] };
  const options = { planPath: path.join(temp, 'plan.json'), filesDir, persistTo: path.join(temp, 'isolated-target'), apply: true };
  const save = () => writeFile(options.planPath, JSON.stringify(plan));
  await save(); await writeFile(path.join(filesDir, `${file.fileId}.bin`), bytes);
  return { temp, options, plan, file, bytes, save };
}
async function using(options, callback) {
  const store = await openLocalStore(options.persistTo);
  try { return await callback(store); } finally { await store.close(); }
}
const errorCode = (code) => (error) => error.code === code;

test('dry-run is default, validates artifacts, creates no local storage', async (t) => {
  const f = await fixture(t);
  const result = await applyLocal({ ...f.options, apply: false });
  assert.equal(result.mode, 'dry-run');
  await assert.rejects(stat(f.options.persistTo), { code: 'ENOENT' });
});

test('actual D1/R2 apply is idempotent and reconciles private counts', async (t) => {
  const f = await fixture(t);
  assert.equal((await applyLocal(f.options)).ok, true);
  assert.equal((await applyLocal(f.options)).ok, true);
  const report = await reconcileLocal(f.options);
  assert.equal(report.ok, true);
  assert.equal(report.counts.pegawai, 1);
  assert.equal(report.files.verified, 1);
  assert.equal(JSON.stringify(report).includes('Synthetic'), false);
  await using(f.options, async ({ db }) => {
    assert.equal((await db.prepare('SELECT complete FROM migration_receipt').first()).complete, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM notifikasi_outbox').first()).count, 0);
  });
});

test('same snapshot with modified plan is refused without target writes', async (t) => {
  const f = await fixture(t);
  await applyLocal(f.options);
  f.plan.tables.pegawai[0].nama = 'Changed synthetic'; await f.save();
  await assert.rejects(applyLocal(f.options), errorCode('RECEIPT_MISMATCH'));
  await using(f.options, async ({ db }) => assert.equal((await db.prepare('SELECT nama FROM pegawai').first()).nama, 'Synthetic 1'));
});

test('all files validated before creating DB or putting objects', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.options.filesDir, `${f.file.fileId}.bin`), Buffer.alloc(f.bytes.length));
  await assert.rejects(applyLocal(f.options), errorCode('FILE_SHA256'));
  await assert.rejects(stat(f.options.persistTo), { code: 'ENOENT' });
});

test('rejects traversal keys, columns, duplicate ids, unexpected flags and default storage', async (t) => {
  const f = await fixture(t);
  const invalid = structuredClone(f.plan); invalid.files[0].fileId = '../outside';
  assert.throws(() => validatePlan(invalid), errorCode('PLAN_FILE'));
  const sql = structuredClone(f.plan); sql.tables.pegawai[0]['name); DROP TABLE akun; --'] = 'x';
  assert.throws(() => validatePlan(sql), errorCode('PLAN_COLUMNS'));
  const duplicate = structuredClone(f.plan); duplicate.tables.pegawai.push(duplicate.tables.pegawai[0]);
  assert.throws(() => validatePlan(duplicate), errorCode('PLAN_DUPLICATE_ID'));
  assert.throws(() => parseArgs(['--remote']), errorCode('CLI_ARGUMENTS'));
  assert.throws(() => parseArgs(['--apply', '--dry-run']), errorCode('CLI_ARGUMENTS'));
  await assert.rejects(persistencePath(ROOT), errorCode('PERSIST_DEDICATED_REQUIRED'));
  await assert.rejects(persistencePath(path.join(ROOT, '.wrangler', 'state')), errorCode('PERSIST_DEDICATED_REQUIRED'));
  await assert.rejects(persistencePath('relative-target'), errorCode('PERSIST_ABSOLUTE_REQUIRED'));
});

test('symlink/junction files directories are refused', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.temp, 'linked-files');
  await symlink(f.options.filesDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyLocal({ ...f.options, filesDir: link }), errorCode('PATH_SYMLINK'));
});

test('existing nonempty application target without receipt is refused', async (t) => {
  const f = await fixture(t);
  await using(f.options, async ({ db }) => db.prepare("INSERT INTO pegawai (id, nip, nama) VALUES (9, '990000000000000009', 'Existing synthetic')").run());
  await assert.rejects(applyLocal(f.options), errorCode('TARGET_NOT_EMPTY'));
  await using(f.options, async ({ db }) => assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM migration_receipt').first()).count, 0));
});

test('SQL batch failure rolls back rows and receipt cursor; exact plan resumes', async (t) => {
  const f = await fixture(t, 201);
  await using(f.options, async ({ db }) => db.prepare("CREATE TRIGGER synthetic_failure BEFORE INSERT ON pegawai WHEN NEW.id = 201 BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END").run());
  await assert.rejects(applyLocal(f.options));
  await using(f.options, async ({ db }) => {
    const receipt = await db.prepare('SELECT * FROM migration_receipt').first();
    assert.equal(receipt.stage, 2); assert.equal(receipt.cursor, 200); assert.equal(receipt.complete, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM pegawai').first()).count, 200);
    await db.prepare('DROP TRIGGER synthetic_failure').run();
  });
  assert.equal((await applyLocal(f.options)).ok, true);
  assert.equal((await reconcileLocal(f.options)).ok, true);
});

test('reconciliation detects missing, modified and unexpected R2 objects', async (t) => {
  const f = await fixture(t);
  await applyLocal(f.options);
  await using(f.options, async ({ bucket }) => bucket.delete(f.file.r2Key));
  assert.deepEqual((await reconcileLocal(f.options)).codes, ['R2_MISSING']);
  // Resume must recheck and restore only an absent exact migration key.
  await applyLocal(f.options);
  await using(f.options, async ({ bucket }) => { await bucket.put(f.file.r2Key, Buffer.alloc(f.bytes.length), { httpMetadata: { contentType: f.file.mimeType } }); });
  assert.deepEqual((await reconcileLocal(f.options)).codes, ['R2_SHA256']);
  await assert.rejects(applyLocal(f.options), errorCode('R2_CONFLICT'));
  await using(f.options, async ({ bucket }) => {
    await bucket.put(f.file.r2Key, f.bytes, { httpMetadata: { contentType: f.file.mimeType } });
    await bucket.put(`migration/${f.plan.snapshotId}/unexpected`, 'synthetic');
  });
  assert.deepEqual((await reconcileLocal(f.options)).codes, ['R2_UNEXPECTED_OBJECT']);
});

test('reconciliation detects changed DB row, extra row and count/status mismatch', async (t) => {
  const f = await fixture(t);
  await applyLocal(f.options);
  await using(f.options, async ({ db }) => {
    await db.prepare("UPDATE arsip_dokumen SET status = 'Ditolak' WHERE id = 1").run();
    await db.prepare("INSERT INTO log_aktivitas (id, ts, action, result) VALUES (2, '2026-10-01T00:00:00.000Z', 'SYNTHETIC', 'SUCCESS')").run();
  });
  const report = await reconcileLocal(f.options);
  assert.equal(report.ok, false); assert.ok(report.codes.includes('DB_ROW_MISMATCH')); assert.ok(report.codes.includes('DB_COUNT')); assert.ok(report.codes.includes('DB_STATUS'));
  await assert.rejects(applyLocal(f.options), errorCode('TARGET_CHANGED'));
});

test('actual CLI apply, resume and reconcile terminate successfully', { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const args = ['--plan', f.options.planPath, '--files', f.options.filesDir, '--persist-to', f.options.persistTo];
  const run = (name, extra = []) => spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args, ...extra], { shell: false, encoding: 'utf8', timeout: 15000 });
  const applied = run('./apply-local.mjs', ['--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).mode, 'local-apply');
  const resumed = run('./apply-local.mjs', ['--apply']);
  assert.equal(resumed.status, 0, resumed.stderr);
  const reconciled = run('./reconcile.mjs');
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.equal(JSON.parse(reconciled.stdout).ok, true);
  await using(f.options, async ({ bucket }) => { await bucket.delete(f.file.r2Key); });
  const missing = run('./reconcile.mjs');
  assert.equal(missing.status, 1, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout).codes, ['R2_MISSING']);
});

test('receipt no-op aborts the entire chunk rather than leaving uncheckpointed rows', async (t) => {
  const f = await fixture(t);
  await using(f.options, async ({ db }) => {
    await db.prepare('CREATE TRIGGER synthetic_receipt_noop BEFORE UPDATE ON migration_receipt BEGIN SELECT RAISE(IGNORE); END').run();
  });
  await assert.rejects(applyLocal(f.options));
  await using(f.options, async ({ db }) => {
    const receipt = await db.prepare('SELECT * FROM migration_receipt').first();
    assert.equal(receipt.stage, 0); assert.equal(receipt.cursor, 0); assert.equal(receipt.complete, 0);
    assert.equal((await db.prepare("SELECT nama FROM jenis_dokumen WHERE id = 'DOC-KTP'").first()).nama, 'Kartu Tanda Penduduk (KTP)');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jenis_dokumen_wajib').first()).count, 22);
    await db.prepare('DROP TRIGGER synthetic_receipt_noop').run();
  });
  assert.equal((await applyLocal(f.options)).ok, true);
});

test('child persistence links block apply/reconcile before writes to either tree', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.temp, 'outside'); await mkdir(outside);
  const marker = path.join(outside, 'marker'); await writeFile(marker, 'unchanged');
  await mkdir(f.options.persistTo);
  await symlink(outside, path.join(f.options.persistTo, 'r2'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyLocal(f.options), errorCode('PERSIST_SYMLINK'));
  await assert.rejects(reconcileLocal(f.options), errorCode('PERSIST_SYMLINK'));
  assert.equal(await readFile(marker, 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(outside), ['marker']);
  assert.deepEqual(await readdir(f.options.persistTo), ['r2']);
});

test('existing populated target child junction blocks resume and reconcile without changing DB or R2', async (t) => {
  const f = await fixture(t); await applyLocal(f.options);
  const r2 = path.join(f.options.persistTo, 'r2'), outside = path.join(f.temp, 'outside-r2');
  const files = async (root) => {
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const name = path.join(root, entry.name);
      if (entry.isDirectory()) result.push(...await files(name)); else result.push([path.relative(root, name), sha256(await readFile(name))]);
    }
    return result;
  };
  await rename(r2, outside);
  const before = await files(outside);
  await symlink(outside, r2, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(applyLocal(f.options), errorCode('PERSIST_SYMLINK'));
  await assert.rejects(reconcileLocal(f.options), errorCode('PERSIST_SYMLINK'));
  assert.deepEqual(await files(outside), before);
  await rm(r2); await rename(outside, r2);
  assert.equal((await reconcileLocal(f.options)).ok, true);
});

for (const [name, damage, mutate, code] of [
  ['deleted unit', "DELETE FROM ref_unit_organisasi WHERE id = 3", (row) => { row.unit_id = 3; }, 'TARGET_REFERENCE_MISSING'],
  ['deleted rank', "DELETE FROM ref_pangkat_golongan WHERE kode = 'III/b'", (row) => { row.pangkat_kode = 'III/b'; }, 'TARGET_REFERENCE_MISSING'],
  ['deleted education', "DELETE FROM ref_pendidikan WHERE kode = 'S2'", (row) => { row.pendidikan_kode = 'S2'; }, 'TARGET_REFERENCE_MISSING'],
  ['changed rank family', "UPDATE ref_pangkat_golongan SET jenis_asn = 'PPPK' WHERE kode = 'III/c'", (row) => { row.pangkat_kode = 'III/c'; }, 'TARGET_REFERENCE_MISMATCH'],
]) test(`actual target ${name} is refused before receipt, objects or rows`, async (t) => {
  const f = await fixture(t, 201); mutate(f.plan.tables.pegawai[200]); await f.save();
  await using(f.options, async ({ db }) => { await db.prepare(damage).run(); });
  await assert.rejects(applyLocal(f.options), errorCode(code));
  await using(f.options, async ({ db, bucket }) => {
    for (const table of ['pegawai', 'akun', 'migration_receipt', 'arsip_dokumen', 'log_aktivitas']) assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0);
    assert.equal((await bucket.list()).objects.length, 0);
    assert.equal((await db.prepare("SELECT nama FROM jenis_dokumen WHERE id = 'DOC-KTP'").first()).nama, 'Kartu Tanda Penduduk (KTP)');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jenis_dokumen_wajib').first()).count, 22);
  });
});

test('reconciliation reports target reference drift after import', async (t) => {
  const f = await fixture(t); await applyLocal(f.options);
  await using(f.options, async ({ db }) => { await db.prepare("UPDATE ref_pangkat_golongan SET jenis_asn = 'PPPK' WHERE kode = 'III/a'").run(); });
  const report = await reconcileLocal(f.options);
  assert.equal(report.ok, false); assert.ok(report.codes.includes('TARGET_REFERENCE_MISMATCH'));
});

test('persistent tree scan is bounded by nodes and byte sizes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(inspectPersistTree(f.options.filesDir, { maxNodes: 1 }), errorCode('PERSIST_TREE_LIMIT'));
  await assert.rejects(inspectPersistTree(f.options.filesDir, { maxBytes: 1 }), errorCode('PERSIST_TREE_LIMIT'));
});

for (const [name, mutate] of [
  ['201st invalid unit', (p) => { p.tables.pegawai[200].unit_id = 99; }],
  ['duplicate NIP', (p) => { p.tables.pegawai[200].nip = p.tables.pegawai[0].nip; }],
  ['duplicate NIK', (p) => { p.tables.pegawai[0].nik = p.tables.pegawai[200].nik = '9900000000000001'; }],
  ['numeric NIP', (p) => { p.tables.pegawai[200].nip = Number('990000000000000000'); }],
  ['numeric NIK', (p) => { p.tables.pegawai[200].nik = Number('9900000000000001'); }],
  ['unknown rank', (p) => { p.tables.pegawai[200].pangkat_kode = 'V/a'; }],
  ['rank family', (p) => { p.tables.pegawai[200].pangkat_kode = 'PPPK-IX'; }],
  ['unknown education', (p) => { p.tables.pegawai[200].pendidikan_kode = 'S9'; }],
  ['invalid enum', (p) => { p.tables.pegawai[200].role = 'Root'; }],
  ['invalid date', (p) => { p.tables.pegawai[200].tanggal_lahir = '2026-02-30'; }],
  ['invalid text length', (p) => { p.tables.pegawai[200].nama = 'a'.repeat(151); }],
  ['duplicate archive slot', (p) => { p.tables.arsip_dokumen.push({ ...p.tables.arsip_dokumen[0], id: 2 }); }],
  ['account foreign key', (p) => { p.tables.akun[200].pegawai_id = 999; }],
  ['archive actor foreign key', (p) => { p.tables.arsip_dokumen[0].verified_by = 999; }],
  ['history actor foreign key', (p) => { p.tables.arsip_dokumen_riwayat[0].actor_id = 999; }],
  ['history archive foreign key', (p) => { p.tables.arsip_dokumen_riwayat[0].arsip_id = 999; }],
]) test(`whole-plan preflight rejects ${name} without target creation`, async (t) => {
  const f = await fixture(t, 201); mutate(f.plan); await f.save();
  for (const apply of [false, true]) await assert.rejects(applyLocal({ ...f.options, apply }));
  await assert.rejects(stat(f.options.persistTo), { code: 'ENOENT' });
});

test('omitted security fields use safe defaults and full-row reconciliation detects tampering', async (t) => {
  const f = await fixture(t);
  delete f.plan.tables.pegawai[0].role; delete f.plan.tables.pegawai[0].status_akun; delete f.plan.tables.pegawai[0].foto_r2_key;
  await f.save();
  const rawHash = sha256(await readFile(f.options.planPath));
  const canonical = await loadArtifacts(f.options);
  assert.equal(canonical.plan.tables.pegawai[0].role, 'Pegawai');
  assert.equal(canonical.plan.tables.pegawai[0].foto_r2_key, null);
  assert.equal(canonical.planSha256, rawHash);
  await applyLocal(f.options);
  await using(f.options, async ({ db }) => {
    assert.equal((await db.prepare('SELECT plan_sha256 FROM migration_receipt').first()).plan_sha256, rawHash);
    await db.prepare("UPDATE pegawai SET role = 'Admin', status_akun = 'Nonaktif', foto_r2_key = 'unexpected' WHERE id = 1").run();
  });
  assert.ok((await reconcileLocal(f.options)).codes.includes('DB_ROW_MISMATCH'));
  await assert.rejects(applyLocal(f.options), errorCode('TARGET_CHANGED'));
});

test('partial master import preserves unrelated seeded required-document rows', async (t) => {
  const f = await fixture(t); await applyLocal(f.options);
  await using(f.options, async ({ db }) => {
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM jenis_dokumen_wajib WHERE jenis_dokumen_id <> 'DOC-KTP'").first()).count, 19);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM jenis_dokumen_wajib WHERE jenis_dokumen_id = 'DOC-KTP'").first()).count, 1);
  });
  assert.equal((await reconcileLocal(f.options)).ok, true);
});

test('bounded plan reads reject oversized and growing handles', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readBoundedPlan(f.options.planPath, 2), errorCode('PLAN_SIZE'));
  let reads = 0;
  const growing = { stat: async () => ({ isFile: () => true, size: 1 }), read: async (buffer) => { reads++; buffer.fill(65); return { bytesRead: buffer.length }; } };
  await assert.rejects(readBoundedHandle(growing, 3), errorCode('PLAN_SIZE'));
  assert.equal(reads, 1);
});

test('case variants of default storage and ancestors are rejected', async () => {
  await assert.rejects(persistencePath(path.join(ROOT, '.WRANGLER', 'state')), errorCode('PERSIST_DEDICATED_REQUIRED'));
  if (process.platform === 'win32') {
    await assert.rejects(persistencePath(ROOT.toUpperCase()), errorCode('PERSIST_DEDICATED_REQUIRED'));
    await assert.rejects(persistencePath(path.dirname(ROOT).toUpperCase()), errorCode('PERSIST_DEDICATED_REQUIRED'));
  }
});

test('privacy verification fails closed for broad Windows ACL or enforces POSIX owner-only mode', async (t) => {
  const f = await fixture(t);
  if (process.platform === 'win32') {
    const insecure = path.join(f.temp, 'explicit-insecure-synthetic'); await mkdir(insecure);
    // Explicit negative-test ACL only on this newly created synthetic directory.
    const script = "$ErrorActionPreference='Stop'; try { $p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; $a=Get-Acl -LiteralPath $p; $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch {exit 2}";
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { shell: false, windowsHide: true, timeout: 10000, encoding: 'utf8', env: { ...process.env, SIKAP_SYNTHETIC_TEST_DIRECTORY: insecure } });
    assert.equal(result.status, 0, 'Synthetic negative-test ACL setup failed');
    await assert.rejects(verifyPrivatePersistence(insecure), errorCode('PERSIST_PERMISSIONS'));
  } else {
    await verifyPrivatePersistence(f.temp);
    assert.equal((await stat(f.temp)).mode & 0o777, 0o700);
  }
});

test('CLI failures expose codes only and no arbitrary local path or raw values', async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL('./apply-local.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--plan', f.options.planPath, '--files', f.options.filesDir, '--persist-to', f.options.persistTo, '--remote'], { shell: false, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, codes: ['CLI_ARGUMENTS'] });
  assert.equal((await readFile(f.options.planPath, 'utf8')).includes('Synthetic'), true);
  assert.equal((await loadArtifacts(f.options)).plan.ready, true);
});
