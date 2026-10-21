// Node built-in tests intentionally live outside the Vitest Workers pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syntheticFixture } from './fixture.mjs';
import { HEADERS, dateOnly, timestamp, validateOverrides } from './normalize.mjs';
import { transformExport, reportFor, runCLI, readBoundedFile, parseArguments } from './transform.mjs';
import { generateSQL, sqlValue } from './sql.mjs';

const pepper = 'synthetic-test-pepper-not-for-use';
const salt = Buffer.alloc(32, 0x71);
const options = { pepper, salt };
const fixture = () => structuredClone(syntheticFixture().snapshot);
const transform = (source = fixture(), overrides = {}) => transformExport(source, { ...options, overrides });
const codes = (plan) => plan.diagnostics.map((d) => d.code);
function set(source, sheet, field, value, row = 0) {
  const data = source.sheets[sheet]; data.rows[row].values[data.headers.indexOf(field)] = value;
}
function append(source, sheet, values) {
  const rows = source.sheets[sheet].rows;
  rows.push({ rowNumber: rows.length + 2, values, displayValues: values.map((v) => String(v ?? '')) });
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sikap-transform-synthetic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function cliInput(directory, source = fixture()) {
  await writeFile(join(directory, 'input.json'), JSON.stringify(source));
  await writeFile(join(directory, 'pepper'), `  ${pepper}\n`);
  await writeFile(join(directory, 'salt'), `${salt.toString('base64')}\n`);
  return ['--input', join(directory, 'input.json'), '--out', join(directory, 'output'), '--pepper-file', join(directory, 'pepper'), '--salt-file', join(directory, 'salt')];
}

test('golden synthetic fixture preserves fixed plan tables, matrix and exact metadata', () => {
  const plan = transform();
  assert.equal(plan.ready, true, JSON.stringify(plan.diagnostics));
  assert.deepEqual(plan.expected, { pegawai: 3, akun: 3, arsip: 2, files: 3, totalFileBytes: 124, arsipPerStatus: { Menunggu: 0, Terverifikasi: 1, Ditolak: 1 } });
  assert.equal(plan.createdAt, fixture().createdAt);
  assert.equal(plan.consistent, false);
  assert.equal(plan.tables.jenis_dokumen.length, 11);
  for (const [status, count] of [['PNS', 9], ['CPNS', 7], ['PPPK', 6]]) assert.equal(plan.tables.jenis_dokumen_wajib.filter((r) => r.status_kepegawaian === status).length, count);
  assert.equal(plan.tables.pegawai[2].pangkat_kode, 'PPPK-IX');
  assert.equal(plan.tables.pegawai[2].status_kepegawaian, 'PPPK');
  assert.equal(plan.tables.pegawai[1].pangkat_kode, 'III/c');
  assert.equal(plan.tables.pegawai[0].no_hp, '6281299990001');
  assert.equal(plan.tables.arsip_dokumen_riwayat.length, 4);
  for (const file of plan.files) assert.equal(file.r2Key, `migration/${plan.snapshotId}/${file.kind}/${file.fileId}-${file.sha256}.${file.mimeType === 'application/pdf' ? 'pdf' : file.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
});

test('same inputs reproduce entire plan and SQL, sorted identities ignore row order', () => {
  const first = transform();
  assert.deepEqual(transform(), first);
  assert.equal(generateSQL(transform()), generateSQL(first));
  const source = fixture(); source.sheets.Data_Pegawai.rows.reverse(); source.sheets.Arsip_Dokumen.rows.reverse();
  const reordered = transform(source);
  assert.deepEqual(reordered.tables, first.tables);
  assert.deepEqual(reordered.files, first.files);
  const otherSalt = transformExport(fixture(), { pepper, salt: Buffer.alloc(32, 0x72) });
  assert.notEqual(otherSalt.tables.akun[0].password_hash, first.tables.akun[0].password_hash);
});

test('legacy wrapped password independently verifies with WebCrypto and rejects counterexamples', async () => {
  const plan = transform();
  const stored = plan.tables.akun[0].password_hash;
  const [prefix, iterations, salt64, hash64] = stored.split('$');
  assert.equal(prefix, 'legacy-wrap'); assert.equal(iterations, '10000');
  assert.equal(Buffer.from(salt64, 'base64').length, 16);
  const encoder = new TextEncoder();
  async function verify(password, secret, hexAsBytes = false) {
    const hex = createHash('sha256').update(password).digest('hex');
    const hmac = await webcrypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const input = await webcrypto.subtle.sign('HMAC', hmac, hexAsBytes ? Buffer.from(hex, 'hex') : encoder.encode(hex));
    const key = await webcrypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 10000, salt: Buffer.from(salt64, 'base64') }, key, 256);
    return Buffer.from(bits).toString('base64') === hash64;
  }
  const password = plan.tables.pegawai[0].nip.slice(-6);
  assert.equal(await verify(password, pepper), true);
  assert.equal(await verify('wrong-password', pepper), false);
  assert.equal(await verify(password, 'wrong-pepper'), false);
  assert.equal(await verify(password, pepper, true), false);
  assert.equal(plan.tables.akun[0].is_default_password, 1);
  const source = fixture(); set(source, 'Data_Pegawai', 'Password_Hash', createHash('sha256').update('different password').digest('hex').toUpperCase());
  const changed = transform(source);
  assert.equal(changed.ready, true); assert.equal(changed.tables.akun[0].is_default_password, 0);
  assert.ok(!JSON.stringify(changed.tables).includes(source.sheets.Data_Pegawai.rows[0].values[1]));
});

test('headers are canonical names, not positions', () => {
  const source = fixture();
  for (const sheet of Object.values(source.sheets)) {
    sheet.headers.reverse();
    for (const row of sheet.rows) { row.values.reverse(); row.displayValues.reverse(); }
  }
  assert.deepEqual(transform(source).tables, transform().tables);
  assert.deepEqual(HEADERS.Data_Pegawai, fixture().sheets.Data_Pegawai.headers);
});

for (const [name, change, code] of [
  ['numeric NIP', (s) => set(s, 'Data_Pegawai', 'NIP', Number('199001012020011001')), 'NUMERIC_NIP'],
  ['numeric NIK', (s) => set(s, 'Data_Pegawai', 'NIK', 5371999900000001), 'NUMERIC_NIK'],
  ['scientific NIP', (s) => set(s, 'Data_Pegawai', 'NIP', '1.99001012020011e17'), 'INVALID_NIP'],
  ['short optional NIK', (s) => set(s, 'Data_Pegawai', 'NIK', '123'), 'INVALID_NIK'],
  ['duplicate NIP', (s) => append(s, 'Data_Pegawai', [...s.sheets.Data_Pegawai.rows[0].values]), 'DUPLICATE_NIP'],
  ['duplicate NIK', (s) => set(s, 'Data_Pegawai', 'NIK', '5371999900000001', 1), 'DUPLICATE_NIK'],
  ['null role', (s) => set(s, 'Data_Pegawai', 'Role', null), 'REQUIRED_VALUE'],
  ['unknown unit', (s) => set(s, 'Data_Pegawai', 'Unit_Organisasi', 'Seksi Penetapan'), 'UNKNOWN_UNIT'],
  ['unknown pangkat', (s) => set(s, 'Data_Pegawai', 'Pangkat_Golongan', 'unmapped'), 'UNKNOWN_PANGKAT'],
  ['unknown education', (s) => set(s, 'Data_Pegawai', 'Pendidikan_Terakhir', 'Guess S1'), 'UNKNOWN_PENDIDIKAN'],
  ['wrong rank family', (s) => set(s, 'Data_Pegawai', 'Pangkat_Golongan', 'PPPK-IX'), 'RANK_FAMILY_MISMATCH'],
  ['invalid date', (s) => set(s, 'Data_Pegawai', 'Tanggal_Lahir', '31/02/1990'), 'INVALID_DATE'],
  ['future birth', (s) => set(s, 'Data_Pegawai', 'Tanggal_Lahir', '2027-01-01'), 'FUTURE_BIRTH_DATE'],
  ['bad email', (s) => set(s, 'Data_Pegawai', 'Email', 'not-email'), 'INVALID_EMAIL'],
  ['bad phone', (s) => set(s, 'Data_Pegawai', 'No_HP', '12345'), 'INVALID_PHONE'],
  ['bad hash', (s) => set(s, 'Data_Pegawai', 'Password_Hash', 'plain-password'), 'INVALID_PASSWORD_HASH'],
  ['missing header', (s) => { s.sheets.Data_Pegawai.headers.pop(); }, 'MISSING_HEADER'],
  ['duplicate header', (s) => { s.sheets.Data_Pegawai.headers[1] = 'NIP'; }, 'DUPLICATE_OR_INVALID_HEADER'],
  ['unexpected header', (s) => { s.sheets.Data_Pegawai.headers.push('Token'); }, 'UNEXPECTED_HEADER'],
  ['short row', (s) => { s.sheets.Data_Pegawai.rows[0].values.pop(); }, 'ROW_LENGTH_MISMATCH'],
  ['session sheet', (s) => { s.sheets.Sesi_Login = { headers: ['Token'], rows: [] }; }, 'UNEXPECTED_SHEET'],
  ['secret property', (s) => { s.scriptProperties = { token: 'NEVER_LOG_THIS' }; }, 'UNEXPECTED_EXPORT_FIELD'],
  ['incomplete source', (s) => { s.isComplete = false; }, 'INCOMPLETE_EXPORT'],
  ['incorrect timezone', (s) => { s.sourceTimezone = 'UTC'; }, 'INVALID_SOURCE_TIMEZONE'],
  ['orphan archive', (s) => set(s, 'Arsip_Dokumen', 'NIP', '199099992020011009'), 'ORPHAN_NIP'],
  ['unknown archive jenis', (s) => set(s, 'Arsip_Dokumen', 'ID_Dokumen', 'DOC-UNKNOWN'), 'UNKNOWN_JENIS'],
  ['missing archive file', (s) => { s.fileManifest.splice(0, 1); }, 'MISSING_FILE_MANIFEST'],
  ['unavailable archive file', (s) => { s.fileManifest[0].status = 'missing'; }, 'FILE_UNAVAILABLE'],
  ['corrupt file hash', (s) => { s.fileManifest[0].sha256 = 'invalid'; }, 'INVALID_FILE_METADATA'],
  ['oversized file', (s) => { s.fileManifest[0].sizeBytes = 5242881; }, 'INVALID_FILE_METADATA'],
  ['unsafe drive ID', (s) => set(s, 'Arsip_Dokumen', 'File_Drive_ID', '../unsafe/file'), 'INVALID_DRIVE_ID'],
  ['noncanonical MIME', (s) => { s.fileManifest[0].mimeType = 'application/x-pdf'; }, 'INVALID_FILE_MIME'],
  ['PDF photo', (s) => { s.fileManifest[2].mimeType = 'application/pdf'; }, 'INVALID_FILE_MIME'],
  ['missing verified timestamp', (s) => set(s, 'Arsip_Dokumen', 'Waktu_Verifikasi', ''), 'REQUIRED_VALUE'],
  ['invalid log time', (s) => set(s, 'Log_Aktivitas', 'Timestamp', 'yesterday'), 'INVALID_DATE'],
  ['NUL text', (s) => set(s, 'Data_Pegawai', 'Nama_Lengkap', 'secret\0name'), 'INVALID_TEXT'],
  ['dash NIP', (s) => set(s, 'Data_Pegawai', 'NIP', '-'), 'INVALID_NIP'],
  ['dash optional NIK', (s) => set(s, 'Data_Pegawai', 'NIK', '-'), 'INVALID_NIK'],
  ['dash birth date', (s) => set(s, 'Data_Pegawai', 'Tanggal_Lahir', '-'), 'INVALID_DATE'],
  ['dash TMT date', (s) => set(s, 'Data_Pegawai', 'TMT_Pangkat', '-'), 'INVALID_DATE'],
  ['dash employment status', (s) => set(s, 'Data_Pegawai', 'Status_Kepegawaian', '-'), 'INVALID_STATUS_KEPEGAWAIAN'],
  ['dash account status', (s) => set(s, 'Data_Pegawai', 'Status_Akun', '-'), 'INVALID_STATUS_AKUN'],
  ['en-dash pangkat', (s) => set(s, 'Data_Pegawai', 'Pangkat_Golongan', '\u2013'), 'UNKNOWN_PANGKAT'],
  ['dash-prefixed pangkat', (s) => set(s, 'Data_Pegawai', 'Pangkat_Golongan', '-x'), 'UNKNOWN_PANGKAT'],
  ['en-dash unit', (s) => set(s, 'Data_Pegawai', 'Unit_Organisasi', '\u2013'), 'UNKNOWN_UNIT'],
  ['dash-prefixed education', (s) => set(s, 'Data_Pegawai', 'Pendidikan_Terakhir', '-x'), 'UNKNOWN_PENDIDIKAN'],
]) {
  test(`fail closed: ${name}`, () => {
    const source = fixture(); change(source);
    const plan = transform(source);
    assert.equal(plan.ready, false); assert.ok(codes(plan).includes(code), JSON.stringify(plan.diagnostics));
    assert.throws(() => generateSQL(plan), /PLAN_NOT_READY/);
    const report = JSON.stringify(reportFor(plan));
    assert.ok(!report.includes('199001012020011001')); assert.ok(!report.includes('NEVER_LOG_THIS'));
    for (const d of plan.diagnostics) assert.deepEqual(Object.keys(d), ['severity', 'sheet', 'rowNumber', 'code']);
  });
}

test('strict date-only conversion uses WITA and never guesses MM/dd', () => {
  assert.equal(dateOnly({ $date: '1990-01-01T16:00:00.000Z' }), '1990-01-02');
  assert.equal(dateOnly('03/04/1990'), '1990-04-03');
  assert.equal(dateOnly('29/02/2000'), '2000-02-29');
  for (const value of ['02/29/2000', '29/02/1900', '2026-02-30', '01/01/00', '1/2/2000', '1899-12-31', '2101-01-01', { $date: '1899-12-30T16:00:00.000Z' }, { $date: '2100-12-31T16:00:00.000Z' }]) assert.throws(() => dateOnly(value));
  assert.equal(timestamp('2026-10-16T08:00:00'), '2026-10-16T00:00:00.000Z');
  assert.throws(() => timestamp('2026-10-16T25:00:00Z'));
});

const placeholderNips = syntheticFixture().snapshot.sheets.Data_Pegawai.rows.map((r) => r.values[0]);
for (const value of ['-', '--', "'-", '  -  ', "'' --- "]) {
  test(`dash placeholder ${JSON.stringify(value)} in rank becomes null with one exact warning`, () => {
    const source = fixture();
    set(source, 'Data_Pegawai', 'Pangkat_Golongan', value);
    const plan = transform(source);
    assert.equal(plan.ready, true, JSON.stringify(plan.diagnostics));
    assert.equal(plan.tables.pegawai[0].pangkat_kode, null);
    const warnings = plan.diagnostics.filter((d) => d.code === 'PLACEHOLDER_PANGKAT');
    assert.deepEqual(warnings, [{ severity: 'warning', sheet: 'Data_Pegawai', rowNumber: source.sheets.Data_Pegawai.rows[0].rowNumber, code: 'PLACEHOLDER_PANGKAT' }]);
    assert.deepEqual(Object.keys(warnings[0]), ['severity', 'sheet', 'rowNumber', 'code']);
    assert.ok(!plan.diagnostics.some((d) => d.code === 'NORMALIZED_PANGKAT' && d.rowNumber === warnings[0].rowNumber));
  });
}

test('dash placeholder in unit, education and PPPK rank becomes null without guessing', () => {
  const source = fixture();
  const rowNumbers = source.sheets.Data_Pegawai.rows.map((r) => r.rowNumber);
  set(source, 'Data_Pegawai', 'Unit_Organisasi', '-', 0);
  set(source, 'Data_Pegawai', 'Pendidikan_Terakhir', '-', 1);
  set(source, 'Data_Pegawai', 'Pangkat_Golongan', '-', 2);
  const plan = transform(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.tables.pegawai[0].unit_id, null);
  assert.equal(plan.tables.pegawai[1].pendidikan_kode, null);
  assert.equal(plan.tables.pegawai[2].pangkat_kode, null);
  assert.equal(plan.tables.pegawai[2].status_kepegawaian, 'PPPK');
  const placeholders = plan.diagnostics.filter((d) => d.code.startsWith('PLACEHOLDER_'));
  assert.deepEqual(placeholders, [
    { severity: 'warning', sheet: 'Data_Pegawai', rowNumber: rowNumbers[0], code: 'PLACEHOLDER_UNIT' },
    { severity: 'warning', sheet: 'Data_Pegawai', rowNumber: rowNumbers[1], code: 'PLACEHOLDER_PENDIDIKAN' },
    { severity: 'warning', sheet: 'Data_Pegawai', rowNumber: rowNumbers[2], code: 'PLACEHOLDER_PANGKAT' },
  ]);
  const report = JSON.stringify(reportFor(plan));
  for (const nip of placeholderNips) assert.ok(!report.includes(nip));
});

test('placeholder override keys are rejected; other dash-like keys stay valid', () => {
  for (const overrides of [
    { pangkat: { '-': 'III/a' } }, { pangkat: { '--': 'III/a' } }, { pangkat: { "'-": 'III/a' } }, { pangkat: { ' - ': 'PPPK-IX' } },
    { unit: { '-': 1 } }, { unit: { "'--": 2 } }, { pendidikan: { '-': 'S1' } }, { pendidikan: { ' -- ': 'SMA' } },
    { pangkat: { '-x': 'III/a', '-': 'III/a' } },
  ]) {
    assert.throws(() => validateOverrides(overrides), /^Error: INVALID_OVERRIDES$/);
    const plan = transform(fixture(), overrides);
    assert.equal(plan.ready, false);
    assert.deepEqual(plan.diagnostics.filter((d) => d.severity === 'error'), [{ severity: 'error', sheet: 'export', rowNumber: null, code: 'INVALID_OVERRIDES' }]);
    assert.equal(plan.tables.pegawai.length, 0);
  }
  assert.doesNotThrow(() => validateOverrides({ pangkat: { '-x': 'III/a', '\u2013': 'III/b', 'a-b': 'III/c' }, unit: { '\u2014': 3 }, pendidikan: { '-S1': 'S1' }, jenis: { '-': 'DOC-CUSTOM' } }));
  const source = fixture();
  set(source, 'Data_Pegawai', 'Pangkat_Golongan', '-', 0);
  set(source, 'Data_Pegawai', 'Pangkat_Golongan', '-x', 1);
  set(source, 'Data_Pegawai', 'Unit_Organisasi', '\u2013', 1);
  const plan = transform(source, { pangkat: { '-x': 'III/c' }, unit: { '\u2013': 2 } });
  assert.equal(plan.ready, true, JSON.stringify(plan.diagnostics));
  assert.equal(plan.tables.pegawai[0].pangkat_kode, null);
  assert.equal(plan.tables.pegawai[1].pangkat_kode, 'III/c');
  assert.equal(plan.tables.pegawai[1].unit_id, 2);
  const [first, second] = source.sheets.Data_Pegawai.rows.map((r) => r.rowNumber);
  assert.deepEqual(plan.diagnostics.filter((d) => [first, second].includes(d.rowNumber) && /_(PANGKAT|UNIT)$/.test(d.code)).map((d) => [d.rowNumber, d.code]), [
    [first, 'PLACEHOLDER_PANGKAT'], [first, 'NORMALIZED_UNIT'], [second, 'NORMALIZED_PANGKAT'], [second, 'NORMALIZED_UNIT'],
  ]);
});

test('placeholder CLI report and stdout carry codes only, no PII', async (t) => {
  const directory = await temporary(t); const source = fixture();
  set(source, 'Data_Pegawai', 'Pangkat_Golongan', '-', 2);
  set(source, 'Data_Pegawai', 'Unit_Organisasi', '--', 1);
  const args = await cliInput(directory, source);
  const result = spawnSync(process.execPath, [resolve('scripts/migrate/transform.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout); assert.equal(result.stderr, '');
  const report = await readFile(join(directory, 'output', 'report.sikap-report.json'), 'utf8');
  const parsed = JSON.parse(report);
  assert.ok(parsed.diagnostics.some((d) => d.code === 'PLACEHOLDER_PANGKAT') && parsed.diagnostics.some((d) => d.code === 'PLACEHOLDER_UNIT'));
  for (const d of parsed.diagnostics) assert.deepEqual(Object.keys(d), ['severity', 'sheet', 'rowNumber', 'code']);
  for (const output of [report, result.stdout]) {
    for (const nip of placeholderNips) assert.ok(!output.includes(nip));
    for (const secret of [pepper, 'Sintetis', '@example.test', '5371999900000001']) assert.ok(!output.includes(secret));
  }
});

test('explicit overrides resolve unknowns, no defaults; blanks stay null', () => {
  const source = fixture();
  set(source, 'Data_Pegawai', 'NIP', "'199001012020011001");
  set(source, 'Data_Pegawai', 'Unit_Organisasi', 'Seksi Penetapan');
  set(source, 'Data_Pegawai', 'Pendidikan_Terakhir', 'S-1 / Ilmu Contoh');
  set(source, 'Data_Pegawai', 'Email', 'User@EXAMPLE.TEST');
  set(source, 'Data_Pegawai', 'NIK', '');
  set(source, 'Data_Pegawai', 'Status_Akun', 'Ganti_Password');
  set(source, 'Data_Pegawai', 'Status_Akun', 'Nonaktif', 1);
  const plan = transform(source, { unit: { 'Seksi Penetapan': 2 } });
  assert.equal(plan.ready, true); assert.equal(plan.tables.pegawai[0].nik, null);
  assert.equal(plan.tables.pegawai[0].unit_id, 2); assert.equal(plan.tables.pegawai[0].email, 'user@example.test');
  assert.equal(plan.tables.pegawai[0].status_akun, 'Aktif'); assert.equal(plan.tables.pegawai[1].status_akun, 'Nonaktif');
  assert.ok(codes(plan).includes('NORMALIZED_GANTI_PASSWORD'));
  assert.ok(codes(plan).includes('NORMALIZED_PENDIDIKAN'));
  assert.equal(transform(source, { unit: { 'Seksi Penetapan': 99 } }).ready, false);
});

test('custom optional jenis allowed, custom required matrix never guessed', () => {
  const source = fixture(); append(source, 'Master_Dokumen', ['DOC-CUSTOM', 'Synthetic Custom', 'Custom category', 'Tidak']);
  let plan = transform(source);
  assert.equal(plan.ready, true); assert.ok(codes(plan).includes('CUSTOM_JENIS_OPTIONAL'));
  assert.equal(plan.tables.jenis_dokumen_wajib.filter((r) => r.jenis_dokumen_id === 'DOC-CUSTOM').length, 0);
  set(source, 'Master_Dokumen', 'Status_Wajib', 'Ya', 11);
  plan = transform(source); assert.equal(plan.ready, false); assert.ok(codes(plan).includes('UNMAPPED_REQUIREMENT_MATRIX'));
});

test('latest archive wins deterministically, equal-time different files rejected', () => {
  const source = fixture();
  const old = [...source.sheets.Arsip_Dokumen.rows[0].values]; old[0] = 'older-id'; old[7] = '2026-10-15T00:00:00Z';
  append(source, 'Arsip_Dokumen', old);
  let plan = transform(source);
  assert.equal(plan.ready, true); assert.equal(plan.tables.arsip_dokumen.length, 2);
  assert.ok(codes(plan).includes('DUPLICATE_ARCHIVE_SUPERSEDED'));
  const duplicate = [...source.sheets.Arsip_Dokumen.rows[0].values]; duplicate[0] = 'another-id'; duplicate[3] = source.fileManifest[1].fileId;
  append(source, 'Arsip_Dokumen', duplicate);
  plan = transform(source); assert.equal(plan.ready, false); assert.ok(codes(plan).includes('AMBIGUOUS_DUPLICATE'));
});

test('photo references shared across employees fail closed without changing key protocol', () => {
  const source = fixture();
  set(source, 'Data_Pegawai', 'Foto_Drive_ID', "'synthetic_photo_0001", 0);
  const plan = transform(source);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.diagnostics.filter((d) => d.code === 'SHARED_PHOTO_REFERENCE').map((d) => [d.sheet, d.rowNumber]), [['Data_Pegawai', 2], ['Data_Pegawai', 3]]);
  assert.throws(() => generateSQL(plan), /PLAN_NOT_READY/);
  const report = JSON.stringify(reportFor(plan));
  assert.ok(!report.includes('synthetic_photo_0001'));
  assert.ok(!report.includes('199001012020011001'));
});

for (const [name, change] of [
  ['status', (row) => { row[5] = 'Ditolak'; }],
  ['verifier', (row) => { row[9] = '199003032022033003'; }],
  ['note', (row) => { row[6] = 'Conflicting synthetic note.'; }],
  ['verification time', (row) => { row[8] = '2026-10-16T00:00:01Z'; }],
]) {
  test(`equal upload and file with conflicting ${name} fails closed`, () => {
    const source = fixture();
    const duplicate = [...source.sheets.Arsip_Dokumen.rows[0].values];
    duplicate[0] = 'zzz-conflicting-id'; change(duplicate);
    append(source, 'Arsip_Dokumen', duplicate);
    const plan = transform(source);
    assert.equal(plan.ready, false); assert.ok(codes(plan).includes('AMBIGUOUS_DUPLICATE'));
    assert.throws(() => generateSQL(plan), /PLAN_NOT_READY/);
  });
}

test('equal-time purged verifiers remain distinguishable before nullable ID mapping', () => {
  const source = fixture();
  set(source, 'Arsip_Dokumen', 'NIP_Verifier', '199099992020011009');
  const duplicate = [...source.sheets.Arsip_Dokumen.rows[0].values];
  duplicate[0] = 'zzz-purged-verifier'; duplicate[9] = '199099992020011008';
  append(source, 'Arsip_Dokumen', duplicate);
  const plan = transform(source);
  assert.equal(plan.ready, false); assert.ok(codes(plan).includes('AMBIGUOUS_DUPLICATE'));
});

test('equal-time historical conflicts are rejected even when a newer archive exists', () => {
  const source = fixture();
  const original = source.sheets.Arsip_Dokumen.rows[0].values;
  for (const [id, note] of [['older-a', 'First outcome.'], ['older-b', 'Second outcome.']]) {
    const duplicate = [...original]; duplicate[0] = id; duplicate[6] = note; duplicate[7] = '2026-10-15T00:00:00Z';
    append(source, 'Arsip_Dokumen', duplicate);
  }
  const plan = transform(source);
  assert.equal(plan.ready, false); assert.ok(codes(plan).includes('AMBIGUOUS_DUPLICATE'));
});

for (const [name, change] of [
  ['slot', (row) => { row[2] = 'DOC-NPWP'; }],
  ['upload time', (row) => { row[7] = '2026-10-15T00:00:00Z'; }],
  ['verification state', (row) => { row[5] = 'Ditolak'; }],
  ['empty/uploaded state', (row) => { row[5] = 'Belum_Unggah'; }],
]) {
  test(`conflicting source archive ID reuse rejects changed ${name}`, () => {
    const source = fixture();
    const duplicate = [...source.sheets.Arsip_Dokumen.rows[0].values]; change(duplicate);
    append(source, 'Arsip_Dokumen', duplicate);
    const plan = transform(source);
    assert.equal(plan.ready, false); assert.ok(codes(plan).includes('CONFLICTING_ARCHIVE_ID'));
  });
}

test('identical archive duplicates are allowed with warning and deterministic output', () => {
  for (const identicalId of [true, false]) {
    const source = fixture();
    const duplicate = [...source.sheets.Arsip_Dokumen.rows[0].values];
    if (!identicalId) duplicate[0] = 'zzz-identical-outcome';
    append(source, 'Arsip_Dokumen', duplicate);
    const plan = transform(source);
    assert.equal(plan.ready, true); assert.ok(codes(plan).includes('DUPLICATE_ARCHIVE_SUPERSEDED'));
    assert.deepEqual(plan.tables, transform().tables);
    source.sheets.Arsip_Dokumen.rows.reverse();
    const reordered = transform(source);
    assert.deepEqual(reordered.tables, plan.tables);
    assert.deepEqual(reordered.diagnostics, plan.diagnostics);
    assert.equal(generateSQL(reordered), generateSQL(plan));
  }
});

for (const [classification, target, row] of [['optional', 'DOC-KARPEG', 9], ['required', 'DOC-KTP', 0]]) {
  test(`custom required matrix cannot be bypassed with an override to a known ${classification} ID`, () => {
    const source = fixture();
    set(source, 'Master_Dokumen', 'ID_Dokumen', 'DOC-CUSTOM', row);
    set(source, 'Master_Dokumen', 'Status_Wajib', 'Ya', row);
    const plan = transform(source, { jenis: { 'DOC-CUSTOM': target } });
    assert.equal(plan.ready, false);
    assert.ok(plan.diagnostics.some((d) => d.sheet === 'Master_Dokumen' && d.rowNumber === row + 2 && d.code === 'UNMAPPED_REQUIREMENT_MATRIX'));
    assert.ok(!plan.tables.jenis_dokumen.some((d) => d.id === target));
    assert.ok(!plan.tables.jenis_dokumen_wajib.some((d) => d.jenis_dokumen_id === target));
    assert.throws(() => generateSQL(plan), /PLAN_NOT_READY/);
    assert.ok(!JSON.stringify(reportFor(plan)).includes('DOC-CUSTOM'));
  });
}

test('unknown required source classification is rejected before target ID collisions', () => {
  const source = fixture();
  set(source, 'Master_Dokumen', 'ID_Dokumen', 'DOC-CUSTOM', 9);
  set(source, 'Master_Dokumen', 'Status_Wajib', 'Ya', 9);
  const plan = transform(source, { jenis: { 'DOC-CUSTOM': 'DOC-KTP' } });
  assert.equal(plan.ready, false);
  assert.ok(plan.diagnostics.some((d) => d.sheet === 'Master_Dokumen' && d.rowNumber === 11 && d.code === 'UNMAPPED_REQUIREMENT_MATRIX'));
});

for (const [sheet, field, limit, row] of [
  ['Data_Pegawai', 'Nama_Lengkap', 150, 0], ['Data_Pegawai', 'Jabatan', 150, 0],
  ['Data_Pegawai', 'Alamat', 500, 0], ['Data_Pegawai', 'Tempat_Lahir', 100, 0],
  ['Master_Dokumen', 'Nama_Dokumen', 150, 0], ['Master_Dokumen', 'Kategori', 100, 0],
  ['Arsip_Dokumen', 'Catatan_Admin', 500, 0],
]) {
  test(`target ${field} limit accepts boundary and rejects overflow without truncation`, () => {
    const source = fixture();
    set(source, sheet, field, 'x'.repeat(limit), row);
    assert.equal(transform(source).ready, true);
    set(source, sheet, field, 'x'.repeat(limit + 1), row);
    const invalid = transform(source);
    assert.equal(invalid.ready, false); assert.ok(codes(invalid).includes('INVALID_TEXT'));
  });
}

test('target phone normalization accepts local 8 prefix and punctuation', () => {
  const source = fixture();
  set(source, 'Data_Pegawai', 'No_HP', '812.9999-0001');
  const plan = transform(source);
  assert.equal(plan.ready, true); assert.equal(plan.tables.pegawai[0].no_hp, '6281299990001');
});

test('strict exporter envelope still rejects top-level issues', () => {
  const source = fixture(); source.issues = [];
  const plan = transform(source);
  assert.equal(plan.ready, false); assert.ok(codes(plan).includes('UNEXPECTED_EXPORT_FIELD'));
});

test('Belum_Unggah skips counted; purged historic actor/verifier become null warnings', () => {
  const source = fixture();
  const empty = [...source.sheets.Arsip_Dokumen.rows[0].values]; empty[0] = 'empty'; empty[2] = 'DOC-NPWP'; empty[3] = ''; empty[5] = 'Belum_Unggah';
  append(source, 'Arsip_Dokumen', empty);
  set(source, 'Arsip_Dokumen', 'NIP_Verifier', '199099992020011009');
  set(source, 'Log_Aktivitas', 'Actor_NIP', '199099992020011009');
  const plan = transform(source);
  assert.equal(plan.ready, true); assert.equal(plan.expected.arsip, 2);
  assert.equal(reportFor(plan).counts.skippedBelumUnggah, 1);
  assert.equal(plan.tables.arsip_dokumen[0].verified_by, null);
  assert.equal(plan.tables.log_aktivitas[0].actor_id, null); assert.equal(plan.tables.log_aktivitas[0].actor_nama, null);
  assert.ok(codes(plan).includes('MISSING_HISTORIC_VERIFIER'));
});

test('SQL quotes user values and rejects structural injection, NUL and wrong scalar types', () => {
  const source = fixture(); set(source, 'Data_Pegawai', 'Nama_Lengkap', "O'Brien'); DROP TABLE akun;--");
  const plan = transform(source); const sql = generateSQL(plan);
  assert.ok(sql.includes("'O''Brien''); DROP TABLE akun;--'"));
  assert.ok(!/\b(?:BEGIN|COMMIT|REPLACE)\b/.test(sql));
  assert.ok(!sql.includes('DELETE FROM pegawai'));
  assert.ok(sql.includes("DELETE FROM jenis_dokumen_wajib WHERE jenis_dokumen_id = 'DOC-KTP';"));
  assert.equal(sqlValue(null), 'NULL'); assert.equal(sqlValue(42), '42');
  for (const value of ['a\0b', true, {}, 1.5, Infinity]) assert.throws(() => sqlValue(value), /INVALID_SQL_VALUE/);
  const injected = structuredClone(plan); injected.tables.pegawai[0]['evil); DROP TABLE akun'] = 'x';
  assert.throws(() => generateSQL(injected), /INVALID_SQL_COLUMN/);
});

test('CLI writes private outputs and refuses every existing artifact without overwrite', async (t) => {
  const directory = await temporary(t); const args = await cliInput(directory);
  const report = await runCLI(args);
  assert.equal(report.ready, true);
  const output = join(directory, 'output');
  assert.deepEqual((await readdir(output)).sort(), ['import.sikap-import.sql', 'plan.sikap-plan.json', 'report.sikap-report.json']);
  const content = await readFile(join(output, 'plan.sikap-plan.json'), 'utf8');
  await assert.rejects(() => runCLI(args), /OUTPUT_EXISTS/);
  assert.equal(await readFile(join(output, 'plan.sikap-plan.json'), 'utf8'), content);
  assert.equal(JSON.parse(content).tables.akun[0].password_hash, transform().tables.akun[0].password_hash);
  if (process.platform !== 'win32') {
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    for (const file of await readdir(output)) assert.equal((await stat(join(output, file))).mode & 0o777, 0o600);
  }
});

test('invalid plan CLI writes report and nonready plan, never SQL; process exits 1 without PII', async (t) => {
  const directory = await temporary(t); const source = fixture(); set(source, 'Data_Pegawai', 'NIP', Number('199001012020011001'));
  const args = await cliInput(directory, source);
  const result = spawnSync(process.execPath, [resolve('scripts/migrate/transform.mjs'), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.ok(!result.stdout.includes('199001012020011001'));
  assert.ok(!result.stdout.includes(pepper)); assert.equal(result.stderr, '');
  assert.deepEqual((await readdir(join(directory, 'output'))).sort(), ['plan.sikap-plan.json', 'report.sikap-report.json']);
  assert.equal(JSON.parse(await readFile(join(directory, 'output', 'plan.sikap-plan.json'), 'utf8')).ready, false);
});

test('CLI rejects remote/force/duplicate flags, bounded input, weak salt and symlink paths', async (t) => {
  assert.throws(() => parseArguments(['--remote']), /INVALID_ARGUMENTS/);
  const directory = await temporary(t); const args = await cliInput(directory);
  assert.throws(() => parseArguments([...args, '--force', 'true']), /INVALID_ARGUMENTS/);
  assert.throws(() => parseArguments([...args, '--input', 'again']), /INVALID_ARGUMENTS/);
  await assert.rejects(() => readBoundedFile(join(directory, 'input.json'), 10), /INPUT_SIZE_OR_TYPE/);
  await writeFile(join(directory, 'salt'), Buffer.alloc(16).toString('base64'));
  await assert.rejects(() => runCLI(args), /INVALID_SALT/);
  await writeFile(join(directory, 'salt'), salt.toString('base64'));
  try { await symlink(join(directory, 'pepper'), join(directory, 'pepper-link'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows symlink creation unavailable; directory-junction check still exercised'); } else throw error; }
  try { await stat(join(directory, 'pepper-link')); await assert.rejects(() => readBoundedFile(join(directory, 'pepper-link'), 65536), /SYMLINK_REFUSED/); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(join(directory, 'real-directory'));
  await symlink(join(directory, 'real-directory'), join(directory, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const changed = [...args]; changed[3] = join(directory, 'junction', 'new-output');
  await assert.rejects(() => runCLI(changed), /SYMLINK_REFUSED/);
});
