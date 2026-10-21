import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AUTH_POLICY } from '../shared/enums';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  sessionPublicId,
  sha256Hex,
  verifyPassword,
  wrapLegacySha256Hex,
} from '../server/lib/crypto';

const PEPPER = 'test-pepper-not-a-secret-0123456789abcdef';

describe('password hashing', () => {
  it('produces the documented format with policy iterations and random salt', async () => {
    const a = await hashPassword('Rahasia123', PEPPER);
    const b = await hashPassword('Rahasia123', PEPPER);
    expect(a).toMatch(/^pbkdf2-sha256\$10000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('Rahasia123', PEPPER);
    expect(await verifyPassword('Rahasia123', stored, PEPPER)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword('rahasia123', stored, PEPPER)).ok).toBe(false);
  });

  it('depends on the pepper', async () => {
    const stored = await hashPassword('Rahasia123', PEPPER);
    expect((await verifyPassword('Rahasia123', stored, 'other-pepper')).ok).toBe(false);
  });

  it('rejects malformed or tampered hashes without throwing', async () => {
    for (const bad of [
      '',
      'plain',
      'sha256$abc',
      'pbkdf2-sha256$abc$AAAA$BBBB',
      'pbkdf2-sha256$0$AAAAAAAAAAAAAAAAAAAAAA==$AAAA',
      'pbkdf2-sha256$999999999$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'pbkdf2-sha256$10000$!!!$AAAA',
    ]) {
      expect((await verifyPassword('x', bad, PEPPER)).ok).toBe(false);
    }
  });

  it('verifies legacy-wrap hashes (HMAC over sha256 hex) without requesting a rehash', async () => {
    const legacyHex = await sha256Hex('123456'); // what GAS stored
    const stored = await wrapLegacySha256Hex(legacyHex.toUpperCase(), PEPPER);
    expect(stored.startsWith('legacy-wrap$10000$')).toBe(true);
    expect(await verifyPassword('123456', stored, PEPPER)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword('654321', stored, PEPPER)).ok).toBe(false);
  });

  it('flags hashes with fewer iterations than policy for rehash', async () => {
    const weak = await hashPassword('Rahasia123', PEPPER, 1000);
    expect(await verifyPassword('Rahasia123', weak, PEPPER)).toEqual({ ok: true, needsRehash: true });
  });
});

describe('session tokens', () => {
  it('are 32 random bytes in base64url and hash to 64 hex chars', async () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toBe(t);
    const h = await hashSessionToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionPublicId(h)).toBe(h.slice(0, 16));
  });
});

describe('PBKDF2 cost (CPU budget estimate)', () => {
  it('measures one 10k-iteration hash under workerd', async () => {
    // Warm up (first call pays key-import/JIT setup).
    await hashPassword('Warmup123', env.PASSWORD_PEPPER);
    const runs = 10;
    const start = performance.now();
    for (let i = 0; i < runs; i++) await hashPassword(`Pw${i}abcDEF`, env.PASSWORD_PEPPER);
    const perHash = (performance.now() - start) / runs;
    console.log(
      `[bench] PBKDF2-SHA256 ${AUTH_POLICY.pbkdf2Iterations} iterations + HMAC pepper: ${perHash.toFixed(2)} ms/hash (avg of ${runs}, local workerd)`,
    );
    expect(perHash).toBeGreaterThanOrEqual(0);
  });
});
