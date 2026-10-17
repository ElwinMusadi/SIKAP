// Private reconciliation: codes/counts only, never row values, keys, names or hashes.
import { IMPORT_TABLES } from './contract.mjs';
import { assertReceipt, inspectDatabase, loadArtifacts, validateTargetReferences, verifyObject } from './apply-local.mjs';
import { isMain, openLocalStore, parseArgs, safeCode } from './local-store.mjs';
export { inspectDatabase } from './apply-local.mjs';

export async function reconcileLocal(options) {
  const artifacts = await loadArtifacts(options);
  const store = await openLocalStore(artifacts.persist, { initialize: false });
  try {
    const receipt = await store.db.prepare('SELECT * FROM migration_receipt WHERE id = 1').first();
    assertReceipt(receipt, artifacts, store);
    const report = await inspectDatabase(store.db, artifacts.plan);
    const codes = new Set([...report.codes, ...await validateTargetReferences(store.db, artifacts.plan)]);
    if (receipt.complete !== 1 || receipt.stage !== IMPORT_TABLES.length || receipt.cursor !== 0) codes.add('RECEIPT_INCOMPLETE');
    let verified = 0, bytes = 0;
    for (const file of artifacts.plan.files) {
      const code = await verifyObject(store.bucket, file);
      if (code) codes.add(code); else { verified++; bytes += file.sizeBytes; }
    }
    // Extra objects in this exact snapshot namespace indicate an inconsistent local target.
    const expectedKeys = new Set(artifacts.plan.files.map((file) => file.r2Key));
    let cursor;
    do {
      const page = await store.bucket.list({ prefix: `migration/${artifacts.plan.snapshotId}/`, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) if (!expectedKeys.has(object.key)) codes.add('R2_UNEXPECTED_OBJECT');
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { ok: codes.size === 0, mode: 'local-reconcile', codes: [...codes].sort(), counts: report.counts, arsipPerStatus: report.arsipPerStatus, files: { expected: artifacts.plan.files.length, verified, bytes } };
  } finally { await store.close(); }
}

if (isMain(import.meta.url)) {
  try {
    const report = await reconcileLocal(parseArgs(process.argv.slice(2), { reconcile: true }));
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, codes: [safeCode(error)] })); process.exitCode = 1; }
}
