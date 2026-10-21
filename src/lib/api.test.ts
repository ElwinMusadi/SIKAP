import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setSessionExpiredListener } from './api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sessionExpired = () =>
  jsonResponse(401, { error: { code: 'SESSION_EXPIRED', message: 'Sesi Anda telah berakhir.' } });

describe('api()', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const listener = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    setSessionExpiredListener(listener);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    listener.mockReset();
    setSessionExpiredListener(null);
  });

  it('returns parsed JSON on success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await expect(api<{ ok: boolean }>('/x')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/x', expect.objectContaining({ method: 'GET' }));
  });

  it('notifies the session-expired listener on 401 SESSION_EXPIRED for regular paths', async () => {
    fetchMock.mockResolvedValueOnce(sessionExpired());
    await expect(api('/x')).rejects.toMatchObject({ status: 401, code: 'SESSION_EXPIRED', path: '/x' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toBeInstanceOf(ApiError);
  });

  it.each(['/auth/me', '/auth/login', '/auth/logout'])('does not notify the listener for probe path %s', async (path) => {
    fetchMock.mockResolvedValueOnce(sessionExpired());
    await expect(api(path, { method: 'POST' })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('maps a network failure to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = await api('/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('maps a non-JSON 500 to INTERNAL_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Bad Gateway</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
    );
    await expect(api('/x')).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('exposes validation field errors', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid', fields: { nip: 'NIP wajib diisi.' } } }),
    );
    await expect(api('/x', { method: 'POST', body: {} })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      fields: { nip: 'NIP wajib diisi.' },
    });
  });
});
