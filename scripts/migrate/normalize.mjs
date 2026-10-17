// Pure offline normalizers. Mirrors shared/enums.ts and migration 0002; no app imports.
export const HEADERS = Object.freeze({
  Data_Pegawai: ['NIP', 'Password_Hash', 'Role', 'Status_Akun', 'Nama_Lengkap', 'Status_Kepegawaian', 'Pangkat_Golongan', 'Jabatan', 'No_HP', 'Alamat', 'Folder_Drive_ID', 'Email', 'Golongan_Darah', 'NIK', 'Tempat_Lahir', 'Tanggal_Lahir', 'Jenis_Kelamin', 'Agama', 'Pendidikan_Terakhir', 'Status_Pernikahan', 'TMT_Pangkat', 'Jenis_Jabatan', 'TMT_Jabatan', 'Unit_Organisasi', 'Foto_Drive_ID'],
  Master_Dokumen: ['ID_Dokumen', 'Nama_Dokumen', 'Kategori', 'Status_Wajib'],
  Arsip_Dokumen: ['ID_Arsip', 'NIP', 'ID_Dokumen', 'File_Drive_ID', 'File_URL', 'Status_Verifikasi', 'Catatan_Admin', 'Waktu_Upload', 'Waktu_Verifikasi', 'NIP_Verifier'],
  Log_Aktivitas: ['Log_ID', 'Timestamp', 'Actor_NIP', 'Actor_Role', 'Action', 'Target_Type', 'Target_ID', 'Description', 'Result'],
});
export const ENUMS = Object.freeze({
  role: ['Admin', 'Pegawai'], status_akun: ['Aktif', 'Nonaktif'], status_kepegawaian: ['PNS', 'CPNS', 'PPPK'],
  jenis_jabatan: ['Fungsional', 'Pelaksana', 'Struktural'], jenis_kelamin: ['Laki-laki', 'Perempuan'],
  agama: ['Kristen Protestan', 'Kristen Katholik', 'Islam', 'Hindu', 'Buddha', 'Konghucu'],
  status_pernikahan: ['Belum Menikah', 'Menikah', 'Cerai'], golongan_darah: ['A', 'B', 'AB', 'O', 'Tidak Tahu'],
  status: ['Menunggu', 'Terverifikasi', 'Ditolak'], result: ['SUCCESS', 'FAILURE', 'WARNING', 'PARTIAL'],
});
export const KNOWN_JENIS = ['DOC-KTP', 'DOC-KK', 'DOC-NPWP', 'DOC-SK-CPNS', 'DOC-SPMT-CPNS', 'DOC-SK-PNS', 'DOC-DRH', 'DOC-IJAZAH', 'DOC-SKP', 'DOC-KARPEG', 'DOC-TASPEN'];
export const REQUIRED = Object.freeze({
  PNS: KNOWN_JENIS.slice(0, 9),
  CPNS: ['DOC-KTP', 'DOC-KK', 'DOC-NPWP', 'DOC-SK-CPNS', 'DOC-SPMT-CPNS', 'DOC-DRH', 'DOC-IJAZAH'],
  PPPK: ['DOC-KTP', 'DOC-KK', 'DOC-NPWP', 'DOC-DRH', 'DOC-IJAZAH', 'DOC-SKP'],
});
const pnsNames = ['Juru Muda', 'Juru Muda Tk. I', 'Juru', 'Juru Tk. I', 'Pengatur Muda', 'Pengatur Muda Tk. I', 'Pengatur', 'Pengatur Tk. I', 'Penata Muda', 'Penata Muda Tk. I', 'Penata', 'Penata Tk. I', 'Pembina', 'Pembina Tk. I', 'Pembina Utama Muda', 'Pembina Utama Madya', 'Pembina Utama'];
const pnsCodes = ['I/a', 'I/b', 'I/c', 'I/d', 'II/a', 'II/b', 'II/c', 'II/d', 'III/a', 'III/b', 'III/c', 'III/d', 'IV/a', 'IV/b', 'IV/c', 'IV/d', 'IV/e'];
const romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII'];
const ranks = new Map();
for (const [i, code] of pnsCodes.entries()) {
  for (const name of [code, `${pnsNames[i]} (${code})`, `${pnsNames[i]} / ${code.replace('/', '.')}`]) ranks.set(name, code);
}
for (const roman of romans) {
  ranks.set(`PPPK-${roman}`, `PPPK-${roman}`);
  ranks.set(`Golongan ${roman}`, `PPPK-${roman}`);
}
ranks.set('Ahli Pertama (IX)', 'PPPK-IX');
const units = new Map([['Subbagian Tata Usaha', 1], ['Seksi Penetapan dan Penagihan', 2], ['Seksi Verifikasi', 3]]);
const educationNames = ['SMA / SMK / Sederajat', 'D-I / Diploma Satu', 'D-II / Diploma Dua', 'D-III / Diploma Tiga', 'D-IV / Sarjana Terapan', 'S-1 / Sarjana', 'S-2 / Magister', 'S-3 / Doktoral'];
const educationCodes = ['SMA', 'D1', 'D2', 'D3', 'D4', 'S1', 'S2', 'S3'];
const educations = new Map(educationCodes.flatMap((c, i) => [[c, c], [educationNames[i], c]]));
const educationPrefixes = new Map([['D-I', 'D1'], ['D-II', 'D2'], ['D-III', 'D3'], ['D-IV', 'D4'], ['S-1', 'S1'], ['S-2', 'S2'], ['S-3', 'S3']]);
export const MIME_EXT = Object.freeze({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
export const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const DOC_ID = /^DOC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export function fail(code) { throw new Error(code); }
export function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function text(value, { required = false, min = 0, max = 4096 } = {}) {
  if (value === null || value === '') { if (required) fail('REQUIRED_VALUE'); return null; }
  if (typeof value !== 'string') fail('INVALID_TEXT');
  const result = value.replace(/^'+/, '').trim();
  if (result.includes('\0') || result.length > max) fail('INVALID_TEXT');
  if (!result) { if (required) fail('REQUIRED_VALUE'); return null; }
  if (result.length < min) fail('INVALID_TEXT');
  return result;
}
export function identity(value, kind = 'NIP', optional = false) {
  if (typeof value === 'number') fail(`NUMERIC_${kind}`);
  const result = text(value, { required: !optional, max: 32 });
  if (result !== null && !new RegExp(`^\\d{${kind === 'NIK' ? 16 : 18}}$`).test(result)) fail(`INVALID_${kind}`);
  return result;
}
export function enumValue(value, kind, optional = true) {
  const result = text(value, { required: !optional, max: 64 });
  if (result !== null && !ENUMS[kind].includes(result)) fail(`INVALID_${kind.toUpperCase()}`);
  return result;
}
function validDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function utcTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !validDay(value.slice(0, 10))) fail('INVALID_TIMESTAMP');
  const [hh, mm, ss] = value.slice(11, 19).split(':').map(Number);
  if (hh > 23 || mm > 59 || ss > 59) fail('INVALID_TIMESTAMP');
  return new Date(value).toISOString();
}
export function dateOnly(value) {
  if (value === null || value === '') return null;
  let day;
  if (isRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, '$date')) {
    const time = utcTimestamp(value.$date);
    // WITA is UTC+08 with no daylight-saving transitions.
    day = new Date(Date.parse(time) + 8 * 3600_000).toISOString().slice(0, 10);
  } else {
    const input = text(value, { required: true, max: 32 });
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
    day = match ? `${match[3]}-${match[2]}-${match[1]}` : input;
  }
  const year = Number(day.slice(0, 4));
  if (!validDay(day) || year < 1900 || year > 2100) fail('INVALID_DATE');
  return day;
}
export function timestamp(value, optional = false) {
  if ((value === null || value === '') && optional) return null;
  if (isRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, '$date')) return utcTimestamp(value.$date);
  const input = text(value, { required: true, max: 40 });
  if (input.endsWith('Z')) return utcTimestamp(input);
  // Legacy getTimestamp() writes an ISO-shaped WITA local time without an offset.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(input)) {
    return new Date(Date.parse(utcTimestamp(`${input}Z`)) - 8 * 3600_000).toISOString();
  }
  return new Date(Date.parse(`${dateOnly(input)}T00:00:00.000Z`) - 8 * 3600_000).toISOString();
}
export function reference(value, kind, overrides, warn) {
  const input = text(value, { max: 256 });
  if (input === null) return null;
  // Legacy placeholder for "none" (seen on PPPK rows without golongan). Treated as
  // empty with a warning; it is never mapped to a real reference by guessing.
  if (/^-+$/.test(input)) { warn(`PLACEHOLDER_${kind.toUpperCase()}`); return null; }
  const mapped = overrides[kind];
  let result;
  if (Object.hasOwn(mapped, input)) result = mapped[input];
  else if (kind === 'pangkat') result = ranks.get(input);
  else if (kind === 'unit') result = units.get(input);
  else {
    result = educations.get(input);
    if (!result) {
      const match = /^(D-I|D-II|D-III|D-IV|S-1|S-2|S-3) \/ [^\r\n]+$/.exec(input);
      if (match) result = educationPrefixes.get(match[1]);
    }
  }
  const valid = kind === 'unit' ? [1, 2, 3].includes(result) : kind === 'pangkat' ? [...pnsCodes, ...romans.map((r) => `PPPK-${r}`)].includes(result) : educationCodes.includes(result);
  if (!valid) fail(`UNKNOWN_${kind.toUpperCase()}`);
  if (result !== input) warn(`NORMALIZED_${kind.toUpperCase()}`);
  return result;
}
export function validateOverrides(value = {}) {
  if (!isRecord(value) || Object.keys(value).some((key) => !['pangkat', 'unit', 'pendidikan', 'jenis'].includes(key))) fail('INVALID_OVERRIDES');
  const result = {};
  for (const key of ['pangkat', 'unit', 'pendidikan', 'jenis']) {
    result[key] = value[key] ?? {};
    if (!isRecord(result[key])) fail('INVALID_OVERRIDES');
    for (const [from, to] of Object.entries(result[key])) {
      if (!from || from.includes('\0') || (key === 'unit' ? ![1, 2, 3].includes(to) : typeof to !== 'string')) fail('INVALID_OVERRIDES');
      // reference() resolves dash placeholders before consulting overrides, so
      // such keys could never apply; reject them instead of ignoring silently.
      if (key !== 'jenis' && /^-+$/.test(from.replace(/^'+/, '').trim())) fail('INVALID_OVERRIDES');
      if (key === 'jenis' && (!DOC_ID.test(to) || to.length > 64)) fail('INVALID_OVERRIDES');
      if (key === 'pangkat' && ![...pnsCodes, ...romans.map((r) => `PPPK-${r}`)].includes(to)) fail('INVALID_OVERRIDES');
      if (key === 'pendidikan' && !educationCodes.includes(to)) fail('INVALID_OVERRIDES');
    }
  }
  return result;
}
export function phone(value) {
  const input = text(value, { max: 40 });
  if (input === null) return null;
  let result = input.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(result)) fail('INVALID_PHONE');
  if (result.startsWith('0')) result = `62${result.slice(1)}`;
  else if (result.startsWith('8')) result = `62${result}`;
  if (!result.startsWith('62') || result.length < 10 || result.length > 15) fail('INVALID_PHONE');
  return result;
}
export function email(value) {
  const result = text(value, { max: 254 })?.toLowerCase() ?? null;
  if (result !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail('INVALID_EMAIL');
  return result;
}
