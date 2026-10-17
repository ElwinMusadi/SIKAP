import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../server/lib/crypto';
// Fixed synthetic Node crypto vector; this is NOT an actual UAT credential.
const pepper='UAT-fixture-synthetic-interop-pepper';
const password='UatFixtureExample123!';
const stored='pbkdf2-sha256$10000$ESIzRFVmd4iZqrvM3e7/AA==$hLwZxkflRdw2uz1uQ1e/sUyEw65vGquxqorxC5sYa3M=';
describe('synthetic UAT fixture password interoperability',()=>{
  it('fixture generator deterministic vector is accepted by Workers', async () => {
    const generated = 'pbkdf2-sha256$10000$BQUFBQUFBQUFBQUFBQUFBQ==$sShNSD5hTZ7wlcCDnnyH/qIsI8vPhtDiI+LVb4BDXEY=';
    const syntheticPepper = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
    expect((await verifyPassword('Synthetic-Vector-Pass_0123456789', generated, syntheticPepper)).ok).toBe(true);
    expect((await verifyPassword('different', generated, syntheticPepper)).ok).toBe(false);
  });
  it('Node-produced PBKDF2 hash verifies in the actual Workers implementation',async()=>{
    expect((await verifyPassword(password,stored,pepper)).ok).toBe(true);
    expect((await verifyPassword(password,stored,'wrong-pepper')).ok).toBe(false);
    expect((await verifyPassword('wrong-password',stored,pepper)).ok).toBe(false);
  });
});
