/** Cache-busted photo URL; the version is a prefix of the random object name, never the full key. */
export function photoUrl(id: number, key: string): string {
  return `/api/pegawai/${id}/photo?v=${key.split('/').pop()!.slice(0, 12)}`;
}
