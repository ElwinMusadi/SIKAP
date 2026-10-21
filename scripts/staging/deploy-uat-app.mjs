// Controlled full-app UAT deploy. Deploys from a fresh temp release OUTSIDE the repo so Wrangler
// can never resolve the root wrangler.toml (observed: root bindings picked even with cwd=ops/uat-app).
// Accepts no caller flags or overrides.
// Also hosts the shared isolation helpers (fresh mkdtemp cwd outside the repo, ancestor-config
// refusal, stale-dir sweep, scoped child env) reused by deploy-holding.mjs and uat-remote-preflight.mjs.
// Wrangler 4 loads .env/.env.local from its cwd into process.env, so it must never run from the repo.
import { readFile, lstat, mkdtemp, mkdir, open, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UAT_ACCOUNT } from './uat-constants.mjs';
import { UAT_APP_DB, UAT_APP_DB_NAME, UAT_APP_FILES_BUCKET, UAT_APP_RETIRED_REFS } from './uat-app-constants.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WRANGLER_BIN = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const digest = (v) => createHash('sha256').update(v).digest('hex');
const fail = (code) => { throw Error(code); };
const DOMAIN = 'shy-thunder-ffc9.cloudflareaccess.com';
const AUD = '50b2c68c92474c0232581b9641f9107836ca66939e439e2314f37384f4f2b3e9';
// LF-normalized digests of ops/uat-app/wrangler.toml (rebound to the verified import target) and its rendered release copy.
export const SOURCE_CONFIG_SHA = '5cbefa7f6975b9e0aea1b7f890dab20a508c9b199896fb0eb0cb79c2946faa07';
export const RELEASE_CONFIG_SHA = 'c87c60ae24aa4024e9df6ac4987d698f4c0ba5987f1a95a7eb5f7ec52fe91aa6';
const SRC_OUTPUT_LINE = 'pages_build_output_dir = "../../dist-uat-app"';
const SRC_MIGRATIONS_LINE = 'migrations_dir = "../../migrations"';
const RELEASE_OUTPUT_LINE = 'pages_build_output_dir = "./public"';
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_COUNT = 20000;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Root (production/preview) D1 IDs; must never appear in any release byte.
export const DENIED_REFS = ['b8611b82-8067-4153-ae5e-d6a0b94be7a6', '1bd39313-4072-43a7-a183-7544c8264c46'];
export const RELEASE_PREFIX = 'sikap-uat-release-';
export const HOLDING_RELEASE_PREFIX = 'sikap-uat-holding-';
export const PREFLIGHT_PREFIX = 'sikap-uat-preflight-';
// Only these mkdtemp prefixes (plus mkdtemp's 6-char suffix) are ever swept as stale.
export const ISOLATED_PREFIXES = Object.freeze([RELEASE_PREFIX, HOLDING_RELEASE_PREFIX, PREFLIGHT_PREFIX]);
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const DEPLOY_ARGS = Object.freeze(['pages', 'deploy', 'public', '--project-name', 'sikap-uat', '--branch', 'uat']);
// Windows: pre-approved sandbox temp (tmpdir/kilo) when present; elsewhere (CI) os.tmpdir().
export function defaultTmpRoot() {
  const kilo = path.join(os.tmpdir(), 'kilo');
  if (process.platform === 'win32') try { if (lstatSync(kilo).isDirectory()) return kilo; } catch { /* fall through */ }
  return os.tmpdir();
}
// Wrangler finds these by walking up from its cwd; .wrangler/deploy/config.json is the redirect file.
const WRANGLER_CONFIGS = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc', path.join('.wrangler', 'deploy', 'config.json')];
const ALLOWED_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'CI', 'CLOUDFLARE_API_TOKEN']);

async function assertPlainFile(p, code) {
  const st = await lstat(p);
  if (!st.isFile() || st.isSymbolicLink()) fail(code);
  return st;
}
async function verifyBundle(dir) {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('UAT_OUTPUT_UNSAFE');
  for (const name of ['_worker.js', '_routes.json', 'index.html']) await assertPlainFile(path.join(dir, name), 'UAT_OUTPUT_UNSAFE');
  const routes = JSON.parse(await readFile(path.join(dir, '_routes.json'), 'utf8'));
  if (JSON.stringify(routes.include) !== '["/*"]' || JSON.stringify(routes.exclude) !== '[]') fail('UAT_ALL_ROUTES_REQUIRED');
  if (!(await readFile(path.join(dir, '_worker.js'), 'utf8')).includes('SIKAP_UAT_ALL_ROUTES_V1')) fail('UAT_ENTRY_REQUIRED');
}
// Exactly one DB (import target) + one FILES (import bucket) binding and one Access var set;
// no BACKUPS, retired UAT resources, [env.*] sections, or cron triggers. Independent of the digest.
const EXACT_ONCE = Object.freeze(['[[d1_databases]]', 'binding = "DB"', `database_name = "${UAT_APP_DB_NAME}"`,
  `database_id = "${UAT_APP_DB}"`, '[[r2_buckets]]', 'binding = "FILES"', `bucket_name = "${UAT_APP_FILES_BUCKET}"`,
  'ACCESS_REQUIRED = "1"', `ACCESS_TEAM_DOMAIN = "${DOMAIN}"`, `ACCESS_AUDIENCE = "${AUD}"`, 'name = "sikap-uat"']);
export function appBindingsValid(text) {
  if (typeof text !== 'string') return false;
  const lines = text.split('\n');
  const lower = text.toLowerCase();
  return EXACT_ONCE.every((l) => lines.filter((x) => x === l).length === 1) &&
    lines.filter((l) => /^\s*binding\s*=/.test(l)).length === 2 &&
    lines.filter((l) => /^\s*(database_id|database_name|bucket_name|preview_bucket_name|preview_database_id)\s*=/.test(l)).length === 3 &&
    lines.filter((l) => /^\s*ACCESS_/.test(l)).length === 3 &&
    !UAT_APP_RETIRED_REFS.some((r) => lower.includes(r.toLowerCase())) &&
    !lower.includes('[env') && !lower.includes('[triggers') && !lower.includes('crons');
}
export async function verifyAppTarget(base = root, env = process.env) {
  if (env.CLOUDFLARE_ACCOUNT_ID !== UAT_ACCOUNT) fail('UAT_ACCOUNT_REQUIRED');
  const config = path.join(base, 'ops/uat-app/wrangler.toml');
  await assertPlainFile(config, 'UAT_CONFIG_UNSAFE');
  const configText = (await readFile(config, 'utf8')).replaceAll('\r\n', '\n');
  if (digest(configText) !== SOURCE_CONFIG_SHA || !appBindingsValid(configText)) fail('UAT_CONFIG_MISMATCH');
  const output = path.join(base, 'dist-uat-app');
  await verifyBundle(output);
  return { config, configText, output };
}
// Rewrites only path lines; resources and vars stay byte-identical.
export function renderReleaseConfig(text) {
  const lines = text.split('\n');
  if (lines.filter((l) => l === SRC_OUTPUT_LINE).length !== 1 || lines.filter((l) => l === SRC_MIGRATIONS_LINE).length !== 1) fail('UAT_CONFIG_MISMATCH');
  const out = lines.filter((l) => l !== SRC_MIGRATIONS_LINE).map((l) => (l === SRC_OUTPUT_LINE ? RELEASE_OUTPUT_LINE : l)).join('\n');
  if (out.includes('..') || !appBindingsValid(out) ||
      DENIED_REFS.some((r) => out.toLowerCase().includes(r)) || /"sikap-(files|backup)/.test(out) || digest(out) !== RELEASE_CONFIG_SHA) fail('UAT_RELEASE_CONFIG_INVALID');
  return out;
}
const isInside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
export async function assertNoAncestorConfig(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    for (const n of WRANGLER_CONFIGS) {
      const found = await lstat(path.join(d, n)).then(() => true,
        (e) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? false : fail('UAT_RELEASE_ANCESTOR_UNCHECKED')));
      if (found) fail('UAT_RELEASE_ANCESTOR_CONFIG');
    }
    if (path.dirname(d) === d) return;
  }
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// mkdtemp appends exactly 6 alphanumeric characters; nothing else in the parent is ever touched.
const ISOLATED_NAME_RE = new RegExp(`^(?:${ISOLATED_PREFIXES.map(escapeRe).join('|')})[A-Za-z0-9]{6}$`);
// Best effort: removes only stale (mtime older than maxAgeMs) real directories directly in `parent`
// whose name is one of ISOLATED_PREFIXES + mkdtemp suffix. Links/junctions and files are skipped,
// and rm() never follows links inside a removed directory. Never throws.
export async function sweepStaleIsolatedDirs(parent, { now = Date.now(), maxAgeMs = STALE_AFTER_MS } = {}) {
  const removed = [];
  let names;
  try { names = await readdir(parent); } catch { return removed; }
  for (const name of names) {
    if (!ISOLATED_NAME_RE.test(name)) continue;
    const p = path.join(parent, name);
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink() || !st.isDirectory() || now - st.mtimeMs <= maxAgeMs) continue;
      if (await realpath(p) !== p || path.dirname(p) !== parent) continue;
      await rm(p, { recursive: true, force: true, maxRetries: 3 });
      removed.push(name);
    } catch { /* best effort */ }
  }
  return removed;
}
// Fresh, verified-empty mkdtemp directory outside every repo in `bases` (and the real repo root),
// with no ancestor Wrangler config/redirect. Used as Wrangler's cwd so it cannot pick up repo
// .env/.env.local files or configs. Caller MUST await cleanup(); it removes only that directory.
export async function createIsolatedDir({ prefix, tmpRoot = defaultTmpRoot(), bases = [] }) {
  if (!ISOLATED_PREFIXES.includes(prefix)) fail('UAT_RELEASE_PREFIX_INVALID');
  const tmp = await realpath(tmpRoot);
  for (const repo of new Set([root, ...bases])) {
    const real = await realpath(repo);
    if (isInside(real, tmp) || isInside(repo, tmp)) fail('UAT_RELEASE_INSIDE_REPO');
  }
  await assertNoAncestorConfig(tmp);
  await sweepStaleIsolatedDirs(tmp);
  const dir = await mkdtemp(path.join(tmp, prefix));
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    if (path.dirname(dir) !== tmp || !path.basename(dir).startsWith(prefix)) fail('UAT_RELEASE_CLEANUP_UNSAFE');
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    removed = true;
  };
  try {
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || await realpath(dir) !== dir || (await readdir(dir)).length !== 0) fail('UAT_RELEASE_DIR_UNSAFE');
    return { path: dir, parent: tmp, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
export async function collectEntries(src) {
  const dirs = []; const files = []; let total = 0;
  const walk = async (rel) => {
    const entries = (await readdir(path.join(src, rel))).sort();
    for (const name of entries) {
      if (name.startsWith('.')) fail('UAT_OUTPUT_HIDDEN_ENTRY');
      const r = path.join(rel, name);
      const st = await lstat(path.join(src, r));
      if (st.isSymbolicLink()) fail('UAT_OUTPUT_LINK');
      if (st.isDirectory()) { dirs.push(r); await walk(r); continue; }
      if (!st.isFile()) fail('UAT_OUTPUT_UNSAFE');
      if (st.nlink > 1) fail('UAT_OUTPUT_LINK');
      if (st.size > MAX_ASSET_BYTES) fail('UAT_OUTPUT_TOO_LARGE');
      total += st.size;
      files.push({ rel: r, st });
      if (files.length > MAX_ASSET_COUNT || total > MAX_TOTAL_BYTES) fail('UAT_OUTPUT_TOO_LARGE');
    }
  };
  await walk('');
  return { dirs, files };
}
const ledgerKey = (rel) => rel.split(path.sep).join('/');
export async function copyEntries(src, dst, { dirs, files }) {
  const fileDigests = Object.create(null);
  for (const d of dirs) await mkdir(path.join(dst, d));
  for (const { rel, st } of files) {
    const fh = await open(path.join(src, rel), 'r');
    let buf;
    try {
      const fst = await fh.stat();
      if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev || fst.size !== st.size) fail('UAT_OUTPUT_CHANGED');
      buf = await fh.readFile();
    } finally { await fh.close(); }
    if (buf.length !== st.size) fail('UAT_OUTPUT_CHANGED');
    if (DENIED_REFS.some((r) => buf.includes(r) || buf.includes(r.toUpperCase()))) fail('UAT_RELEASE_DENIED_REF');
    const hash = digest(buf);
    await writeFile(path.join(dst, rel), buf, { flag: 'wx' });
    if (digest(await readFile(path.join(dst, rel))) !== hash) fail('UAT_RELEASE_COPY_MISMATCH');
    fileDigests[ledgerKey(rel)] = hash;
  }
  return Object.freeze(fileDigests);
}
// Release must contain exactly wrangler.toml (pinned digest) + public/ files matching the ledger; nothing else.
export async function verifyReleaseLayout({ releasePath, fileDigests }, configSha) {
  const top = (await readdir(releasePath)).sort();
  if (JSON.stringify(top) !== '["public","wrangler.toml"]') fail('UAT_RELEASE_EXTRA_ENTRY');
  const configPath = path.join(releasePath, 'wrangler.toml');
  await assertPlainFile(configPath, 'UAT_RELEASE_TAMPERED');
  if (digest(await readFile(configPath, 'utf8')) !== configSha) fail('UAT_RELEASE_TAMPERED');
  const pub = path.join(releasePath, 'public');
  const pst = await lstat(pub);
  if (!pst.isDirectory() || pst.isSymbolicLink()) fail('UAT_RELEASE_TAMPERED');
  const seen = new Set();
  const walk = async (rel) => {
    for (const name of await readdir(path.join(pub, rel))) {
      const r = path.join(rel, name); const p = path.join(pub, r);
      const st = await lstat(p);
      if (st.isSymbolicLink()) fail('UAT_RELEASE_TAMPERED');
      if (st.isDirectory()) { await walk(r); continue; }
      const key = ledgerKey(r);
      if (!st.isFile() || st.nlink > 1 || !Object.hasOwn(fileDigests, key)) fail('UAT_RELEASE_EXTRA_ENTRY');
      if (digest(await readFile(p)) !== fileDigests[key]) fail('UAT_RELEASE_TAMPERED');
      seen.add(key);
    }
  };
  await walk('');
  if (seen.size !== Object.keys(fileDigests).length) fail('UAT_RELEASE_MISSING_ENTRY');
  return pub;
}
export async function verifyUatRelease(release) {
  await verifyBundle(await verifyReleaseLayout(release, RELEASE_CONFIG_SHA));
}
// Writes wrangler.toml + public/ (copied from `output`) into a fresh isolated dir outside the repo,
// then runs `verify`. Caller MUST await cleanup(); it removes only that mkdtemp dir.
export async function buildRelease({ prefix, output, rendered, verify, tmpRoot, bases }) {
  const entries = await collectEntries(output);
  const dir = await createIsolatedDir({ prefix, tmpRoot, bases });
  const releasePath = dir.path;
  try {
    const publicPath = path.join(releasePath, 'public');
    await mkdir(publicPath);
    const fileDigests = await copyEntries(output, publicPath, entries);
    const configPath = path.join(releasePath, 'wrangler.toml');
    await writeFile(configPath, rendered, { flag: 'wx' });
    await verify({ releasePath, fileDigests });
    return { releasePath, publicPath, configPath, fileDigests, cleanup: dir.cleanup };
  } catch (e) {
    await dir.cleanup();
    throw e;
  }
}
// Builds a self-contained release (wrangler.toml + public/) in a fresh mkdtemp dir outside the repo.
// Caller MUST await cleanup(); it removes only that mkdtemp dir.
export async function createUatRelease({ base = root, env = process.env, tmpRoot = defaultTmpRoot() } = {}) {
  const target = await verifyAppTarget(base, env);
  const rendered = renderReleaseConfig(target.configText);
  return buildRelease({ prefix: RELEASE_PREFIX, output: target.output, rendered, verify: verifyUatRelease, tmpRoot, bases: [base] });
}
export const prepareUatRelease = createUatRelease;
export function childEnvFor(env) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => ALLOWED_ENV.has(key.toUpperCase())));
  childEnv.CLOUDFLARE_ACCOUNT_ID = UAT_ACCOUNT;
  return childEnv;
}
export async function deployUatApp({ base = root, env = process.env, spawn = spawnSync, tmpRoot = defaultTmpRoot() } = {}) {
  const release = await createUatRelease({ base, env, tmpRoot });
  try {
    await verifyUatRelease(release);
    const r = spawn(process.execPath, [WRANGLER_BIN, ...DEPLOY_ARGS], {
      cwd: release.releasePath, env: childEnvFor(env), shell: false, stdio: 'inherit',
    });
    if (r.error || r.status !== 0) fail('UAT_DEPLOY_FAILED');
  } finally {
    await release.cleanup();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) { console.error('UAT_DEPLOY_NO_ARGUMENTS'); process.exitCode = 1; }
  else try { await deployUatApp(); } catch (e) {
    const code = /^UAT_[A-Z_]+$/.test(e?.message) ? ` ${e.message}` : '';
    console.error(`UAT_APP_DEPLOY_REFUSED${code}`); process.exitCode = 1;
  }
}
