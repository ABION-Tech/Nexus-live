// Session 50 — PRD §14 light/dark toggle. "Both" storage, deliberately
// layered rather than picking one:
//
// - localStorage is what actually paints the page, synchronously, on
//   every load — including LoginPage, before any session check has
//   resolved. Theme is a rendering concern that shouldn't have to wait
//   on a network round trip the way admin-gate flags or IA visibility
//   legitimately do.
// - The server column (0026_theme_preference.sql) is the account-level
//   source of truth once someone's actually signed in — same person on
//   a second device should see their own preference, not device-local
//   dark-by-default. App.tsx's `syncFromSession` effect below is what
//   reconciles the two: server wins once a session resolves, and the
//   write-through on toggle keeps them from drifting apart again.
//
// Kept as its own file (not folded into App.tsx) because ThemeProvider
// has to wrap LoginPage too — it can't live inside the
// session-status-gated tree the way AuthenticatedApp does.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThemePreference } from '@nexus/shared';
import { patchThemePreference } from '../services/themeService';

const STORAGE_KEY = 'nexus-theme';

function readStoredTheme(): ThemePreference {
  // SSR-safe guard is unnecessary here (this is a Vite SPA, no server
  // render pass), but a corrupted/foreign localStorage value shouldn't
  // be able to put the app in an unstyled state — same defensive
  // posture as userPreferencesService.ts's own fallback-to-'dark' on a
  // missing DB row.
  const stored = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
  return stored === 'light' || stored === 'dark' ? stored : 'dark';
}

interface ThemeContextValue {
  theme: ThemePreference;
  /** Flips the theme, persists to localStorage immediately, and — if
   * `persistToServer` (default true) — best-effort PATCHes the account's
   * saved preference. Pass `persistToServer: false` only for the
   * server->client reconciliation effect below; every user-initiated
   * toggle should leave it at the default. */
  setTheme: (theme: ThemePreference, persistToServer?: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  function setTheme(next: ThemePreference, persistToServer = true) {
    setThemeState(next);
    if (persistToServer) {
      // Fire-and-forget, same "never let a preference write block or
      // fail the interaction that triggered it" posture as
      // routes/auth.ts's own recomputeSeatCount call — the toggle
      // already flipped locally; a failed PATCH just means next
      // session's server sync re-applies the old value, not that
      // anything is broken right now.
      patchThemePreference(next).catch((err) => {
        console.warn('Failed to save theme preference', err);
      });
    }
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
