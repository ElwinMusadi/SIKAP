import { describe, expect, it } from 'vitest';
import { verifyPassword } from '../server/lib/crypto';

// Fixed SYNTHETIC vector generated with Node's crypto implementation, not production
// data. This bridges the offline transform algorithm and the actual Workers verifier.
// Regenerate only if intentionally versioning the migration password protocol.
const pepper = 'synthetic-migration-pepper-not-a-real-secret';
const password = '022002';

const stored = 'legacy-wrap$10000$ABEiM0RVZneImaq7zN3u/w==$/BLCdHRxzLhD2LYVLmUxLYtzOe9R0VomMgRrq/IExPc=';

describe('offline GAS migration password interoperability', () => {
  it('accepts a Node-produced legacy-wrap hash with the matching pepper', async () => {
    expect(await verifyPassword(password, stored, pepper)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword('not-the-password', stored, pepper)).ok).toBe(false);
    expect((await verifyPassword(password, stored, 'different-pepper')).ok).toBe(false);
  });
});
