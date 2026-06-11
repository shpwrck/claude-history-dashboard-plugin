/**
 * Light/dark theme preference (#442).
 *
 * PatternFly 6 ships a dark theme via the `pf-v6-theme-dark` class on
 * `<html>`. This module owns:
 *  - resolving the initial theme (manual choice in localStorage wins; otherwise
 *    the OS `prefers-color-scheme`),
 *  - applying the resolved theme to `document.documentElement`, and
 *  - persisting a manual choice.
 *
 * It lives alongside {@link ../lib/nav-prefs} (a sibling pref) but in its own
 * key so the theme toggle and the nav prefs evolve independently.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'claude-dashboard:theme';
/** PF6's dark-theme class, toggled on `<html>`. */
export const PF_DARK_CLASS = 'pf-v6-theme-dark';

/** Read the user's persisted manual choice, or `null` if they never picked. */
export function getStoredTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch {
    return null;
  }
}

/** Persist a manual theme choice so it survives reloads. */
export function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* localStorage may be disabled (private mode etc.) — silently fail */
  }
}

/** The OS-level preference, defaulting to `light` where unavailable. */
export function getSystemTheme(): Theme {
  try {
    return window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  } catch {
    return 'light';
  }
}

/**
 * The theme to use on first paint: a stored manual choice wins, otherwise the
 * OS preference (#442 acceptance — "first load respects OS preference").
 */
export function resolveInitialTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

/** Toggle the PF dark class on `<html>` to match `theme`. */
export function applyTheme(theme: Theme): void {
  try {
    const root = document.documentElement;
    root.classList.toggle(PF_DARK_CLASS, theme === 'dark');
  } catch {
    /* no DOM (SSR/tests without jsdom) — no-op */
  }
}
