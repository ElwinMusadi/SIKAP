#!/usr/bin/env node
// Phase 9: synthetic document UAT kit generator (offline, Node built-ins only).
//
// Produces, into a NEW private directory outside the repository, the files an operator
// uploads with the synthetic fixture accounts to exercise the document workflow
// (upload / reject / re-upload / approve / rollback / delete) and the upload guards:
//   version-1.pdf   valid 1-page PDF, label "SIKAP SYNTHETIC UAT V1 - NO PERSONAL DATA"  (accept)
//   version-2.pdf   valid 1-page PDF, label "SIKAP SYNTHETIC UAT V2 - NO PERSONAL DATA"  (accept)
//   image.png       valid 256x128 solid-colour PNG                                      (accept)
//   fake-pdf.pdf    HTML text named .pdf, no '%PDF-' magic                               (reject)
//   oversize.pdf    structurally valid PDF of exactly 5 MiB + 1 byte                     (reject)
//   disallowed.svg  static SVG, no script/handlers                                       (reject)
//   manifest.json   purpose, sizes, SHA-256 of the 6 files, synthetic profile examples, steps
// It never contacts the network or the app API, never reads credentials, app or cloud config,
// and never changes ACLs/modes/owners of existing paths (read-only privacy verification).
//
// Usage: node scripts/staging/uat-document-kit.mjs --out <new private dir> --purpose synthetic-document-uat

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  MigrationError, ROOT, canonicalPath, check, isMain, noLinks, persistencePath, safeCode, verifyPrivatePersistence,
} from '../migrate/local-store.mjs';
import { FIXTURE_ACCOUNTS } from './uat-fixture.mjs';

export const PURPOSE = 'synthetic-document-uat';
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // shared/dokumen.ts DOCUMENT_POLICY.maxBytes
export const OVERSIZE_BYTES = MAX_UPLOAD_BYTES + 1;
export const FILES = Object.freeze({
  v1: 'version-1.pdf', v2: 'version-2.pdf', image: 'image.png',
  fakePdf: 'fake-pdf.pdf', oversize: 'oversize.pdf', svg: 'disallowed.svg', manifest: 'manifest.json',
});
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*\.[a-z]{3,4}$/;
export const LABEL = (v) => `SIKAP SYNTHETIC UAT V${v} - NO PERSONAL DATA`;

// ---------------------------------------------------------------------------
// PDF (hand-built, byte-exact xref offsets)
// ---------------------------------------------------------------------------

const ascii = (s) => { check(/^[\t\n\r -~]*$/.test(s), 'NON_ASCII'); return Buffer.from(s, 'latin1'); };
const pdfString = (s) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** Build a 1-page PDF. `padding` adds an unreferenced whitespace stream object (for size targets). */
export function buildPdf({ lines, padding = 0 }) {
  const content = ['BT'];
  for (const { text, size, x, y } of lines) content.push(`/F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm ${pdfString(text)} Tj`);
  content.push('ET');
  const stream = ascii(`${content.join('\n')}\n`);
  const objects = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    Buffer.concat([ascii(`<< /Length ${stream.length} >>\nstream\n`), stream, ascii('endstream')]),
  ];
  if (padding > 0) {
    const pad = Buffer.alloc(padding, 0x20);
    for (let i = 99; i < padding; i += 100) pad[i] = 0x0a; // short lines of harmless whitespace
    objects.push(Buffer.concat([ascii(`<< /Length ${padding} >>\nstream\n`), pad, ascii('\nendstream')]));
  }
  const parts = [ascii('%PDF-1.4\n')];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    const obj = Buffer.concat([ascii(`${i + 1} 0 obj\n`), body, ascii('\nendobj\n')]);
    offsets.push(offset); parts.push(obj); offset += obj.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(ascii(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

export function labelPdf(version) {
  return buildPdf({ lines: [
    { text: LABEL(version), size: 20, x: 50, y: 720 },
    { text: `V${version}`, size: 160, x: 180, y: 420 },
    { text: 'SYNTHETIC TEST DOCUMENT - FIXTURE ACCOUNTS ONLY', size: 14, x: 50, y: 200 },
  ] });
}

/** Valid PDF of exactly `size` bytes (padding stream adjusted until the total matches). */
export function sizedPdf(size) {
  const lines = [{ text: 'SIKAP SYNTHETIC UAT OVERSIZE - NO PERSONAL DATA', size: 20, x: 50, y: 720 }];
  let padding = Math.max(1, size - buildPdf({ lines }).length - 64);
  for (let i = 0; i < 10; i++) {
    const pdf = buildPdf({ lines, padding });
    if (pdf.length === size) return pdf;
    padding += size - pdf.length;
    check(padding > 0, 'PDF_SIZE');
  }
  throw new MigrationError('PDF_SIZE');
}

// ---------------------------------------------------------------------------
// PNG (zlib deflate + hand-rolled CRC-32)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function buildPng({ width = 256, height = 128, rgb = [0x2e, 0x7d, 0x32] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB, no interlace
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3); // filter byte 0 (None)
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Negative samples (inert: no script, no event handlers, no external refs)
// ---------------------------------------------------------------------------

const FAKE_PDF = '<!DOCTYPE html>\n<html><head><title>SIKAP SYNTHETIC UAT</title></head>\n'
  + '<body><p>SIKAP SYNTHETIC UAT - HTML NAMED .PDF - MUST BE REJECTED - NO PERSONAL DATA</p></body></html>\n';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="128" viewBox="0 0 256 128">\n'
  + '<rect width="256" height="128" fill="#c62828"/>\n'
  + '<text x="8" y="70" font-size="12" fill="#ffffff">SIKAP SYNTHETIC UAT - SVG MUST BE REJECTED</text>\n</svg>\n';

// ---------------------------------------------------------------------------
// Synthetic profile examples (advisory; the generator never calls the API)
// ---------------------------------------------------------------------------

// NIK: 16 digits, all-zero region/date components (not a real NIK); unique per fixture.
// Phone: '0000000000' normalises to '62000000000' (passes normalizePhone, not a real number).
// Email: RFC 2606 '.invalid' TLD, undeliverable by definition.
export function profileExamples() {
  return Object.fromEntries(FIXTURE_ACCOUNTS.map((a, i) => [a.label, {
    nik: `000000000000000${i + 1}`,
    noHp: '0000000000',
    email: `sikap-uat-${a.label}@example.invalid`,
    tempatLahir: 'SINTETIS UAT',
    tanggalLahir: `${a.nip.slice(0, 4)}-${a.nip.slice(4, 6)}-${a.nip.slice(6, 8)}`,
    jenisKelamin: 'Laki-laki',
    agama: 'Islam',
    pendidikanKode: 'SMA',
    statusPernikahan: 'Belum Menikah',
    alamat: 'ALAMAT SINTETIS UAT - BUKAN ALAMAT NYATA',
  }]));
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Pure: build every kit file in memory. No I/O. */
export function buildDocumentKit({ now = new Date() } = {}) {
  const entries = [
    { name: FILES.v1, bytes: labelPdf(1), mediaType: 'application/pdf', expect: 'ACCEPT', use: 'Initial upload, later rejected; rollback target.' },
    { name: FILES.v2, bytes: labelPdf(2), mediaType: 'application/pdf', expect: 'ACCEPT', use: 'Re-upload after rejection; approved.' },
    { name: FILES.image, bytes: buildPng(), mediaType: 'image/png', expect: 'ACCEPT', use: 'Image upload path (256x128 solid colour).' },
    { name: FILES.fakePdf, bytes: ascii(FAKE_PDF), mediaType: 'text/html', expect: 'REJECT', use: 'HTML renamed .pdf; magic-byte sniff must reject.' },
    { name: FILES.oversize, bytes: sizedPdf(OVERSIZE_BYTES), mediaType: 'application/pdf', expect: 'REJECT', use: `Valid PDF of ${OVERSIZE_BYTES} bytes (5 MiB + 1); size limit must reject. Intentionally oversized.` },
    { name: FILES.svg, bytes: ascii(SVG), mediaType: 'image/svg+xml', expect: 'REJECT', use: 'Static SVG (no script); type not allowed.' },
  ];
  for (const e of entries) check(SAFE_NAME.test(e.name) && path.basename(e.name) === e.name, 'FILE_NAME_INVALID');
  const manifest = {
    purpose: PURPOSE,
    generator: 'scripts/staging/uat-document-kit.mjs',
    generatedAt: now.toISOString(),
    disclaimer: 'Synthetic test data only. Use ONLY with the synthetic UAT fixture accounts on the isolated UAT target. '
      + 'No personal data, no real contact details, no credentials. Never upload to production.',
    policy: { maxUploadBytes: MAX_UPLOAD_BYTES, allowedMime: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'], note: 'jenis_dokumen.max_size_bytes may lower the limit per type.' },
    warnings: [`${FILES.oversize} is intentionally ${OVERSIZE_BYTES} bytes (over the 5 MiB limit) and must be rejected.`,
      `${FILES.fakePdf} and ${FILES.svg} must be rejected; they contain no script.`],
    files: entries.map(({ name, bytes, mediaType, expect, use }) => ({ name, bytes: bytes.length, sha256: sha256(bytes), mediaType, expect, use })),
    profileExamples: profileExamples(),
    profileNotes: [
      'Fill the profile only with these values; all 10 required fields are covered.',
      'noHp 0000000000 normalises to 62000000000: syntactically accepted, not a real number. Never enter a real phone.',
      'email uses the reserved .invalid TLD and cannot be delivered.',
      'NIK values are unique per fixture and not real NIKs.',
    ],
    operatorSteps: [
      'BEFORE any profile fill or upload: as admin set notification toggles dokumenBaru, dokumenApproved, dokumenRejected all OFF.',
      'Confirm WhatsApp settings show no configured provider token (fonnte and meta configured=false). Do not enter any token.',
       'Log in pns/pppk fixture accounts with their private credentials (not part of this kit) and fill profileExamples[label]. Filling the admin profile is optional and not needed for verification.',
      `pns: upload ${FILES.v1}; expect accepted, pending verification, notifikasi NONAKTIF.`,
      'admin: reject it with a synthetic reason (e.g. "UAT sintetis").',
      `pns: re-upload ${FILES.v2}; expect a new version.`,
      'admin: approve version 2.',
       'Use a SECOND document type for rollback: admin approves PDF V1, pns uploads PDF V2, admin opens review V2 without deciding/refetching, pns rolls back to the previous verified file. Content V1 returns with arsip version 3; stale V2 decision must fail 409 (only if admin view truly stayed stale).',
       'Test delete/restore on another pending document. Admin-deleted VERIFIED document: owner cannot restore (UI absent/API403); after owner uploads a replacement, the DELETE/VERIFIED previous version remains admin-only (owner rollback403). Admin may rollback. API-only check: rollback while the arsip is still soft-deleted gives409 restore-first; the UI has no deleted-version viewer.',
      `pppk: upload ${FILES.image}; expect accepted.`,
       `Negative: ${FILES.svg} and ${FILES.oversize} are blocked client-side (no HTTP upload). ${FILES.fakePdf} reaches the server and must fail400 VALIDATION_ERROR. Existing valid data must stay intact.`,
      'After UAT: delete this kit directory.',
    ],
  };
  return { entries, manifest: ascii(`${JSON.stringify(manifest, null, 2)}\n`) };
}

// ---------------------------------------------------------------------------
// CLI / private output
// ---------------------------------------------------------------------------

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
  check(path.isAbsolute(options.out) && path.resolve(options.out) === options.out, 'PATH_ABSOLUTE_REQUIRED');
  return { out: options.out, purpose: options.purpose };
}

// Read-only privacy check (Windows: ACL read via shared helper; POSIX: owner/mode only, no chmod).
async function verifyPrivate(target, code, { exactMode, file = false } = {}) {
  const stat = await lstat(target);
  check(!stat.isSymbolicLink() && (file ? stat.isFile() : stat.isDirectory()), code);
  if (process.platform === 'win32') {
    try { await verifyPrivatePersistence(target); } catch { throw new MigrationError(code); }
  } else {
    check(stat.uid === process.getuid(), code);
    check(exactMode === undefined ? (stat.mode & 0o077) === 0 : (stat.mode & 0o777) === exactMode, code);
  }
}
async function outsideRepo(value, code) {
  const target = await persistencePath(value);
  const fromRoot = path.relative(canonicalPath(ROOT), canonicalPath(target));
  check(fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot), code);
  return target;
}
const exists = async (target) => {
  try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

export async function writeDocumentKit({ out, purpose }, deps = {}) {
  check(purpose === PURPOSE, 'PURPOSE_INVALID');
  check(typeof out === 'string' && path.isAbsolute(out) && path.resolve(out) === out, 'PATH_ABSOLUTE_REQUIRED');
  const target = await outsideRepo(out, 'OUT_IN_REPO');
  check(!(await exists(target)), 'OUTPUT_EXISTS');
  const parent = path.dirname(target);
  try { await verifyPrivate(parent, 'PARENT_PERMISSIONS'); }
  catch (error) { if (error.code === 'ENOENT') throw new MigrationError('PARENT_MISSING'); throw error; }
  const kit = buildDocumentKit({ now: deps.now ?? new Date() });

  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new MigrationError('OUTPUT_EXISTS'); throw error; }
  const created = [];
  try {
    await noLinks(target);
    await verifyPrivate(target, 'OUTPUT_PERMISSIONS', { exactMode: 0o700 });
    let bytes = 0;
    for (const [name, value] of [...kit.entries.map((e) => [e.name, e.bytes]), [FILES.manifest, kit.manifest]]) {
      const file = path.join(target, name);
      check(path.dirname(file) === target, 'FILE_NAME_INVALID');
      const handle = await open(file, 'wx', 0o600); // exclusive create: never overwrites
      created.push(file);
      try { await handle.writeFile(value); } finally { await handle.close(); }
      const stat = await lstat(file);
      check(stat.isFile() && stat.size === value.length && (process.platform === 'win32' || (stat.mode & 0o777) === 0o600), 'OUTPUT_PERMISSIONS');
      await noLinks(file);
      await verifyPrivate(file, 'OUTPUT_PERMISSIONS', { file: true, exactMode: 0o600 }); // Windows: read-only ACL check
      bytes += value.length;
    }
    return { purpose: PURPOSE, files: created.length, accept: 3, reject: 3, bytes };
  } catch (error) {
    let linked = false;
    try { await noLinks(target); } catch { linked = true; }
    if (!linked) {
      for (const file of created.reverse()) { try { if ((await lstat(file)).isFile()) await unlink(file); } catch { /* best effort */ } }
      try { await rmdir(target); } catch { /* best effort */ }
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  try {
    const result = await writeDocumentKit(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, code: 'UAT_DOCUMENT_KIT_READY', ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: safeCode(error) })}\n`);
    process.exitCode = 1;
  }
}
