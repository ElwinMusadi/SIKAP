-- M4: bind each history row to the document slot it describes.
--
-- arsip_dokumen uses `INTEGER PRIMARY KEY` WITHOUT AUTOINCREMENT, so SQLite may hand
-- out the id of a purged arsip (the highest id) again. arsip_dokumen_riwayat has no FK
-- (history outlives purged rows), so a reused id would otherwise show another
-- employee's history. We do NOT rely on AUTOINCREMENT / sqlite_sequence to fix this
-- (rebuilding arsip_dokumen on D1 would need PRAGMA foreign_keys / defer_foreign_keys
-- juggling because arsip_dokumen_versi cascades from it). Instead every riwayat row now
-- records (pegawai_id, jenis_dokumen_id) and reads filter on the full triple taken from
-- the AUTHORISED arsip row: a reused id for a different pegawai/jenis never matches.
-- A reused id for the SAME pegawai + jenis is the same document slot, so sharing its
-- history is intended.
--
-- Additive and nullable. Rows whose arsip still exists are backfilled; rows of already
-- purged arsip stay NULL and are therefore never returned again (correct: their slot
-- is gone).
--
-- L1 note: jenis_dokumen.max_size_bytes keeps its CHECK (> 0) only; SQLite cannot alter a
-- CHECK in place. The application caps it at DOCUMENT_POLICY.maxBytes (5 MB).

ALTER TABLE arsip_dokumen_riwayat ADD COLUMN pegawai_id INTEGER;
ALTER TABLE arsip_dokumen_riwayat ADD COLUMN jenis_dokumen_id TEXT;

UPDATE arsip_dokumen_riwayat
   SET pegawai_id = (SELECT a.pegawai_id FROM arsip_dokumen a WHERE a.id = arsip_dokumen_riwayat.arsip_id),
       jenis_dokumen_id = (SELECT a.jenis_dokumen_id FROM arsip_dokumen a WHERE a.id = arsip_dokumen_riwayat.arsip_id)
 WHERE pegawai_id IS NULL;

CREATE INDEX idx_riwayat_slot ON arsip_dokumen_riwayat(arsip_id, pegawai_id, jenis_dokumen_id, created_at);
