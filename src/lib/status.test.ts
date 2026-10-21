import { describe, expect, it } from 'vitest';
import { STATUS_AKUN, STATUS_DOKUMEN, STATUS_PENGAJUAN } from '@shared/enums';
import { KELENGKAPAN } from '@shared/pegawai';
import { STATUS_REGISTRY, TONE_CLASSES, statusSpec } from './status';

describe('status registry', () => {
  it('covers every enum value of each domain', () => {
    expect(Object.keys(STATUS_REGISTRY.dokumen).sort()).toEqual([...STATUS_DOKUMEN, 'Belum diunggah'].sort());
    expect(Object.keys(STATUS_REGISTRY.pengajuan).sort()).toEqual([...STATUS_PENGAJUAN].sort());
    expect(Object.keys(STATUS_REGISTRY.akun).sort()).toEqual([...STATUS_AKUN].sort());
    expect(Object.keys(STATUS_REGISTRY.kelengkapan).sort()).toEqual([...KELENGKAPAN].sort());
  });

  it('uses only known tones with literal classes', () => {
    for (const domain of Object.values(STATUS_REGISTRY)) {
      for (const spec of Object.values(domain)) {
        expect(Object.keys(TONE_CLASSES)).toContain(spec.tone);
        expect(spec.label.length).toBeGreaterThan(0);
        expect(spec.icon).toBeTruthy();
      }
    }
  });

  it('keeps red for failure only: neutral for not-yet-uploaded, inactive and cancelled', () => {
    expect(statusSpec('dokumen', 'Belum diunggah').tone).toBe('neutral');
    expect(statusSpec('akun', 'Nonaktif').tone).toBe('neutral');
    expect(statusSpec('pengajuan', 'Dibatalkan').tone).toBe('neutral');
    expect(statusSpec('dokumen', 'Ditolak').tone).toBe('rejected');
    expect(statusSpec('hasil', 'Gagal').tone).toBe('rejected');
  });

  it('gives one word the same tone and icon in every domain', () => {
    const byLabel = new Map<string, { tone: string; icon: unknown }>();
    for (const domain of Object.values(STATUS_REGISTRY)) {
      for (const spec of Object.values(domain)) {
        const seen = byLabel.get(spec.label);
        if (seen) expect({ tone: spec.tone, icon: spec.icon }).toEqual(seen);
        else byLabel.set(spec.label, { tone: spec.tone, icon: spec.icon });
      }
    }
  });
});
