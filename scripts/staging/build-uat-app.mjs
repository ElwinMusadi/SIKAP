// Build the guarded UAT app bundle (Pages advanced-mode _worker.js + reviewed static assets).
// Requires a prior `vite build` (dist/). Never spawns Vite/npm, never deploys, never reads secrets.
// Output is fixed to <root>/dist-uat-app and must not exist; delete it manually to rebuild.
import { lstat, readdir, mkdir, mkdtemp, copyFile, readFile, writeFile, rename, rm, constants } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST_DIR = 'dist';
export const OUT_DIR = 'dist-uat-app';
export const ENTRY = 'server/uat-deployment.ts';
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // Pages per-file limit
// Force every request through the worker guard (no static bypass).
export const ROUTES = Object.freeze({ version: 1, include: ['/*'], exclude: [] });

const REQUIRED_TOP = new Set(['assets', 'index.html']);
const OPTIONAL_TOP = new Set(['logo-ntt.png', '_headers', '_routes.json']);
const TOP_FILES = new Set(['index.html', 'logo-ntt.png', '_headers', '_routes.json']);
// Flat Vite asset names only: no hidden files, maps, JSON, HTML, or nested dirs.
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(?:js|css|woff2?|ttf|otf|eot|png|jpe?g|webp|avif|gif|svg|ico)$/;
const FORBIDDEN_RE = /snapshot|sikap|export|private|secret|credential|wrangler|\.dev|\.env|\.map$/i;

export class BuildError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}
const fail = (code, detail) => { throw new BuildError(code, detail); };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function lstatOrNull(p) {
  try { return await lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function regularFile(p, label) {
  const st = await lstatOrNull(p);
  if (!st) fail('MISSING_FILE', label);
  if (st.isSymbolicLink() || !st.isFile()) fail('UNSAFE_ENTRY', label);
  if (st.size > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', label);
  return st;
}

/** Validate dist/ against the allowlist. Returns relative POSIX paths to copy (excludes _routes.json). */
export async function validateDist(distDir) {
  const st = await lstatOrNull(distDir);
  if (!st) fail('DIST_MISSING', 'run `vite build` first');
  if (st.isSymbolicLink() || !st.isDirectory()) fail('UNSAFE_DIST');
  const top = await readdir(distDir);
  for (const name of top) {
    if (!REQUIRED_TOP.has(name) && !OPTIONAL_TOP.has(name)) fail('UNEXPECTED_DIST_ENTRY', name);
  }
  for (const name of REQUIRED_TOP) if (!top.includes(name)) fail('DIST_INCOMPLETE', name);
  const files = [];
  for (const name of top) {
    const p = path.join(distDir, name);
    if (TOP_FILES.has(name)) {
      await regularFile(p, name);
      if (name !== '_routes.json') files.push(name); // always regenerated
      continue;
    }
    const ast = await lstat(p);
    if (ast.isSymbolicLink() || !ast.isDirectory()) fail('UNSAFE_ENTRY', name);
    for (const asset of await readdir(p)) {
      const rel = `assets/${asset}`;
      if (!ASSET_RE.test(asset) || FORBIDDEN_RE.test(asset)) fail('UNEXPECTED_ASSET', rel);
      await regularFile(path.join(p, asset), rel);
      files.push(rel);
    }
  }
  return files.sort();
}

/** Bundle the guarded worker entry in memory. Returns the single output bundle. */
export async function bundleWorker(entryPath) {
  await regularFile(entryPath, 'worker entry');
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    conditions: ['worker', 'browser'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    metafile: true,
    outfile: '_worker.js',
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (result.errors.length) fail('WORKER_BUILD_FAILED');
  if (result.outputFiles.length !== 1) fail('WORKER_OUTPUT_COUNT', String(result.outputFiles.length));
  const outputs = Object.values(result.metafile.outputs);
  if (outputs.length !== 1 || JSON.stringify(outputs[0].exports) !== '["default"]') fail('WORKER_DEFAULT_ONLY');
  const bytes = Buffer.from(result.outputFiles[0].contents);
  if (bytes.includes('sourceMappingURL')) fail('WORKER_SOURCEMAP');
  return { bytes, warnings: result.warnings.length };
}

export async function buildUatApp({ root = ROOT } = {}) {
  root = path.resolve(root);
  const dist = path.join(root, DIST_DIR);
  const out = path.join(root, OUT_DIR);
  if (await lstatOrNull(out)) fail('OUTPUT_EXISTS', `${OUT_DIR} exists; delete it manually to rebuild`);
  const files = await validateDist(dist);
  const worker = await bundleWorker(path.join(root, ENTRY));

  // Stage on the same volume, then rename atomically into place.
  const stage = await mkdtemp(path.join(root, `.${OUT_DIR}-staging-`));
  try {
    await mkdir(path.join(stage, 'assets'));
    for (const rel of files) {
      const src = path.join(dist, ...rel.split('/'));
      const dst = path.join(stage, ...rel.split('/'));
      await regularFile(src, rel); // re-check right before copy
      await copyFile(src, dst, constants.COPYFILE_EXCL);
      if (sha256(await readFile(src)) !== sha256(await readFile(dst))) fail('COPY_MISMATCH', rel);
    }
    await writeFile(path.join(stage, '_worker.js'), worker.bytes, { flag: 'wx' });
    await writeFile(path.join(stage, '_routes.json'), `${JSON.stringify(ROUTES)}\n`, { flag: 'wx' });
    if (await lstatOrNull(out)) fail('OUTPUT_EXISTS', 'appeared during build');
    await rename(stage, out);
  } finally {
    await rm(stage, { recursive: true, force: true }); // only our unique staging dir; no-op after rename
  }
  return {
    out,
    files: files.length,
    workerBytes: worker.bytes.length,
    workerSha256: sha256(worker.bytes),
    warnings: worker.warnings,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('build-uat-app takes no arguments (output is fixed).');
    process.exit(2);
  }
  try {
    const r = await buildUatApp();
    console.log(`UAT app bundle ready: ${OUT_DIR}/ (${r.files} static files, _worker.js ${r.workerBytes} B sha256 ${r.workerSha256}, ${r.warnings} esbuild warnings).`);
  } catch (e) {
    console.error(`UAT app build refused: ${e.code ?? 'ERROR'}${e instanceof BuildError ? '' : ` ${e.message}`}`);
    if (e instanceof BuildError) console.error(e.message);
    process.exit(1);
  }
}
