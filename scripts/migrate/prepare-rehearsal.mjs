// Synthetic-rehearsal secret helper. Node built-ins only; never reads app/cloud config or source data.
// Creates a NEW private directory holding a random pepper and salt for a manual GAS rehearsal.
// It never changes ACLs/modes/owners of existing paths and never deletes paths it did not create.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  MigrationError, check, isMain, noLinks, persistencePath, safeCode, verifyPrivatePersistence,
} from './local-store.mjs';

export const PURPOSE = 'synthetic-rehearsal';
export const SECRET_BYTES = 32;
export const FILES = Object.freeze({ pepper: 'rehearsal.sikap-pepper', salt: 'rehearsal.sikap-salt' });

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    check(arg === '--out' || arg === '--purpose', 'CLI_ARGUMENTS');
    const key = arg.slice(2);
    check(!Object.hasOwn(options, key) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'CLI_ARGUMENTS');
    options[key] = argv[++i];
  }
  check(options.out !== undefined && options.purpose !== undefined, 'CLI_ARGUMENTS');
  check(options.purpose === PURPOSE, 'PURPOSE_INVALID');
  check(path.isAbsolute(options.out) && path.resolve(options.out) === options.out, 'OUT_ABSOLUTE_REQUIRED');
  return { out: options.out, purpose: options.purpose };
}

// Read-only privacy check. POSIX is verified here because the shared helper chmods on POSIX.
async function verifyPrivate(target, code, { exactMode } = {}) {
  const stat = await lstat(target);
  check(stat.isDirectory() && !stat.isSymbolicLink(), code);
  if (process.platform === 'win32') {
    try { await verifyPrivatePersistence(target); } // Windows branch only reads the ACL.
    catch { throw new MigrationError(code); }
  } else {
    check(stat.uid === process.getuid(), code);
    check(exactMode === undefined ? (stat.mode & 0o077) === 0 : (stat.mode & 0o777) === exactMode, code);
  }
}

const exists = async (target) => {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

export async function prepareRehearsal({ out, purpose }, deps = {}) {
  const openFile = deps.open ?? open;
  check(purpose === PURPOSE, 'PURPOSE_INVALID');
  check(typeof out === 'string' && path.isAbsolute(out) && path.resolve(out) === out, 'OUT_ABSOLUTE_REQUIRED');
  const target = await persistencePath(out); // absolute, outside repo, no symlink in existing ancestry
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  const parent = path.dirname(target);
  try { await verifyPrivate(parent, 'PARENT_PERMISSIONS'); }
  catch (error) { if (error.code === 'ENOENT') throw new MigrationError('PARENT_MISSING'); throw error; }

  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new MigrationError('OUTPUT_EXISTS'); throw error; }
  const created = [];
  try {
    await noLinks(target);
    await verifyPrivate(target, 'OUTPUT_PERMISSIONS', { exactMode: 0o700 });
    const pepper = randomBytes(SECRET_BYTES).toString('base64');
    let salt = randomBytes(SECRET_BYTES).toString('base64');
    while (salt === pepper) salt = randomBytes(SECRET_BYTES).toString('base64');
    for (const [name, value] of [[FILES.pepper, pepper], [FILES.salt, salt]]) {
      const file = path.join(target, name);
      const handle = await openFile(file, 'wx', 0o600); // exclusive create: never overwrites
      created.push(file); // tracked before writing so a partial write is still cleaned up
      try { await handle.writeFile(value, 'utf8'); } finally { await handle.close(); }
      const stat = await lstat(file);
      check(stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600), 'OUTPUT_PERMISSIONS');
    }
    return { ready: true, files: created.length, secretBytes: SECRET_BYTES };
  } catch (error) {
    // Remove only what this run created; rmdir (non-recursive) leaves a non-empty dir untouched.
    // If the created directory was swapped for a link, skip cleanup rather than touch outside paths.
    let linked = false;
    try { await noLinks(target); } catch { linked = true; }
    if (!linked) {
      for (const file of created.reverse()) {
        try { if ((await lstat(file)).isFile()) await unlink(file); } catch { /* best effort */ }
      }
      try { await rmdir(target); } catch { /* best effort */ }
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = await prepareRehearsal(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, code: 'REHEARSAL_SECRETS_READY', ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: safeCode(error) })}\n`);
    process.exitCode = 1;
  }
}
