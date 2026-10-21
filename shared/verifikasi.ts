// Phase 5 API contract: admin document verification queue + WhatsApp notifications
// (outbox) + notification/WhatsApp settings. Shared by server and client.
import { z } from 'zod';
import type { DocumentMime } from './dokumen';
import type { StatusKepegawaian } from './enums';

// ---------------------------------------------------------------------------
// Verification queue — GET /api/admin/verifikasi?jenis=&cursor=
// ---------------------------------------------------------------------------
// Admin only. Items = active (not soft-deleted) arsip with status 'Menunggu' of
// non-deleted pegawai, ordered OLDEST upload first (uploaded_at ASC, id ASC).
// Keyset pagination: `cursor` is opaque (server encodes "uploaded_at|id"); page size 25.
// Optional filter `jenis` = jenis_dokumen_id.

export interface VerifikasiItem {
  arsipId: number;
  /** Optimistic-concurrency token: send back on approve/reject. */
  versi: number;
  jenisDokumen: { id: string; nama: string; kategori: string; wajib: boolean };
  pegawai: {
    id: number;
    nip: string;
    nama: string;
    statusKepegawaian: StatusKepegawaian | null;
    jabatan: string | null;
    unit: string | null;
    fotoUrl: string | null;
  };
  file: { fileName: string; mimeType: DocumentMime; sizeBytes: number };
  uploadedAt: string;
  /** True when this is a re-upload (versi > 1): there is an earlier decision in riwayat. */
  isReupload: boolean;
  /** Last rejection note on this arsip, if the previous version was rejected. */
  catatanSebelumnya: string | null;
}

export interface VerifikasiQueueResponse {
  items: VerifikasiItem[];
  nextCursor: string | null;
  /** Total pending across all jenis (ignores the `jenis` filter). */
  total: number;
  /** Pending count per jenis_dokumen_id, for the filter dropdown. */
  perJenis: Record<string, number>;
}

export const verifikasiQuerySchema = z.object({
  jenis: z.string().trim().max(64).optional(),
  cursor: z.string().max(200).optional(),
});

// File preview reuses GET /api/documents/:arsipId/file (admin is allowed).

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------
// POST /api/admin/verifikasi/:arsipId/approve   body { versi }
// POST /api/admin/verifikasi/:arsipId/reject    body { versi, alasan }
//
// Atomic compare-and-set: succeeds only if the arsip is still active, status 'Menunggu',
// AND versi = body.versi (the owner may have rolled back / re-uploaded / deleted meanwhile).
// Otherwise 409 CONFLICT 'Dokumen telah berubah. Muat ulang antrean.'
// Same batch: arsip update (status, verified_at, verified_by, catatan_admin),
// riwayat APPROVE/REJECT (with pegawai_id + jenis_dokumen_id), audit
// DOKUMEN_APPROVE / DOKUMEN_REJECT, and the WhatsApp outbox row (if enabled).
// An admin MAY verify their own documents? NO → 403 FORBIDDEN
// 'Dokumen Anda sendiri harus diverifikasi admin lain.' (four-eyes, like pengajuan).
// Response: DecisionResponse.

export const approveRequestSchema = z.object({
  versi: z.number().int().positive(),
});
export const rejectRequestSchema = z.object({
  versi: z.number().int().positive(),
  alasan: z
    .string()
    .trim()
    .min(5, 'Alasan penolakan minimal 5 karakter.')
    .max(500, 'Alasan penolakan maksimal 500 karakter.'),
});
export type ApproveRequest = z.infer<typeof approveRequestSchema>;
export type RejectRequest = z.input<typeof rejectRequestSchema>;

export interface DecisionResponse {
  arsipId: number;
  status: 'Terverifikasi' | 'Ditolak';
  /** Whether a WhatsApp notification was queued (false if disabled / no phone). */
  notifikasi: 'DIANTRIKAN' | 'NONAKTIF' | 'TANPA_NOMOR';
  /** Remaining pending count after this decision (for the badge). */
  sisaAntrean: number;
}

// ---------------------------------------------------------------------------
// WhatsApp notifications (outbox)
// ---------------------------------------------------------------------------
// Events (owner-visible names from the legacy system, same Meta template names):
//   dokumen_baru_admin     → every ACTIVE admin with a phone (except the uploader; duplicate
//                            numbers get one message), on employee UPLOAD/REUPLOAD
//   dokumen_terverifikasi  → the employee, on APPROVE
//   dokumen_ditolak        → the employee, on REJECT (includes alasan)
//   test                   → the requesting admin (settings page)
// Rows are inserted in the same batch as the triggering mutation (never lost), then
// sent with waitUntil() right after the response. Delivery uses an atomic, expiring lease
// so overlapping waitUntil/cron invocations do not normally send the same row concurrently.
// Delivery is AT-LEAST-ONCE, not exactly-once: if a provider accepts the message but the
// process stops before persisting SENT, an eventual retry may send a duplicate.
// Failures stay PENDING with attempts+1, last_error and a retry due time; the companion
// cron retries due PENDING rows with attempts < 5 and marks FAILED after that.
// Missing provider configuration does not consume attempts. Phone numbers are normalised
// '62…' digits. Background batches are bounded to fit the 30-second HTTP waitUntil window.
// Messages never contain secrets; provider error details are controlled messages rather
// than raw response bodies, which could echo credentials or personal data.

export const WA_TEMPLATES = ['dokumen_baru_admin', 'dokumen_terverifikasi', 'dokumen_ditolak', 'test'] as const;
export type WaTemplate = (typeof WA_TEMPLATES)[number];

export const WA_PROVIDERS = ['fonnte', 'meta'] as const;
export type WaProvider = (typeof WA_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Settings — GET/PUT /api/admin/settings/notifications
//            GET/PUT /api/admin/settings/whatsapp, POST /api/admin/settings/whatsapp/test
// ---------------------------------------------------------------------------

export interface NotifSettings {
  dokumenBaru: boolean;
  dokumenApproved: boolean;
  dokumenRejected: boolean;
}
export const notifSettingsSchema = z
  .object({
    dokumenBaru: z.boolean(),
    dokumenApproved: z.boolean(),
    dokumenRejected: z.boolean(),
  })
  .strict();

/** Secrets are never returned; only whether they are set and the last 4 chars. */
export interface WhatsAppSettings {
  provider: WaProvider;
  fonnte: { configured: boolean; tokenHint: string | null };
  meta: { configured: boolean; tokenHint: string | null; phoneNumberId: string | null };
  /** Outbox health for the settings page. */
  outbox: { pending: number; failed: number; sentLast24h: number; lastError: string | null };
}

/**
 * PUT body. Omitted secret fields keep their stored value; an empty string clears it.
 * Tokens are stored encrypted (AES-GCM, SETTINGS_ENC_KEY) in `pengaturan` (is_secret=1).
 */
export const updateWhatsAppSchema = z
  .object({
    provider: z.enum(['fonnte', 'meta']),
    fonnteToken: z.string().trim().max(200).optional(),
    metaToken: z.string().trim().max(1000).optional(),
    metaPhoneNumberId: z
      .string()
      .trim()
      .regex(/^\d{5,30}$/, 'Phone Number ID harus berupa angka.')
      .or(z.literal(''))
      .optional(),
  })
  .strict();
export type UpdateWhatsAppRequest = z.input<typeof updateWhatsAppSchema>;

/**
 * POST /api/admin/settings/whatsapp/test — sends synchronously to the requesting admin.
 * 400 VALIDATION_ERROR fields._form when the admin has no phone number
 * ('Nomor HP Anda belum diisi di profil.') or the active provider is not fully configured
 * ('Konfigurasi WhatsApp belum lengkap.').
 * Rate-limited per admin: at most 5 attempts in 10 minutes; further attempts return
 * 429 RATE_LIMITED with retryAfterSeconds.
 */
export interface TestWhatsAppResponse {
  ok: boolean;
  provider: WaProvider;
  /** Sanitised provider reason when !ok (HTTP status + ≤ 200 chars, digit runs masked). */
  detail: string | null;
}
