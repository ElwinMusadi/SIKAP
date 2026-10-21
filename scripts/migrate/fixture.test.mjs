import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { syntheticFixture, writeFixture } from './fixture.mjs';
import { EXPORT_FORMAT, VERSION, SOURCE_SHEETS } from './contract.mjs';

const PREAPPROVED_TEMP = path.join(os.tmpdir(), 'kilo');
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

async function resolveTempBase() {
  try {
    const st = await fs.lstat(PREAPPROVED_TEMP);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      return PREAPPROVED_TEMP;
    }
  } catch {
    // fallback
  }
  return os.tmpdir();
}

describe('syntheticFixture contract and integrity', () => {
  it('is deterministic across invocations without generating random secrets', () => {
    const run1 = syntheticFixture();
    const run2 = syntheticFixture();

    assert.deepEqual(run1.snapshot, run2.snapshot);
    assert.equal(run1.files.length, run2.files.length);
    for (let i = 0; i < run1.files.length; i++) {
      assert.equal(run1.files[i].fileId, run2.files[i].fileId);
      assert.equal(run1.files[i].mimeType, run2.files[i].mimeType);
      assert.ok(run1.files[i].bytes.equals(run2.files[i].bytes));
    }

    assert.equal(typeof run1.snapshot.snapshotId, 'string');
    assert.match(run1.snapshot.snapshotId, UUID_REGEX);
    assert.equal(run1.snapshot.format, EXPORT_FORMAT);
    assert.equal(run1.snapshot.version, VERSION);
    assert.equal(run1.snapshot.sourceTimezone, 'Asia/Makassar');
    assert.equal(run1.snapshot.consistent, false);
    assert.equal(run1.snapshot.readOnlyDeclared, true);
    assert.equal(run1.snapshot.isComplete, true);
    assert.match(run1.snapshot.createdAt, ISO_DATE_REGEX);
    assert.match(run1.snapshot.finishedAt, ISO_DATE_REGEX);
  });

  it('contains strictly SOURCE_SHEETS with no session or config secrets', () => {
    const { snapshot } = syntheticFixture();
    const sheetNames = Object.keys(snapshot.sheets);

    assert.deepEqual(sheetNames.sort(), [...SOURCE_SHEETS].sort());

    const serialized = JSON.stringify(snapshot).toLowerCase();
    const forbiddenKeys = [
      'session',
      'password_plain',
      'secret_key',
      'scriptproperties',
      'access_token',
      'refresh_token',
      'authorization',
      'cookie',
    ];
    for (const key of forbiddenKeys) {
      assert.equal(serialized.includes(`"${key}"`), false, `Found forbidden key: ${key}`);
    }
  });

  it('validates Data_Pegawai with strict 25 headers, fake string IDs, and SHA256 default password hash', () => {
    const { snapshot } = syntheticFixture();
    const sheet = snapshot.sheets.Data_Pegawai;

    const expectedHeaders = [
      'NIP', 'Password_Hash', 'Role', 'Status_Akun', 'Nama_Lengkap',
      'Status_Kepegawaian', 'Pangkat_Golongan', 'Jabatan', 'No_HP', 'Alamat',
      'Folder_Drive_ID', 'Email', 'Golongan_Darah', 'NIK', 'Tempat_Lahir',
      'Tanggal_Lahir', 'Jenis_Kelamin', 'Agama', 'Pendidikan_Terakhir', 'Status_Pernikahan',
      'TMT_Pangkat', 'Jenis_Jabatan', 'TMT_Jabatan', 'Unit_Organisasi', 'Foto_Drive_ID',
    ];

    assert.equal(sheet.headers.length, 25);
    assert.deepEqual(sheet.headers, expectedHeaders);
    assert.ok(sheet.rows.length >= 3);

    for (const row of sheet.rows) {
      assert.equal(row.values.length, 25);
      assert.equal(row.displayValues.length, 25);

      const [nip, passHash, role, statusAkun, nama, , , , noHp, alamat, , email, , nik] = row.values;

      // NIP and NIK must be string types to preserve precision; never numbers
      assert.equal(typeof nip, 'string');
      assert.equal(typeof nik, 'string');
      assert.match(nip, /^\d{18}$/);
      assert.match(nik, /^53719999\d{8}$/);

      // Verify fake identity references
      assert.ok(nama.includes('Sintetis'));
      assert.equal(noHp, '081299990001');
      assert.equal(alamat, 'Alamat fixture lokal');
      assert.equal(email, `${nip}@example.test`);
      assert.ok(['Admin', 'Pegawai'].includes(role));
      assert.equal(statusAkun, 'Aktif');

      // Verify SHA256 default password hash computed from last 6 digits of NIP
      const expectedHash = createHash('sha256').update(nip.slice(-6)).digest('hex');
      assert.equal(passHash, expectedHash);
      assert.match(passHash, /^[0-9a-f]{64}$/);
    }
  });

  it('provides 2 archives and coherent file manifest with matching size and sha256', () => {
    const { snapshot, files } = syntheticFixture();
    const archiveSheet = snapshot.sheets.Arsip_Dokumen;

    assert.equal(archiveSheet.rows.length, 2);
    assert.equal(archiveSheet.rows[0].values[0], 'archive-synthetic-1');
    assert.equal(archiveSheet.rows[1].values[0], 'archive-synthetic-2');

    assert.equal(snapshot.fileManifest.length, 3);
    assert.equal(files.length, 3);

    const manifestMap = new Map(snapshot.fileManifest.map((entry) => [entry.fileId, entry]));

    for (const file of files) {
      const manifestEntry = manifestMap.get(file.fileId);
      assert.ok(manifestEntry, `Manifest missing entry for file ${file.fileId}`);
      assert.equal(manifestEntry.status, 'available');
      assert.equal(manifestEntry.name, file.name);
      assert.equal(manifestEntry.mimeType, file.mimeType);
      assert.equal(manifestEntry.kind, file.kind);
      assert.equal(manifestEntry.sizeBytes, file.bytes.length);

      const computedSha256 = createHash('sha256').update(file.bytes).digest('hex');
      assert.equal(manifestEntry.sha256, computedSha256);
    }

    // Every archive row references an available fileId from the manifest
    for (const row of archiveSheet.rows) {
      const fileId = row.values[3];
      assert.ok(manifestMap.has(fileId));
      assert.equal(manifestMap.get(fileId).status, 'available');
    }
  });

  it('verifies binary sniffing signatures for JPEG, PNG, and PDF without real PII', () => {
    const { files } = syntheticFixture();
    const pdf = files.find((f) => f.mimeType === 'application/pdf');
    const png = files.find((f) => f.mimeType === 'image/png');
    const jpeg = files.find((f) => f.mimeType === 'image/jpeg');

    assert.ok(pdf && png && jpeg);

    // PDF magic %PDF-
    assert.equal(pdf.bytes.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(pdf.bytes.toString('ascii').includes('Synthetic local migration test'));

    // PNG signature 89 50 4E 47 0D 0A 1A 0A
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.bytes.subarray(0, 8).equals(pngSig));

    // JPEG SOI marker FF D8 FF
    assert.equal(jpeg.bytes[0], 0xff);
    assert.equal(jpeg.bytes[1], 0xd8);
    assert.equal(jpeg.bytes[2], 0xff);
  });

  it('guarantees UUID snapshotId and file IDs have no path traversal risks', () => {
    const { snapshot, files } = syntheticFixture();

    assert.match(snapshot.snapshotId, UUID_REGEX);
    assert.equal(path.basename(snapshot.snapshotId), snapshot.snapshotId);
    assert.equal(snapshot.snapshotId.includes('..'), false);

    for (const file of files) {
      assert.equal(path.basename(file.fileId), file.fileId);
      assert.equal(path.basename(file.name), file.name);
      assert.equal(file.fileId.includes('/'), false);
      assert.equal(file.fileId.includes('\\'), false);
      assert.equal(file.fileId.includes('..'), false);
      assert.match(file.fileId, /^[a-zA-Z0-9_-]+$/);
    }
  });
});

describe('writeFixture filesystem output and protection', () => {
  const createdDirs = [];

  after(async () => {
    for (const dir of createdDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('writes fixture files and generates random secrets only at write time', async () => {
    const base = await resolveTempBase();
    const dir1 = path.join(base, `fixture-test-1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const dir2 = path.join(base, `fixture-test-2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    createdDirs.push(dir1, dir2);

    const stats1 = await writeFixture(dir1);
    assert.deepEqual(stats1, { employees: 3, documents: 2, files: 3 });

    const stats2 = await writeFixture(dir2);
    assert.deepEqual(stats2, { employees: 3, documents: 2, files: 3 });

    // Validate generated snapshot JSON
    const snapshotRaw = await fs.readFile(path.join(dir1, 'snapshot.sikap-export.json'), 'utf-8');
    const parsedSnapshot = JSON.parse(snapshotRaw);
    assert.equal(parsedSnapshot.format, EXPORT_FORMAT);
    assert.equal(parsedSnapshot.version, VERSION);

    // Validate file binaries written to files/ directory
    for (const manifestEntry of parsedSnapshot.fileManifest) {
      const filePath = path.join(dir1, 'files', `${manifestEntry.fileId}.bin`);
      const fileBytes = await fs.readFile(filePath);
      assert.equal(fileBytes.length, manifestEntry.sizeBytes);
      const computedSha = createHash('sha256').update(fileBytes).digest('hex');
      assert.equal(computedSha, manifestEntry.sha256);
    }

    // Validate pepper and salt secrets
    const pepper1 = await fs.readFile(path.join(dir1, 'fixture.sikap-pepper'), 'utf-8');
    const salt1 = await fs.readFile(path.join(dir1, 'fixture.sikap-salt'), 'utf-8');
    const pepper2 = await fs.readFile(path.join(dir2, 'fixture.sikap-pepper'), 'utf-8');
    const salt2 = await fs.readFile(path.join(dir2, 'fixture.sikap-salt'), 'utf-8');

    // 32 bytes base64 encoded should be 44 chars
    assert.equal(Buffer.from(pepper1, 'base64').length, 32);
    assert.equal(Buffer.from(salt1, 'base64').length, 32);
    assert.equal(Buffer.from(pepper2, 'base64').length, 32);
    assert.equal(Buffer.from(salt2, 'base64').length, 32);

    // Random secrets generated on writeFixture must be distinct per write
    assert.notEqual(pepper1, pepper2);
    assert.notEqual(salt1, salt2);
  });

  it('refuses to overwrite an existing directory', async () => {
    const base = await resolveTempBase();
    const existingDir = path.join(base, `fixture-test-exists-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    createdDirs.push(existingDir);

    await fs.mkdir(existingDir, { recursive: true });
    const sentinelFile = path.join(existingDir, 'sentinel.txt');
    await fs.writeFile(sentinelFile, 'preserve-existing-data', 'utf-8');

    await assert.rejects(
      async () => {
        await writeFixture(existingDir);
      },
      (error) => {
        assert.equal(error.message, 'OUTPUT_EXISTS');
        return true;
      }
    );

    // Ensure existing files remain intact
    const sentinelContent = await fs.readFile(sentinelFile, 'utf-8');
    assert.equal(sentinelContent, 'preserve-existing-data');
  });
});
