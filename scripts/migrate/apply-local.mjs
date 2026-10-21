// Offline apply: validate everything first, verify local R2, then transactionally import.
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ENUMS, REQUIRED as REQUIRED_MATRIX, dateOnly, reference, utcTimestamp } from './normalize.mjs';
import path from 'node:path';
import { ARTIFACT_LIMITS, IMPORT_TABLES, PLAN_FORMAT, VERSION } from './contract.mjs';
import { canonicalPath, check, inspectPersistTree, isMain, MigrationError, noLinks, openLocalStore, parseArgs, persistencePath, readBoundedPlan, safeCode, sha256 } from './local-store.mjs';

export const COLUMNS = {
  jenis_dokumen: 'id nama kategori urutan aktif max_size_bytes updated_at'.split(' '),
  jenis_dokumen_wajib: 'jenis_dokumen_id status_kepegawaian'.split(' '),
  pegawai: 'id nip nik nama role status_akun status_kepegawaian pangkat_kode tmt_pangkat jabatan jenis_jabatan tmt_jabatan unit_id tempat_lahir tanggal_lahir jenis_kelamin agama pendidikan_kode status_pernikahan golongan_darah no_hp email alamat foto_r2_key created_at updated_at deleted_at deleted_by purge_after'.split(' '),
  akun: 'pegawai_id password_hash is_default_password failed_attempts locked_until password_changed_at last_login_at'.split(' '),
  arsip_dokumen: 'id pegawai_id jenis_dokumen_id status r2_key file_name mime_type size_bytes sha256 versi catatan_admin uploaded_at uploaded_by verified_at verified_by deleted_at purge_after'.split(' '),
  arsip_dokumen_riwayat: 'id arsip_id pegawai_id jenis_dokumen_id versi aksi status catatan actor_id created_at'.split(' '),
  log_aktivitas: 'id ts actor_id actor_nip actor_nama actor_role action target_type target_id description result ip'.split(' '),
};
const REQUIRED = {
  jenis_dokumen: ['id', 'nama', 'kategori'], jenis_dokumen_wajib: COLUMNS.jenis_dokumen_wajib,
  pegawai: ['id', 'nip', 'nama'], akun: ['pegawai_id', 'password_hash', 'is_default_password'],
  arsip_dokumen: ['id', 'pegawai_id', 'jenis_dokumen_id', 'status', 'r2_key', 'file_name', 'mime_type', 'size_bytes', 'sha256', 'uploaded_at'],
  arsip_dokumen_riwayat: ['id', 'arsip_id', 'pegawai_id', 'jenis_dokumen_id', 'versi', 'aksi', 'created_at'],
  log_aktivitas: ['id', 'ts', 'action', 'result'],
};
export const PRIMARY = Object.fromEntries(IMPORT_TABLES.map((table) => [table, table === 'akun' ? ['pegawai_id'] : table === 'jenis_dokumen_wajib' ? COLUMNS[table] : ['id']]));
export const EMPTY_TABLES = ['pegawai', 'akun', 'arsip_dokumen', 'arsip_dokumen_riwayat', 'arsip_dokumen_versi', 'log_aktivitas', 'sesi', 'rate_limit', 'pengajuan_perubahan', 'notifikasi_outbox', 'r2_purge_queue', 'backup_job', 'backup_part'];
const MIME = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const STATUS = ['Menunggu', 'Terverifikasi', 'Ditolak'];
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => integer(value) && value > 0;
function exactKeys(value, keys, code) { check(object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)), code); }
export function rowIdentity(table, row) { return JSON.stringify(PRIMARY[table].map((key) => row[key])); }

// SQL defaults are materialized before validation/import/compare; raw-byte receipt hash
// remains separate. Time defaults use the export timestamp rather than wall-clock time.
export function canonicalRow(table, row, createdAt) {
  const defaults = Object.fromEntries(COLUMNS[table].map((column) => [column, null]));
  if (table === 'jenis_dokumen') Object.assign(defaults, { urutan: 0, aktif: 1, max_size_bytes: ARTIFACT_LIMITS.fileBytes, updated_at: '1970-01-01T00:00:00.000Z' });
  if (table === 'pegawai') Object.assign(defaults, { role: 'Pegawai', status_akun: 'Aktif', created_at: createdAt, updated_at: createdAt });
  if (table === 'akun') Object.assign(defaults, { failed_attempts: 0 });
  if (table === 'arsip_dokumen') Object.assign(defaults, { versi: 1 });
  return { ...defaults, ...row };
}
function validText(value, max, min = 0, nullable = true) {
  return value === null ? nullable : typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
}
function validateCanonical(table, row, createdAt) {
  const required = (column, max, min = 1) => check(validText(row[column], max, min, false), 'PLAN_TEXT');
  const optional = (column, max) => check(validText(row[column], max), 'PLAN_TEXT');
  const timestamp = (column, nullable = false) => {
    if (nullable && row[column] === null) return;
    try { check(typeof row[column] === 'string' && utcTimestamp(row[column]) === row[column], 'PLAN_DATE'); }
    catch { throw new MigrationError('PLAN_DATE'); }
  };
  const enumeration = (column, allowed, nullable = true) => check((nullable && row[column] === null) || allowed.includes(row[column]), 'PLAN_ENUM');
  if (table === 'pegawai') {
    required('nama', 150, 3);
    for (const [column, max] of Object.entries({ jabatan: 150, tempat_lahir: 100, alamat: 500, email: 254, no_hp: 15, foto_r2_key: 512 })) optional(column, max);
    for (const column of ['role', 'status_akun']) enumeration(column, ENUMS[column], false);
    for (const column of ['status_kepegawaian', 'jenis_jabatan', 'jenis_kelamin', 'agama', 'status_pernikahan', 'golongan_darah']) enumeration(column, ENUMS[column]);
    check(row.unit_id === null || [1, 2, 3].includes(row.unit_id), 'PLAN_REFERENCE');
    for (const [column, kind] of [['pangkat_kode', 'pangkat'], ['pendidikan_kode', 'pendidikan']]) {
      if (row[column] === null) continue;
      try { check(reference(row[column], kind, { [kind]: {} }, () => {}) === row[column], 'PLAN_REFERENCE'); }
      catch { throw new MigrationError('PLAN_REFERENCE'); }
    }
    if (row.pangkat_kode !== null) check(row.status_kepegawaian !== null && (row.pangkat_kode.startsWith('PPPK-') ? row.status_kepegawaian === 'PPPK' : row.status_kepegawaian !== 'PPPK'), 'PLAN_RANK_FAMILY');
    for (const column of ['tanggal_lahir', 'tmt_pangkat', 'tmt_jabatan']) {
      if (row[column] === null) continue;
      try { check(typeof row[column] === 'string' && dateOnly(row[column]) === row[column], 'PLAN_DATE'); }
      catch { throw new MigrationError('PLAN_DATE'); }
    }
    if (row.tanggal_lahir !== null) check(row.tanggal_lahir <= new Date(Date.parse(createdAt) + 8 * 3600000).toISOString().slice(0, 10), 'PLAN_DATE');
    check(row.email === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email), 'PLAN_TEXT');
    check(row.no_hp === null || /^62\d{8,13}$/.test(row.no_hp), 'PLAN_TEXT');
    timestamp('created_at'); timestamp('updated_at');
  } else if (table === 'jenis_dokumen') {
    required('nama', 150, 2); required('kategori', 100, 2);
    check(integer(row.urutan) && [0, 1].includes(row.aktif) && positive(row.max_size_bytes) && row.max_size_bytes <= ARTIFACT_LIMITS.fileBytes, 'PLAN_JENIS');
    timestamp('updated_at');
  } else if (table === 'akun') {
    timestamp('password_changed_at', true);
  } else if (table === 'arsip_dokumen') {
    check(positive(row.versi), 'PLAN_ID');
    required('file_name', 255); optional('catatan_admin', 500);
    check(!/[\\/]/.test(row.file_name), 'PLAN_TEXT');
    timestamp('uploaded_at'); timestamp('verified_at', true);
    check(row.status === 'Menunggu' || row.verified_at !== null, 'PLAN_DATE');
    check(row.verified_at === null || row.verified_at >= row.uploaded_at, 'PLAN_DATE');
  } else if (table === 'arsip_dokumen_riwayat') {
    enumeration('aksi', ['UPLOAD', 'REUPLOAD', 'APPROVE', 'REJECT', 'DELETE', 'RESTORE', 'ROLLBACK'], false);
    enumeration('status', STATUS); optional('catatan', 500); timestamp('created_at');
  } else if (table === 'log_aktivitas') {
    timestamp('ts'); required('action', 100);
    check(/^[A-Z][A-Z0-9_]{0,99}$/.test(row.action), 'PLAN_TEXT');
    enumeration('result', ENUMS.result, false); enumeration('actor_role', ENUMS.role);
    for (const [column, max] of Object.entries({ actor_nama: 150, target_type: 100, target_id: 256, description: 16384 })) optional(column, max);
    check(row.actor_nip === null || typeof row.actor_nip === 'string' && /^\d{18}$/.test(row.actor_nip), 'PLAN_IDENTITY');
  }
}

export function validatePlan(plan) {
  exactKeys(plan, ['format', 'version', 'snapshotId', 'sourceSha256', 'createdAt', 'sourceReadOnlyDeclared', 'consistent', 'ready', 'tables', 'files', 'expected', 'diagnostics'], 'PLAN_FORMAT');
  check(plan.format === PLAN_FORMAT && plan.version === VERSION && UUID.test(plan.snapshotId) && SHA.test(plan.sourceSha256), 'PLAN_FORMAT');
  try { check(typeof plan.createdAt === 'string' && utcTimestamp(plan.createdAt) === plan.createdAt, 'PLAN_FORMAT'); }
  catch { throw new MigrationError('PLAN_FORMAT'); }
  check(plan.ready === true && plan.consistent === false && typeof plan.sourceReadOnlyDeclared === 'boolean', 'PLAN_NOT_READY');
  check(Array.isArray(plan.diagnostics) && plan.diagnostics.every((entry) => {
    exactKeys(entry, ['severity', 'sheet', 'rowNumber', 'code'], 'PLAN_DIAGNOSTICS');
    return entry.severity === 'warning' && typeof entry.sheet === 'string' && (entry.rowNumber === null || positive(entry.rowNumber)) && /^[A-Z][A-Z0-9_]*$/.test(entry.code);
  }), 'PLAN_NOT_READY');
  exactKeys(plan.tables, IMPORT_TABLES, 'PLAN_TABLES');
  let rowCount = 0;
  for (const table of IMPORT_TABLES) {
    const rows = plan.tables[table];
    check(Array.isArray(rows), 'PLAN_ROWS');
    rowCount += rows.length;
    check(rowCount <= ARTIFACT_LIMITS.rows, 'PLAN_ROW_LIMIT');
    const ids = new Set();
    for (let index = 0; index < rows.length; index++) {
      let row = rows[index];
      check(object(row) && Object.keys(row).every((key) => COLUMNS[table].includes(key)) && REQUIRED[table].every((key) => Object.hasOwn(row, key) && row[key] !== null), 'PLAN_COLUMNS');
      check(Object.values(row).every((value) => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))), 'PLAN_VALUE');
      row = rows[index] = canonicalRow(table, row, plan.createdAt);
      validateCanonical(table, row, plan.createdAt);
      for (const [key, value] of Object.entries(row)) {
        if (['id', 'pegawai_id', 'arsip_id', 'actor_id', 'uploaded_by', 'verified_by', 'deleted_by', 'unit_id', 'versi'].includes(key) && !(key === 'id' && table === 'jenis_dokumen')) check(value === null || positive(value), 'PLAN_ID');
      }
      const identity = rowIdentity(table, row);
      check(!ids.has(identity), 'PLAN_DUPLICATE_ID'); ids.add(identity);
      if (table === 'pegawai') {
        check(typeof row.nip === 'string' && /^\d{18}$/.test(row.nip) && (row.nik === null || typeof row.nik === 'string' && /^\d{16}$/.test(row.nik)), 'PLAN_IDENTITY');
        check(row.deleted_at == null && row.deleted_by == null && row.purge_after == null, 'PLAN_DELETED_ROW');
      }
      if (table === 'akun') {
        check(typeof row.password_hash === 'string' && /^legacy-wrap\$10000\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/.test(row.password_hash), 'PLAN_PASSWORD');
        const parts = row.password_hash.split('$');
        check(Buffer.from(parts[2], 'base64').length >= 16 && Buffer.from(parts[3], 'base64').length === 32, 'PLAN_PASSWORD');
        check([0, 1].includes(row.is_default_password) && (row.failed_attempts === undefined || row.failed_attempts === 0) && row.locked_until == null && row.last_login_at == null, 'PLAN_AUTH_STATE');
      }
      if (table === 'arsip_dokumen') check(STATUS.includes(row.status) && row.deleted_at == null && row.purge_after == null, 'PLAN_ARCHIVE');
      if (table === 'log_aktivitas') check(row.ip == null, 'PLAN_AUTH_STATE');
    }
  }
  const nips = new Set(), niks = new Set(), slots = new Set();
  for (const row of plan.tables.pegawai) {
    check(!nips.has(row.nip) && (row.nik === null || !niks.has(row.nik)), 'PLAN_DUPLICATE_IDENTITY');
    nips.add(row.nip); if (row.nik !== null) niks.add(row.nik);
  }
  for (const row of plan.tables.arsip_dokumen) {
    const slot = JSON.stringify([row.pegawai_id, row.jenis_dokumen_id]);
    check(!slots.has(slot), 'PLAN_DUPLICATE_SLOT'); slots.add(slot);
  }
  const photos = plan.tables.pegawai.map((row) => row.foto_r2_key).filter((key) => key !== null);
  check(new Set(photos).size === photos.length, 'PLAN_SHARED_PHOTO');
  const employeeIds = new Set(plan.tables.pegawai.map((row) => row.id));
  const jenisIds = new Set(plan.tables.jenis_dokumen.map((row) => row.id));
  const archives = new Map(plan.tables.arsip_dokumen.map((row) => [row.id, row]));
  for (const row of plan.tables.jenis_dokumen) check(typeof row.id === 'string' && row.id.length <= 64 && /^DOC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(row.id), 'PLAN_JENIS');
  for (const row of plan.tables.jenis_dokumen_wajib) check(jenisIds.has(row.jenis_dokumen_id) && ['PNS', 'CPNS', 'PPPK'].includes(row.status_kepegawaian), 'PLAN_REFERENCE');
  check(plan.tables.akun.length === employeeIds.size, 'PLAN_ACCOUNTS');
  for (const row of plan.tables.akun) check(employeeIds.has(row.pegawai_id), 'PLAN_REFERENCE');
  for (const row of plan.tables.arsip_dokumen) {
    check(employeeIds.has(row.pegawai_id) && jenisIds.has(row.jenis_dokumen_id), 'PLAN_REFERENCE');
    for (const key of ['uploaded_by', 'verified_by']) check(row[key] == null || employeeIds.has(row[key]), 'PLAN_REFERENCE');
  }
  for (const row of plan.tables.arsip_dokumen_riwayat) {
    const archive = archives.get(row.arsip_id);
    check(archive && archive.pegawai_id === row.pegawai_id && archive.jenis_dokumen_id === row.jenis_dokumen_id && (row.actor_id == null || employeeIds.has(row.actor_id)), 'PLAN_REFERENCE');
  }
  for (const row of plan.tables.log_aktivitas) check(row.actor_id == null || employeeIds.has(row.actor_id), 'PLAN_REFERENCE');
  check(Array.isArray(plan.files) && plan.files.length <= ARTIFACT_LIMITS.rows, 'PLAN_FILES');
  const files = new Map();
  for (const file of plan.files) {
    exactKeys(file, ['fileId', 'kind', 'r2Key', 'mimeType', 'sizeBytes', 'sha256'], 'PLAN_FILE');
    check(typeof file.fileId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(file.fileId) && ['document', 'photo'].includes(file.kind), 'PLAN_FILE');
    check(SHA.test(file.sha256) && integer(file.sizeBytes) && file.sizeBytes > 0 && file.sizeBytes <= ARTIFACT_LIMITS.fileBytes && Object.hasOwn(MIME, file.mimeType), 'PLAN_FILE');
    check(file.kind !== 'photo' || file.mimeType !== 'application/pdf', 'PLAN_FILE');
    const key = `migration/${plan.snapshotId}/${file.kind}/${file.fileId}-${file.sha256}.${MIME[file.mimeType]}`;
    check(file.r2Key === key && !files.has(key), 'PLAN_FILE_KEY'); files.set(key, file);
  }
  const used = new Set();
  for (const row of plan.tables.arsip_dokumen) {
    const file = files.get(row.r2_key);
    check(file && file.kind === 'document' && file.sha256 === row.sha256 && file.sizeBytes === row.size_bytes && file.mimeType === row.mime_type, 'PLAN_FILE_REFERENCE');
    used.add(file.r2Key);
  }
  for (const row of plan.tables.pegawai) {
    if (row.foto_r2_key == null) continue;
    const file = files.get(row.foto_r2_key);
    check(file && file.kind === 'photo', 'PLAN_FILE_REFERENCE'); used.add(file.r2Key);
  }
  check(used.size === files.size, 'PLAN_UNUSED_FILE');
  exactKeys(plan.expected, ['pegawai', 'akun', 'arsip', 'files', 'totalFileBytes', 'arsipPerStatus'], 'PLAN_EXPECTED');
  exactKeys(plan.expected.arsipPerStatus, STATUS, 'PLAN_EXPECTED');
  check(['pegawai', 'akun', 'arsip', 'files', 'totalFileBytes'].every((key) => integer(plan.expected[key])) && STATUS.every((key) => integer(plan.expected.arsipPerStatus[key])), 'PLAN_EXPECTED');
  check(plan.expected.pegawai === plan.tables.pegawai.length && plan.expected.akun === plan.tables.akun.length && plan.expected.arsip === archives.size && plan.expected.files === files.size && plan.expected.totalFileBytes === plan.files.reduce((sum, file) => sum + file.sizeBytes, 0), 'PLAN_EXPECTED');
  for (const status of STATUS) check(plan.expected.arsipPerStatus[status] === plan.tables.arsip_dokumen.filter((row) => row.status === status).length, 'PLAN_EXPECTED');
  return plan;
}

function magic(bytes, mime) {
  if (mime === 'application/pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
}
export async function readVerifiedFile(filesDir, file) {
  const base = await noLinks(filesDir);
  check((await lstat(base)).isDirectory(), 'FILES_DIRECTORY');
  const target = path.join(base, `${file.fileId}.bin`);
  await noLinks(target);
  check(canonicalPath(path.dirname(await realpath(target))) === canonicalPath(await realpath(base)), 'FILE_CONFINEMENT');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size === file.sizeBytes, 'FILE_SIZE');
    const bytes = Buffer.alloc(file.sizeBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const data = bytes.subarray(0, offset);
    check(data.length === file.sizeBytes && sha256(data) === file.sha256, 'FILE_SHA256');
    check(magic(data, file.mimeType), 'FILE_MAGIC');
    await noLinks(target);
    return data;
  } finally { await handle.close(); }
}
export async function loadArtifacts({ planPath, filesDir, persistTo }) {
  const persist = await persistencePath(persistTo);
  await inspectPersistTree(persist);
  const bytes = await readBoundedPlan(planPath, ARTIFACT_LIMITS.exportBytes);
  let plan;
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { throw new MigrationError('PLAN_JSON'); }
  validatePlan(plan);
  await noLinks(filesDir);
  check((await lstat(filesDir)).isDirectory(), 'FILES_DIRECTORY');
  for (const file of plan.files) await readVerifiedFile(filesDir, file);
  return { plan, planSha256: sha256(bytes), persist, filesDir };
}

export function assertReceipt(receipt, artifacts, store) {
  check(receipt && receipt.snapshot_id === artifacts.plan.snapshotId && receipt.source_sha256 === artifacts.plan.sourceSha256 && receipt.plan_sha256 === artifacts.planSha256 && receipt.persist_identity === store.identity, 'RECEIPT_MISMATCH');
  check(integer(receipt.stage) && receipt.stage <= IMPORT_TABLES.length && integer(receipt.cursor) && [0, 1].includes(receipt.complete), 'RECEIPT_INVALID');
  const counts = {};
  for (let index = 0; index < IMPORT_TABLES.length; index++) {
    const table = IMPORT_TABLES[index];
    counts[table] = index < receipt.stage ? artifacts.plan.tables[table].length : index === receipt.stage ? receipt.cursor : 0;
    check(counts[table] <= artifacts.plan.tables[table].length, 'RECEIPT_INVALID');
  }
  check(receipt.counts_json === JSON.stringify(counts) && (receipt.stage < IMPORT_TABLES.length || receipt.cursor === 0) && (!receipt.complete || receipt.stage === IMPORT_TABLES.length), 'RECEIPT_INVALID');
  return counts;
}
function countJson(plan, stage, cursor) {
  return JSON.stringify(Object.fromEntries(IMPORT_TABLES.map((table, index) => [table, index < stage ? plan.tables[table].length : index === stage ? cursor : 0])));
}
export async function ensureReceipt(store, artifacts) {
  const receipt = await store.db.prepare('SELECT * FROM migration_receipt WHERE id = 1').first();
  if (receipt) { assertReceipt(receipt, artifacts, store); return receipt; }
  // Application data and operational queues must be pristine. Reference/settings seeds are allowed.
  const statements = [];
  for (const table of EMPTY_TABLES) {
    check((await store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count === 0, 'TARGET_NOT_EMPTY');
    // This conditional INSERT is checked again inside the receipt transaction; concurrent
    // runners cannot turn a nonempty target into an authorised migration target.
    statements.push(`(SELECT COUNT(*) FROM ${table}) = 0`);
  }
  await store.db.prepare(`INSERT INTO migration_receipt (id, snapshot_id, source_sha256, plan_sha256, persist_identity, stage, cursor, counts_json, complete)
    SELECT 1, ?, ?, ?, ?, 0, 0, ?, 0 WHERE ${statements.join(' AND ')}`)
    .bind(artifacts.plan.snapshotId, artifacts.plan.sourceSha256, artifacts.planSha256, store.identity, countJson(artifacts.plan, 0, 0)).run();
  const created = await store.db.prepare('SELECT * FROM migration_receipt WHERE id = 1').first();
  assertReceipt(created, artifacts, store);
  return created;
}

export async function verifyObject(bucket, file) {
  const object = await bucket.get(file.r2Key);
  if (!object) return 'R2_MISSING';
  if (object.size !== file.sizeBytes) return 'R2_SIZE';
  const bytes = Buffer.from(await object.arrayBuffer());
  if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256) return 'R2_SHA256';
  if (object.httpMetadata?.contentType !== file.mimeType) return 'R2_MIME';
  return null;
}
function insertStatement(db, table, row) {
  const columns = COLUMNS[table].filter((column) => Object.hasOwn(row, column));
  let sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  if (table === 'jenis_dokumen') sql += ` ON CONFLICT(id) DO UPDATE SET ${columns.filter((column) => column !== 'id').map((column) => `${column} = excluded.${column}`).join(', ')}`;
  return db.prepare(sql).bind(...columns.map((column) => row[column]));
}

// Shared database inspection lives here so the CLI entry points never import each other.
export async function inspectDatabase(db, plan, cursors = null) {
  const codes = new Set(), counts = {};
  const initial = cursors && IMPORT_TABLES.every((table) => cursors[table] === 0);
  for (const table of IMPORT_TABLES) {
    let wanted = plan.tables[table].slice(0, cursors ? cursors[table] : undefined).map((row) => canonicalRow(table, row, plan.createdAt));
    if (table === 'jenis_dokumen_wajib' && !initial) {
      const importedJenis = new Set(plan.tables.jenis_dokumen.map((row) => row.id));
      wanted = [...wanted, ...Object.entries(REQUIRED_MATRIX).flatMap(([status, ids]) => ids.filter((id) => !importedJenis.has(id)).map((id) => ({ jenis_dokumen_id: id, status_kepegawaian: status })))];
    }
    const columns = COLUMNS[table];
    const result = await db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all();
    counts[table] = result.results.length;
    // Seed jenis rows are allowed; the required-document matrix is replaced on import.
    if (table === 'jenis_dokumen_wajib' && initial) continue;
    if (table !== 'jenis_dokumen' && result.results.length !== wanted.length) codes.add('DB_COUNT');
    const actual = new Map(result.results.map((row) => [rowIdentity(table, row), row]));
    for (const row of wanted) {
      const stored = actual.get(rowIdentity(table, row));
      if (!stored) { codes.add('DB_ROW_MISSING'); continue; }
      if (Object.entries(row).some(([column, value]) => stored[column] !== value)) codes.add('DB_ROW_MISMATCH');
    }
  }
  for (const table of EMPTY_TABLES.filter((name) => !IMPORT_TABLES.includes(name))) {
    if ((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count !== 0) codes.add('DB_UNEXPECTED_OPERATIONAL_ROWS');
  }
  if ((await db.prepare('SELECT COUNT(*) AS count FROM akun WHERE failed_attempts <> 0 OR locked_until IS NOT NULL OR last_login_at IS NOT NULL').first()).count !== 0) codes.add('DB_AUTH_STATE');
  if ((await db.prepare('SELECT COUNT(*) AS count FROM pegawai WHERE deleted_at IS NOT NULL OR deleted_by IS NOT NULL OR purge_after IS NOT NULL').first()).count !== 0) codes.add('DB_DELETED_STATE');
  if ((await db.prepare('SELECT COUNT(*) AS count FROM arsip_dokumen WHERE deleted_at IS NOT NULL OR purge_after IS NOT NULL').first()).count !== 0) codes.add('DB_DELETED_STATE');
  const status = { Menunggu: 0, Terverifikasi: 0, Ditolak: 0 };
  const grouped = await db.prepare('SELECT status, COUNT(*) AS count FROM arsip_dokumen GROUP BY status').all();
  for (const row of grouped.results) {
    if (!Object.hasOwn(status, row.status)) codes.add('DB_STATUS');
    else status[row.status] = row.count;
  }
  const expectedStatus = cursors ? Object.fromEntries(Object.keys(status).map((value) => [value, plan.tables.arsip_dokumen.slice(0, cursors.arsip_dokumen).filter((row) => row.status === value).length])) : plan.expected.arsipPerStatus;
  for (const value of Object.keys(status)) if (status[value] !== expectedStatus[value]) codes.add('DB_STATUS');
  if ((await db.prepare('PRAGMA foreign_key_check').all()).results.length) codes.add('DB_FOREIGN_KEY');
  return { codes: [...codes].sort(), counts, arsipPerStatus: status };
}

// Static seed validation is not enough for a reused target: seeds may have been deleted
// or altered after migrations were recorded. Read the ACTUAL target references once.
export async function validateTargetReferences(db, plan) {
  const [units, ranks, educations] = await db.batch([
    db.prepare('SELECT id FROM ref_unit_organisasi'),
    db.prepare('SELECT kode, jenis_asn FROM ref_pangkat_golongan'),
    db.prepare('SELECT kode FROM ref_pendidikan'),
  ]);
  const unitIds = new Set(units.results.map((row) => row.id));
  const rankFamily = new Map(ranks.results.map((row) => [row.kode, row.jenis_asn]));
  const educationCodes = new Set(educations.results.map((row) => row.kode));
  const codes = new Set();
  for (const row of plan.tables.pegawai) {
    if (row.unit_id !== null && !unitIds.has(row.unit_id)) codes.add('TARGET_REFERENCE_MISSING');
    if (row.pendidikan_kode !== null && !educationCodes.has(row.pendidikan_kode)) codes.add('TARGET_REFERENCE_MISSING');
    if (row.pangkat_kode !== null) {
      const family = rankFamily.get(row.pangkat_kode);
      if (family === undefined) codes.add('TARGET_REFERENCE_MISSING');
      else if ((family === 'PPPK') !== (row.status_kepegawaian === 'PPPK')) codes.add('TARGET_REFERENCE_MISMATCH');
    }
  }
  return [...codes].sort();
}

export async function applyLocal(options) {
  const artifacts = await loadArtifacts(options);
  if (options.apply !== true) return { ok: true, mode: 'dry-run', codes: [], expected: artifacts.plan.expected };
  const store = await openLocalStore(artifacts.persist);
  try {
    // Before receipt creation, R2 uploads, or application rows; also checked on resume.
    const references = await validateTargetReferences(store.db, artifacts.plan);
    check(references.length === 0, references[0]);
    let receipt = await ensureReceipt(store, artifacts);
    // A matching receipt authorises resume, not skipping integrity checks.
    const before = await inspectDatabase(store.db, artifacts.plan, assertReceipt(receipt, artifacts, store));
    check(before.codes.length === 0, 'TARGET_CHANGED');
    for (const file of artifacts.plan.files) {
      const bytes = await readVerifiedFile(artifacts.filesDir, file);
      const existing = await store.bucket.head(file.r2Key);
      if (existing) check(await verifyObject(store.bucket, file) === null, 'R2_CONFLICT');
      else await store.bucket.put(file.r2Key, bytes, { httpMetadata: { contentType: file.mimeType }, customMetadata: { sha256: file.sha256 } });
      check(await verifyObject(store.bucket, file) === null, 'R2_VERIFY_FAILED');
    }
    // Each chunk and its cursor are one D1 batch transaction. Failure rolls back both.
    for (let stage = receipt.stage; stage < IMPORT_TABLES.length; stage++) {
      const table = IMPORT_TABLES[stage], rows = artifacts.plan.tables[table];
      let cursor = stage === receipt.stage ? receipt.cursor : 0;
      do {
        const end = Math.min(cursor + 200, rows.length);
        const nextStage = end === rows.length ? stage + 1 : stage;
        const nextCursor = end === rows.length ? 0 : end;
        const statements = [];
        if (stage === 0 && cursor === 0) statements.push(store.db.prepare('DELETE FROM jenis_dokumen_wajib WHERE jenis_dokumen_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(artifacts.plan.tables.jenis_dokumen.map((row) => row.id))));
        statements.push(...rows.slice(cursor, end).map((row) => insertStatement(store.db, table, row)));
        statements.push(store.db.prepare(`UPDATE migration_receipt SET stage = ?, cursor = ?, counts_json = ?
          WHERE id = 1 AND stage = ? AND cursor = ? AND complete = 0`)
          .bind(nextStage, nextCursor, countJson(artifacts.plan, nextStage, nextCursor), stage, cursor));
        // A no-op cursor CAS must ABORT the transaction, not commit uncheckpointed
        // rows. SQLite evaluates json('') only on the failing CASE branch.
        statements.push(store.db.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('') END AS receipt_guard"));
        await store.db.batch(statements);
        cursor = end;
      } while (cursor < rows.length);
    }
    const final = await inspectDatabase(store.db, artifacts.plan);
    check(final.codes.length === 0, 'RECONCILE_DATABASE');
    for (const file of artifacts.plan.files) check(await verifyObject(store.bucket, file) === null, 'RECONCILE_R2');
    await store.db.prepare('UPDATE migration_receipt SET complete = 1 WHERE id = 1 AND stage = ? AND cursor = 0').bind(IMPORT_TABLES.length).run();
    receipt = await store.db.prepare('SELECT * FROM migration_receipt WHERE id = 1').first();
    assertReceipt(receipt, artifacts, store);
    check(receipt.complete === 1, 'RECEIPT_INCOMPLETE');
    return { ok: true, mode: 'local-apply', codes: [], counts: final.counts, files: artifacts.plan.files.length };
  } finally { await store.close(); }
}

if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await applyLocal(parseArgs(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ ok: false, codes: [safeCode(error)] })); process.exitCode = 1; }
}
