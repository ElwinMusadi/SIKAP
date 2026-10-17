import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  deployHolding, verifyHoldingTarget, createHoldingRelease, verifyHoldingRelease, renderHoldingConfig,
  HOLDING_DEPLOY_ARGS, HOLDING_RELEASE_CONFIG_SHA, HOLDING_WORKER_SHA, UAT_ACCOUNT, UAT_DB,
} from './deploy-holding.mjs';
import { defaultTmpRoot, HOLDING_RELEASE_PREFIX } from './deploy-uat-app.mjs';
import * as constants from './uat-constants.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const isInside = (parent, child) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const WRANGLER = path.join(root, 'node_modules/wrangler/bin/wrangler.js');

async function scratch(t, name) {
  const dir = await mkdtemp(path.join(defaultTmpRoot(), name));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture(t) {
  const dir = await scratch(t, 'uat-holding-test-');
  await mkdir(path.join(dir, 'ops/uat'), { recursive: true });
  await mkdir(path.join(dir, 'dist-uat'));
  await copyFile(path.join(root, 'ops/uat/wrangler.toml'), path.join(dir, 'ops/uat/wrangler.toml'));
  await copyFile(path.join(root, 'ops/uat/holding-worker.mjs'), path.join(dir, 'ops/uat/holding-worker.mjs'));
  await copyFile(path.join(root, 'ops/uat/holding-worker.mjs'), path.join(dir, 'dist-uat/_worker.js'));
  return { dir, tmpRoot: await scratch(t, 'uat-holding-release-root-') };
}

test('re-exports pinned UAT identifiers for existing consumers', () => {
  assert.equal(UAT_ACCOUNT, constants.UAT_ACCOUNT);
  assert.equal(UAT_DB, constants.UAT_DB);
});

test('holding deploy refuses missing or different account before invoking any command', async () => {
  for (const env of [{}, { CLOUDFLARE_ACCOUNT_ID: 'wrong' }]) {
    await assert.rejects(deployHolding({ env, spawn() { assert.fail('no remote command permitted'); } }), /UAT_ACCOUNT_REQUIRED/);
  }
});

test('release is isolated outside repo with exact public/_worker.js and pinned rendered config', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  const rel = await createHoldingRelease({ base: dir, env: { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT }, tmpRoot });
  try {
    assert.ok(!isInside(root, rel.releasePath) && !isInside(dir, rel.releasePath) && isInside(tmpRoot, rel.releasePath));
    assert.ok(path.basename(rel.releasePath).startsWith(HOLDING_RELEASE_PREFIX));
    assert.deepEqual(readdirSync(rel.releasePath).sort(), ['public', 'wrangler.toml']);
    assert.deepEqual(readdirSync(rel.publicPath), ['_worker.js']);
    assert.equal(sha((await readFile(path.join(rel.publicPath, '_worker.js'), 'utf8')).replaceAll('\r\n', '\n')), HOLDING_WORKER_SHA);
    const cfg = await readFile(rel.configPath, 'utf8');
    assert.equal(sha(cfg), HOLDING_RELEASE_CONFIG_SHA);
    assert.ok(cfg.includes('pages_build_output_dir = "./public"'));
    assert.ok(!cfg.includes('migrations_dir') && !cfg.includes('..') && !cfg.includes('[env'));
    assert.ok(cfg.includes(`database_id = "${UAT_DB}"`) && cfg.includes('name = "sikap-uat"'));
    const src = readFileSync(path.join(root, 'ops/uat/wrangler.toml'), 'utf8').replaceAll('\r\n', '\n').split('\n');
    const kept = src.filter((l) => !l.startsWith('pages_build_output_dir') && !l.startsWith('migrations_dir'));
    assert.deepEqual(cfg.split('\n').filter((l) => !l.startsWith('pages_build_output_dir')), kept, 'resources/vars untouched');
    await verifyHoldingRelease(rel);
  } finally { await rel.cleanup(); }
  assert.ok(!existsSync(rel.releasePath));
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test('deploy spawns pinned wrangler with exact args, isolated cwd and scoped env, then cleans up', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  const env = { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT, CLOUDFLARE_ENV: 'production', WRANGLER_SEND_METRICS: 'true',
    HTTPS_PROXY: 'http://invalid.test', WRANGLER_CONFIG: path.join(root, 'wrangler.toml'), CLOUDFLARE_API_BASE_URL: 'http://evil.test',
    PATH: 'test-path', CLOUDFLARE_API_TOKEN: 'tok' };
  let calls = 0; let cwd;
  await deployHolding({ base: dir, env, tmpRoot, spawn(bin, args, opts) {
    calls++; cwd = opts.cwd;
    assert.equal(bin, process.execPath);
    assert.deepEqual(args, [WRANGLER, 'pages', 'deploy', 'public', '--project-name', 'sikap-uat', '--branch', 'uat', '--commit-dirty=true']);
    assert.deepEqual(args.slice(1), [...HOLDING_DEPLOY_ARGS]);
    assert.ok(!isInside(root, opts.cwd) && !isInside(dir, opts.cwd) && isInside(tmpRoot, opts.cwd));
    assert.notEqual(opts.cwd, path.join(dir, 'ops/uat'));
    assert.equal(opts.shell, false);
    assert.deepEqual(opts.env, { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT, PATH: 'test-path', CLOUDFLARE_API_TOKEN: 'tok' });
    assert.deepEqual(readdirSync(opts.cwd).sort(), ['public', 'wrangler.toml']);
    assert.deepEqual(readdirSync(path.join(opts.cwd, 'public')), ['_worker.js']);
    assert.equal(sha(readFileSync(path.join(opts.cwd, 'wrangler.toml'), 'utf8')), HOLDING_RELEASE_CONFIG_SHA);
    return { status: 0 };
  } });
  assert.equal(calls, 1);
  assert.ok(!existsSync(cwd));
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test('hostile env account is overridden and failure still cleans up', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  let cwd;
  await assert.rejects(deployHolding({ base: dir, env: { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT, cloudflare_account_id: 'other' }, tmpRoot,
    spawn(_b, _a, opts) {
      cwd = opts.cwd;
      assert.deepEqual(opts.env, { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT });
      return { status: 1 };
    } }), /UAT_DEPLOY_FAILED/);
  assert.ok(cwd && !existsSync(cwd));
  await assert.rejects(deployHolding({ base: dir, env: { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT }, tmpRoot,
    spawn() { return { error: Error('spawn'), status: null }; } }), /UAT_DEPLOY_FAILED/);
  await assert.rejects(deployHolding({ base: dir, env: { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT }, tmpRoot,
    spawn() { throw Error('boom'); } }), /boom/);
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test('tampered release refuses before spawn and is removed', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  const rel = await createHoldingRelease({ base: dir, env: { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT }, tmpRoot });
  try {
    await writeFile(path.join(rel.publicPath, 'index.html'), 'x');
    await assert.rejects(verifyHoldingRelease(rel), /UAT_RELEASE_EXTRA_ENTRY/);
    await rm(path.join(rel.publicPath, 'index.html'));
    await writeFile(path.join(rel.publicPath, '_worker.js'), 'export default {}');
    await assert.rejects(verifyHoldingRelease(rel), /UAT_RELEASE_TAMPERED/);
    await copyFile(path.join(root, 'ops/uat/holding-worker.mjs'), path.join(rel.publicPath, '_worker.js'));
    await writeFile(rel.configPath, 'name = "sikap-uat"\n');
    await assert.rejects(verifyHoldingRelease(rel), /UAT_RELEASE_TAMPERED/);
    await assert.rejects(verifyHoldingRelease({ ...rel, fileDigests: { '_worker.js': 'x', 'index.html': 'y' } }), /UAT_HOLDING_ONLY/);
  } finally { await rel.cleanup(); }
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test('only the reviewed holding bundle and UAT config may deploy', async (t) => {
  const { dir, tmpRoot } = await fixture(t);
  const env = { CLOUDFLARE_ACCOUNT_ID: UAT_ACCOUNT };
  const noSpawn = () => assert.fail('no remote command permitted');
  await writeFile(path.join(dir, 'dist-uat/index.html'), 'must not be public');
  await assert.rejects(verifyHoldingTarget(dir, env), /UAT_HOLDING_ONLY/);
  await assert.rejects(deployHolding({ base: dir, env, tmpRoot, spawn: noSpawn }), /UAT_HOLDING_ONLY/);
  await rm(path.join(dir, 'dist-uat/index.html'));
  await writeFile(path.join(dir, 'dist-uat/_worker.js'), 'export default {fetch(){return new Response("public")}}');
  await assert.rejects(deployHolding({ base: dir, env, tmpRoot, spawn: noSpawn }), /UAT_HOLDING_MISMATCH/);
  await copyFile(path.join(root, 'ops/uat/holding-worker.mjs'), path.join(dir, 'dist-uat/_worker.js'));
  await writeFile(path.join(dir, 'ops/uat/wrangler.toml'), 'name="sikap-uat"\n');
  await assert.rejects(deployHolding({ base: dir, env, tmpRoot, spawn: noSpawn }), /UAT_CONFIG_MISMATCH/);
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test('rendered config is pinned; any other rendering is refused', () => {
  const src = readFileSync(path.join(root, 'ops/uat/wrangler.toml'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(sha(renderHoldingConfig(src)), HOLDING_RELEASE_CONFIG_SHA);
  assert.throws(() => renderHoldingConfig(src.replace('sikap-uat-files', 'sikap-files')), /UAT_RELEASE_CONFIG_INVALID/);
  assert.throws(() => renderHoldingConfig(src.replace('pages_build_output_dir = "../../dist-uat"', 'pages_build_output_dir = "../../dist"')), /UAT_CONFIG_MISMATCH/);
  assert.throws(() => renderHoldingConfig(`${src}\n[env.production]\n`), /UAT_RELEASE_CONFIG_INVALID/);
});
