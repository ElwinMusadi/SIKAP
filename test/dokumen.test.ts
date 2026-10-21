import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_POLICY, type DokumenItemResponse, type DokumenListResponse, type RiwayatResponse } from '../shared/dokumen';
import { r2KeyReferenced } from '../server/db/dokumen';
import { sniffDocument } from '../server/lib/file-sniff';
import { deleteUnreferencedObject } from '../server/lib/r2';
import { clientFileName } from '../server/services/dokumen';
import { call, createUser, json, login, type TestUser } from './helpers';

const DAY = 86_400_000;

function pdfBytes(size = 512): Uint8Array {
  const b = new Uint8Array(size).fill(0x20);
  b.set(new TextEncoder().encode('%PDF-1.4\n'));
  return b;
}
function pngBytes(size = 256): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}
function jpegBytes(size = 256): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
}
function webpBytes(size = 256): Uint8Array {
  const b = new Uint8Array(size);
  b.set(new TextEncoder().encode('RIFF'));
  b.set(new TextEncoder().encode('WEBP'), 8);
  return b;
}
interface FileSpec {
  bytes: Uint8Array;
  name: string;
  type: string;
}
function form(bytes: Uint8Array, name = 'doc.pdf', type = 'application/pdf'): FileSpec {
  return { bytes, name, type };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Raw PUT upload as the SPA does it (contract M5). */
async function putDoc(
  cookie: string,
  jenis: string,
  bytes: Uint8Array,
  opts: {
    sha?: string | null;
    length?: string | null;
    name?: string;
    type?: string;
    origin?: string | null;
    body?: BodyInit;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': opts.type ?? 'application/octet-stream' };
  const sha = opts.sha === undefined ? await sha256Hex(bytes) : opts.sha;
  if (sha !== null) headers['X-Content-SHA256'] = sha;
  const length = opts.length === undefined ? String(bytes.byteLength) : opts.length;
  if (length !== null) headers['Content-Length'] = length;
  if (opts.name) headers['X-File-Name'] = encodeURIComponent(opts.name);
  return call(`/api/me/documents/${jenis}`, {
    method: 'PUT',
    cookie,
    headers,
    origin: opts.origin,
    rawBody: opts.body ?? bytes,
  });
}

async function completeProfile(id: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE pegawai SET no_hp = '081234567890', email = ?2, nik = ?3, tempat_lahir = 'Kupang',
            tanggal_lahir = '1990-01-01', jenis_kelamin = 'Laki-laki', agama = 'Islam', pendidikan_kode = 'SMA',
            status_pernikahan = 'Menikah', alamat = 'Jl. Uji 1'
      WHERE id = ?1`,
  )
    .bind(id, `u${id}@example.test`, String(3200000000000000 + id))
    .run();
}

async function pegawai(opts: { complete?: boolean; role?: 'Admin' | 'Pegawai' } = {}): Promise<{ user: TestUser; cookie: string }> {
  const user = await createUser({ role: opts.role });
  if (opts.complete !== false) await completeProfile(user.id);
  return { user, cookie: await login(user) };
}

async function upload(cookie: string, jenis = 'DOC-KTP', fd = form(pdfBytes())): Promise<Response> {
  return putDoc(cookie, jenis, fd.bytes, { name: fd.name, type: fd.type });
}

async function uploadOk(cookie: string, jenis = 'DOC-KTP', fd?: FileSpec): Promise<DokumenItemResponse['item']> {
  const res = await upload(cookie, jenis, fd);
  if (res.status !== 201 && res.status !== 200) throw new Error(`upload ${res.status}: ${await res.text()}`);
  return (await json<DokumenItemResponse>(res)).item;
}

async function setStatus(arsipId: number, status: string, verifiedBy: number | null = null): Promise<void> {
  await env.DB.prepare(`UPDATE arsip_dokumen SET status = ?2, verified_by = ?3, verified_at = ?4 WHERE id = ?1`)
    .bind(arsipId, status, verifiedBy, verifiedBy ? new Date().toISOString() : null)
    .run();
}

async function arsipRow(id: number) {
  return env.DB.prepare(`SELECT * FROM arsip_dokumen WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
}

async function r2Exists(key: string): Promise<boolean> {
  return (await env.FILES.head(key)) !== null;
}

describe('sniffDocument', () => {
  it('accepts PDF and images, rejects HTML', () => {
    expect(sniffDocument(pdfBytes(16))).toEqual({ mime: 'application/pdf', ext: 'pdf' });
    expect(sniffDocument(pngBytes(16))?.mime).toBe('image/png');
    expect(sniffDocument(jpegBytes(16))?.mime).toBe('image/jpeg');
    expect(sniffDocument(new TextEncoder().encode('<html><script>'))).toBeNull();
  });
});

describe('GET /api/me/documents', () => {
  it('keeps an inactive document type visible when it has an archive, but never mandatory/uploadable', async () => {
    const { cookie } = await pegawai();
    const jenis = `DOC-HIST-${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO jenis_dokumen(id,nama,kategori,urutan,aktif,max_size_bytes)
        VALUES (?1,'Riwayat nonaktif','Pengujian',999,1,5242880)`).bind(jenis),
      env.DB.prepare(`INSERT INTO jenis_dokumen_wajib(jenis_dokumen_id,status_kepegawaian) VALUES (?1,'PNS')`).bind(jenis),
    ]);
    const item = await uploadOk(cookie, jenis);
    await env.DB.prepare('UPDATE jenis_dokumen SET aktif=0 WHERE id=?1').bind(jenis).run();
    const list = await json<DokumenListResponse>(await call('/api/me/documents', { cookie }));
    const historical = list.items.find((row) => row.jenisDokumenId === jenis);
    expect(historical?.arsip?.id).toBe(item.arsip?.id);
    expect(historical?.wajib).toBe(false);
    expect(historical?.can.upload).toBe(false);
    expect(historical?.uploadBlockedReason).toBe('Jenis dokumen tidak aktif.');
    expect((await call(`/api/documents/${item.arsip?.id}/file`, { cookie })).status).toBe(200);
  });

  it('lists all types with 9 wajib for PNS', async () => {
    const { user, cookie } = await pegawai({ complete: false });
    const res = await call('/api/me/documents', { cookie });
    expect(res.status).toBe(200);
    const body = await json<DokumenListResponse>(res);
    expect(body.pegawai.id).toBe(user.id);
    expect(body.items).toHaveLength(11);
    expect(body.summary.wajibTotal).toBe(9);
    expect(body.summary.counts['Belum diunggah']).toBe(11);
    expect(body.summary.persen).toBe(0);
    expect(body.profileMissingFields.length).toBeGreaterThan(0);
    const ktp = body.items.find((i) => i.jenisDokumenId === 'DOC-KTP');
    expect(ktp?.can.upload).toBe(false);
    expect(ktp?.uploadBlockedReason).toMatch(/Lengkapi profil/);
  });

  it('PPPK has 6 wajib; complete profile can upload', async () => {
    const { user, cookie } = await pegawai();
    await env.DB.prepare(`UPDATE pegawai SET status_kepegawaian = 'PPPK' WHERE id = ?1`).bind(user.id).run();
    const body = await json<DokumenListResponse>(await call('/api/me/documents', { cookie }));
    expect(body.summary.wajibTotal).toBe(6);
    expect(body.profileMissingFields).toEqual([]);
    expect(body.items.every((i) => i.can.upload)).toBe(true);
  });

  it('requires a session', async () => {
    expect((await call('/api/me/documents')).status).toBe(401);
  });
});

type ErrBody = { error: { code: string; message: string; fields?: Record<string, string> } };

async function arsipCount(pegawaiId: number): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM arsip_dokumen WHERE pegawai_id = ?1`)
    .bind(pegawaiId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
async function r2Count(pegawaiId: number): Promise<number> {
  return (await env.FILES.list({ prefix: `dokumen/${pegawaiId}/` })).objects.length;
}

describe('PUT /api/me/documents/:jenisId', () => {
  it('blocks upload when the profile is incomplete', async () => {
    const { cookie } = await pegawai({ complete: false });
    const res = await upload(cookie);
    expect(res.status).toBe(400);
    const err = (await json<ErrBody>(res)).error;
    expect(err.fields?._form).toMatch(/Lengkapi profil/);
    expect(err.fields?.profile).toContain('NIK');
  });

  it('uploads a PDF: 201 Menunggu, R2 object with checksum, riwayat and audit on the arsip', async () => {
    const { user, cookie } = await pegawai();
    const bytes = pdfBytes();
    const res = await putDoc(cookie, 'DOC-KTP', bytes, { name: 'KTP saya ü.pdf', type: 'application/pdf' });
    expect(res.status).toBe(201);
    const { item } = await json<DokumenItemResponse>(res);
    expect(item.status).toBe('Menunggu');
    expect(item.arsip?.versi).toBe(1);
    expect(item.arsip?.mimeType).toBe('application/pdf');
    expect(item.arsip?.sizeBytes).toBe(bytes.byteLength);
    expect(item.arsip?.fileName).toMatch(new RegExp(`^${user.nip}_User_\\d{4}_DOC-KTP\\.pdf$`));
    expect(item.can.upload).toBe(false);
    expect(item.can.delete).toBe(true);
    const row = await arsipRow(item.arsip!.id);
    expect(row?.sha256).toBe(await sha256Hex(bytes));
    const obj = await env.FILES.get(String(row?.r2_key));
    expect(obj).not.toBeNull();
    expect(obj?.httpMetadata?.contentType).toBe('application/pdf');
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
    // L2: first-upload audit points at the new arsip via last_insert_rowid().
    const audit = await env.DB.prepare(
      `SELECT target_type, target_id, description FROM log_aktivitas WHERE action = 'DOKUMEN_UPLOAD' AND actor_id = ?1`,
    )
      .bind(user.id)
      .all<{ target_type: string; target_id: string; description: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]?.target_type).toBe('arsip_dokumen');
    expect(audit.results[0]?.target_id).toBe(String(item.arsip!.id));
    expect(audit.results[0]?.description).toContain('KTP saya ü.pdf');
    const riwayat = await env.DB.prepare(
      `SELECT aksi, pegawai_id, jenis_dokumen_id FROM arsip_dokumen_riwayat WHERE arsip_id = ?1`,
    )
      .bind(item.arsip!.id)
      .all<{ aksi: string; pegawai_id: number; jenis_dokumen_id: string }>();
    expect(riwayat.results).toEqual([{ aksi: 'UPLOAD', pegawai_id: user.id, jenis_dokumen_id: 'DOC-KTP' }]);
  });

  it('accepts PNG, JPEG and WEBP', async () => {
    const { cookie } = await pegawai();
    expect((await upload(cookie, 'DOC-KK', form(pngBytes(), 'a.png', 'image/png'))).status).toBe(201);
    expect((await upload(cookie, 'DOC-NPWP', form(jpegBytes(), 'a.jpg', 'image/jpeg'))).status).toBe(201);
    const res = await upload(cookie, 'DOC-DRH', form(webpBytes(), 'a.webp', 'image/webp'));
    expect(res.status).toBe(201);
    expect((await json<DokumenItemResponse>(res)).item.arsip?.mimeType).toBe('image/webp');
  });

  it('rejects spoofed HTML, %PDF without dash, RIFF WAVE and unknown jenis', async () => {
    const { user, cookie } = await pegawai();
    const enc = new TextEncoder();
    const wave = new Uint8Array(64);
    wave.set(enc.encode('RIFF'));
    wave.set(enc.encode('WAVE'), 8);
    for (const bytes of [enc.encode('<html><script>alert(1)</script></html>'), enc.encode('%PDF1.4 not really a pdf'), wave]) {
      const res = await putDoc(cookie, 'DOC-KTP', bytes, { name: 'x.pdf', type: 'application/pdf' });
      expect(res.status).toBe(400);
      expect((await json<ErrBody>(res)).error.fields?.file).toMatch(/PDF, JPG/);
    }
    expect((await upload(cookie, 'DOC-NOPE')).status).toBe(404);
    expect(await arsipCount(user.id)).toBe(0);
    expect(await r2Count(user.id)).toBe(0);
  });

  it('wrong checksum: 400, no row and no R2 object left', async () => {
    const { user, cookie } = await pegawai();
    const res = await putDoc(cookie, 'DOC-KTP', pdfBytes(), { sha: 'a'.repeat(64) });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.file).toMatch(/checksum tidak cocok/);
    expect(await arsipCount(user.id)).toBe(0);
    expect(await r2Count(user.id)).toBe(0);
  });

  it('missing or malformed checksum header: 400', async () => {
    const { cookie } = await pegawai();
    for (const sha of [null, 'A'.repeat(64), 'abc']) {
      const res = await putDoc(cookie, 'DOC-KTP', pdfBytes(), { sha });
      expect(res.status).toBe(400);
      expect((await json<ErrBody>(res)).error.fields?.file).toBe('Checksum file tidak valid.');
    }
  });

  it('missing Content-Length (streamed body): 400', async () => {
    const { user, cookie } = await pegawai();
    const bytes = pdfBytes();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(bytes);
        ctrl.close();
      },
    });
    const res = await putDoc(cookie, 'DOC-KTP', bytes, { length: null, body: stream });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.file).toMatch(/Content-Length/);
    expect(await arsipCount(user.id)).toBe(0);
  });

  it('Content-Length above the limit: 400 without reading the body', async () => {
    const { user, cookie } = await pegawai();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(ctrl) {
          pulled = true;
          ctrl.enqueue(pdfBytes(16));
          ctrl.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await putDoc(cookie, 'DOC-KTP', pdfBytes(16), {
      length: String(DOCUMENT_POLICY.maxBytes + 1),
      body: stream,
    });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.file).toMatch(/maksimal 5 MB/);
    expect(pulled).toBe(false);
    expect(await arsipCount(user.id)).toBe(0);
  });

  it('body length different from Content-Length: 400, nothing stored', async () => {
    const { user, cookie } = await pegawai();
    const bytes = pdfBytes(512);
    const res = await putDoc(cookie, 'DOC-KTP', bytes, { length: '1024' });
    expect(res.status).toBe(400);
    expect(await arsipCount(user.id)).toBe(0);
    expect(await r2Count(user.id)).toBe(0);
  });

  it('Menunggu 409 is returned before the body is read', async () => {
    const { cookie } = await pegawai();
    await uploadOk(cookie);
    // A body that would fail sniffing: the conflict must win.
    const html = new TextEncoder().encode('<html><script>');
    const res = await putDoc(cookie, 'DOC-KTP', html);
    expect(res.status).toBe(409);
  });

  it('re-upload after Ditolak keeps the old version and its R2 object', async () => {
    const { cookie } = await pegawai();
    const first = await uploadOk(cookie);
    const arsipId = first.arsip!.id;
    const oldKey = String((await arsipRow(arsipId))?.r2_key);
    await setStatus(arsipId, 'Ditolak');

    const before = Date.now();
    const res = await upload(cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png'));
    expect(res.status).toBe(200);
    const { item } = await json<DokumenItemResponse>(res);
    expect(item.arsip?.versi).toBe(2);
    expect(item.status).toBe('Menunggu');
    expect(item.versiSebelumnya).toHaveLength(1);
    expect(item.versiSebelumnya[0]?.status).toBe('Ditolak');

    const v = await env.DB.prepare(`SELECT * FROM arsip_dokumen_versi WHERE arsip_id = ?1`)
      .bind(arsipId)
      .first<{ versi: number; r2_key: string; reason: string; purge_after: string }>();
    expect(v?.versi).toBe(1);
    expect(v?.reason).toBe('REUPLOAD');
    expect(v?.r2_key).toBe(oldKey);
    const purge = Date.parse(v!.purge_after);
    expect(purge).toBeGreaterThanOrEqual(before + 3 * DAY - 5_000);
    expect(purge).toBeLessThanOrEqual(Date.now() + 3 * DAY + 5_000);
    expect(await r2Exists(oldKey)).toBe(true);
    const newKey = String((await arsipRow(arsipId))?.r2_key);
    expect(newKey).not.toBe(oldKey);
    expect(await r2Exists(newKey)).toBe(true);
    const audit = await env.DB.prepare(
      `SELECT target_type, target_id FROM log_aktivitas WHERE action = 'DOKUMEN_REUPLOAD' AND target_id = ?1`,
    )
      .bind(String(arsipId))
      .first<{ target_type: string }>();
    expect(audit?.target_type).toBe('arsip_dokumen');
  });

  it('upload over a restorable soft-deleted arsip: 200, deleted file becomes a DELETE version', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    const oldKey = String((await arsipRow(id))?.r2_key);
    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie })).status).toBe(200);
    const deletedPurge = String((await arsipRow(id))?.purge_after);

    const list = await json<DokumenListResponse>(await call('/api/me/documents', { cookie }));
    const ktp = list.items.find((i) => i.jenisDokumenId === 'DOC-KTP');
    expect(ktp?.can.upload).toBe(true);
    expect(ktp?.uploadBlockedReason).toBeNull();

    const res = await upload(cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png'));
    expect(res.status).toBe(200);
    const { item } = await json<DokumenItemResponse>(res);
    expect(item.arsip?.id).toBe(id);
    expect(item.arsip?.versi).toBe(2);
    expect(item.status).toBe('Menunggu');
    expect(item.deleted).toBeNull();
    expect(item.versiSebelumnya).toHaveLength(1);
    expect(item.versiSebelumnya[0]?.versi).toBe(1);
    expect(item.versiSebelumnya[0]?.purgeAfter).toBe(deletedPurge);
    const v = await env.DB.prepare(`SELECT reason, r2_key FROM arsip_dokumen_versi WHERE arsip_id = ?1`)
      .bind(id)
      .first<{ reason: string; r2_key: string }>();
    expect(v).toEqual({ reason: 'DELETE', r2_key: oldKey });
    const row = await arsipRow(id);
    expect(row?.deleted_at).toBeNull();
    expect(row?.purge_after).toBeNull();
    expect(await r2Exists(oldKey)).toBe(true);
  });

  it('upload over an expired soft-deleted arsip: 200, expired file is not listed', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(`UPDATE arsip_dokumen SET deleted_at = ?2, purge_after = ?2 WHERE id = ?1`).bind(id, past).run();
    const res = await upload(cookie);
    expect(res.status).toBe(200);
    const { item } = await json<DokumenItemResponse>(res);
    expect(item.arsip?.versi).toBe(2);
    expect(item.deleted).toBeNull();
    expect(item.versiSebelumnya).toEqual([]);
  });

  it('rejects upload without Origin (CSRF)', async () => {
    const { cookie } = await pegawai();
    for (const origin of [null, 'https://evil.example']) {
      expect((await putDoc(cookie, 'DOC-KTP', pdfBytes(), { origin })).status).toBe(403);
    }
  });

  it('the old POST multipart route is gone', async () => {
    const { cookie } = await pegawai();
    const fd = new FormData();
    fd.append('file', new File([pdfBytes()], 'a.pdf', { type: 'application/pdf' }));
    const res = await call('/api/me/documents/DOC-KTP', { method: 'POST', cookie, formData: fd });
    expect(res.status).toBe(404);
  });
});

describe('deleteUnreferencedObject (compensation, M2)', () => {
  it('keeps a key still referenced by a row, deletes an unreferenced one', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    const usedKey = String((await arsipRow(id))?.r2_key);
    expect(await deleteUnreferencedObject(env.FILES, usedKey, r2KeyReferenced(env.DB, usedKey))).toBe('kept');
    expect(await r2Exists(usedKey)).toBe(true);

    const strayKey = `dokumen/test/${crypto.randomUUID()}.pdf`;
    await env.FILES.put(strayKey, pdfBytes(16));
    expect(await deleteUnreferencedObject(env.FILES, strayKey, r2KeyReferenced(env.DB, strayKey))).toBe('deleted');
    expect(await r2Exists(strayKey)).toBe(false);
  });

  it('a key referenced only by a version row is kept', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    const oldKey = String((await arsipRow(id))?.r2_key);
    await setStatus(id, 'Ditolak');
    await uploadOk(cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png'));
    expect(await deleteUnreferencedObject(env.FILES, oldKey, r2KeyReferenced(env.DB, oldKey))).toBe('kept');
  });
});

describe('GET /api/documents/:arsipId/file', () => {
  it('streams inline with safe headers; download=1 is an attachment', async () => {
    const { cookie } = await pegawai();
    const item = await uploadOk(cookie);
    const id = item.arsip!.id;
    let res = await call(`/api/documents/${id}/file`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline; filename="[^"]+\.pdf"; filename\*=UTF-8''/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(new Uint8Array(await res.arrayBuffer()).subarray(0, 5)).toEqual(new TextEncoder().encode('%PDF-'));

    res = await call(`/api/documents/${id}/file?download=1`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
    await res.arrayBuffer();
  });

  it('serves a previous version; unknown version is 404', async () => {
    const { cookie } = await pegawai();
    const first = await uploadOk(cookie);
    const id = first.arsip!.id;
    await setStatus(id, 'Ditolak');
    await uploadOk(cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png'));
    let res = await call(`/api/documents/${id}/file?versi=1`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    await res.arrayBuffer();
    res = await call(`/api/documents/${id}/file`, { cookie });
    expect(res.headers.get('Content-Type')).toBe('image/png');
    await res.arrayBuffer();
    expect((await call(`/api/documents/${id}/file?versi=9`, { cookie })).status).toBe(404);
  });

  it('other pegawai gets 404, admin 200, anonymous 401, bad id 404', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    const other = await pegawai();
    expect((await call(`/api/documents/${id}/file`, { cookie: other.cookie })).status).toBe(404);
    expect((await call(`/api/documents/${id}/riwayat`, { cookie: other.cookie })).status).toBe(404);
    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie: other.cookie })).status).toBe(404);
    const admin = await pegawai({ role: 'Admin' });
    const res = await call(`/api/documents/${id}/file`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect((await call(`/api/documents/${id}/file`)).status).toBe(401);
    expect((await call(`/api/documents/abc/file`, { cookie })).status).toBe(404);
  });
});

describe('delete / restore', () => {
  it('owner deletes a Menunggu document and restores it', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    let res = await call(`/api/documents/${id}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(200);
    let { item } = await json<DokumenItemResponse>(res);
    expect(item.status).toBe('Belum diunggah');
    expect(item.arsip).toBeNull();
    expect(item.deleted?.id).toBe(id);
    expect(item.can.restore).toBe(true);
    // Upload over a soft-deleted arsip is allowed (contract M1).
    expect(item.can.upload).toBe(true);
    // Still viewable during the retention window.
    const file = await call(`/api/documents/${id}/file`, { cookie });
    expect(file.status).toBe(200);
    await file.arrayBuffer();
    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie })).status).toBe(409);

    res = await call(`/api/documents/${id}/restore`, { method: 'POST', cookie });
    expect(res.status).toBe(200);
    ({ item } = await json<DokumenItemResponse>(res));
    expect(item.status).toBe('Menunggu');
    expect(item.deleted).toBeNull();
    expect(item.arsip?.id).toBe(id);
    expect((await call(`/api/documents/${id}/restore`, { method: 'POST', cookie })).status).toBe(409);
  });

  it('restore after purge time is 404', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    const past = new Date(Date.now() - 1000).toISOString();
    await env.DB.prepare(`UPDATE arsip_dokumen SET deleted_at = ?2, purge_after = ?2 WHERE id = ?1`).bind(id, past).run();
    expect((await call(`/api/documents/${id}/restore`, { method: 'POST', cookie })).status).toBe(404);
  });

  it('owner cannot delete Terverifikasi (403); admin can', async () => {
    const { cookie } = await pegawai();
    const admin = await pegawai({ role: 'Admin' });
    const id = (await uploadOk(cookie)).arsip!.id;
    await setStatus(id, 'Terverifikasi', admin.user.id);
    const list = await json<DokumenListResponse>(await call('/api/me/documents', { cookie }));
    const ktp = list.items.find((i) => i.jenisDokumenId === 'DOC-KTP');
    expect(ktp?.can.delete).toBe(false);
    expect(ktp?.arsip?.verifiedBy?.id).toBe(admin.user.id);
    expect(list.summary.wajibTerverifikasi).toBe(1);
    expect(list.summary.persen).toBe(Math.round(100 / 9));

    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie })).status).toBe(403);
    const res = await call(`/api/documents/${id}`, { method: 'DELETE', cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect((await json<DokumenItemResponse>(res)).item.deleted?.id).toBe(id);
    const audit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM log_aktivitas WHERE action = 'DOKUMEN_DELETE' AND target_id = ?1`,
    )
      .bind(String(id))
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('owner cannot restore a Terverifikasi document deleted by admin (403); admin can', async () => {
    const { cookie } = await pegawai();
    const admin = await pegawai({ role: 'Admin' });
    const id = (await uploadOk(cookie)).arsip!.id;
    await setStatus(id, 'Terverifikasi', admin.user.id);
    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie: admin.cookie })).status).toBe(200);

    const list = await json<DokumenListResponse>(await call('/api/me/documents', { cookie }));
    const ktp = list.items.find((i) => i.jenisDokumenId === 'DOC-KTP');
    expect(ktp?.deleted?.id).toBe(id);
    expect(ktp?.can.restore).toBe(false);
    const adminList = await json<DokumenListResponse>(
      await call(`/api/admin/pegawai/${list.pegawai.id}/documents`, { cookie: admin.cookie }),
    );
    expect(adminList.items.find((i) => i.jenisDokumenId === 'DOC-KTP')?.can.restore).toBe(true);

    const denied = await call(`/api/documents/${id}/restore`, { method: 'POST', cookie });
    expect(denied.status).toBe(403);
    expect((await json<ErrBody>(denied)).error.message).toBe(
      'Dokumen terverifikasi yang dihapus admin hanya dapat dipulihkan oleh admin.',
    );
    expect((await arsipRow(id))?.deleted_at).not.toBeNull();
    const res = await call(`/api/documents/${id}/restore`, { method: 'POST', cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect((await json<DokumenItemResponse>(res)).item.status).toBe('Terverifikasi');
  });
});

describe('admin-deleted verified file cannot be resurrected by the owner (upload + rollback)', () => {
  it('owner rollback to the DELETE/Terverifikasi version is 403; admin rollback is 200', async () => {
    const { user, cookie } = await pegawai();
    const admin = await pegawai({ role: 'Admin' });
    const id = (await uploadOk(cookie)).arsip!.id;
    await setStatus(id, 'Terverifikasi', admin.user.id);
    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie: admin.cookie })).status).toBe(200);

    const up = await upload(cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png'));
    expect(up.status).toBe(200);
    const { item } = await json<DokumenItemResponse>(up);
    expect(item.status).toBe('Menunggu');
    // Still visible, but not a valid rollback target for the owner.
    expect(item.versiSebelumnya.map((v) => [v.versi, v.status, v.bisaDipulihkan])).toEqual([
      [1, 'Terverifikasi', false],
    ]);
    expect(item.can.rollback).toBe(false);
    const adminList = await json<DokumenListResponse>(
      await call(`/api/admin/pegawai/${user.id}/documents`, { cookie: admin.cookie }),
    );
    const adminKtp = adminList.items.find((i) => i.jenisDokumenId === 'DOC-KTP');
    expect(adminKtp?.can.rollback).toBe(true);
    expect(adminKtp?.versiSebelumnya[0]?.bisaDipulihkan).toBe(true);

    const denied = await call(`/api/documents/${id}/rollback`, { cookie, body: { versi: 1 } });
    expect(denied.status).toBe(403);
    expect((await json<ErrBody>(denied)).error.message).toBe(
      'Dokumen terverifikasi yang dihapus admin hanya dapat dipulihkan oleh admin.',
    );
    const row = await arsipRow(id);
    expect(row?.status).toBe('Menunggu');
    expect(row?.versi).toBe(2);

    const res = await call(`/api/documents/${id}/rollback`, { cookie: admin.cookie, body: { versi: 1 } });
    expect(res.status).toBe(200);
    const after = (await json<DokumenItemResponse>(res)).item;
    expect(after.status).toBe('Terverifikasi');
    expect(after.arsip?.versi).toBe(3);
  });

  it('a non-verified DELETE version stays an owner rollback target', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    await setStatus(id, 'Ditolak');
    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie })).status).toBe(200);
    const { item } = await json<DokumenItemResponse>(await upload(cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png')));
    expect(item.can.rollback).toBe(true);
    expect(item.versiSebelumnya[0]?.bisaDipulihkan).toBe(true);
    const res = await call(`/api/documents/${id}/rollback`, { cookie, body: { versi: 1 } });
    expect(res.status).toBe(200);
    expect((await json<DokumenItemResponse>(res)).item.status).toBe('Ditolak');
  });
});

describe('raw upload failure paths', () => {
  it('R2 put failing mid-stream completes the request (no hang) and leaves nothing', async () => {
    const { user, cookie } = await pegawai();
    const spy = vi.spyOn(env.FILES, 'put').mockImplementationOnce(async (_key, value) => {
      // Read a little, then fail like a mid-stream R2 error.
      const r = (value as ReadableStream<Uint8Array>).getReader();
      await r.read();
      r.releaseLock();
      throw new Error('R2 internal error');
    });
    try {
      const big = pdfBytes(2 * 1024 * 1024);
      const res = await putDoc(cookie, 'DOC-KTP', big);
      expect(spy).toHaveBeenCalledTimes(1);
      // Unclassified R2 error: rethrown → generic 500 (never a hang).
      expect(res.status).toBe(500);
      await res.text();
    } finally {
      spy.mockRestore();
    }
    expect(await arsipCount(user.id)).toBe(0);
    expect(await r2Count(user.id)).toBe(0);
  }, 10_000);

  it('client disconnect before the head arrives is a 400, not a 500', async () => {
    const { user, cookie } = await pegawai();
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.error(new Error('client went away'));
      },
    });
    const res = await putDoc(cookie, 'DOC-KTP', pdfBytes(), { body: stream });
    expect(res.status).toBe(400);
    expect((await json<ErrBody>(res)).error.fields?.file).toBeTruthy();
    expect(await arsipCount(user.id)).toBe(0);
  });

  it('client file name strips C0, C1 and bidi controls', () => {
    const raw = encodeURIComponent('a\u0001b\u0085c\u202Ed\u2066e\u200Ff\u007F.pdf');
    expect(clientFileName(raw)).toBe('abcdef.pdf');
    expect(clientFileName('%E0%A4%A')).toBeNull();
    expect(clientFileName(encodeURIComponent('x'.repeat(256)))).toBeNull();
  });
});

describe('version file access and history isolation', () => {
  it('?versi= on another pegawai arsip is 404; an expired version is 404', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    await setStatus(id, 'Ditolak');
    await uploadOk(cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png'));
    const other = await pegawai();
    expect((await call(`/api/documents/${id}/file?versi=1`, { cookie: other.cookie })).status).toBe(404);

    await env.DB.prepare(`UPDATE arsip_dokumen_versi SET purge_after = ?2 WHERE arsip_id = ?1`)
      .bind(id, new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await call(`/api/documents/${id}/file?versi=1`, { cookie })).status).toBe(404);
    const list = await json<DokumenListResponse>(await call('/api/me/documents', { cookie }));
    const ktp = list.items.find((i) => i.jenisDokumenId === 'DOC-KTP');
    expect(ktp?.versiSebelumnya).toEqual([]);
    expect(ktp?.can.rollback).toBe(false);
  });

  it('riwayat rows of a reused arsip id (other pegawai/jenis) are never returned (M4)', async () => {
    const { cookie } = await pegawai();
    const id = (await uploadOk(cookie)).arsip!.id;
    const stranger = await createUser();
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO arsip_dokumen_riwayat (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, status, created_at)
         VALUES (?1, ?2, 'DOC-KTP', 9, 'APPROVE', 'Terverifikasi', ?3)`,
      ).bind(id, stranger.id, now),
      env.DB.prepare(
        `INSERT INTO arsip_dokumen_riwayat (arsip_id, pegawai_id, jenis_dokumen_id, versi, aksi, status, created_at)
         VALUES (?1, (SELECT pegawai_id FROM arsip_dokumen WHERE id = ?1), 'DOC-KK', 8, 'REJECT', 'Ditolak', ?2)`,
      ).bind(id, now),
      // Pre-0004 row of a purged slot: never backfilled, never shown.
      env.DB.prepare(
        `INSERT INTO arsip_dokumen_riwayat (arsip_id, versi, aksi, status, created_at)
         VALUES (?1, 7, 'DELETE', 'Menunggu', ?2)`,
      ).bind(id, now),
    ]);
    const res = await call(`/api/documents/${id}/riwayat`, { cookie });
    expect(res.status).toBe(200);
    const body = await json<RiwayatResponse>(res);
    expect(body.items.map((r) => [r.aksi, r.versi])).toEqual([['UPLOAD', 1]]);
  });

  it('maxSizeBytes is capped at the global policy (L1)', async () => {
    const { cookie } = await pegawai();
    await env.DB.prepare(`UPDATE jenis_dokumen SET max_size_bytes = ?1 WHERE id = 'DOC-TASPEN'`)
      .bind(DOCUMENT_POLICY.maxBytes * 4)
      .run();
    try {
      const list = await json<DokumenListResponse>(await call('/api/me/documents', { cookie }));
      expect(list.items.find((i) => i.jenisDokumenId === 'DOC-TASPEN')?.maxSizeBytes).toBe(DOCUMENT_POLICY.maxBytes);
      const res = await putDoc(cookie, 'DOC-TASPEN', pdfBytes(16), { length: String(DOCUMENT_POLICY.maxBytes + 1) });
      expect(res.status).toBe(400);
    } finally {
      await env.DB.prepare(`UPDATE jenis_dokumen SET max_size_bytes = ?1 WHERE id = 'DOC-TASPEN'`)
        .bind(DOCUMENT_POLICY.maxBytes)
        .run();
    }
  });
});

describe('rollback', () => {
  async function verifiedThenReuploaded() {
    const owner = await pegawai();
    const admin = await pegawai({ role: 'Admin' });
    const id = (await uploadOk(owner.cookie)).arsip!.id;
    const key1 = String((await arsipRow(id))?.r2_key);
    await setStatus(id, 'Terverifikasi', admin.user.id);
    await uploadOk(owner.cookie, 'DOC-KTP', form(pngBytes(), 'b.png', 'image/png'));
    const key2 = String((await arsipRow(id))?.r2_key);
    return { owner, admin, id, key1, key2 };
  }

  it('owner rolls back a pending re-upload to the verified version', async () => {
    const { owner, admin, id, key1, key2 } = await verifiedThenReuploaded();
    const res = await call(`/api/documents/${id}/rollback`, { cookie: owner.cookie, body: { versi: 1 } });
    expect(res.status).toBe(200);
    const { item } = await json<DokumenItemResponse>(res);
    expect(item.status).toBe('Terverifikasi');
    expect(item.arsip?.versi).toBe(3);
    expect(item.arsip?.mimeType).toBe('application/pdf');
    expect(item.arsip?.verifiedBy?.id).toBe(admin.user.id);
    expect(item.versiSebelumnya.map((v) => v.versi)).toEqual([2]);
    expect(item.versiSebelumnya[0]?.status).toBe('Menunggu');
    expect(item.can.rollback).toBe(false); // owner, now Terverifikasi
    expect(String((await arsipRow(id))?.r2_key)).toBe(key1);
    // uploaded_by is restored from the version row (migration 0003), not reset to NULL.
    expect((await arsipRow(id))?.uploaded_by).toBe(owner.user.id);
    expect(await r2Exists(key1)).toBe(true);
    expect(await r2Exists(key2)).toBe(true);

    const riwayat = await json<RiwayatResponse>(await call(`/api/documents/${id}/riwayat`, { cookie: owner.cookie }));
    expect(riwayat.items.map((r) => r.aksi)).toEqual(['ROLLBACK', 'REUPLOAD', 'UPLOAD']);
    expect(riwayat.items[0]?.actor?.id).toBe(owner.user.id);
    expect(riwayat.items[0]?.versi).toBe(3);
  });

  it('owner cannot roll back a Terverifikasi document (403); admin can', async () => {
    const { owner, admin, id } = await verifiedThenReuploaded();
    await setStatus(id, 'Terverifikasi', admin.user.id);
    expect((await call(`/api/documents/${id}/rollback`, { cookie: owner.cookie, body: { versi: 1 } })).status).toBe(403);
    const res = await call(`/api/documents/${id}/rollback`, { cookie: admin.cookie, body: { versi: 1 } });
    expect(res.status).toBe(200);
  });

  it('unknown version is 404; invalid body 400; soft-deleted 409', async () => {
    const { owner, id } = await verifiedThenReuploaded();
    expect((await call(`/api/documents/${id}/rollback`, { cookie: owner.cookie, body: { versi: 7 } })).status).toBe(404);
    expect((await call(`/api/documents/${id}/rollback`, { cookie: owner.cookie, body: { versi: 'x' } })).status).toBe(400);
    expect((await call(`/api/documents/${id}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(200);
    expect((await call(`/api/documents/${id}/rollback`, { cookie: owner.cookie, body: { versi: 1 } })).status).toBe(409);
  });
});

describe('GET /api/admin/pegawai/:id/documents', () => {
  it('admin sees the list with can.upload false; pegawai gets 403', async () => {
    const owner = await pegawai();
    await uploadOk(owner.cookie);
    const admin = await pegawai({ role: 'Admin' });
    const res = await call(`/api/admin/pegawai/${owner.user.id}/documents`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = await json<DokumenListResponse>(res);
    expect(body.pegawai.id).toBe(owner.user.id);
    expect(body.profileMissingFields).toEqual([]);
    expect(body.items.every((i) => !i.can.upload)).toBe(true);
    const ktp = body.items.find((i) => i.jenisDokumenId === 'DOC-KTP');
    expect(ktp?.status).toBe('Menunggu');
    expect(ktp?.can.delete).toBe(true);
    expect((await call(`/api/admin/pegawai/${owner.user.id}/documents`, { cookie: owner.cookie })).status).toBe(403);
    expect((await call(`/api/admin/pegawai/999999999/documents`, { cookie: admin.cookie })).status).toBe(404);
  });
});
