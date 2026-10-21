import { env } from 'cloudflare:test';
import { app } from '../server/app';
import { hashPassword } from '../server/lib/crypto';

export const ORIGIN = 'https://sikap.test';
export const COOKIE_NAME = '__Host-sikap_sid';

let seq = 0;
const runPrefix = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');

/** Unique, syntactically valid fake NIP (18 digits) per call. */
export function uniqueNip(): string {
  seq += 1;
  return `19${runPrefix}${String(seq).padStart(10, '0')}`;
}

/** Unique fake client IP so the per-IP throttle never couples tests. */
export function uniqueIp(): string {
  seq += 1;
  return `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${seq & 255}`;
}

export interface TestUser {
  id: number;
  nip: string;
  password: string;
}

export async function createUser(
  opts: {
    nip?: string;
    password?: string;
    passwordHash?: string;
    role?: 'Admin' | 'Pegawai';
    statusAkun?: 'Aktif' | 'Nonaktif';
    deleted?: boolean;
    fotoR2Key?: string;
  } = {},
): Promise<TestUser> {
  const nip = opts.nip ?? uniqueNip();
  const password = opts.password ?? nip.slice(-6);
  const hash = opts.passwordHash ?? (await hashPassword(password, env.PASSWORD_PEPPER));
  const now = new Date().toISOString();
  const deletedAt = opts.deleted ? now : null;
  const purgeAfter = opts.deleted ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null;
  const row = await env.DB.prepare(
    `INSERT INTO pegawai (nip, nama, role, status_akun, status_kepegawaian, jabatan, foto_r2_key, deleted_at, purge_after)
     VALUES (?1, ?2, ?3, ?4, 'PNS', 'Penguji', ?5, ?6, ?7) RETURNING id`,
  )
    .bind(nip, `User ${nip.slice(-4)}`, opts.role ?? 'Pegawai', opts.statusAkun ?? 'Aktif', opts.fotoR2Key ?? null, deletedAt, purgeAfter)
    .first<{ id: number }>();
  if (!row) throw new Error('insert failed');
  await env.DB.prepare(`INSERT INTO akun (pegawai_id, password_hash, is_default_password) VALUES (?1, ?2, ?3)`)
    .bind(row.id, hash, password === nip.slice(-6) ? 1 : 0)
    .run();
  return { id: row.id, nip, password };
}

export interface CallOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  ip?: string;
  base?: string;
  headers?: Record<string, string>;
  /** Multipart body; the runtime sets the Content-Type boundary. */
  formData?: FormData;
  /** Raw request body (e.g. a document upload); headers are passed as given. */
  rawBody?: BodyInit;
}

/** Call the Hono app in-process with the test bindings. */
export function call(pathname: string, opts: CallOptions = {}): Promise<Response> {
  const method = opts.method ?? (opts.body !== undefined || opts.formData || opts.rawBody ? 'POST' : 'GET');
  const base = opts.base ?? ORIGIN;
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const origin = opts.origin === undefined ? base : opts.origin;
  if (origin !== null && method !== 'GET') headers['Origin'] = origin;
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  headers['CF-Connecting-IP'] = opts.ip ?? uniqueIp();
  return Promise.resolve(
    app.request(
      `${base}${pathname}`,
      {
        method,
        headers,
        body: opts.rawBody ?? opts.formData ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
      },
      env,
    ),
  );
}

/** Extract `name=value` from Set-Cookie for reuse in a Cookie header. */
export function sessionCookieFrom(res: Response, name = COOKIE_NAME): string | null {
  const setCookie = res.headers.get('Set-Cookie');
  if (!setCookie) return null;
  const m = new RegExp(`${name.replace(/[$^.*+?()[\]{}|\\-]/g, '\\$&')}=([^;]*)`).exec(setCookie);
  return m && m[1] ? `${name}=${m[1]}` : null;
}

export async function login(user: TestUser, password = user.password, ip?: string): Promise<string> {
  const res = await call('/api/auth/login', { body: { nip: user.nip, password }, ip });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = sessionCookieFrom(res);
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
