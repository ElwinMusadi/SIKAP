import type { ApiErrorBody, ApiErrorCode } from '@shared/api';

/** Server codes plus the client-only code for requests that never reached the server. */
export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR';

const API_BASE = '/api';

/**
 * Requests whose 401 means "not signed in" rather than "session expired":
 * they must never trigger the global session-expired redirect.
 */
const SESSION_PROBE_PATHS = new Set(['/auth/me', '/auth/login', '/auth/logout']);

export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly fields?: Record<string, string>;
  readonly retryAfterSeconds?: number;
  /** API path (without the /api prefix) that produced the error. */
  readonly path: string;

  constructor(init: {
    status: number;
    code: ClientErrorCode;
    message: string;
    path: string;
    fields?: Record<string, string>;
    retryAfterSeconds?: number;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.path = init.path;
    this.fields = init.fields;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export function isApiError(error: unknown, code?: ClientErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

// ---------------------------------------------------------------------------
// Session-expired notification (wired up in query-client.ts)
// ---------------------------------------------------------------------------

type SessionExpiredListener = (error: ApiError) => void;
let sessionExpiredListener: SessionExpiredListener | null = null;

export function setSessionExpiredListener(listener: SessionExpiredListener | null) {
  sessionExpiredListener = listener;
}

// ---------------------------------------------------------------------------
// Fetch wrapper
// ---------------------------------------------------------------------------

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
}

const FALLBACK_MESSAGES: Record<ClientErrorCode, string> = {
  VALIDATION_ERROR: 'Data yang dikirim tidak valid.',
  INVALID_CREDENTIALS: 'NIP atau password salah.',
  ACCOUNT_LOCKED: 'Akun terkunci sementara.',
  ACCOUNT_INACTIVE: 'Akun tidak aktif.',
  SESSION_EXPIRED: 'Sesi Anda telah berakhir.',
  FORBIDDEN: 'Anda tidak memiliki akses.',
  CSRF_REJECTED: 'Permintaan ditolak.',
  NOT_FOUND: 'Data tidak ditemukan.',
  CONFLICT: 'Data telah berubah. Muat ulang lalu coba lagi.',
  RATE_LIMITED: 'Terlalu banyak percobaan. Coba lagi nanti.',
  INTERNAL_ERROR: 'Terjadi kesalahan pada server. Silakan coba lagi.',
  NETWORK_ERROR: 'Tidak dapat terhubung ke server. Periksa koneksi internet Anda.',
};

/** Best-effort code when the response is not the standard JSON envelope (e.g. a proxy error page). */
function codeFromStatus(status: number): ApiErrorCode {
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 401) return 'SESSION_EXPIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 423) return 'ACCOUNT_LOCKED';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL_ERROR';
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const error = (value as { error: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function readBody(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (cause) {
    // Let TanStack Query see cancellations as-is.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: FALLBACK_MESSAGES.NETWORK_ERROR, path });
  }

  if (res.status === 204) return undefined as T;
  const data = await readBody(res);

  if (res.ok) return data as T;

  const error = isErrorBody(data)
    ? new ApiError({
        status: res.status,
        code: data.error.code,
        message: data.error.message || FALLBACK_MESSAGES[data.error.code],
        path,
        fields: data.error.fields,
        retryAfterSeconds: data.error.retryAfterSeconds ?? parseRetryAfter(res.headers.get('retry-after')),
      })
    : new ApiError({
        status: res.status,
        code: codeFromStatus(res.status),
        message: FALLBACK_MESSAGES[codeFromStatus(res.status)],
        path,
        retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
      });

  if (error.code === 'SESSION_EXPIRED' && !SESSION_PROBE_PATHS.has(path)) {
    sessionExpiredListener?.(error);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Multipart upload (XHR for upload progress)
// ---------------------------------------------------------------------------

interface UploadOptions {
  method?: 'POST' | 'PUT';
  signal?: AbortSignal;
  /** Upload progress 0..100. */
  onProgress?: (percent: number) => void;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Sends FormData (browser sets the multipart boundary). Same error envelope and session handling as api(). */
export function apiUpload<T>(path: string, formData: FormData, options: UploadOptions = {}): Promise<T> {
  return xhrSend<T>(path, formData, options);
}

interface RawUploadOptions extends UploadOptions {
  /** Extra request headers (e.g. Content-Type, X-File-Name). Content-Length is set by the browser. */
  headers?: Record<string, string>;
}

/** Sends a Blob/File as the raw request body (no multipart), with upload progress. */
export function apiUploadRaw<T>(path: string, body: Blob, options: RawUploadOptions = {}): Promise<T> {
  return xhrSend<T>(path, body, options);
}

function xhrSend<T>(path: string, body: XMLHttpRequestBodyInit, options: RawUploadOptions): Promise<T> {
  const { method = 'PUT', signal, onProgress, headers } = options;

  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(method, API_BASE + path);
    xhr.withCredentials = false; // same-origin: cookies are sent automatically
    xhr.setRequestHeader('Accept', 'application/json');
    for (const [name, value] of Object.entries(headers ?? {})) xhr.setRequestHeader(name, value);

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      });
    }

    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new ApiError({ status: 0, code: 'NETWORK_ERROR', message: FALLBACK_MESSAGES.NETWORK_ERROR, path }));
    });
    xhr.addEventListener('load', () => {
      cleanup();
      const type = xhr.getResponseHeader('content-type') ?? '';
      const data = type.includes('application/json') ? parseJson(xhr.responseText) : undefined;

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.status === 204 ? undefined : data) as T);
        return;
      }

      const retryAfter = parseRetryAfter(xhr.getResponseHeader('retry-after'));
      const fallbackCode = codeFromStatus(xhr.status);
      const error = isErrorBody(data)
        ? new ApiError({
            status: xhr.status,
            code: data.error.code,
            message: data.error.message || FALLBACK_MESSAGES[data.error.code],
            path,
            fields: data.error.fields,
            retryAfterSeconds: data.error.retryAfterSeconds ?? retryAfter,
          })
        : new ApiError({
            status: xhr.status,
            code: fallbackCode,
            message: FALLBACK_MESSAGES[fallbackCode],
            path,
            retryAfterSeconds: retryAfter,
          });

      if (error.code === 'SESSION_EXPIRED' && !SESSION_PROBE_PATHS.has(path)) {
        sessionExpiredListener?.(error);
      }
      reject(error);
    });

    xhr.send(body);
  });
}

/** User-facing message for any thrown value. Never exposes non-API internals. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || FALLBACK_MESSAGES[error.code];
  return FALLBACK_MESSAGES.INTERNAL_ERROR;
}
