// Unit tests for the network-free route-catalog extraction in
// measure-render-churn.mjs (#2395). The measurement path itself needs a live
// preview server + a headless browser and is run on demand (see the script
// header); these tests pin only the pure `extractRouteCatalog()` parser, so a
// silent coverage regression (a nav-prefs.ts shape change that drops routes)
// fails here instead of shrinking the sweep unnoticed. Run:
//   node --test scripts/measure-render-churn.test.mjs
//   (npm run test:render-churn)

import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRouteCatalog } from './measure-render-churn.mjs';

test('extractRouteCatalog: yields a non-trivial catalog from both sources', () => {
  const routes = extractRouteCatalog();
  // The real nav-prefs.ts has far more than this; the floor guards against a
  // parser/shape regression collapsing coverage.
  assert.ok(routes.length >= 20, `expected >= 20 routes, got ${routes.length}`);

  const sidebar = routes.filter((r) => r.source === 'sidebar');
  const absorbed = routes.filter((r) => r.source === 'absorbed');
  assert.ok(sidebar.length > 0, 'NAV_ITEMS (sidebar) resolved empty');
  assert.ok(absorbed.length > 0, 'ABSORBED_VIEW_ITEMS (absorbed) resolved empty');
});

test('extractRouteCatalog: includes the capabilities composite and an absorbed id', () => {
  const routes = extractRouteCatalog();
  const byView = new Map(routes.map((r) => [r.view, r]));

  // `capabilities` is a NAV_ITEMS composite-tab destination.
  assert.ok(byView.has('capabilities'), "catalog missing 'capabilities'");
  // `tools` is an absorbed view (folded into the capabilities tab group).
  const tools = byView.get('tools');
  assert.ok(tools, "catalog missing absorbed view 'tools'");
  assert.equal(tools.source, 'absorbed');
});

test('extractRouteCatalog: every route carries the fields the sweep reads', () => {
  const routes = extractRouteCatalog();
  for (const r of routes) {
    assert.equal(typeof r.view, 'string');
    assert.equal(r.hash, `#/${r.view}`);
    assert.ok(r.source === 'sidebar' || r.source === 'absorbed');
    assert.equal(typeof r.requires, 'string'); // 'always' when unspecified
  }
});

test('extractRouteCatalog: liveServer routes are tagged so the sweep can flag redirects', () => {
  const routes = extractRouteCatalog();
  const liveServer = routes.filter((r) => r.requires === 'liveServer');
  // These are the views that redirect to `home` on a target without a live
  // backend — the sweep marks such rows REDIRECTED rather than trusting them.
  assert.ok(liveServer.length > 0, 'expected at least one liveServer route');
});
