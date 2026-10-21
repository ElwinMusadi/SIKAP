export type Theme = 'light' | 'dark';

/** Same key as public/theme-init.js (applies the class before React renders, so no flash). */
export const THEME_STORAGE_KEY = 'sikap.theme';

/**
 * Light unless this device opted into dark. The OS colour scheme is deliberately ignored, and
 * entries from the old light/dark/system picker ("light", or nothing for "system") read as light.
 */
export function themeFromStored(value: string | null): Theme {
  return value === 'dark' ? 'dark' : 'light';
}
