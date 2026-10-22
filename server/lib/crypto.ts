// Password hashing and session tokens (MIGRATION_PLAN §3.1, owner decision #2).
//
// Standard format:  pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>
//   PBKDF2-SHA256(key = HMAC-SHA256(PASSWORD_PEPPER, password), salt 16 B, 32 B output)
// Legacy format:    legacy-wrap$<iter>$<salt_b64>$<hash_b64>
//   same, but the HMAC input is the lowercase hex SHA-256 of the password
//   (wraps the unsalted GAS hash during data migration — §5.1).
//
// The pepper is used as the UTF-8 bytes of the secret string. scripts/dev-seed.mjs
// and the migration ETL MUST use exactly the same encoding.
//
// CPU budget (Workers Free = 10 ms/request): one HMAC + one 10k PBKDF2 per verify.

import { AUTH_POLICY } from '../../shared/enums';
import { API_KEY_PATTERN } from '../../shared/integrasi';

export const HASH_PREFIX = 'pbkdf2-sha256';
export const LEGACY_PREFIX = 'legacy-wrap';
const SALT_BYTES = 16;
const HASH_BITS = 256;
/** workerd rejects PBKDF2 above 100k iterations; also guards against tampered rows. */
const MAX_ITERATIONS = 100_000;

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/** Constant-time comparison (length is not secret here: both are fixed-size digests). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

async function pepperedBytes(pepper: string, input: string): Promise<ArrayBuffer> {
  if (!pepper) throw new Error('PASSWORD_PEPPER is not configured');
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return crypto.subtle.sign('HMAC', key, encoder.encode(input));
}

async function pbkdf2(keyMaterial: ArrayBuffer, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
}

function format(prefix: string, iterations: number, salt: Uint8Array, hash: Uint8Array): string {
  return `${prefix}$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

/** Hash a plaintext password in the standard format. */
export async function hashPassword(
  password: string,
  pepper: string,
  iterations: number = AUTH_POLICY.pbkdf2Iterations,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(await pepperedBytes(pepper, password), salt, iterations);
  return format(HASH_PREFIX, iterations, salt, hash);
}

/**
 * Wrap a legacy unsalted SHA-256 hex hash (GAS `hashPassword`) for import.
 * Used by the migration ETL and tests; never stores the bare SHA-256.
 */
export async function wrapLegacySha256Hex(
  sha256HexHash: string,
  pepper: string,
  iterations: number = AUTH_POLICY.pbkdf2Iterations,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(await pepperedBytes(pepper, sha256HexHash.toLowerCase()), salt, iterations);
  return format(LEGACY_PREFIX, iterations, salt, hash);
}

interface ParsedHash {
  prefix: typeof HASH_PREFIX | typeof LEGACY_PREFIX;
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 4) return null;
  const [prefix, iterStr, saltB64, hashB64] = parts as [string, string, string, string];
  if (prefix !== HASH_PREFIX && prefix !== LEGACY_PREFIX) return null;
  if (!/^\d{1,7}$/.test(iterStr)) return null;
  const iterations = Number(iterStr);
  if (iterations < 1 || iterations > MAX_ITERATIONS) return null;
  try {
    const salt = base64ToBytes(saltB64);
    const hash = base64ToBytes(hashB64);
    if (salt.length < 8 || hash.length !== HASH_BITS / 8) return null;
    return { prefix, iterations, salt, hash };
  } catch {
    return null;
  }
}

export interface VerifyResult {
  ok: boolean;
  /** True when the stored hash uses fewer iterations than policy and should be replaced. */
  needsRehash: boolean;
}

/** Verify `password` against a stored hash (standard or legacy-wrap). Malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string, pepper: string): Promise<VerifyResult> {
  const parsed = parseHash(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const input = parsed.prefix === LEGACY_PREFIX ? await sha256Hex(password) : password;
  const candidate = await pbkdf2(await pepperedBytes(pepper, input), parsed.salt, parsed.iterations);
  const ok = constantTimeEqual(candidate, parsed.hash);
  return {
    ok,
    // legacy-wrap is NOT rehashed: it is already salted + peppered + policy
    // iterations, so a rehash would only spend a second PBKDF2 (~4 ms CPU) on
    // the login path for no security gain. Only weaker iteration counts upgrade.
    needsRehash: ok && parsed.iterations < AUTH_POLICY.pbkdf2Iterations,
  };
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/** 32 random bytes, base64url (43 chars). Only ever sent in the cookie. */
export function generateSessionToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Value stored in `sesi.token_hash`. */
export function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Public, non-secret session identifier exposed by GET /api/auth/sessions. */
export function sessionPublicId(tokenHash: string): string {
  return tokenHash.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Integration API keys (shared/integrasi.ts)
// ---------------------------------------------------------------------------

/**
 * New key `skp_<idPublik>_<secret>`: 6 random bytes as the public id (lookup, shown in the UI)
 * and 32 random bytes as the secret. Only `hashApiKey(kunci)` is stored.
 */
export function generateApiKey(): { kunci: string; idPublik: string } {
  const idPublik = bytesToHex(crypto.getRandomValues(new Uint8Array(6)));
  const secret = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { kunci: `skp_${idPublik}_${secret}`, idPublik };
}

/** Public id of a well-formed key, or null. Never logs or returns the secret part. */
export function apiKeyPublicId(kunci: string): string | null {
  return API_KEY_PATTERN.exec(kunci)?.[1] ?? null;
}

/** Value stored in `kunci_api.token_hash` (SHA-256 hex of the full key). */
export function hashApiKey(kunci: string): Promise<string> {
  return sha256Hex(kunci);
}

/** Constant-time comparison of two SHA-256 hex digests. */
export function hexDigestEqual(a: string, b: string): boolean {
  return constantTimeEqual(encoder.encode(a), encoder.encode(b));
}
