// Reviewed PRODUCTION import pins (pure frozen data, NO imports, no I/O).
//
// Every value below is deliberately PENDING/null. The production orchestrator fails closed
// (RUNTIME_PIN_PENDING / PLAN_PIN_PENDING) until the parent replaces them after independent review:
//   1. review the source of every MODULE_FILES entry, then pin MODULE_PINS from `--print-module-pins`;
//   2. run `--describe-plan` on the FINAL (post-freeze) plan (requires module pins), review counts only;
//   3. pin PLAN_FACTS; 4. `--check-only`; 5. `--import-production` only after gate-E approval.
// The target itself is pinned in real-data-gate.mjs (PROD_TARGET), which is a pinned module.
//
// SELF_SOURCES cannot pin themselves (a file cannot contain its own hash). `--print-module-pins`
// prints their hashes for the reviewer to RECORD; they are not enforced at runtime. This gap is
// accepted and documented: the self-sources are bound only by review of the committed bytes.
export const PENDING = '0000000000000000000000000000000000000000000000000000000000000000';

// Exact transitive closure of relative static/dynamic imports of run-prod-import.mjs, minus
// SELF_SOURCES (tests recompute and compare). SHA-256 of LF-normalized UTF-8 text.
// External packages (miniflare, used only for the in-memory expected schema) and node built-ins are
// NOT pinned here; package-lock.json review covers them.
export const MODULE_FILES = Object.freeze([
  'scripts/import/prod-import-orchestrator.mjs',
  'scripts/import/core.mjs', 'scripts/import/d1-rest.mjs', 'scripts/import/d1-readback.mjs', 'scripts/import/r2-s3.mjs',
  'scripts/import/real-data-gate.mjs', 'scripts/import/synthetic-runner.mjs', 'scripts/import/ledger-contract.mjs',
  'scripts/migrate/local-store.mjs', 'scripts/migrate/apply-local.mjs',
  'scripts/migrate/normalize.mjs', 'scripts/migrate/contract.mjs',
  'scripts/staging/uat-constants.mjs',
]);
// Pinned 21 Oct 2026 from `--print-module-pins` (LF-normalized SHA-256) after the importer review.
export const MODULE_PINS = Object.freeze([
  ['scripts/import/prod-import-orchestrator.mjs', '4a45135fb8506628ec0205c1b26243456cfa4e25d985b13d496384c9fbfbaf10'],
  ['scripts/import/core.mjs', '3f85c5d4b2038d6b689556c7ff857b6d4cb31cab6f82d6302c2f4f7c2e09d520'],
  ['scripts/import/d1-rest.mjs', '657c16bdbeff0b2e220e58c1722b040f6a7f093e4df43266cb8859396cf57e4c'],
  ['scripts/import/d1-readback.mjs', '27fa0e4d4157c3a18c7d0c204db08535c69a319c9f9ec5fdb7d953bd86a6939b'],
  ['scripts/import/r2-s3.mjs', 'ced68c6192a2407b7cae3e39a68288ec84f365fafef88ba0a712c0083a36c2fd'],
  ['scripts/import/real-data-gate.mjs', '907b010c55556545dcdf7f06d6535081115d424bcd9389ce1c2ba57fe1a2efe7'],
  ['scripts/import/synthetic-runner.mjs', 'dad10c37d2583d4e852dde13991fa23a7f47f438aac0eae5c4c52699e23979f8'],
  ['scripts/import/ledger-contract.mjs', 'fdfbd5d58dcc91a2f29d427c3f21ab3cef7e261b90f5767664c9fb1245b5fc16'],
  ['scripts/migrate/local-store.mjs', 'a6852f3020c164646ffde4aaf4fbc37973d5953a82c4bb99b7ed24c54033622b'],
  ['scripts/migrate/apply-local.mjs', '9ae67c4e31af3f4f1f627835e88f2b2ce0d404e76999f821af92a1e1210061ec'],
  ['scripts/migrate/normalize.mjs', '6cb008d07b8366ec4c4e777624df8d70bccd1881e945211aaa0eacc391344c90'],
  ['scripts/migrate/contract.mjs', '3678235bd07cbc3eb8eebd0a35c5ef8c0807426a33bd967436777761285bebc6'],
  ['scripts/staging/uat-constants.mjs', 'b260c3f17a794ab0b44eb11dd32c6aeb23e9816a148f7f68e5c1aff6cf1eb5a7'],
].map((pair) => Object.freeze(pair)));
export const SELF_SOURCES = Object.freeze(['scripts/import/run-prod-import.mjs', 'scripts/import/prod-import-pins.mjs']);

// FINAL-plan facts (counts and warning-CODE counts only; never rows/values/diagnostic detail).
// When pinned, nested objects must also be Object.freeze'd; the orchestrator additionally uses a deep frozen copy.
// Pinned 21 Oct 2026 from `--describe-plan` on the FINAL post-freeze plan (snapshot c7d62229): 0 errors, 74 warnings.
export const PLAN_FACTS = Object.freeze({
  snapshotId: 'c7d62229-c808-4972-a6c3-975e8927dd15',
  planSha256: 'a52c081f77901a15565eef39ee96624bd761fceb16ee1f45695fa32b9d24055d',
  expected: Object.freeze({
    pegawai: 46, akun: 46, arsip: 63, files: 66, totalFileBytes: 44162297,
    arsipPerStatus: Object.freeze({ Menunggu: 1, Terverifikasi: 59, Ditolak: 3 }),
  }),
  warningCounts: Object.freeze({
    NON_ATOMIC_SNAPSHOT: 1, OWNER_REQUIREMENT_MATRIX: 11, CUSTOM_JENIS_OPTIONAL: 1, NORMALIZED_PANGKAT: 6, NORMALIZED_UNIT: 10,
    NORMALIZED_PENDIDIKAN: 10, PLACEHOLDER_PANGKAT: 4, MISSING_HISTORIC_LOG_ACTOR: 31,
  }),
  diagnosticsTotal: 74,
});

// Exact reviewed local deployment-config inventory (repo-relative, POSIX separators). The
// orchestrator's bounded repo walk must find exactly this set; a missing or extra config fails.
export const CONFIG_FILES = Object.freeze(['ops/tx-probe/wrangler.toml', 'ops/uat-app/wrangler.toml', 'ops/uat/wrangler.toml', 'workers/cron/wrangler.toml', 'wrangler.toml']);
