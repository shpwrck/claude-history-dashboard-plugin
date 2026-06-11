// @vitest-environment jsdom
//
// Regression coverage for the versioned/opt-in nav-prefs model (#608) — the
// prerequisite for the recs-driven curated default (#609). The invariant under
// test: a never-customized profile rolls forward to the current curated default,
// while an explicit customization is preserved untouched, and legacy/malformed
// blobs degrade gracefully.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURATED_DEFAULT_HIDDEN_VIEWS,
  CURATED_CORE_VIEWS,
  CURRENT_NAV_LAYOUT_VERSION,
  getNavPrefs,
  migrateNavPrefs,
  isDefaultVisibleView,
  hideView,
  showView,
  showAllViews,
  setLastView,
  setEntrypointFilter,
  toggleAdvancedNav,
  type NavPrefs,
} from './nav-prefs';
import type { ActionDomain } from '../types';

const STORAGE_KEY = 'claude-dashboard:nav-prefs';

function store(blob: unknown): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

// A minimal well-formed prefs object at an arbitrary version, for unit-testing
// the pure migration function in isolation.
function prefsAt(version: number, over: Partial<NavPrefs> = {}): NavPrefs {
  return {
    hiddenViews: [],
    bannerDismissed: false,
    entrypointFilter: 'all',
    navLayoutVersion: version,
    customized: false,
    ...over,
  };
}

describe('getNavPrefs — fresh install', () => {
  it('adopts the curated default visible-set and stamps the current version', () => {
    const prefs = getNavPrefs();
    expect(prefs.hiddenViews).toEqual([...CURATED_DEFAULT_HIDDEN_VIEWS]);
    expect(prefs.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
    expect(prefs.customized).toBe(false);
  });

  it('returns defaults (not a shared reference) so callers can mutate safely', () => {
    const a = getNavPrefs();
    const b = getNavPrefs();
    expect(a).not.toBe(b);
    expect(a.hiddenViews).not.toBe(b.hiddenViews);
  });
});

describe('migrateNavPrefs — version reconciliation', () => {
  it('is a no-op for a profile already at the current version', () => {
    const current = prefsAt(CURRENT_NAV_LAYOUT_VERSION, {
      hiddenViews: ['stats'],
      customized: true,
    });
    expect(migrateNavPrefs(current)).toBe(current);
  });

  it('rolls a never-customized old profile forward to the curated default', () => {
    const legacy = prefsAt(0, { hiddenViews: [], customized: false });
    const migrated = migrateNavPrefs(legacy);
    expect(migrated.hiddenViews).toEqual([...CURATED_DEFAULT_HIDDEN_VIEWS]);
    expect(migrated.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
    expect(migrated.customized).toBe(false);
  });

  it('REPLACES a stale hidden-set with the curated default when not customized', () => {
    // Non-vacuous even while CURATED is []: a never-customized profile carrying a
    // stale non-empty hidden-set must be reset to the curated default, not left
    // as-is. This is what distinguishes "migration adopted the curated set" from
    // "migration did nothing" — the assertion that survives #609 making CURATED
    // non-empty. The input ['cost','stats'] must NOT pass through.
    const stale = prefsAt(0, { hiddenViews: ['cost', 'stats'], customized: false });
    const migrated = migrateNavPrefs(stale);
    expect(migrated.hiddenViews).toEqual([...CURATED_DEFAULT_HIDDEN_VIEWS]);
    expect(migrated.hiddenViews).not.toEqual(['cost', 'stats']);
    expect(migrated.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
  });

  it('preserves an explicit customization across the upgrade (regression)', () => {
    // The exact clobber the versioned model exists to prevent: a user who chose
    // their own visible-set keeps it, even when it differs from the curated set.
    const customized = prefsAt(0, {
      hiddenViews: ['cost', 'tokens'],
      customized: true,
    });
    const migrated = migrateNavPrefs(customized);
    expect(migrated.hiddenViews).toEqual(['cost', 'tokens']);
    expect(migrated.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
    expect(migrated.customized).toBe(true);
  });

  it('is idempotent — re-running after a migration changes nothing', () => {
    const once = migrateNavPrefs(prefsAt(0, { hiddenViews: ['errors'], customized: true }));
    const twice = migrateNavPrefs(once);
    expect(twice).toEqual(once);
  });
});

describe('getNavPrefs — legacy blob migration', () => {
  it('treats a versionless empty profile as never-customized and rolls it forward', () => {
    store({ hiddenViews: [], bannerDismissed: false, entrypointFilter: 'all' });
    const prefs = getNavPrefs();
    expect(prefs.hiddenViews).toEqual([...CURATED_DEFAULT_HIDDEN_VIEWS]);
    expect(prefs.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
    expect(prefs.customized).toBe(false);
  });

  it('infers customization from a legacy non-empty hiddenViews and preserves it', () => {
    // Pre-#608 the only way to populate hiddenViews was an explicit Settings
    // toggle, so a legacy non-empty set must survive as a customization.
    store({ hiddenViews: ['cost', 'timeline'], bannerDismissed: true, entrypointFilter: 'all' });
    const prefs = getNavPrefs();
    expect(prefs.hiddenViews).toEqual(['cost', 'timeline']);
    expect(prefs.customized).toBe(true);
    expect(prefs.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
  });

  it('does NOT treat banner dismissal alone as a customization', () => {
    store({ hiddenViews: [], bannerDismissed: true, entrypointFilter: 'all' });
    const prefs = getNavPrefs();
    expect(prefs.customized).toBe(false);
    expect(prefs.hiddenViews).toEqual([...CURATED_DEFAULT_HIDDEN_VIEWS]);
  });

  it('does NOT infer customization from a non-empty hidden-set on a VERSIONED blob', () => {
    // Downgrade safety: a version-1+ blob whose hiddenViews came from an adopted
    // curated default (customized:false) must stay non-customized — the length
    // heuristic is for legacy version-0 blobs only, so the stored flag wins here.
    store({
      hiddenViews: ['timeline', 'cost'],
      bannerDismissed: false,
      entrypointFilter: 'all',
      navLayoutVersion: CURRENT_NAV_LAYOUT_VERSION,
      customized: false,
    });
    const prefs = getNavPrefs();
    expect(prefs.customized).toBe(false);
    // At the current version migration is a no-op, so the set is left intact.
    expect(prefs.hiddenViews).toEqual(['timeline', 'cost']);
  });

  it('honours an explicit stored customized flag even with an empty hidden-set', () => {
    store({
      hiddenViews: [],
      bannerDismissed: false,
      entrypointFilter: 'all',
      navLayoutVersion: 0,
      customized: true,
    });
    const prefs = getNavPrefs();
    // customized + empty set means "I explicitly want everything" — must not be
    // re-hidden by the curated default.
    expect(prefs.customized).toBe(true);
    expect(prefs.hiddenViews).toEqual([]);
    expect(prefs.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
  });
});

describe('getNavPrefs — graceful degradation', () => {
  it('drops unknown view ids while sanitizing the hidden-set', () => {
    store({ hiddenViews: ['cost', 'not-a-real-view', 42], entrypointFilter: 'all' });
    expect(getNavPrefs().hiddenViews).toEqual(['cost']);
  });

  it('falls back to defaults for a non-object / malformed blob', () => {
    localStorage.setItem(STORAGE_KEY, 'not json {{{');
    const prefs = getNavPrefs();
    expect(prefs.navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
    expect(prefs.hiddenViews).toEqual([...CURATED_DEFAULT_HIDDEN_VIEWS]);
  });

  it('coerces a non-numeric stored version to a forward-migrating 0', () => {
    store({ hiddenViews: [], navLayoutVersion: 'bogus', entrypointFilter: 'all' });
    expect(getNavPrefs().navLayoutVersion).toBe(CURRENT_NAV_LAYOUT_VERSION);
  });
});

describe('mutators set the customization signal', () => {
  it('hideView marks the profile customized', () => {
    expect(hideView(prefsAt(1), 'stats').customized).toBe(true);
  });

  it('showView marks the profile customized', () => {
    const hidden = prefsAt(1, { hiddenViews: ['stats'] });
    expect(showView(hidden, 'stats').customized).toBe(true);
  });

  it('showAllViews marks the profile customized when it clears a hidden-set', () => {
    const hidden = prefsAt(1, { hiddenViews: ['stats', 'cost'] });
    const shown = showAllViews(hidden);
    expect(shown.hiddenViews).toEqual([]);
    expect(shown.customized).toBe(true);
  });

  it('setLastView / setEntrypointFilter do NOT mark the profile customized', () => {
    expect(setLastView(prefsAt(1), 'cost').customized).toBe(false);
    expect(setEntrypointFilter(prefsAt(1), 'unattended').customized).toBe(false);
  });
});

describe('isDefaultVisibleView — recs-driven curated default (#609)', () => {
  it('always shows the curated core, even with no findings', () => {
    for (const view of CURATED_CORE_VIEWS) {
      expect(isDefaultVisibleView(view, null)).toBe(true);
      expect(isDefaultVisibleView(view, new Set())).toBe(true);
    }
  });

  it('hides a non-core view whose domain has no active finding', () => {
    // tokens (cost domain), agents (workflow-hygiene), stats (raw) are not core.
    expect(isDefaultVisibleView('reclaim-compass', new Set())).toBe(true);
    expect(isDefaultVisibleView('tokens', new Set())).toBe(false);
    expect(isDefaultVisibleView('agents', null)).toBe(false);
    expect(isDefaultVisibleView('stats', new Set())).toBe(false);
  });

  it('reveals a non-core view once its action-domain has a finding', () => {
    // `tokens` and `files` are cost-domain; a cost finding reveals them.
    const cost = new Set<ActionDomain>(['cost']);
    expect(isDefaultVisibleView('tokens', cost)).toBe(true);
    expect(isDefaultVisibleView('files', cost)).toBe(true);
    // ...but a different domain stays hidden.
    expect(isDefaultVisibleView('agents', cost)).toBe(false);
  });

  it('core membership matches the issue-specified set', () => {
    expect([...CURATED_CORE_VIEWS].sort()).toEqual(
      [
        'cost',
        'errors',
        'home',
        'permissions',
        'reclaim-compass',
        'recommendations',
        'search',
      ].sort()
    );
  });
});

describe('toggleAdvancedNav — Show advanced views toggle (#609)', () => {
  it('expands a curated profile to advanced mode', () => {
    const next = toggleAdvancedNav(prefsAt(1, { customized: false }));
    expect(next.customized).toBe(true);
  });

  it('collapses an advanced profile back to curated', () => {
    const next = toggleAdvancedNav(prefsAt(1, { customized: true }));
    expect(next.customized).toBe(false);
  });

  it('NEVER discards an explicit hidden-set across a collapse->expand round-trip', () => {
    // Regression: a user who hid tabs via Settings (customized + hiddenViews)
    // then toggles essentials and back must keep their hidden-set — "Show
    // advanced" reveals the advanced nav, it does not undo a Settings choice.
    const hidden = prefsAt(1, { customized: true, hiddenViews: ['stats', 'cost'] });
    const collapsed = toggleAdvancedNav(hidden);
    expect(collapsed.hiddenViews).toEqual(['stats', 'cost']);
    const reExpanded = toggleAdvancedNav(collapsed);
    expect(reExpanded.customized).toBe(true);
    expect(reExpanded.hiddenViews).toEqual(['stats', 'cost']);
  });
});
