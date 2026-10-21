import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { THEME_STORAGE_KEY, themeFromStored, type Theme } from '@/app/theme-storage';

export type { Theme } from '@/app/theme-storage';

const THEME_COLORS: Record<Theme, string> = { light: '#f7f6f2', dark: '#0d0e11' };

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readTheme(): Theme {
  try {
    return themeFromStored(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'light';
  }
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}

/** Light by default; dark only when switched on manually, per device (docs/RENCANA-REDESIGN-UIUX.md §9). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => applyTheme(theme), [theme]);

  const setTheme = useCallback((next: Theme) => {
    try {
      // Light is the default, so only the opt-in is stored.
      if (next === 'dark') localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      else localStorage.removeItem(THEME_STORAGE_KEY);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this tab only.
    }
    setThemeState(next);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider.');
  return context;
}
