/** Page buttons to show: always first/last, a window around the current page, '…' for gaps. 1-based. */
export function pageNumbers(current: number, pageCount: number, siblings = 1): (number | 'gap')[] {
  if (pageCount <= 0) return [];
  const pages = new Set<number>([1, pageCount]);
  for (let p = current - siblings; p <= current + siblings; p++) if (p >= 1 && p <= pageCount) pages.add(p);
  const sorted = [...pages].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const page = sorted[i]!;
    const prev = sorted[i - 1];
    if (prev !== undefined && page - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && page - prev > 2) out.push('gap');
    out.push(page);
  }
  return out;
}

/** "Menampilkan 16–30 dari 46" (1-based page). */
export function rangeLabel(page: number, pageSize: number, total: number): string {
  if (total === 0) return 'Tidak ada data';
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return `Menampilkan ${from.toLocaleString('id-ID')}–${to.toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')}`;
}

export function pageCountFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
