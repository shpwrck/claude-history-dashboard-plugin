// @vitest-environment jsdom
//
// Browser API-key custody (#3281, building on #2063): the BYO Ask-Claude key
// must never rest in a DURABLE script-readable store. The ADR 0008 BYO
// contract now requires memory-only/session-bounded handling; the
// implementation holds the key in sessionStorage (tab-scoped, cleared when the
// browsing session ends) and destroys any localStorage copy a pre-#2063 build
// left behind. These tests are the automated browser check for that contract:
// no durable web-storage entry ever contains the credential, and once the
// session storage is gone the key is gone — nothing durable resurrects it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearApiKey, getApiKey, setApiKey } from './api-key';

const STORAGE_KEY = 'claude-history-dashboard:anthropic-api-key';
const KEY = 'sk-ant-test-credential-3281';

/** Every value currently held in a durable web store (localStorage). */
function durableValues(): string[] {
  const values: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (name !== null) values.push(localStorage.getItem(name) ?? '');
  }
  return values;
}

describe('browser API-key custody is session-bounded, never durable (#3281)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('setApiKey writes no durable web-storage entry anywhere', () => {
    setApiKey(KEY);

    expect(getApiKey()).toBe(KEY);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(KEY);
    expect(localStorage.length).toBe(0);
    expect(durableValues()).not.toContain(KEY);
  });

  it('the credential does not survive the end of the browsing session', () => {
    setApiKey(KEY);
    // sessionStorage is discarded when the tab's browsing session ends —
    // simulate that boundary, then prove nothing durable resurrects the key.
    sessionStorage.clear();

    expect(getApiKey()).toBeNull();
    expect(durableValues()).not.toContain(KEY);
  });

  it('destroys a legacy localStorage copy on first read (one-shot migration)', () => {
    // A pre-#2063 build persisted the key durably; reading it must move it to
    // session custody and delete the durable copy.
    localStorage.setItem(STORAGE_KEY, KEY);

    expect(getApiKey()).toBe(KEY);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(durableValues()).not.toContain(KEY);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(KEY);
  });

  it('clearApiKey purges both session custody and any legacy durable copy', () => {
    sessionStorage.setItem(STORAGE_KEY, KEY);
    localStorage.setItem(STORAGE_KEY, KEY);

    clearApiKey();

    expect(getApiKey()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
