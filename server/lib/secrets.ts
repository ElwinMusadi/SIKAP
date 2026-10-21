// Encrypted settings (Phase 5): WhatsApp provider tokens are stored in `pengaturan`
// as AES-GCM-256 ciphertext under SETTINGS_ENC_KEY (base64 of exactly 32 bytes).
// Format: `v1:<iv_b64>:<ct_b64>` (12-byte random IV; ciphertext includes the GCM tag).
// The key is imported per call (cheap); plaintext and key never appear in errors.
import { base64ToBytes, bytesToBase64 } from './crypto';

const PREFIX = 'v1';
const IV_BYTES = 12;

async function importKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(keyB64.trim());
  } catch {
    throw new Error('SETTINGS_ENC_KEY is not valid base64');
  }
  if (raw.length !== 32) throw new Error('SETTINGS_ENC_KEY must decode to 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSetting(plain: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
  return `${PREFIX}:${bytesToBase64(iv)}:${bytesToBase64(ct)}`;
}

/** Throws (without revealing anything) on a wrong key, tampering or an unknown format. */
export async function decryptSetting(cipher: string, keyB64: string): Promise<string> {
  const parts = cipher.split(':');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('unsupported encrypted setting format');
  const key = await importKey(keyB64);
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = base64ToBytes(parts[1]!);
    ct = base64ToBytes(parts[2]!);
  } catch {
    throw new Error('malformed encrypted setting');
  }
  if (iv.length !== IV_BYTES) throw new Error('malformed encrypted setting');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('encrypted setting could not be decrypted');
  }
}
