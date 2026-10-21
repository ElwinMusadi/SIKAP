import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PREVIEW, PRODUCTION, assertConfigSafe, prepareRelease, renderConfig } from './pages-release.mjs';

// Fictitious ID for tests only; the real one lives in the GitHub secret PROD_D1_DATABASE_ID.
const FAKE_ID = '00000000-1111-4222-8333-444444444444';
const temps = [];
async function temp(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

describe('renderConfig', () => {
  it('binds production to the cutover D1 and R2 and keeps the preview bindings', () => {
    const text = renderConfig(FAKE_ID);
    assert.match(text, /\[env\.production\.vars\]\nAPP_URL = "https:\/\/sikap\.uptdpenda-kupang\.web\.id"/);
    assert.ok(text.includes(`database_name = "${PRODUCTION.d1Name}"\ndatabase_id = "${FAKE_ID}"`));
    assert.ok(text.includes(`bucket_name = "${PRODUCTION.r2Bucket}"`));
    assert.ok(text.includes(`database_id = "${PREVIEW.d1Id}"`));
    assert.ok(!text.includes('ACCESS_'), 'custom domain must not require Access');
    assert.ok(!text.includes('"sikap-db"') && !text.includes('"sikap-files"'), 'no historical bindings');
  });

  it('rejects missing, malformed, preview and historical database IDs', () => {
    for (const bad of [undefined, '', 'not-a-uuid', PREVIEW.d1Id, 'b8611b82-8067-4153-ae5e-d6a0b94be7a6']) {
      assert.throws(() => renderConfig(bad), /PROD_D1_DATABASE_ID_(INVALID|DENIED)/);
    }
  });

  it('the independent check refuses tampered configs', () => {
    const good = renderConfig(FAKE_ID);
    assert.throws(() => assertConfigSafe(good.replace(PRODUCTION.d1Name, 'sikap-db'), FAKE_ID), /RELEASE_CONFIG/);
    assert.throws(() => assertConfigSafe(`${good}ACCESS_REQUIRED = "1"\n`, FAKE_ID), /RELEASE_CONFIG_DENIED_REF/);
    assert.throws(() => assertConfigSafe(`${good}[[r2_buckets]]\nbinding = "BACKUPS"\nbucket_name = "x"\n`, FAKE_ID), /RELEASE_CONFIG/);
  });
});

describe('prepareRelease', () => {
  async function fakeRepo() {
    const root = await temp('sikap-repo-');
    await mkdir(path.join(root, 'dist', 'assets'), { recursive: true });
    await writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html>');
    for (const dir of ['functions/api', 'server', 'shared', 'node_modules/wrangler']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'functions/api/[[route]].ts'), 'export {}');
    await writeFile(path.join(root, 'package.json'), '{}');
    await writeFile(path.join(root, 'tsconfig.json'), '{}');
    await writeFile(path.join(root, 'tsconfig.server.json'), '{}');
    await writeFile(path.join(root, 'wrangler.toml'), '# root config with historical bindings');
    return root;
  }

  it('assembles public/, Functions sources, tsconfigs, a node_modules link and the generated config', async () => {
    const root = await fakeRepo();
    const out = path.join(await temp('sikap-out-'), 'release');
    await prepareRelease({ root, outDir: out, prodD1Id: FAKE_ID });
    assert.equal(await readFile(path.join(out, 'public', 'index.html'), 'utf8'), '<!doctype html>');
    for (const entry of ['functions/api/[[route]].ts', 'server', 'shared', 'package.json', 'tsconfig.json', 'tsconfig.server.json']) {
      await lstat(path.join(out, entry));
    }
    assert.ok((await lstat(path.join(out, 'node_modules'))).isSymbolicLink());
    assert.equal(await readFile(path.join(out, 'wrangler.toml'), 'utf8'), renderConfig(FAKE_ID));
  });

  it('refuses a release directory inside the checkout, a relative path, or a missing build', async () => {
    const root = await fakeRepo();
    await assert.rejects(prepareRelease({ root, outDir: path.join(root, '.release'), prodD1Id: FAKE_ID }), /RELEASE_DIR_INSIDE_CHECKOUT/);
    await assert.rejects(prepareRelease({ root, outDir: 'release', prodD1Id: FAKE_ID }), /RELEASE_DIR_NOT_ABSOLUTE/);
    await rm(path.join(root, 'dist'), { recursive: true });
    await assert.rejects(prepareRelease({ root, outDir: path.join(await temp('sikap-out-'), 'r'), prodD1Id: FAKE_ID }), /BUILD_OUTPUT_MISSING/);
  });

  it('refuses a non-empty release directory and an ancestor wrangler config', async () => {
    const root = await fakeRepo();
    const busy = await temp('sikap-out-');
    await writeFile(path.join(busy, 'leftover.txt'), 'x');
    await assert.rejects(prepareRelease({ root, outDir: busy, prodD1Id: FAKE_ID }), /RELEASE_DIR_NOT_EMPTY/);
    const parent = await temp('sikap-out-');
    await writeFile(path.join(parent, 'wrangler.toml'), '');
    await assert.rejects(prepareRelease({ root, outDir: path.join(parent, 'release'), prodD1Id: FAKE_ID }), /RELEASE_DIR_ANCESTOR_CONFIG/);
  });
});
