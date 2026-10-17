import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OUTSTANDING_REQUIREMENTS,
  PROBE_PATHS,
  RESULT_CHALLENGED,
  RESULT_UNPROVEN,
  auditInventory,
  hostError,
  isAccessLoginLocation,
  main,
  parseArgs,
  readInventoryFile,
  validPathArg,
  validateInventory,
  writeReportExclusive,
} from './access-audit.mjs';

test('report output rejects NT device and control-character paths before filesystem access', async () => {
  for (const p of ['\\??\\UNC\\server\\share\\report.json', '/??/C:/report.json', 'report\n.json', '//server/share/report.json']) {
    await assert.rejects(writeReportExclusive(p, { readyForImport: false }), { code: 'OUTPUT_PATH_INVALID' });
  }
});

const TEAM = 'sikap-team.cloudflareaccess.com';
const ROOT = 'sikap-uat.pages.dev';
const PREVIEW = 'feat-x.sikap-uat.pages.dev';
const HASH = 'a1b2c3d4.sikap-uat.pages.dev';
const ALL_HOSTS = [ROOT, PREVIEW, HASH];

function inventory(overrides = {}) {
  return {
    version: 1,
    project: 'sikap-uat',
    teamDomain: TEAM,
    hosts: [...ALL_HOSTS],
    inventoryComplete: true,
    ...overrides,
  };
}

function headers(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

function respond(status, map = {}, extra = {}) {
  return { status, headers: headers(map), redirected: false, type: 'basic', body: null, ...extra };
}

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(new URL(url), init);
  };
  fn.calls = calls;
  return fn;
}

const accessRedirect = (host) =>
  respond(302, { location: `https://${TEAM}/cdn-cgi/access/login/${host}?kid=abc&redirect_url=%2Flogin` });

const challengeFetch = () => recordingFetch((url) => accessRedirect(url.hostname));

const fixedNow = () => new Date('2026-10-17T00:00:00.000Z');

test('all listed probes challenged by host-bound team Access login: exit 0 but readyForImport false', async () => {
  const fetchImpl = challengeFetch();
  const { exitCode, report } = await auditInventory(inventory(), { fetchImpl, now: fixedNow });

  assert.equal(exitCode, 0);
  assert.equal(report.readyForImport, false);
  assert.equal(report.anonymousChallengesPassed, true);
  assert.equal(report.inventoryDeclaration.inventoryComplete, true);
  assert.equal(report.inventoryDeclaration.declaredNotVerified, true);
  assert.deepEqual(report.outstandingRequirements, [...OUTSTANDING_REQUIREMENTS]);
  assert.equal(report.evidence.totalProbes, ALL_HOSTS.length * PROBE_PATHS.length);
  assert.equal(report.evidence.challenged, 9);
  assert.equal(report.scope.rootPagesDevHostListed, true);
  assert.ok(report.probes.every((p) => p.result === RESULT_CHALLENGED));
  assert.ok(report.warnings.includes('CUSTOM_DOMAINS_NOT_PROBED'));
  assert.ok(report.warnings.includes('INVENTORY_COMPLETENESS_NOT_VERIFIED'));

  assert.equal(fetchImpl.calls.length, 9);
  for (const { url, init } of fetchImpl.calls) {
    assert.equal(init.method, 'HEAD');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers, undefined, 'no request headers sent');
    assert.ok(init.signal instanceof AbortSignal);
    assert.match(url, /^https:\/\/([a-z0-9-]+\.)?sikap-uat\.pages\.dev\/(login|api\/auth\/me|api\/health)$/);
  }
  // Report never echoes Location / query values.
  assert.doesNotMatch(JSON.stringify(report), /kid=abc|redirect_url|location/i);
});

test('missing root <project>.pages.dev is rejected before any fetch', async () => {
  const fetchImpl = recordingFetch(() => accessRedirect(PREVIEW));
  const { exitCode, report } = await auditInventory(inventory({ hosts: [PREVIEW, HASH] }), { fetchImpl });
  assert.equal(exitCode, 2);
  assert.equal(report.error.code, 'INVENTORY_INVALID');
  assert.deepEqual(report.error.details, [{ code: 'ROOT_PAGES_DEV_HOST_REQUIRED', field: 'hosts' }]);
  assert.equal(report.readyForImport, false);
  assert.equal(fetchImpl.calls.length, 0);
});

test('root unprotected while branch/hash previews are protected fails', async () => {
  const fetchImpl = recordingFetch((url) => (url.hostname === ROOT ? respond(200) : accessRedirect(url.hostname)));
  const { exitCode, report } = await auditInventory(inventory(), { fetchImpl });
  assert.equal(exitCode, 2);
  assert.equal(report.anonymousChallengesPassed, false);
  assert.equal(report.evidence.challenged, 6);
  assert.ok(report.probes.filter((p) => p.host === ROOT).every((p) => p.result === RESULT_UNPROVEN));
});

test('hostless or trailing-slash Access login redirect is unproven (not host-bound)', async () => {
  assert.equal(isAccessLoginLocation(`https://${TEAM}/cdn-cgi/access/login/${PREVIEW}`, PREVIEW, TEAM), true);
  assert.equal(isAccessLoginLocation(`https://${TEAM}/cdn-cgi/access/login`, PREVIEW, TEAM), false);
  assert.equal(isAccessLoginLocation(`https://${TEAM}/cdn-cgi/access/login/`, PREVIEW, TEAM), false);
  assert.equal(isAccessLoginLocation(`https://${TEAM}/cdn-cgi/access/login/${HASH}`, PREVIEW, TEAM), false);

  for (const location of [`https://${TEAM}/cdn-cgi/access/login`, `https://${TEAM}/cdn-cgi/access/login/?x=1`]) {
    const { exitCode, report } = await auditInventory(inventory(), {
      fetchImpl: async () => respond(302, { location }),
    });
    assert.equal(exitCode, 2);
    assert.equal(report.evidence.challenged, 0);
    assert.ok(report.probes.every((p) => p.reason === 'REDIRECT_NOT_ACCESS_LOGIN'));
  }
});

test('inventoryComplete false: challenges pass but exit 2', async () => {
  const { exitCode, report } = await auditInventory(inventory({ inventoryComplete: false }), {
    fetchImpl: challengeFetch(),
  });
  assert.equal(exitCode, 2);
  assert.equal(report.anonymousChallengesPassed, true);
  assert.equal(report.exitReason, 'INVENTORY_NOT_DECLARED_COMPLETE');
  assert.equal(report.readyForImport, false);
});

test('/login 200 and /api/auth/me 401 fail as UNPROTECTED_OR_UNPROVEN', async () => {
  const fetchImpl = recordingFetch((url) => {
    if (url.pathname === '/login') return respond(200, { 'content-type': 'text/html' });
    if (url.pathname === '/api/auth/me') return respond(401, { 'content-type': 'application/json' });
    return respond(404);
  });
  const { exitCode, report } = await auditInventory(inventory({ hosts: [ROOT] }), { fetchImpl });
  assert.equal(exitCode, 2);
  assert.equal(report.anonymousChallengesPassed, false);
  assert.equal(report.readyForImport, false);
  assert.deepEqual(
    report.probes.map((p) => [p.path, p.status, p.result]),
    [
      ['/login', 200, RESULT_UNPROVEN],
      ['/api/auth/me', 401, RESULT_UNPROVEN],
      ['/api/health', 404, RESULT_UNPROVEN],
    ],
  );
});

test('login challenged but API bypassed fails', async () => {
  const fetchImpl = recordingFetch((url) => (url.pathname === '/login' ? accessRedirect(url.hostname) : respond(401)));
  const { exitCode, report } = await auditInventory(inventory({ hosts: [ROOT] }), { fetchImpl });
  assert.equal(exitCode, 2);
  assert.equal(report.evidence.challenged, 1);
  assert.equal(report.evidence.unprotectedOrUnproven, 2);
});

test('403 without redirect is unproven, not a pass', async () => {
  const fetchImpl = recordingFetch(() => respond(403));
  const { exitCode, report } = await auditInventory(inventory({ hosts: [ROOT] }), { fetchImpl });
  assert.equal(exitCode, 2);
  assert.ok(report.probes.every((p) => p.reason === 'FORBIDDEN_WITHOUT_CHALLENGE'));
});

test('evil, relative, http, javascript and wrong-team redirects are rejected and never followed', async () => {
  const bad = [
    `https://evil.example/cdn-cgi/access/login/${PREVIEW}`,
    `https://${TEAM}.evil.example/cdn-cgi/access/login/${PREVIEW}`,
    `https://other-team.cloudflareaccess.com/cdn-cgi/access/login/${PREVIEW}`,
    `http://${TEAM}/cdn-cgi/access/login/${PREVIEW}`,
    `https://${TEAM}:8443/cdn-cgi/access/login/${PREVIEW}`,
    `https://user@${TEAM}/cdn-cgi/access/login/${PREVIEW}`,
    `https://${TEAM}/cdn-cgi/access/logout`,
    `https://${TEAM}/cdn-cgi/access/login/evil.example`,
    `/cdn-cgi/access/login/${PREVIEW}`,
    'javascript:alert(1)',
    '',
  ];
  for (const location of bad) {
    assert.equal(isAccessLoginLocation(location, PREVIEW, TEAM), false, location);
  }
  const fetchImpl = recordingFetch(() => respond(302, { location: `https://evil.example/cdn-cgi/access/login/${ROOT}` }));
  const { exitCode, report } = await auditInventory(inventory({ hosts: [ROOT] }), { fetchImpl });
  assert.equal(exitCode, 2);
  assert.equal(fetchImpl.calls.length, 3, 'no follow-up request to redirect target');
  assert.ok(fetchImpl.calls.every((c) => new URL(c.url).hostname === ROOT));
  assert.ok(report.probes.every((p) => p.reason === 'REDIRECT_NOT_ACCESS_LOGIN'));
  assert.doesNotMatch(JSON.stringify(report), /evil\.example/);
});

test('301/308 and followed/opaque redirects are not accepted', async () => {
  const loc = { location: `https://${TEAM}/cdn-cgi/access/login/${ROOT}` };
  for (const [res, reason] of [
    [respond(301, loc), 'REDIRECT_STATUS_NOT_ACCEPTED'],
    [respond(308, loc), 'REDIRECT_STATUS_NOT_ACCEPTED'],
    [respond(200, {}, { redirected: true }), 'REDIRECT_WAS_FOLLOWED'],
    [respond(0, {}, { type: 'opaqueredirect' }), 'OPAQUE_REDIRECT'],
  ]) {
    const { report } = await auditInventory(inventory({ hosts: [ROOT] }), { fetchImpl: async () => res });
    assert.ok(report.probes.every((p) => p.reason === reason), reason);
  }
});

test('timeout and network errors are sanitized', async () => {
  const secret = 'Authorization: Bearer SECRET-TOKEN cf_clearance=abc';
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const { report: timedOut } = await auditInventory(inventory({ hosts: [ROOT] }), {
    fetchImpl: hang,
    timeoutMs: 20,
  });
  assert.ok(timedOut.probes.every((p) => p.reason === 'TIMEOUT' && p.status === null));

  const { exitCode, report } = await auditInventory(inventory({ hosts: [ROOT] }), {
    fetchImpl: async () => {
      const err = new TypeError(secret);
      err.cause = { headers: { cookie: 'x' } };
      throw err;
    },
  });
  assert.equal(exitCode, 2);
  assert.ok(report.probes.every((p) => p.reason === 'NETWORK_ERROR'));
  assert.doesNotMatch(JSON.stringify(report), /SECRET|Bearer|cookie|cf_clearance|stack/i);
});

test('production project and hosts are rejected before any fetch', async () => {
  const fetchImpl = recordingFetch(() => respond(302));
  const cases = [
    inventory({ project: 'sikap', hosts: ['sikap.pages.dev'] }),
    inventory({ hosts: [ROOT, 'sikap.uptdpenda-kupang.web.id'] }),
    inventory({ hosts: [ROOT, 'www.sikap.uptdpenda-kupang.web.id'] }),
    inventory({ hosts: [ROOT, 'feat.sikap.pages.dev'] }),
    inventory({ hosts: [ROOT, '*.sikap-uat.pages.dev'] }),
  ];
  for (const inv of cases) {
    const { exitCode, report } = await auditInventory(inv, { fetchImpl });
    assert.equal(exitCode, 2);
    assert.equal(report.error.code, 'INVENTORY_INVALID');
    assert.equal(report.readyForImport, false);
  }
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(hostError('sikap.pages.dev', 'sikap-uat'), 'PRODUCTION_HOST_REJECTED');
  assert.equal(hostError('a.sikap.pages.dev', 'sikap-uat'), 'PRODUCTION_HOST_REJECTED');
});

test('old preview project sikap-v2 (shared BASELINE_DENY) is refused before any fetch', async () => {
  const fetchImpl = recordingFetch(() => accessRedirect('sikap-v2.pages.dev'));
  const v2 = inventory({ project: 'sikap-v2', hosts: ['sikap-v2.pages.dev', 'feat.sikap-v2.pages.dev'] });
  const { exitCode, report } = await auditInventory(v2, { fetchImpl });
  assert.equal(exitCode, 2);
  assert.equal(report.error.code, 'INVENTORY_INVALID');
  assert.equal(report.readyForImport, false);
  assert.deepEqual(report.error.details, [
    { code: 'PRODUCTION_PROJECT_REJECTED', field: 'project' },
    { code: 'PRODUCTION_HOST_REJECTED', field: 'hosts[0]' },
    { code: 'PRODUCTION_HOST_REJECTED', field: 'hosts[1]' },
  ]);
  for (const host of ['sikap-v2.pages.dev', 'feat.sikap-v2.pages.dev']) {
    assert.equal(hostError(host, 'sikap-uat'), 'PRODUCTION_HOST_REJECTED', host);
    const r = await auditInventory(inventory({ hosts: [ROOT, host] }), { fetchImpl });
    assert.deepEqual(r.report.error.details, [{ code: 'PRODUCTION_HOST_REJECTED', field: 'hosts[1]' }]);
  }
  assert.equal(fetchImpl.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /sikap-v2/);
});

test('SSRF-shaped and non-project hosts are rejected', () => {
  const rejects = {
    localhost: 'HOST_LOCALHOST',
    'api.localhost': 'HOST_LOCALHOST',
    '127.0.0.1': 'HOST_IP_LITERAL',
    '169.254.169.254': 'HOST_IP_LITERAL',
    '[::1]': 'HOST_SYNTAX',
    'https://feat.sikap-uat.pages.dev': 'HOST_SYNTAX',
    'feat.sikap-uat.pages.dev:8443': 'HOST_SYNTAX',
    'feat.sikap-uat.pages.dev/login': 'HOST_SYNTAX',
    'user@feat.sikap-uat.pages.dev': 'HOST_SYNTAX',
    'FEAT.sikap-uat.pages.dev': 'HOST_SYNTAX',
    'feat.sikap-uat.pages.dev.': 'HOST_SYNTAX',
    'a.b.sikap-uat.pages.dev': 'HOST_NOT_PROJECT_PAGES_DEV',
    'feat.other.pages.dev': 'HOST_NOT_PROJECT_PAGES_DEV',
    'staging.example.com': 'HOST_NOT_PROJECT_PAGES_DEV',
    'sikap-uat.pages.dev.evil.com': 'HOST_NOT_PROJECT_PAGES_DEV',
  };
  for (const [host, code] of Object.entries(rejects)) {
    assert.equal(hostError(host, 'sikap-uat'), code, host);
  }
  assert.equal(hostError(ROOT, 'sikap-uat'), null);
  assert.equal(hostError(PREVIEW, 'sikap-uat'), null);
  assert.equal(hostError('feat.sikap-uat.pages.dev', 'sikap-uat'), null);
});

test('inventory schema validation', () => {
  assert.equal(validateInventory(inventory()).ok, true);
  assert.equal(
    validateInventory(inventory({ project: 'sikap-uat-b', hosts: ['sikap-uat-b.pages.dev', 'x.sikap-uat-b.pages.dev'] })).ok,
    true,
  );
  const codes = (raw) => validateInventory(raw).errors?.map((e) => e.code) ?? [];
  assert.deepEqual(codes(inventory({ version: 2 })), ['VERSION_UNSUPPORTED']);
  assert.deepEqual(codes(inventory({ teamDomain: 'sikap.example.com' })), ['TEAM_DOMAIN_INVALID']);
  assert.deepEqual(codes(inventory({ inventoryComplete: 'yes' })), ['INVENTORY_COMPLETE_NOT_BOOLEAN']);
  assert.deepEqual(codes(inventory({ hosts: [] })), ['HOSTS_EMPTY_OR_INVALID']);
  assert.deepEqual(codes(inventory({ hosts: [ROOT, PREVIEW, PREVIEW] })), ['HOST_DUPLICATE']);
  assert.deepEqual(codes(inventory({ apiToken: 'x' })), ['UNKNOWN_FIELD']);
  assert.deepEqual(codes(inventory({ checkedAt: 'yesterday' })), ['CHECKED_AT_INVALID']);
  assert.deepEqual(codes(inventory({ project: 'Bad_Name' })), ['PROJECT_INVALID']);
  assert.deepEqual(codes([]), ['INVENTORY_NOT_OBJECT']);
  // Errors never echo raw values.
  assert.doesNotMatch(JSON.stringify(validateInventory(inventory({ hosts: [ROOT, 'localhost'] }))), /localhost/);
});

test('partial host failure fails the whole audit', async () => {
  const fetchImpl = recordingFetch((url) => (url.hostname === HASH ? respond(200) : accessRedirect(url.hostname)));
  const { exitCode, report } = await auditInventory(inventory(), { fetchImpl });
  assert.equal(exitCode, 2);
  assert.equal(report.anonymousChallengesPassed, false);
  assert.equal(report.evidence.challenged, 6);
  assert.equal(report.evidence.unprotectedOrUnproven, 3);
});

function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

test('CLI: unknown flag reports CLI_ARGUMENTS without echoing values', async () => {
  const stderr = sink();
  const code = await main(['--token', 'SECRET', '--inventory', 'x.json'], { stderr, stdout: sink() });
  assert.equal(code, 2);
  const report = JSON.parse(stderr.text());
  assert.equal(report.error.code, 'CLI_ARGUMENTS');
  assert.equal(report.readyForImport, false);
  assert.doesNotMatch(stderr.text(), /SECRET|--token|stack/);
  assert.equal(parseArgs([]).details[0].code, 'MISSING_INVENTORY');
  assert.equal(parseArgs(['--inventory', 'a\0b']).details[0].code, 'INVALID_PATH');
  assert.equal(parseArgs(['--inventory', 'a.json', '--out', 'a.json']).details[0].code, 'OUT_EQUALS_INVENTORY');
});

test('UNC, device and leading-double-separator paths are rejected before any fs call', async (t) => {
  const lstatSync = t.mock.method(fs, 'lstatSync');
  const openSync = t.mock.method(fs, 'openSync');
  const hazards = [
    '\\\\server\\share\\inv.json',
    '//server/share/inv.json',
    '\\\\?\\C:\\inv.json',
    '\\\\.\\PhysicalDrive0',
    '//?/C:/inv.json',
    '///inv.json',
    '\\/server/inv.json',
  ];
  for (const p of hazards) {
    assert.equal(validPathArg(p), false, p);
    assert.equal(parseArgs(['--inventory', p]).details[0].code, 'INVALID_PATH', p);
    assert.equal(parseArgs(['--inventory', 'ok.json', '--out', p]).details[0].code, 'INVALID_PATH', p);
    assert.throws(() => readInventoryFile(p), { code: 'INVENTORY_FILE_PATH_INVALID' });
    await assert.rejects(writeReportExclusive(p, {}), { code: 'OUTPUT_PATH_INVALID' });
    const stderr = sink();
    assert.equal(await main(['--inventory', p], { stdout: sink(), stderr }), 2);
    assert.equal(JSON.parse(stderr.text()).error.code, 'CLI_ARGUMENTS');
  }
  assert.equal(lstatSync.mock.callCount(), 0);
  assert.equal(openSync.mock.callCount(), 0);
});

test('symlinked inventory or output ancestor is rejected', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sikap-access-audit-'));
  try {
    const realDir = path.join(dir, 'real');
    await mkdir(realDir);
    await writeFile(path.join(realDir, 'inventory.json'), JSON.stringify(inventory()));
    const linkDir = path.join(dir, 'link');
    try {
      await symlink(realDir, linkDir, 'junction'); // junction needs no admin on Windows
    } catch {
      t.skip('directory links unsupported here');
      return;
    }
    assert.throws(() => readInventoryFile(path.join(linkDir, 'inventory.json')), {
      code: 'INVENTORY_FILE_SYMLINK_FORBIDDEN',
    });
    await assert.rejects(writeReportExclusive(path.join(linkDir, 'out.json'), {}), {
      code: 'OUTPUT_PATH_SYMLINK_FORBIDDEN',
    });
    assert.equal(fs.existsSync(path.join(realDir, 'out.json')), false);

    const fileLink = path.join(dir, 'file-link.json');
    let fileLinked = true;
    try {
      await symlink(path.join(realDir, 'inventory.json'), fileLink, 'file');
    } catch {
      fileLinked = false; // file symlinks need privilege on Windows
    }
    if (fileLinked) {
      const stderr = sink();
      assert.equal(await main(['--inventory', fileLink], { stdout: sink(), stderr, fetchImpl: challengeFetch() }), 2);
      assert.equal(JSON.parse(stderr.text()).error.code, 'INVENTORY_FILE_SYMLINK_FORBIDDEN');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI: reads inventory, writes report exclusively, refuses overwrite', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sikap-access-audit-'));
  try {
    const invPath = path.join(dir, 'inventory.json');
    const outPath = path.join(dir, 'out.report.json');
    await writeFile(invPath, JSON.stringify(inventory()));
    const stdout = sink();
    const code = await main(['--inventory', invPath, '--out', outPath], {
      stdout,
      stderr: sink(),
      fetchImpl: challengeFetch(),
    });
    assert.equal(code, 0);
    const written = JSON.parse(await readFile(outPath, 'utf8'));
    assert.equal(written.readyForImport, false);
    assert.equal(written.anonymousChallengesPassed, true);
    assert.equal(JSON.parse(stdout.text()).readyForImport, false);

    const stderr = sink();
    const again = await main(['--inventory', invPath, '--out', outPath], {
      stdout: sink(),
      stderr,
      fetchImpl: challengeFetch(),
    });
    assert.equal(again, 2);
    assert.equal(JSON.parse(stderr.text()).error.code, 'OUTPUT_EXISTS');

    const badJson = path.join(dir, 'bad.json');
    await writeFile(badJson, '{not json');
    const stderr2 = sink();
    assert.equal(await main(['--inventory', badJson], { stdout: sink(), stderr: stderr2 }), 2);
    assert.equal(JSON.parse(stderr2.text()).error.code, 'INVENTORY_JSON_INVALID');

    const big = path.join(dir, 'big.json');
    await writeFile(big, `{"pad":"${'x'.repeat(70_000)}"}`);
    const stderr3 = sink();
    assert.equal(await main(['--inventory', big], { stdout: sink(), stderr: stderr3 }), 2);
    assert.equal(JSON.parse(stderr3.text()).error.code, 'INVENTORY_FILE_TOO_LARGE');

    const stderr4 = sink();
    assert.equal(await main(['--inventory', path.join(dir, 'missing.json')], { stdout: sink(), stderr: stderr4 }), 2);
    assert.equal(JSON.parse(stderr4.text()).error.code, 'INVENTORY_FILE_NOT_FOUND');
    assert.doesNotMatch(stderr4.text(), /missing\.json|sikap-access-audit-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
