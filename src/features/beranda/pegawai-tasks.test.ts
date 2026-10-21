import { describe, expect, it } from 'vitest';
import type { DashboardDokumen, DashboardResponse } from '@shared/profile';
import { pegawaiTasks } from './pegawai-tasks';

function doc(id: string, status: DashboardDokumen['status'], overrides: Partial<DashboardDokumen> = {}): DashboardDokumen {
  return { jenisDokumenId: id, nama: id, kategori: 'Identitas', wajib: true, status, catatanAdmin: null, uploadedAt: null, verifiedAt: null, ...overrides };
}

function dashboard(overrides: { dokumen?: Partial<DashboardResponse['dokumen']>; profil?: Partial<DashboardResponse['profil']>; statusKepegawaianKosong?: boolean } = {}): DashboardResponse {
  return {
    dokumen: {
      wajibTotal: 0,
      wajibTerverifikasi: 0,
      wajibTersedia: 0,
      persen: 0,
      counts: { 'Belum diunggah': 0, Menunggu: 0, Terverifikasi: 0, Ditolak: 0 },
      prioritas: [],
      ...overrides.dokumen,
    },
    profil: { terisi: 10, total: 10, persen: 100, missingFields: [], ...overrides.profil },
    pengajuanAktif: null,
    statusKepegawaianKosong: overrides.statusKepegawaianKosong ?? false,
  };
}

describe('pegawaiTasks', () => {
  it('is empty when everything is complete', () => {
    expect(pegawaiTasks(dashboard({ dokumen: { wajibTotal: 2, wajibTersedia: 2, wajibTerverifikasi: 2 } }))).toEqual([]);
  });

  it('orders profile, status, rejected, missing and waiting steps', () => {
    const tasks = pegawaiTasks(
      dashboard({
        profil: { missingFields: ['NIK', 'Email'] },
        statusKepegawaianKosong: true,
        dokumen: {
          wajibTotal: 4,
          wajibTersedia: 2,
          counts: { 'Belum diunggah': 2, Menunggu: 1, Terverifikasi: 0, Ditolak: 1 },
          prioritas: [doc('KK', 'Ditolak', { catatanAdmin: 'Buram' }), doc('KTP', 'Belum diunggah'), doc('NPWP', 'Belum diunggah'), doc('SK', 'Menunggu')],
        },
      }),
    );
    expect(tasks.map((t) => t.id)).toEqual(['profil', 'status', 'perbaiki-KK', 'unggah-KTP', 'unggah-NPWP', 'menunggu']);
    expect(tasks[2]?.description).toBe('Catatan admin: Buram');
    expect(tasks[3]?.description).toBe('Bisa diunggah setelah data diri lengkap.');
    expect(tasks[3]?.action?.to).toBe('/dokumen?jenis=KTP');
    expect(tasks.at(-1)?.action).toBeUndefined();
  });

  it('summarises documents beyond the capped priority list', () => {
    const tasks = pegawaiTasks(
      dashboard({
        dokumen: {
          wajibTotal: 9,
          wajibTersedia: 1,
          counts: { 'Belum diunggah': 8, Menunggu: 0, Terverifikasi: 0, Ditolak: 6 },
          prioritas: ['A', 'B', 'C', 'D', 'E'].map((id) => doc(id, 'Ditolak')),
        },
      }),
    );
    expect(tasks.map((t) => t.title).slice(-2)).toEqual(['Perbaiki 1 dokumen ditolak lainnya', 'Unggah 8 dokumen wajib lainnya']);
  });
});
