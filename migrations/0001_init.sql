-- SIKAP — initial schema (MIGRATION_PLAN.md §2 + owner decisions 15 Oct 2026).
--
-- Conventions
--   * Timestamps: ISO-8601 UTC TEXT, e.g. '2026-10-15T21:16:48.123Z'
--     (same shape as JS `Date#toISOString()` so values compare lexicographically).
--   * Dates without time: 'YYYY-MM-DD'.
--   * Enum CHECK values mirror shared/enums.ts exactly — change both together.
--   * D1 enforces foreign keys by default; no PRAGMA here (it would not persist).

-- ---------------------------------------------------------------------------
-- Reference tables (editable by admin later)
-- ---------------------------------------------------------------------------

CREATE TABLE ref_pangkat_golongan (
  kode        TEXT PRIMARY KEY,                    -- 'III/a', 'PPPK-IX'
  nama        TEXT NOT NULL,                       -- 'Penata Muda (III/a)'
  jenis_asn   TEXT NOT NULL CHECK (jenis_asn IN ('PNS','PPPK')),
  urutan      INTEGER NOT NULL,
  aktif       INTEGER NOT NULL DEFAULT 1 CHECK (aktif IN (0,1))
);

CREATE TABLE ref_unit_organisasi (
  id     INTEGER PRIMARY KEY,
  nama   TEXT NOT NULL UNIQUE,
  aktif  INTEGER NOT NULL DEFAULT 1 CHECK (aktif IN (0,1))
);

CREATE TABLE ref_pendidikan (
  kode   TEXT PRIMARY KEY,                         -- 'S1'
  nama   TEXT NOT NULL,                            -- 'S-1 / Sarjana'
  urutan INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Pegawai + akun + sesi
-- ---------------------------------------------------------------------------

CREATE TABLE pegawai (
  id                  INTEGER PRIMARY KEY,
  nip                 TEXT NOT NULL UNIQUE CHECK (length(nip) = 18 AND nip NOT GLOB '*[^0-9]*'),
  nik                 TEXT UNIQUE CHECK (nik IS NULL OR (length(nik) = 16 AND nik NOT GLOB '*[^0-9]*')),
  nama                TEXT NOT NULL,
  role                TEXT NOT NULL DEFAULT 'Pegawai' CHECK (role IN ('Admin','Pegawai')),
  status_akun         TEXT NOT NULL DEFAULT 'Aktif'   CHECK (status_akun IN ('Aktif','Nonaktif')),
  status_kepegawaian  TEXT CHECK (status_kepegawaian IN ('PNS','CPNS','PPPK')),
  pangkat_kode        TEXT REFERENCES ref_pangkat_golongan(kode),
  tmt_pangkat         TEXT,
  jabatan             TEXT,
  jenis_jabatan       TEXT CHECK (jenis_jabatan IN ('Fungsional','Pelaksana','Struktural')),
  tmt_jabatan         TEXT,
  unit_id             INTEGER REFERENCES ref_unit_organisasi(id),
  tempat_lahir        TEXT,
  tanggal_lahir       TEXT,
  jenis_kelamin       TEXT CHECK (jenis_kelamin IN ('Laki-laki','Perempuan')),
  agama               TEXT CHECK (agama IN ('Kristen Protestan','Kristen Katholik','Islam','Hindu','Buddha','Konghucu')),
  pendidikan_kode     TEXT REFERENCES ref_pendidikan(kode),
  status_pernikahan   TEXT CHECK (status_pernikahan IN ('Belum Menikah','Menikah','Cerai')),
  golongan_darah      TEXT CHECK (golongan_darah IN ('A','B','AB','O','Tidak Tahu')),
  no_hp               TEXT,                        -- normalised '62…' (no '+')
  email               TEXT,
  alamat              TEXT,
  foto_r2_key         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Soft delete, 7-day retention (owner decision #5). Cron purges D1 + R2 after purge_after.
  deleted_at          TEXT,
  deleted_by          INTEGER,                     -- no FK: the deleting admin may be purged first
  purge_after         TEXT,
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
);
CREATE INDEX idx_pegawai_status ON pegawai(status_kepegawaian, status_akun) WHERE deleted_at IS NULL;
CREATE INDEX idx_pegawai_nama   ON pegawai(nama COLLATE NOCASE);
CREATE INDEX idx_pegawai_purge  ON pegawai(purge_after) WHERE deleted_at IS NOT NULL;

CREATE TABLE akun (
  pegawai_id            INTEGER PRIMARY KEY REFERENCES pegawai(id) ON DELETE CASCADE,
  -- 'pbkdf2-sha256$<iter>$<salt_b64>$<hash_b64>'  (PBKDF2 input = HMAC-SHA256(PASSWORD_PEPPER, password))
  -- 'legacy-wrap$<iter>$<salt_b64>$<hash_b64>'    (PBKDF2 input = HMAC-SHA256(PASSWORD_PEPPER, sha256hex(password)))
  password_hash         TEXT NOT NULL,
  -- Banner only, never blocks access (owner decision #6).
  is_default_password   INTEGER NOT NULL DEFAULT 1 CHECK (is_default_password IN (0,1)),
  failed_attempts       INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          TEXT,
  password_changed_at   TEXT,
  last_login_at         TEXT
);
CREATE INDEX idx_akun_default_pw ON akun(is_default_password) WHERE is_default_password = 1;

CREATE TABLE sesi (
  token_hash   TEXT PRIMARY KEY,                   -- lowercase hex SHA-256(token); raw token only in cookie
  pegawai_id   INTEGER NOT NULL REFERENCES pegawai(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_sesi_pegawai ON sesi(pegawai_id);
CREATE INDEX idx_sesi_expires ON sesi(expires_at);

-- Fixed-window counters (e.g. failed logins per IP). Cleaned by cron.
CREATE TABLE rate_limit (
  key          TEXT PRIMARY KEY,                   -- 'login-fail:<ip>'
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rate_limit_window ON rate_limit(window_start);

-- ---------------------------------------------------------------------------
-- Dokumen
-- ---------------------------------------------------------------------------

CREATE TABLE jenis_dokumen (
  id             TEXT PRIMARY KEY,                 -- 'DOC-KTP'
  nama           TEXT NOT NULL,
  kategori       TEXT NOT NULL,                    -- 'Dokumen Pribadi' | 'Dokumen Kepegawaian' | 'Dokumen Pendidikan'
  urutan         INTEGER NOT NULL DEFAULT 0,
  aktif          INTEGER NOT NULL DEFAULT 1 CHECK (aktif IN (0,1)),
  max_size_bytes INTEGER NOT NULL DEFAULT 5242880 CHECK (max_size_bytes > 0)
);

-- Required documents per status kepegawaian (fixes F-13). Editable by admin.
CREATE TABLE jenis_dokumen_wajib (
  jenis_dokumen_id   TEXT NOT NULL REFERENCES jenis_dokumen(id) ON DELETE CASCADE,
  status_kepegawaian TEXT NOT NULL CHECK (status_kepegawaian IN ('PNS','CPNS','PPPK')),
  PRIMARY KEY (jenis_dokumen_id, status_kepegawaian)
);
CREATE INDEX idx_wajib_status ON jenis_dokumen_wajib(status_kepegawaian);

CREATE TABLE arsip_dokumen (
  id                INTEGER PRIMARY KEY,
  pegawai_id        INTEGER NOT NULL REFERENCES pegawai(id) ON DELETE CASCADE,
  jenis_dokumen_id  TEXT NOT NULL REFERENCES jenis_dokumen(id),
  status            TEXT NOT NULL CHECK (status IN ('Menunggu','Terverifikasi','Ditolak')),
  r2_key            TEXT NOT NULL,
  file_name         TEXT NOT NULL,                 -- [NIP]_[Nama]_[ID].[ext]
  mime_type         TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256            TEXT NOT NULL,
  versi             INTEGER NOT NULL DEFAULT 1 CHECK (versi >= 1),
  catatan_admin     TEXT,
  uploaded_at       TEXT NOT NULL,
  uploaded_by       INTEGER REFERENCES pegawai(id) ON DELETE SET NULL,
  verified_at       TEXT,
  verified_by       INTEGER REFERENCES pegawai(id) ON DELETE SET NULL,
  -- Soft delete, 3-day retention (owner decision #4).
  deleted_at        TEXT,
  purge_after       TEXT,
  UNIQUE (pegawai_id, jenis_dokumen_id),
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
);
CREATE INDEX idx_arsip_status ON arsip_dokumen(status, uploaded_at);
CREATE INDEX idx_arsip_jenis  ON arsip_dokumen(jenis_dokumen_id, status);
CREATE INDEX idx_arsip_purge  ON arsip_dokumen(purge_after) WHERE deleted_at IS NOT NULL;

-- Previous file versions kept 3 days for rollback (owner decision #4).
-- Inserted ONLY after the new file is stored in R2 and the arsip row is updated.
CREATE TABLE arsip_dokumen_versi (
  id             INTEGER PRIMARY KEY,
  arsip_id       INTEGER NOT NULL REFERENCES arsip_dokumen(id) ON DELETE CASCADE,
  versi          INTEGER NOT NULL,
  r2_key         TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('Menunggu','Terverifikasi','Ditolak')), -- restored on rollback
  catatan_admin  TEXT,
  uploaded_at    TEXT NOT NULL,
  verified_at    TEXT,
  verified_by    INTEGER,
  replaced_at    TEXT NOT NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('REUPLOAD','DELETE')),
  purge_after    TEXT NOT NULL,                    -- replaced_at + 3 days
  UNIQUE (arsip_id, versi)
);
CREATE INDEX idx_versi_purge ON arsip_dokumen_versi(purge_after);

-- Per-document audit trail.
CREATE TABLE arsip_dokumen_riwayat (
  id          INTEGER PRIMARY KEY,
  arsip_id    INTEGER NOT NULL,                    -- no FK: history outlives purged rows
  versi       INTEGER NOT NULL,
  aksi        TEXT NOT NULL CHECK (aksi IN ('UPLOAD','REUPLOAD','APPROVE','REJECT','DELETE','RESTORE','ROLLBACK')),
  status      TEXT CHECK (status IS NULL OR status IN ('Menunggu','Terverifikasi','Ditolak')),
  catatan     TEXT,
  actor_id    INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_riwayat_arsip ON arsip_dokumen_riwayat(arsip_id, created_at);

-- ---------------------------------------------------------------------------
-- Pengajuan perubahan data kepegawaian (owner decision #6)
-- ---------------------------------------------------------------------------

CREATE TABLE pengajuan_perubahan (
  id            INTEGER PRIMARY KEY,
  pegawai_id    INTEGER NOT NULL REFERENCES pegawai(id) ON DELETE CASCADE,
  perubahan     TEXT NOT NULL CHECK (json_valid(perubahan)), -- { field: { lama, baru } }
  alasan        TEXT,
  status        TEXT NOT NULL DEFAULT 'Menunggu' CHECK (status IN ('Menunggu','Disetujui','Ditolak','Dibatalkan')),
  catatan_admin TEXT,
  created_at    TEXT NOT NULL,
  reviewed_at   TEXT,
  reviewed_by   INTEGER REFERENCES pegawai(id) ON DELETE SET NULL
);
-- At most one pending request per pegawai.
CREATE UNIQUE INDEX uq_pengajuan_aktif ON pengajuan_perubahan(pegawai_id) WHERE status = 'Menunggu';
CREATE INDEX idx_pengajuan_status ON pengajuan_perubahan(status, created_at);
CREATE INDEX idx_pengajuan_pegawai ON pengajuan_perubahan(pegawai_id, created_at);

-- ---------------------------------------------------------------------------
-- Audit log, settings, notification outbox
-- ---------------------------------------------------------------------------

CREATE TABLE log_aktivitas (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  actor_id     INTEGER,                            -- no FK: log must survive pegawai purge
  actor_nip    TEXT,
  actor_nama   TEXT,
  actor_role   TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  description  TEXT,
  result       TEXT NOT NULL CHECK (result IN ('SUCCESS','FAILURE','WARNING','PARTIAL')),
  ip           TEXT
);
CREATE INDEX idx_log_ts     ON log_aktivitas(ts DESC);
CREATE INDEX idx_log_action ON log_aktivitas(action, ts DESC);
CREATE INDEX idx_log_actor  ON log_aktivitas(actor_id, ts DESC);

CREATE TABLE pengaturan (
  key         TEXT PRIMARY KEY,                    -- 'wa.provider', 'notif.dokumen_baru', ...
  value       TEXT NOT NULL,                       -- secrets: AES-GCM ciphertext (SETTINGS_ENC_KEY)
  is_secret   INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0,1)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  INTEGER
);

CREATE TABLE notifikasi_outbox (
  id          INTEGER PRIMARY KEY,
  channel     TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  target      TEXT NOT NULL,
  template    TEXT NOT NULL,                       -- dokumen_baru_admin | dokumen_terverifikasi | dokumen_ditolak | test
  params      TEXT NOT NULL CHECK (json_valid(params)),
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE INDEX idx_outbox_pending ON notifikasi_outbox(status, created_at) WHERE status = 'PENDING';
