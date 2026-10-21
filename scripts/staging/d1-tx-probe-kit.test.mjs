import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIT_VERSION, PROBE_DB_NAME, PROBE_PREFIX, MARKER_TABLE, DATA_TABLE, TRANSPORT, PHASE_IDS, OWNED_ROWS,
  MAX_COMMAND_BYTES, MAX_STATEMENTS, MARKER_DDL, DATA_DDL, PRECONDITION_SQL, ProbeKitError,
  isNonce, generateNonce, createProbeKit, isProbeKit, renderPhaseCommand, validateProbeTarget,
  analysePrecondition, analyseProbeRead, isCleanupCandidate,
} from './d1-tx-probe-kit.mjs';
import { BASELINE_DENY } from './uat-target.mjs';
import { UAT_ACCOUNT, UAT_DB } from './uat-constants.mjs';

const NONCE = '0123456789abcdef0123456789abcdef';
const OTHER_NONCE = 'fedcba9876543210fedcba9876543210';
const FAKE_DB_ID = '7f3c2a10-5b6d-4e8f-9a0b-1c2d3e4f5a6b';
const SECRET = 'TOPSECRET-cf-token-should-never-echo';
const FALSE_FLAGS = ['remoteExecuted', 'remoteVerified', 'transactionAtomicityVerified', 'readyForImport',
  'appliesToWorkerBatch', 'appliesToFileImport', 'cleanupAuthorized', 'authorizesExecution'];
const kit = createProbeKit({ nonce: NONCE });
const phase = (k, id) => k.phases.find((p) => p.id === id);
const code = (expected) => (error) => error instanceof ProbeKitError && error.code === expected && error.message === expected;
const assertFlagsFalse = (o) => { for (const f of FALSE_FLAGS) assert.equal(o[f], false, f); };

test('exports, nonce contract and frozen kit metadata never claim remote proof', () => {
  assert.equal(KIT_VERSION, 1);
  assert.equal(PROBE_DB_NAME, 'sikap-uat-tx-probe');
  assert.equal(PROBE_PREFIX, '__sikap_uat_tx_probe');
  assert.equal(MARKER_TABLE, '__sikap_uat_tx_probe_marker');
  assert.equal(DATA_TABLE, '__sikap_uat_tx_probe_data');
  assert.equal(TRANSPORT, 'wrangler-d1-execute-remote-command');
  assert.ok(isNonce(NONCE) && isNonce(generateNonce()));
  for (const bad of [NONCE.toUpperCase(), NONCE.slice(1), `${NONCE}0`, 123, null, `${NONCE.slice(0, 31)}'`]) assert.equal(isNonce(bad), false);
  assert.ok(Object.isFrozen(kit) && Object.isFrozen(kit.phases) && Object.isFrozen(kit.tables) && isProbeKit(kit));
  assert.equal(isProbeKit({ ...kit }), false);
  assertFlagsFalse(kit);
  assert.equal(kit.templatesOnly, true);
  assert.equal(kit.expectedWranglerVersion, '4.151.0');
  assert.match(kit.notice, /not remote proof/);
  assert.deepEqual(createProbeKit({ nonce: NONCE }), kit, 'deterministic for a fixed nonce');
});

test('caller nonce is required and malicious options are refused without echo', () => {
  const cases = [[undefined, 'KIT_OPTIONS_INVALID'], [{}, 'KIT_OPTIONS_INVALID'], [{ nonce: NONCE, sql: 'DROP' }, 'KIT_OPTIONS_INVALID'],
    [{ nonce: `${NONCE.slice(0, 20)}'; DROP TABLE x;--` }, 'NONCE_INVALID'], [{ nonce: NONCE.toUpperCase() }, 'NONCE_INVALID'],
    [{ nonce: NONCE, transport: 'wrangler-d1-execute-remote-file' }, 'TRANSPORT_UNSUPPORTED'],
    [{ nonce: NONCE, transport: 'worker-db-batch' }, 'TRANSPORT_UNSUPPORTED'],
    [Object.defineProperty({}, 'nonce', { get: () => NONCE, enumerable: true }), 'KIT_OPTIONS_INVALID'],
    [Object.assign(Object.create({ inherited: 1 }), { nonce: NONCE }), 'KIT_OPTIONS_INVALID']];
  for (const [options, expected] of cases) assert.throws(() => createProbeKit(options), code(expected));
  assert.equal(createProbeKit({ nonce: NONCE, transport: TRANSPORT }).transport, TRANSPORT);
});

test('phases are fixed, ordered, immutable and bounded single-statement arrays', () => {
  assert.deepEqual(kit.phases.map((p) => p.id), [...PHASE_IDS]);
  assert.deepEqual(kit.phases.map((p) => p.order), PHASE_IDS.map((_, i) => i));
  for (const p of kit.phases) {
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.statements));
    assert.throws(() => { p.statements.push('DROP TABLE x'); }, TypeError);
    assert.throws(() => { p.statements[0] = 'DROP TABLE x'; }, TypeError);
    assert.ok(p.statements.length >= 1 && p.statements.length <= MAX_STATEMENTS);
    for (const s of p.statements) {
      assert.equal(s, s.trim());
      assert.ok(!s.includes(';') && !s.includes('--') && !s.includes('/*'));
      assert.doesNotMatch(s, /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA|ATTACH|DETACH|VACUUM|REPLACE|EXISTS|TEMP)\b/i);
    }
    const r = renderPhaseCommand(p);
    assert.ok(r.byteLength <= MAX_COMMAND_BYTES && r.sql.endsWith(';') && r.statementCount === p.statements.length);
    assert.equal(r.sql.split(';\n').length, p.statements.length);
    assert.equal(r.targetBound, false); assert.equal(r.templateOnly, true);
    assertFlagsFalse(p); assertFlagsFalse(r);
    assert.ok(Object.isFrozen(r));
    const cleanup = p.id === 'cleanup-data' || p.id === 'cleanup-marker';
    assert.equal(p.requiresIndependentReadAndApproval, cleanup, p.id);
    assert.equal(r.requiresIndependentReadAndApproval, cleanup, p.id);
  }
  assert.throws(() => renderPhaseCommand({ ...phase(kit, 'setup') }), code('PHASE_NOT_OWNED'));
  assert.throws(() => renderPhaseCommand({ id: 'setup', statements: ['DROP TABLE users'] }), code('PHASE_NOT_OWNED'));
  assert.throws(() => renderPhaseCommand('SELECT 1'), code('PHASE_NOT_OWNED'));
});

test('setup, positive and failure phase content matches the approved design', () => {
  assert.deepEqual([...phase(kit, 'precondition').statements], [PRECONDITION_SQL]);
  for (const id of ['inspect', 'cleanup-reinspect']) {
    assert.match(phase(kit, id).statements[1], new RegExp(`OR tbl_name IN \\('${MARKER_TABLE}', '${DATA_TABLE}'\\) ORDER BY type,name$`));
  }
  assert.match(PRECONDITION_SQL, /substr\(name,1,7\)<>'sqlite_' AND substr\(name,1,4\)<>'_cf_' ORDER BY type,name$/);
  const setup = phase(kit, 'setup').statements;
  assert.deepEqual([...setup.slice(0, 2)], [MARKER_DDL, DATA_DDL]);
  for (const ddl of setup.slice(0, 2)) assert.match(ddl, /^CREATE TABLE __sikap_uat_tx_probe_(marker|data) \(/);
  assert.match(MARKER_DDL, /CHECK \(id = 1\).*CHECK \(length\(nonce\) = 32\).*kit_version INTEGER NOT NULL, step INTEGER NOT NULL/);
  assert.match(DATA_DDL, /CHECK \(phase IN \('positive', 'fail_guard', 'fail_constraint', 'trailing'\)\)/);
  assert.equal(setup[2], `INSERT INTO ${MARKER_TABLE} (id, nonce, kit_version, step) VALUES (1, '${NONCE}', 1, 0)`);
  const positive = phase(kit, 'positive');
  assert.equal(positive.expect, 'success');
  assert.match(positive.statements[0], /VALUES \(1, '[0-9a-f]{32}', 'positive'\), \(2, .*\(3, /);
  assert.match(positive.statements[1], /SET step = 1 WHERE id = 1 AND nonce = '[0-9a-f]{32}' AND kit_version = 1 AND step = 0$/);
  assert.equal(positive.statements[2], "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('') END AS receipt_guard");
  const guard = phase(kit, 'guard-abort');
  assert.equal(guard.expect, 'failure');
  assert.match(guard.statements[0], /\(101, .*'fail_guard'\), \(102, .*\(103, /);
  assert.match(guard.statements[1], /AND step = 99$/);
  assert.equal(guard.statements[2], positive.statements[2]);
  assert.match(guard.statements[3], /VALUES \(104, '[0-9a-f]{32}', 'trailing'\)$/);
  const constraint = phase(kit, 'constraint-abort');
  assert.equal(constraint.expect, 'failure');
  assert.match(constraint.statements[0], /\(201, .*'fail_constraint'\), \(202, /);
  assert.match(constraint.statements[1], /VALUES \(201, '[0-9a-f]{32}', 'fail_constraint'\)$/, 'self-contained duplicate');
  assert.match(constraint.statements[2], /VALUES \(203, '[0-9a-f]{32}', 'trailing'\)$/);
  assert.deepEqual(Object.values(OWNED_ROWS).flat().sort((a, b) => a - b), [1, 2, 3, 101, 102, 103, 104, 201, 202, 203]);
});

test('cleanup templates are single-statement unguarded DROPs, data before independent reinspect before marker', () => {
  const data = phase(kit, 'cleanup-data'), marker = phase(kit, 'cleanup-marker');
  for (const p of [data, marker]) {
    assert.equal(p.statements.length, 1, 'one DROP per command, no same-command guard');
    assert.equal(renderPhaseCommand(p).statementCount, 1);
    assert.ok(!p.statements[0].includes('json(') && !p.statements[0].includes('SELECT'));
    assert.match(p.gate, /UNSAFE TO EXECUTE/);
    assert.match(p.gate, /no SQL enforces ownership/);
    assert.match(p.gate, /independent, separately executed .* cleanupCandidate AND explicit operator approval/);
  }
  assert.match(data.gate, /executed inspect read/);
  assert.match(marker.gate, /executed cleanup-reinspect read/);
  assert.deepEqual([...data.statements], [`DROP TABLE ${DATA_TABLE}`]);
  assert.deepEqual([...marker.statements], [`DROP TABLE ${MARKER_TABLE}`]);
  assert.equal(phase(kit, 'cleanup-reinspect').expect, 'read');
  assert.ok(!kit.phases.flatMap((p) => p.statements).some((s) => s.includes('cleanup_guard')));
  assert.match(kit.notice, /single unguarded DROPs: no SQL enforces ownership/);
  assert.ok(PHASE_IDS.indexOf('cleanup-reinspect') > PHASE_IDS.indexOf('cleanup-data'));
  assert.ok(PHASE_IDS.indexOf('cleanup-marker') > PHASE_IDS.indexOf('cleanup-reinspect'));
  assert.equal(PHASE_IDS.at(-1), 'final-precondition');
  const drops = kit.phases.flatMap((p) => p.statements).filter((s) => s.startsWith('DROP'));
  assert.deepEqual(drops, [`DROP TABLE ${DATA_TABLE}`, `DROP TABLE ${MARKER_TABLE}`], 'only the two owned tables');
});

test('validateProbeTarget accepts only the exact pinned probe shape and never echoes input', () => {
  const good = { accountId: UAT_ACCOUNT, databaseName: PROBE_DB_NAME, databaseId: FAKE_DB_ID };
  const r = validateProbeTarget(good);
  assert.equal(r.valid, true); assert.equal(r.descriptorSyntaxValid, true);
  for (const f of ['existenceVerified', 'identityVerified', 'emptinessVerified']) assert.equal(r[f], false, f);
  assertFlagsFalse(r);
  assert.deepEqual(Object.keys(r).filter((k) => r[k] === true).sort(), ['descriptorSyntaxValid', 'templatesOnly', 'valid']);
  assert.ok(!JSON.stringify(r).includes(FAKE_DB_ID) && !JSON.stringify(r).includes(UAT_ACCOUNT), 'no echo on success');
  assert.ok(Object.isFrozen(r));
  const bad = [
    [null, 'TARGET_SHAPE_INVALID'], [[], 'TARGET_SHAPE_INVALID'], ['x', 'TARGET_SHAPE_INVALID'],
    [{ ...good, extra: SECRET }, 'TARGET_SHAPE_INVALID'], [{ accountId: UAT_ACCOUNT, databaseName: PROBE_DB_NAME }, 'TARGET_SHAPE_INVALID'],
    [Object.defineProperty({ accountId: UAT_ACCOUNT, databaseName: PROBE_DB_NAME }, 'databaseId', { get: () => FAKE_DB_ID, enumerable: true }), 'TARGET_SHAPE_INVALID'],
    [{ ...good, accountId: SECRET }, 'TARGET_ACCOUNT_DENIED'], [{ ...good, accountId: UAT_ACCOUNT.toUpperCase() }, 'TARGET_ACCOUNT_DENIED'],
    [{ ...good, databaseName: 'sikap-db' }, 'TARGET_NAME_DENIED'], [{ ...good, databaseName: 'sikap-db-preview' }, 'TARGET_NAME_DENIED'],
    [{ ...good, databaseName: 'sikap-uat' }, 'TARGET_NAME_DENIED'], [{ ...good, databaseName: `${PROBE_DB_NAME} ` }, 'TARGET_NAME_DENIED'],
    [{ ...good, databaseId: FAKE_DB_ID.toUpperCase() }, 'TARGET_ID_INVALID'], [{ ...good, databaseId: SECRET }, 'TARGET_ID_INVALID'],
    [{ ...good, databaseId: 42 }, 'TARGET_ID_INVALID'],
    ...[...BASELINE_DENY.databaseIds, UAT_DB, '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'].map((id) => [{ ...good, databaseId: id }, 'TARGET_ID_DENIED']),
  ];
  for (const [target, expected] of bad) {
    assert.throws(() => validateProbeTarget(target), (e) => code(expected)(e) && !String(e.stack).includes(SECRET));
  }
});

const pre = (rows) => [{ results: rows, success: true, meta: {} }];
test('analysePrecondition refuses any user object and reports only counts', () => {
  const empty = analysePrecondition(pre([]));
  assert.equal(empty.setupCandidate, true); assert.equal(empty.empty, true); assertFlagsFalse(empty);
  for (const rows of [[{ type: 'table', name: 'd1_migrations' }], [{ type: 'table', name: MARKER_TABLE }],
    [{ type: 'view', name: SECRET }], [{ type: 'trigger', name: 'x' }, { type: 'table', name: DATA_TABLE }]]) {
    const r = analysePrecondition(pre(rows));
    assert.equal(r.setupCandidate, false); assert.deepEqual([...r.codes], ['TARGET_NOT_EMPTY']);
    assert.equal(r.objectCount, rows.length);
    assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes('d1_migrations'));
  }
  assert.equal(analysePrecondition(pre([{ type: 'table', name: MARKER_TABLE }])).ownedResidueCount, 1);
  for (const raw of [undefined, [], [{}], [{ results: [], success: true }, { results: [], success: true }],
    pre([{ type: 'table', name: 'x', sql: SECRET }]), pre([{ type: 'table' }]), pre([{ type: 'table', name: '' }]),
    pre([{ type: 'table', name: 'a' }, { type: 'index', name: 'a' }]), [{ results: [], success: true, token: SECRET }]]) {
    assert.throws(() => analysePrecondition(raw), (e) => e instanceof ProbeKitError && !e.message.includes(SECRET));
  }
});

// Synthetic read results shaped like the inspect / cleanup-reinspect phases.
const schemaRow = (name, sql, type = 'table') => ({ type, name, tbl_name: name, sql });
const OWNED_SCHEMA = [schemaRow(DATA_TABLE, DATA_DDL), schemaRow(MARKER_TABLE, MARKER_DDL)];
const counts = (o = {}) => ({ marker_rows: 1, marker_owned: 1, marker_step: 1, data_total: 3, data_foreign: 0,
  data_positive: 3, data_fail_guard: 0, data_fail_constraint: 0, data_trailing: 0, ...o });
const inspectRaw = (c = counts(), s = OWNED_SCHEMA) => [{ results: [c], success: true }, { results: s, success: true }];

test('analyseProbeRead: exact expected state is a cleanup candidate but never an authorization', () => {
  const r = analyseProbeRead('inspect', inspectRaw());
  assert.equal(r.stateConsistentWithExpectedRows, true); assert.equal(r.positiveCommitted, true); assert.equal(r.failureRowsAbsent, true);
  assert.equal(r.ownershipMatches, true); assert.equal(r.cleanupCandidate, true); assert.ok(isCleanupCandidate(r));
  assertFlagsFalse(r); assert.ok(Object.isFrozen(r) && Object.isFrozen(r.counts) && Object.isFrozen(r.schema));
  assert.equal(isCleanupCandidate({ ...r }), false, 'forged copies are never candidates');
  assert.equal(isCleanupCandidate({ cleanupCandidate: true }), false);
  const reinspect = analyseProbeRead('cleanup-reinspect', [{ results: [{ marker_rows: 1, marker_owned: 1, marker_step: 1 }], success: true },
    { results: [schemaRow(MARKER_TABLE, MARKER_DDL)], success: true }]);
  assert.equal(reinspect.cleanupCandidate, true); assertFlagsFalse(reinspect);
});

test('analyseProbeRead: foreign schema, foreign data or unowned marker deny cleanup candidacy', () => {
  const unsafe = [
    inspectRaw(counts({ data_total: 4, data_foreign: 1 })),
    inspectRaw(counts({ marker_owned: 0, marker_step: -1 })),
    inspectRaw(counts({ marker_rows: 2 })),
    inspectRaw(counts(), [...OWNED_SCHEMA, schemaRow('t', 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END', 'trigger')]),
    inspectRaw(counts(), [...OWNED_SCHEMA, schemaRow('v', 'CREATE VIEW v AS SELECT 1', 'view')]),
    inspectRaw(counts(), [...OWNED_SCHEMA, { type: 'index', name: 'i', tbl_name: DATA_TABLE, sql: 'CREATE INDEX i ON d(x)' }]),
    // Hidden-prefix objects attached to owned tables (returned by the tbl_name clause) are foreign.
    inspectRaw(counts(), [...OWNED_SCHEMA, { type: 'index', name: '_cf_probe_hidden_idx', tbl_name: DATA_TABLE, sql: 'CREATE INDEX x' }]),
    inspectRaw(counts(), [...OWNED_SCHEMA, { type: 'trigger', name: 'sqlite_hidden_trg', tbl_name: MARKER_TABLE, sql: 'CREATE TRIGGER x' }]),
    inspectRaw(counts(), [...OWNED_SCHEMA, { type: 'index', name: 'sqlite_autoindex_x_1', tbl_name: DATA_TABLE, sql: null }]),
    inspectRaw(counts(), [schemaRow(DATA_TABLE, `${DATA_DDL} `), schemaRow(MARKER_TABLE, MARKER_DDL)]),
    inspectRaw(counts(), [schemaRow(MARKER_TABLE, MARKER_DDL)]),
    inspectRaw(counts(), [{ ...schemaRow(DATA_TABLE, DATA_DDL), type: 'view' }, schemaRow(MARKER_TABLE, MARKER_DDL)]),
  ];
  for (const raw of unsafe) {
    const r = analyseProbeRead('inspect', raw);
    assert.equal(r.cleanupCandidate, false); assert.equal(isCleanupCandidate(r), false); assert.equal(r.stateConsistentWithExpectedRows, false);
  }
  const rolledForward = analyseProbeRead('inspect', inspectRaw(counts({ data_total: 6, data_fail_guard: 3 })));
  assert.equal(rolledForward.failureRowsAbsent, false); assert.equal(rolledForward.stateConsistentWithExpectedRows, false);
  assert.equal(rolledForward.cleanupCandidate, true, 'owned failure rows are still owned');
});

test('analyseProbeRead: unknown, inconsistent or hostile results throw controlled codes and redact text', () => {
  const hostile = [
    ['precondition', inspectRaw()], ['inspect', inspectRaw().slice(0, 1)], ['inspect', [...inspectRaw(), { results: [] }]],
    ['inspect', inspectRaw({ ...counts(), extra: SECRET })], ['inspect', inspectRaw(counts({ data_total: -1 }))],
    ['inspect', inspectRaw(counts({ data_total: '3' }))], ['inspect', inspectRaw(counts({ data_total: 1.5 }))],
    ['inspect', inspectRaw(counts({ data_total: 9 }))], ['inspect', inspectRaw(counts({ data_positive: 4, data_total: 4 }))],
    ['inspect', inspectRaw(counts({ marker_owned: 1, marker_step: -1 }))], ['inspect', inspectRaw(counts({ marker_rows: 0 }))],
    ['inspect', [{ results: [counts(), counts()], success: true }, { results: OWNED_SCHEMA, success: true }]],
    ['inspect', inspectRaw(counts(), [...OWNED_SCHEMA, { ...schemaRow('x', SECRET), password: SECRET }])],
    ['inspect', inspectRaw(counts(), [...OWNED_SCHEMA, schemaRow(DATA_TABLE, DATA_DDL)])],
    ['inspect', inspectRaw(counts(), [...OWNED_SCHEMA, schemaRow('y', 'x'.repeat(5000))])],
    ['inspect', [{ results: [counts()], success: false, error: SECRET }, { results: OWNED_SCHEMA, success: true }]],
    ['cleanup-reinspect', inspectRaw()],
  ];
  for (const [id, raw] of hostile) {
    assert.throws(() => analyseProbeRead(id, raw), (e) => e instanceof ProbeKitError && /^[A-Z_]+$/.test(e.message) && !e.message.includes(SECRET), id);
  }
  const redacted = analyseProbeRead('inspect', inspectRaw(counts(), [...OWNED_SCHEMA, schemaRow(SECRET, `CREATE TABLE x (${SECRET})`)]));
  assert.ok(!JSON.stringify(redacted).includes(SECRET)); assert.equal(redacted.schema.foreignObjectCount, 1);
});

test('every result set must carry explicit success:true; missing or non-true success is rejected', () => {
  const [agg, sch] = inspectRaw();
  const withSuccess = (set, value) => { const copy = { results: set.results }; if (value !== undefined) copy.success = value; return copy; };
  for (const value of [undefined, false, 'true', 1, null]) {
    const expected = value === undefined ? 'RESULT_SHAPE_INVALID' : 'RESULT_NOT_SUCCESS';
    assert.throws(() => analyseProbeRead('inspect', [withSuccess(agg, value), sch]), code(expected), String(value));
    assert.throws(() => analyseProbeRead('inspect', [agg, withSuccess(sch, value)]), code(expected), String(value));
    assert.throws(() => analysePrecondition([withSuccess({ results: [] }, value)]), code(expected), String(value));
    assert.throws(() => analyseProbeRead('cleanup-reinspect', [withSuccess({ results: [{ marker_rows: 1, marker_owned: 1, marker_step: 1 }] }, value),
      { results: [schemaRow(MARKER_TABLE, MARKER_DDL)], success: true }]), code(expected), String(value));
  }
});

// ---------------------------------------------------------------------------------------------
// LOCAL Miniflare D1 binding semantics ONLY. Executes the generated arrays with db.batch() on a
// fresh throwaway local database (no Wrangler, no persistence path, no migrations, no R2).
// This is NOT evidence about `wrangler d1 execute --remote --command` or any remote D1 behaviour.
// ---------------------------------------------------------------------------------------------
test('LOCAL binding semantics only (not remote command proof): rollback, collisions, analysis-gated single-DROP cleanup', { timeout: 120000 }, async (t) => {
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = await import('miniflare');
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-10-01', host: '127.0.0.1', port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
    outboundService: () => new Response(null, { status: 403 }), log: new Log(LogLevel.NONE),
    cf: false, telemetry: { enabled: false }, d1Databases: { DB: 'sikap-tx-probe-local-semantics' },
  }));
  try {
    const db = await mf.getD1Database('DB');
    const run = async (p) => (await db.batch(p.statements.map((s) => db.prepare(s)))).map((r) => ({ results: r.results, success: r.success }));
    const rejects = (p) => assert.rejects(run(p));
    const read = async (id, k = kit) => analyseProbeRead(id, await run(phase(k, id)));
    const ids = async () => (await db.prepare(`SELECT id FROM ${DATA_TABLE} ORDER BY id`).all()).results.map((r) => r.id);
    const marker = async () => db.prepare(`SELECT nonce, kit_version, step FROM ${MARKER_TABLE}`).all().then((r) => r.results);
    // Mirrors the mandatory gate: a cleanup DROP is only ever executed after an independent read in a
    // SEPARATE call analysed as cleanupCandidate (explicit approval is the operator's step, not modelled).
    const gatedDrop = async (readId, dropId) => {
      const analysis = await read(readId);
      if (!isCleanupCandidate(analysis)) return false;
      assert.equal(analysis.cleanupAuthorized, false);
      await run(phase(kit, dropId));
      return true;
    };

    await t.test('fresh database precondition is empty; d1_migrations refuses', async () => {
      assert.equal(analysePrecondition(await run(phase(kit, 'precondition'))).setupCandidate, true);
      await db.prepare('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY)').run();
      assert.equal(analysePrecondition(await run(phase(kit, 'precondition'))).setupCandidate, false);
      await db.prepare('DROP TABLE d1_migrations').run();
    });
    await t.test('pre-existing owned-name table makes setup fail without creating the marker', async () => {
      await db.prepare(`CREATE TABLE ${DATA_TABLE} (x TEXT)`).run();
      await rejects(phase(kit, 'setup'));
      const r = analysePrecondition(await run(phase(kit, 'precondition')));
      assert.equal(r.objectCount, 1); assert.equal(r.ownedResidueCount, 1);
      await db.prepare(`DROP TABLE ${DATA_TABLE}`).run();
    });
    await t.test('setup creates owned tables; a second setup collides and overwrites nothing', async () => {
      await run(phase(kit, 'setup'));
      await rejects(phase(createProbeKit({ nonce: OTHER_NONCE }), 'setup'));
      assert.deepEqual(await marker(), [{ nonce: NONCE, kit_version: 1, step: 0 }]);
      const r = await read('inspect');
      assert.equal(r.schema.ownedTablesExact, true, 'stored DDL equals emitted DDL');
    });
    await t.test('positive commits 3 rows and step 1; guard/constraint failures roll back locally', async () => {
      await run(phase(kit, 'positive'));
      // Baseline after positive ALONE: identical aggregates, so the flag cannot prove failures were attempted.
      const baseline = await read('inspect');
      assert.equal(baseline.stateConsistentWithExpectedRows, true); assertFlagsFalse(baseline);
      assert.deepEqual({ ...baseline.counts }, counts());
      await rejects(phase(kit, 'guard-abort'));
      await rejects(phase(kit, 'constraint-abort'));
      assert.deepEqual(await ids(), [1, 2, 3]);
      assert.deepEqual(await marker(), [{ nonce: NONCE, kit_version: 1, step: 1 }]);
      const r = await read('inspect');
      assert.equal(r.stateConsistentWithExpectedRows, true); assert.equal(r.cleanupCandidate, true); assertFlagsFalse(r);
      assert.deepEqual({ ...r.counts }, counts());
    });
    await t.test('unsafe contexts analyse as not cleanupCandidate; no DROP is executed', async () => {
      // Wrong nonce (another kit's view of this database).
      assert.equal((await read('inspect', createProbeKit({ nonce: OTHER_NONCE }))).cleanupCandidate, false);
      // Foreign row.
      await db.prepare(`INSERT INTO ${DATA_TABLE} (id, nonce, phase) VALUES (900, ?, 'positive')`).bind(OTHER_NONCE).run();
      assert.equal((await read('inspect')).cleanupCandidate, false);
      assert.equal(await gatedDrop('inspect', 'cleanup-data'), false);
      await db.prepare(`DELETE FROM ${DATA_TABLE} WHERE id = 900`).run();
      // Foreign index and foreign view.
      await db.prepare(`CREATE INDEX foreign_idx ON ${DATA_TABLE} (nonce)`).run();
      assert.equal(await gatedDrop('inspect', 'cleanup-data'), false);
      await db.prepare('DROP INDEX foreign_idx').run();
      // Local D1 refuses user objects with the reserved _cf_ prefix (SQLITE_AUTH), so the hidden-prefix
      // case cannot be reproduced locally; it is covered by the synthetic analyser test instead.
      await assert.rejects(db.prepare(`CREATE INDEX _cf_probe_hidden_idx ON ${DATA_TABLE} (nonce)`).run());
      assert.equal((await read('inspect')).cleanupCandidate, true);
      await db.prepare(`CREATE INDEX foreign_idx ON ${DATA_TABLE} (nonce)`).run();
      await db.prepare('DROP INDEX foreign_idx').run();
      await db.prepare(`CREATE VIEW foreign_view AS SELECT id FROM ${MARKER_TABLE}`).run();
      assert.equal(await gatedDrop('inspect', 'cleanup-data'), false);
      await db.prepare('DROP VIEW foreign_view').run();
      // Marker must not be dropped while the data table still exists.
      assert.equal(await gatedDrop('cleanup-reinspect', 'cleanup-marker'), false);
      assert.deepEqual(await ids(), [1, 2, 3], 'no DROP executed: data intact');
      assert.deepEqual(await marker(), [{ nonce: NONCE, kit_version: 1, step: 1 }]);
    });
    await t.test('analysis-gated single-DROP cleanup: data, independent reinspect, marker last, final empty', async () => {
      assert.equal(await gatedDrop('inspect', 'cleanup-data'), true);
      await db.prepare('CREATE TABLE foreign_after (x INTEGER)').run();
      assert.equal(await gatedDrop('cleanup-reinspect', 'cleanup-marker'), false, 'foreign object blocks marker drop');
      assert.equal(analysePrecondition(await run(phase(kit, 'precondition'))).objectCount, 2);
      await db.prepare('DROP TABLE foreign_after').run();
      assert.equal(await gatedDrop('cleanup-reinspect', 'cleanup-marker'), true);
      const final = analysePrecondition(await run(phase(kit, 'final-precondition')));
      assert.equal(final.empty, true); assertFlagsFalse(final);
    });
  } finally {
    await mf.dispose();
  }
});
