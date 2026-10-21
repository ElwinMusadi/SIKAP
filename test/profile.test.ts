import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PHOTO_POLICY, type DashboardResponse, type PhotoResponse, type ProfileResponse, type RefResponse } from '../shared/profile';
import { sniffImage } from '../server/lib/file-sniff';
import { call, createUser, json, login } from './helpers';

interface ErrBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

async function signedIn() {
  const user = await createUser();
  const cookie = await login(user);
  return { user, cookie };
}

/** Unique 16-digit NIK per call. */
let nikSeq = 0;
function uniqueNik(): string {
  nikSeq += 1;
  return `53${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}${String(nikSeq).padStart(8, '0')}`;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function pngBytes(extra = 100): Uint8Array {
  const b = new Uint8Array(PNG_MAGIC.length + extra);
  b.set(PNG_MAGIC, 0);
  return b;
}
function photoForm(bytes: Uint8Array, name = 'a.png', type = 'image/png'): FormData {
  const fd = new FormData();
  fd.append('file', new File([bytes], name, { type }));
  return fd;
}
async function fotoKeyOf(id: number): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT foto_r2_key FROM pegawai WHERE id = ?1`)
    .bind(id)
    .first<{ foto_r2_key: string | null }>();
  return row?.foto_r2_key ?? null;
}

describe('GET /api/ref', () => {
  it('returns active reference data with a private cache header', async () => {
    const { cookie } = await signedIn();
    const res = await call('/api/ref', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
    const body = await json<RefResponse>(res);
    expect(body.pangkat.filter((p) => p.jenisAsn === 'PNS')).toHaveLength(17);
    expect(body.pangkat.filter((p) => p.jenisAsn === 'PPPK')).toHaveLength(17);
    const wajib = (s: 'PNS' | 'CPNS' | 'PPPK') => body.jenisDokumen.filter((d) => d.wajibUntuk.includes(s)).length;
    expect(wajib('PNS')).toBe(9);
    expect(wajib('CPNS')).toBe(7);
    expect(wajib('PPPK')).toBe(6);
    expect(body.pendidikan.length).toBeGreaterThan(0);
  });

  it('requires a session', async () => {
    const res = await call('/api/ref');
    expect(res.status).toBe(401);
  });

  it('keeps no-store on other API responses', async () => {
    const { cookie } = await signedIn();
    const res = await call('/api/me/profile', { cookie });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/me/profile', () => {
  it('lists all 10 missing fields for a fresh user', async () => {
    const { user, cookie } = await signedIn();
    const res = await call('/api/me/profile', { cookie });
    expect(res.status).toBe(200);
    const body = await json<ProfileResponse>(res);
    expect(body.profile.id).toBe(user.id);
    expect(body.profile.nip).toBe(user.nip);
    expect(body.missingFields).toHaveLength(10);
    expect(body.pengajuanAktif).toBeNull();
  });

  it('includes the pending pengajuan', async () => {
    const { user, cookie } = await signedIn();
    const perubahan = { jabatan: { lama: 'Penguji', baru: 'Analis' } };
    await env.DB.prepare(
      `INSERT INTO pengajuan_perubahan (pegawai_id, perubahan, alasan, status, created_at)
       VALUES (?1, ?2, 'Alasan pengujian', 'Menunggu', ?3)`,
    )
      .bind(user.id, JSON.stringify(perubahan), new Date().toISOString())
      .run();
    const body = await json<ProfileResponse>(await call('/api/me/profile', { cookie }));
    expect(body.pengajuanAktif?.perubahan).toEqual(perubahan);
    expect(body.pengajuanAktif?.reviewedBy).toBeNull();
  });
});

describe('PATCH /api/me/profile', () => {
  it('normalises phone and email, and clears with empty string', async () => {
    const { cookie } = await signedIn();
    let res = await call('/api/me/profile', {
      method: 'PATCH',
      cookie,
      body: { noHp: '0812-3456-7890', email: 'Foo@Example.COM', tempatLahir: 'Kupang' },
    });
    expect(res.status).toBe(200);
    let body = await json<ProfileResponse>(res);
    expect(body.profile.noHp).toBe('6281234567890');
    expect(body.profile.email).toBe('foo@example.com');
    expect(body.profile.tempatLahir).toBe('Kupang');
    expect(body.missingFields).toHaveLength(7);

    res = await call('/api/me/profile', { method: 'PATCH', cookie, body: { tempatLahir: '' } });
    expect(res.status).toBe(200);
    body = await json<ProfileResponse>(res);
    expect(body.profile.tempatLahir).toBeNull();
    expect(body.profile.noHp).toBe('6281234567890');
  });

  it('rejects employment fields with a _form message', async () => {
    const { cookie } = await signedIn();
    const res = await call('/api/me/profile', { method: 'PATCH', cookie, body: { jabatan: 'x' } });
    expect(res.status).toBe(400);
    const body = await json<ErrBody>(res);
    expect(body.error.fields?._form).toMatch(/pengajuan perubahan/);
  });

  it('rejects an empty patch', async () => {
    const { cookie } = await signedIn();
    const res = await call('/api/me/profile', { method: 'PATCH', cookie, body: {} });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?._form).toBe('Tidak ada perubahan.');
  });

  it('rejects an invalid NIK', async () => {
    const { cookie } = await signedIn();
    const res = await call('/api/me/profile', { method: 'PATCH', cookie, body: { nik: '123' } });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.nik).toBeTruthy();
  });

  it('rejects a NIK used by another pegawai with 409', async () => {
    const a = await signedIn();
    const b = await signedIn();
    const nik = uniqueNik();
    expect((await call('/api/me/profile', { method: 'PATCH', cookie: a.cookie, body: { nik } })).status).toBe(200);
    const res = await call('/api/me/profile', { method: 'PATCH', cookie: b.cookie, body: { nik } });
    expect(res.status).toBe(409);
    expect((await json<ErrBody>(res)).error.code).toBe('CONFLICT');
    // Same user re-saving own NIK is fine.
    expect((await call('/api/me/profile', { method: 'PATCH', cookie: a.cookie, body: { nik } })).status).toBe(200);
  });

  it('rejects an unknown pendidikanKode and accepts a known one', async () => {
    const { cookie } = await signedIn();
    let res = await call('/api/me/profile', { method: 'PATCH', cookie, body: { pendidikanKode: 'XX-NOPE' } });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.pendidikanKode).toBe('Pendidikan tidak valid.');

    const known = await env.DB.prepare(`SELECT kode FROM ref_pendidikan LIMIT 1`).first<{ kode: string }>();
    res = await call('/api/me/profile', { method: 'PATCH', cookie, body: { pendidikanKode: known!.kode } });
    expect(res.status).toBe(200);
    expect((await json<ProfileResponse>(res)).profile.pendidikanKode).toBe(known!.kode);
  });

  it('audits field names without values', async () => {
    const { user, cookie } = await signedIn();
    const nik = uniqueNik();
    const res = await call('/api/me/profile', { method: 'PATCH', cookie, body: { nik, alamat: 'Jl. Uji 1' } });
    expect(res.status).toBe(200);
    const log = await env.DB.prepare(
      `SELECT description FROM log_aktivitas WHERE actor_id = ?1 AND action = 'PROFILE_UPDATE' ORDER BY id DESC LIMIT 1`,
    )
      .bind(user.id)
      .first<{ description: string }>();
    expect(log?.description).toContain('nik');
    expect(log?.description).toContain('alamat');
    expect(log?.description).not.toContain(nik);
    expect(log?.description).not.toContain('Jl. Uji');
  });

  it('rejects malformed JSON', async () => {
    const { cookie } = await signedIn();
    const res = await call('/api/me/profile', { method: 'PATCH', cookie, body: undefined, headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
  });
});

describe('photo', () => {
  it('uploads a PNG, serves it with ETag and honours If-None-Match', async () => {
    const { user, cookie } = await signedIn();
    const res = await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(pngBytes()) });
    expect(res.status).toBe(200);
    const body = await json<PhotoResponse>(res);
    expect(body.fotoUrl).toMatch(new RegExp(`^/api/pegawai/${user.id}/photo\\?v=`));

    const key = await fotoKeyOf(user.id);
    expect(key).toMatch(new RegExp(`^foto/${user.id}/.+\\.png$`));
    const obj = await env.FILES.get(key!);
    expect(obj).not.toBeNull();
    await obj?.arrayBuffer();

    const get = await call(body.fotoUrl, { cookie });
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/png');
    expect(get.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(get.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const etag = get.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(new Uint8Array(await get.arrayBuffer()).length).toBe(108);

    const cached = await call(body.fotoUrl, { cookie, headers: { 'If-None-Match': etag! } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('ETag')).toBe(etag);

    // /auth/me reflects the same cache-busted URL.
    const me = await json<{ user: { fotoUrl: string } }>(await call('/api/auth/me', { cookie }));
    expect(me.user.fotoUrl).toBe(body.fotoUrl);
  });

  it('rejects a non-image disguised as PNG', async () => {
    const { cookie } = await signedIn();
    const text = new TextEncoder().encode('hello, this is not an image at all');
    const res = await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(text, 'x.png') });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.file).toBe('File harus berupa gambar JPG, PNG, atau WEBP.');
  });

  it('rejects a photo larger than the limit', async () => {
    const { cookie } = await signedIn();
    const res = await call('/api/me/photo', {
      method: 'PUT',
      cookie,
      formData: photoForm(pngBytes(PHOTO_POLICY.maxBytes)),
    });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.file).toBeTruthy();
  });

  it('rejects a missing file field', async () => {
    const { cookie } = await signedIn();
    const fd = new FormData();
    fd.append('other', 'x');
    const res = await call('/api/me/photo', { method: 'PUT', cookie, formData: fd });
    expect(res.status).toBe(400);
  });

  it('deletes the old R2 object when the photo is replaced', async () => {
    const { user, cookie } = await signedIn();
    expect((await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(pngBytes()) })).status).toBe(200);
    const oldKey = await fotoKeyOf(user.id);
    expect((await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(pngBytes(50)) })).status).toBe(200);
    const newKey = await fotoKeyOf(user.id);
    expect(newKey).not.toBe(oldKey);
    expect(await env.FILES.head(oldKey!)).toBeNull();
    expect(await env.FILES.head(newKey!)).not.toBeNull();
  });

  it('returns 404 for a pegawai without a photo or an invalid id', async () => {
    const { cookie } = await signedIn();
    const other = await createUser();
    expect((await call(`/api/pegawai/${other.id}/photo`, { cookie })).status).toBe(404);
    expect((await call(`/api/pegawai/abc/photo`, { cookie })).status).toBe(404);
    expect((await call(`/api/pegawai/0/photo`, { cookie })).status).toBe(404);
  });

  it('requires a session to upload or view', async () => {
    const { user } = await signedIn();
    expect((await call(`/api/pegawai/${user.id}/photo`)).status).toBe(401);
    expect((await call('/api/me/photo', { method: 'PUT', formData: photoForm(pngBytes()) })).status).toBe(401);
  });
});

describe('GET /api/me/dashboard', () => {
  async function insertArsip(pegawaiId: number, jenisId: string, status: string, catatan: string | null = null) {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO arsip_dokumen (pegawai_id, jenis_dokumen_id, status, r2_key, file_name, mime_type, size_bytes, sha256, catatan_admin, uploaded_at)
       VALUES (?1, ?2, ?3, ?4, 'f.pdf', 'application/pdf', 10, 'x', ?5, ?6)`,
    )
      .bind(pegawaiId, jenisId, status, `dummy/${pegawaiId}/${jenisId}`, catatan, now)
      .run();
  }

  it('computes progress and priorities for a PNS employee', async () => {
    const { user, cookie } = await signedIn();
    const wajib = await env.DB.prepare(
      `SELECT j.id FROM jenis_dokumen j JOIN jenis_dokumen_wajib w ON w.jenis_dokumen_id = j.id
        WHERE w.status_kepegawaian = 'PNS' AND j.aktif = 1 ORDER BY j.urutan, j.nama`,
    ).all<{ id: string }>();
    const ids = wajib.results.map((r) => r.id);
    expect(ids.length).toBe(9);
    await insertArsip(user.id, ids[0]!, 'Terverifikasi');
    await insertArsip(user.id, ids[1]!, 'Terverifikasi');
    await insertArsip(user.id, ids[2]!, 'Menunggu');
    await insertArsip(user.id, ids[3]!, 'Ditolak', 'Buram');

    const res = await call('/api/me/dashboard', { cookie });
    expect(res.status).toBe(200);
    const body = await json<DashboardResponse>(res);
    expect(body.statusKepegawaianKosong).toBe(false);
    expect(body.dokumen.wajibTotal).toBe(9);
    expect(body.dokumen.wajibTerverifikasi).toBe(2);
    expect(body.dokumen.wajibTersedia).toBe(4);
    expect(body.dokumen.persen).toBe(22);
    expect(body.dokumen.counts.Terverifikasi).toBe(2);
    expect(body.dokumen.counts.Ditolak).toBe(1);
    expect(body.dokumen.counts.Menunggu).toBe(1);
    expect(body.dokumen.prioritas).toHaveLength(5);
    expect(body.dokumen.prioritas[0]?.status).toBe('Ditolak');
    expect(body.dokumen.prioritas[0]?.catatanAdmin).toBe('Buram');
    expect(body.dokumen.prioritas[1]?.status).toBe('Belum diunggah');
    expect(body.profil.total).toBe(10);
    expect(body.profil.terisi).toBe(0);
    expect(body.profil.missingFields).toHaveLength(10);
    expect(body.pengajuanAktif).toBeNull();
  });

  it('flags an empty status kepegawaian', async () => {
    const user = await createUser();
    await env.DB.prepare(`UPDATE pegawai SET status_kepegawaian = NULL WHERE id = ?1`).bind(user.id).run();
    const cookie = await login(user);
    const body = await json<DashboardResponse>(await call('/api/me/dashboard', { cookie }));
    expect(body.statusKepegawaianKosong).toBe(true);
    expect(body.dokumen.wajibTotal).toBe(0);
    expect(body.dokumen.persen).toBe(0);
  });
});

describe('review fixes (profile/photo)', () => {
  it.each(['role', 'nip', 'foto_r2_key', 'statusKepegawaian'])('PATCH rejects the protected key %s', async (key) => {
    const { cookie } = await signedIn();
    const res = await call('/api/me/profile', { method: 'PATCH', cookie, body: { [key]: 'x' } });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?._form).toMatch(/pengajuan perubahan/);
  });

  it('validates tanggalLahir strictly', async () => {
    const { cookie } = await signedIn();
    const patch = (tanggalLahir: string) => call('/api/me/profile', { method: 'PATCH', cookie, body: { tanggalLahir } });
    let res = await patch('2026-02-31');
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.tanggalLahir).toBeTruthy();

    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    res = await patch(future);
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.tanggalLahir).toBe('Tanggal lahir tidak boleh di masa depan.');

    expect((await patch('1899-12-31')).status).toBe(400);
    res = await patch('1990-02-28');
    expect(res.status).toBe(200);
    expect((await json<ProfileResponse>(res)).profile.tanggalLahir).toBe('1990-02-28');
  });

  it('serves the photo with a sandboxing CSP and nosniff', async () => {
    const { user, cookie } = await signedIn();
    expect((await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(pngBytes()) })).status).toBe(200);
    const res = await call(`/api/pegawai/${user.id}/photo`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await res.arrayBuffer();
  });

  it('never answers If-Match with 304', async () => {
    const { user, cookie } = await signedIn();
    expect((await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(pngBytes()) })).status).toBe(200);
    const res = await call(`/api/pegawai/${user.id}/photo`, { cookie, headers: { 'If-Match': '"nope"' } });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it('accepts JPEG and WEBP uploads', async () => {
    const { user, cookie } = await signedIn();
    const jpeg = new Uint8Array(64);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
    let res = await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(jpeg, 'a.jpg', 'image/jpeg') });
    expect(res.status).toBe(200);
    expect(await fotoKeyOf(user.id)).toMatch(/\.jpg$/);

    const webp = new Uint8Array(64);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    res = await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(webp, 'a.webp', 'image/webp') });
    expect(res.status).toBe(200);
    const key = await fotoKeyOf(user.id);
    expect(key).toMatch(/\.webp$/);
    const obj = await env.FILES.head(key!);
    expect(obj?.httpMetadata?.contentType).toBe('image/webp');
  });

  it('rejects a body above the photo body limit with 400', async () => {
    const { cookie } = await signedIn();
    const big = pngBytes(PHOTO_POLICY.maxBytes + 128 * 1024);
    const res = await call('/api/me/photo', { method: 'PUT', cookie, formData: photoForm(big) });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects state-changing profile/photo requests without a same-site Origin', async () => {
    const { cookie } = await signedIn();
    for (const origin of [null, 'https://evil.example']) {
      const photo = await call('/api/me/photo', { method: 'PUT', cookie, origin, formData: photoForm(pngBytes()) });
      expect(photo.status).toBe(403);
      expect((await json<ErrBody>(photo)).error.code).toBe('CSRF_REJECTED');
      const patch = await call('/api/me/profile', { method: 'PATCH', cookie, origin, body: { alamat: 'x' } });
      expect(patch.status).toBe(403);
    }
  });
});

describe('sniffImage', () => {
  const bytes = (...parts: (number[] | string)[]) => {
    const out: number[] = [];
    for (const p of parts) out.push(...(typeof p === 'string' ? Array.from(new TextEncoder().encode(p)) : p));
    return new Uint8Array(out);
  };

  it('accepts JPEG, PNG and WEBP', () => {
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toEqual({
      mime: 'image/png',
      ext: 'png',
    });
    expect(sniffImage(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('rejects other RIFF containers, truncated input and SVG', () => {
    expect(sniffImage(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt '))).toBeNull();
    expect(sniffImage(bytes([0xff, 0xd8]))).toBeNull();
    expect(sniffImage(bytes([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffImage(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});
