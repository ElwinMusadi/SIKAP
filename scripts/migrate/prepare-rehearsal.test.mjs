import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FILES, PURPOSE, parseArgs, prepareRehearsal } from './prepare-rehearsal.mjs';

const SCRIPT = fileURLToPath(new URL('./prepare-rehearsal.mjs', import.meta.url));
const code = (expected) => (error) => error?.code === expected;
const ps = (script, dir) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { shell: false, windowsHide: true, timeout: 10000, encoding: 'utf8', env: { ...process.env, SIKAP_SYNTHETIC_TEST_DIRECTORY: dir } });

// Explicit fixture setup only (same pattern as apply-local/pipeline tests): protect a brand-new
// empty synthetic temp directory. The helper under test never changes ACLs or modes.
async function privateParent(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sikap-rehearsal-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    const result = ps("$ErrorActionPreference='Stop'; try { $p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; if((Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count -ne 0){exit 2}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch {exit 2}", temp);
    assert.equal(result.status, 0, 'Private synthetic fixture setup failed');
  } else assert.equal((await stat(temp)).mode & 0o777, 0o700);
  return temp;
}

test('parseArgs requires exact --out absolute and --purpose synthetic-rehearsal only', () => {
  const out = path.join(os.tmpdir(), 'x');
  assert.deepEqual(parseArgs(['--out', out, '--purpose', PURPOSE]), { out, purpose: PURPOSE });
  for (const argv of [[], ['--out', out], ['--purpose', PURPOSE], ['--out', out, '--purpose', PURPOSE, '--remote'],
    ['--out', out, '--out', out, '--purpose', PURPOSE], ['--out', '--purpose', PURPOSE], ['--production', '--out', out, '--purpose', PURPOSE]]) {
    assert.throws(() => parseArgs(argv), code('CLI_ARGUMENTS'));
  }
  assert.throws(() => parseArgs(['--out', out, '--purpose', 'production']), code('PURPOSE_INVALID'));
  assert.throws(() => parseArgs(['--out', 'relative/dir', '--purpose', PURPOSE]), code('OUT_ABSOLUTE_REQUIRED'));
  assert.throws(() => parseArgs(['--out', `${out}${path.sep}..${path.sep}y`, '--purpose', PURPOSE]), code('OUT_ABSOLUTE_REQUIRED'));
});

test('creates distinct canonical 32-byte base64 secrets in a new private directory', async (t) => {
  const parent = await privateParent(t), out = path.join(parent, 'secrets');
  const parentMode = (await stat(parent)).mode;
  const sddl = () => process.platform === 'win32' ? ps("(Get-Acl -LiteralPath $env:SIKAP_SYNTHETIC_TEST_DIRECTORY).Sddl", parent).stdout.trim() : '';
  const parentAcl = sddl();
  if (process.platform === 'win32') assert.match(parentAcl, /^O:/);
  assert.deepEqual(await prepareRehearsal({ out, purpose: PURPOSE }), { ready: true, files: 2, secretBytes: 32 });
  assert.equal(sddl(), parentAcl);
  assert.deepEqual((await readdir(out)).sort(), [FILES.pepper, FILES.salt].sort());
  const values = [];
  for (const name of [FILES.pepper, FILES.salt]) {
    const bytes = await readFile(path.join(out, name));
    const text = bytes.toString('utf8');
    assert.ok(!bytes.includes(0) && Buffer.from(text, 'utf8').equals(bytes));
    assert.match(text, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(Buffer.from(text, 'base64').length, 32);
    assert.equal(Buffer.from(text, 'base64').toString('base64'), text);
    if (process.platform !== 'win32') assert.equal((await stat(path.join(out, name))).mode & 0o777, 0o600);
    values.push(text);
  }
  assert.notEqual(values[0], values[1]);
  assert.equal((await stat(parent)).mode, parentMode);
  if (process.platform !== 'win32') assert.equal((await stat(out)).mode & 0o777, 0o700);
});

test('refuses existing output without overwriting or deleting it', async (t) => {
  const parent = await privateParent(t), out = path.join(parent, 'existing');
  await mkdir(out); await writeFile(path.join(out, FILES.pepper), 'keep');
  await assert.rejects(prepareRehearsal({ out, purpose: PURPOSE }), code('OUTPUT_EXISTS'));
  assert.equal(await readFile(path.join(out, FILES.pepper), 'utf8'), 'keep');
  assert.deepEqual(await readdir(out), [FILES.pepper]);
  const file = path.join(parent, 'file'); await writeFile(file, 'keep');
  await assert.rejects(prepareRehearsal({ out: file, purpose: PURPOSE }), code('OUTPUT_EXISTS'));
  assert.equal(await readFile(file, 'utf8'), 'keep');
});

test('broadly accessible or missing parent fails before creating output and is left unchanged', async (t) => {
  const parent = path.join(await privateParent(t), 'explicit-insecure-synthetic'), out = path.join(parent, 'secrets');
  await mkdir(parent, { mode: 0o700 });
  if (process.platform === 'win32') {
    const result = ps("$ErrorActionPreference='Stop'; try { $p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; $a=Get-Acl -LiteralPath $p; $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch {exit 2}", parent);
    assert.equal(result.status, 0, 'Synthetic negative-test ACL setup failed');
  } else await chmod(parent, 0o755); // fixture-only change on the test's own temp dir
  await assert.rejects(prepareRehearsal({ out, purpose: PURPOSE }), code('PARENT_PERMISSIONS'));
  await assert.rejects(stat(out), { code: 'ENOENT' });
  if (process.platform !== 'win32') assert.equal((await stat(parent)).mode & 0o777, 0o755);
  await assert.rejects(prepareRehearsal({ out: path.join(parent, 'missing', 'secrets'), purpose: PURPOSE }), code('PARENT_MISSING'));
  await assert.rejects(stat(path.join(parent, 'missing')), { code: 'ENOENT' });
});

test('rejects symlink or junction in output ancestry', async (t) => {
  const parent = await privateParent(t), real = path.join(parent, 'real'), link = path.join(parent, 'link');
  await mkdir(real);
  try { await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('symlink unsupported'); return; }
  await assert.rejects(prepareRehearsal({ out: path.join(link, 'secrets'), purpose: PURPOSE }), code('PATH_SYMLINK'));
  assert.deepEqual(await readdir(real), []);
});

test('partial write after exclusive create removes only files and directory created by this run', async (t) => {
  const parent = await privateParent(t), out = path.join(parent, 'secrets');
  await writeFile(path.join(parent, 'sibling'), 'keep');
  let calls = 0, partial;
  // Second file: real exclusive open, then a short write followed by a synthetic disk-full error.
  const failingOpen = async (...args) => {
    const handle = await open(...args);
    if (++calls !== 2) return handle;
    partial = args[0];
    return { close: () => handle.close(), writeFile: async () => { await handle.writeFile('AAAA', 'utf8'); throw Object.assign(new Error('synthetic'), { code: 'ENOSPC' }); } };
  };
  await assert.rejects(prepareRehearsal({ out, purpose: PURPOSE }, { open: failingOpen }), { code: 'ENOSPC' });
  assert.equal(path.basename(partial), FILES.salt);
  await assert.rejects(stat(out), { code: 'ENOENT' });
  assert.deepEqual(await readdir(parent), ['sibling']);
  assert.equal(await readFile(path.join(parent, 'sibling'), 'utf8'), 'keep');
});

test('CLI prints only codes and counts, never paths or secrets', async (t) => {
  const parent = await privateParent(t), out = path.join(parent, 'cli');
  const run = (argv) => spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const ok = run(['--out', out, '--purpose', PURPOSE]);
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, code: 'REHEARSAL_SECRETS_READY', ready: true, files: 2, secretBytes: 32 });
  const secrets = await Promise.all([FILES.pepper, FILES.salt].map((n) => readFile(path.join(out, n), 'utf8')));
  const again = run(['--out', out, '--purpose', PURPOSE]);
  assert.equal(again.status, 1);
  assert.deepEqual(JSON.parse(again.stdout), { ok: false, code: 'OUTPUT_EXISTS' });
  for (const text of [ok.stdout, ok.stderr, again.stdout, again.stderr]) {
    assert.ok(!text.includes(parent) && !text.includes('cli') && secrets.every((s) => !text.includes(s)));
  }
  assert.deepEqual(JSON.parse(run(['--out', out, '--purpose', PURPOSE, '--remote']).stdout), { ok: false, code: 'CLI_ARGUMENTS' });
});
