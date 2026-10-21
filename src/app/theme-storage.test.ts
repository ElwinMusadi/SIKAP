import { describe, expect, it } from 'vitest';
import INIT_SCRIPT from '../../public/theme-init.js?raw';
import { THEME_STORAGE_KEY, themeFromStored } from './theme-storage';

/** Runs public/theme-init.js against a fake page; `stored` undefined means storage throws. */
function runInitScript(stored: string | null | undefined, prefersDark = true) {
  const classes = new Set<string>();
  const meta = { content: '#f7f6f2', setAttribute: (_: string, value: string) => (meta.content = value) };
  const keys: string[] = [];
  const localStorage = {
    getItem: (key: string) => {
      keys.push(key);
      if (stored === undefined) throw new Error('storage disabled');
      return stored;
    },
  };
  const document = {
    documentElement: { classList: { add: (name: string) => classes.add(name) } },
    querySelector: () => meta,
  };
  // The OS asks for dark (by default here): the script must ignore it.
  const window = { matchMedia: () => ({ matches: prefersDark }) };
  new Function('localStorage', 'document', 'window', INIT_SCRIPT)(localStorage, document, window);
  return { dark: classes.has('dark'), themeColor: meta.content, keys };
}

describe('themeFromStored', () => {
  it('is light unless dark was switched on', () => {
    expect(themeFromStored('dark')).toBe('dark');
    expect(themeFromStored(null)).toBe('light');
    expect(themeFromStored('light')).toBe('light');
    expect(themeFromStored('system')).toBe('light');
    expect(themeFromStored('')).toBe('light');
  });
});

describe('public/theme-init.js', () => {
  it('reads the same storage key as the app', () => {
    expect(runInitScript(null).keys).toEqual([THEME_STORAGE_KEY]);
  });

  it('stays light by default even when the OS prefers dark', () => {
    expect(runInitScript(null, true)).toMatchObject({ dark: false, themeColor: '#f7f6f2' });
    expect(runInitScript('light', true).dark).toBe(false);
    expect(runInitScript('system', true).dark).toBe(false);
  });

  it('applies dark only for the stored opt-in', () => {
    expect(runInitScript('dark', false)).toMatchObject({ dark: true, themeColor: '#0d0e11' });
  });

  it('falls back to light when storage is unavailable', () => {
    expect(runInitScript(undefined).dark).toBe(false);
  });

  it('agrees with themeFromStored for every value', () => {
    for (const value of [null, '', 'light', 'dark', 'system', 'DARK']) {
      expect(runInitScript(value).dark).toBe(themeFromStored(value) === 'dark');
    }
  });
});
