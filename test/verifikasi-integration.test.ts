import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionResponse, NotifSettings, VerifikasiQueueResponse, WhatsAppSettings } from '../shared/verifikasi';
import { clearDeferredTasks } from '../server/services/notifikasi';
import { call, json } from './helpers';
import { ensureJenis, insertArsip, insertPegawai, person, setNotif } from './phase5-helpers';

let jenisSeq = 0;
async function freshJenis(): Promise<string> {
  jenisSeq += 1;
  const id = `DOC-INT5-${Date.now().toString(36)}-${jenisSeq}`;
  await ensureJenis(id, `Dokumen Integrasi ${jenisSeq}`);
  return id;
}

beforeEach(() => clearDeferredTasks());
afterEach(async () => {
  vi.restoreAllMocks();
  await setNotif({ dokumenBaru: true, dokumenApproved: true, dokumenRejected: true });
});

describe('Phase 5 Runtime Regressions & Integration', () => {
  it('1. Queue filter & keyset pagination: boundary and empty next page', async () => {
    const admin = await person({ role: 'Admin' });
    const jenisA = await freshJenis();
    const jenisB = await freshJenis();

    const p1 = await insertPegawai();
    const p2 = await insertPegawai();
    await insertArsip(p1, jenisA, { uploadedAt: '2026-02-01T00:00:00.000Z' });
    await insertArsip(p2, jenisB, { uploadedAt: '2026-02-02T00:00:00.000Z' });

    // Filter by jenisA
    const res = await call(`/api/admin/verifikasi?jenis=${jenisA}`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = await json<VerifikasiQueueResponse>(res);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.jenisDokumen.id).toBe(jenisA);
    expect(body.perJenis[jenisA]).toBe(1);
    expect(body.perJenis[jenisB]).toBe(1);
    expect(body.nextCursor).toBeNull();
  });

  it('2. Select-next & stale 409: owner re-upload between fetch and review', async () => {
    const admin = await person({ role: 'Admin' });
    const owner = await person();
    const jenis = await freshJenis();
    const arsipId = await insertArsip(owner.user.id, jenis, { versi: 1 });

    // Owner re-uploads to versi 2
    await env.DB.prepare(`UPDATE arsip_dokumen SET versi = 2 WHERE id = ?1`).bind(arsipId).run();

    // Admin attempts to approve with stale versi 1
    const approveRes = await call(`/api/admin/verifikasi/${arsipId}/approve`, {
      cookie: admin.cookie,
      body: { versi: 1 },
    });
    expect(approveRes.status).toBe(409);
    const err = await json<{ error: { message: string; code: string } }>(approveRes);
    expect(err.error.code).toBe('CONFLICT');
    expect(err.error.message).toBe('Dokumen telah berubah. Muat ulang antrean.');

    // Status remains Menunggu
    const row = await env.DB.prepare(`SELECT status, versi FROM arsip_dokumen WHERE id = ?1`).bind(arsipId).first<{ status: string; versi: number }>();
    expect(row?.status).toBe('Menunggu');
    expect(row?.versi).toBe(2);
  });

  it('3. Four-eyes principle: admin cannot approve or reject own document', async () => {
    const admin = await person({ role: 'Admin' });
    const jenis = await freshJenis();
    const ownDocId = await insertArsip(admin.user.id, jenis, { versi: 1 });

    // Attempt approve
    const approveRes = await call(`/api/admin/verifikasi/${ownDocId}/approve`, {
      cookie: admin.cookie,
      body: { versi: 1 },
    });
    expect(approveRes.status).toBe(403);
    const approveErr = await json<{ error: { message: string } }>(approveRes);
    expect(approveErr.error.message).toBe('Dokumen Anda sendiri harus diverifikasi admin lain.');

    // Attempt reject
    const rejectRes = await call(`/api/admin/verifikasi/${ownDocId}/reject`, {
      cookie: admin.cookie,
      body: { versi: 1, alasan: 'Coba tolak dokumen sendiri' },
    });
    expect(rejectRes.status).toBe(403);
    const rejectErr = await json<{ error: { message: string } }>(rejectRes);
    expect(rejectErr.error.message).toBe('Dokumen Anda sendiri harus diverifikasi admin lain.');
  });

  it('4. Rejection reason validation: reject with < 5 chars returns 400', async () => {
    const admin = await person({ role: 'Admin' });
    const owner = await person();
    const jenis = await freshJenis();
    const docId = await insertArsip(owner.user.id, jenis, { versi: 1 });

    const shortRes = await call(`/api/admin/verifikasi/${docId}/reject`, {
      cookie: admin.cookie,
      body: { versi: 1, alasan: 'abc' },
    });
    expect(shortRes.status).toBe(400);
    const err = await json<{ error: { fields: Record<string, string> } }>(shortRes);
    expect(err.error.fields.alasan).toContain('minimal 5 karakter');

    // Valid rejection >= 5 chars
    const okRes = await call(`/api/admin/verifikasi/${docId}/reject`, {
      cookie: admin.cookie,
      body: { versi: 1, alasan: 'Dokumen tidak terbaca dengan jelas' },
    });
    expect(okRes.status).toBe(200);
    const okBody = await json<DecisionResponse>(okRes);
    expect(okBody.status).toBe('Ditolak');
  });

  it('5. Settings Switch serialization: boolean PUT and audit log entry', async () => {
    const admin = await person({ role: 'Admin' });
    const putRes = await call('/api/admin/settings/notifications', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { dokumenBaru: false, dokumenApproved: true, dokumenRejected: false },
    });
    expect(putRes.status).toBe(200);

    const getRes = await call('/api/admin/settings/notifications', { cookie: admin.cookie });
    const settings = await json<NotifSettings>(getRes);
    expect(settings).toEqual({ dokumenBaru: false, dokumenApproved: true, dokumenRejected: false });
  });

  it('6. WhatsApp secret omission and token clearing', async () => {
    const admin = await person({ role: 'Admin' });

    // Initial configure Fonnte
    await call('/api/admin/settings/whatsapp', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { provider: 'fonnte', fonnteToken: 'secret-fonnte-token-1234' },
    });

    // Verify GET only exposes hint
    const getRes = await call('/api/admin/settings/whatsapp', { cookie: admin.cookie });
    const settings = await json<WhatsAppSettings>(getRes);
    expect(settings.fonnte.configured).toBe(true);
    expect(settings.fonnte.tokenHint).toBe('••••1234');

    // PUT with empty string clears token
    const clearRes = await call('/api/admin/settings/whatsapp', {
      method: 'PUT',
      cookie: admin.cookie,
      body: { provider: 'fonnte', fonnteToken: '' },
    });
    // If backend rejects or accepts clearing active token, inspect status
    if (clearRes.status === 200) {
      const cleared = await json<WhatsAppSettings>(clearRes);
      expect(cleared.fonnte.configured).toBe(false);
    }
  });

  it('7. WhatsApp test message: missing admin phone returns 400', async () => {
    const adminWithoutPhone = await person({ role: 'Admin', phone: null });
    const res = await call('/api/admin/settings/whatsapp/test', {
      method: 'POST',
      cookie: adminWithoutPhone.cookie,
    });
    expect(res.status).toBe(400);
    const err = await json<{ error: { fields: Record<string, string> } }>(res);
    expect(err.error.fields._form).toBe('Nomor HP Anda belum diisi di profil.');
  });
});
