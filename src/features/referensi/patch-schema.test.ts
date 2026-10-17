import { describe, expect, it } from 'vitest';
import { updateJenisSchema, updatePangkatSchema, updateUnitSchema } from '@shared/administrasi';

describe('PATCH must not apply create-only defaults', () => {
  it.each([
    ['pangkat', updatePangkatSchema],
    ['unit', updateUnitSchema],
    ['jenis dokumen', updateJenisSchema],
  ] as const)('%s: editing a name cannot implicitly reactivate an inactive row', (_label, schema) => {
    const patch = schema.parse({ nama: 'Nama baru' });
    expect(patch).toEqual({ nama: 'Nama baru' });
    expect(Object.hasOwn(patch, 'aktif')).toBe(false);
    expect(schema.parse({ aktif: false })).toEqual({ aktif: false });
    expect(schema.parse({ aktif: true })).toEqual({ aktif: true });
  });
});
