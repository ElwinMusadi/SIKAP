// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Returns `raw` only when it is a same-origin absolute path, preventing open
 * redirects via `?next=//evil.com`, `?next=/\evil.com`, or `?next=https://...`.
 */
export function safeNextPath(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (CONTROL_CHARS.test(raw)) return '/';
  return raw;
}
