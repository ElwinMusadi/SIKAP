import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { ROOT, verifyPrivatePersistence } from '../migrate/local-store.mjs';
import {
  FILES, LABEL, MAX_UPLOAD_BYTES, OVERSIZE_BYTES, PURPOSE, buildDocumentKit, crc32, parseArgs, writeDocumentKit,
} from './uat-document-kit.mjs';

const BASE_TEMP = path.join(tmpdir(), process.platform === 'win32' ? 'kilo' : 'sikap-uat-doc-kit-tests');
const WIN_ACL_SCRIPT = "$ErrorActionPreference='Stop'; try { $p=$env:SIKAP_SYNTHETIC_TEST_DIRECTORY; " +
  "if((Get-ChildItem -LiteralPath $p -Force | Measure-Object).Count -ne 0){exit 2}; " +
  "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object System.Security.AccessControl.DirectorySecurity; " +
  "$a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); " +
  "$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); " +
  "Set-Acl -LiteralPath $p -AclObject $a; exit 0 } catch { exit 2 }";
async function privateTemp(t) {
  await mkdir(BASE_TEMP, { recursive: true });
  const temp = await mkdtemp(path.join(BASE_TEMP, 'sikap-uat-doc-kit-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_ACL_SCRIPT, 'utf16le').toString('base64')],
      { shell: false, windowsHide: true, timeout: 10000, env: { ...process.env, SIKAP_SYNTHETIC_TEST_DIRECTORY: temp } });
    assert.equal(r.status, 0, 'private test dir ACL setup failed');
  } else {
    const { chmod } = await import('node:fs/promises');
    await chmod(temp, 0o700);
  }
  return temp;
}
const errorCode = (code) => (error) => error?.code === code;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const kit = buildDocumentKit({ now: new Date('2026-10-17T00:00:00Z') });
const byName = Object.fromEntries(kit.entries.map((e) => [e.name, e.bytes]));

// Minimal structural PDF check: header, EOF, startxref -> xref, every in-use entry -> "N 0 obj", /Length matches.
function assertPdf(bytes) {
  const text = bytes.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.endsWith('%%EOF\n'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 5), 'xref\n');
  const [, first, count] = /^xref\n(\d+) (\d+)\n/.exec(text.slice(startxref));
  assert.equal(Number(first), 0);
  const entries = text.slice(startxref).split('\n').slice(2, 2 + Number(count));
  assert.equal(entries[0], '0000000000 65535 f ');
  entries.slice(1).forEach((line, i) => {
    assert.match(line, /^\d{10} 00000 n $/);
    const off = Number(line.slice(0, 10));
    assert.equal(text.slice(off, off + `${i + 1} 0 obj\n`.length), `${i + 1} 0 obj\n`);
  });
  assert.equal(Number(/\/Size (\d+)/.exec(text.slice(startxref))[1]), Number(count));
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length, len = Number(m[1]);
    assert.match(text.slice(start + len, start + len + 10), /^\n?endstream/);
  }
  return text;
}

test('PDFs: valid structure, exact xref offsets, ASCII labels, oversize is exactly 5 MiB + 1', () => {
  assert.ok(assertPdf(byName[FILES.v1]).includes(`(${LABEL(1)})`));
  assert.ok(assertPdf(byName[FILES.v2]).includes(`(${LABEL(2)})`));
  assert.notEqual(sha(byName[FILES.v1]), sha(byName[FILES.v2]));
  assertPdf(byName[FILES.oversize]);
  assert.equal(byName[FILES.oversize].length, OVERSIZE_BYTES);
  assert.ok(byName[FILES.oversize].length > MAX_UPLOAD_BYTES && MAX_UPLOAD_BYTES === 5 * 1024 * 1024);
  for (const name of [FILES.v1, FILES.v2]) assert.ok(byName[name].length < 4096);
});

test('PNG: signature, 256x128 RGB IHDR, valid CRC-32 for every chunk, IDAT inflates', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const png = byName[FILES.image];
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8; const types = []; let idat;
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + len);
    assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), type);
    if (type === 'IHDR') { assert.equal(data.readUInt32BE(0), 256); assert.equal(data.readUInt32BE(4), 128); assert.equal(data[8], 8); assert.equal(data[9], 2); }
    if (type === 'IDAT') idat = data;
    types.push(type); off += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  assert.equal(inflateSync(idat).length, 128 * (1 + 256 * 3));
});

test('negative samples: fake PDF has no magic, SVG has no script; all names safe', () => {
  const fake = byName[FILES.fakePdf];
  assert.notEqual(fake.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(fake.toString('latin1'), /^<!DOCTYPE html>/);
  const svg = byName[FILES.svg].toString('latin1');
  assert.ok(svg.startsWith('<svg') && !/script|on\w+=|href|<foreignObject/i.test(svg));
  for (const e of kit.entries) {
    assert.match(e.name, /^[a-z0-9][a-z0-9-]*\.[a-z]{3,4}$/);
    assert.ok(/^[ -~]+$/.test(e.name));
  }
});

test('manifest: purpose, sizes and checksums of all files, synthetic profiles, no credentials', () => {
  const m = JSON.parse(kit.manifest.toString('utf8'));
  assert.equal(m.purpose, PURPOSE);
  assert.deepEqual(m.files.map((f) => f.name), [FILES.v1, FILES.v2, FILES.image, FILES.fakePdf, FILES.oversize, FILES.svg]);
  for (const f of m.files) { assert.equal(f.bytes, byName[f.name].length); assert.equal(f.sha256, sha(byName[f.name])); }
  assert.deepEqual(Object.keys(m.profileExamples), ['admin', 'pns', 'pppk']);
  const niks = new Set();
  for (const p of Object.values(m.profileExamples)) {
    assert.equal(Object.keys(p).length, 10);
    assert.match(p.nik, /^0{15}[1-3]$/); niks.add(p.nik);
    assert.equal(p.noHp, '0000000000');
    assert.match(p.email, /^sikap-uat-[a-z]+@example\.invalid$/);
    assert.match(p.tanggalLahir, /^1900-0[1-3]-0[1-3]$/);
  }
  assert.equal(niks.size, 3);
  assert.ok(/notification toggles .* OFF/.test(m.operatorSteps[0]));
  assert.ok(!/password|pepper|token"|secret"/i.test(JSON.stringify({ ...m, operatorSteps: [], profileNotes: [] })));
});

test('parseArgs accepts only --out --purpose synthetic-document-uat', () => {
  const out = path.resolve(BASE_TEMP, 'o');
  assert.deepEqual(parseArgs(['--out', out, '--purpose', PURPOSE]), { out, purpose: PURPOSE });
  for (const argv of [
    ['--out', out], ['--out', out, '--purpose', 'synthetic-uat'], ['--out', out, '--purpose', PURPOSE, '--remote'],
    ['--out', out, '--out', out, '--purpose', PURPOSE], ['--out', 'relative', '--purpose', PURPOSE],
    ['--out', `${out}${path.sep}..${path.sep}x`, '--purpose', PURPOSE],
  ]) assert.throws(() => parseArgs(argv), (e) => ['CLI_ARGUMENTS', 'PURPOSE_INVALID', 'PATH_ABSOLUTE_REQUIRED'].includes(e.code));
});

test('writeDocumentKit refuses repo/.wrangler/existing/missing-parent outputs and creates nothing', async (t) => {
  const temp = await privateTemp(t);
  const base = { purpose: PURPOSE };
  await assert.rejects(writeDocumentKit({ ...base, out: path.join(ROOT, 'uat-doc-kit') }), errorCode('OUT_IN_REPO'));
  await assert.rejects(writeDocumentKit({ ...base, out: ROOT }), errorCode('PERSIST_DEDICATED_REQUIRED'));
  await assert.rejects(writeDocumentKit({ ...base, out: path.join(temp, '.wrangler', 'x') }), errorCode('PERSIST_DEDICATED_REQUIRED'));
  await assert.rejects(writeDocumentKit({ ...base, out: temp }), errorCode('OUTPUT_EXISTS'));
  await assert.rejects(writeDocumentKit({ ...base, out: path.join(temp, 'missing', 'x') }), errorCode('PARENT_MISSING'));
  await assert.rejects(writeDocumentKit({ purpose: 'other', out: path.join(temp, 'x') }), errorCode('PURPOSE_INVALID'));
  await writeFile(path.join(temp, 'keep.txt'), 'x');
  await assert.rejects(writeDocumentKit({ ...base, out: path.join(temp, 'keep.txt') }), errorCode('OUTPUT_EXISTS'));
  assert.equal(await readFile(path.join(temp, 'keep.txt'), 'utf8'), 'x');
  await assert.rejects(lstat(path.join(temp, 'x')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(ROOT, 'uat-doc-kit')), { code: 'ENOENT' });
});

test('CLI writes 7 private files with matching checksums, prints counts only, never overwrites', { timeout: 60000 }, async (t) => {
  const temp = await privateTemp(t);
  const out = path.join(temp, 'kit-out');
  const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'staging', 'uat-document-kit.mjs'), '--out', out, '--purpose', PURPOSE],
    { cwd: ROOT, encoding: 'utf8', timeout: 30000, shell: false });
  const cli = run();
  assert.equal(cli.status, 0, cli.stdout);
  assert.equal(cli.stderr, '');
  const report = JSON.parse(cli.stdout);
  assert.deepEqual({ ...report, bytes: undefined }, { ok: true, code: 'UAT_DOCUMENT_KIT_READY', purpose: PURPOSE, files: 7, accept: 3, reject: 3, bytes: undefined });
  assert.deepEqual((await readdir(out)).sort(), Object.values(FILES).sort());
  const manifest = JSON.parse(await readFile(path.join(out, FILES.manifest), 'utf8'));
  let total = 0;
  for (const f of manifest.files) {
    const bytes = await readFile(path.join(out, f.name));
    assert.equal(bytes.length, f.bytes); assert.equal(sha(bytes), f.sha256); total += bytes.length;
  }
  assert.equal(report.bytes, total + (await lstat(path.join(out, FILES.manifest))).size);
  if (process.platform === 'win32') {
    await verifyPrivatePersistence(out);
    for (const f of Object.values(FILES)) await verifyPrivatePersistence(path.join(out, f));
  } else {
    assert.equal((await lstat(out)).mode & 0o777, 0o700);
    for (const f of Object.values(FILES)) assert.equal((await lstat(path.join(out, f))).mode & 0o777, 0o600);
  }
  const before = sha(await readFile(path.join(out, FILES.v1)));
  const again = run();
  assert.equal(again.status, 1);
  assert.deepEqual(JSON.parse(again.stdout), { ok: false, code: 'OUTPUT_EXISTS' });
  assert.equal(sha(await readFile(path.join(out, FILES.v1))), before);
});
