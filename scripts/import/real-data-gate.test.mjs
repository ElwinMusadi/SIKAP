// Local synthetic fixtures only. No remote calls, credential/private files or environment access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IMPORT_TABLES } from '../migrate/contract.mjs';
import {
  UAT_TARGET, UAT_APP_SCHEMA_SHA256, UAT_LEDGER_SCHEMA_SHA256, UAT_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256,
  PROD_TARGET, PROD_APP_SCHEMA_SHA256, PROD_LEDGER_SCHEMA_SHA256, PROD_POLICY_SHA256, PROD_RETENTION_POLICY_SHA256, issueRealDataProductionPermit,
  RealDataGateError, REAL_DATA_GATE_ERROR_CODES, issueRealDataUatPermit, claimPermitForRun, finishPermitRun,
  validatePermitRequest, getPermitTables, getPermitManifest, getPermitFile, assertPermittedObject,
  REHEARSAL_TARGET, REHEARSAL_APP_SCHEMA_SHA256, REHEARSAL_LEDGER_SCHEMA_SHA256, REHEARSAL_POLICY_SHA256, REHEARSAL_RETENTION_POLICY_SHA256, issueRealDataRehearsalPermit,
} from './real-data-gate.mjs';

const NOW = '2026-10-18T00:00:00.000Z', LATER = '2026-10-18T00:01:00.000Z', EXPIRES = '2026-10-18T01:00:00.000Z';
const h = (bytes) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const plan = {
    format: 'sikap-migration-plan', version: 1, snapshotId: '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d',
    sourceSha256: h('synthetic source'), createdAt: NOW, sourceReadOnlyDeclared: true, consistent: false, ready: true,
    tables: Object.fromEntries(IMPORT_TABLES.map((t) => [t, []])), files: [],
    expected: { pegawai: 0, akun: 0, arsip: 0, files: 0, totalFileBytes: 0, arsipPerStatus: { Menunggu: 0, Terverifikasi: 0, Ditolak: 0 } }, diagnostics: [],
  };
  const planBytes = Buffer.from(JSON.stringify(plan));
  const descriptor = {
    format: 'sikap-remote-import-descriptor', version: 1, ...UAT_TARGET,
    snapshotId: plan.snapshotId, sourceSha256: plan.sourceSha256, planSha256: h(planBytes),
    appSchemaSha256: UAT_APP_SCHEMA_SHA256, ledgerSchemaSha256: UAT_LEDGER_SCHEMA_SHA256,
    baselineSha256: h('baseline'), policySha256: UAT_POLICY_SHA256, retentionPolicySha256: UAT_RETENTION_POLICY_SHA256,
    runNonce: '0123456789abcdef0123456789abcdef', ownerNonce: 'fedcba9876543210fedcba9876543210', epoch: 0, expiresAt: EXPIRES,
  };
  return { plan, descriptor, planBytes, now: NOW };
}
const issue = (f) => issueRealDataUatPermit({ descriptor: f.descriptor, planBytes: f.planBytes, now: f.now });
const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof RealDataGateError && e.message === code && e.code === code && REAL_DATA_GATE_ERROR_CODES.includes(code));
const reencode = (f) => { f.planBytes = Buffer.from(JSON.stringify(f.plan)); f.descriptor.planSha256 = h(f.planBytes); };

test('issuer binds exact target, schema/policy pins, raw plan bytes and semantic validation', () => {
  const f = fixture(), permit = issue(f);
  assert.ok(Object.isFrozen(permit) && Object.isFrozen(permit.counts) && Object.isFrozen(permit.counts.rowsPerTable));
  for (const key of ['ready', 'readyForImport', 'remoteAuthorized', 'authorizesExecution', 'transportProven']) assert.equal(permit[key], false);
  assert.equal(getPermitTables(permit).pegawai.length, 0);
  assert.ok(Object.isFrozen(getPermitTables(permit)) && Object.isFrozen(getPermitManifest(permit)));
  for (const [field, value, code] of [
    ['profile', 'synthetic', 'PROFILE_MISMATCH'],
    ['accountId', 'a'.repeat(32), 'DESCRIPTOR_TARGET_DENIED'],
    ['databaseId', '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'TARGET_PIN_MISMATCH'],
    ['databaseName', 'sikap-import-another', 'TARGET_PIN_MISMATCH'], ['bucket', 'sikap-import-another-files', 'TARGET_PIN_MISMATCH'],
    ['appSchemaSha256', h('wrong'), 'SCHEMA_PIN_MISMATCH'], ['ledgerSchemaSha256', h('wrong'), 'SCHEMA_PIN_MISMATCH'],
    ['policySha256', h('wrong'), 'POLICY_PIN_MISMATCH'], ['retentionPolicySha256', h('wrong'), 'POLICY_PIN_MISMATCH'],
    ['planSha256', h('wrong'), 'PLAN_HASH_MISMATCH'], ['sourceSha256', h('wrong'), 'PLAN_BINDING_MISMATCH'],
    ['snapshotId', '8a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', 'PLAN_BINDING_MISMATCH'], ['expiresAt', NOW, 'DESCRIPTOR_EXPIRED'],
  ]) { const bad = fixture(); bad.descriptor[field] = value; rejects(() => issue(bad), code); }
  for (const mutate of [
    (p) => { p.ready = false; }, (p) => { p.expected.files = 1; },
    (p) => { p.tables.pegawai.push({ id: 1, nip: 'invalid', nama: 'Synthetic' }); },
    (p) => { p.diagnostics.push({ severity: 'error', sheet: 'Synthetic', rowNumber: 1, code: 'INVALID' }); },
  ]) { const bad = fixture(); mutate(bad.plan); reencode(bad); rejects(() => issue(bad), 'PLAN_INVALID'); }
  const changed = fixture(); changed.planBytes = Buffer.concat([changed.planBytes, Buffer.from(' ')]);
  rejects(() => issue(changed), 'PLAN_HASH_MISMATCH');
  for (const bytes of [Buffer.from('{'), Uint8Array.of(0xff)]) {
    const bad = fixture(); bad.planBytes = bytes; bad.descriptor.planSha256 = h(bytes);
    rejects(() => issue(bad), 'PLAN_JSON_INVALID');
  }
});

test('plan bytes use intrinsic private copy; reject aliases with fake slots, shared memory and getters', () => {
  const f = fixture();
  const original = new Uint8Array(f.planBytes);
  Object.defineProperty(original, 'byteLength', { get() { throw new Error('must not run'); } });
  Object.defineProperty(original, 'buffer', { get() { throw new Error('must not run'); } });
  f.planBytes = original;
  const permit = issue(f);
  original.fill(0);
  assert.equal(getPermitTables(permit).pegawai.length, 0);
  for (const bytes of [new Proxy(new Uint8Array([1]), {}), new Uint16Array([1]), new Uint8Array(0), new Uint8Array(new SharedArrayBuffer(8))]) {
    const bad = fixture(); bad.planBytes = bytes; rejects(() => issue(bad), 'PLAN_BYTES_INVALID');
  }
  const bad = fixture(); Object.defineProperty(bad.descriptor, 'policySha256', { get() { throw new Error('getter ran'); }, enumerable: true });
  rejects(() => issue(bad), 'DESCRIPTOR_INVALID');
});

test('one claim permits repeated same-run requests; rejects copies, full descriptor mutations, stale time and finish reuse', () => {
  const f = fixture(), permit = issue(f);
  rejects(() => validatePermitRequest(permit, f.descriptor, NOW), 'PERMIT_NOT_CLAIMED');
  for (const fake of [{}, { ...permit }, structuredClone(permit), null, Object.create(permit)]) {
    rejects(() => claimPermitForRun(fake, { now: NOW }), 'PERMIT_INVALID');
    rejects(() => validatePermitRequest(fake, f.descriptor, NOW), 'PERMIT_INVALID');
  }
  const claim = claimPermitForRun(permit, { now: NOW });
  assert.ok(Object.isFrozen(claim) && Object.isFrozen(claim.descriptor) && Object.isFrozen(claim.tables));
  assert.ok(!Object.hasOwn(claim, 'filesByKey'));
  rejects(() => claimPermitForRun(permit, { now: NOW }), 'PERMIT_ALREADY_CLAIMED');
  for (const key of Object.keys(f.descriptor)) {
    const d = { ...f.descriptor };
    if (key === 'version' || key === 'epoch') d[key]++;
    else if (key === 'expiresAt') d[key] = '2026-10-18T02:00:00.000Z';
    else if (key.endsWith('Sha256')) d[key] = h('different');
    else if (key === 'runNonce' || key === 'ownerNonce') d[key] = 'a'.repeat(32);
    else if (key === 'databaseId' || key === 'snapshotId') d[key] = '8a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
    else d[key] = 'invalid';
    rejects(() => validatePermitRequest(permit, d, NOW), 'DESCRIPTOR_INVALID');
  }
  const accepted = validatePermitRequest(permit, f.descriptor, NOW);
  assert.ok(Object.isFrozen(accepted) && !Object.hasOwn(accepted, 'filesByKey'));
  validatePermitRequest(permit, f.descriptor, LATER);
  rejects(() => validatePermitRequest(permit, f.descriptor, NOW), 'NOW_NOT_MONOTONE');
  rejects(() => validatePermitRequest(permit, f.descriptor, EXPIRES), 'DESCRIPTOR_EXPIRED');
  finishPermitRun(permit);
  rejects(() => validatePermitRequest(permit, f.descriptor, LATER), 'PERMIT_SPENT');
  rejects(() => claimPermitForRun(permit, { now: LATER }), 'PERMIT_ALREADY_CLAIMED');
  const fresh = issue(fixture()); finishPermitRun(fresh);
  rejects(() => claimPermitForRun(fresh, { now: NOW }), 'PERMIT_SPENT');
});

test('manifest entries and tables remain private/frozen; exact key/hash/MIME/size assertion only', () => {
  const f = fixture(), sha = h('%PDF-synthetic');
  const file = { fileId: 'synthetic_file', kind: 'document', r2Key: `migration/${f.plan.snapshotId}/document/synthetic_file-${sha}.pdf`, mimeType: 'application/pdf', sizeBytes: 14, sha256: sha };
  f.plan.files = [file];
  f.plan.tables.jenis_dokumen = [{ id: 'DOC-KTP', nama: 'Synthetic document', kategori: 'Synthetic' }];
  f.plan.tables.pegawai = [{ id: 1, nip: '990000000000000001', nama: 'Synthetic employee' }];
  f.plan.tables.akun = [{ pegawai_id: 1, password_hash: `legacy-wrap$10000$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(32, 2).toString('base64')}`, is_default_password: 0 }];
  f.plan.tables.arsip_dokumen = [{ id: 1, pegawai_id: 1, jenis_dokumen_id: 'DOC-KTP', status: 'Menunggu', r2_key: file.r2Key, file_name: 'synthetic.pdf', mime_type: file.mimeType, size_bytes: file.sizeBytes, sha256: file.sha256, uploaded_at: NOW }];
  Object.assign(f.plan.expected, { pegawai: 1, akun: 1, arsip: 1, files: 1, totalFileBytes: 14, arsipPerStatus: { Menunggu: 1, Terverifikasi: 0, Ditolak: 0 } });
  reencode(f);
  const permit = issue(f); claimPermitForRun(permit, { now: NOW });
  const metadata = { key: file.r2Key, sha256: file.sha256, mimeType: file.mimeType, sizeBytes: file.sizeBytes };
  assert.deepEqual(assertPermittedObject(permit, f.descriptor, NOW, metadata), file);
  assert.ok(Object.isFrozen(getPermitFile(permit, file.r2Key)));
  assert.equal(getPermitFile(permit, 'missing'), null);
  for (const over of [{ key: 'other' }, { sha256: h('other') }, { mimeType: 'image/png' }, { sizeBytes: 15 }, { sizeBytes: '14' }]) rejects(() => assertPermittedObject(permit, f.descriptor, NOW, { ...metadata, ...over }), 'OBJECT_MANIFEST_MISMATCH');
  assert.throws(() => { getPermitManifest(permit)[0].sha256 = h('other'); }, TypeError);
  assert.throws(() => { getPermitTables(permit).pegawai[0].nama = 'other'; }, TypeError);
  const publicJson = JSON.stringify(permit);
  for (const secret of [file.r2Key, 'Synthetic employee', '990000000000000001', 'legacy-wrap', f.descriptor.ownerNonce, f.descriptor.runNonce]) assert.ok(!publicJson.includes(secret));
});

test('production permit is pinned to the production target and never crosses with UAT', () => {
  const prodFixture = () => {
    const f = fixture();
    Object.assign(f.descriptor, PROD_TARGET, {
      appSchemaSha256: PROD_APP_SCHEMA_SHA256, ledgerSchemaSha256: PROD_LEDGER_SCHEMA_SHA256,
      policySha256: PROD_POLICY_SHA256, retentionPolicySha256: PROD_RETENTION_POLICY_SHA256,
    });
    return f;
  };
  const issueProd = (f) => issueRealDataProductionPermit({ descriptor: f.descriptor, planBytes: f.planBytes, now: f.now });
  const f = prodFixture(), permit = issueProd(f);
  assert.ok(Object.isFrozen(permit));
  assert.equal(permit.databaseId, PROD_TARGET.databaseId);
  assert.equal(permit.bucket, PROD_TARGET.bucket);
  assert.equal(permit.realDataProduction, true);
  assert.ok(!Object.hasOwn(permit, 'realDataUat'));
  for (const key of ['ready', 'readyForImport', 'remoteAuthorized', 'authorizesExecution', 'transportProven']) assert.equal(permit[key], false);
  assert.equal(issue(fixture()).realDataUat, true);
  // distinct targets, distinct policy digests, same application schema
  assert.notEqual(PROD_TARGET.databaseId, UAT_TARGET.databaseId);
  assert.notEqual(PROD_TARGET.bucket, UAT_TARGET.bucket);
  assert.notEqual(PROD_POLICY_SHA256, UAT_POLICY_SHA256);
  assert.notEqual(PROD_RETENTION_POLICY_SHA256, UAT_RETENTION_POLICY_SHA256);
  assert.equal(PROD_APP_SCHEMA_SHA256, UAT_APP_SCHEMA_SHA256);
  assert.match(PROD_TARGET.databaseName, /^sikap-import-[a-z0-9]+(?:-[a-z0-9]+)*$/);
  // a UAT descriptor is refused by the production issuer, and a production descriptor by the UAT issuer
  rejects(() => issueRealDataProductionPermit({ descriptor: fixture().descriptor, planBytes: fixture().planBytes, now: NOW }), 'TARGET_PIN_MISMATCH');
  const pf = prodFixture();
  rejects(() => issueRealDataUatPermit({ descriptor: pf.descriptor, planBytes: pf.planBytes, now: NOW }), 'TARGET_PIN_MISMATCH');
  // every pinned field is enforced for production as well
  for (const [field, value, code] of [
    ['profile', 'synthetic', 'PROFILE_MISMATCH'],
    ['databaseId', UAT_TARGET.databaseId, 'TARGET_PIN_MISMATCH'],
    ['databaseName', 'sikap-import-another', 'TARGET_PIN_MISMATCH'], ['bucket', 'sikap-import-another-files', 'TARGET_PIN_MISMATCH'],
    ['appSchemaSha256', h('wrong'), 'SCHEMA_PIN_MISMATCH'], ['ledgerSchemaSha256', h('wrong'), 'SCHEMA_PIN_MISMATCH'],
    ['policySha256', UAT_POLICY_SHA256, 'POLICY_PIN_MISMATCH'], ['retentionPolicySha256', UAT_RETENTION_POLICY_SHA256, 'POLICY_PIN_MISMATCH'],
    ['planSha256', h('wrong'), 'PLAN_HASH_MISMATCH'],
  ]) { const bad = prodFixture(); bad.descriptor[field] = value; rejects(() => issueProd(bad), code); }
  // a production permit is one-run like any other
  claimPermitForRun(permit, { now: NOW });
  rejects(() => claimPermitForRun(permit, { now: NOW }), 'PERMIT_ALREADY_CLAIMED');
  finishPermitRun(permit);
  rejects(() => validatePermitRequest(permit, f.descriptor, LATER), 'PERMIT_SPENT');
});

test('rehearsal permit is pinned to the fixed synthetic rehearsal target; all three kinds reject each other', () => {
  const asTarget = (target, app, ledger, policy, retention) => {
    const f = fixture();
    Object.assign(f.descriptor, target, { appSchemaSha256: app, ledgerSchemaSha256: ledger, policySha256: policy, retentionPolicySha256: retention });
    return f;
  };
  const kinds = {
    uat: { make: () => fixture(), issue: issueRealDataUatPermit, marker: 'realDataUat' },
    production: { make: () => asTarget(PROD_TARGET, PROD_APP_SCHEMA_SHA256, PROD_LEDGER_SCHEMA_SHA256, PROD_POLICY_SHA256, PROD_RETENTION_POLICY_SHA256), issue: issueRealDataProductionPermit, marker: 'realDataProduction' },
    rehearsal: { make: () => asTarget(REHEARSAL_TARGET, REHEARSAL_APP_SCHEMA_SHA256, REHEARSAL_LEDGER_SCHEMA_SHA256, REHEARSAL_POLICY_SHA256, REHEARSAL_RETENTION_POLICY_SHA256), issue: issueRealDataRehearsalPermit, marker: 'realDataRehearsal' },
  };
  for (const [name, k] of Object.entries(kinds)) {
    const f = k.make(), permit = k.issue({ descriptor: f.descriptor, planBytes: f.planBytes, now: f.now });
    assert.equal(permit[k.marker], true);
    for (const other of Object.values(kinds)) if (other !== k) assert.ok(!Object.hasOwn(permit, other.marker), `${name} has foreign marker`);
    for (const key of ['ready', 'readyForImport', 'remoteAuthorized', 'authorizesExecution', 'transportProven']) assert.equal(permit[key], false);
    for (const [otherName, other] of Object.entries(kinds)) {
      if (otherName === name) continue;
      const g = k.make();
      rejects(() => other.issue({ descriptor: g.descriptor, planBytes: g.planBytes, now: g.now }), 'TARGET_PIN_MISMATCH');
    }
  }
  // Target fields alone are not enough: a rehearsal descriptor carrying production policy digests is refused.
  const mixed = kinds.rehearsal.make();
  Object.assign(mixed.descriptor, { policySha256: PROD_POLICY_SHA256, retentionPolicySha256: PROD_RETENTION_POLICY_SHA256 });
  rejects(() => issueRealDataRehearsalPermit({ descriptor: mixed.descriptor, planBytes: mixed.planBytes, now: NOW }), 'POLICY_PIN_MISMATCH');
  for (const t of [UAT_TARGET, PROD_TARGET]) {
    assert.notEqual(REHEARSAL_TARGET.databaseId, t.databaseId);
    assert.notEqual(REHEARSAL_TARGET.databaseName, t.databaseName);
    assert.notEqual(REHEARSAL_TARGET.bucket, t.bucket);
  }
  assert.ok(Object.isFrozen(REHEARSAL_TARGET));
  assert.notEqual(REHEARSAL_POLICY_SHA256, PROD_POLICY_SHA256);
  assert.notEqual(REHEARSAL_POLICY_SHA256, UAT_POLICY_SHA256);
});

test('gate contains no direct I/O/default clock/network/credentials behavior', () => {
  const source = readFileSync(new URL('./real-data-gate.mjs', import.meta.url), 'utf8');
  for (const pattern of [/process\./, /globalThis/, /Date\.now/, /node:fs/, /child_process/, /console\./, /fetch\(/]) assert.doesNotMatch(source, pattern);
});
