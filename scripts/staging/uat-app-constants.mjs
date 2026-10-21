// Pinned bindings of the protected full-app UAT (ops/uat-app) after the verified private import.
// Pure data: no imports, no I/O. Must equal the import target in scripts/import/real-data-gate.mjs
// (alignment is pinned by deploy-uat-app.test.mjs). uat-constants.mjs UAT_DB stays the OLD
// holding/fixture database and remains in the import-core deny list; it is never an app binding.
export const UAT_APP_DB = '885b655b-3482-44fc-9d01-56ad0204bb35';
export const UAT_APP_DB_NAME = 'sikap-import-uat-20261018';
export const UAT_APP_FILES_BUCKET = 'sikap-import-uat-20261018-files';
// Retired app resources (old fixture DB id/name, old files and backup buckets, backup binding).
// Any occurrence in the app source or release config is refused. Not added to the shared
// DENIED_REFS because the holding deploy intentionally still binds the old fixture DB.
export const UAT_APP_RETIRED_REFS = Object.freeze([
  '9d6ca598-057e-4297-9b8c-3ce789c5ab14', 'sikap-uat-db', 'sikap-uat-files', 'sikap-uat-backup', 'BACKUPS',
]);
