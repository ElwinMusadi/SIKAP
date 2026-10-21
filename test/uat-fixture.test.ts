// Cross-check: the hash produced by scripts/staging/uat-fixture.mjs (Node) verifies with the
// server's verifyPassword (workerd). Fixed synthetic vector; the .mjs test asserts the same string.
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../server/lib/crypto';

// base64 of 32 bytes of 0x07 (synthetic). Used as its literal UTF-8 string, like PASSWORD_PEPPER.
const PEPPER = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
const PASSWORD = 'Synthetic-Vector-Pass_0123456789';
const STORED = 'pbkdf2-sha256$10000$BQUFBQUFBQUFBQUFBQUFBQ==$sShNSD5hTZ7wlcCDnnyH/qIsI8vPhtDiI+LVb4BDXEY=';

describe('uat-fixture hash compatibility', () => {
  it('server verifyPassword accepts the fixture generator vector', async () => {
    expect(await verifyPassword(PASSWORD, STORED, PEPPER)).toEqual({ ok: true, needsRehash: false });
  });

  it('rejects a wrong password and a base64-decoded pepper interpretation', async () => {
    expect((await verifyPassword(`${PASSWORD}x`, STORED, PEPPER)).ok).toBe(false);
    expect((await verifyPassword(PASSWORD, STORED, atob(PEPPER))).ok).toBe(false);
  });
});
