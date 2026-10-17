// The ONLY supported UAT holding deploy command. Never reads root wrangler.toml.
// It cannot deploy an application bundle: output must be the exact locked worker.
// Deploys from a fresh isolated release OUTSIDE the repo (same flow as deploy-uat-app.mjs) so
// Wrangler cannot load repo .env/.env.local files or resolve an ancestor/root wrangler.toml.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UAT_ACCOUNT, UAT_DB } from './uat-constants.mjs';
import {
  buildRelease, verifyReleaseLayout, childEnvFor, defaultTmpRoot, DENIED_REFS, HOLDING_RELEASE_PREFIX, WRANGLER_BIN,
} from './deploy-uat-app.mjs';
// Re-exported for existing consumers (deploy-uat-app.test, uat-remote-preflight).
export { UAT_ACCOUNT, UAT_DB };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const fail = (code) => { throw Error(code); };
// Exact known configuration is fingerprinted rather than attempting a partial TOML parser.
export const HOLDING_SOURCE_CONFIG_SHA = 'dfd77f8017b1627431af61d3ae6d186c737477548a6dd99108b740f96e166138';
export const HOLDING_RELEASE_CONFIG_SHA = '31dd3f7da89d3b694f68728614a81843a1ef11d6c78ddc2935238ff147a40968';
export const HOLDING_WORKER_SHA = '6044479567d761c7e71ce5a02569534e3487600c2b144472e4a40bd8c65087fc';
const SRC_OUTPUT_LINE = 'pages_build_output_dir = "../../dist-uat"';
const SRC_MIGRATIONS_LINE = 'migrations_dir = "../../migrations"';
const RELEASE_OUTPUT_LINE = 'pages_build_output_dir = "./public"';
export const HOLDING_DEPLOY_ARGS = Object.freeze(['pages', 'deploy', 'public', '--project-name', 'sikap-uat', '--branch', 'uat', '--commit-dirty=true']);
const normalized = (buf) => buf.toString('utf8').replaceAll('\r\n', '\n');
async function assertPlainFile(p, code) {
  const st = await lstat(p);
  if (!st.isFile() || st.isSymbolicLink()) fail(code);
}
export async function verifyHoldingTarget(base = root, env = process.env) {
  if (env.CLOUDFLARE_ACCOUNT_ID !== UAT_ACCOUNT) fail('UAT_ACCOUNT_REQUIRED');
  const cfgPath = path.join(base, 'ops/uat/wrangler.toml');
  await assertPlainFile(cfgPath, 'UAT_CONFIG_UNSAFE');
  const configText = normalized(await readFile(cfgPath));
  if (hash(configText) !== HOLDING_SOURCE_CONFIG_SHA || !configText.includes(`database_id = "${UAT_DB}"`) ||
      !configText.includes('name = "sikap-uat"')) fail('UAT_CONFIG_MISMATCH');
  const output = path.join(base, 'dist-uat');
  const st = await lstat(output);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('UAT_OUTPUT_UNSAFE');
  const files = await readdir(output);
  if (files.length !== 1 || files[0] !== '_worker.js') fail('UAT_HOLDING_ONLY');
  const outputFile = path.join(output, '_worker.js');
  const source = path.join(base, 'ops/uat/holding-worker.mjs');
  for (const f of [outputFile, source]) await assertPlainFile(f, 'UAT_WORKER_UNSAFE');
  const sourceHash = hash(normalized(await readFile(source)));
  const outputHash = hash(normalized(await readFile(outputFile)));
  if (sourceHash !== HOLDING_WORKER_SHA || outputHash !== sourceHash) fail('UAT_HOLDING_MISMATCH');
  return { configText, output, account: UAT_ACCOUNT };
}
// Rewrites only path lines (output dir to ./public, migrations_dir dropped); everything else byte-identical.
export function renderHoldingConfig(text) {
  const lines = text.split('\n');
  if (lines.filter((l) => l === SRC_OUTPUT_LINE).length !== 1 || lines.filter((l) => l === SRC_MIGRATIONS_LINE).length > 1) fail('UAT_CONFIG_MISMATCH');
  const out = lines.filter((l) => l !== SRC_MIGRATIONS_LINE).map((l) => (l === SRC_OUTPUT_LINE ? RELEASE_OUTPUT_LINE : l)).join('\n');
  if (out.includes('..') || out.includes('[env') || out.includes('migrations_dir') || !out.includes('name = "sikap-uat"') ||
      !out.includes(`database_id = "${UAT_DB}"`) || DENIED_REFS.some((r) => out.toLowerCase().includes(r)) ||
      hash(out) !== HOLDING_RELEASE_CONFIG_SHA) fail('UAT_RELEASE_CONFIG_INVALID');
  return out;
}
// Release must be exactly wrangler.toml (pinned digest) + public/_worker.js (pinned holding worker).
export async function verifyHoldingRelease(release) {
  if (JSON.stringify(Object.keys(release.fileDigests)) !== '["_worker.js"]') fail('UAT_HOLDING_ONLY');
  const pub = await verifyReleaseLayout(release, HOLDING_RELEASE_CONFIG_SHA);
  const worker = path.join(pub, '_worker.js');
  await assertPlainFile(worker, 'UAT_RELEASE_TAMPERED');
  if (hash(normalized(await readFile(worker))) !== HOLDING_WORKER_SHA) fail('UAT_HOLDING_MISMATCH');
}
// Caller MUST await cleanup(); it removes only the mkdtemp release dir.
export async function createHoldingRelease({ base = root, env = process.env, tmpRoot = defaultTmpRoot() } = {}) {
  const target = await verifyHoldingTarget(base, env);
  const rendered = renderHoldingConfig(target.configText);
  return buildRelease({ prefix: HOLDING_RELEASE_PREFIX, output: target.output, rendered, verify: verifyHoldingRelease, tmpRoot, bases: [base] });
}
export async function deployHolding({ base = root, env = process.env, spawn = spawnSync, tmpRoot = defaultTmpRoot() } = {}) {
  const release = await createHoldingRelease({ base, env, tmpRoot });
  try {
    await verifyHoldingRelease(release);
    // No caller-supplied flags, branch, project or config path. cwd is the isolated release, so
    // Wrangler sees only its rendered wrangler.toml; env is scoped with the account forced.
    const result = spawn(process.execPath, [WRANGLER_BIN, ...HOLDING_DEPLOY_ARGS], {
      cwd: release.releasePath, env: childEnvFor(env), shell: false, stdio: 'inherit',
    });
    if (result.error || result.status !== 0) fail('UAT_DEPLOY_FAILED');
  } finally {
    await release.cleanup();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) { console.error('UAT_DEPLOY_NO_ARGUMENTS'); process.exitCode = 1; }
  else try { await deployHolding(); } catch { console.error('UAT_HOLDING_DEPLOY_REFUSED'); process.exitCode = 1; }
}
