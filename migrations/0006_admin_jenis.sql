-- Phase 7: admin-editable document types.
--
-- `updated_at` is the optimistic-concurrency stamp for PATCH /api/admin/jenis-dokumen/:id
-- (shared/administrasi.ts expectedUpdatedAt). Existing seed rows get the epoch sentinel so
-- the column can be NOT NULL without rewriting seed data; every PATCH bumps it strictly
-- monotonically (server/db/administrasi.ts).
--
-- No new log_aktivitas indexes: category filters are action-prefix ranges served by
-- idx_log_action(action, ts DESC) and date/cursor filters by idx_log_ts(ts DESC).
ALTER TABLE jenis_dokumen ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
