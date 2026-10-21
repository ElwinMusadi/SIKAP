import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, lstat, readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { syntheticFixture, writeFixture } from './fixture.mjs';
import { runCLI, transformExport, wrapLegacyHash } from './transform.mjs';
import { applyLocal } from './apply-local.mjs';
import { reconcileLocal } from './reconcile.mjs';
import { openLocalStore } from './local-store.mjs';

// Preapproved temporary scratch space when available, falling back to os tmpdir.
const PREAPPROVED_TEMP = path.join(tmpdir(), 'kilo');

async function resolveTempBase() {
  try {
    const st = await lstat(PREAPPROVED_TEMP);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      return PREAPPROVED_TEMP;
    }
  } catch {
    // fallback
  }
  return tmpdir();
}

// Explicit test fixture setup only: protect the new unique synthetic directory
// so that all children inherit private permissions compliant with verifyPrivatePersistence.
const WIN_ACL_SCRIPT = "$ErrorActionPreference='Stop'; try { " +
  "$p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; " +
  "if((Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count -ne 0){Write-Error 'NON_EMPTY'; exit 2}; " +
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
  "$a=New-Object System.Security.AccessControl.DirectorySecurity; " +
  "$a.SetOwner($sid); " +
  "$a.SetAccessRuleProtection($true,$false); " +
  "$r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); " +
  "$a.AddAccessRule($r); " +
  "$sys=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); " +
  "$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sys,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); " +
  "$admin=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'); " +
  "$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admin,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); " +
  "Set-Acl -LiteralPath $p -AclObject $a; exit 0 " +
  "} catch { Write-Error $_; exit 2 }";

async function ensurePrivateTestDirectory(targetDir) {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(WIN_ACL_SCRIPT, 'utf16le').toString('base64'),
    ], {
      shell: false,
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8',
      env: { ...process.env, SIKAP_SYNTHETIC_TEST_DIRECTORY: targetDir },
    });
    assert.equal(result.status, 0, 'Private synthetic test root ACL setup failed');
  } else {
    await chmod(targetDir, 0o700);
  }
}

test('Phase 8 synthetic migration pipeline: full chain execution and verification', { timeout: 60000 }, async (t) => {
  const baseTemp = await resolveTempBase();
  const temp = await mkdtemp(path.join(baseTemp, 'sikap-pipeline-'));
  t.after(async () => {
    await rm(temp, { recursive: true, force: true });
  });
  await ensurePrivateTestDirectory(temp);

  const fixtureDir = path.join(temp, 'fixture');
  const planDir = path.join(temp, 'plan');
  const persistTo = path.join(temp, 'isolated-miniflare');

  // Step 1: Generate synthetic export fixture (3 pegawai, 2 arsip, 3 files).
  // Verified to be purely synthetic, inert bytes with no PII.
  const fixtureMeta = await writeFixture(fixtureDir);
  assert.equal(fixtureMeta.employees, 3);
  assert.equal(fixtureMeta.documents, 2);
  assert.equal(fixtureMeta.files, 3);

  // Direct transformExport contract verification on syntheticFixture in-memory
  const inMemoryFixture = syntheticFixture();
  const directPlan = transformExport(inMemoryFixture.snapshot, {
    pepper: 'pipeline-test-pepper',
    salt: Buffer.alloc(32, 7),
  });
  assert.equal(directPlan.ready, true);
  assert.equal(directPlan.expected.pegawai, 3);
  assert.equal(directPlan.expected.arsip, 2);
  assert.equal(directPlan.expected.files, 3);

  // Step 2: Transform synthetic export via CLI into migration plan & SQL artifacts.
  const snapshotPath = path.join(fixtureDir, 'snapshot.sikap-export.json');
  const pepperPath = path.join(fixtureDir, 'fixture.sikap-pepper');
  const saltPath = path.join(fixtureDir, 'fixture.sikap-salt');

  const report = await runCLI([
    '--input', snapshotPath,
    '--out', planDir,
    '--pepper-file', pepperPath,
    '--salt-file', saltPath,
  ]);

  assert.equal(report.ready, true);
  assert.equal(report.expected.pegawai, 3);
  assert.equal(report.expected.arsip, 2);
  assert.equal(report.expected.files, 3);

  const planPath = path.join(planDir, 'plan.sikap-plan.json');
  const filesDir = path.join(fixtureDir, 'files');

  // Step 3: Dry-run apply (apply: false). Validates artifacts, ensures no writes to target.
  const dryRunResult = await applyLocal({ planPath, filesDir, persistTo, apply: false });
  assert.equal(dryRunResult.ok, true);
  assert.equal(dryRunResult.mode, 'dry-run');
  assert.deepEqual(dryRunResult.codes, []);
  assert.equal(dryRunResult.expected.pegawai, 3);
  assert.equal(dryRunResult.expected.arsip, 2);
  assert.equal(dryRunResult.expected.files, 3);
  await assert.rejects(stat(persistTo), { code: 'ENOENT' });

  // Step 4: Apply to isolated Miniflare D1 & R2 store.
  const applyResult = await applyLocal({ planPath, filesDir, persistTo, apply: true });
  assert.equal(applyResult.ok, true);
  assert.equal(applyResult.mode, 'local-apply');
  assert.deepEqual(applyResult.codes, []);
  assert.equal(applyResult.counts.pegawai, 3);
  assert.equal(applyResult.counts.akun, 3);
  assert.equal(applyResult.counts.arsip_dokumen, 2);
  assert.equal(applyResult.files, 3);

  // Step 5: Reconcile local target against plan.
  const reconcileResult = await reconcileLocal({ planPath, filesDir, persistTo });
  assert.equal(reconcileResult.ok, true);
  assert.deepEqual(reconcileResult.codes, []);
  assert.equal(reconcileResult.counts.pegawai, 3);
  assert.equal(reconcileResult.counts.akun, 3);
  assert.equal(reconcileResult.counts.arsip_dokumen, 2);
  assert.equal(reconcileResult.files.verified, 3);
  assert.equal(reconcileResult.files.expected, 3);
  assert.deepEqual(reconcileResult.arsipPerStatus, { Menunggu: 0, Terverifikasi: 1, Ditolak: 1 });
  // Verify report contains only aggregate counts and safe codes, no raw PII
  const serializedReconcile = JSON.stringify(reconcileResult);
  assert.equal(serializedReconcile.includes('Sintetis'), false);
  assert.equal(serializedReconcile.includes('081299990001'), false);

  // Step 6: Apply resume (re-run on completed migration).
  // Idempotent: must succeed with no changes.
  const resumeResult = await applyLocal({ planPath, filesDir, persistTo, apply: true });
  assert.equal(resumeResult.ok, true);
  assert.equal(resumeResult.mode, 'local-apply');

  // Step 7: Verify database records: 3 pegawai phones/statuses and 3 accounts HMAC/PBKDF2 hashes.
  const store = await openLocalStore(persistTo, { initialize: false });
  try {
    const pegawaiRows = await store.db.prepare('SELECT id, nip, nama, no_hp, status_akun, status_kepegawaian FROM pegawai ORDER BY id ASC').all();
    assert.equal(pegawaiRows.results.length, 3);
    for (const row of pegawaiRows.results) {
      assert.equal(row.no_hp, '6281299990001');
      assert.equal(row.status_akun, 'Aktif');
      assert.ok(['PNS', 'PPPK'].includes(row.status_kepegawaian));
    }

    const akunRows = await store.db.prepare('SELECT pegawai_id, password_hash, is_default_password FROM akun ORDER BY pegawai_id ASC').all();
    assert.equal(akunRows.results.length, 3);

    const saltSecret = Buffer.from((await readFile(saltPath, 'utf8')).trim(), 'base64');
    const pepper = (await readFile(pepperPath, 'utf8')).trim();
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));

    for (let i = 0; i < 3; i++) {
      const emp = pegawaiRows.results[i];
      const acc = akunRows.results[i];
      assert.equal(acc.pegawai_id, emp.id);
      assert.equal(acc.is_default_password, 1);

      // Verify legacy-wrap hash structure: legacy-wrap$10000$<salt_b64>$<derived_b64>
      const parts = acc.password_hash.split('$');
      assert.equal(parts.length, 4);
      assert.equal(parts[0], 'legacy-wrap');
      assert.equal(parts[1], '10000');
      const saltBuf = Buffer.from(parts[2], 'base64');
      assert.equal(saltBuf.length, 16);
      const derivedBuf = Buffer.from(parts[3], 'base64');
      assert.equal(derivedBuf.length, 32);

      // Node independent verification using standard HMAC-SHA256 and PBKDF2
      const gasHashHex = snapshot.sheets.Data_Pegawai.rows[i].values[1];
      const expectedSalt = createHmac('sha256', saltSecret).update(snapshot.snapshotId + emp.nip, 'utf8').digest().subarray(0, 16);
      assert.deepEqual(saltBuf, expectedSalt);
      const hmacInput = createHmac('sha256', pepper).update(gasHashHex.toLowerCase(), 'utf8').digest();
      const expectedDerived = pbkdf2Sync(hmacInput, expectedSalt, 10_000, 32, 'sha256');
      assert.deepEqual(derivedBuf, expectedDerived);

      // Verify against wrapLegacyHash algorithm export
      const wrapResult = wrapLegacyHash(gasHashHex, emp.nip, snapshot.snapshotId, pepper, saltSecret);
      assert.equal(acc.password_hash, wrapResult);
    }
  } finally {
    await store.close();
  }

  // Step 8: Mutate file target bytes in R2 bucket; reconcile must detect corruption and fail.
  const targetStore = await openLocalStore(persistTo, { initialize: false });
  try {
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    const targetFile = plan.files[0];
    // Put corrupted bytes into R2 under the same key
    await targetStore.bucket.put(targetFile.r2Key, Buffer.from('MUTATED_CORRUPTED_TARGET_BYTES'), {
      httpMetadata: { contentType: targetFile.mimeType },
      customMetadata: { sha256: 'corrupted' },
    });
  } finally {
    await targetStore.close();
  }

  const corruptReconcile = await reconcileLocal({ planPath, filesDir, persistTo });
  assert.equal(corruptReconcile.ok, false);
  assert.ok(corruptReconcile.codes.includes('R2_SHA256') || corruptReconcile.codes.includes('R2_SIZE'));

  // Step 9: Second clean fresh dry-run; measure elapsed time and record counts without raw PII.
  const freshPersist = path.join(temp, 'fresh-dryrun-target');
  const startMs = performance.now();
  const freshDryRun = await applyLocal({ planPath, filesDir, persistTo: freshPersist, apply: false });
  const elapsedMs = performance.now() - startMs;

  assert.equal(freshDryRun.ok, true);
  assert.equal(freshDryRun.mode, 'dry-run');
  assert.ok(typeof elapsedMs === 'number' && elapsedMs >= 0);
  assert.equal(freshDryRun.expected.pegawai, 3);
  assert.equal(freshDryRun.expected.akun, 3);
  assert.equal(freshDryRun.expected.arsip, 2);
  assert.equal(freshDryRun.expected.files, 3);
  assert.deepEqual(freshDryRun.expected.arsipPerStatus, { Menunggu: 0, Terverifikasi: 1, Ditolak: 1 });

  // Assert target was untouched
  await assert.rejects(stat(freshPersist), { code: 'ENOENT' });

  // Ensure result contains no raw PII
  const freshSerialized = JSON.stringify(freshDryRun);
  assert.equal(freshSerialized.includes('Sintetis'), false);
  assert.equal(freshSerialized.includes('081299990001'), false);
  assert.equal(freshSerialized.includes('6281299990001'), false);
  assert.equal(freshSerialized.includes('19900101'), false);
});
