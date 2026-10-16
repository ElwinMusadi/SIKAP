// Phase 4 API contract: document archive (R2), versions kept 3 days, rollback,
// soft delete with restore (owner decision #4). Shared by server and client.
import { z } from 'zod';
import { RETENTION, type StatusDokumen } from './enums';
import type { StatusDokumenView } from './profile';

// ---------------------------------------------------------------------------
// Upload policy
// ---------------------------------------------------------------------------

/** Accepted document types, verified server-side by magic bytes (never the client MIME). */
export const DOCUMENT_POLICY = {
  /** Default; per-type override in jenis_dokumen.max_size_bytes. */
  maxBytes: 5 * 1024 * 1024,
  mimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const,
  /** For <input accept>. */
  accept: '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp',
  versionRetentionDays: RETENTION.documentVersionDays,
  softDeleteRetentionDays: RETENTION.documentSoftDeleteDays,
} as const;
export type DocumentMime = (typeof DOCUMENT_POLICY.mimeTypes)[number];

/** True only for types the browser may render inline (PDF viewer / <img>). */
export function isViewableDocumentMime(mime: string | null | undefined): mime is DocumentMime {
  return !!mime && (DOCUMENT_POLICY.mimeTypes as readonly string[]).includes(mime);
}

// ---------------------------------------------------------------------------
// Archive listing — GET /api/me/documents, GET /api/admin/pegawai/:id/documents
// ---------------------------------------------------------------------------

/** A previous file version still restorable (until purgeAfter). */
export interface DokumenVersi {
  versi: number;
  fileName: string;
  mimeType: DocumentMime;
  sizeBytes: number;
  /** Status the document had when this version was replaced; restored on rollback. */
  status: StatusDokumen;
  uploadedAt: string;
  replacedAt: string;
  /** ISO UTC; the version is permanently purged after this. */
  purgeAfter: string;
  /**
   * Whether the CURRENT viewer may roll back to this version. False for owners on a
   * Terverifikasi file that an admin deleted (only admins may bring it back).
   */
  bisaDipulihkan: boolean;
}

export interface DokumenItem {
  jenisDokumenId: string;
  nama: string;
  kategori: string;
  /** Mandatory for this employee's status kepegawaian. */
  wajib: boolean;
  maxSizeBytes: number;
  /** 'Belum diunggah' when there is no active (non-deleted) arsip row. */
  status: StatusDokumenView;
  /** Active arsip row; null when Belum diunggah (even if a soft-deleted one exists). */
  arsip: {
    id: number;
    versi: number;
    fileName: string;
    mimeType: DocumentMime;
    sizeBytes: number;
    catatanAdmin: string | null;
    uploadedAt: string;
    verifiedAt: string | null;
    verifiedBy: { id: number; nama: string } | null;
  } | null;
  /** Soft-deleted arsip that can still be restored. */
  deleted: { id: number; fileName: string; deletedAt: string; purgeAfter: string } | null;
  /** Restorable previous versions of the active arsip, newest first. */
  versiSebelumnya: DokumenVersi[];
  /** Server-computed permissions for the CURRENT user. */
  can: {
    upload: boolean; // owner only; false while Menunggu or profile incomplete. Allowed over a soft-deleted arsip.
    delete: boolean; // owner: not Terverifikasi; admin: always (if arsip exists)
    rollback: boolean;
    /** Owner: only when the deleted file was not Terverifikasi (mirrors the delete rule). Admin: always. */
    restore: boolean;
  };
  /** Human reason when can.upload is false. */
  uploadBlockedReason: string | null;
}

export interface DokumenListResponse {
  pegawai: { id: number; nip: string; nama: string; statusKepegawaian: string | null };
  items: DokumenItem[];
  summary: {
    wajibTotal: number;
    wajibTersedia: number;
    wajibTerverifikasi: number;
    /** round(wajibTerverifikasi / wajibTotal * 100), 0 when wajibTotal = 0. */
    persen: number;
    counts: Record<StatusDokumenView, number>;
  };
  /** Profile fields still missing (upload gate). Empty for admins viewing others. */
  profileMissingFields: string[];
}

// ---------------------------------------------------------------------------
// Upload — PUT /api/me/documents/:jenisId   (RAW request body = the file bytes)
// ---------------------------------------------------------------------------
// Why raw instead of multipart: measured on the Cloudflare edge, parsing a 5 MB multipart
// body + hashing it in the Worker cost 21–31 ms CPU (Free plan limit: 10 ms). With a raw body
// the Worker streams request.body straight into R2 (~no CPU) and R2 verifies the SHA-256
// computed by the browser.
//
// Request headers:
//   Content-Type:        file MIME as chosen by the browser (informational only)
//   Content-Length:      REQUIRED, 1..maxSizeBytes (no chunked uploads)
//   X-File-Name:         original file name, encodeURIComponent()-encoded (informational, ≤255)
//   X-Content-SHA256:    REQUIRED, lowercase hex SHA-256 of the body (computed with crypto.subtle)
// Server: checks all gates BEFORE reading the body, sniffs magic bytes from the first chunk,
// streams the rest to R2 with put(..., { sha256 }) — R2 rejects a mismatching hash.
//
// Errors:
//   400 VALIDATION_ERROR fields.file  — wrong type (magic bytes) / too large / empty /
//                                        missing or bad Content-Length / hash missing or mismatch
//   400 VALIDATION_ERROR fields._form + fields.profile — profile incomplete; `profile` holds the
//       missing field labels joined by ', ' (same labels as REQUIRED_PROFILE_FIELDS)
//   409 CONFLICT                       — status Menunggu (already waiting for verification);
//                                         the owner may delete it and upload again (see below)
//   409 CONFLICT                       — concurrent change (retry)
//   404 NOT_FOUND                      — unknown or inactive jenis dokumen
// Behaviour (owner decision #4):
//   1. put new object to R2 (unique key)        — on failure: nothing changed
//   2. db.batch: copy current row → arsip_dokumen_versi (purge_after = now + 3 days),
//      update arsip (versi+1, status Menunggu, catatan NULL), riwayat, audit
//   3. if 2 fails AND no arsip row references the new key: delete the new R2 object
//   Old file is NEVER deleted in the request path; cron purges after 3 days.
// Upload over a SOFT-DELETED arsip is allowed (lets an employee replace a wrong pending file:
// delete → upload): the deleted file becomes a version row with reason 'DELETE' and keeps its
// original purge_after (or now, if already expired), deleted_at/purge_after are cleared.
// Response 201 (first upload) / 200 (re-upload): DokumenItemResponse.

export const UPLOAD_HEADERS = {
  fileName: 'X-File-Name',
  sha256: 'X-Content-SHA256',
} as const;

export interface DokumenItemResponse {
  item: DokumenItem;
}

// ---------------------------------------------------------------------------
// File access — GET /api/documents/:arsipId/file[?download=1][&versi=N]
// ---------------------------------------------------------------------------
// Owner or Admin. Streams from R2 with:
//   Content-Type: the sniffed canonical type (one of DOCUMENT_POLICY.mimeTypes)
//   Content-Disposition: inline; filename*=UTF-8''…  (attachment when download=1)
//   Cache-Control: private, no-store
//   X-Content-Type-Options: nosniff
//   Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'
//   (no `sandbox` directive: it breaks Chrome's built-in PDF viewer; safety comes from
//    serving only magic-byte-verified PDF/JPEG/PNG/WEBP — never HTML/SVG)
// `versi` selects a restorable previous version (owner/admin) — 404 if purged.
// The SPA's own CSP must allow `frame-src 'self'` and `img-src 'self'` (already the case).

export function documentFileUrl(arsipId: number, opts: { download?: boolean; versi?: number } = {}): string {
  const q = new URLSearchParams();
  if (opts.download) q.set('download', '1');
  if (opts.versi !== undefined) q.set('versi', String(opts.versi));
  const qs = q.toString();
  return `/api/documents/${arsipId}/file${qs ? `?${qs}` : ''}`;
}

// ---------------------------------------------------------------------------
// Delete / restore / rollback
// ---------------------------------------------------------------------------
// DELETE /api/documents/:arsipId          → soft delete (deleted_at, purge_after = now + 3 days)
//   Owner: only when status != Terverifikasi (403 FORBIDDEN otherwise). Admin: always.
//   409 if already deleted. Response DokumenItemResponse.
// POST /api/documents/:arsipId/restore    → undo soft delete within 3 days.
//   Admin: always. Owner: only if the deleted file's status != Terverifikasi (403 otherwise —
//   an employee cannot undo an admin's removal of a verified document).
//   409 if not deleted, 404 if purged (purge_after passed).
// POST /api/documents/:arsipId/rollback   body { versi }
//   Restore a previous version within 3 days: the current file becomes a version row
//   (purge_after = now + 3 days, reason 'REUPLOAD'), the selected version becomes active
//   WITH ITS PREVIOUS STATUS / catatan / verified_* (e.g. back to Terverifikasi), and its
//   version row is removed. versi number of the arsip increments (monotonic).
//   Owner: allowed only if current status != Terverifikasi (403 otherwise) — so an employee
//     can withdraw a pending/rejected re-upload and get the earlier file back.
//   Admin: always. Not allowed on a soft-deleted arsip (409: restore first).
//   404 if that version is purged/unknown.
// Version rows of a soft-deleted arsip are kept until the arsip itself is purged.

export const rollbackRequestSchema = z.object({
  versi: z.number().int().positive(),
});
export type RollbackRequest = z.infer<typeof rollbackRequestSchema>;

// ---------------------------------------------------------------------------
// History — GET /api/documents/:arsipId/riwayat  (owner or admin)
// ---------------------------------------------------------------------------

export type RiwayatAksi = 'UPLOAD' | 'REUPLOAD' | 'APPROVE' | 'REJECT' | 'DELETE' | 'RESTORE' | 'ROLLBACK';

export interface RiwayatItem {
  id: number;
  versi: number;
  aksi: RiwayatAksi;
  status: StatusDokumen | null;
  catatan: string | null;
  actor: { id: number; nama: string } | null;
  createdAt: string;
}
export interface RiwayatResponse {
  items: RiwayatItem[];
}

// ---------------------------------------------------------------------------
// Admin: list another employee's documents (read + delete/restore/rollback via the
// same /api/documents/:arsipId routes, which allow Admin).
// GET /api/admin/pegawai/:id/documents → DokumenListResponse (can.upload = false for admin)
// ---------------------------------------------------------------------------
