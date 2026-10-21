// Pinned contract for the importer ledger DDL (ops/import/ledger.v1.sql). PURE: imports only
// node:crypto; no filesystem, environment, network, clock or CLI. Callers pass the DDL text.
//
// A valid result proves only that the text is byte-identical (after CRLF -> LF) to the reviewed
// v1 DDL. It proves nothing about any target database, applies nothing and authorizes nothing:
// every result carries the fixed false flags below. The DDL itself was exercised only against a
// disposable local Miniflare D1 database (scripts/import/ledger.integration.test.mjs).
import { createHash } from 'node:crypto';

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_SQL_FILE = 'ops/import/ledger.v1.sql';
export const LEDGER_MAX_BYTES = 16 * 1024;
// SHA-256 of the UTF-8 DDL bytes after CRLF -> LF normalization (repo is eol=lf).
export const LEDGER_DDL_SHA256 = 'd535092f2854e35823e1bda430e13ebfda9a871aca65ce900b8f5be6251050e9';
// Exact sqlite_master objects the DDL creates (incl. SQLite-generated autoindexes: run UNIQUE,
// journal composite PRIMARY KEY). run.id is INTEGER PRIMARY KEY (rowid alias, no index).
export const LEDGER_SCHEMA_OBJECTS = Object.freeze([
  Object.freeze({ type: 'index', name: 'sqlite_autoindex___sikap_import_v1_journal_1', tbl_name: '__sikap_import_v1_journal' }),
  Object.freeze({ type: 'index', name: 'sqlite_autoindex___sikap_import_v1_run_1', tbl_name: '__sikap_import_v1_run' }),
  Object.freeze({ type: 'table', name: '__sikap_import_v1_journal', tbl_name: '__sikap_import_v1_journal' }),
  Object.freeze({ type: 'table', name: '__sikap_import_v1_run', tbl_name: '__sikap_import_v1_run' }),
]);
export const LEDGER_FLAGS = Object.freeze({
  localCandidateOnly: true, appliedToTarget: false, remoteVerified: false, transportProven: false,
  readyForImport: false, authorizesExecution: false,
});
export const LEDGER_CODES = Object.freeze(['OK', 'LEDGER_SQL_TYPE', 'LEDGER_SQL_SIZE', 'LEDGER_SQL_ENCODING', 'LEDGER_SQL_HASH_MISMATCH']);

const result = (code) => Object.freeze({ valid: code === 'OK', code, schemaVersion: LEDGER_SCHEMA_VERSION, ...LEDGER_FLAGS });

// Validates DDL text against the pin. Output is a fixed-shape object; input is never echoed.
export function validateLedgerSql(text) {
  if (typeof text !== 'string') return result('LEDGER_SQL_TYPE');
  if (text.length > LEDGER_MAX_BYTES || Buffer.byteLength(text, 'utf8') > LEDGER_MAX_BYTES) return result('LEDGER_SQL_SIZE');
  const normalized = text.replace(/\r\n/g, '\n');
  if (!text.isWellFormed() || normalized.includes('\r') || normalized.includes('\0') || normalized.startsWith('\uFEFF')) return result('LEDGER_SQL_ENCODING');
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return result(digest === LEDGER_DDL_SHA256 ? 'OK' : 'LEDGER_SQL_HASH_MISMATCH');
}
