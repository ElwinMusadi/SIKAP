// Offline VM measurement on the stale LOCAL guard prototype, not live v140 or a deploy candidate.
// No Google latency, account quota or runtime behavior is measured.
// Composite admin measurements stub authorization, so they exclude its reads and are lower bounds.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const BACKEND = new URL('../../legacy-gas/src/backend/', import.meta.url);
const FILES = readdirSync(BACKEND).filter((f) => f.endsWith('.gs')).sort();
const SOURCES = Object.fromEntries(FILES.map((f) => [f, readFileSync(new URL(f, BACKEND), 'utf8')]));

function makePegawaiRow(i) {
  const row = new Array(25).fill('val');
  row[0] = `NIP_${i}`;
  row[2] = 'Pegawai';
  row[3] = 'Aktif';
  row[4] = `Pegawai ${i}`;
  row[8] = '081234567890';
  row[13] = '7371010101010001';
  row[15] = '1990-01-01';
  row[20] = '2015-01-01';
  row[22] = '2020-01-01';
  return row;
}

function createVm(opts = {}) {
  let reads = 0;
  const throwAfter = opts.throwAfter ?? Infinity;
  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => {
          reads++;
          if (reads > throwAfter) throw new Error('Exception: Service invoked too many times: properties');
          return opts.state ?? 'open';
        },
      }),
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) => ({
          getDataRange: () => ({
            getValues: () => (name === 'Data_Pegawai' ? [new Array(25).fill('hdr'), ...(opts.rows ?? [])] : [new Array(4).fill('hdr')]),
          }),
        }),
      }),
    },
    Utilities: {
      formatDate: (d) => (d instanceof Date && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : ''),
    },
    Logger: { log: () => {} },
  };
  const ctx = vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(SOURCES[f], ctx, { filename: f });
  return { ctx, getReads: () => reads, resetReads: () => { reads = 0; } };
}

test('quota amplification: _mapPegawaiRowToObject scales linearly with >1 read multiplier', () => {
  const { ctx, getReads, resetReads } = createVm();
  const singleRow = makePegawaiRow(1);

  ctx._mapPegawaiRowToObject(singleRow);
  const single = getReads();
  assert.ok(single > 1, `Single row property reads (${single}) must exceed 1 to catch amplification`);

  resetReads();
  for (let i = 0; i < 46; i++) ctx._mapPegawaiRowToObject(makePegawaiRow(i));
  const count46 = getReads();
  assert.equal(count46, 46 * single, `46 rows must equal 46 * single (${46 * single}), got ${count46}`);

  resetReads();
  for (let i = 0; i < 1000; i++) ctx._mapPegawaiRowToObject(makePegawaiRow(i));
  const count1000 = getReads();
  assert.equal(count1000, 1000 * single, `1000 rows must equal 1000 * single (${1000 * single}), got ${count1000}`);

  console.log(`# Diagnostic property reads: 1 row = ${single}, 46 rows = ${count46}, 1000 rows = ${count1000} (multiplier: ${single}x)`);
});

test('quota amplification: adminGetAllPegawai measures cumulative property reads', () => {
  const rows46 = Array.from({ length: 46 }, (_, i) => makePegawaiRow(i));
  const { ctx, getReads } = createVm({ rows: rows46 });
  ctx.authorize = () => ({ authorized: true, session: { role: 'Admin' } });

  const res = ctx.adminGetAllPegawai('fake_token');
  const totalReads = getReads();

  assert.equal(res.success, true);
  assert.equal(res.data.rows.length, 46);
  assert.ok(totalReads > 46, `adminGetAllPegawai total reads (${totalReads}) must exceed row count`);
  assert.ok(totalReads >= 46 * 22, `adminGetAllPegawai reads (${totalReads}) includes row mapping amplification`);

  console.log(`# Diagnostic adminGetAllPegawai with authorization stubbed: 46 rows = ${totalReads} property reads (lower bound)`);
});

test('quota error handling: mid-call quota exhaustion caught by handler vs fresh call fail-closed', () => {
  const rows46 = Array.from({ length: 46 }, (_, i) => makePegawaiRow(i));
  const { ctx } = createVm({ rows: rows46, throwAfter: 25 });
  ctx.authorize = () => ({ authorized: true, session: { role: 'Admin' } });

  const res = ctx.adminGetAllPegawai('fake_token');
  assert.equal(res.success, false, 'In-flight failure must be caught by handler');
  assert.equal(res.message, 'Terjadi kesalahan sistem.', 'Handler returns standard user error message');

  const fresh = createVm({ rows: rows46, throwAfter: 0 });
  fresh.ctx.authorize = () => ({ authorized: true, session: { role: 'Admin' } });

  assert.throws(
    () => fresh.ctx.adminGetAllPegawai('fake_token'),
    (err) => err.message === 'SIKAP_CUTOVER_STATE_UNAVAILABLE',
    'Fresh call must fail-closed at first statement before handler executes',
  );
});
