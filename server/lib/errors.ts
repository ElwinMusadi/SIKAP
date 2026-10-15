import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiErrorBody, ApiErrorCode } from '../../shared/api';

/**
 * Expected, client-facing failure. Thrown anywhere in a request and rendered
 * by the global error handler as `{ error: { code, message, ... } }`.
 * `message` is always safe to show to the user.
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ApiErrorCode;
  readonly fields?: Record<string, string>;
  readonly retryAfterSeconds?: number;

  constructor(
    status: ContentfulStatusCode,
    code: ApiErrorCode,
    message: string,
    extra: { fields?: Record<string, string>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.fields) error.fields = this.fields;
    if (this.retryAfterSeconds !== undefined) error.retryAfterSeconds = this.retryAfterSeconds;
    return { error };
  }
}

export const MESSAGES = {
  invalidCredentials: 'NIP atau password salah.',
  accountLocked: 'Akun terkunci sementara karena terlalu banyak percobaan login. Coba lagi nanti.',
  accountInactive: 'Akun tidak aktif. Silakan hubungi administrator.',
  sessionExpired: 'Sesi Anda telah berakhir. Silakan login kembali.',
  forbidden: 'Anda tidak memiliki akses ke sumber daya ini.',
  csrf: 'Permintaan ditolak.',
  notFound: 'Sumber daya tidak ditemukan.',
  rateLimited: 'Terlalu banyak percobaan. Coba lagi nanti.',
  internal: 'Terjadi kesalahan pada server. Silakan coba lagi.',
  validation: 'Data yang dikirim tidak valid.',
} as const;

export const errors = {
  validation: (fields?: Record<string, string>, message: string = MESSAGES.validation) =>
    new ApiError(400, 'VALIDATION_ERROR', message, { fields }),
  invalidCredentials: () => new ApiError(401, 'INVALID_CREDENTIALS', MESSAGES.invalidCredentials),
  accountLocked: (retryAfterSeconds: number) =>
    new ApiError(423, 'ACCOUNT_LOCKED', MESSAGES.accountLocked, { retryAfterSeconds }),
  accountInactive: () => new ApiError(403, 'ACCOUNT_INACTIVE', MESSAGES.accountInactive),
  sessionExpired: () => new ApiError(401, 'SESSION_EXPIRED', MESSAGES.sessionExpired),
  forbidden: () => new ApiError(403, 'FORBIDDEN', MESSAGES.forbidden),
  csrf: () => new ApiError(403, 'CSRF_REJECTED', MESSAGES.csrf),
  notFound: (message: string = MESSAGES.notFound) => new ApiError(404, 'NOT_FOUND', message),
  conflict: (message: string) => new ApiError(409, 'CONFLICT', message),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiError(429, 'RATE_LIMITED', MESSAGES.rateLimited, { retryAfterSeconds }),
};
