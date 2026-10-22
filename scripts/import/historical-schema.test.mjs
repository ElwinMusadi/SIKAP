// Guards for the historical importer (scripts/import/historical-schema.mjs, owner decision 22 Oct 2026):
//   1. migrations 0001–0008 keep their exact bytes (production was built from them);
//   2. later migrations are only appended after 0008, numbered consecutively;
//   3. the pinned production importer refuses the evolved schema before reading a plan,
//      a credential, the clock or the network.
// Every importer dependency below is a throwing stub, like run-prod-import.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { executeProductionImport } from './run-prod-import.mjs';
import { IMPORT_SCHEMA_PINS, MIGRATIONS_DIR, REPO_MIGRATIONS, SCHEMA_EVOLVED } from './historical-schema.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const counters = () => ({ cred: 0, fetch: 0, plan: 0, file: 0, now: 0 });
function options(c, mode) {
  return {
    readCredential: async () => { c.cred++; assert.fail('credential must not be read'); },
    fetchImpl: async () => { c.fetch++; assert.fail('network must not be used'); },
    readPlanBytes: async () => { c.plan++; assert.fail('plan must not be read'); },
    readFileBytes: async () => { c.file++; assert.fail('file must not be read'); },
    now: () => { c.now++; return '2026-10-22T00:00:00.000Z'; },
    mode,
  };
}

test('migrasi 0001–0008 tidak boleh berubah: byte-nya persis seperti saat produksi diimpor', () => {
  for (const [name, pin] of IMPORT_SCHEMA_PINS) {
    const text = readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
    assert.equal(text.includes('\r'), false, `${name} harus LF`);
    assert.equal(sha256(text), pin, `${name} berubah`);
  }
});

test('migrasi baru hanya ditambahkan setelah 0008, bernomor berurutan tanpa celah', () => {
  assert.deepEqual(REPO_MIGRATIONS.slice(0, IMPORT_SCHEMA_PINS.length), IMPORT_SCHEMA_PINS.map(([name]) => name));
  REPO_MIGRATIONS.forEach((name, i) => assert.equal(Number(name.slice(0, 4)), i + 1, name));
});

test('importer produksi menolak skema yang sudah melewati 0008, sebelum plan, kredensial, jam, atau jaringan',
  { skip: SCHEMA_EVOLVED ? false : 'repo masih di skema impor 0001–0008' }, async () => {
    for (const mode of ['check-only', 'import', 'describe-plan']) {
      const c = counters();
      const r = await executeProductionImport(options(c, mode));
      assert.equal(r.code, 'MIGRATION_SET_MISMATCH', mode);
      assert.match(r.status, /^STOPPED/, mode);
      assert.equal(r.requests, 0, mode);
      assert.equal(r.writeAttempts, 0, mode);
      assert.deepEqual(c, counters(), mode);
    }
  });
