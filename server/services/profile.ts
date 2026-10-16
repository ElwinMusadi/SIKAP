// Phase 3: profile, photo, reference data and the employee dashboard.
import type { StatusKepegawaian } from '../../shared/enums';
import {
  missingProfileFields,
  PHOTO_POLICY,
  REQUIRED_PROFILE_FIELDS,
  updateProfileRequestSchema,
  type DashboardDokumen,
  type DashboardResponse,
  type Pengajuan,
  type PhotoResponse,
  type ProfileResponse,
  type RefResponse,
  type StatusDokumenView,
} from '../../shared/profile';
import {
  dashboardDocs,
  nikUsedByOther,
  pendidikanExists,
  PROFILE_COLUMN_MAP,
  refStatements,
  rowToPendingPengajuan,
  rowToProfile,
  selectPegawaiById,
  selectFotoKey,
  selectPendingPengajuan,
  updateFotoKey,
  type DashboardDocRow,
  type EditableProfileKey,
  type PegawaiRow,
  type PengajuanRow,
  type RefJenisDokumenRow,
  type RefPangkatRow,
  type RefPendidikanRow,
  type RefUnitRow,
  type RefWajibRow,
} from '../db/profile';
import type { AuthContext, Bindings } from '../env';
import { auditStatement, type AuditActor } from '../lib/audit';
import { errors } from '../lib/errors';
import { sniffImage } from '../lib/file-sniff';
import { toIso } from '../lib/time';
import { zodFieldErrors } from '../lib/validation';
import type { RequestMeta } from './auth';
import { photoUrl } from '../lib/photo-url';
import { deleteUnreferencedObject } from '../lib/r2';

function fotoKeyReferenced(db: D1Database, key: string): D1PreparedStatement {
  return db.prepare(`SELECT 1 AS ok FROM pegawai WHERE foto_r2_key = ?1 LIMIT 1`).bind(key);
}

function actorOf(auth: AuthContext): AuditActor {
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

function isUniqueNikError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg) && /nik/i.test(msg);
}

// ---------------------------------------------------------------------------
// GET /api/ref
// ---------------------------------------------------------------------------

export async function getRef(env: Bindings): Promise<RefResponse> {
  const [pangkat, unit, pendidikan, jenis, wajib] = await env.DB.batch(refStatements(env.DB));
  const wajibMap = new Map<string, StatusKepegawaian[]>();
  for (const w of (wajib?.results ?? []) as RefWajibRow[]) {
    const list = wajibMap.get(w.jenis_dokumen_id);
    if (list) list.push(w.status_kepegawaian);
    else wajibMap.set(w.jenis_dokumen_id, [w.status_kepegawaian]);
  }
  return {
    pangkat: ((pangkat?.results ?? []) as RefPangkatRow[]).map((r) => ({
      kode: r.kode,
      nama: r.nama,
      jenisAsn: r.jenis_asn,
    })),
    unit: ((unit?.results ?? []) as RefUnitRow[]).map((r) => ({ id: r.id, nama: r.nama })),
    pendidikan: ((pendidikan?.results ?? []) as RefPendidikanRow[]).map((r) => ({ kode: r.kode, nama: r.nama })),
    jenisDokumen: ((jenis?.results ?? []) as RefJenisDokumenRow[]).map((r) => ({
      id: r.id,
      nama: r.nama,
      kategori: r.kategori,
      wajibUntuk: wajibMap.get(r.id) ?? [],
      maxSizeBytes: r.max_size_bytes,
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/me/profile
// ---------------------------------------------------------------------------

async function loadProfileAndPending(
  env: Bindings,
  id: number,
): Promise<{ row: PegawaiRow; pengajuan: Pengajuan | null }> {
  const [pRes, qRes] = await env.DB.batch([selectPegawaiById(env.DB, id), selectPendingPengajuan(env.DB, id)]);
  const row = (pRes?.results?.[0] as PegawaiRow | undefined) ?? null;
  if (!row) throw errors.notFound('Pegawai tidak ditemukan.');
  const pRow = (qRes?.results?.[0] as PengajuanRow | undefined) ?? null;
  return { row, pengajuan: pRow ? rowToPendingPengajuan(pRow) : null };
}

export async function getProfile(env: Bindings, auth: AuthContext): Promise<ProfileResponse> {
  const { row, pengajuan } = await loadProfileAndPending(env, auth.user.id);
  const profile = rowToProfile(row);
  return { profile, missingFields: missingProfileFields(profile), pengajuanAktif: pengajuan };
}

// ---------------------------------------------------------------------------
// PATCH /api/me/profile
// ---------------------------------------------------------------------------

export async function updateProfile(
  env: Bindings,
  auth: AuthContext,
  body: unknown,
  meta: RequestMeta,
): Promise<ProfileResponse> {
  const parsed = updateProfileRequestSchema.safeParse(body);
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.code === 'unrecognized_keys')) {
      throw errors.validation({ _form: 'Data kepegawaian hanya dapat diubah melalui pengajuan perubahan.' });
    }
    throw errors.validation(zodFieldErrors(parsed.error));
  }
  const input = parsed.data;
  const keys = (Object.keys(input) as EditableProfileKey[]).filter(
    (k) => k in PROFILE_COLUMN_MAP && input[k] !== undefined,
  );
  if (keys.length === 0) throw errors.validation({ _form: 'Tidak ada perubahan.' });

  const id = auth.user.id;
  const db = env.DB;
  const nikConflict = 'NIK sudah terdaftar pada pegawai lain.';
  // Round trip 1: reference/uniqueness pre-checks in one batch (skipped when not needed).
  const checks: D1PreparedStatement[] = [];
  if (input.pendidikanKode != null) checks.push(pendidikanExists(db, input.pendidikanKode));
  if (input.nik != null) checks.push(nikUsedByOther(db, input.nik, id));
  if (checks.length) {
    const results = await db.batch(checks);
    let i = 0;
    if (input.pendidikanKode != null && !results[i++]?.results?.length) {
      throw errors.validation({ pendidikanKode: 'Pendidikan tidak valid.' });
    }
    if (input.nik != null && results[i]?.results?.length) throw errors.conflict(nikConflict);
  }

  const nowIso = toIso(meta.nowMs);
  // Column names come from the fixed whitelist map, never from user input.
  const sets = keys.map((k, i) => `${PROFILE_COLUMN_MAP[k]} = ?${i + 2}`);
  const values = keys.map((k) => input[k] ?? null);
  sets.push(`updated_at = ?${keys.length + 2}`);
  const update = env.DB.prepare(`UPDATE pegawai SET ${sets.join(', ')} WHERE id = ?1 AND deleted_at IS NULL`).bind(
    id,
    ...values,
    nowIso,
  );
  const audit = auditStatement(
    env.DB,
    {
      ts: nowIso,
      actor: actorOf(auth),
      action: 'PROFILE_UPDATE',
      targetType: 'pegawai',
      targetId: id,
      // Field names only; values (NIK, phone, …) are personal data and never logged.
      description: `Profil diperbarui: ${keys.join(', ')}`,
      result: 'SUCCESS',
      ip: meta.ip,
    },
    { onlyIfPreviousChanged: true },
  );
  // Round trip 2: update + audit + re-read of the profile and pending pengajuan.
  let results: D1Result[];
  try {
    results = await db.batch([update, audit, selectPegawaiById(db, id), selectPendingPengajuan(db, id)]);
  } catch (err) {
    if (isUniqueNikError(err)) throw errors.conflict(nikConflict);
    throw err;
  }
  const row = (results[2]?.results?.[0] as PegawaiRow | undefined) ?? null;
  if (!row) throw errors.notFound('Pegawai tidak ditemukan.');
  const pRow = (results[3]?.results?.[0] as PengajuanRow | undefined) ?? null;
  const profile = rowToProfile(row);
  return {
    profile,
    missingFields: missingProfileFields(profile),
    pengajuanAktif: pRow ? rowToPendingPengajuan(pRow) : null,
  };
}

// ---------------------------------------------------------------------------
// PUT /api/me/photo
// ---------------------------------------------------------------------------

export async function uploadPhoto(
  env: Bindings,
  auth: AuthContext,
  file: File | string | null,
  meta: RequestMeta,
): Promise<PhotoResponse> {
  if (!(file instanceof File)) throw errors.validation({ file: 'File foto wajib diunggah.' });
  if (file.size < 1 || file.size > PHOTO_POLICY.maxBytes) {
    throw errors.validation({ file: `Ukuran foto maksimal ${PHOTO_POLICY.maxBytes / 1024 / 1024} MB.` });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes.subarray(0, 16));
  if (!type) throw errors.validation({ file: 'File harus berupa gambar JPG, PNG, atau WEBP.' });

  const id = auth.user.id;
  const current = await selectFotoKey(env.DB, id);
  if (!current) throw errors.notFound('Pegawai tidak ditemukan.');
  const oldKey = current.foto_r2_key;

  const key = `foto/${id}/${crypto.randomUUID()}.${type.ext}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type.mime } });

  const nowIso = toIso(meta.nowMs);
  let changed: number;
  try {
    const [upd] = await env.DB.batch([
      // Compare-and-set on the key read above: a concurrent upload or a soft
      // delete in between makes this a no-op instead of orphaning objects.
      updateFotoKey(env.DB, id, key, oldKey, nowIso),
      auditStatement(
        env.DB,
        {
          ts: nowIso,
          actor: actorOf(auth),
          action: 'FOTO_PROFIL_UPLOAD',
          targetType: 'pegawai',
          targetId: id,
          description: 'Foto profil diperbarui',
          result: 'SUCCESS',
          ip: meta.ip,
        },
        { onlyIfPreviousChanged: true },
      ),
    ]);
    changed = upd?.meta.changes ?? 0;
  } catch (err) {
    // The batch may have committed despite the error: only delete an unreferenced key.
    await deleteUnreferencedObject(env.FILES, key, fotoKeyReferenced(env.DB, key));
    throw err;
  }
  if (changed !== 1) {
    await deleteUnreferencedObject(env.FILES, key, fotoKeyReferenced(env.DB, key));
    const still = await selectFotoKey(env.DB, id);
    if (!still) throw errors.notFound('Pegawai tidak ditemukan.');
    throw errors.conflict('Foto sedang diperbarui dari perangkat lain. Coba lagi.');
  }

  // A profile photo is not a document: the 3-day version retention (owner
  // decision #4) applies to documents only, so the old object goes now.
  if (oldKey && oldKey !== key) {
    try {
      await env.FILES.delete(oldKey);
    } catch {
      // Best effort; an orphaned object is harmless and never referenced again.
    }
  }
  return { fotoUrl: photoUrl(id, key) };
}

// ---------------------------------------------------------------------------
// GET /api/pegawai/:id/photo
// ---------------------------------------------------------------------------

export type PhotoObject = { kind: 'body'; obj: R2ObjectBody } | { kind: 'not-modified'; etag: string };

/**
 * Any signed-in user may view the photo of any non-deleted pegawai (legacy
 * behaviour: photos appear in admin lists and shared views).
 */
export async function getPhoto(env: Bindings, rawId: string, requestHeaders: Headers): Promise<PhotoObject> {
  // Only the "not modified" preconditions: If-Match / If-Unmodified-Since must
  // never turn into a 304 (R2 would return a body-less object for them too).
  const conditional = new Headers();
  for (const name of ['If-None-Match', 'If-Modified-Since']) {
    const v = requestHeaders.get(name);
    if (v) conditional.set(name, v);
  }
  const notFound = () => errors.notFound('Foto tidak ditemukan.');
  if (!/^[1-9]\d{0,15}$/.test(rawId)) throw notFound();
  const id = Number(rawId);
  if (!Number.isSafeInteger(id)) throw notFound();
  const row = await selectFotoKey(env.DB, id);
  if (!row?.foto_r2_key) throw notFound();
  const obj = await env.FILES.get(row.foto_r2_key, { onlyIf: conditional });
  if (!obj) throw notFound();
  if (!('body' in obj) || !obj.body) return { kind: 'not-modified', etag: obj.httpEtag };
  return { kind: 'body', obj: obj as R2ObjectBody };
}

// ---------------------------------------------------------------------------
// GET /api/me/dashboard
// ---------------------------------------------------------------------------

const PRIORITAS_MAX = 5;

export async function getDashboard(env: Bindings, auth: AuthContext): Promise<DashboardResponse> {
  const id = auth.user.id;
  // The wajib flag needs the status before the batch runs; the session middleware
  // read it from the same row at request start.
  const sessionStatus = auth.user.statusKepegawaian;
  const [pRes, dRes, qRes] = await env.DB.batch([
    selectPegawaiById(env.DB, id),
    dashboardDocs(env.DB, id, sessionStatus ?? ''),
    selectPendingPengajuan(env.DB, id),
  ]);
  const row = (pRes?.results?.[0] as PegawaiRow | undefined) ?? null;
  if (!row) throw errors.notFound('Pegawai tidak ditemukan.');
  const docRows = (dRes?.results ?? []) as DashboardDocRow[];
  const pRow = (qRes?.results?.[0] as PengajuanRow | undefined) ?? null;

  const status = row.status_kepegawaian;
  // Session status and row status only differ if an admin changed it mid-request;
  // in that case treat wajib flags as unknown for this response.
  const statusMatches = status === sessionStatus;

  const docs: DashboardDokumen[] = docRows.map((d) => ({
    jenisDokumenId: d.id,
    nama: d.nama,
    kategori: d.kategori,
    wajib: statusMatches && status !== null && d.wajib === 1,
    status: d.status ?? 'Belum diunggah',
    catatanAdmin: d.catatan_admin,
    uploadedAt: d.uploaded_at,
    verifiedAt: d.verified_at,
  }));

  const counts: Record<StatusDokumenView, number> = {
    'Belum diunggah': 0,
    Menunggu: 0,
    Terverifikasi: 0,
    Ditolak: 0,
  };
  for (const d of docs) counts[d.status] += 1;

  const wajibDocs = docs.filter((d) => d.wajib);
  const wajibTotal = wajibDocs.length;
  const wajibTerverifikasi = wajibDocs.filter((d) => d.status === 'Terverifikasi').length;
  const wajibTersedia = wajibDocs.filter((d) => d.status !== 'Belum diunggah').length;
  const persen = wajibTotal ? Math.round((wajibTerverifikasi / wajibTotal) * 100) : 0;

  const prioritas = [
    ...docs.filter((d) => d.status === 'Ditolak'),
    ...docs.filter((d) => d.wajib && d.status === 'Belum diunggah'),
    ...docs.filter((d) => d.status === 'Menunggu'),
  ].slice(0, PRIORITAS_MAX);

  const profile = rowToProfile(row);
  const missingFields = missingProfileFields(profile);
  const total = Object.keys(REQUIRED_PROFILE_FIELDS).length;
  const terisi = total - missingFields.length;

  return {
    dokumen: { wajibTotal, wajibTerverifikasi, wajibTersedia, persen, counts, prioritas },
    profil: { terisi, total, persen: total ? Math.round((terisi / total) * 100) : 0, missingFields },
    pengajuanAktif: pRow ? rowToPendingPengajuan(pRow) : null,
    statusKepegawaianKosong: status === null,
  };
}
