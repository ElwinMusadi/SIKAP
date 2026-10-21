// Build only the locked holding deployment; never copy application assets or Functions.
import { mkdir, readdir, copyFile, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'dist-uat');
try {
  const st = await lstat(out);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('UNSAFE_OUTPUT');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await mkdir(out, { mode: 0o700 });
}
const existing = await readdir(out);
// No destructive cleanup: refuse an unexpected app bundle instead of publishing it.
if (existing.some((n) => n !== '_worker.js')) throw Error('HOLDING_OUTPUT_NOT_EMPTY');
if (existing.includes('_worker.js')) {
  const st = await lstat(path.join(out, '_worker.js'));
  if (!st.isFile() || st.isSymbolicLink()) throw Error('UNSAFE_WORKER');
}
const source = path.join(root, 'ops/uat/holding-worker.mjs');
const sourceStat = await lstat(source);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw Error('UNSAFE_SOURCE');
const digest = (b) => createHash('sha256').update(b).digest('hex');
await copyFile(source, path.join(out, '_worker.js'));
if (digest(await readFile(source)) !== digest(await readFile(path.join(out, '_worker.js')))) throw Error('HOLDING_COPY_MISMATCH');
console.log('UAT holding bundle ready (one locked worker, no app assets).');
