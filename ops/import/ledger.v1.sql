-- SIKAP remote importer ledger, schema version 1. LOCAL CANDIDATE ONLY.
--
-- Not an application migration: lives outside migrations/ so it is never picked up by
-- wrangler d1 migrations or the offline local-store. Byte-pinned by
-- scripts/import/ledger-contract.mjs (LEDGER_DDL_SHA256 over CRLF-normalized UTF-8 bytes).
-- Applying it anywhere other than a disposable local Miniflare database requires a separate
-- reviewed decision. It was validated only against local Miniflare D1 (no remote proof).
--
-- Contract with scripts/import/core.mjs (LEDGER, SQL.claim/journal/checkpoint):
--   * exactly one run row (id = 1), plain CREATE only so an existing object aborts the batch
--   * claim_seq may equal ordinal + 1 transiently inside one request (claim before checkpoint),
--     the checkpoint restores claim_seq = ordinal by incrementing ordinal
--   * ordinal 0 has no previous chunk hash, every later ordinal has one
--   * journal key (run_nonce, ordinal) is unique and its (run_nonce, target) must name the run
--   * every stored integer has typeof 'integer' and lies in 0..2^53-1. Column affinity runs
--     BEFORE the CHECK: numeric text and integral REAL (e.g. 1.0) are coerced to INTEGER and
--     accepted; fractional REAL, non-numeric TEXT and BLOB stay non-integer and are rejected
--   * complete is always 0 in v1: core has no completion statement and classifyResume requires
--     0. Any completion protocol needs a new reviewed schema version
--   * hex identifiers are lowercase and non-zero, matching core descriptor validation; the BLOB
--     length check rejects values with an embedded NUL (length()/GLOB stop at the first NUL)
-- No defaults are derived from wall-clock time, and nothing here updates rows automatically.

CREATE TABLE __sikap_import_v1_run (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  run_nonce             TEXT NOT NULL CHECK (typeof(run_nonce) = 'text' AND length(run_nonce) = 32 AND length(CAST(run_nonce AS BLOB)) = 32 AND run_nonce NOT GLOB '*[^0-9a-f]*' AND run_nonce GLOB '*[1-9a-f]*'),
  owner_nonce           TEXT NOT NULL CHECK (typeof(owner_nonce) = 'text' AND length(owner_nonce) = 32 AND length(CAST(owner_nonce AS BLOB)) = 32 AND owner_nonce NOT GLOB '*[^0-9a-f]*' AND owner_nonce GLOB '*[1-9a-f]*'),
  epoch                 INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch BETWEEN 0 AND 9007199254740991),
  target_binding_sha256 TEXT NOT NULL CHECK (typeof(target_binding_sha256) = 'text' AND length(target_binding_sha256) = 64 AND length(CAST(target_binding_sha256 AS BLOB)) = 64 AND target_binding_sha256 NOT GLOB '*[^0-9a-f]*' AND target_binding_sha256 GLOB '*[1-9a-f]*'),
  plan_sha256           TEXT NOT NULL CHECK (typeof(plan_sha256) = 'text' AND length(plan_sha256) = 64 AND length(CAST(plan_sha256 AS BLOB)) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*' AND plan_sha256 GLOB '*[1-9a-f]*'),
  stage                 INTEGER NOT NULL CHECK (typeof(stage) = 'integer' AND stage BETWEEN 0 AND 7),
  cursor                INTEGER NOT NULL CHECK (typeof(cursor) = 'integer' AND cursor BETWEEN 0 AND 9007199254740991),
  ordinal               INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 9007199254740991),
  claim_seq             INTEGER NOT NULL CHECK (typeof(claim_seq) = 'integer' AND claim_seq BETWEEN 0 AND 9007199254740991),
  last_chunk_sha256     TEXT CHECK (last_chunk_sha256 IS NULL OR (typeof(last_chunk_sha256) = 'text' AND length(last_chunk_sha256) = 64 AND length(CAST(last_chunk_sha256 AS BLOB)) = 64 AND last_chunk_sha256 NOT GLOB '*[^0-9a-f]*' AND last_chunk_sha256 GLOB '*[1-9a-f]*')),
  complete              INTEGER NOT NULL DEFAULT 0 CHECK (typeof(complete) = 'integer' AND complete = 0),
  CHECK (run_nonce <> owner_nonce),
  CHECK (claim_seq = ordinal OR claim_seq = ordinal + 1),
  CHECK ((ordinal = 0) = (last_chunk_sha256 IS NULL)),
  CHECK (stage < 7 OR cursor = 0),
  UNIQUE (run_nonce, target_binding_sha256)
);

CREATE TABLE __sikap_import_v1_journal (
  run_nonce             TEXT NOT NULL CHECK (typeof(run_nonce) = 'text' AND length(run_nonce) = 32 AND length(CAST(run_nonce AS BLOB)) = 32 AND run_nonce NOT GLOB '*[^0-9a-f]*' AND run_nonce GLOB '*[1-9a-f]*'),
  epoch                 INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch BETWEEN 0 AND 9007199254740991),
  target_binding_sha256 TEXT NOT NULL CHECK (typeof(target_binding_sha256) = 'text' AND length(target_binding_sha256) = 64 AND length(CAST(target_binding_sha256 AS BLOB)) = 64 AND target_binding_sha256 NOT GLOB '*[^0-9a-f]*' AND target_binding_sha256 GLOB '*[1-9a-f]*'),
  ordinal               INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 9007199254740991),
  stage                 INTEGER NOT NULL CHECK (typeof(stage) = 'integer' AND stage BETWEEN 0 AND 6),
  table_name            TEXT NOT NULL CHECK (typeof(table_name) = 'text'),
  start_cursor          INTEGER NOT NULL CHECK (typeof(start_cursor) = 'integer' AND start_cursor BETWEEN 0 AND 9007199254740991),
  end_cursor            INTEGER NOT NULL CHECK (typeof(end_cursor) = 'integer' AND end_cursor BETWEEN 0 AND 9007199254740991),
  chunk_sha256          TEXT NOT NULL CHECK (typeof(chunk_sha256) = 'text' AND length(chunk_sha256) = 64 AND length(CAST(chunk_sha256 AS BLOB)) = 64 AND chunk_sha256 NOT GLOB '*[^0-9a-f]*' AND chunk_sha256 GLOB '*[1-9a-f]*'),
  CHECK (end_cursor >= start_cursor),
  CHECK (table_name = CASE stage WHEN 0 THEN 'jenis_dokumen' WHEN 1 THEN 'jenis_dokumen_wajib' WHEN 2 THEN 'pegawai' WHEN 3 THEN 'akun' WHEN 4 THEN 'arsip_dokumen' WHEN 5 THEN 'arsip_dokumen_riwayat' WHEN 6 THEN 'log_aktivitas' END),
  PRIMARY KEY (run_nonce, ordinal),
  FOREIGN KEY (run_nonce, target_binding_sha256) REFERENCES __sikap_import_v1_run (run_nonce, target_binding_sha256)
);
