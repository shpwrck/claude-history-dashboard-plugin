// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PF_DARK_CLASS,
  applyTheme,
  getStoredTheme,
  getSystemTheme,
  resolveInitialTheme,
  setStoredTheme,
} from './theme';

const STORAGE_KEY = 'claude-dashboard:theme';

function mockSystem(prefersDark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('dark') ? prefersDark : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove(PF_DARK_CLASS);
    mockSystem(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns null stored theme until the user picks one', () => {
    expect(getStoredTheme()).toBeNull();
  });

  it('persists and reads back a manual choice', () => {
    setStoredTheme('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(getStoredTheme()).toBe('dark');
    setStoredTheme('light');
    expect(getStoredTheme()).toBe('light');
  });

  it('reads the OS preference', () => {
    mockSystem(true);
    expect(getSystemTheme()).toBe('dark');
    mockSystem(false);
    expect(getSystemTheme()).toBe('light');
  });

  it('initial theme follows the OS preference when no manual choice exists', () => {
    mockSystem(true);
    expect(resolveInitialTheme()).toBe('dark');
    mockSystem(false);
    expect(resolveInitialTheme()).toBe('light');
  });

  it('manual choice overrides the OS preference on initial resolve', () => {
    mockSystem(true); // OS prefers dark…
    setStoredTheme('light'); // …but the user chose light
    expect(resolveInitialTheme()).toBe('light');
  });

  it('applyTheme toggles the PF dark class on <html>', () => {
    applyTheme('dark');
    expect(document.documentElement.classList.contains(PF_DARK_CLASS)).toBe(
      true
    );
    applyTheme('light');
    expect(document.documentElement.classList.contains(PF_DARK_CLASS)).toBe(
      false
    );
  });
});
