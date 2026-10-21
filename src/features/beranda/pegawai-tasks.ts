import type { DashboardResponse } from '@shared/profile';

export type PegawaiTaskKind = 'profil' | 'status' | 'perbaiki' | 'unggah' | 'menunggu';

export interface PegawaiTask {
  id: string;
  kind: PegawaiTaskKind;
  title: string;
  description?: string;
  /** Omitted for information-only steps (documents waiting for the admin). */
  action?: { to: string; label: string };
}

const jenisLink = (id: string) => `/dokumen?jenis=${encodeURIComponent(id)}`;

/**
 * Ordered to-do list for the employee dashboard (docs/RENCANA-REDESIGN-UIUX.md §8):
 * complete the profile → fix rejected documents → upload missing mandatory documents → wait for review.
 * `prioritas` is capped by the API, so the remainder is summarised from the totals.
 */
export function pegawaiTasks(data: DashboardResponse): PegawaiTask[] {
  const tasks: PegawaiTask[] = [];
  const { profil, dokumen } = data;
  const profileIncomplete = profil.missingFields.length > 0;
  const uploadNote = profileIncomplete ? 'Bisa diunggah setelah data diri lengkap.' : undefined;

  if (profileIncomplete) {
    tasks.push({
      id: 'profil',
      kind: 'profil',
      title: 'Lengkapi data diri',
      description: `${profil.missingFields.length} data belum diisi: ${profil.missingFields.join(', ')}.`,
      action: { to: '/profil', label: 'Lengkapi' },
    });
  }
  if (data.statusKepegawaianKosong) {
    tasks.push({
      id: 'status',
      kind: 'status',
      title: 'Ajukan status kepegawaian',
      description: 'Dokumen wajib baru dapat ditentukan setelah status kepegawaian Anda terisi.',
      action: { to: '/profil#kepegawaian', label: 'Ajukan' },
    });
  }

  const ditolak = dokumen.prioritas.filter((d) => d.status === 'Ditolak');
  for (const doc of ditolak) {
    tasks.push({
      id: `perbaiki-${doc.jenisDokumenId}`,
      kind: 'perbaiki',
      title: `Perbaiki ${doc.nama}`,
      description: doc.catatanAdmin ? `Catatan admin: ${doc.catatanAdmin}` : (uploadNote ?? 'Dokumen ditolak, unggah ulang file yang benar.'),
      action: { to: jenisLink(doc.jenisDokumenId), label: 'Unggah ulang' },
    });
  }
  const ditolakLainnya = (dokumen.counts.Ditolak ?? 0) - ditolak.length;
  if (ditolakLainnya > 0) {
    tasks.push({
      id: 'perbaiki-lainnya',
      kind: 'perbaiki',
      title: `Perbaiki ${ditolakLainnya} dokumen ditolak lainnya`,
      action: { to: '/dokumen', label: 'Buka arsip' },
    });
  }

  const belum = dokumen.prioritas.filter((d) => d.wajib && d.status === 'Belum diunggah');
  for (const doc of belum) {
    tasks.push({
      id: `unggah-${doc.jenisDokumenId}`,
      kind: 'unggah',
      title: `Unggah ${doc.nama}`,
      description: uploadNote ?? `Dokumen wajib · ${doc.kategori}`,
      action: { to: jenisLink(doc.jenisDokumenId), label: 'Unggah' },
    });
  }
  const belumLainnya = Math.max(0, dokumen.wajibTotal - dokumen.wajibTersedia) - belum.length;
  if (belumLainnya > 0) {
    tasks.push({
      id: 'unggah-lainnya',
      kind: 'unggah',
      title: `Unggah ${belumLainnya} dokumen wajib lainnya`,
      description: uploadNote,
      action: { to: '/dokumen', label: 'Buka arsip' },
    });
  }

  const menunggu = dokumen.counts.Menunggu ?? 0;
  if (menunggu > 0) {
    tasks.push({
      id: 'menunggu',
      kind: 'menunggu',
      title: `${menunggu} dokumen sedang diverifikasi`,
      description: 'Tidak perlu tindakan. Anda akan melihat hasilnya di Arsip Dokumen.',
    });
  }
  return tasks;
}
