/** Required-document counts behind every completeness visual (ProgressMeter, KPI, table cells). */
export interface ProgressCounts {
  terverifikasi: number;
  menunggu: number;
  ditolak: number;
  /** Required documents with no upload yet. */
  belum: number;
}

export function progressTotal(counts: ProgressCounts): number {
  return counts.terverifikasi + counts.menunggu + counts.ditolak + counts.belum;
}

/** Completeness = verified share of all required documents, rounded down so 99.6% never shows as 100%. */
export function progressPercent(counts: ProgressCounts): number {
  const total = progressTotal(counts);
  return total === 0 ? 0 : Math.floor((counts.terverifikasi / total) * 100);
}

export function progressSummary(counts: ProgressCounts): string {
  const total = progressTotal(counts);
  return `${counts.terverifikasi} dari ${total} dokumen wajib terverifikasi, ${counts.menunggu} menunggu, ${counts.ditolak} ditolak, ${counts.belum} belum diunggah`;
}

/** From the list API shape (wajibTotal, wajibTerverifikasi, menunggu) when per-status counts are unknown. */
export function countsFromSummary(summary: { wajibTotal: number; wajibTerverifikasi: number; menunggu: number; ditolak?: number }): ProgressCounts {
  const ditolak = summary.ditolak ?? 0;
  const menunggu = Math.min(summary.menunggu, Math.max(0, summary.wajibTotal - summary.wajibTerverifikasi));
  return {
    terverifikasi: summary.wajibTerverifikasi,
    menunggu,
    ditolak,
    belum: Math.max(0, summary.wajibTotal - summary.wajibTerverifikasi - menunggu - ditolak),
  };
}
