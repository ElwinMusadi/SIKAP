-- Integrasi API (docs/RENCANA-API-INTEGRASI.md, contract: shared/integrasi.ts).
--
-- A kunci API lets another application (first: PINTU) read employee data through
-- /api/v1 with `Authorization: Bearer skp_<id_publik>_<secret>`. Only the SHA-256 of the
-- full key is stored; the key itself is shown once when an Admin creates it.
--
-- id AUTOINCREMENT: ids of deleted keys are never reused, so log_aktivitas rows that
-- reference a key stay unambiguous. Deleting a row revokes the key immediately (no cache).
-- izin: JSON array of scopes the server knows (v1: ["pegawai:baca"]).
-- last_used_at/last_used_ip: written at most every 5 minutes per key (saves D1 writes).
--
-- Deliberately NOT in BACKUP_TABLES (shared/backup.ts): restoring a backup must never
-- bring a deleted key back to life. Keys can always be issued again.

CREATE TABLE kunci_api (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  id_publik       TEXT NOT NULL UNIQUE CHECK (length(id_publik) = 12 AND id_publik NOT GLOB '*[^0-9a-f]*'),
  token_hash      TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  nama            TEXT NOT NULL CHECK (length(nama) BETWEEN 1 AND 60),
  keterangan      TEXT CHECK (keterangan IS NULL OR length(keterangan) <= 200),
  izin            TEXT NOT NULL CHECK (json_valid(izin) AND json_type(izin) = 'array'),
  created_at      TEXT NOT NULL,
  created_by      INTEGER,                         -- no FK: the creating admin may be purged first
  created_by_nama TEXT,
  expires_at      TEXT NOT NULL CHECK (expires_at > created_at),
  last_used_at    TEXT,
  last_used_ip    TEXT
);
