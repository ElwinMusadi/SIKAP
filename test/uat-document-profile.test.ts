// Synthetic fixtures only. Tests supported non-contact test values before the
// operator document UAT; not a relaxation of production validation.
import { describe, expect, it } from 'vitest';
import { updateProfileRequestSchema } from '../shared/profile';
import { normalizePhone } from '../shared/validators';

describe('non-contact synthetic UAT profile', () => {
  it('accepts deliberately non-routable dummy phone and reserved email domain', () => {
    expect(normalizePhone('0000000000')).toBe('62000000000');
    const profile = updateProfileRequestSchema.parse({
      nik: '0000000000000002', tempatLahir: 'KOTA SINTETIS UAT', tanggalLahir: '1900-02-02',
      jenisKelamin: 'Laki-laki', agama: 'Islam', pendidikanKode: 'S1',
      statusPernikahan: 'Belum Menikah', noHp: '0000000000', email: 'pns@example.invalid',
      alamat: 'ALAMAT SINTETIS UAT — BUKAN DATA PEGAWAI NYATA',
    });
    expect(profile.noHp).toBe('62000000000');
    expect(profile.email).toBe('pns@example.invalid');
  });
});
