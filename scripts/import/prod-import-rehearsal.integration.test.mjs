// Integration tests for the synthetic rehearsal seam in prod-import-orchestrator.mjs.
// Uses Miniflare-backed ephemeral in-memory D1 + in-memory R2 map fake.
// No network, no remote state, no Cloudflare CLI/Wrangler, no real credentials, no real PII.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { syntheticFixture } from '../migrate/fixture.mjs';
import { transformExport } from '../migrate/transform.mjs';
import * as PINS from './prod-import-pins.mjs';
import { REHEARSAL_TARGET } from './real-data-gate.mjs';
import { orchestrateImport } from './prod-import-orchestrator.mjs';
import { ENDPOINT_ORIGIN, ENDPOINT_PATH } from './d1-rest.mjs';
import { LEDGER } from './core.mjs';

const ROOT = new URL('../../', import.meta.url);

function computeModulePins() {
  return PINS.MODULE_FILES.map((file) => [
    file,
    createHash('sha256').update(readFileSync(new URL(file, ROOT), 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
  ]);
}

function createSyntheticPlan() {
  const fixture = syntheticFixture();
  const plan = transformExport(fixture.snapshot, {
    pepper: 'synthetic-prod-rehearsal-pepper',
    salt: Buffer.alloc(32, 0x42),
  });
  assert.equal(plan.ready, true);
  const planBytes = new Uint8Array(Buffer.from(JSON.stringify(plan)));
  const planSha256 = createHash('sha256').update(planBytes).digest('hex');

  const warningCounts = {};
  for (const d of plan.diagnostics) {
    assert.equal(d.severity, 'warning');
    warningCounts[d.code] = (warningCounts[d.code] ?? 0) + 1;
  }

  const planFacts = {
    snapshotId: plan.snapshotId,
    planSha256,
    expected: plan.expected,
    warningCounts,
    diagnosticsTotal: plan.diagnostics.length,
  };

  const fileBySha = new Map(fixture.files.map((f) => [
    createHash('sha256').update(f.bytes).digest('hex'),
    new Uint8Array(f.bytes),
  ]));

  return { fixture, plan, planBytes, planFacts, fileBySha };
}

function createMonotonicClock(startIso = '2026-10-18T00:00:00.000Z') {
  let currentMs = Date.parse(startIso);
  return () => {
    const iso = new Date(currentMs).toISOString();
    currentMs += 1000;
    return iso;
  };
}

const CREDENTIAL = Object.freeze({
  token: 'SYNTHETIC-TOKEN-' + 'A'.repeat(30),
  expiresAt: '2026-10-18T08:00:00.000Z', // clock base 2026-10-18T00:00Z: 8 h, inside the 12 h credential-lifetime cap
  accessKeyId: 'SYNTHACCESSKEYID0001',
  secretAccessKey: 'SYNTHETIC-SECRET/not+a+real+key+0001',
  r2ExpiresAt: '2026-10-18T08:00:00.000Z',
});

async function openMiniflare(t) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    compatibilityDate: '2026-10-01',
    host: '127.0.0.1',
    port: 0,
    script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
    outboundService: () => new Response(null, { status: 403 }),
    log: new Log(LogLevel.NONE),
    cf: false,
    telemetry: { enabled: false },
    d1Databases: { DB: 'sikap-rehearsal-d1' },
    d1Persist: false,
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  return { mf, db };
}

function createRehearsalTransport({ db, onBeforeD1 = null, onAfterD1 = null, initialR2 = new Map() }) {
  const d1Endpoint = `${ENDPOINT_ORIGIN}${ENDPOINT_PATH(REHEARSAL_TARGET.accountId, REHEARSAL_TARGET.databaseId)}`;
  const r2Base = `https://${REHEARSAL_TARGET.accountId}.r2.cloudflarestorage.com/${REHEARSAL_TARGET.bucket}/`;
  const r2Storage = new Map(initialR2);
  let d1PostCount = 0;
  let r2GetCount = 0;
  let r2PutCount = 0;
  let totalCalls = 0;

  const fetchImpl = async (url, init) => {
    totalCalls++;
    if (url === d1Endpoint) {
      d1PostCount++;
      assert.equal(init.method, 'POST');
      assert.match(init.headers?.Authorization ?? '', /^Bearer SYNTHETIC-TOKEN-/);
      assert.equal(init.headers?.['Content-Type'], 'application/json');

      if (onBeforeD1) {
        const intercepted = await onBeforeD1(init, d1PostCount);
        if (intercepted) return intercepted;
      }

      const parsed = JSON.parse(init.body);
      const queries = parsed.batch ? parsed.batch : [parsed];
      const mfResults = await db.batch(queries.map((s) => db.prepare(s.sql).bind(...(s.params ?? []))));

      if (onAfterD1) {
        const intercepted = await onAfterD1(mfResults, init, d1PostCount);
        if (intercepted) return intercepted;
      }

      const result = mfResults.map((r) => {
        assert.equal(r.success, true);
        const item = {
          success: r.success,
          results: Array.isArray(r.results) ? r.results.map((x) => ({ ...x })) : [],
        };
        if (r.meta && typeof r.meta.changes === 'number') item.meta = { changes: r.meta.changes };
        return item;
      });

      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.startsWith(r2Base)) {
      if (init.method === 'GET') {
        r2GetCount++;
        if (!r2Storage.has(url)) {
          return new Response(null, { status: 404, statusText: 'Not Found' });
        }
        const item = r2Storage.get(url);
        return new Response(item.bytes, {
          status: 200,
          headers: { 'content-type': item.contentType },
        });
      }
      if (init.method === 'PUT') {
        r2PutCount++;
        assert.equal(init.headers?.['if-none-match'], '*');
        if (r2Storage.has(url)) {
          return new Response(null, { status: 412, statusText: 'Precondition Failed' });
        }
        const copy = new Uint8Array(init.body);
        r2Storage.set(url, {
          bytes: copy,
          contentType: init.headers?.['content-type'] ?? 'application/octet-stream',
        });
        return new Response(null, { status: 200, statusText: 'OK' });
      }
      assert.fail(`Unexpected R2 method: ${init.method}`);
    }

    assert.fail(`Unexpected fetch URL: ${url}`);
  };

  return {
    fetchImpl,
    r2Storage,
    getCounts: () => ({ d1PostCount, r2GetCount, r2PutCount, totalCalls }),
  };
}

test('rehearsal integration 1: check-only mode completes with CHECK_ONLY_OK, zero credential reads, and zero HTTP fetch calls', async () => {
  const { planBytes, planFacts, fileBySha } = createSyntheticPlan();
  const modulePins = computeModulePins();
  let credentialCalls = 0;
  let fetchCalls = 0;

  const req = {
    kind: 'synthetic-rehearsal',
    mode: 'check-only',
    io: {
      readPlanBytes: async () => planBytes,
      readFileBytes: async (f) => fileBySha.get(f.sha256),
      readCredential: async () => {
        credentialCalls++;
        return { ...CREDENTIAL };
      },
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error('fetchImpl should never be called in check-only mode');
      },
      now: createMonotonicClock(),
    },
    rehearsal: {
      planFacts,
      modulePins,
    },
  };

  const res = await orchestrateImport(req);

  assert.equal(res.status, 'CHECK_ONLY_OK');
  assert.equal(res.code, null);
  assert.equal(res.phase, 'DONE');
  assert.equal(res.kind, 'synthetic-rehearsal');
  assert.equal(res.syntheticRehearsal, true);
  assert.equal(res.productionImport, false);
  assert.equal(res.targetId, REHEARSAL_TARGET.databaseId);
  assert.equal(res.targetName, REHEARSAL_TARGET.databaseName);
  assert.equal(res.requests, 0);
  assert.equal(res.blockedRequests, 0);
  assert.equal(res.writeAttempts, 0);
  assert.equal(res.setupStatements.planned, 67);
  assert.equal(res.setupStatements.applied, 0);
  assert.equal(res.residuesRetained, false);
  assert.equal(res.manualRecoveryRequired, false);
  assert.equal(credentialCalls, 0);
  assert.equal(fetchCalls, 0);

  // Authority invariants
  assert.equal(res.ready, false);
  assert.equal(res.readyForImport, false);
  assert.equal(res.remoteAuthorized, false);
  assert.equal(res.transportProven, false);
  assert.equal(res.authorizesExecution, false);
  assert.equal(res.authorizesRetry, false);
  assert.equal(res.authorizesResume, false);
});

test('rehearsal integration 2: happy path completes COMPLETE_SYNTHETIC_REHEARSAL with exact B requests, no authority, Miniflare D1 + in-memory R2', async (t) => {
  const { db } = await openMiniflare(t);
  const { plan, planBytes, planFacts, fileBySha } = createSyntheticPlan();
  const modulePins = computeModulePins();
  const transport = createRehearsalTransport({ db });
  let credentialCalls = 0;

  const req = {
    kind: 'synthetic-rehearsal',
    mode: 'import',
    io: {
      readPlanBytes: async () => planBytes,
      readFileBytes: async (f) => fileBySha.get(f.sha256),
      readCredential: async () => {
        credentialCalls++;
        return { ...CREDENTIAL };
      },
      fetchImpl: transport.fetchImpl,
      now: createMonotonicClock(),
    },
    rehearsal: {
      planFacts,
      modulePins,
    },
  };

  const res = await orchestrateImport(req);

  assert.equal(res.status, 'COMPLETE_SYNTHETIC_REHEARSAL');
  assert.equal(res.code, null);
  assert.equal(res.phase, 'DONE');
  assert.equal(res.kind, 'synthetic-rehearsal');
  assert.equal(res.syntheticRehearsal, true);
  assert.equal(res.productionImport, false);
  assert.equal(res.targetId, REHEARSAL_TARGET.databaseId);
  assert.equal(res.targetName, REHEARSAL_TARGET.databaseName);

  // Exact B = 67 setup + 5 + 4F + 3C = 72 + 4F + 3C
  const F = plan.files.length;
  const C = res.chunks;
  const expectedB = 72 + 4 * F + 3 * C;
  assert.equal(res.requestBudget, expectedB);
  assert.equal(res.requests, expectedB);
  assert.equal(transport.getCounts().totalCalls, expectedB);
  assert.equal(res.blockedRequests, 0);
  assert.equal(res.writeAttempts > 0, true);
  assert.equal(res.setupStatements.planned, 67);
  assert.equal(res.setupStatements.applied, 67);
  assert.equal(res.targetEmptyObserved, true);
  assert.equal(res.destinationsAbsent, F);
  assert.equal(res.schemaObserved, true);
  assert.equal(res.referencesObserved, true);
  assert.equal(res.operationalEmptyObserved, true);
  assert.equal(res.residuesRetained, true);
  assert.equal(res.manualRecoveryRequired, false);
  assert.equal(credentialCalls, 1);

  // Authority invariants
  assert.equal(res.ready, false);
  assert.equal(res.readyForImport, false);
  assert.equal(res.remoteAuthorized, false);
  assert.equal(res.transportProven, false);
  assert.equal(res.authorizesExecution, false);
  assert.equal(res.authorizesRetry, false);
  assert.equal(res.authorizesResume, false);
  assert.equal(res.deployed, false);
  assert.equal(res.appBindingAllowed, false);

  // Database verification: verify imported rows and ledger
  const runRow = await db.prepare(`SELECT * FROM ${LEDGER.runTable} WHERE id = 1`).first();
  assert.ok(runRow);
  assert.equal(runRow.plan_sha256, planFacts.planSha256);

  const pegawaiCount = await db.prepare('SELECT count(*) AS n FROM pegawai').first();
  assert.equal(pegawaiCount.n, plan.expected.pegawai);

  // R2 storage verification: verify each file is stored and matches sha256
  for (const file of plan.files) {
    const url = `https://${REHEARSAL_TARGET.accountId}.r2.cloudflarestorage.com/${REHEARSAL_TARGET.bucket}/${file.r2Key}`;
    assert.equal(transport.r2Storage.has(url), true);
    const stored = transport.r2Storage.get(url);
    assert.equal(stored.bytes.byteLength, file.sizeBytes);
    assert.equal(createHash('sha256').update(stored.bytes).digest('hex'), file.sha256);
  }
});

test('rehearsal integration 3: fault setup ambiguous returns manualRecoveryRequired with no resend', async (t) => {
  const { db } = await openMiniflare(t);
  const { planBytes, planFacts, fileBySha } = createSyntheticPlan();
  const modulePins = computeModulePins();
  let callsAfterFault = 0;
  let faultTriggered = false;

  const transport = createRehearsalTransport({
    db,
    onBeforeD1: async (_init, postCount) => {
      // postCount 1 is EMPTY_CHECK. Setup begins at postCount 2.
      // Trigger fault on setup statement 5 (postCount 6).
      if (postCount === 6) {
        faultTriggered = true;
        throw new TypeError('fetch failed: network connection dropped during setup DDL');
      }
      if (faultTriggered) {
        callsAfterFault++;
      }
      return null;
    },
  });

  const req = {
    kind: 'synthetic-rehearsal',
    mode: 'import',
    io: {
      readPlanBytes: async () => planBytes,
      readFileBytes: async (f) => fileBySha.get(f.sha256),
      readCredential: async () => ({ ...CREDENTIAL }),
      fetchImpl: transport.fetchImpl,
      now: createMonotonicClock(),
    },
    rehearsal: {
      planFacts,
      modulePins,
    },
  };

  const res = await orchestrateImport(req);

  assert.equal(faultTriggered, true);
  assert.equal(res.status, 'STOPPED_SETUP');
  assert.equal(res.code, 'HTTP_FAILED');
  assert.equal(res.phase, 'SETUP');
  assert.equal(res.writeAttempts > 0, true);
  assert.equal(res.residuesRetained, true);
  assert.equal(res.manualRecoveryRequired, true);
  assert.equal(callsAfterFault, 0);

  // Authority invariants: no resend / no retry authorized
  assert.equal(res.authorizesRetry, false);
  assert.equal(res.authorizesResume, false);
  assert.equal(res.ready, false);
  assert.equal(res.remoteAuthorized, false);
});

test('rehearsal integration 4: R2 pre-existing destination conflict stops before DDL with no user tables created', async (t) => {
  const { db } = await openMiniflare(t);
  const { plan, planBytes, planFacts, fileBySha } = createSyntheticPlan();
  const modulePins = computeModulePins();

  const conflictKey = plan.files[0].r2Key;
  const conflictUrl = `https://${REHEARSAL_TARGET.accountId}.r2.cloudflarestorage.com/${REHEARSAL_TARGET.bucket}/${conflictKey}`;
  const preExistingBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x39, 0x39]);
  const initialR2 = new Map([[conflictUrl, { bytes: preExistingBytes, contentType: 'application/pdf' }]]);

  const transport = createRehearsalTransport({ db, initialR2 });

  const req = {
    kind: 'synthetic-rehearsal',
    mode: 'import',
    io: {
      readPlanBytes: async () => planBytes,
      readFileBytes: async (f) => fileBySha.get(f.sha256),
      readCredential: async () => ({ ...CREDENTIAL }),
      fetchImpl: transport.fetchImpl,
      now: createMonotonicClock(),
    },
    rehearsal: {
      planFacts,
      modulePins,
    },
  };

  const res = await orchestrateImport(req);

  assert.equal(res.status, 'STOPPED_OBJECT_ABSENCE');
  assert.equal(res.code, 'R2_DESTINATION_CONFLICT');
  assert.equal(res.phase, 'OBJECT_ABSENCE');
  assert.equal(res.setupStatements.applied, 0);
  assert.equal(res.writeAttempts, 0);
  assert.equal(res.residuesRetained, false);
  assert.equal(res.manualRecoveryRequired, false);

  // Verify in Miniflare D1: no DDL statements were executed (zero user tables)
  const emptyCheck = await db.prepare(
    "SELECT count(*) AS user_objects FROM sqlite_master WHERE substr(name, 1, 4) <> '_cf_' AND substr(name, 1, 7) <> 'sqlite_'",
  ).first();
  assert.equal(emptyCheck.user_objects, 0);

  // Verify pre-existing R2 bytes were untouched
  assert.deepEqual(transport.r2Storage.get(conflictUrl).bytes, preExistingBytes);

  // Authority invariants
  assert.equal(res.ready, false);
  assert.equal(res.readyForImport, false);
  assert.equal(res.remoteAuthorized, false);
  assert.equal(res.authorizesExecution, false);
  assert.equal(res.authorizesRetry, false);
  assert.equal(res.authorizesResume, false);
});
