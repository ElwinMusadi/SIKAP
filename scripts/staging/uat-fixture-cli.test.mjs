import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from '../migrate/local-store.mjs';
import { FILES, PURPOSE } from './uat-fixture.mjs';

const SYNTHETIC_PEPPER = Buffer.alloc(32, 0x3c).toString('base64');
const BASE_TEMP = process.platform === 'win32'
  ? path.join(tmpdir(), 'kilo')
  : path.join(tmpdir(), 'sikap-uat-cli-tests');

const WIN_ACL_SCRIPT = "$ErrorActionPreference='Stop'; try { $p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; " +
  "if((Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count -ne 0){exit 2}; " +
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; " +
  "$a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); " +
  "$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); " +
  "Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch { exit 2 }";

async function privateTemp(t) {
  await mkdir(BASE_TEMP, { recursive: true });
  const temp = await mkdtemp(path.join(BASE_TEMP, 'sikap-uat-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_ACL_SCRIPT, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, timeout: 15000, env: { ...process.env, SIKAP_SYNTHETIC_TEST_DIRECTORY: temp } });
    assert.equal(r.status, 0, 'private test dir ACL setup failed');
  } else {
    const { chmod } = await import('node:fs/promises');
    await chmod(temp, 0o700);
  }
  return temp;
}

function runCli(args, { cwd = ROOT } = {}) {
  const cliPath = path.join(ROOT, 'scripts', 'staging', 'uat-fixture.mjs');
  return spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', timeout: 60000, shell: false });
}

test('CLI runs with synthetic pepper in private dir, emits sanitized JSON, creates files without secret leakage', { timeout: 60000 }, async (t) => {
  const temp = await privateTemp(t);
  const pepperFile = path.join(temp, 'synthetic-pepper.txt');
  await writeFile(pepperFile, `${SYNTHETIC_PEPPER}\n`, { mode: 0o600 });
  const outDir = path.join(temp, 'fixture-out');

  const cli = runCli(['--out', outDir, '--pepper-file', pepperFile, '--purpose', PURPOSE]);
  assert.equal(cli.status, 0, `CLI exit status non-zero: ${cli.stderr || cli.stdout}`);

  const report = JSON.parse(cli.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.code, 'UAT_FIXTURE_READY');
  assert.equal(report.purpose, 'synthetic-uat');
  assert.equal(report.accounts, 3);
  assert.equal(report.admins, 1);
  assert.equal(report.pegawai, 2);
  assert.equal(report.pns, 2);
  assert.equal(report.pppk, 1);
  assert.equal(report.statements, 5);
  assert.equal(report.defaultPasswords, 0);
  assert.equal(report.files, 2);

  const credsPath = path.join(outDir, FILES.credentials);
  const sqlPath = path.join(outDir, FILES.sql);
  const creds = JSON.parse(await readFile(credsPath, 'utf8'));
  const sql = await readFile(sqlPath, 'utf8');

  assert.equal(creds.purpose, 'synthetic-uat');
  assert.equal(creds.accounts.length, 3);

  // Assert stdout contains no plain passwords, hashes, or NIPs
  for (const acc of creds.accounts) {
    assert.ok(acc.password && acc.password.length >= 20);
    assert.equal(cli.stdout.includes(acc.password), false, 'CLI stdout must not contain passwords');
    assert.equal(cli.stdout.includes(acc.nip), false, 'CLI stdout must not contain account NIPs');
    assert.equal(sql.includes(acc.password), false, 'SQL output must not contain plaintext passwords');
  }
  assert.equal(cli.stdout.includes('pbkdf2-sha256'), false, 'CLI stdout must not leak password hashes');
  assert.equal(cli.stderr, '');
});

test('CLI rerun refuses overwrite when target output exists (OUTPUT_EXISTS)', { timeout: 60000 }, async (t) => {
  const temp = await privateTemp(t);
  const pepperFile = path.join(temp, 'synthetic-pepper.txt');
  await writeFile(pepperFile, SYNTHETIC_PEPPER, { mode: 0o600 });
  const outDir = path.join(temp, 'fixture-out');

  // First run creates output
  const first = runCli(['--out', outDir, '--pepper-file', pepperFile, '--purpose', PURPOSE]);
  assert.equal(first.status, 0);

  // Rerun targeting existing directory must be refused
  const rerun = runCli(['--out', outDir, '--pepper-file', pepperFile, '--purpose', PURPOSE]);
  assert.equal(rerun.status, 1);
  const report = JSON.parse(rerun.stdout);
  assert.deepEqual(report, { ok: false, code: 'OUTPUT_EXISTS' });
});

test('CLI rejects unsupported arguments, invalid purpose, and remote flags', { timeout: 60000 }, async (t) => {
  const temp = await privateTemp(t);
  const pepperFile = path.join(temp, 'synthetic-pepper.txt');
  await writeFile(pepperFile, SYNTHETIC_PEPPER, { mode: 0o600 });
  const outDir = path.join(temp, 'fixture-out');

  // --remote flag rejected
  const remoteRun = runCli(['--out', outDir, '--pepper-file', pepperFile, '--purpose', PURPOSE, '--remote']);
  assert.equal(remoteRun.status, 1);
  assert.deepEqual(JSON.parse(remoteRun.stdout), { ok: false, code: 'CLI_ARGUMENTS' });

  // Invalid purpose rejected
  const badPurpose = runCli(['--out', outDir, '--pepper-file', pepperFile, '--purpose', 'production']);
  assert.equal(badPurpose.status, 1);
  assert.deepEqual(JSON.parse(badPurpose.stdout), { ok: false, code: 'PURPOSE_INVALID' });

  // Relative output path rejected
  const relOut = runCli(['--out', 'relative-out-dir', '--pepper-file', pepperFile, '--purpose', PURPOSE]);
  assert.equal(relOut.status, 1);
  assert.deepEqual(JSON.parse(relOut.stdout), { ok: false, code: 'PATH_ABSOLUTE_REQUIRED' });
});

test('CLI refuses output or pepper files within repository and non-private parents', { timeout: 60000 }, async (t) => {
  const temp = await privateTemp(t);
  const pepperFile = path.join(temp, 'synthetic-pepper.txt');
  await writeFile(pepperFile, SYNTHETIC_PEPPER, { mode: 0o600 });

  // Out within repo refused
  const inRepoOut = path.join(ROOT, 'in-repo-fixture-attempt');
  const repoOutRun = runCli(['--out', inRepoOut, '--pepper-file', pepperFile, '--purpose', PURPOSE]);
  assert.equal(repoOutRun.status, 1);
  assert.deepEqual(JSON.parse(repoOutRun.stdout), { ok: false, code: 'OUT_IN_REPO' });
  await assert.rejects(lstat(inRepoOut), { code: 'ENOENT' });

  // Pepper file inside repo refused
  const inRepoPepper = path.join(ROOT, 'package.json');
  const validOut = path.join(temp, 'fixture-out');
  const repoPepRun = runCli(['--out', validOut, '--pepper-file', inRepoPepper, '--purpose', PURPOSE]);
  assert.equal(repoPepRun.status, 1);
  assert.deepEqual(JSON.parse(repoPepRun.stdout), { ok: false, code: 'PEPPER_FILE_INVALID' });
  await assert.rejects(lstat(validOut), { code: 'ENOENT' });
});
