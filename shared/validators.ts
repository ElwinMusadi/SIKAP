import { z } from 'zod';

/** NIP ASN: exactly 18 digits. */
export const nipSchema = z
  .string()
  .trim()
  .regex(/^\d{18}$/, 'NIP harus 18 digit angka.');

/** NIK: exactly 16 digits. */
export const nikSchema = z
  .string()
  .trim()
  .regex(/^\d{16}$/, 'NIK harus 16 digit angka.');

/** Default password = last 6 digits of NIP (owner decision #6). */
export function defaultPasswordFor(nip: string): string {
  return nip.slice(-6);
}

/**
 * Password chosen by the user. The default password is never accepted here;
 * it is only ever assigned by the system (create / admin reset).
 */
export function newPasswordSchema(nip?: string) {
  return z
    .string()
    .min(8, 'Password minimal 8 karakter.')
    .max(128, 'Password maksimal 128 karakter.')
    .regex(/[a-z]/, 'Password harus mengandung huruf kecil.')
    .regex(/[A-Z]/, 'Password harus mengandung huruf besar.')
    .regex(/\d/, 'Password harus mengandung minimal 1 angka.')
    .refine((v) => !nip || v !== defaultPasswordFor(nip), {
      message: 'Password baru tidak boleh sama dengan password default.',
    });
}

/** Password rule checklist for live UI feedback. */
export const PASSWORD_RULES = [
  { id: 'length', label: 'Minimal 8 karakter', test: (v: string) => v.length >= 8 },
  { id: 'case', label: 'Huruf besar dan kecil', test: (v: string) => /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { id: 'digit', label: 'Minimal 1 angka', test: (v: string) => /\d/.test(v) },
] as const;

/** Normalise Indonesian phone numbers to 62xxxxxxxx (no '+'). Returns null if invalid. */
export function normalizePhone(input: string): string | null {
  const raw = input.replace(/[\s\-().]/g, '');
  if (!raw) return null;
  let digits = raw.startsWith('+') ? raw.slice(1) : raw;
  if (!/^\d+$/.test(digits)) return null;
  if (digits.startsWith('0')) digits = '62' + digits.slice(1);
  else if (digits.startsWith('8')) digits = '62' + digits;
  if (!digits.startsWith('62')) return null;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
