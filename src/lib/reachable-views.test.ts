// Drift guard (#765): the render-smoke e2e spec drives its view list from the
// icon-free `e2e/reachable-views.ts` (the Playwright runner can't import
// nav-prefs.ts because of its extensionless PF-icon imports). This test — run
// under vitest, which resolves nav-prefs fine via Vite — asserts that hand-kept
// list stays exactly equal to the derived `NAV_ITEMS.filter(!serverOnly)`. Add,
// remove, or flag a view server-only in nav-prefs without updating the e2e list
// and this fails, so the render gate never silently stops covering a view.
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './nav-prefs';
import { REACHABLE_VIEWS } from '../../e2e/reachable-views';

describe('reachable-views (render-smoke drift guard)', () => {
  it('matches NAV_ITEMS minus server-only views, in order', () => {
    const derived = NAV_ITEMS.filter((i) => !i.serverOnly).map((i) => i.view);
    expect([...REACHABLE_VIEWS]).toEqual(derived);
  });
});
