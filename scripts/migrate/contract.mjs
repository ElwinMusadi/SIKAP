// Offline Phase 8 format shared by migration tools; not imported by the web app.
// Artifacts contain PII/hashes and must stay outside version control. No source credentials,
// sessions or Script Properties belong in an export or migration plan.
export const EXPORT_FORMAT = 'sikap-gas-export';
export const PLAN_FORMAT = 'sikap-migration-plan';
export const VERSION = 1;
export const SOURCE_SHEETS = ['Data_Pegawai', 'Master_Dokumen', 'Arsip_Dokumen', 'Log_Aktivitas'];
export const IMPORT_TABLES = [
  'jenis_dokumen', 'jenis_dokumen_wajib', 'pegawai', 'akun', 'arsip_dokumen',
  'arsip_dokumen_riwayat', 'log_aktivitas',
];
export const ARTIFACT_LIMITS = { exportBytes: 50 * 1024 * 1024, fileBytes: 5 * 1024 * 1024, rows: 100_000 };
// The manual GAS exporter uses a stricter 8 MiB UTF-8 manifest ceiling so resumable
// Drive File.setContent checkpoints remain below GAS's 10 MB write limit. Larger
// offline input limits do not imply the manual exporter supports a 50 MiB manifest.

/**
 * Export envelope:
 * {format: EXPORT_FORMAT, version:1, snapshotId:UUID, createdAt:ISO UTC,
 *  sourceTimezone:'Asia/Makassar', consistent:false, readOnlyDeclared:boolean,
 *  isComplete:true, finishedAt:ISO UTC,
 *  sheets:{[SOURCE_SHEETS]:{headers:string[],rows:{rowNumber:number,values:Cell[],displayValues:string[]}[]}},
 *  fileManifest:{fileId,kind:'document'|'photo',name,mimeType,sizeBytes,sha256,
 *    status:'available'|'missing'|'invalid'|'pending'}[]}
 * Cell = null|string|number|boolean|{$date:ISO UTC}. Numeric NIP/NIK must be rejected;
 * their precision may already be lost. Never recover identity from rounded display text.
 * A downloaded files directory contains <fileId>.bin, no nested arbitrary user paths.
 * `sourceTimezone` is required; bare date strings accepted only with unambiguous mapping.
 * Exporting reads tables at different times: cutover needs a read-only source and
 * reconciliation; `consistent:false` must never be relabelled true by these tools.
 *
 * Transform result / plan envelope (sensitive; private output directory):
 * {format:PLAN_FORMAT,version:1,snapshotId,sourceSha256,createdAt,
 *  sourceReadOnlyDeclared:boolean,consistent:false,ready:boolean,
 *  tables:{[IMPORT_TABLES]:Array<Record<string,string|number|null>>},
 *  files:{fileId,kind:'document'|'photo',r2Key,mimeType,sizeBytes,sha256}[],
 *  expected:{pegawai:number,akun:number,arsip:number,files:number,totalFileBytes:number,
 *    arsipPerStatus:{Menunggu:number,Terverifikasi:number,Ditolak:number}},
 *  diagnostics:{severity:'error'|'warning',sheet:string,rowNumber:number|null,code:string}[]}
 * No raw values in diagnostics. A plan with any errors MUST ready=false and MUST NOT import.
 * Row identities: pegawai positive ids from sorted validated NIP; arsip positive ids from
 * sorted (NIP,jenisId); logs from canonical source row ordering. Import allowed ONLY on an
 * otherwise empty application database (seeded reference/jenis rows allowed).
 * files r2Key = `migration/<snapshotId>/<kind>/<fileId>-<sha256>.<canonical extension>`;
 * keys are never selected by user input or prefix-deleted. SHA256 identifies exact bytes.
 * Photo format remains verified original JPEG/PNG/WEBP (no conversion that breaks checksums).
 * All accepted archive files are validated locally before a database import may start.
 *
 * Overrides file (optional, private, explicit):
 * {pangkat:{[legacyValue]:targetKode},unit:{[legacyValue]:targetNumericId},
 *  pendidikan:{[legacyValue]:targetKode},jenis:{[legacyId]:targetDocId}}
 * Unknown references are ERRORs; no implicit dropping, guessing, auto-admin creation, or
 * password reset. Passwords wrap GAS SHA256 via legacy-wrap$10000$... with the target pepper;
 * default-password flag is computed against SHA256(last6NIP), no forced change.
 * Sessions, failed attempts, provider tokens, and outbox are NOT migrated.
 *
 * Local apply CLI: NO --remote option and NO public import HTTP route.
 * Uses local Wrangler D1/R2 only, explicitly selected isolated --persist-to directory.
 * A checkpoint is bound to snapshotId + sourceSha256 + plan file SHA256 + persist directory.
 * No overwrite/resume against a nonempty target without the exact matching checkpoint.
 * Target reference tables must be checked against plan assignments before any receipt or
 * object upload; matching built-in mappings alone cannot prove an existing target is intact.
 * Files uploaded/verified before SQL; all SQL values escaped and columns/table names fixed.
 * Source archives with unavailable files must not be silently counted as migrated.
 * Reconciliation compares database rows/status counts + exact R2 file SHA256/size and
 * returns nonzero on mismatch. A successful dry-run does not authorize a real migration.
 */
