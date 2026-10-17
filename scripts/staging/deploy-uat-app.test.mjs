import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink, appendFile, stat, utimes, realpath, lstat } from 'node:fs/promises';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  createUatRelease, prepareUatRelease, deployUatApp, verifyAppTarget, verifyUatRelease, renderReleaseConfig, defaultTmpRoot,
  assertNoAncestorConfig, sweepStaleIsolatedDirs,
  DEPLOY_ARGS, DENIED_REFS, MAX_ASSET_BYTES, RELEASE_CONFIG_SHA, RELEASE_PREFIX, HOLDING_RELEASE_PREFIX, PREFLIGHT_PREFIX,
  ISOLATED_PREFIXES, STALE_AFTER_MS,
} from './deploy-uat-app.mjs';
import { UAT_ACCOUNT, UAT_DB } from './deploy-holding.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const ENV = { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT };
const isInside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

async function scratch(t, name) {
  const dir = await mkdtemp(path.join(defaultTmpRoot(), name));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t) {
  const dir = await scratch(t, 'uat-app-fixture-');
  await mkdir(path.join(dir, 'ops/uat-app'), { recursive: true });
  await copyFile(path.join(root, 'ops/uat-app/wrangler.toml'), path.join(dir, 'ops/uat-app/wrangler.toml'));
  const out = path.join(dir, 'dist-uat-app');
  await mkdir(path.join(out, 'assets/nested'), { recursive: true });
  await writeFile(path.join(out, '_worker.js'), 'const M="SIKAP_UAT_ALL_ROUTES_V1";export default{fetch(){return new Response(M)}}');
  await writeFile(path.join(out, '_routes.json'), JSON.stringify({ version: 1, include: ['/*'], exclude: [] }));
  await writeFile(path.join(out, 'index.html'), '<!doctype html><title>uat</title>');
  await writeFile(path.join(out, 'assets/nested/app.js'), 'console.log(1)');
  return { dir, out, tmpRoot: await scratch(t, 'uat-app-release-root-') };
}
const listing = (d) => readdirSync(d);

test('release is outside repo, has no ancestor wrangler config, renders only path lines', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  const rel = await createUatRelease({ base: dir, env: ENV, tmpRoot });
  try {
    assert.ok(!isInside(root, rel.releasePath), 'release must be outside repo');
    assert.ok(!isInside(path.join(root, 'ops'), rel.releasePath));
    assert.ok(path.basename(rel.releasePath).startsWith(RELEASE_PREFIX));
    for (let d = path.dirname(rel.releasePath); ; d = path.dirname(d)) {
      for (const n of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) assert.ok(!existsSync(path.join(d, n)), `ancestor ${d}`);
      if (path.dirname(d) === d) break;
    }
    const cfg = await readFile(rel.configPath, 'utf8');
    assert.equal(sha(cfg), RELEASE_CONFIG_SHA);
    assert.ok(cfg.includes('pages_build_output_dir = "./public"'));
    assert.ok(!cfg.includes('migrations_dir') && !cfg.includes('..') && !cfg.includes('[env'));
    assert.ok(cfg.includes(`database_id = "${UAT_DB}"`) && cfg.includes('ACCESS_REQUIRED = "1"'));
    assert.ok(cfg.includes('shy-thunder-ffc9.cloudflareaccess.com') && cfg.includes('50b2c68c92474c0232581b9641f9107836ca66939e439e2314f37384f4f2b3e9'));
    for (const r of DENIED_REFS) assert.ok(!cfg.includes(r));
    const src = readFileSync(path.join(root, 'ops/uat-app/wrangler.toml'), 'utf8').replaceAll('\r\n', '\n').split('\n');
    const kept = src.filter((l) => !l.startsWith('pages_build_output_dir') && !l.startsWith('migrations_dir'));
    assert.deepEqual(cfg.split('\n').filter((l) => !l.startsWith('pages_build_output_dir')), kept, 'resources/vars untouched');
    assert.deepEqual(listing(rel.releasePath).sort(), ['public', 'wrangler.toml']);
    assert.equal(await readFile(path.join(rel.publicPath, 'assets/nested/app.js'), 'utf8'), 'console.log(1)');
    assert.equal(prepareUatRelease, createUatRelease);
  } finally { await rel.cleanup(); }
  assert.ok(!existsSync(rel.releasePath));
  assert.deepEqual(listing(tmpRoot), []);
  await rel.cleanup();
});

test('deploy spawns pinned wrangler in release cwd with exact args and scoped env, then cleans up', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  const env = { ...ENV, CLOUDFLARE_ENV: 'production', WRANGLER_SEND_METRICS: 'true', HTTPS_PROXY: 'http://invalid.test',
    WRANGLER_CONFIG: path.join(root, 'wrangler.toml'), PATH: 'test-path', CLOUDFLARE_API_TOKEN: 'tok' };
  let calls = 0; let seen;
  await deployUatApp({ base: dir, env, tmpRoot, spawn(bin, args, opts) {
    calls++;
    assert.equal(bin, process.execPath);
    assert.deepEqual(args, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...DEPLOY_ARGS]);
    assert.ok(!args.includes('--no-bundle') && !args.some((a) => a.startsWith('--config') || a.startsWith('--env')));
    assert.notEqual(opts.cwd, path.join(root, 'ops/uat-app'));
    assert.ok(!isInside(root, opts.cwd) && isInside(tmpRoot, opts.cwd));
    assert.equal(opts.shell, false);
    assert.deepEqual(Object.keys(opts.env).sort(), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'PATH']);
    assert.equal(opts.env.CLOUDFLARE_ACCOUNT_ID, UAT_ACCOUNT);
    const cfg = readFileSync(path.join(opts.cwd, 'wrangler.toml'), 'utf8');
    assert.equal(sha(cfg), RELEASE_CONFIG_SHA);
    assert.ok(readFileSync(path.join(opts.cwd, 'public/_worker.js'), 'utf8').includes('SIKAP_UAT_ALL_ROUTES_V1'));
    assert.deepEqual(JSON.parse(readFileSync(path.join(opts.cwd, 'public/_routes.json'), 'utf8')).include, ['/*']);
    seen = opts.cwd;
    return { status: 0 };
  } });
  assert.equal(calls, 1);
  assert.ok(!existsSync(seen));
  assert.deepEqual(listing(tmpRoot), []);
});

test('failed deploy still removes only the release dir', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  const sentinel = path.join(tmpRoot, 'keep.txt');
  await writeFile(sentinel, 'x');
  await assert.rejects(deployUatApp({ base: dir, env: ENV, tmpRoot, spawn: () => ({ status: 1 }) }), /UAT_DEPLOY_FAILED/);
  assert.deepEqual(listing(tmpRoot), ['keep.txt']);
  assert.ok(existsSync(path.join(dir, 'dist-uat-app/_worker.js')), 'source untouched');
});

test('account, source config tamper, routes, marker refused before any spawn', async (t) => {
  const { dir, out, tmpRoot } = await fixture(t);
  const never = () => assert.fail('no spawn');
  for (const env of [{}, { CLOUDFLARE_ACCOUNT_ID: 'wrong' }]) {
    await assert.rejects(deployUatApp({ base: dir, env, tmpRoot, spawn: never }), /UAT_ACCOUNT_REQUIRED/);
  }
  await appendFile(path.join(dir, 'ops/uat-app/wrangler.toml'), '\n[env.production.vars]\nX="1"\n');
  await assert.rejects(deployUatApp({ base: dir, env: ENV, tmpRoot, spawn: never }), /UAT_CONFIG_MISMATCH/);
  await copyFile(path.join(root, 'ops/uat-app/wrangler.toml'), path.join(dir, 'ops/uat-app/wrangler.toml'));
  await writeFile(path.join(out, '_routes.json'), JSON.stringify({ include: ['/api/*'], exclude: [] }));
  await assert.rejects(deployUatApp({ base: dir, env: ENV, tmpRoot, spawn: never }), /UAT_ALL_ROUTES_REQUIRED/);
  await writeFile(path.join(out, '_routes.json'), JSON.stringify({ include: ['/*'], exclude: [] }));
  await writeFile(path.join(out, '_worker.js'), 'export default {}');
  await assert.rejects(deployUatApp({ base: dir, env: ENV, tmpRoot, spawn: never }), /UAT_ENTRY_REQUIRED/);
  assert.deepEqual(listing(tmpRoot), []);
});

test('renderReleaseConfig rejects any drift from pinned source text', () => {
  const src = readFileSync(path.join(root, 'ops/uat-app/wrangler.toml'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(sha(renderReleaseConfig(src)), RELEASE_CONFIG_SHA);
  for (const bad of [src.replace(UAT_DB, DENIED_REFS[0]), src.replace('sikap-uat-files', 'sikap-files'),
    src.replace('migrations_dir = "../../migrations"\n', ''), `${src}\n[env.production]\n`, src.replace('ACCESS_REQUIRED = "1"', 'ACCESS_REQUIRED = "0"')]) {
    assert.throws(() => renderReleaseConfig(bad), /UAT_(CONFIG_MISMATCH|RELEASE_CONFIG_INVALID)/);
  }
});

test('sha256 ledger binds copied bytes; extra, altered, missing release files refused', async (t) => {
  const { dir, out, tmpRoot } = await fixture(t);
  const rel = await createUatRelease({ base: dir, env: ENV, tmpRoot });
  try {
    assert.deepEqual(Object.keys(rel.fileDigests).sort(), ['_routes.json', '_worker.js', 'assets/nested/app.js', 'index.html']);
    for (const [k, h] of Object.entries(rel.fileDigests)) {
      assert.equal(h, sha(readFileSync(path.join(out, k))), `source ${k}`);
      assert.equal(h, sha(readFileSync(path.join(rel.publicPath, k))), `release ${k}`);
    }
    assert.ok(Object.isFrozen(rel.fileDigests));
    await verifyUatRelease(rel);
    const extra = path.join(rel.publicPath, 'assets/nested/extra.js');
    await writeFile(extra, 'x');
    await assert.rejects(verifyUatRelease(rel), /UAT_RELEASE_EXTRA_ENTRY/);
    await rm(extra);
    await writeFile(path.join(rel.releasePath, '.dev.vars'), 'S=1');
    await assert.rejects(verifyUatRelease(rel), /UAT_RELEASE_EXTRA_ENTRY/);
    await rm(path.join(rel.releasePath, '.dev.vars'));
    const app = path.join(rel.publicPath, 'assets/nested/app.js');
    await writeFile(app, 'console.log(2)');
    await assert.rejects(verifyUatRelease(rel), /UAT_RELEASE_TAMPERED/);
    await rm(app);
    await assert.rejects(verifyUatRelease(rel), /UAT_RELEASE_MISSING_ENTRY/);
    await writeFile(app, 'console.log(1)');
    await appendFile(rel.configPath, '\n');
    await assert.rejects(verifyUatRelease(rel), /UAT_RELEASE_TAMPERED/);
  } finally { await rel.cleanup(); }
  assert.deepEqual(listing(tmpRoot), []);
});

test('root DB refs in bundle bytes refused and release removed', async (t) => {
  const { dir, out, tmpRoot } = await fixture(t);
  for (const ref of DENIED_REFS) {
    await writeFile(path.join(out, 'assets/leak.js'), `const id="${ref.toUpperCase()}"`);
    await assert.rejects(createUatRelease({ base: dir, env: ENV, tmpRoot }), /UAT_RELEASE_DENIED_REF/);
    assert.deepEqual(listing(tmpRoot), []);
  }
});

test('links, hidden entries, oversize assets refused before copy', async (t) => {
  const { dir, out, tmpRoot } = await fixture(t);
  const target = await scratch(t, 'uat-app-link-target-');
  await writeFile(path.join(target, 'secret.txt'), 'x');
  await symlink(target, path.join(out, 'assets/linked'), 'junction');
  await assert.rejects(createUatRelease({ base: dir, env: ENV, tmpRoot }), /UAT_OUTPUT_LINK/);
  assert.deepEqual(listing(tmpRoot), []);
  await rm(path.join(out, 'assets/linked'));
  await writeFile(path.join(out, '.dev.vars'), 'SECRET=1');
  await assert.rejects(createUatRelease({ base: dir, env: ENV, tmpRoot }), /UAT_OUTPUT_HIDDEN_ENTRY/);
  await rm(path.join(out, '.dev.vars'));
  await writeFile(path.join(out, 'assets/big.bin'), Buffer.alloc(MAX_ASSET_BYTES + 1));
  await assert.rejects(createUatRelease({ base: dir, env: ENV, tmpRoot }), /UAT_OUTPUT_TOO_LARGE/);
  assert.deepEqual(listing(tmpRoot), []);
});

test('tmp root inside repo or under ancestor wrangler config refused without creating anything', async (t) => {
  const { dir } = await fixture(t);
  const before = listing(path.join(root, 'scripts'));
  await assert.rejects(createUatRelease({ base: dir, env: ENV, tmpRoot: path.join(root, 'scripts') }), /UAT_RELEASE_INSIDE_REPO/);
  assert.deepEqual(listing(path.join(root, 'scripts')), before);
  const parent = await scratch(t, 'uat-app-ancestor-');
  await writeFile(path.join(parent, 'wrangler.toml'), 'name="sikap"\n');
  await mkdir(path.join(parent, 'child'));
  await assert.rejects(createUatRelease({ base: dir, env: ENV, tmpRoot: path.join(parent, 'child') }), /UAT_RELEASE_ANCESTOR_CONFIG/);
  assert.deepEqual(listing(path.join(parent, 'child')), []);
});

test('ancestor .wrangler/deploy/config.json redirect (and json/jsonc configs) refused without creating anything', async (t) => {
  const { dir } = await fixture(t);
  const clean = await realpath(await scratch(t, 'uat-app-clean-'));
  await assertNoAncestorConfig(clean);
  const parent = await realpath(await scratch(t, 'uat-app-redirect-'));
  await mkdir(path.join(parent, '.wrangler/deploy'), { recursive: true });
  await writeFile(path.join(parent, '.wrangler/deploy/config.json'), JSON.stringify({ configPath: '../../wrangler.toml' }));
  const child = path.join(parent, 'a', 'b');
  await mkdir(child, { recursive: true });
  await assert.rejects(assertNoAncestorConfig(parent), /UAT_RELEASE_ANCESTOR_CONFIG/);
  await assert.rejects(assertNoAncestorConfig(child), /UAT_RELEASE_ANCESTOR_CONFIG/);
  await assert.rejects(createUatRelease({ base: dir, env: ENV, tmpRoot: child }), /UAT_RELEASE_ANCESTOR_CONFIG/);
  assert.deepEqual(listing(child), []);
  // A plain `.wrangler` file (ENOTDIR on lookup) is not a redirect.
  const notDir = await realpath(await scratch(t, 'uat-app-notdir-'));
  await writeFile(path.join(notDir, '.wrangler'), 'x');
  await assertNoAncestorConfig(notDir);
  for (const name of ['wrangler.json', 'wrangler.jsonc']) {
    const p = await realpath(await scratch(t, 'uat-app-cfg-'));
    await writeFile(path.join(p, name), '{}');
    await mkdir(path.join(p, 'c'));
    await assert.rejects(assertNoAncestorConfig(path.join(p, 'c')), /UAT_RELEASE_ANCESTOR_CONFIG/, name);
  }
});

const SUFFIX = 'aB3xY9';
async function age(p, ms) { const t = new Date(Date.now() - ms); await utimes(p, t, t); }

test('stale sweep removes only old exact prefix+6-char dirs; fresh, unrelated, files and links preserved', async (t) => {
  assert.deepEqual([...ISOLATED_PREFIXES].sort(), [HOLDING_RELEASE_PREFIX, PREFLIGHT_PREFIX, RELEASE_PREFIX].sort());
  const parent = await realpath(await scratch(t, 'uat-app-sweep-'));
  const old = STALE_AFTER_MS + 60 * 60 * 1000;
  const oldDirs = ISOLATED_PREFIXES.map((p) => `${p}${SUFFIX}`);
  for (const n of oldDirs) {
    await mkdir(path.join(parent, n, 'public'), { recursive: true });
    await writeFile(path.join(parent, n, 'public', 'f.txt'), 'x');
    await age(path.join(parent, n), old);
  }
  const fresh = ISOLATED_PREFIXES.map((p) => `${p}Fr35h0`);
  for (const n of fresh) await mkdir(path.join(parent, n));
  const unrelated = [`${RELEASE_PREFIX}abc`, `${RELEASE_PREFIX}abcdefg`, `${RELEASE_PREFIX}ab_cde`, `x${RELEASE_PREFIX}abcdef`,
    'sikap-uat-other-abcdef', 'uat-app-fixture-abcdef', `${PREFLIGHT_PREFIX}`];
  for (const n of unrelated) { await mkdir(path.join(parent, n)); await age(path.join(parent, n), old); }
  const fileNamed = `${HOLDING_RELEASE_PREFIX}F1leXX`;
  await writeFile(path.join(parent, fileNamed), 'keep');
  await age(path.join(parent, fileNamed), old);
  // Link named like a stale isolated dir pointing at an old real dir with content: link and target both survive.
  const target = await realpath(await scratch(t, 'uat-app-sweep-target-'));
  await writeFile(path.join(target, 'secret.txt'), 'keep');
  await age(target, old);
  const linkName = `${RELEASE_PREFIX}L1nkZZ`;
  let linked = true;
  try { await symlink(target, path.join(parent, linkName), 'junction'); } catch { linked = false; }

  const removed = await sweepStaleIsolatedDirs(parent);
  assert.deepEqual(removed.sort(), [...oldDirs].sort());
  for (const n of oldDirs) assert.ok(!existsSync(path.join(parent, n)), n);
  for (const n of [...fresh, ...unrelated, fileNamed]) assert.ok(existsSync(path.join(parent, n)), n);
  assert.equal(readFileSync(path.join(target, 'secret.txt'), 'utf8'), 'keep');
  if (linked) assert.ok((await lstat(path.join(parent, linkName))).isSymbolicLink(), 'link left in place');
  else t.diagnostic('directory links unsupported; link case not exercised');

  // Boundary: maxAgeMs is strict (> not >=); a far-future `now` sweeps the fresh ones too.
  assert.deepEqual(await sweepStaleIsolatedDirs(parent), []);
  const later = await sweepStaleIsolatedDirs(parent, { now: Date.now() + STALE_AFTER_MS + 60_000 });
  assert.deepEqual(later.sort(), [...fresh].sort());
  for (const n of unrelated) assert.ok(existsSync(path.join(parent, n)), n);
  if (linked) assert.ok((await lstat(path.join(parent, linkName))).isSymbolicLink());
  assert.equal(readFileSync(path.join(target, 'secret.txt'), 'utf8'), 'keep');
  // Missing parent never throws.
  assert.deepEqual(await sweepStaleIsolatedDirs(path.join(parent, 'missing')), []);
});

test('release creation sweeps stale isolated dirs in its tmp root and keeps fresh/unrelated entries', async (t) => {
  const { dir } = await fixture(t);
  const tmpRoot = await realpath(await scratch(t, 'uat-app-sweep-root-'));
  const stale = `${PREFLIGHT_PREFIX}${SUFFIX}`;
  const freshName = `${HOLDING_RELEASE_PREFIX}${SUFFIX}`;
  await mkdir(path.join(tmpRoot, stale));
  await age(path.join(tmpRoot, stale), STALE_AFTER_MS + 60_000);
  await mkdir(path.join(tmpRoot, freshName));
  await writeFile(path.join(tmpRoot, 'keep.txt'), 'x');
  const rel = await createUatRelease({ base: dir, env: ENV, tmpRoot });
  try {
    assert.ok(!existsSync(path.join(tmpRoot, stale)));
    assert.deepEqual(listing(tmpRoot).filter((n) => n !== path.basename(rel.releasePath)).sort(), [freshName, 'keep.txt'].sort());
  } finally { await rel.cleanup(); }
  assert.deepEqual(listing(tmpRoot).sort(), [freshName, 'keep.txt'].sort());
});

test('real repo source passes when built bundle present', { skip: !existsSync(path.join(root, 'dist-uat-app/_worker.js')) }, async (t) => {
  await verifyAppTarget(root, ENV);
  const tmpRoot = await scratch(t, 'uat-app-real-');
  const rel = await createUatRelease({ env: ENV, tmpRoot });
  try { assert.equal(sha(await readFile(rel.configPath, 'utf8')), RELEASE_CONFIG_SHA); assert.ok((await stat(rel.publicPath)).isDirectory()); }
  finally { await rel.cleanup(); }
});

test('CLI refuses any caller argument without acting', () => {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'deploy-uat-app.mjs'), '--env', 'production'],
    { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /UAT_DEPLOY_NO_ARGUMENTS/);
});
