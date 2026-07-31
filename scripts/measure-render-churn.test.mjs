// Unit tests for the network-free route-catalog extraction in
// measure-render-churn.mjs (#2395), plus the end-to-end refusal contract for
// unverified targets (#3396). The measurement path itself needs a live
// preview server + a headless browser and is run on demand (see the script
// header); the parser tests pin the pure `extractRouteCatalog()` shape, and
// the refusal test proves an occupied-by-something-else port exits nonzero
// BEFORE any measurement starts. Run:
//   node --test scripts/measure-render-churn.test.mjs
//   (npm run test:render-churn)

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

import {
  extractRouteCatalog,
  deriveNavMs,
  measureView,
  LEGACY_SETTLE_MS,
} from './measure-render-churn.mjs';

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

// ---------------------------------------------------------------------------
// #3092: the legacy probe's `navMs`.
//
// It used to be `Date.now()` around a hash navigation plus an unconditional
// 2,000 ms settling sleep, so every view reported ~2,000 ms regardless of how
// fast it rendered — the reported metric WAS the delay. navMs now comes from
// the page's own instrumentation timestamps, and the settling delay sits
// outside the reported interval.
// ---------------------------------------------------------------------------

test('deriveNavMs: uses the page render-completion timestamp, not wall time', () => {
  assert.equal(
    deriveNavMs({ navStart: 1000, firstFrameAt: 1120, lastMutationAt: 1420, mutationBatches: 3 }),
    420
  );
  // No mutations: the first painted frame is the completion signal.
  assert.equal(
    deriveNavMs({ navStart: 1000, firstFrameAt: 1080, lastMutationAt: 1000, mutationBatches: 0 }),
    80
  );
});

test('deriveNavMs: reports unknown (null) rather than substituting a plausible value', () => {
  assert.equal(deriveNavMs({ navStart: 1000, firstFrameAt: null, mutationBatches: 0 }), null);
  assert.equal(deriveNavMs({ navStart: null, firstFrameAt: 1200, mutationBatches: 0 }), null);
  assert.equal(deriveNavMs(undefined), null);
  // A timestamp from before the reset is not this route's render.
  assert.equal(deriveNavMs({ navStart: 1000, firstFrameAt: 900, mutationBatches: 0 }), null);
});

/**
 * A deterministic in-process stand-in for a Playwright page. `evaluate` runs the
 * real callbacks against a fake window, and `waitForTimeout` advances a virtual
 * clock — so a render instrumented at `renderAtMs` after the route reset is
 * observable without a browser.
 */
function fakePage(renderAtMs) {
  let clock = 10_000;
  const metrics = {
    longtasks: [],
    shifts: [],
    paintTime: null,
    navStart: clock,
    firstFrameAt: null,
    firstMutationAt: null,
    lastMutationAt: clock,
    mutationBatches: 0,
    mutationRecords: 0,
  };
  const win = {
    __churnMetrics: metrics,
    __churnResetRouteMetrics: () => {
      Object.assign(metrics, {
        longtasks: [],
        shifts: [],
        paintTime: null,
        navStart: clock,
        firstFrameAt: null,
        firstMutationAt: null,
        lastMutationAt: clock,
        mutationBatches: 0,
        mutationRecords: 0,
      });
    },
    location: {
      set hash(_value) {
        // The route render completes renderAtMs after the reset.
        metrics.firstFrameAt = metrics.navStart + Math.min(16, renderAtMs);
        metrics.firstMutationAt = metrics.navStart + Math.min(8, renderAtMs);
        metrics.lastMutationAt = metrics.navStart + renderAtMs;
        metrics.mutationBatches = 2;
      },
    },
  };
  const document = { body: { innerText: 'x'.repeat(500) } };
  return {
    calls: { settleWaits: [] },
    async goto() {},
    async waitForFunction() {},
    async waitForTimeout(ms) {
      // Real sleep AND virtual-clock advance: a wall-clock timer around the
      // navigation would observe this delay, which is precisely the bug.
      await new Promise((r) => setTimeout(r, ms));
      clock += ms;
      this.calls.settleWaits.push(ms);
    },
    async setViewportSize() {},
    viewportSize: () => ({ width: 1280, height: 720 }),
    async evaluate(fn, arg) {
      const prevWindow = globalThis.window;
      const prevDocument = globalThis.document;
      globalThis.window = win;
      globalThis.document = document;
      try {
        return await fn(arg);
      } finally {
        globalThis.window = prevWindow;
        globalThis.document = prevDocument;
      }
    },
  };
}

const VIEW = { name: 'Tokens', hash: '#/tokens' };

test('measureView: navMs tracks the instrumented render, not the settling delay', async () => {
  const page = fakePage(420);
  const r = await measureView(page, VIEW, 'http://127.0.0.1:4476', { settleMs: 200 });
  assert.equal(r.navMs, 420, 'navMs must be the instrumented render latency');
  assert.equal(page.calls.settleWaits[0], 200, 'the settle delay really elapsed');
});

test('measureView: changing the settling delay does not change navMs', async () => {
  const long = fakePage(420);
  const short = fakePage(420);
  const withLong = await measureView(long, VIEW, 'http://127.0.0.1:4476', { settleMs: 200 });
  const withShort = await measureView(short, VIEW, 'http://127.0.0.1:4476', { settleMs: 40 });
  assert.equal(withLong.navMs, withShort.navMs);
  assert.equal(withLong.navMs, 420);
  // Sanity: the two runs really did settle for different durations.
  assert.equal(long.calls.settleWaits[0], 200);
  assert.equal(short.calls.settleWaits[0], 40);
});

test('the legacy settling delay is still the documented 2s default', () => {
  assert.equal(LEGACY_SETTLE_MS, 2000);
});

// The end-to-end contract (#3396, mirroring #3091/#3394 in
// measure-isolated-views): an unrelated server on the requested port must make
// the script exit nonzero BEFORE any measurement starts — occupancy is not
// identity.
test('the script exits nonzero when an unrelated server occupies the port', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('unrelated static server');
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['scripts/measure-render-churn.mjs', '--port', String(port)],
        { cwd: PROJECT_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.notEqual(
      result.code,
      0,
      `expected a nonzero exit, got ${result.code}\n${result.stdout}`
    );
    assert.match(result.stderr, /refusing to measure port/);
    // Nothing was measured, so no target/measurement output may exist.
    assert.equal(
      /Target:|# Render-churn/.test(result.stdout),
      false,
      `measurements ran against an unverified responder:\n${result.stdout}`
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
