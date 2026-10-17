// Offline-only transformer. Never contacts GAS, Drive, D1, R2, or a network service.
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, chmod, open, unlink } from 'node:fs/promises';
import { resolve, dirname, parse, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ARTIFACT_LIMITS, EXPORT_FORMAT, IMPORT_TABLES, PLAN_FORMAT, SOURCE_SHEETS, VERSION } from './contract.mjs';
import { HEADERS, ENUMS, KNOWN_JENIS, REQUIRED, MIME_EXT, DRIVE_ID, DOC_ID, fail, isRecord, text, identity, enumValue, dateOnly, timestamp, utcTimestamp, reference, validateOverrides, phone, email } from './normalize.mjs';
import { generateSQL } from './sql.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPORT_KEYS = ['format', 'version', 'snapshotId', 'createdAt', 'sourceTimezone', 'consistent', 'readOnlyDeclared', 'isComplete', 'finishedAt', 'sheets', 'fileManifest'];

export function wrapLegacyHash(hash, nip, snapshotId, pepper, saltSecret) {
  if (typeof pepper !== 'string' || !pepper || pepper.includes('\0')) fail('INVALID_PEPPER');
  if (!(saltSecret instanceof Uint8Array) || saltSecret.length < 32) fail('INVALID_SALT');
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) fail('INVALID_PASSWORD_HASH');
  // Fixed-width NIP and UUID make concatenation unambiguous. Secret salt prevents
  // deterministic salts revealing identity across independently keyed migrations.
  const salt = createHmac('sha256', saltSecret).update(snapshotId + nip, 'utf8').digest().subarray(0, 16);
  const input = createHmac('sha256', pepper).update(hash.toLowerCase(), 'utf8').digest();
  const derived = pbkdf2Sync(input, salt, 10_000, 32, 'sha256');
  return `legacy-wrap$10000$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function sheetRows(source, sheet, diagnostic) {
  const data = source.sheets?.[sheet];
  if (!isRecord(data) || !Array.isArray(data.headers) || !Array.isArray(data.rows)) {
    diagnostic('error', sheet, null, 'INVALID_SHEET'); return [];
  }
  const headers = data.headers;
  if (headers.some((h) => typeof h !== 'string') || new Set(headers).size !== headers.length) {
    diagnostic('error', sheet, null, 'DUPLICATE_OR_INVALID_HEADER'); return [];
  }
  if (HEADERS[sheet].some((h) => !headers.includes(h))) {
    diagnostic('error', sheet, null, 'MISSING_HEADER'); return [];
  }
  if (headers.length !== HEADERS[sheet].length || headers.some((h) => !HEADERS[sheet].includes(h))) {
    diagnostic('error', sheet, null, 'UNEXPECTED_HEADER'); return [];
  }
  const rows = [];
  const seen = new Set();
  for (const row of data.rows) {
    const number = Number.isSafeInteger(row?.rowNumber) && row.rowNumber >= 2 ? row.rowNumber : null;
    if (number === null || seen.has(number)) {
      diagnostic('error', sheet, number, 'INVALID_ROW_NUMBER'); continue;
    }
    seen.add(number);
    if (!Array.isArray(row.values) || row.values.length !== headers.length || !Array.isArray(row.displayValues) || row.displayValues.length !== headers.length || row.displayValues.some((v) => typeof v !== 'string')) {
      diagnostic('error', sheet, number, 'ROW_LENGTH_MISMATCH'); continue;
    }
    if (row.values.some((cell) => !(cell === null || typeof cell === 'string' || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell)) || (isRecord(cell) && Object.keys(cell).length === 1 && typeof cell.$date === 'string')))) {
      diagnostic('error', sheet, number, 'INVALID_CELL'); continue;
    }
    if (row.values.some((cell) => typeof cell === 'string' && cell.includes('\0'))) {
      diagnostic('error', sheet, number, 'INVALID_TEXT'); continue;
    }
    rows.push({ rowNumber: number, data: Object.fromEntries(headers.map((h, i) => [h, row.values[i]])) });
  }
  return rows.sort((a, b) => a.rowNumber - b.rowNumber);
}

/** Returns only a sensitive plan. Reports are deliberately constructed separately. */
export function transformExport(source, { pepper, salt, overrides = {}, sourceSha256 } = {}) {
  const diagnostics = [];
  const diagnostic = (severity, sheet, rowNumber, code) => diagnostics.push({ severity, sheet, rowNumber, code });
  const tables = Object.fromEntries(IMPORT_TABLES.map((name) => [name, []]));
  const plan = {
    format: PLAN_FORMAT, version: VERSION, snapshotId: null, sourceSha256: sourceSha256 ?? sha256(JSON.stringify(source)), createdAt: null,
    sourceReadOnlyDeclared: false, consistent: false, ready: false, tables, files: [],
    expected: { pegawai: 0, akun: 0, arsip: 0, files: 0, totalFileBytes: 0, arsipPerStatus: { Menunggu: 0, Terverifikasi: 0, Ditolak: 0 } }, diagnostics,
  };
  const attempt = (sheet, number, callback) => {
    try { return callback((code) => diagnostic('warning', sheet, number, code)); }
    catch (error) {
      // Never serialize exceptions: runtime errors can include source values/paths.
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'INVALID_SOURCE_ROW';
      diagnostic('error', sheet, number, code); return null;
    }
  };
  const envelope = attempt('export', null, (warn) => {
    if (!isRecord(source) || source.format !== EXPORT_FORMAT || source.version !== VERSION) fail('INVALID_EXPORT_FORMAT');
    if (Object.keys(source).some((k) => !EXPORT_KEYS.includes(k))) fail('UNEXPECTED_EXPORT_FIELD');
    if (typeof source.snapshotId !== 'string' || !UUID.test(source.snapshotId)) fail('INVALID_SNAPSHOT_ID');
    plan.snapshotId = source.snapshotId;
    plan.createdAt = utcTimestamp(source.createdAt);
    const finished = utcTimestamp(source.finishedAt);
    if (finished < plan.createdAt) fail('INVALID_FINISHED_AT');
    if (source.sourceTimezone !== 'Asia/Makassar') fail('INVALID_SOURCE_TIMEZONE');
    if (source.consistent !== false || source.isComplete !== true || typeof source.readOnlyDeclared !== 'boolean') fail('INCOMPLETE_EXPORT');
    if (!isRecord(source.sheets)) fail('INVALID_SHEETS');
    if (Object.keys(source.sheets).some((s) => !SOURCE_SHEETS.includes(s))) fail('UNEXPECTED_SHEET');
    plan.sourceReadOnlyDeclared = source.readOnlyDeclared;
    if (!source.readOnlyDeclared) warn('SOURCE_NOT_READ_ONLY');
    warn('NON_ATOMIC_SNAPSHOT');
    if (typeof plan.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(plan.sourceSha256)) fail('INVALID_SOURCE_DIGEST');
    if (Buffer.byteLength(JSON.stringify(source), 'utf8') > ARTIFACT_LIMITS.exportBytes) fail('EXPORT_TOO_LARGE');
    const count = SOURCE_SHEETS.reduce((n, s) => n + (Array.isArray(source.sheets[s]?.rows) ? source.sheets[s].rows.length : 0), 0);
    if (count > ARTIFACT_LIMITS.rows) fail('ROW_LIMIT_EXCEEDED');
    if (!Array.isArray(source.fileManifest) || source.fileManifest.length > ARTIFACT_LIMITS.rows) fail('INVALID_FILE_MANIFEST');
    if (typeof pepper !== 'string' || !pepper || pepper.includes('\0')) fail('INVALID_PEPPER');
    if (!(salt instanceof Uint8Array) || salt.length < 32) fail('INVALID_SALT');
    return validateOverrides(overrides);
  });
  if (!envelope) return plan;
  const mappedOverrides = envelope;
  const rows = Object.fromEntries(SOURCE_SHEETS.map((s) => [s, sheetRows(source, s, diagnostic)]));
  const manifest = new Map();
  const usedFiles = new Map();
  for (const file of source.fileManifest) {
    attempt('fileManifest', null, () => {
      if (!isRecord(file) || typeof file.fileId !== 'string' || !DRIVE_ID.test(file.fileId) || !['document', 'photo'].includes(file.kind) || !['available', 'missing', 'invalid', 'pending'].includes(file.status)) fail('INVALID_FILE_MANIFEST');
      const key = `${file.kind}:${file.fileId}`;
      if (manifest.has(key)) fail('DUPLICATE_FILE_MANIFEST');
      manifest.set(key, file);
      return true;
    });
  }
  const getFile = (rawId, kind) => {
    const id = text(rawId, { required: true, max: 200 });
    if (!DRIVE_ID.test(id)) fail('INVALID_DRIVE_ID');
    const file = manifest.get(`${kind}:${id}`);
    if (!file) fail('MISSING_FILE_MANIFEST');
    if (file.status !== 'available') fail('FILE_UNAVAILABLE');
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > ARTIFACT_LIMITS.fileBytes) fail('INVALID_FILE_METADATA');
    if (!Object.hasOwn(MIME_EXT, file.mimeType) || (kind === 'photo' && file.mimeType === 'application/pdf')) fail('INVALID_FILE_MIME');
    return {
      fileId: id, kind, r2Key: `migration/${source.snapshotId}/${kind}/${id}-${file.sha256}.${MIME_EXT[file.mimeType]}`,
      mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256,
    };
  };
  const useFile = (file) => usedFiles.set(`${file.kind}:${file.fileId}`, file);
  const jenisMap = new Map();
  const jenisTargets = new Set();
  for (const { rowNumber, data: d } of rows.Master_Dokumen) {
    attempt('Master_Dokumen', rowNumber, (warn) => {
      const sourceId = text(d.ID_Dokumen, { required: true, max: 256 });
      const wajib = text(d.Status_Wajib, { required: true, max: 16 });
      if (!['Ya', 'Tidak'].includes(wajib)) fail('INVALID_STATUS_WAJIB');
      // An ID alias is not approval of a custom document's per-status matrix.
      // Validate the original source classification before any target remapping.
      if (!KNOWN_JENIS.includes(sourceId) && wajib === 'Ya') fail('UNMAPPED_REQUIREMENT_MATRIX');
      if (jenisMap.has(sourceId)) fail('DUPLICATE_JENIS');
      const id = Object.hasOwn(mappedOverrides.jenis, sourceId) ? mappedOverrides.jenis[sourceId] : sourceId;
      if (!DOC_ID.test(id) || id.length > 64) fail('UNKNOWN_JENIS');
      // Known IDs retain their meaning, even if an override attempts to rename them.
      if (KNOWN_JENIS.includes(sourceId) && id !== sourceId) fail('KNOWN_JENIS_REMAP');
      if (jenisTargets.has(id)) fail('DUPLICATE_JENIS');
      const nama = text(d.Nama_Dokumen, { required: true, min: 2, max: 150 });
      const kategori = text(d.Kategori, { required: true, min: 2, max: 100 });
      if (!KNOWN_JENIS.includes(id)) {
        warn('CUSTOM_JENIS_OPTIONAL');
      } else warn('OWNER_REQUIREMENT_MATRIX');
      jenisMap.set(sourceId, id); jenisTargets.add(id);
      tables.jenis_dokumen.push({ id, nama, kategori, urutan: KNOWN_JENIS.includes(id) ? KNOWN_JENIS.indexOf(id) + 1 : 1000 + rowNumber, aktif: 1, max_size_bytes: ARTIFACT_LIMITS.fileBytes });
      for (const status of ENUMS.status_kepegawaian) {
        if (REQUIRED[status].includes(id)) tables.jenis_dokumen_wajib.push({ jenis_dokumen_id: id, status_kepegawaian: status });
      }
      return true;
    });
  }
  tables.jenis_dokumen.sort((a, b) => compare(a.id, b.id));
  tables.jenis_dokumen_wajib.sort((a, b) => compare(a.jenis_dokumen_id, b.jenis_dokumen_id) || compare(a.status_kepegawaian, b.status_kepegawaian));
  const employees = [];
  const photoOwners = new Map();
  const seenNip = new Set(); const seenNik = new Set();
  for (const { rowNumber, data: d } of rows.Data_Pegawai) {
    attempt('Data_Pegawai', rowNumber, (warn) => {
      const nip = identity(d.NIP);
      const nik = identity(d.NIK, 'NIK', true);
      if (seenNip.has(nip)) diagnostic('error', 'Data_Pegawai', rowNumber, 'DUPLICATE_NIP');
      if (nik !== null && seenNik.has(nik)) diagnostic('error', 'Data_Pegawai', rowNumber, 'DUPLICATE_NIK');
      seenNip.add(nip); if (nik !== null) seenNik.add(nik);
      const role = enumValue(d.Role, 'role', false);
      let status = text(d.Status_Kepegawaian, { max: 64 });
      if (status === 'P3K') { status = 'PPPK'; warn('NORMALIZED_P3K'); }
      status = enumValue(status, 'status_kepegawaian');
      let accountStatus = text(d.Status_Akun, { required: true, max: 64 });
      if (accountStatus === 'Ganti_Password') { accountStatus = 'Aktif'; warn('NORMALIZED_GANTI_PASSWORD'); }
      accountStatus = enumValue(accountStatus, 'status_akun', false);
      const pangkat = reference(d.Pangkat_Golongan, 'pangkat', mappedOverrides, warn);
      if (pangkat !== null && (status === null || (pangkat.startsWith('PPPK-') ? status !== 'PPPK' : status === 'PPPK'))) fail('RANK_FAMILY_MISMATCH');
      const born = dateOnly(d.Tanggal_Lahir);
      const snapshotDay = dateOnly({ $date: plan.createdAt });
      if (born !== null && born > snapshotDay) fail('FUTURE_BIRTH_DATE');
      const legacyHash = text(d.Password_Hash, { required: true, max: 64 });
      if (!/^[a-f0-9]{64}$/i.test(legacyHash)) fail('INVALID_PASSWORD_HASH');
      const photoId = text(d.Foto_Drive_ID, { max: 200 });
      if (photoId !== null) {
        const owner = photoOwners.get(photoId);
        if (owner && owner.nip !== nip) {
          // Photo replacement deletes the previous key. Shared keys are unsafe
          // until operators copy the source photo into distinct Drive files.
          if (!owner.conflicted) diagnostic('error', 'Data_Pegawai', owner.rowNumber, 'SHARED_PHOTO_REFERENCE');
          diagnostic('error', 'Data_Pegawai', rowNumber, 'SHARED_PHOTO_REFERENCE');
          owner.conflicted = true;
        } else if (!owner) photoOwners.set(photoId, { nip, rowNumber, conflicted: false });
      }
      const photo = photoId ? getFile(photoId, 'photo') : null;
      const employee = {
        id: 0, nip, nik, nama: text(d.Nama_Lengkap, { required: true, min: 3, max: 150 }), role, status_akun: accountStatus, status_kepegawaian: status,
        pangkat_kode: pangkat, tmt_pangkat: dateOnly(d.TMT_Pangkat), jabatan: text(d.Jabatan, { max: 150 }), jenis_jabatan: enumValue(d.Jenis_Jabatan, 'jenis_jabatan'),
        tmt_jabatan: dateOnly(d.TMT_Jabatan), unit_id: reference(d.Unit_Organisasi, 'unit', mappedOverrides, warn), tempat_lahir: text(d.Tempat_Lahir, { max: 100 }), tanggal_lahir: born,
        jenis_kelamin: enumValue(d.Jenis_Kelamin, 'jenis_kelamin'), agama: enumValue(d.Agama, 'agama'), pendidikan_kode: reference(d.Pendidikan_Terakhir, 'pendidikan', mappedOverrides, warn),
        status_pernikahan: enumValue(d.Status_Pernikahan, 'status_pernikahan'), golongan_darah: enumValue(d.Golongan_Darah, 'golongan_darah'), no_hp: phone(d.No_HP), email: email(d.Email),
        alamat: text(d.Alamat, { max: 500 }), foto_r2_key: photo?.r2Key ?? null, created_at: plan.createdAt, updated_at: plan.createdAt,
      };
      employees.push({ employee, legacyHash, photo });
      return true;
    });
  }
  employees.sort((a, b) => compare(a.employee.nip, b.employee.nip));
  const byNip = new Map();
  for (const [index, item] of employees.entries()) {
    const employee = item.employee;
    employee.id = index + 1;
    byNip.set(employee.nip, employee); tables.pegawai.push(employee);
    tables.akun.push({ pegawai_id: employee.id, password_hash: wrapLegacyHash(item.legacyHash, employee.nip, source.snapshotId, pepper, salt), is_default_password: sha256(employee.nip.slice(-6)) === item.legacyHash.toLowerCase() ? 1 : 0 });
    if (item.photo) useFile(item.photo);
  }
  const slots = new Map();
  const sourceArchives = new Map();
  const registerSourceArchive = (sourceId, fingerprint, rowNumber) => {
    const previous = sourceArchives.get(sourceId);
    if (previous && previous.fingerprint !== fingerprint) {
      diagnostic('error', 'Arsip_Dokumen', previous.rowNumber, 'CONFLICTING_ARCHIVE_ID');
      diagnostic('error', 'Arsip_Dokumen', rowNumber, 'CONFLICTING_ARCHIVE_ID');
    } else if (!previous) sourceArchives.set(sourceId, { fingerprint, rowNumber });
  };
  const businessFingerprint = (record) => JSON.stringify([record.file.fileId, record.status, record.catatan, record.verifiedAt, record.verifierNip]);
  for (const { rowNumber, data: d } of rows.Arsip_Dokumen) {
    attempt('Arsip_Dokumen', rowNumber, (warn) => {
      const nip = identity(d.NIP);
      const employee = byNip.get(nip);
      if (!employee) fail('ORPHAN_NIP');
      const jenis = jenisMap.get(text(d.ID_Dokumen, { required: true, max: 256 }));
      if (!jenis) fail('UNKNOWN_JENIS');
      const status = text(d.Status_Verifikasi, { required: true, max: 64 });
      const sourceId = text(d.ID_Arsip, { required: true, max: 256 });
      if (status === 'Belum_Unggah') {
        registerSourceArchive(sourceId, JSON.stringify([nip, jenis, status]), rowNumber);
        warn('SKIPPED_BELUM_UNGGAH'); return true;
      }
      enumValue(status, 'status', false);
      const file = getFile(d.File_Drive_ID, 'document');
      const uploadedAt = timestamp(d.Waktu_Upload);
      const verifiedAt = timestamp(d.Waktu_Verifikasi, status === 'Menunggu');
      if (verifiedAt !== null && verifiedAt < uploadedAt) fail('INVALID_VERIFICATION_TIME');
      const verifierNip = identity(d.NIP_Verifier, 'NIP', true);
      const verifier = verifierNip === null ? null : byNip.get(verifierNip);
      if (status !== 'Menunggu' && !verifier) warn('MISSING_HISTORIC_VERIFIER');
      const record = { nip, jenis, employee, file, status, uploadedAt, verifiedAt, verifierNip, verifiedBy: verifier?.id ?? null, catatan: text(d.Catatan_Admin, { max: 500 }), sourceId, rowNumber };
      registerSourceArchive(sourceId, JSON.stringify([nip, jenis, uploadedAt, businessFingerprint(record)]), rowNumber);
      const slot = `${nip}:${jenis}`;
      if (!slots.has(slot)) slots.set(slot, []);
      slots.get(slot).push(record);
      return true;
    });
  }
  for (const [index, slot] of [...slots.keys()].sort(compare).entries()) {
    const candidates = slots.get(slot).sort((a, b) => compare(b.uploadedAt, a.uploadedAt) || compare(b.sourceId, a.sourceId) || b.rowNumber - a.rowNumber);
    const selected = candidates[0];
    const outcomesByTimestamp = new Map();
    for (const candidate of candidates) {
      const outcome = businessFingerprint(candidate);
      const previous = outcomesByTimestamp.get(candidate.uploadedAt);
      if (previous !== undefined && previous !== outcome) {
        diagnostic('error', 'Arsip_Dokumen', candidate.rowNumber, 'AMBIGUOUS_DUPLICATE');
      } else outcomesByTimestamp.set(candidate.uploadedAt, outcome);
    }
    for (const dropped of candidates.slice(1)) diagnostic('warning', 'Arsip_Dokumen', dropped.rowNumber, 'DUPLICATE_ARCHIVE_SUPERSEDED');
    const id = index + 1;
    const { employee, jenis, file, status, uploadedAt, verifiedAt, verifiedBy, catatan } = selected;
    tables.arsip_dokumen.push({
      id, pegawai_id: employee.id, jenis_dokumen_id: jenis, status, r2_key: file.r2Key,
      file_name: `${employee.nip}_${jenis}.${MIME_EXT[file.mimeType]}`, mime_type: file.mimeType, size_bytes: file.sizeBytes, sha256: file.sha256,
      versi: 1, catatan_admin: catatan, uploaded_at: uploadedAt, uploaded_by: employee.id, verified_at: verifiedAt, verified_by: verifiedBy,
    });
    tables.arsip_dokumen_riwayat.push({ id: tables.arsip_dokumen_riwayat.length + 1, arsip_id: id, versi: 1, aksi: 'UPLOAD', status: 'Menunggu', catatan: null, actor_id: employee.id, created_at: uploadedAt, pegawai_id: employee.id, jenis_dokumen_id: jenis });
    if (status !== 'Menunggu') tables.arsip_dokumen_riwayat.push({ id: tables.arsip_dokumen_riwayat.length + 1, arsip_id: id, versi: 1, aksi: status === 'Terverifikasi' ? 'APPROVE' : 'REJECT', status, catatan, actor_id: verifiedBy, created_at: verifiedAt, pegawai_id: employee.id, jenis_dokumen_id: jenis });
    useFile(file);
  }
  for (const { rowNumber, data: d } of rows.Log_Aktivitas) {
    attempt('Log_Aktivitas', rowNumber, (warn) => {
      const actorNip = identity(d.Actor_NIP, 'NIP', true);
      const actor = actorNip === null ? null : byNip.get(actorNip);
      if (actorNip !== null && !actor) warn('MISSING_HISTORIC_LOG_ACTOR');
      const actorRole = enumValue(d.Actor_Role, 'role');
      const action = text(d.Action, { required: true, max: 100 });
      if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(action)) fail('INVALID_LOG_ACTION');
      tables.log_aktivitas.push({ id: tables.log_aktivitas.length + 1, ts: timestamp(d.Timestamp), actor_id: actor?.id ?? null, actor_nip: actorNip, actor_nama: actor?.nama ?? null, actor_role: actorRole, action,
        target_type: text(d.Target_Type, { max: 100 }), target_id: text(d.Target_ID, { max: 256 }), description: text(d.Description, { max: 16384 }), result: enumValue(d.Result, 'result', false) });
      return true;
    });
  }
  for (const key of manifest.keys()) if (!usedFiles.has(key)) diagnostic('warning', 'fileManifest', null, 'UNREFERENCED_FILE_MANIFEST');
  plan.files = [...usedFiles.values()].sort((a, b) => compare(a.kind, b.kind) || compare(a.fileId, b.fileId));
  Object.assign(plan.expected, { pegawai: tables.pegawai.length, akun: tables.akun.length, arsip: tables.arsip_dokumen.length, files: plan.files.length, totalFileBytes: plan.files.reduce((n, f) => n + f.sizeBytes, 0) });
  for (const archive of tables.arsip_dokumen) plan.expected.arsipPerStatus[archive.status]++;
  plan.ready = !diagnostics.some((d) => d.severity === 'error');
  return plan;
}

export function reportFor(plan) {
  return {
    format: 'sikap-migration-report', version: VERSION, ready: plan.ready, consistent: false, sourceReadOnlyDeclared: plan.sourceReadOnlyDeclared,
    expected: plan.expected,
    counts: { errors: plan.diagnostics.filter((d) => d.severity === 'error').length, warnings: plan.diagnostics.filter((d) => d.severity === 'warning').length, skippedBelumUnggah: plan.diagnostics.filter((d) => d.code === 'SKIPPED_BELUM_UNGGAH').length, supersededArchives: plan.diagnostics.filter((d) => d.code === 'DUPLICATE_ARCHIVE_SUPERSEDED').length },
    diagnostics: plan.diagnostics,
  };
}

// Check every existing component, including ancestor junctions/symlinks. Exclusive
// create and O_NOFOLLOW (where supported) also guard the final file open.
export async function assertNoSymlinks(path, allowMissing = false) {
  const absolute = resolve(path); const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail('SYMLINK_REFUSED');
      if (i < parts.length - 1 && !stat.isDirectory()) fail('INVALID_PATH');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute;
      throw error;
    }
  }
  return absolute;
}

export async function readBoundedFile(path, maxBytes) {
  const absolute = await assertNoSymlinks(path);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail('INPUT_SIZE_OR_TYPE');
    // Bound actual reads too: do not rely on stat if another process grows a file.
    const chunks = []; let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes) fail('INPUT_SIZE_OR_TYPE');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await handle.close(); }
}

export function parseArguments(args) {
  const allowed = ['--input', '--out', '--pepper-file', '--salt-file', '--overrides'];
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!allowed.includes(flag) || Object.hasOwn(options, flag) || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS');
    options[flag] = value;
  }
  if (allowed.slice(0, 4).some((flag) => !options[flag])) fail('INVALID_ARGUMENTS');
  return options;
}

export async function runCLI(args) {
  const options = parseArguments(args);
  const input = await readBoundedFile(options['--input'], ARTIFACT_LIMITS.exportBytes);
  const pepper = (await readBoundedFile(options['--pepper-file'], 64 * 1024)).trim();
  if (!pepper || pepper.includes('\0')) fail('INVALID_PEPPER');
  const saltText = (await readBoundedFile(options['--salt-file'], 4096)).trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(saltText)) fail('INVALID_SALT');
  const salt = Buffer.from(saltText, 'base64');
  if (salt.length < 32 || salt.toString('base64') !== saltText) fail('INVALID_SALT');
  let source; let overrides;
  try {
    source = JSON.parse(input);
    overrides = options['--overrides'] ? JSON.parse(await readBoundedFile(options['--overrides'], 1024 * 1024)) : {};
  } catch { fail('INVALID_JSON'); }
  const plan = transformExport(source, { pepper, salt, overrides, sourceSha256: sha256(input) });
  const report = reportFor(plan);
  const output = await assertNoSymlinks(options['--out'], true);
  // Create only the requested directory; its parent must already exist.
  await assertNoSymlinks(dirname(output));
  try { await mkdir(output, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!(await lstat(output)).isDirectory()) fail('INVALID_OUTPUT_DIRECTORY');
  await chmod(output, 0o700);
  const names = ['plan.sikap-plan.json', 'import.sikap-import.sql', 'report.sikap-report.json'];
  // Refuse existing files even for the same source; there is deliberately no --force.
  for (const name of names) {
    try { await lstat(join(output, name)); fail('OUTPUT_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const artifacts = [
    [names[0], `${JSON.stringify(plan, null, 2)}\n`],
    ...(plan.ready ? [[names[1], generateSQL(plan)]] : []),
    [names[2], `${JSON.stringify(report, null, 2)}\n`],
  ];
  const created = [];
  try {
    for (const [name, contents] of artifacts) {
      const path = join(output, name);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created.push(path);
      try { await file.chmod(0o600); await file.writeFile(contents, 'utf8'); } finally { await file.close(); }
    }
  } catch (error) {
    // Only files exclusively created by this invocation may be removed.
    for (const path of created) await unlink(path).catch(() => {});
    throw error;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCLI(process.argv.slice(2)).then((report) => {
    process.stdout.write(`${JSON.stringify({ ready: report.ready, counts: report.counts, expected: report.expected })}\n`);
    if (!report.ready) process.exitCode = 1;
  }).catch(() => {
    // Do not log Error.message/stack: filesystem and parser errors expose paths/PII.
    process.stderr.write('MIGRATION_TRANSFORM_FAILED\n'); process.exitCode = 1;
  });
}
