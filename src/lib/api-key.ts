/**
 * Browser-side Anthropic API-key custody: read/write/clear the user-pasted key.
 *
 * Split out of `claude-api.ts` (#2371, eviction pass — epic #1852 / ADR 0016)
 * so the eager first-paint shell can read the key WITHOUT pulling the heavier
 * `claude-api` surface — and, transitively, the `model-registry` pricing/model
 * tables it imports — into the frozen `index` chunk. Those helpers are only
 * needed once the user opens Settings / Ask-Claude (lazy views), so `claude-api`
 * re-exports these three functions for its existing consumers and stays lazy;
 * only this tiny, dependency-free module remains in the eager graph.
 */

const API_KEY_STORAGE = 'claude-history-dashboard:anthropic-api-key';

// The Ask-Claude key lives in sessionStorage, not localStorage (#2063): it is
// cleared on tab close and not shared across tabs, shrinking the window in which
// a script in the origin could read it, and matching where the enterprise auth
// token is held. getApiKey migrates a key written by an older localStorage-based
// build so users don't have to re-enter it once.
export function getApiKey(): string | null {
  try {
    const current = sessionStorage.getItem(API_KEY_STORAGE);
    if (current !== null) return current;
    const legacy = localStorage.getItem(API_KEY_STORAGE);
    if (legacy !== null) {
      sessionStorage.setItem(API_KEY_STORAGE, legacy);
      localStorage.removeItem(API_KEY_STORAGE);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

export function setApiKey(key: string): void {
  try {
    sessionStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    /* sessionStorage may be disabled (private mode etc.) — silently fail */
  }
}

export function clearApiKey(): void {
  try {
    sessionStorage.removeItem(API_KEY_STORAGE);
    // Also drop any key left by an older localStorage-based build.
    localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* see setApiKey */
  }
}
