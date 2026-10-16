import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { call, createUser, login, uniqueNip, type TestUser } from './helpers';

export function pdfBytes(size = 512): Uint8Array {
  const b = new Uint8Array(size).fill(0x20);
  b.set(new TextEncoder().encode('%PDF-1.4\n'));
  return b;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Raw PUT upload as the SPA does it. */
export async function putDoc(cookie: string, jenis: string, bytes = pdfBytes()): Promise<Response> {
  return call(`/api/me/documents/${jenis}`, {
    method: 'PUT',
    cookie,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Content-SHA256': await sha256Hex(bytes),
      'Content-Length': String(bytes.byteLength),
    },
    rawBody: bytes,
  });
}

let phoneSeq = 0;
/** Unique, valid '62…' phone per call. */
export function uniquePhone(): string {
  phoneSeq += 1;
  return `6281${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}${String(phoneSeq).padStart(5, '0')}`;
}

/** Fill the profile so uploads are allowed; `phone: null` leaves no_hp empty. */
export async function completeProfile(id: number, phone: string | null = uniquePhone()): Promise<void> {
  await env.DB.prepare(
    `UPDATE pegawai SET no_hp = ?4, email = ?2, nik = ?3, tempat_lahir = 'Kupang', nama = ?5,
            tanggal_lahir = '1990-01-01', jenis_kelamin = 'Laki-laki', agama = 'Islam', pendidikan_kode = 'SMA',
            status_pernikahan = 'Menikah', alamat = 'Jl. Uji 1'
      WHERE id = ?1`,
  )
    .bind(id, `u${id}@example.test`, String(3200000000000000 + id), phone, `Pegawai Uji ${id}`)
    .run();
}

export async function person(
  opts: { role?: 'Admin' | 'Pegawai'; phone?: string | null; statusAkun?: 'Aktif' | 'Nonaktif' } = {},
): Promise<{ user: TestUser; cookie: string; phone: string | null }> {
  const user = await createUser({ role: opts.role });
  const phone = opts.phone === undefined ? uniquePhone() : opts.phone;
  await completeProfile(user.id, phone);
  const cookie = await login(user);
  if (opts.statusAkun === 'Nonaktif') {
    await env.DB.prepare(`UPDATE pegawai SET status_akun = 'Nonaktif' WHERE id = ?1`).bind(user.id).run();
  }
  return { user, cookie, phone };
}

/** Bare pegawai row (no akun), fast; for queue fixtures. */
export async function insertPegawai(opts: { phone?: string | null; deleted?: boolean } = {}): Promise<number> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO pegawai (nip, nama, status_kepegawaian, jabatan, no_hp, deleted_at, purge_after)
     VALUES (?1, ?2, 'PNS', 'Staf', ?3, ?4, ?5) RETURNING id`,
  )
    .bind(
      uniqueNip(),
      `Fixture ${Math.random().toString(36).slice(2, 8)}`,
      opts.phone === undefined ? uniquePhone() : opts.phone,
      opts.deleted ? now : null,
      opts.deleted ? new Date(Date.now() + 86_400_000).toISOString() : null,
    )
    .first<{ id: number }>();
  return row!.id;
}

/** Direct arsip insert (status Menunggu by default). */
export async function insertArsip(
  pegawaiId: number,
  jenisId: string,
  opts: { uploadedAt?: string; status?: string; versi?: number; deleted?: boolean } = {},
): Promise<number> {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO arsip_dokumen (pegawai_id, jenis_dokumen_id, status, r2_key, file_name, mime_type, size_bytes, sha256,
                                versi, uploaded_at, uploaded_by, deleted_at, purge_after)
     VALUES (?1, ?2, ?3, ?4, 'f.pdf', 'application/pdf', 10, ?5, ?6, ?7, ?1, ?8, ?9) RETURNING id`,
  )
    .bind(
      pegawaiId,
      jenisId,
      opts.status ?? 'Menunggu',
      `dokumen/${pegawaiId}/${jenisId}/${crypto.randomUUID()}.pdf`,
      '0'.repeat(64),
      opts.versi ?? 1,
      opts.uploadedAt ?? now,
      opts.deleted ? now : null,
      opts.deleted ? new Date(Date.now() + 86_400_000).toISOString() : null,
    )
    .first<{ id: number }>();
  return row!.id;
}

export async function ensureJenis(id: string, nama = id): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO jenis_dokumen (id, nama, kategori, urutan, aktif) VALUES (?1, ?2, 'Dokumen Uji', 999, 1)`,
  )
    .bind(id, nama)
    .run();
}

export async function setNotif(values: { dokumenBaru?: boolean; dokumenApproved?: boolean; dokumenRejected?: boolean }) {
  const map = {
    'notif.dokumen_baru': values.dokumenBaru,
    'notif.dokumen_approved': values.dokumenApproved,
    'notif.dokumen_rejected': values.dokumenRejected,
  };
  for (const [key, v] of Object.entries(map)) {
    if (v === undefined) continue;
    await env.DB.prepare(
      `INSERT INTO pengaturan (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
      .bind(key, v ? 'true' : 'false')
      .run();
  }
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** Mock global fetch (provider APIs). Restore with vi.restoreAllMocks(). */
export function mockFetch(respond: (url: string) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url);
  });
  return calls;
}

export const fonnteOk = () => new Response(JSON.stringify({ status: true, detail: 'success! message in queue' }), { status: 200 });
