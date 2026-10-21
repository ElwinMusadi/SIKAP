import { describe, expect, it } from 'vitest';
import { actionLabel, actorLabel, logQueryString, parseLogFilters, validateLogFilters, EMPTY_LOG_FILTERS } from './log-utils';

describe('log filters', () => {
  it('drops unknown or malformed URL values', () => {
    const f = parseLogFilters(new URLSearchParams('q=%20budi%20&category=hack&result=SUCCESS&from=2026-1-1&to=2026-10-16'));
    expect(f).toEqual({ q: 'budi', category: null, result: 'SUCCESS', from: '', to: '2026-10-16' });
  });

  it('sends the same filters with every cursor, literal q encoded', () => {
    const filters = { ...EMPTY_LOG_FILTERS, q: "a%_'b", category: 'dokumen' as const };
    expect(logQueryString(filters, null)).toBe('?q=a%25_%27b&category=dokumen');
    expect(logQueryString(filters, 'abc==')).toBe('?q=a%25_%27b&category=dokumen&cursor=abc%3D%3D');
    expect(logQueryString(EMPTY_LOG_FILTERS, null)).toBe('');
  });

  it('rejects reversed date range via shared schema', () => {
    expect(validateLogFilters({ ...EMPTY_LOG_FILTERS, from: '2026-10-10', to: '2026-10-01' })).toHaveProperty('to');
    expect(validateLogFilters({ ...EMPTY_LOG_FILTERS, from: '2026-02-30' })).toHaveProperty('from');
    expect(validateLogFilters({ ...EMPTY_LOG_FILTERS, from: '2026-10-01', to: '2026-10-01' })).toEqual({});
  });

  it('formats actor and action', () => {
    expect(actorLabel({ id: null, nip: null, nama: null, role: null }).name).toBe('Sistem');
    expect(actorLabel({ id: 1, nip: '1990', nama: 'Budi', role: 'Admin' })).toEqual({ name: 'Budi', detail: '1990' });
    expect(actionLabel('dokumen.approve')).toBe('Dokumen · approve');
    expect(actionLabel('custom')).toBe('custom');
  });
});
