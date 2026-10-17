import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

import {
  BASELINE_DENY,
  MAX_FILE_BYTES,
  canonicalJson,
  isSafeLocalPath,
  parseCliArgs,
  readBoundedJsonFile,
  runCli,
  validateDescriptor,
  validatePolicy,
} from './uat-target.mjs';

const ACCOUNT = 'a'.repeat(32);
const OTHER_ACCOUNT = 'b'.repeat(32);
const PROD_DB = 'b8611b82-8067-4153-ae5e-d6a0b94be7a6';
const PREVIEW_DB = '1bd39313-4072-43a7-a183-7544c8264c46';
const REPORT_KEYS = ['accessDeclared', 'accessVerified', 'codes', 'credentialScopeVerified', 'ok', 'readyForImport'];

function descriptor(overrides = {}) {
  return {
    version: 1,
    purpose: 'private-uat',
    accountId: ACCOUNT,
    projectName: 'sikap-uat',
    environment: 'uat',
    database: { id: '0f1e2d3c-4b5a-4968-8776-5544332211aa', name: 'sikap-uat-db' },
    filesBucket: 'sikap-uat-files',
    backupBucket: 'sikap-uat-backup',
    access: {
      teamDomain: 'sikap-team.cloudflareaccess.com',
      audience: 'c'.repeat(64),
      hostnames: ['sikap-uat.pages.dev', '*.sikap-uat.pages.dev'],
    },
    pepperFingerprint: 'd'.repeat(64),
    schemaSha256: 'e'.repeat(64),
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    version: 1,
    allowedAccountIds: [ACCOUNT],
    deniedAccountIds: [],
    deniedProjectNames: ['sikap', 'sikap-v2'],
    deniedDatabaseIds: [PROD_DB, PREVIEW_DB],
    deniedBuckets: ['sikap-files', 'sikap-files-preview', 'sikap-backup', 'sikap-backup-preview'],
    ...overrides,
  };
}

const withAccess = (access) => descriptor({ access: { ...descriptor().access, ...access } });
const codesOf = (d, p = policy()) => validateDescriptor(d, p).codes;

function assertSafeFlags(r) {
  assert.equal(r.accessVerified, false);
  assert.equal(r.readyForImport, false);
  assert.equal(r.credentialScopeVerified, false);
}

describe('validateDescriptor: valid target', () => {
  test('passes, reports digest, never ready', () => {
    const r = validateDescriptor(descriptor(), policy());
    assert.equal(r.ok, true, JSON.stringify(r.codes));
    assert.deepEqual(r.codes, []);
    assert.match(r.descriptorSha256, /^[0-9a-f]{64}$/);
    assert.equal(r.accessDeclared, true);
    assertSafeFlags(r);
    assert.deepEqual(Object.keys(r).sort(), [...REPORT_KEYS, 'descriptorSha256'].sort());
  });

  test('backupBucket optional; project suffix allowed', () => {
    const d = descriptor({
      projectName: 'sikap-uat-2026',
      access: { ...descriptor().access, hostnames: ['sikap-uat-2026.pages.dev', '*.sikap-uat-2026.pages.dev'] },
    });
    delete d.backupBucket;
    assert.deepEqual(codesOf(d), []);
  });

  test('report never echoes descriptor values', () => {
    const d = descriptor();
    for (const r of [validateDescriptor(d, policy()), validateDescriptor({ ...d, projectName: 'sikap' }, policy())]) {
      const s = JSON.stringify(r);
      for (const v of [ACCOUNT, 'sikap-uat-db', 'sikap-uat-files', 'sikap-team', 'c'.repeat(64), 'd'.repeat(64), d.database.id]) {
        assert.ok(!s.includes(v), `leaked ${v}`);
      }
    }
  });

  test('same production account explicitly allowed still credentialScopeVerified=false', () => {
    const r = validateDescriptor(descriptor(), policy({ allowedAccountIds: [ACCOUNT, OTHER_ACCOUNT] }));
    assert.equal(r.ok, true);
    assertSafeFlags(r);
  });
});

describe('canonical hash', () => {
  test('key order independent, deep sorted', () => {
    const d = descriptor();
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(d).reverse())));
    reordered.database = { name: d.database.name, id: d.database.id };
    reordered.access = { hostnames: d.access.hostnames, audience: d.access.audience, teamDomain: d.access.teamDomain };
    const a = validateDescriptor(d, policy()).descriptorSha256;
    const b = validateDescriptor(reordered, policy()).descriptorSha256;
    assert.equal(a, b);
    assert.equal(a, createHash('sha256').update(canonicalJson(d)).digest('hex'));
  });

  test('value change changes digest', () => {
    const a = validateDescriptor(descriptor(), policy()).descriptorSha256;
    const b = validateDescriptor(descriptor({ schemaSha256: 'f'.repeat(64) }), policy()).descriptorSha256;
    assert.notEqual(a, b);
  });

  test('canonicalJson sorts nested keys', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":0,"z":1}]},"b":1}');
  });

  test('no digest when invalid', () => {
    const r = validateDescriptor(descriptor({ projectName: 'sikap' }), policy());
    assert.equal(r.ok, false);
    assert.equal(r.descriptorSha256, undefined);
    assertSafeFlags(r);
  });
});

describe('forbidden production / preview identifiers', () => {
  test('production and preview DB UUIDs denied even with renamed project', () => {
    for (const id of [PROD_DB, PREVIEW_DB]) {
      const d = descriptor({ database: { id, name: 'sikap-uat-db' } });
      assert.ok(codesOf(d).includes('DATABASE_ID_DENIED'));
      // Baseline holds even if policy omits it.
      assert.ok(codesOf(d, policy({ deniedDatabaseIds: [] })).includes('DATABASE_ID_DENIED'));
    }
  });

  test('uppercase prod UUID rejected', () => {
    assert.ok(codesOf(descriptor({ database: { id: PROD_DB.toUpperCase(), name: 'sikap-uat-db' } })).includes('DATABASE_ID_INVALID'));
  });

  test('production project names denied regardless of policy', () => {
    for (const projectName of ['sikap', 'sikap-v2']) {
      const c = codesOf(descriptor({ projectName }), policy({ deniedProjectNames: [] }));
      assert.ok(c.includes('PROJECT_NAME_DENIED'));
      assert.ok(c.includes('PROJECT_NAME_INVALID'));
    }
  });

  test('policy-denied UAT project name', () => {
    assert.ok(codesOf(descriptor(), policy({ deniedProjectNames: ['sikap-uat'] })).includes('PROJECT_NAME_DENIED'));
  });

  test('production buckets denied regardless of policy', () => {
    for (const b of BASELINE_DENY.buckets) {
      assert.ok(codesOf(descriptor({ filesBucket: b }), policy({ deniedBuckets: [] })).includes('FILES_BUCKET_DENIED'));
      assert.ok(codesOf(descriptor({ backupBucket: b }), policy({ deniedBuckets: [] })).includes('BACKUP_BUCKET_DENIED'));
    }
  });

  test('non sikap-uat names rejected', () => {
    for (const n of ['sikapuat', 'sikap-uatx', 'Sikap-uat', 'sikap-uat-', 'sikap-uat--x', 'x-sikap-uat', 'sikap-uat_files']) {
      assert.ok(codesOf(descriptor({ filesBucket: n })).includes('FILES_BUCKET_INVALID'), n);
      assert.ok(codesOf(descriptor({ database: { id: descriptor().database.id, name: n } })).includes('DATABASE_NAME_INVALID'), n);
    }
    assert.ok(codesOf(descriptor({ filesBucket: 'sikap-uat-' + 'a'.repeat(60) })).includes('FILES_BUCKET_INVALID'));
  });

  test('files and backup buckets must differ', () => {
    assert.ok(codesOf(descriptor({ backupBucket: 'sikap-uat-files' })).includes('BUCKETS_NOT_DISTINCT'));
  });
});

describe('strict shape', () => {
  test('unknown top-level and nested fields rejected', () => {
    assert.ok(codesOf({ ...descriptor(), extra: 1 }).includes('DESCRIPTOR_UNKNOWN_FIELD'));
    assert.ok(codesOf(descriptor({ database: { ...descriptor().database, region: 'x' } })).includes('DATABASE_UNKNOWN_FIELD'));
    assert.ok(codesOf(withAccess({ bypass: true })).includes('ACCESS_UNKNOWN_FIELD'));
    assert.ok(codesOf(JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(descriptor()).slice(1)}`)).includes('DESCRIPTOR_UNKNOWN_FIELD'));
  });

  test('secret-like fields rejected', () => {
    for (const k of ['apiToken', 'secret', 'password', 'CF_API_KEY', 'credentials', 'privateKey']) {
      assert.ok(codesOf({ ...descriptor(), [k]: 'x' }).includes('DESCRIPTOR_SECRET_FIELD_FORBIDDEN'), k);
    }
    assert.ok(codesOf(withAccess({ serviceToken: 'x' })).includes('ACCESS_SECRET_FIELD_FORBIDDEN'));
    assert.ok(codesOf(descriptor({ database: { ...descriptor().database, token: 'x' } })).includes('DATABASE_SECRET_FIELD_FORBIDDEN'));
  });

  test('missing fields, wrong constants, non-objects', () => {
    const d = descriptor();
    delete d.schemaSha256;
    assert.ok(codesOf(d).includes('DESCRIPTOR_FIELD_MISSING'));
    assert.ok(codesOf(descriptor({ version: 2 })).includes('DESCRIPTOR_VERSION_UNSUPPORTED'));
    assert.ok(codesOf(descriptor({ version: '1' })).includes('DESCRIPTOR_VERSION_UNSUPPORTED'));
    assert.ok(codesOf(descriptor({ purpose: 'production' })).includes('PURPOSE_INVALID'));
    assert.ok(codesOf(descriptor({ environment: 'production' })).includes('ENVIRONMENT_INVALID'));
    assert.ok(codesOf(descriptor({ database: [] })).includes('DATABASE_INVALID'));
    assert.ok(codesOf(descriptor({ access: 'none' })).includes('ACCESS_INVALID'));
    for (const v of [null, [], 'x', 1]) {
      const r = validateDescriptor(v, policy());
      assert.deepEqual(r.codes, ['DESCRIPTOR_NOT_OBJECT']);
      assertSafeFlags(r);
    }
  });
});

describe('access hostnames', () => {
  const bad = {
    'custom domain': ['sikap-uat.pages.dev', 'uat.example.go.id'],
    'missing wildcard': ['sikap-uat.pages.dev'],
    'missing root': ['*.sikap-uat.pages.dev'],
    'duplicate root': ['sikap-uat.pages.dev', 'sikap-uat.pages.dev'],
    'other project': ['sikap-v2.pages.dev', '*.sikap-v2.pages.dev'],
    'scheme': ['https://sikap-uat.pages.dev', '*.sikap-uat.pages.dev'],
    'path': ['sikap-uat.pages.dev/x', '*.sikap-uat.pages.dev'],
    'query': ['sikap-uat.pages.dev?x', '*.sikap-uat.pages.dev'],
    'port': ['sikap-uat.pages.dev:443', '*.sikap-uat.pages.dev'],
    'backslash': ['sikap-uat.pages.dev\\', '*.sikap-uat.pages.dev'],
    'control': ['sikap-uat.pages.dev\n', '*.sikap-uat.pages.dev'],
    'uppercase': ['SIKAP-UAT.pages.dev', '*.sikap-uat.pages.dev'],
    'ip': ['127.0.0.1', '*.sikap-uat.pages.dev'],
    'extra': ['sikap-uat.pages.dev', '*.sikap-uat.pages.dev', 'x.sikap-uat.pages.dev'],
    'reversed order': ['*.sikap-uat.pages.dev', 'sikap-uat.pages.dev'],
    'not array': 'sikap-uat.pages.dev',
  };
  for (const [name, hostnames] of Object.entries(bad)) {
    test(`rejects ${name}`, () => {
      const r = validateDescriptor(withAccess({ hostnames }), policy());
      assert.equal(r.ok, false);
      assert.equal(r.accessDeclared, false);
      assert.ok(r.codes.some((c) => c.startsWith('ACCESS_HOSTNAME')), r.codes.join());
    });
  }

  test('custom domain code specific', () => {
    assert.ok(codesOf(withAccess({ hostnames: ['sikap-uat.pages.dev', 'uat.example.go.id'] })).includes('ACCESS_HOSTNAME_CUSTOM_DOMAIN_FORBIDDEN'));
  });

  test('team domain and audience', () => {
    for (const teamDomain of ['sikap.example.com', 'SIKAP.cloudflareaccess.com', 'a.b.cloudflareaccess.com', 'https://x.cloudflareaccess.com', '-x.cloudflareaccess.com']) {
      assert.ok(codesOf(withAccess({ teamDomain })).includes('ACCESS_TEAM_DOMAIN_INVALID'), teamDomain);
    }
    for (const audience of ['c'.repeat(63), 'c'.repeat(65), 'C'.repeat(64), 'g'.repeat(64), '', 64]) {
      assert.ok(codesOf(withAccess({ audience })).includes('ACCESS_AUDIENCE_INVALID'), String(audience));
    }
  });
});

describe('fingerprints and IDs', () => {
  for (const field of ['pepperFingerprint', 'schemaSha256']) {
    test(`malformed ${field}`, () => {
      for (const v of ['d'.repeat(63), 'D'.repeat(64), 'z'.repeat(64), `${'d'.repeat(64)}\n`, null]) {
        assert.equal(validateDescriptor(descriptor({ [field]: v }), policy()).ok, false);
      }
    });
  }

  test('account id format', () => {
    for (const accountId of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32)]) {
      assert.ok(codesOf(descriptor({ accountId })).includes('ACCOUNT_ID_INVALID'));
    }
  });
});

describe('policy', () => {
  test('valid policy; effective always includes baseline', () => {
    const r = validatePolicy(policy({ deniedProjectNames: [], deniedDatabaseIds: [], deniedBuckets: [] }));
    assert.equal(r.ok, true);
    for (const n of BASELINE_DENY.projectNames) assert.ok(r.effective.deniedProjectNames.has(n));
    for (const n of BASELINE_DENY.databaseIds) assert.ok(r.effective.deniedDatabaseIds.has(n));
    for (const n of BASELINE_DENY.buckets) assert.ok(r.effective.deniedBuckets.has(n));
  });

  test('account not allowed fails', () => {
    assert.ok(codesOf(descriptor(), policy({ allowedAccountIds: [OTHER_ACCOUNT] })).includes('ACCOUNT_NOT_ALLOWED'));
  });

  test('denied overrides allowed', () => {
    const c = codesOf(descriptor(), policy({ deniedAccountIds: [ACCOUNT] }));
    assert.ok(c.includes('ACCOUNT_DENIED'));
    assert.ok(!c.includes('ACCOUNT_NOT_ALLOWED'));
  });

  test('empty allow list rejected', () => {
    const r = validateDescriptor(descriptor(), policy({ allowedAccountIds: [] }));
    assert.ok(r.codes.includes('POLICY_ALLOWED_ACCOUNT_IDS_EMPTY'));
    assert.ok(r.codes.includes('POLICY_INVALID'));
  });

  test('strict policy shape', () => {
    assert.ok(validatePolicy({ ...policy(), bypass: true }).codes.includes('POLICY_UNKNOWN_FIELD'));
    assert.ok(validatePolicy({ ...policy(), allowCustomDomains: true }).codes.includes('POLICY_UNKNOWN_FIELD'));
    assert.ok(validatePolicy({ ...policy(), apiToken: 'x' }).codes.includes('POLICY_SECRET_FIELD_FORBIDDEN'));
    const p = policy();
    delete p.deniedBuckets;
    assert.ok(validatePolicy(p).codes.includes('POLICY_FIELD_MISSING'));
    assert.ok(validatePolicy(policy({ version: 2 })).codes.includes('POLICY_VERSION_UNSUPPORTED'));
    assert.ok(validatePolicy(policy({ allowedAccountIds: ['X'] })).codes.includes('POLICY_ALLOWED_ACCOUNT_IDS_INVALID'));
    assert.ok(validatePolicy(policy({ deniedDatabaseIds: ['nope'] })).codes.includes('POLICY_DENIED_DATABASE_IDS_INVALID'));
    assert.ok(validatePolicy(policy({ allowedAccountIds: [ACCOUNT, ACCOUNT] })).codes.includes('POLICY_ALLOWED_ACCOUNT_IDS_DUPLICATE'));
    assert.ok(validatePolicy([]).codes.includes('POLICY_NOT_OBJECT'));
  });

  test('invalid policy cannot weaken baseline', () => {
    const r = validateDescriptor(descriptor({ projectName: 'sikap-v2' }), { version: 1 });
    assert.ok(r.codes.includes('PROJECT_NAME_DENIED'));
    assert.equal(r.ok, false);
  });
});

describe('CLI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uat-target-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, content) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content), { mode: 0o600 });
    return f;
  };
  const run = (argv) => {
    let out = '';
    const exit = runCli(argv, (s) => { out += s; });
    assert.ok(out.endsWith('\n'));
    return { exit, report: JSON.parse(out) };
  };
  const dFile = write('d.json', descriptor());
  const pFile = write('p.json', policy());

  test('valid run', () => {
    const { exit, report } = run(['--descriptor', dFile, '--policy', pFile]);
    assert.equal(exit, 0);
    assert.equal(report.ok, true);
    assertSafeFlags(report);
    assert.equal(report.descriptorSha256, validateDescriptor(descriptor(), policy()).descriptorSha256);
  });

  test('usage errors', () => {
    assert.deepEqual(parseCliArgs([]).codes, ['USAGE_DESCRIPTOR_REQUIRED', 'USAGE_POLICY_REQUIRED']);
    assert.ok(parseCliArgs(['--descriptor', dFile, '--policy', pFile, '--remote']).codes.includes('USAGE_REMOTE_FORBIDDEN'));
    assert.ok(parseCliArgs(['--descriptor', dFile, '--policy', pFile, '--remote=true']).codes.includes('USAGE_REMOTE_FORBIDDEN'));
    assert.ok(parseCliArgs(['--descriptor', dFile, '--policy', pFile, '--out', 'x']).codes.includes('USAGE_UNKNOWN_ARGUMENT'));
    assert.ok(parseCliArgs(['--descriptor', dFile, '--descriptor', dFile, '--policy', pFile]).codes.includes('USAGE_DUPLICATE_FLAG'));
    assert.ok(parseCliArgs(['--descriptor', '--policy', pFile]).codes.includes('USAGE_FLAG_VALUE_MISSING'));
    const { exit, report } = run(['--descriptor', dFile]);
    assert.equal(exit, 2);
    assertSafeFlags(report);
  });

  test('oversize, invalid JSON, missing, directory', () => {
    const big = write('big.json', ' '.repeat(MAX_FILE_BYTES + 1));
    assert.ok(run(['--descriptor', big, '--policy', pFile]).report.codes.includes('DESCRIPTOR_FILE_TOO_LARGE'));
    const junk = write('junk.json', '{nope');
    assert.ok(run(['--descriptor', dFile, '--policy', junk]).report.codes.includes('POLICY_JSON_INVALID'));
    assert.ok(run(['--descriptor', path.join(dir, 'missing.json'), '--policy', pFile]).report.codes.includes('DESCRIPTOR_FILE_NOT_FOUND'));
    assert.ok(run(['--descriptor', dir, '--policy', pFile]).report.codes.includes('DESCRIPTOR_FILE_NOT_REGULAR'));
  });

  test('forbidden ids via CLI exit 1 without echo', () => {
    const f = write('prod.json', descriptor({ database: { id: PROD_DB, name: 'sikap-uat-db' } }));
    const { exit, report } = run(['--descriptor', f, '--policy', pFile]);
    assert.equal(exit, 1);
    assert.ok(report.codes.includes('DATABASE_ID_DENIED'));
    assert.ok(!JSON.stringify(report).includes(PROD_DB));
  });

  test('symlinked file and ancestor rejected', (t) => {
    const fileLink = path.join(dir, 'link.json');
    const dirLink = path.join(dir, 'linkdir');
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'd.json'), JSON.stringify(descriptor()));
    let fileLinked = true;
    try { fs.symlinkSync(dFile, fileLink, 'file'); } catch { fileLinked = false; }
    fs.symlinkSync(realDir, dirLink, 'junction');
    if (fileLinked) assert.equal(readBoundedJsonFile(fileLink, 'DESCRIPTOR').code, 'DESCRIPTOR_FILE_SYMLINK_FORBIDDEN');
    else t.diagnostic('file symlink not permitted on this host; ancestor junction still tested');
    assert.equal(readBoundedJsonFile(path.join(dirLink, 'd.json'), 'DESCRIPTOR').code, 'DESCRIPTOR_FILE_SYMLINK_FORBIDDEN');
  });

  test('device paths rejected', () => {
    assert.equal(readBoundedJsonFile('\\\\?\\C:\\x.json', 'DESCRIPTOR').code, 'DESCRIPTOR_FILE_PATH_INVALID');
    assert.equal(readBoundedJsonFile('', 'POLICY').code, 'POLICY_FILE_PATH_INVALID');
  });
});

describe('lexical path guard (no fs, no SMB)', () => {
  // Any fs call fails the test: rejected paths must never reach the filesystem.
  const trap = new Proxy({}, { get: (_, k) => () => assert.fail(`fs.${String(k)} called`) });
  const noResolve = () => assert.fail('resolve called for lexically rejected path');
  const rejected = [
    '\\\\server\\share\\d.json',
    '//server/share/d.json',
    '\\/server/share/d.json',
    '/\\server\\share\\d.json',
    '\\\\server',
    '//10.0.0.1/c$/d.json',
    '\\\\?\\C:\\d.json',
    '\\\\.\\C:\\d.json',
    '//?/C:/d.json',
    '\\\\?\\UNC\\server\\share\\d.json',
    '\\??\\UNC\\server\\share\\d.json',
    '/??/C:/d.json',
    'd.json\n',
    'a\u0007.json',
    'a\0.json',
    '',
    'x'.repeat(4097),
  ];
  for (const p of rejected) {
    test(`rejects ${JSON.stringify(p.slice(0, 40))}`, () => {
      assert.equal(isSafeLocalPath(p, noResolve), false);
      assert.deepEqual(readBoundedJsonFile(p, 'DESCRIPTOR', trap), { ok: false, code: 'DESCRIPTOR_FILE_PATH_INVALID' });
    });
  }

  test('non-string rejected without fs', () => {
    for (const p of [undefined, null, 1, ['//x/y']]) {
      assert.equal(readBoundedJsonFile(p, 'POLICY', trap).code, 'POLICY_FILE_PATH_INVALID');
    }
  });

  test('UNC current directory caught after resolve', () => {
    assert.equal(isSafeLocalPath('d.json', () => '\\\\server\\share\\d.json'), false);
    assert.equal(isSafeLocalPath('d.json', () => '//server/share/d.json'), false);
  });

  test('normal local paths allowed', () => {
    for (const p of ['/tmp/uat/d.json', 'd.json', './x/d.json', 'C:\\uat\\d.json', 'C:/uat/d.json', '\\uat\\d.json']) {
      assert.equal(isSafeLocalPath(p, (x) => x), true, p);
    }
    assert.equal(isSafeLocalPath('/tmp/uat/d.json', path.posix.resolve), true);
  });

  test('CLI rejects UNC before any read', () => {
    let out = '';
    const exit = runCli(['--descriptor', '\\\\server\\share\\d.json', '--policy', '//server/share/p.json'], (s) => { out += s; });
    assert.equal(exit, 1);
    const report = JSON.parse(out);
    assert.deepEqual(report.codes, ['DESCRIPTOR_FILE_PATH_INVALID', 'POLICY_FILE_PATH_INVALID']);
    assert.ok(!out.includes('server'));
  });
});
