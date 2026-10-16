// Phase 4: document archive on R2 (owner decision #4: versions kept 3 days,
// rollback, soft delete with restore). Contract: shared/dokumen.ts.
import {
  DOCUMENT_POLICY,
  isViewableDocumentMime,
  rollbackRequestSchema,
  UPLOAD_HEADERS,
  type DocumentMime,
  type DokumenItem,
  type DokumenListResponse,
  type DokumenVersi,
  type RiwayatAksi,
  type RiwayatItem,
} from '../../shared/dokumen';
import { missingProfileFields, type StatusDokumenView } from '../../shared/profile';
import {
  copyCurrentToVersi,
  copyDeletedToVersi,
  deleteVersiRow,
  insertArsip,
  isAdminOnlyVersi,
  OWNER_ROLLBACK_TARGET_SQL,
  r2KeyReferenced,
  restoreArsip,
  riwayatAfterChange,
  selectArsipById,
  selectDokumenRows,
  selectRiwayat,
  selectVersiFile,
  selectVersiRows,
  softDeleteArsip,
  updateArsipFromVersi,
  updateArsipNewFile,
  type ArsipRow,
  type DokumenListRow,
  type DokumenVersiRow,
  type NewFile,
  type RiwayatRow,
  type VersiFileRow,
} from '../db/dokumen';
import { rowToProfile, selectPegawaiById, type PegawaiRow } from '../db/profile';
import type { AuthContext, AuthUser, Bindings } from '../env';
import { auditStatement, type AuditActor } from '../lib/audit';
import { ApiError, errors } from '../lib/errors';
import { sniffDocument } from '../lib/file-sniff';
import { deleteUnreferencedObject } from '../lib/r2';
import { toIso } from '../lib/time';
import { parseWith } from '../lib/validation';
import type { RequestMeta } from './auth';

const DAY_MS = 86_400_000;
const VERSION_RETENTION_MS = DOCUMENT_POLICY.versionRetentionDays * DAY_MS;
const SOFT_DELETE_RETENTION_MS = DOCUMENT_POLICY.softDeleteRetentionDays * DAY_MS;

const MSG = {
  pegawaiNotFound: 'Pegawai tidak ditemukan.',
  arsipNotFound: 'Dokumen tidak ditemukan.',
  jenisNotFound: 'Jenis dokumen tidak ditemukan.',
  fileNotFound: 'File tidak ditemukan.',
  versiNotFound: 'Versi dokumen tidak ditemukan atau sudah dihapus permanen.',
  fileRequired: 'File dokumen wajib diunggah.',
  fileType: 'File harus PDF, JPG, PNG, atau WEBP.',
  profileIncomplete: 'Lengkapi profil sebelum mengunggah dokumen.',
  menunggu: 'Dokumen masih menunggu verifikasi.',
  lengthRequired: 'Ukuran file (Content-Length) wajib dikirim.',
  lengthMismatch: 'Ukuran file tidak sesuai dengan yang dikirim. Coba lagi.',
  badChecksum: 'Checksum file tidak valid.',
  checksumMismatch: 'File rusak saat diunggah (checksum tidak cocok). Coba lagi.',
  restoreVerifiedAdminOnly: 'Dokumen terverifikasi yang dihapus admin hanya dapat dipulihkan oleh admin.',
  concurrent: 'Dokumen telah diubah dari perangkat lain. Muat ulang lalu coba lagi.',
  alreadyDeleted: 'Dokumen sudah dihapus.',
  notDeleted: 'Dokumen tidak dalam keadaan terhapus.',
  purged: 'Dokumen sudah dihapus permanen.',
  restoreFirst: 'Pulihkan dokumen terlebih dahulu.',
} as const;

function actorOf(auth: AuthContext): AuditActor {
  const u = auth.user;
  return { id: u.id, nip: u.nip, nama: u.nama, role: u.role };
}

function formatMb(bytes: number): string {
  return String(Number((bytes / 1024 / 1024).toFixed(1)));
}

/** Positive integer path/query id; anything else is "not found". */
export function parseId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Item builder (shared by list and every mutation response)
// ---------------------------------------------------------------------------

interface ViewerCtx {
  owner: boolean;
  admin: boolean;
  /** Missing profile labels of the pegawai (only meaningful for the owner). */
  profileMissing: string[];
  nowIso: string;
}

function toVersi(v: DokumenVersiRow, bisaDipulihkan: boolean): DokumenVersi {
  return {
    versi: v.versi,
    fileName: v.file_name,
    mimeType: v.mime_type as DocumentMime,
    sizeBytes: v.size_bytes,
    status: v.status,
    uploadedAt: v.uploaded_at,
    replacedAt: v.replaced_at,
    purgeAfter: v.purge_after,
    bisaDipulihkan,
  };
}

function buildItem(r: DokumenListRow, versiRows: DokumenVersiRow[], ctx: ViewerCtx): DokumenItem {
  const hasArsip = r.arsip_id !== null;
  const softDeleted = hasArsip && r.deleted_at !== null;
  const active = hasArsip && !softDeleted;

  const arsip: DokumenItem['arsip'] = active
    ? {
        id: r.arsip_id as number,
        versi: r.versi as number,
        fileName: r.file_name as string,
        mimeType: r.mime_type as DocumentMime,
        sizeBytes: r.size_bytes as number,
        catatanAdmin: r.catatan_admin,
        uploadedAt: r.uploaded_at as string,
        verifiedAt: r.verified_at,
        verifiedBy: r.verified_by !== null ? { id: r.verified_by, nama: r.verifier_nama ?? '' } : null,
      }
    : null;
  const deleted: DokumenItem['deleted'] =
    softDeleted && r.purge_after !== null && r.purge_after > ctx.nowIso
      ? {
          id: r.arsip_id as number,
          fileName: r.file_name as string,
          deletedAt: r.deleted_at as string,
          purgeAfter: r.purge_after,
        }
      : null;
  const ownVersi = active ? versiRows.filter((v) => v.arsip_id === r.arsip_id) : [];
  const status: StatusDokumenView = active && r.status ? r.status : 'Belum diunggah';
  // Same rules the rollback endpoint enforces (service + SQL guard).
  const mayChange = ctx.admin || status !== 'Terverifikasi';
  const versiSebelumnya = ownVersi.map((v) =>
    toVersi(v, active && mayChange && (ctx.admin || !isAdminOnlyVersi(v))),
  );

  // Upload gate, first matching reason wins.
  let uploadBlockedReason: string | null = null;
  if (!ctx.owner) uploadBlockedReason = 'Dokumen hanya dapat diunggah oleh pegawai yang bersangkutan.';
  else if (r.aktif !== 1) uploadBlockedReason = 'Jenis dokumen tidak aktif.';
  // A soft-deleted arsip does not block: uploading replaces it (contract M1).
  else if (status === 'Menunggu') uploadBlockedReason = MSG.menunggu;
  else if (ctx.profileMissing.length > 0) uploadBlockedReason = MSG.profileIncomplete;

  return {
    jenisDokumenId: r.jenis_id,
    nama: r.jenis_nama,
    kategori: r.kategori,
    wajib: r.wajib === 1,
    maxSizeBytes: effectiveMaxBytes(r.max_size_bytes),
    status,
    arsip,
    deleted,
    versiSebelumnya,
    can: {
      upload: uploadBlockedReason === null,
      delete: active && mayChange,
      // True when at least one listed version is a valid target for this viewer;
      // each version carries its own `bisaDipulihkan`.
      rollback: versiSebelumnya.some((v) => v.bisaDipulihkan),
      // Owner: not when the deleted file was Terverifikasi (mirrors the delete rule, M3).
      restore: deleted !== null && (ctx.admin || (ctx.owner && r.status !== 'Terverifikasi')),
    },
    uploadBlockedReason,
  };
}

function viewerCtx(viewer: AuthUser, pegawai: PegawaiRow, nowIso: string): ViewerCtx {
  const owner = viewer.id === pegawai.id;
  return {
    owner,
    admin: viewer.role === 'Admin',
    profileMissing: owner ? missingProfileFields(rowToProfile(pegawai)) : [],
    nowIso,
  };
}

/** Item from the trailing [pegawai, rows, versi] results of a mutation batch. */
function itemFromResults(viewer: AuthUser, results: D1Result[], offset: number, nowIso: string): DokumenItem {
  const pegawai = (results[offset]?.results?.[0] as PegawaiRow | undefined) ?? null;
  const row = (results[offset + 1]?.results?.[0] as DokumenListRow | undefined) ?? null;
  if (!pegawai || !row) throw errors.notFound(MSG.arsipNotFound);
  const versi = (results[offset + 2]?.results ?? []) as DokumenVersiRow[];
  return buildItem(row, versi, viewerCtx(viewer, pegawai, nowIso));
}

function itemReads(db: D1Database, pegawaiId: number, jenisId: string, nowIso: string): D1PreparedStatement[] {
  return [
    selectPegawaiById(db, pegawaiId),
    selectDokumenRows(db, pegawaiId, jenisId),
    selectVersiRows(db, pegawaiId, nowIso, jenisId),
  ];
}

// ---------------------------------------------------------------------------
// GET /api/me/documents, GET /api/admin/pegawai/:id/documents
// ---------------------------------------------------------------------------

export async function listDocuments(
  env: Bindings,
  viewer: AuthUser,
  pegawaiId: number,
  nowMs: number = Date.now(),
): Promise<DokumenListResponse> {
  const nowIso = toIso(nowMs);
  const [pRes, dRes, vRes] = await env.DB.batch([
    selectPegawaiById(env.DB, pegawaiId),
    selectDokumenRows(env.DB, pegawaiId),
    selectVersiRows(env.DB, pegawaiId, nowIso),
  ]);
  const pegawai = (pRes?.results?.[0] as PegawaiRow | undefined) ?? null;
  if (!pegawai) throw errors.notFound(MSG.pegawaiNotFound);
  const rows = (dRes?.results ?? []) as DokumenListRow[];
  const versi = (vRes?.results ?? []) as DokumenVersiRow[];
  const ctx = viewerCtx(viewer, pegawai, nowIso);
  const items = rows.map((r) => buildItem(r, versi, ctx));

  const counts: Record<StatusDokumenView, number> = { 'Belum diunggah': 0, Menunggu: 0, Terverifikasi: 0, Ditolak: 0 };
  for (const it of items) counts[it.status] += 1;
  const wajib = items.filter((it) => it.wajib);
  const wajibTotal = wajib.length;
  const wajibTerverifikasi = wajib.filter((it) => it.status === 'Terverifikasi').length;
  const wajibTersedia = wajib.filter((it) => it.status !== 'Belum diunggah').length;

  return {
    pegawai: {
      id: pegawai.id,
      nip: pegawai.nip,
      nama: pegawai.nama,
      statusKepegawaian: pegawai.status_kepegawaian,
    },
    items,
    summary: {
      wajibTotal,
      wajibTersedia,
      wajibTerverifikasi,
      persen: wajibTotal ? Math.round((wajibTerverifikasi / wajibTotal) * 100) : 0,
      counts,
    },
    profileMissingFields: ctx.profileMissing,
  };
}

// ---------------------------------------------------------------------------
// PUT /api/me/documents/:jenisId   (raw body, streamed to R2; contract M5)
// ---------------------------------------------------------------------------

interface JenisRow {
  id: string;
  nama: string;
  max_size_bytes: number;
}

/** Effective per-type limit (L1): the DB value can never exceed the global policy. */
export function effectiveMaxBytes(jenisMax: number): number {
  return Math.min(jenisMax, DOCUMENT_POLICY.maxBytes);
}

/** `[NIP]_[Nama]_[ID].[ext]` (legacy naming), ASCII-safe. */
export function documentFileName(nip: string, nama: string, jenisId: string, ext: string): string {
  const safeNama =
    nama
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60)
      .replace(/_+$/, '') || 'Pegawai';
  const safeJenis = jenisId.replace(/[^A-Za-z0-9-]+/g, '_');
  return `${nip}_${safeNama}_${safeJenis}.${ext}`;
}

function isUniqueError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed/i.test(msg);
}

function isUnsafeNameChar(code: number): boolean {
  return (
    code < 0x20 || // C0
    (code >= 0x7f && code <= 0x9f) || // DEL + C1
    code === 0x200e || // LRM
    code === 0x200f || // RLM
    (code >= 0x202a && code <= 0x202e) || // LRE, RLE, PDF, LRO, RLO
    (code >= 0x2066 && code <= 0x2069) // LRI, RLI, FSI, PDI
  );
}

/** Original client file name: informational only (audit), never stored as file_name. */
export function clientFileName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    // Strip C0/DEL/C1 controls and bidi controls (which could visually reorder the
    // audit line, e.g. "fdp.exe" tricks) so the description stays one honest line.
    const name = Array.from(decodeURIComponent(raw))
      .filter((ch) => !isUnsafeNameChar(ch.charCodeAt(0)))
      .join('')
      .trim();
    return name && name.length <= 255 ? name : null;
  } catch {
    return null;
  }
}

const SNIFF_BYTES = 16;

/**
 * Read just enough of the body to sniff the magic bytes. Returns the chunks read
 * (to be replayed in front of the rest) and the reader positioned after them.
 */
async function readHead(
  body: ReadableStream<Uint8Array>,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; chunks: Uint8Array[]; head: Uint8Array }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < SNIFF_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // Client disconnected / body errored before the head arrived: a client problem, not a 500.
    await reader.cancel().catch(() => undefined);
    throw errors.validation({ file: MSG.lengthMismatch });
  }
  // Only the first ≤16 bytes are copied; the chunks themselves are passed through as is.
  const head = new Uint8Array(Math.min(total, SNIFF_BYTES));
  let off = 0;
  for (const c of chunks) {
    if (off >= head.length) break;
    const part = c.subarray(0, head.length - off);
    head.set(part, off);
    off += part.length;
  }
  return { reader, chunks, head };
}

class LengthMismatchError extends Error {
  constructor() {
    super('body length does not match Content-Length');
  }
}

export interface RawUpload {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

export async function uploadDocument(
  env: Bindings,
  auth: AuthContext,
  jenisId: string,
  req: RawUpload,
  meta: RequestMeta,
): Promise<{ item: DokumenItem; created: boolean }> {
  if (!jenisId || jenisId.length > 64) throw errors.notFound(MSG.jenisNotFound);
  const db = env.DB;
  const pegawaiId = auth.user.id;

  // Round trip 1, BEFORE touching the body: pegawai (profile), jenis (active only)
  // and the existing arsip row, so every cheap gate fails fast.
  const [pRes, jRes, aRes] = await db.batch([
    selectPegawaiById(db, pegawaiId),
    db.prepare(`SELECT id, nama, max_size_bytes FROM jenis_dokumen WHERE id = ?1 AND aktif = 1`).bind(jenisId),
    db
      .prepare(`SELECT * FROM arsip_dokumen WHERE pegawai_id = ?1 AND jenis_dokumen_id = ?2`)
      .bind(pegawaiId, jenisId),
  ]);
  const pegawai = (pRes?.results?.[0] as PegawaiRow | undefined) ?? null;
  if (!pegawai) throw errors.notFound(MSG.pegawaiNotFound);
  const jenis = (jRes?.results?.[0] as JenisRow | undefined) ?? null;
  if (!jenis) throw errors.notFound(MSG.jenisNotFound);
  const existing = (aRes?.results?.[0] as ArsipRow | undefined) ?? null;

  const missing = missingProfileFields(rowToProfile(pegawai));
  if (missing.length > 0) throw errors.validation({ _form: MSG.profileIncomplete, profile: missing.join(', ') });
  // A soft-deleted arsip (restorable or expired) may be replaced (contract M1);
  // only an ACTIVE pending one blocks.
  if (existing && existing.deleted_at === null && existing.status === 'Menunggu') throw errors.conflict(MSG.menunggu);

  // Header gates (still no body read).
  const maxBytes = effectiveMaxBytes(jenis.max_size_bytes);
  const tooLarge = `Ukuran file maksimal ${formatMb(maxBytes)} MB.`;
  if (/chunked/i.test(req.headers.get('Transfer-Encoding') ?? '')) throw errors.validation({ file: MSG.lengthRequired });
  const lenHeader = req.headers.get('Content-Length');
  if (lenHeader === null) throw errors.validation({ file: MSG.lengthRequired });
  if (!/^\d{1,16}$/.test(lenHeader)) throw errors.validation({ file: MSG.lengthRequired });
  const length = Number(lenHeader);
  if (length < 1) throw errors.validation({ file: MSG.fileRequired });
  if (length > maxBytes) throw errors.validation({ file: tooLarge });
  const sha256 = req.headers.get(UPLOAD_HEADERS.sha256) ?? '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw errors.validation({ file: MSG.badChecksum });
  const originalName = clientFileName(req.headers.get(UPLOAD_HEADERS.fileName));
  if (!req.body) throw errors.validation({ file: MSG.fileRequired });

  // Sniff the first bytes only; never trust the client's Content-Type or file name.
  const { reader, chunks, head } = await readHead(req.body);
  const type = sniffDocument(head);
  if (!type) {
    await reader.cancel().catch(() => undefined);
    throw errors.validation({ file: MSG.fileType });
  }

  const fileName = documentFileName(pegawai.nip, pegawai.nama, jenis.id, type.ext);
  const newFile: NewFile = {
    r2Key: `dokumen/${pegawaiId}/${jenis.id}/${crypto.randomUUID()}.${type.ext}`,
    fileName,
    mime: type.mime,
    // R2 enforces both: FixedLengthStream the length, put({ sha256 }) the content hash.
    size: length,
    sha256,
  };

  // Step 1 (contract): stream head + rest into R2 under a unique key. No arrayBuffer(),
  // no digest in the Worker. R2 needs a known length for a stream, which
  // FixedLengthStream provides (it errors natively on a short/long body).
  //
  // CPU (measured on the Cloudflare edge, 4.9 MB body): a JS read/write loop over the
  // chunks cost 62–70 ms CPU (Free plan limit: 10 ms); handing the rest of the body to
  // the runtime with pipeTo() costs ~1 ms. So JS only touches the few head chunks.
  const fixed = new FixedLengthStream(length);
  const body = req.body;
  // Lets a failed put() stop the native pipe; without it `await pumpResult` could wait
  // forever on a stream nobody reads any more.
  const pipeAbort = new AbortController();
  const pump = (async () => {
    const writer = fixed.writable.getWriter();
    try {
      let total = 0;
      for (const c of chunks) {
        total += c.byteLength;
        if (total > length) throw new LengthMismatchError();
        await writer.write(c);
      }
    } catch (err) {
      await writer.abort(err).catch(() => undefined);
      await reader.cancel(err).catch(() => undefined);
      throw err;
    }
    writer.releaseLock();
    reader.releaseLock();
    // Native pipe of the remaining bytes; closes `fixed.writable` at the end, which makes
    // FixedLengthStream verify the total length.
    await body.pipeTo(fixed.writable, { signal: pipeAbort.signal });
  })();
  // Settle-handler attached immediately: the pump may fail while put() is still pending.
  const pumpResult = pump.then(
    () => null,
    (err: unknown) => err ?? new Error('stream error'),
  );
  let putError: unknown = null;
  try {
    await env.FILES.put(newFile.r2Key, fixed.readable, {
      httpMetadata: { contentType: type.mime, contentDisposition: contentDisposition(fileName, false) },
      customMetadata: { nip: pegawai.nip, jenisDokumenId: jenis.id, uploadedBy: String(auth.user.id) },
      sha256,
    });
  } catch (err) {
    putError = err;
    // Stop the pipe (also cancels the request body and aborts fixed.writable) and
    // release the readable side R2 may not have drained.
    pipeAbort.abort(err);
    await fixed.readable.cancel(err).catch(() => undefined);
  }
  const pumpError = await pumpResult;
  // A pump error equal to putError is only our own abort above; anything else is a
  // genuine body problem (short/long body, client disconnect) and wins.
  if (pumpError && pumpError !== putError) {
    // Body shorter/longer than Content-Length (or the client aborted). R2 puts are
    // atomic, but remove the key defensively in case the put itself completed.
    if (!putError) await env.FILES.delete(newFile.r2Key).catch(() => undefined);
    throw errors.validation({ file: MSG.lengthMismatch });
  }
  if (putError) {
    const msg = putError instanceof Error ? putError.message : String(putError);
    // FixedLengthStream reports a short/long body through the put itself.
    if (/FixedLengthStream|expected bytes|length/i.test(msg)) throw errors.validation({ file: MSG.lengthMismatch });
    if (/sha-?256|checksum|digest|did not match/i.test(msg)) throw errors.validation({ file: MSG.checksumMismatch });
    throw putError;
  }

  const nowIso = toIso(meta.nowMs);
  const actorId = auth.user.id;
  const what = `dokumen ${jenis.id}${originalName ? ` (file asli: ${originalName})` : ''}`;
  const audit = (action: string, description: string, arsipId: number | null) =>
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: actorOf(auth),
        action,
        targetType: 'arsip_dokumen',
        targetId: arsipId,
        description,
        result: 'SUCCESS',
        ip: meta.ip,
      },
      // First upload: the arsip id is the row just inserted (L2).
      { onlyIfPreviousChanged: true, targetIdFromLastInsert: arsipId === null },
    );
  const reads = itemReads(db, pegawaiId, jenis.id, nowIso);

  // Step 2 (contract): one batch = one transaction; each step runs only if the
  // previous one changed a row. Step 3: compensation on failure.
  // The OLD object is never deleted here; the cron purges version rows after 3 days.
  let results: D1Result[];
  let changeIndex: number;
  try {
    if (!existing) {
      changeIndex = 0;
      results = await db.batch([
        insertArsip(db, pegawaiId, jenis.id, newFile, actorId, nowIso),
        // Must directly follow the INSERT: it reads last_insert_rowid().
        audit('DOKUMEN_UPLOAD', `Unggah ${what}, versi 1`, null),
        riwayatAfterChange(db, 'UPLOAD', null, actorId, nowIso, { pegawaiId, jenisId: jenis.id }),
        ...reads,
      ]);
    } else {
      changeIndex = 1;
      // Compare-and-set on the versi read above: a concurrent upload, review,
      // rollback, delete or restore in between turns the whole chain into no-ops.
      const copy =
        existing.deleted_at !== null
          ? copyDeletedToVersi(db, existing.id, existing.versi, nowIso)
          : copyCurrentToVersi(
              db,
              existing.id,
              existing.versi,
              nowIso,
              toIso(meta.nowMs + VERSION_RETENTION_MS),
              `AND status <> 'Menunggu'`,
            );
      results = await db.batch([
        copy,
        updateArsipNewFile(db, existing.id, existing.versi, newFile, actorId, nowIso),
        riwayatAfterChange(db, 'REUPLOAD', null, actorId, nowIso, { arsipId: existing.id }),
        audit('DOKUMEN_REUPLOAD', `Unggah ulang ${what}, versi ${existing.versi + 1}`, existing.id),
        ...reads,
      ]);
    }
  } catch (err) {
    await deleteUnreferencedObject(env.FILES, newFile.r2Key, r2KeyReferenced(db, newFile.r2Key));
    // First-upload race: another request inserted the same (pegawai, jenis) first.
    if (!existing && isUniqueError(err)) throw errors.conflict(MSG.concurrent);
    throw err;
  }
  if ((results[changeIndex]?.meta.changes ?? 0) !== 1) {
    await deleteUnreferencedObject(env.FILES, newFile.r2Key, r2KeyReferenced(db, newFile.r2Key));
    throw errors.conflict(MSG.concurrent);
  }
  const offset = existing ? 4 : 3;
  return { item: itemFromResults(auth.user, results, offset, nowIso), created: !existing };
}

// ---------------------------------------------------------------------------
// Access rule
// ---------------------------------------------------------------------------

/**
 * Owner or Admin may access an arsip. Everyone else gets 404 (not 403) so that
 * arsip IDs cannot be enumerated to learn which documents exist.
 */
export function assertCanAccessArsip(auth: AuthContext, arsip: ArsipRow | null): asserts arsip is ArsipRow {
  if (!arsip) throw errors.notFound(MSG.arsipNotFound);
  if (arsip.pegawai_id !== auth.user.id && auth.user.role !== 'Admin') throw errors.notFound(MSG.arsipNotFound);
}

async function loadArsip(env: Bindings, auth: AuthContext, rawId: string): Promise<ArsipRow> {
  const id = parseId(rawId);
  if (id === null) throw errors.notFound(MSG.arsipNotFound);
  const row = await selectArsipById(env.DB, id).first<ArsipRow>();
  assertCanAccessArsip(auth, row);
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/documents/:arsipId/file
// ---------------------------------------------------------------------------

export const DOCUMENT_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'";

export function contentDisposition(fileName: string, download: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface DocumentFile {
  body: ReadableStream;
  size: number;
  headers: Record<string, string>;
}

export async function getDocumentFile(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  opts: { download: boolean; versi: string | undefined },
  nowMs: number = Date.now(),
): Promise<DocumentFile> {
  const nowIso = toIso(nowMs);
  const id = parseId(rawId);
  if (id === null) throw errors.notFound(MSG.arsipNotFound);
  let versi: number | null = null;
  if (opts.versi !== undefined) {
    versi = parseId(opts.versi);
    if (versi === null) throw errors.notFound(MSG.versiNotFound);
  }
  const stmts = [selectArsipById(env.DB, id)];
  if (versi !== null) stmts.push(selectVersiFile(env.DB, id, versi, nowIso));
  const [aRes, vRes] = await env.DB.batch(stmts);
  const arsip = (aRes?.results?.[0] as ArsipRow | undefined) ?? null;
  assertCanAccessArsip(auth, arsip);
  // A soft-deleted file stays viewable until purge so the user can decide on restore.
  if (arsip.deleted_at !== null && (arsip.purge_after ?? '') <= nowIso) throw errors.notFound(MSG.arsipNotFound);

  let target: Pick<VersiFileRow, 'r2_key' | 'file_name' | 'mime_type'> = arsip;
  if (versi !== null && versi !== arsip.versi) {
    const v = (vRes?.results?.[0] as VersiFileRow | undefined) ?? null;
    if (!v) throw errors.notFound(MSG.versiNotFound);
    target = v;
  }
  const obj = await env.FILES.get(target.r2_key);
  if (!obj) throw errors.notFound(MSG.fileNotFound);

  // Only magic-byte-verified types are ever stored; anything else is forced to download.
  const viewable = isViewableDocumentMime(target.mime_type);
  return {
    body: obj.body,
    size: obj.size,
    headers: {
      'Content-Type': viewable ? target.mime_type : 'application/octet-stream',
      'Content-Disposition': contentDisposition(target.file_name, opts.download || !viewable),
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': DOCUMENT_CSP,
    },
  };
}

// ---------------------------------------------------------------------------
// DELETE /api/documents/:arsipId, POST …/restore, POST …/rollback
// ---------------------------------------------------------------------------

/** Audit row for an arsip mutation; inserted only if the previous batch statement changed a row. */
function auditFor(
  env: Bindings,
  auth: AuthContext,
  meta: RequestMeta,
  nowIso: string,
  action: string,
  arsip: ArsipRow,
  what: string,
) {
  return auditStatement(
    env.DB,
    {
      ts: nowIso,
      actor: actorOf(auth),
      action,
      targetType: 'arsip_dokumen',
      targetId: arsip.id,
      description: `${what} ${arsip.jenis_dokumen_id} (arsip ${arsip.id}, pegawai ${arsip.pegawai_id})`,
      result: 'SUCCESS',
      ip: meta.ip,
    },
    { onlyIfPreviousChanged: true },
  );
}

export async function deleteDocument(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  meta: RequestMeta,
): Promise<DokumenItem> {
  const arsip = await loadArsip(env, auth, rawId);
  const admin = auth.user.role === 'Admin';
  if (arsip.deleted_at !== null) throw errors.conflict(MSG.alreadyDeleted);
  if (!admin && arsip.status === 'Terverifikasi') throw errors.forbidden();

  const db = env.DB;
  const nowIso = toIso(meta.nowMs);
  const results = await db.batch([
    // Status re-checked in SQL for owners: a verification in between makes this a no-op.
    softDeleteArsip(db, arsip.id, nowIso, toIso(meta.nowMs + SOFT_DELETE_RETENTION_MS), admin),
    riwayatAfterChange(db, 'DELETE', null, auth.user.id, nowIso, { arsipId: arsip.id }),
    auditFor(env, auth, meta, nowIso, 'DOKUMEN_DELETE', arsip, 'Hapus dokumen'),
    ...itemReads(db, arsip.pegawai_id, arsip.jenis_dokumen_id, nowIso),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG.concurrent);
  return itemFromResults(auth.user, results, 3, nowIso);
}

export async function restoreDocument(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  meta: RequestMeta,
): Promise<DokumenItem> {
  const arsip = await loadArsip(env, auth, rawId);
  const nowIso = toIso(meta.nowMs);
  if (arsip.deleted_at === null) throw errors.conflict(MSG.notDeleted);
  if ((arsip.purge_after ?? '') <= nowIso) throw errors.notFound(MSG.purged);
  const admin = auth.user.role === 'Admin';
  // An employee cannot undo an admin's removal of a verified document (M3).
  if (!admin && arsip.status === 'Terverifikasi') {
    throw new ApiError(403, 'FORBIDDEN', MSG.restoreVerifiedAdminOnly);
  }

  const db = env.DB;
  const results = await db.batch([
    // Rule re-checked in SQL for owners.
    restoreArsip(db, arsip.id, nowIso, admin),
    riwayatAfterChange(db, 'RESTORE', null, auth.user.id, nowIso, { arsipId: arsip.id }),
    auditFor(env, auth, meta, nowIso, 'DOKUMEN_RESTORE', arsip, 'Pulihkan dokumen'),
    ...itemReads(db, arsip.pegawai_id, arsip.jenis_dokumen_id, nowIso),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG.concurrent);
  return itemFromResults(auth.user, results, 3, nowIso);
}

export async function rollbackDocument(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  body: unknown,
  meta: RequestMeta,
): Promise<DokumenItem> {
  const id = parseId(rawId);
  if (id === null) throw errors.notFound(MSG.arsipNotFound);
  const { versi: target } = parseWith(rollbackRequestSchema, body);
  const db = env.DB;
  const nowIso = toIso(meta.nowMs);

  const [aRes, vRes] = await db.batch([selectArsipById(db, id), selectVersiFile(db, id, target, nowIso)]);
  const arsip = (aRes?.results?.[0] as ArsipRow | undefined) ?? null;
  assertCanAccessArsip(auth, arsip);
  const admin = auth.user.role === 'Admin';
  if (arsip.deleted_at !== null) throw errors.conflict(MSG.restoreFirst);
  if (!admin && arsip.status === 'Terverifikasi') throw errors.forbidden();
  const targetRow = (vRes?.results?.[0] as VersiFileRow | undefined) ?? null;
  if (!targetRow) throw errors.notFound(MSG.versiNotFound);
  // An owner cannot resurrect an admin-deleted verified file via upload + rollback.
  if (!admin && isAdminOnlyVersi(targetRow)) throw new ApiError(403, 'FORBIDDEN', MSG.restoreVerifiedAdminOnly);

  // Chain (each step runs only if the previous one changed a row):
  //  1. current file → version row (versi = current number). Version rows only hold
  //     numbers LOWER than the arsip's current versi (it only ever increments), so
  //     UNIQUE(arsip_id, versi) cannot collide. Guarded by the expected versi, the
  //     owner's status rule and the target version still existing (cron purge race) and,
  //     for owners, not being an admin-only target (OWNER_ROLLBACK_TARGET_SQL).
  //  2. arsip ← selected version (file + status/catatan/verified_*), versi + 1.
  //  3. selected version row removed.  4. riwayat ROLLBACK.  5. audit.
  const ownerGuard = admin ? '' : `AND status <> 'Terverifikasi'`;
  const results = await db.batch([
    copyCurrentToVersi(
      db,
      arsip.id,
      arsip.versi,
      nowIso,
      toIso(meta.nowMs + VERSION_RETENTION_MS),
      `${ownerGuard} AND EXISTS (SELECT 1 FROM arsip_dokumen_versi x
                                   WHERE x.arsip_id = ?1 AND x.versi = ?5 AND x.purge_after > ?3
                                     ${admin ? '' : `AND ${OWNER_ROLLBACK_TARGET_SQL}`})`,
      target,
    ),
    updateArsipFromVersi(db, arsip.id, arsip.versi, target),
    deleteVersiRow(db, arsip.id, target),
    riwayatAfterChange(db, 'ROLLBACK', `Kembali ke versi ${target}`, auth.user.id, nowIso, { arsipId: arsip.id }),
    auditFor(env, auth, meta, nowIso, 'DOKUMEN_ROLLBACK', arsip, `Kembalikan ke versi ${target}: dokumen`),
    ...itemReads(db, arsip.pegawai_id, arsip.jenis_dokumen_id, nowIso),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG.concurrent);
  return itemFromResults(auth.user, results, 5, nowIso);
}

// ---------------------------------------------------------------------------
// GET /api/documents/:arsipId/riwayat
// ---------------------------------------------------------------------------

export async function getRiwayat(env: Bindings, auth: AuthContext, rawId: string): Promise<RiwayatItem[]> {
  const id = parseId(rawId);
  if (id === null) throw errors.notFound(MSG.arsipNotFound);
  // One round trip; the history is only returned after the access check below.
  const [aRes, rRes] = await env.DB.batch([selectArsipById(env.DB, id), selectRiwayat(env.DB, id)]);
  assertCanAccessArsip(auth, (aRes?.results?.[0] as ArsipRow | undefined) ?? null);
  return ((rRes?.results ?? []) as RiwayatRow[]).map((r) => ({
    id: r.id,
    versi: r.versi,
    aksi: r.aksi as RiwayatAksi,
    status: r.status,
    catatan: r.catatan,
    actor: r.actor_id !== null ? { id: r.actor_id, nama: r.actor_nama ?? '' } : null,
    createdAt: r.created_at,
  }));
}
