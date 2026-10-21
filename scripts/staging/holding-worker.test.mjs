import { test } from 'node:test';
import assert from 'node:assert/strict';
import holding from '../../ops/uat/holding-worker.mjs';

test('holding UAT denies every route and method without accessing bindings/assets', async () => {
  const bindings = new Proxy({}, { get() { assert.fail('Holding worker must not access any binding'); } });
  for (const p of ['/', '/login', '/api/auth/login', '/api/auth/me', '/api/health', '/api/admin/pegawai', '/api/documents/1/file', '/assets/app.js']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await holding.fetch(new Request(`https://sikap-uat.pages.dev${p}`, { method }), bindings);
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(r.headers.get('x-sikap-uat-state'), 'locked-holding');
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('location'), null);
      const text = await r.text();
      if (method === 'HEAD') assert.equal(text, '');
      else assert.ok(text.includes('UAT terkunci'));
    }
  }
});
