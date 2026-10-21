import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildUatApp, validateDist, ROUTES, OUT_DIR } from './build-uat-app.mjs';

async function fixture({ extra } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sikap-uat-app-'));
  await mkdir(path.join(root, 'dist/assets'), { recursive: true });
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, 'dist/index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(path.join(root, 'dist/logo-ntt.png'), 'png');
  await writeFile(path.join(root, 'dist/_headers'), '/*\n  X-Frame-Options: DENY\n');
  await writeFile(path.join(root, 'dist/_routes.json'), '{"version":1,"include":["/api/*"],"exclude":["/assets/*"]}');
  await writeFile(path.join(root, 'dist/assets/index-AbC123.js'), 'console.log(1)');
  await writeFile(path.join(root, 'dist/assets/index-AbC123.css'), 'body{}');
  await writeFile(path.join(root, 'dist/assets/inter-latin-400.woff2'), 'font');
  await writeFile(
    path.join(root, 'server/uat-deployment.ts'),
    'const tag: string = "fixture-guard";\nexport default { async fetch(_r: Request): Promise<Response> { return new Response(tag, { status: 403 }); } };\n',
  );
  if (extra) await extra(root);
  return root;
}
const cleanup = (root) => rm(root, { recursive: true, force: true });

test('builds isolated output with worker, allowlisted files and forced routes', async () => {
  const root = await fixture();
  try {
    const r = await buildUatApp({ root });
    const out = path.join(root, OUT_DIR);
    assert.deepEqual((await readdir(out)).sort(), ['_headers', '_routes.json', '_worker.js', 'assets', 'index.html', 'logo-ntt.png']);
    assert.deepEqual(JSON.parse(await readFile(path.join(out, '_routes.json'), 'utf8')), ROUTES);
    const worker = await readFile(path.join(out, '_worker.js'), 'utf8');
    assert.match(worker, /fixture-guard/);
    assert.doesNotMatch(worker, /sourceMappingURL/);
    assert.match(worker, /export\s*\{/);
    assert.equal(r.files, 6);
    assert.match(r.workerSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual((await readdir(root)).sort(), ['dist', OUT_DIR, 'server'].sort(), 'staging dir removed');
  } finally { await cleanup(root); }
});

test('refuses when output already exists (no destructive cleanup)', async () => {
  const root = await fixture({ extra: (r) => mkdir(path.join(r, OUT_DIR)) });
  try {
    await assert.rejects(buildUatApp({ root }), { code: 'OUTPUT_EXISTS' });
    assert.deepEqual(await readdir(path.join(root, OUT_DIR)), []);
  } finally { await cleanup(root); }
});

test('requires a prior vite build', async () => {
  const root = await fixture({ extra: (r) => rm(path.join(r, 'dist/index.html')) });
  try {
    await assert.rejects(buildUatApp({ root }), { code: 'DIST_INCOMPLETE' });
    await rm(path.join(root, 'dist'), { recursive: true });
    await assert.rejects(buildUatApp({ root }), { code: 'DIST_MISSING' });
  } finally { await cleanup(root); }
});

const rejectCases = [
  ['source map', 'dist/assets/index-AbC123.js.map', 'UNEXPECTED_ASSET'],
  ['hidden asset', 'dist/assets/.dev.vars', 'UNEXPECTED_ASSET'],
  ['json asset', 'dist/assets/data.json', 'UNEXPECTED_ASSET'],
  ['html asset', 'dist/assets/other.html', 'UNEXPECTED_ASSET'],
  ['snapshot-named asset', 'dist/assets/sikap-snapshot-1.js', 'UNEXPECTED_ASSET'],
  ['unknown top file', 'dist/private.json', 'UNEXPECTED_DIST_ENTRY'],
  ['dev vars at top', 'dist/.dev.vars', 'UNEXPECTED_DIST_ENTRY'],
  ['wrangler config', 'dist/wrangler.toml', 'UNEXPECTED_DIST_ENTRY'],
  ['functions dir', 'dist/functions/x.js', 'UNEXPECTED_DIST_ENTRY'],
  ['nested asset dir', 'dist/assets/sub/a.js', 'UNEXPECTED_ASSET'],
];
for (const [name, rel, code] of rejectCases) {
  test(`rejects ${name} before writing output`, async () => {
    const root = await fixture({
      extra: async (r) => {
        await mkdir(path.dirname(path.join(r, rel)), { recursive: true });
        await writeFile(path.join(r, rel), 'x');
      },
    });
    try {
      await assert.rejects(buildUatApp({ root }), { code });
      assert.ok(!(await readdir(root)).some((n) => n.includes(OUT_DIR)), 'no output or staging left');
    } finally { await cleanup(root); }
  });
}

test('rejects symlinks inside dist', async (t) => {
  const root = await fixture();
  try {
    try {
      await symlink(path.join(root, 'dist/index.html'), path.join(root, 'dist/assets/link-abc.js'));
    } catch (e) {
      if (e.code === 'EPERM') return t.skip('symlinks not permitted on this host');
      throw e;
    }
    await assert.rejects(validateDist(path.join(root, 'dist')), { code: 'UNSAFE_ENTRY' });
  } finally { await cleanup(root); }
});

test('rejects additional named worker exports', async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, 'server/uat-deployment.ts'), 'export const extra = () => 1; export default {fetch(){return new Response("x")}};');
    await assert.rejects(buildUatApp({ root }), { code: 'WORKER_DEFAULT_ONLY' });
  } finally { await cleanup(root); }
});

test('rejects missing worker entry without output', async () => {
  const root = await fixture({ extra: (r) => rm(path.join(r, 'server/uat-deployment.ts')) });
  try {
    await assert.rejects(buildUatApp({ root }), { code: 'MISSING_FILE' });
    assert.ok(!(await readdir(root)).some((n) => n.includes(OUT_DIR)));
  } finally { await cleanup(root); }
});
