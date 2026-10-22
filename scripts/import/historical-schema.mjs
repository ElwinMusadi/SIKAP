// The data importer in scripts/import is a HISTORICAL tool since 22 Oct 2026 (owner decision,
// docs/RENCANA-API-INTEGRASI.md §11). It is pinned to the import-time schema, migrations
// 0001–0008, and its static check refuses any other migration set (MIGRATION_SET_MISMATCH /
// SCHEMA_MISMATCH). The production import must never be re-run (CLAUDE.md), and the pinned
// importer modules (prod-import-pins.mjs MODULE_FILES) are never edited to follow new migrations.
//
// Tests that need the 0001–0008 schema in the repository skip with IMPORT_SCHEMA_SKIP once newer
// migrations exist. historical-schema.test.mjs proves the importer refuses the current schema and
// freezes the bytes of 0001–0008 (production was built from them).
//
// Test-only helper: imported by tests, never by a pinned module.
import { readdirSync } from 'node:fs';

/** Import-time migrations and their LF SHA-256, identical to MIGRATION_PINS in the pinned importer. */
export const IMPORT_SCHEMA_PINS = Object.freeze([
  ['0001_init.sql', 'bb47096b7f68350cb5040c5d8fd4060bd2315dc0f32e493f641ac9276b2bd171'],
  ['0002_seed_reference.sql', 'f0d7c90d8e8ccf7e265bdb3753038c7be6cdbf5761f8e97516a25738f1099f0b'],
  ['0003_versi_uploaded_by.sql', 'de85d455cb9e4799040d477f15758e77c9089acabfee442f4ccded0f8b0ebdf8'],
  ['0004_riwayat_integrity.sql', '1513436a4d98c15c3c06d400020b3c8f8f188455b945cea3011d15011fa2c736'],
  ['0005_outbox_leases.sql', 'd98771fb386f5a1ef32c811976d477a3edda86d114cd9f8f0e4d4cd79ab47ba0'],
  ['0006_admin_jenis.sql', '56073c4d59e6c49336e91cde0735c7eb7b4701022650de385c8b453a88ae73f3'],
  ['0007_r2_purge_queue.sql', '422fd699b2cbdec06f039725769aaf7e49b9a134680996141089756f579a1701'],
  ['0008_backup_jobs.sql', 'cd7c04c559a3eb67aab26737ff3216ce490b40da60066933c9be570f471cbbd3'],
].map((pair) => Object.freeze(pair)));

export const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/** Migration files in the repository, as the importer lists them. */
export const REPO_MIGRATIONS = Object.freeze(
  readdirSync(MIGRATIONS_DIR).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort(),
);

/** True once the repository schema has moved past the import-time set. */
export const SCHEMA_EVOLVED =
  REPO_MIGRATIONS.length !== IMPORT_SCHEMA_PINS.length || IMPORT_SCHEMA_PINS.some(([name], i) => REPO_MIGRATIONS[i] !== name);

/** `test(name, { skip: IMPORT_SCHEMA_SKIP }, fn)`: the reason is printed in the test report. */
export const IMPORT_SCHEMA_SKIP = SCHEMA_EVOLVED
  ? 'importer historis: dipin ke skema impor 0001–0008, repo sudah punya migrasi lebih baru (scripts/import/historical-schema.mjs)'
  : false;
