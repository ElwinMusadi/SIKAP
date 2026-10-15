import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it.each([
    [null, '/'],
    ['', '/'],
    ['https://evil.example', '/'],
    ['evil.example/path', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/a\tb', '/'],
    ['/a\nb', '/'],
    ['/a\u007fb', '/'],
  ])('rejects %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    ['/', '/'],
    ['/admin/pegawai?x=1', '/admin/pegawai?x=1'],
    ['/akun#sesi', '/akun#sesi'],
    // Encoded slashes stay a single same-origin path segment; the router never decodes them into "//".
    ['/%2F%2Fevil', '/%2F%2Fevil'],
  ])('keeps same-origin path %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});
