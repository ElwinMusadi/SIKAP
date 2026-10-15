// API contract shared by server (Hono) and client (React).
// Every change here must be reflected in both server/routes and src/lib/api.
import { z } from 'zod';
import { newPasswordSchema } from './validators';
import type { Role, StatusKepegawaian } from './enums';

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * All non-2xx JSON responses use this shape. `code` is the stable,
 * machine-readable signal the client must branch on (never on `message`).
 */
export type ApiErrorCode =
  | 'VALIDATION_ERROR' // 400 — `fields` holds per-field messages
  | 'INVALID_CREDENTIALS' // 401 — wrong NIP/password (generic on purpose)
  | 'ACCOUNT_LOCKED' // 423 — too many failed attempts; `retryAfterSeconds` set
  | 'ACCOUNT_INACTIVE' // 403 — status_akun = Nonaktif (only after correct password)
  | 'SESSION_EXPIRED' // 401 — missing/invalid/expired session cookie
  | 'FORBIDDEN' // 403 — authenticated but role/ownership denies access
  | 'CSRF_REJECTED' // 403 — Origin header mismatch on unsafe method
  | 'NOT_FOUND' // 404
  | 'CONFLICT' // 409
  | 'RATE_LIMITED' // 429
  | 'INTERNAL_ERROR'; // 500 — never leaks internals

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    fields?: Record<string, string>;
    retryAfterSeconds?: number;
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginRequestSchema = z.object({
  nip: z.string().trim().min(1, 'NIP wajib diisi.').max(32),
  password: z.string().min(1, 'Password wajib diisi.').max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Current user as returned by POST /api/auth/login and GET /api/auth/me. */
export interface SessionUser {
  id: number;
  nip: string;
  nama: string;
  role: Role;
  statusKepegawaian: StatusKepegawaian | null;
  jabatan: string | null;
  /** URL to GET /api/pegawai/:id/photo, or null when no photo. */
  fotoUrl: string | null;
  /** True while the account still uses the default password (banner only, never blocks). */
  isDefaultPassword: boolean;
}

export interface LoginResponse {
  user: SessionUser;
}
export interface MeResponse {
  user: SessionUser;
}

export function changePasswordRequestSchema(nip?: string) {
  return z
    .object({
      currentPassword: z.string().min(1, 'Password saat ini wajib diisi.').max(128),
      newPassword: newPasswordSchema(nip),
      confirmPassword: z.string(),
      /** Revoke every other session after the change (default true). */
      revokeOtherSessions: z.boolean().default(true),
    })
    .refine((v) => v.newPassword === v.confirmPassword, {
      path: ['confirmPassword'],
      message: 'Konfirmasi password tidak cocok.',
    });
}
export type ChangePasswordRequest = z.input<ReturnType<typeof changePasswordRequestSchema>>;

export interface ChangePasswordResponse {
  user: SessionUser;
  revokedSessions: number;
}

export interface SessionInfo {
  /** Opaque, non-secret identifier (first 16 hex chars of token hash). */
  id: string;
  createdAt: string; // ISO UTC
  lastSeenAt: string; // ISO UTC
  expiresAt: string; // ISO UTC
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface SessionsResponse {
  sessions: SessionInfo[];
}

export interface RevokeSessionsResponse {
  revoked: number;
}

export interface HealthResponse {
  status: 'ok';
  time: string;
  db: 'ok' | 'error';
}
