// Phase 5: admin document verification queue + approve/reject decisions.
// Contract: shared/verifikasi.ts.
import type { DocumentMime } from '../../shared/dokumen';
import { normalizePhone } from '../../shared/validators';
import {
  approveRequestSchema,
  rejectRequestSchema,
  verifikasiQuerySchema,
  type DecisionResponse,
  type VerifikasiItem,
  type VerifikasiQueueResponse,
} from '../../shared/verifikasi';
import { riwayatAfterChange } from '../db/dokumen';
import { NOTIF_KEYS, notifEnabled, selectSettings, SETTING_KEYS, settingsMap, type SettingRow } from '../db/pengaturan';
import {
  decideArsip,
  QUEUE_PAGE_SIZE,
  selectDecisionTarget,
  selectPendingCount,
  selectPendingPerJenis,
  selectQueue,
  type DecisionTargetRow,
  type QueueRow,
} from '../db/verifikasi';
import type { AuthContext, Bindings } from '../env';
import { auditStatement } from '../lib/audit';
import { base64ToBytes, bytesToBase64Url } from '../lib/crypto';
import { ApiError, errors } from '../lib/errors';
import { photoUrl } from '../lib/photo-url';
import { toIso } from '../lib/time';
import { parseWith } from '../lib/validation';
import type { RequestMeta } from './auth';
import { parseId } from './dokumen';
import { decisionGuard, insertedIds, outboxStatements, type OutboxMessage } from './notifikasi';

const MSG = {
  arsipNotFound: 'Dokumen tidak ditemukan.',
  ownDocument: 'Dokumen Anda sendiri harus diverifikasi admin lain.',
  changed: 'Dokumen telah berubah. Muat ulang antrean.',
  badCursor: 'Cursor tidak valid.',
} as const;

// ---------------------------------------------------------------------------
// Cursor: base64url("uploaded_at|id")
// ---------------------------------------------------------------------------

export function encodeCursor(uploadedAt: string, id: number): string {
  return bytesToBase64Url(new TextEncoder().encode(`${uploadedAt}|${id}`));
}

export function decodeCursor(raw: string): { uploadedAt: string; id: number } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64ToBytes(b64));
    const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([1-9]\d{0,15})$/.exec(text);
    if (!m) return null;
    const id = Number(m[2]);
    return Number.isSafeInteger(id) ? { uploadedAt: m[1]!, id } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/verifikasi
// ---------------------------------------------------------------------------

function toItem(r: QueueRow): VerifikasiItem {
  return {
    arsipId: r.arsip_id,
    versi: r.versi,
    jenisDokumen: { id: r.jenis_id, nama: r.jenis_nama, kategori: r.kategori, wajib: r.wajib === 1 },
    pegawai: {
      id: r.pegawai_id,
      nip: r.nip,
      nama: r.nama,
      statusKepegawaian: r.status_kepegawaian,
      jabatan: r.jabatan,
      unit: r.unit_nama,
      fotoUrl: r.foto_r2_key ? photoUrl(r.pegawai_id, r.foto_r2_key) : null,
    },
    file: { fileName: r.file_name, mimeType: r.mime_type as DocumentMime, sizeBytes: r.size_bytes },
    uploadedAt: r.uploaded_at,
    isReupload: r.versi > 1,
    catatanSebelumnya: r.catatan_sebelumnya,
  };
}

export async function listQueue(env: Bindings, query: unknown): Promise<VerifikasiQueueResponse> {
  const q = parseWith(verifikasiQuerySchema, query);
  let cursor: { uploadedAt: string; id: number } | null = null;
  if (q.cursor) {
    cursor = decodeCursor(q.cursor);
    if (!cursor) throw errors.validation({ cursor: MSG.badCursor });
  }
  const jenis = q.jenis ? q.jenis : null;
  const db = env.DB;
  const [itemsRes, perRes] = await db.batch([
    selectQueue(db, jenis, cursor, QUEUE_PAGE_SIZE + 1),
    selectPendingPerJenis(db),
  ]);
  const rows = (itemsRes?.results ?? []) as QueueRow[];
  const page = rows.slice(0, QUEUE_PAGE_SIZE);
  const last = page[page.length - 1];
  const perJenis: Record<string, number> = {};
  let total = 0;
  for (const r of (perRes?.results ?? []) as { jenis_id: string; n: number }[]) {
    perJenis[r.jenis_id] = r.n;
    total += r.n;
  }
  return {
    items: page.map(toItem),
    nextCursor: rows.length > QUEUE_PAGE_SIZE && last ? encodeCursor(last.uploaded_at, last.arsip_id) : null,
    total,
    perJenis,
  };
}

// ---------------------------------------------------------------------------
// POST /api/admin/verifikasi/:arsipId/approve | reject
// ---------------------------------------------------------------------------

export interface DecisionOutcome {
  response: DecisionResponse;
  /** Outbox ids inserted by this decision (to flush after the response). */
  outboxIds: number[];
}

async function decide(
  env: Bindings,
  auth: AuthContext,
  rawId: string,
  kind: 'approve' | 'reject',
  body: unknown,
  meta: RequestMeta,
): Promise<DecisionOutcome> {
  const arsipId = parseId(rawId);
  if (arsipId === null) throw errors.notFound(MSG.arsipNotFound);
  const input =
    kind === 'approve'
      ? { ...parseWith(approveRequestSchema, body), alasan: null as string | null }
      : parseWith(rejectRequestSchema, body);
  const db = env.DB;

  // Round trip 1: target arsip (+ owner name/phone, jenis name) and notification toggles.
  const [aRes, sRes] = await db.batch([selectDecisionTarget(db, arsipId), selectSettings(db, NOTIF_KEYS)]);
  const target = (aRes?.results?.[0] as DecisionTargetRow | undefined) ?? null;
  if (!target || target.deleted_at !== null) throw errors.notFound(MSG.arsipNotFound);
  // Four-eyes rule (like pengajuan): overrides the generic FORBIDDEN message on purpose.
  if (target.pegawai_id === auth.user.id) throw new ApiError(403, 'FORBIDDEN', MSG.ownDocument);
  if (target.status !== 'Menunggu' || target.versi !== input.versi) throw errors.conflict(MSG.changed);

  const status = kind === 'approve' ? 'Terverifikasi' : 'Ditolak';
  const settings = settingsMap(sRes?.results as SettingRow[] | undefined);
  const enabled = notifEnabled(
    settings,
    kind === 'approve' ? SETTING_KEYS.notifDokumenApproved : SETTING_KEYS.notifDokumenRejected,
  );
  const phone = target.no_hp ? normalizePhone(target.no_hp) : null;
  const notifikasi: DecisionResponse['notifikasi'] = !enabled ? 'NONAKTIF' : !phone ? 'TANPA_NOMOR' : 'DIANTRIKAN';

  const nowIso = toIso(meta.nowMs);
  const messages: OutboxMessage[] =
    notifikasi === 'DIANTRIKAN' && phone
      ? [
          kind === 'approve'
            ? {
                target: phone,
                template: 'dokumen_terverifikasi',
                params: { nama: target.pegawai_nama, namaDokumen: target.jenis_nama },
              }
            : {
                target: phone,
                template: 'dokumen_ditolak',
                params: { nama: target.pegawai_nama, namaDokumen: target.jenis_nama, alasan: input.alasan ?? '' },
              },
        ]
      : [];

  const u = auth.user;
  const results = await db.batch([
    // 0: compare-and-set.
    decideArsip(db, arsipId, input.versi, status, u.id, nowIso, input.alasan),
    // 1: riwayat (only if 0 changed a row; carries pegawai_id + jenis_dokumen_id).
    riwayatAfterChange(db, kind === 'approve' ? 'APPROVE' : 'REJECT', input.alasan, u.id, nowIso, { arsipId }),
    // 2: audit (only if 1 inserted, i.e. 0 changed a row).
    auditStatement(
      db,
      {
        ts: nowIso,
        actor: { id: u.id, nip: u.nip, nama: u.nama, role: u.role },
        action: kind === 'approve' ? 'DOKUMEN_APPROVE' : 'DOKUMEN_REJECT',
        targetType: 'arsip_dokumen',
        targetId: arsipId,
        description:
          `${kind === 'approve' ? 'Verifikasi' : 'Tolak'} dokumen ${target.jenis_dokumen_id} ` +
          `(arsip ${arsipId}, versi ${input.versi}, pegawai ${target.pegawai_id})` +
          (input.alasan ? `: ${input.alasan}` : ''),
        result: 'SUCCESS',
        ip: meta.ip,
      },
      { onlyIfPreviousChanged: true },
    ),
    // 3: outbox (≤ 1 message), guarded by the decision's post-condition AND changes() > 0
    // of the gated audit at 2, so a same-millisecond replay that lost the CAS inserts
    // nothing (decisionGuard sets requirePreviousChange). Must stay directly after 2.
    ...outboxStatements(db, messages, decisionGuard(arsipId, input.versi, status, u.id, nowIso), nowIso),
    // last: remaining queue size.
    selectPendingCount(db),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw errors.conflict(MSG.changed);
  const countRow = results[results.length - 1]?.results?.[0] as { n: number } | undefined;
  return {
    response: { arsipId, status, notifikasi, sisaAntrean: countRow?.n ?? 0 },
    outboxIds: insertedIds(results.slice(3, 3 + messages.length)),
  };
}

export function approveDocument(env: Bindings, auth: AuthContext, rawId: string, body: unknown, meta: RequestMeta) {
  return decide(env, auth, rawId, 'approve', body, meta);
}

export function rejectDocument(env: Bindings, auth: AuthContext, rawId: string, body: unknown, meta: RequestMeta) {
  return decide(env, auth, rawId, 'reject', body, meta);
}
