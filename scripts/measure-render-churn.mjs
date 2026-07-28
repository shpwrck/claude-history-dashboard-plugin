#!/usr/bin/env node
// Render-churn measurement harness (issue #666).
//
// Measures layout-thrash indicators for the views that use ResizeObserver
// width-measurers and large table renders. Reports per-view:
//   - PerformanceObserver 'longtask' entries (> 50 ms JS tasks)
//   - layout-shift (CLS) events
//   - forced-reflow proxy: time-to-first-paint after navigation
//   - a synthetic resize-storm: viewport is cycled narrow→wide 5 times and the
//     total longtask duration during that window is captured.
//
// Usage:
//   npm run build:spa          # build the SPA with sample data first
//   node scripts/measure-render-churn.mjs [--port 4476]
//   node scripts/measure-render-churn.mjs --sweep [--json]   # warm-nav settle sweep (#2395)
//   node scripts/measure-render-churn.mjs --help
//
// The script starts `vite preview` on --port (default 4476), waits for it,
// runs measurements, then kills the preview server and prints a summary.
// With --json in --sweep mode, all human/progress output goes to stderr so
// stdout is pure JSON (`… --sweep --json | jq`).

import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as ts from 'typescript';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 4476;
const DEFAULT_SWEEP_TIMES = ['24h', 'all'];
const VALID_SWEEP_TIMES = new Set(['24h', '7d', '30d', 'all']);
const DEFAULT_SETTLE_IDLE_MS = 300;
const DEFAULT_SETTLE_TIMEOUT_MS = 8000;
const RECOMMENDATIONS_NOTE =
  'client render; shared /api/dataset.json fetch cost tracked in #2181';

function parseArgs(argv) {
  const opts = {
    base: null,
    port: DEFAULT_PORT,
    sweep: false,
    json: false,
    help: false,
    views: [],
    limit: null,
    times: [...DEFAULT_SWEEP_TIMES],
    settleIdleMs: DEFAULT_SETTLE_IDLE_MS,
    settleTimeoutMs: DEFAULT_SETTLE_TIMEOUT_MS,
  };

  const nextValue = (i, arg) => {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`measure-render-churn: ${arg} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') {
      opts.base = nextValue(i, arg);
      i += 1;
    } else if (arg.startsWith('--base=')) {
      opts.base = arg.slice('--base='.length);
    } else if (arg === '--port') {
      opts.port = Number.parseInt(nextValue(i, arg), 10);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      opts.port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--sweep') {
      opts.sweep = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--views') {
      opts.views = parseList(nextValue(i, arg));
      i += 1;
    } else if (arg.startsWith('--views=')) {
      opts.views = parseList(arg.slice('--views='.length));
    } else if (arg === '--limit') {
      opts.limit = Number.parseInt(nextValue(i, arg), 10);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      opts.limit = Number.parseInt(arg.slice('--limit='.length), 10);
    } else if (arg === '--times') {
      opts.times = parseTimes(nextValue(i, arg));
      i += 1;
    } else if (arg.startsWith('--times=')) {
      opts.times = parseTimes(arg.slice('--times='.length));
    } else if (arg === '--settle-idle-ms') {
      opts.settleIdleMs = Number.parseInt(nextValue(i, arg), 10);
      i += 1;
    } else if (arg.startsWith('--settle-idle-ms=')) {
      opts.settleIdleMs = Number.parseInt(arg.slice('--settle-idle-ms='.length), 10);
    } else if (arg === '--settle-timeout-ms') {
      opts.settleTimeoutMs = Number.parseInt(nextValue(i, arg), 10);
      i += 1;
    } else if (arg.startsWith('--settle-timeout-ms=')) {
      opts.settleTimeoutMs = Number.parseInt(arg.slice('--settle-timeout-ms='.length), 10);
    } else {
      throw new Error(`measure-render-churn: unknown argument ${arg}`);
    }
  }

  if (!Number.isInteger(opts.port) || opts.port <= 0) opts.port = DEFAULT_PORT;
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) opts.limit = null;
  if (!Number.isInteger(opts.settleIdleMs) || opts.settleIdleMs < 0) {
    opts.settleIdleMs = DEFAULT_SETTLE_IDLE_MS;
  }
  if (!Number.isInteger(opts.settleTimeoutMs) || opts.settleTimeoutMs < 1) {
    opts.settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS;
  }

  return opts;
}

function parseList(value) {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseTimes(value) {
  const times = parseList(value);
  const invalid = times.filter((time) => !VALID_SWEEP_TIMES.has(time));
  if (invalid.length > 0) {
    throw new Error(`measure-render-churn: invalid --times value(s): ${invalid.join(', ')}`);
  }
  return times.length > 0 ? times : [...DEFAULT_SWEEP_TIMES];
}

function normalizeBase(base) {
  return String(base).replace(/\/+$/, '');
}

// Check port is free before starting preview
async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

// Start vite preview and wait until it's accepting connections
async function startPreview(port) {
  if (!(await isPortFree(port))) {
    console.log(`  port ${port} already in use — assuming a preview server is running`);
    return null;
  }
  const proc = spawn(
    'node',
    ['node_modules/.bin/vite', 'preview', '--port', String(port), '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  // Wait until the server starts (poll for up to 15 s)
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const free = await isPortFree(port);
    if (!free) break;
  }
  return proc;
}

async function resolveTarget(opts) {
  if (opts.base) {
    return { baseUrl: normalizeBase(opts.base), previewProc: null };
  }
  const previewProc = await startPreview(opts.port);
  return { baseUrl: `http://127.0.0.1:${opts.port}`, previewProc };
}

// Views to measure: nav label -> URL hash/path.
// These are the views that own useContainerWidth calls or render large tables.
const VIEWS = [
  { name: 'Tokens',          hash: '#/tokens' },
  { name: 'Tool Usage',      hash: '#/tools' },
  { name: 'Context Health',  hash: '#/context' },
  { name: 'Agents',          hash: '#/agents' },
  { name: 'Errors',          hash: '#/errors' },
  { name: 'Cost',            hash: '#/cost' },
  { name: 'Sessions',        hash: '#/sessions' },
  { name: 'Stats',           hash: '#/stats' },
  { name: 'Conversation',    hash: '#/conversation' },
  { name: 'Activity',        hash: '#/activity' },
  { name: 'File Impact',     hash: '#/files' },
  { name: 'Patterns',        hash: '#/patterns' },
];

// Inject PerformanceObserver instrumentation before navigation so it catches
// entries from the moment the page loads.
const INJECT_SCRIPT = `
(() => {
  const g = window;
  const freshMetrics = (route = null) => {
    const now = performance.now();
    return {
      route,
      longtasks: [],
      shifts: [],
      paintTime: null,
      navStart: now,
      firstFrameAt: null,
      firstMutationAt: null,
      lastMutationAt: now,
      mutationBatches: 0,
      mutationRecords: 0,
    };
  };
  g.__churnMetrics = freshMetrics();
  g.__churnFetchState = g.__churnFetchState ?? {
    pending: 0,
    total: 0,
    completed: 0,
    failed: 0,
    generation: 0,
    lastActivityAt: performance.now(),
  };
  g.__churnMarkFirstFrame = (metrics) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (g.__churnMetrics === metrics && metrics.firstFrameAt === null) {
          metrics.firstFrameAt = performance.now();
        }
      });
    });
  };
  g.__churnResetRouteMetrics = (route = null) => {
    const fetchState = g.__churnFetchState;
    fetchState.generation += 1;
    fetchState.pending = 0;
    fetchState.total = 0;
    fetchState.completed = 0;
    fetchState.failed = 0;
    fetchState.lastActivityAt = performance.now();
    const metrics = freshMetrics(route);
    g.__churnMetrics = metrics;
    g.__churnEnsureMutationObserver?.();
    g.__churnMarkFirstFrame(metrics);
  };
  if (!g.__churnFetchWrapped && typeof g.fetch === 'function') {
    g.__churnFetchWrapped = true;
    const originalFetch = g.fetch.bind(g);
    g.fetch = (...args) => {
      const fetchState = g.__churnFetchState;
      const generation = fetchState.generation;
      fetchState.pending += 1;
      fetchState.total += 1;
      fetchState.lastActivityAt = performance.now();
      let completed = false;
      let pendingPromise;
      try {
        pendingPromise = originalFetch(...args);
      } catch (err) {
        // A synchronous throw from fetch (e.g. a bad Request) must not leak a
        // permanently-pending count that would keep the settle loop LIVE forever.
        if (fetchState.generation === generation) {
          fetchState.pending = Math.max(0, fetchState.pending - 1);
          fetchState.failed += 1;
          fetchState.lastActivityAt = performance.now();
        }
        throw err;
      }
      return pendingPromise
        .then((response) => {
          completed = true;
          return response;
        })
        .catch((err) => {
          if (fetchState.generation === generation) {
            fetchState.failed += 1;
          }
          throw err;
        })
        .finally(() => {
          if (fetchState.generation === generation) {
            fetchState.pending = Math.max(0, fetchState.pending - 1);
            if (completed) fetchState.completed += 1;
            fetchState.lastActivityAt = performance.now();
          }
        });
    };
  }
  let mutationObserver = null;
  g.__churnEnsureMutationObserver = () => {
    if (mutationObserver) return true;
    const target = document.documentElement || document.body || document;
    if (!target) return false;
    mutationObserver = new MutationObserver((records) => {
      const metrics = g.__churnMetrics;
      if (!metrics) return;
      const now = performance.now();
      if (metrics.firstMutationAt === null) metrics.firstMutationAt = now;
      metrics.lastMutationAt = now;
      metrics.mutationBatches += 1;
      metrics.mutationRecords += records.length;
    });
    mutationObserver.observe(target, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    return true;
  };
  if (!g.__churnEnsureMutationObserver()) {
    document.addEventListener('DOMContentLoaded', () => g.__churnEnsureMutationObserver(), {
      once: true,
    });
  }
  try {
    const lto = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__churnMetrics.longtasks.push({ start: e.startTime, dur: e.duration });
      }
    });
    lto.observe({ type: 'longtask', buffered: true });
  } catch (e) { /* longtask not supported */ }
  try {
    const lso = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__churnMetrics.shifts.push({
          start: e.startTime,
          value: e.value,
          hadRecentInput: e.hadRecentInput === true,
        });
      }
    });
    lso.observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* layout-shift not supported */ }
  try {
    const pto = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-contentful-paint' && window.__churnMetrics.paintTime === null) {
          window.__churnMetrics.paintTime = e.startTime;
        }
      }
    });
    pto.observe({ type: 'paint', buffered: true });
  } catch (e) { /* paint not supported */ }
})();
`;

export const LEGACY_SETTLE_MS = 2000;

/**
 * Route-render latency from the page's OWN timestamps (#3092).
 *
 * The legacy probe used to start a wall clock, force a hash navigation, sleep a
 * fixed {@link LEGACY_SETTLE_MS}, and report the elapsed wall time as `navMs` —
 * so every view reported roughly the settling delay plus harness overhead, not
 * navigation or render latency, and changing the delay changed the "metric".
 *
 * The injected instrumentation already records, in page time: `navStart` (when
 * the route metrics were reset, immediately before navigation), `lastMutationAt`
 * (the last DOM mutation the route produced) and `firstFrameAt` (the second RAF
 * after the reset). Render completion is the last mutation when the route
 * mutated the DOM, else the first painted frame.
 *
 * If neither timestamp is usable, this returns null — "we did not measure it" —
 * rather than substituting the settling delay, which is not the metric.
 */
export function deriveNavMs(timing) {
  // `Number(null)` is 0, which would silently pass a finiteness check and turn a
  // missing timestamp into a measurement — exactly the substitution this fix
  // exists to prevent.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const navStart = num(timing?.navStart);
  if (navStart === null) return null;
  const candidates = [];
  // `lastMutationAt` is seeded to navStart, so it is evidence of a render only
  // once the MutationObserver actually fired.
  if ((num(timing?.mutationBatches) ?? 0) > 0) candidates.push(num(timing.lastMutationAt));
  candidates.push(num(timing?.firstFrameAt));
  const usable = candidates.filter((t) => t !== null && t >= navStart);
  if (usable.length === 0) return null;
  return Math.max(...usable) - navStart;
}

export async function measureView(page, view, baseUrl, { settleMs = LEGACY_SETTLE_MS } = {}) {
  // Navigate to root first so sample data is loaded (the SPA auto-loads it on mount)
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Wait for sample data to load: the app mounts and parses the corpus
  await page.waitForFunction(
    () => document.body.innerText.length > 200,
    { timeout: 10000 }
  ).catch(() => {}); // soft: if no data, still measure

  // Reset metrics before navigating to the view
  await page.evaluate(() => {
    window.__churnResetRouteMetrics?.();
  });

  // Navigate to the specific view (hash routing)
  await page.evaluate((hash) => { window.location.hash = hash; }, view.hash);

  // Settling delay: gives observers time to report. It is deliberately OUTSIDE
  // the reported interval — navMs comes from the page's own timestamps below.
  await page.waitForTimeout(settleMs);

  // Read metrics collected so far
  const metricsBefore = await page.evaluate(() => ({
    longtasks: window.__churnMetrics.longtasks.slice(),
    shifts: window.__churnMetrics.shifts.slice(),
    paintTime: window.__churnMetrics.paintTime,
    navStart: window.__churnMetrics.navStart,
    firstFrameAt: window.__churnMetrics.firstFrameAt,
    firstMutationAt: window.__churnMetrics.firstMutationAt,
    lastMutationAt: window.__churnMetrics.lastMutationAt,
    mutationBatches: window.__churnMetrics.mutationBatches,
  }));

  const navMs = deriveNavMs(metricsBefore);

  // --- Synthetic resize storm ---
  // Cycle viewport narrow <-> wide 5 times to stress ResizeObserver callbacks
  await page.evaluate(() => {
    window.__churnMetrics.longtasks = [];
    window.__churnMetrics.shifts = [];
    window.__churnMetrics.resizeStart = performance.now();
  });

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  for (let i = 0; i < 5; i++) {
    await page.setViewportSize({ width: 400, height: 720 });
    await page.waitForTimeout(80);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(80);
  }
  // Let any pending microtasks / RAF settle
  await page.waitForTimeout(300);

  const metricsResize = await page.evaluate(() => ({
    longtasks: window.__churnMetrics.longtasks.slice(),
    shifts: window.__churnMetrics.shifts.slice(),
  }));

  const sumCLS = (shifts) =>
    shifts
      .filter((e) => e.hadRecentInput !== true)
      .reduce((s, e) => s + e.value, 0);
  const sumRawCLS = (shifts) => shifts.reduce((s, e) => s + e.value, 0);

  return {
    name: view.name,
    navMs,
    initialLongtaskCount: metricsBefore.longtasks.length,
    initialLongtaskTotalMs: metricsBefore.longtasks.reduce((s, e) => s + e.dur, 0),
    initialCLS: sumCLS(metricsBefore.shifts),
    initialRawCLS: sumRawCLS(metricsBefore.shifts),
    resizeLongtaskCount: metricsResize.longtasks.length,
    resizeLongtaskTotalMs: metricsResize.longtasks.reduce((s, e) => s + e.dur, 0),
    resizeCLS: sumCLS(metricsResize.shifts),
    resizeRawCLS: sumRawCLS(metricsResize.shifts),
  };
}

function unwrapExpression(expr) {
  let current = expr;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function stringProperty(obj, propName) {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (propertyNameText(prop.name) !== propName) continue;
    const value = unwrapExpression(prop.initializer);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return value.text;
    }
  }
  return null;
}

export function extractRouteCatalog() {
  const navPrefsPath = join(PROJECT_DIR, 'src/lib/nav-prefs.ts');
  const sourceText = readFileSync(navPrefsPath, 'utf8');
  const source = ts.createSourceFile(
    navPrefsPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const wanted = new Map([
    ['NAV_ITEMS', 'sidebar'],
    ['ABSORBED_VIEW_ITEMS', 'absorbed'],
  ]);
  const routes = [];
  // Track how many routes each source array yielded so a silent coverage cap
  // (a shape change in nav-prefs.ts that drops entries) is surfaced loudly
  // rather than shrinking the sweep without a trace — per repo convention.
  const perSource = new Map();
  for (const kind of wanted.values()) perSource.set(kind, 0);

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const arrayName = node.name.text;
      const sourceKind = wanted.get(arrayName);
      if (sourceKind && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isArrayLiteralExpression(initializer)) {
          for (const element of initializer.elements) {
            const object = unwrapExpression(element);
            if (!ts.isObjectLiteralExpression(object)) {
              console.warn(
                `measure-render-churn: skipping non-object-literal element in ${arrayName} ` +
                  `(SyntaxKind ${ts.SyntaxKind[element.kind]}) — route not measured`
              );
              continue;
            }
            const view = stringProperty(object, 'view');
            if (!view) {
              console.warn(
                `measure-render-churn: skipping ${arrayName} entry with a non-string-literal ` +
                  `'view' property — route not measured`
              );
              continue;
            }
            const label = stringProperty(object, 'label') ?? view;
            routes.push({
              view,
              label,
              name: label,
              hash: `#/${view}`,
              source: sourceKind,
              requires: stringProperty(object, 'requires') ?? 'always',
            });
            perSource.set(sourceKind, perSource.get(sourceKind) + 1);
          }
        } else {
          console.warn(
            `measure-render-churn: ${arrayName} initializer is not an array literal — ` +
              `route coverage from this source is 0`
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);

  // Fail loudly when either source array resolved empty: the sweep would
  // otherwise run on a partial catalog with no indication it lost coverage.
  for (const [arrayName, kind] of wanted) {
    if (perSource.get(kind) === 0) {
      console.warn(
        `\n!! measure-render-churn: route-coverage cap — ${arrayName} resolved to 0 routes. ` +
          `nav-prefs.ts may have changed shape; the sweep catalog is INCOMPLETE.\n`
      );
    }
  }
  return routes;
}

function selectSweepRoutes(opts) {
  let routes = extractRouteCatalog();
  if (opts.views.length > 0) {
    const wanted = new Set(opts.views.map((v) => v.toLowerCase()));
    routes = routes.filter(
      (route) =>
        wanted.has(route.view.toLowerCase()) ||
        wanted.has(route.label.toLowerCase()) ||
        wanted.has(route.name.toLowerCase())
    );
  }
  if (opts.limit !== null) {
    routes = routes.slice(0, opts.limit);
  }
  return routes;
}

function sumCLS(shifts) {
  return shifts
    .filter((e) => e.hadRecentInput !== true)
    .reduce((s, e) => s + e.value, 0);
}

function sumRawCLS(shifts) {
  return shifts.reduce((s, e) => s + e.value, 0);
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function formatMs(value) {
  return value === null || value === undefined ? 'n/a' : String(Math.round(value));
}

function routeHash(view, time) {
  const params = new URLSearchParams({ time });
  return `#/${view}?${params.toString()}`;
}

// Extract the view slug from a `#/<view>?params` hash. Used to detect when the
// app redirected our target route to a different view (e.g. a `liveServer` view
// funnelled to `home` on a target without the live backend).
function viewFromHash(hash) {
  if (typeof hash !== 'string') return null;
  const match = /^#\/?([^?/]+)/.exec(hash);
  return match ? match[1] : null;
}

const DEFAULT_LANDING_VIEW = 'home';

async function warmApp(page, baseUrl) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page
    .waitForFunction(() => document.body.innerText.length > 200, { timeout: 10000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

async function readRouteMetrics(page) {
  return page.evaluate(() => {
    const metrics = window.__churnMetrics ?? {};
    const fetchState = window.__churnFetchState ?? {};
    return {
      now: performance.now(),
      route: metrics.route ?? null,
      navStart: metrics.navStart ?? performance.now(),
      firstFrameAt: metrics.firstFrameAt ?? null,
      firstMutationAt: metrics.firstMutationAt ?? null,
      lastMutationAt: metrics.lastMutationAt ?? metrics.navStart ?? performance.now(),
      mutationBatches: metrics.mutationBatches ?? 0,
      mutationRecords: metrics.mutationRecords ?? 0,
      longtasks: Array.isArray(metrics.longtasks) ? metrics.longtasks.slice() : [],
      shifts: Array.isArray(metrics.shifts) ? metrics.shifts.slice() : [],
      fetchPending: fetchState.pending ?? 0,
      fetchTotal: fetchState.total ?? 0,
      fetchCompleted: fetchState.completed ?? 0,
      fetchFailed: fetchState.failed ?? 0,
      fetchLastActivityAt: fetchState.lastActivityAt ?? metrics.navStart ?? performance.now(),
      locationHash: window.location.hash,
    };
  });
}

async function waitForWarmNavSettle(page, opts) {
  const deadline = Date.now() + opts.settleTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readRouteMetrics(page);
    const lastActivityAt = Math.max(last.lastMutationAt, last.fetchLastActivityAt);
    const domAndFetchIdleMs = last.now - lastActivityAt;
    if (last.fetchPending === 0 && domAndFetchIdleMs >= opts.settleIdleMs) {
      return { settled: true, snapshot: last };
    }
    await page.waitForTimeout(50);
  }
  return { settled: false, snapshot: last ?? (await readRouteMetrics(page)) };
}

async function measureSweepRoute(page, route, time, opts, targetHasLiveServer) {
  const hash = routeHash(route.view, time);

  // Deterministic redirect skip: a `liveServer` view has no live backend on the
  // default preview/SPA target, so App.navigateTo funnels it to `home`. Because
  // a warm sweep already sits on `home`, that redirect is a home->home no-op:
  // `currentView` never changes, the hash-sync effect never fires, and the hash
  // keeps *lying* (`#/provisioning`) while the view is actually `home`. So we
  // can't trust a post-nav hash check here — we skip the navigation entirely and
  // stamp the row REDIRECTED rather than record a bogus `home` render under the
  // route's name. (An explicit --base target may be a real server, so we only
  // apply this to the default target; see the runtime fallback below.)
  if (route.requires === 'liveServer' && !targetHasLiveServer) {
    return {
      name: route.name,
      view: route.view,
      source: route.source,
      requires: route.requires,
      time,
      hash,
      firstPaintMs: null,
      settleMs: null,
      fetchCount: 0,
      fetchCompleted: 0,
      fetchFailed: 0,
      pendingFetchesAtEnd: 0,
      secondCommitCount: 0,
      mutationBatches: 0,
      mutationRecords: 0,
      initialLongtaskCount: 0,
      initialLongtaskTotalMs: 0,
      initialCLS: 0,
      initialRawCLS: 0,
      status: 'REDIRECTED',
      live: false,
      redirected: true,
      settledView: DEFAULT_LANDING_VIEW,
      locationHash: null,
      note: `not measured — requires '${route.requires}'; target has no live backend (redirects to ${DEFAULT_LANDING_VIEW})`,
    };
  }

  await page.evaluate((nextHash) => {
    window.__churnResetRouteMetrics?.(nextHash);
    window.location.hash = nextHash;
  }, hash);

  const settled = await waitForWarmNavSettle(page, opts);
  const m = settled.snapshot;
  const firstPaintAt = m.firstMutationAt ?? m.firstFrameAt;
  const firstPaintMs = firstPaintAt === null ? null : round1(firstPaintAt - m.navStart);
  // Report settle from the TRUE settle instant (last DOM mutation / last fetch
  // activity), not `now`. Measuring at `now` inflates every row by the idle
  // window plus poll quantization and makes the number config-dependent; the
  // idle window stays purely the detection criterion in waitForWarmNavSettle.
  const settleInstant = Math.max(m.lastMutationAt, m.fetchLastActivityAt);
  const settleMs = round1(settleInstant - m.navStart);
  const initialCLS = sumCLS(m.shifts);
  const initialRawCLS = sumRawCLS(m.shifts);

  // Runtime redirect fallback (best-effort, for --base targets): if the app
  // corrected the hash to `home` for a non-home route, it redirected the view.
  // This only fires when `currentView` actually changed (so the hash-sync effect
  // ran) — e.g. navigating from a rendered view to an unavailable one; a warm
  // home->home redirect leaves the hash uncorrected and is caught by the
  // deterministic liveServer skip above instead. Absorbed views legitimately
  // land on their composite parent (capabilities/automation), not `home`, so
  // they are not flagged here.
  const settledView = viewFromHash(m.locationHash);
  const redirected =
    route.view !== DEFAULT_LANDING_VIEW && settledView === DEFAULT_LANDING_VIEW;
  const redirectNote = redirected
    ? `redirected to ${DEFAULT_LANDING_VIEW} (requires '${route.requires}'; target lacks capability)`
    : '';
  const note =
    redirectNote || (route.view === 'recommendations' ? RECOMMENDATIONS_NOTE : '');

  return {
    name: route.name,
    view: route.view,
    source: route.source,
    requires: route.requires,
    time,
    hash,
    firstPaintMs,
    settleMs,
    fetchCount: m.fetchTotal,
    fetchCompleted: m.fetchCompleted,
    fetchFailed: m.fetchFailed,
    pendingFetchesAtEnd: m.fetchPending,
    secondCommitCount: Math.max(0, m.mutationBatches - 1),
    mutationBatches: m.mutationBatches,
    mutationRecords: m.mutationRecords,
    initialLongtaskCount: m.longtasks.length,
    initialLongtaskTotalMs: round1(m.longtasks.reduce((s, e) => s + e.dur, 0)),
    initialCLS,
    initialRawCLS,
    status: redirected ? 'REDIRECTED' : settled.settled ? 'settled' : 'LIVE',
    live: redirected ? false : !settled.settled,
    redirected,
    settledView,
    locationHash: m.locationHash,
    note,
    ...(!redirected && route.view === 'recommendations'
      ? {
          fetchVsRender:
            'Recommendations are computed client-side; the shared dataset fetch cost is tracked by #2181.',
        }
      : {}),
  };
}

function printSweepTable(results, times, say = (line = '') => console.log(line)) {
  say('\n## Warm Navigation Settle Sweep\n');
  for (const time of times) {
    const rows = results.filter((r) => r.time === time);
    say(`### time=${time}\n`);
    say(
      'Route                | first-paint | settle | fetches | 2nd commits | status  | note'
    );
    say(
      '---------------------|-------------|--------|---------|-------------|---------|-----'
    );
    for (const r of rows) {
      // ERROR rows carry no metric fields; default them so the table never
      // prints a literal `undefined` cell.
      const fetches = r.fetchCount ?? 'n/a';
      const secondCommits = r.secondCommitCount ?? 'n/a';
      const note = r.note ?? '';
      say(
        `${r.name.padEnd(20)} | ${formatMs(r.firstPaintMs).padStart(11)} | ${formatMs(
          r.settleMs
        ).padStart(6)} | ${String(fetches).padStart(7)} | ${String(
          secondCommits
        ).padStart(11)} | ${r.status.padEnd(7)} | ${note}`
      );
    }
    say('');
  }
}

async function runSweep(page, baseUrl, opts) {
  // With --json, stdout must be pure JSON (so `... --json | jq` works), so route
  // every progress/log/table line to stderr and reserve stdout for the JSON.
  const logStream = opts.json ? process.stderr : process.stdout;
  const say = (line = '') => logStream.write(`${line}\n`);
  const sayInline = (chunk) => logStream.write(chunk);

  const routes = selectSweepRoutes(opts);
  if (routes.length === 0) {
    throw new Error('measure-render-churn: no routes selected for sweep');
  }

  // The default target is a static `vite preview` with no live backend, so
  // `liveServer` views there always redirect to `home` and can't be measured.
  // An explicit --base may point at a real server, so trust it and fall back to
  // the runtime redirect check for those.
  const targetHasLiveServer = opts.base != null;
  const liveServerRoutes = routes.filter((r) => r.requires === 'liveServer');
  if (!targetHasLiveServer && liveServerRoutes.length > 0) {
    say(
      `Note: ${liveServerRoutes.length} liveServer route(s) (${liveServerRoutes
        .map((r) => r.view)
        .join(', ')}) will be reported REDIRECTED — the default target has no live backend. Use --base <live-server-url> to measure them.`
    );
  }

  say('# Render-churn warm-navigation settle sweep (issue #2395)\n');
  say(`Target: ${baseUrl}`);
  say(
    `Routes: ${routes.length} (${routes.filter((r) => r.source === 'sidebar').length} sidebar, ${routes.filter((r) => r.source === 'absorbed').length} absorbed)`
  );
  say(`Time filters: ${opts.times.join(', ')}`);
  say(`Settle: pending fetches == 0 and DOM/fetch idle >= ${opts.settleIdleMs}ms`);
  say(`Timeout: ${opts.settleTimeoutMs}ms -> status LIVE\n`);

  await warmApp(page, baseUrl);

  const results = [];
  for (const time of opts.times) {
    for (const route of routes) {
      sayInline(`  ${time.padEnd(4)} ${route.name.padEnd(22)}`);
      try {
        const r = await measureSweepRoute(page, route, time, opts, targetHasLiveServer);
        results.push(r);
        say(
          ` first=${formatMs(r.firstPaintMs)}ms settle=${formatMs(r.settleMs)}ms fetches=${r.fetchCount} second=${r.secondCommitCount} ${r.status}`
        );
      } catch (err) {
        const result = {
          name: route.name,
          view: route.view,
          source: route.source,
          requires: route.requires,
          time,
          hash: routeHash(route.view, time),
          error: err.message,
          status: 'ERROR',
          live: true,
          // Default the metric fields so the summary table never prints
          // `undefined` for an ERROR row.
          firstPaintMs: null,
          settleMs: null,
          fetchCount: 'n/a',
          secondCommitCount: 'n/a',
          note: '',
        };
        results.push(result);
        say(` ERROR: ${err.message}`);
      }
    }
  }

  printSweepTable(results, opts.times, say);

  const out = {
    mode: 'warm-nav-settle-sweep',
    base: baseUrl,
    generatedAt: new Date().toISOString(),
    settle: {
      idleMs: opts.settleIdleMs,
      timeoutMs: opts.settleTimeoutMs,
      timeoutStatus: 'LIVE',
    },
    routes: routes.map(({ view, label, source, requires }) => ({
      view,
      label,
      source,
      requires,
    })),
    times: opts.times,
    annotations: {
      recommendations: RECOMMENDATIONS_NOTE,
    },
    results,
  };

  if (opts.json) {
    // Pure JSON on stdout — all human output above went to stderr.
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  }

  return out;
}

// navMs is null when the page reported no render-completion timestamp: say so
// rather than printing a number that was never measured.
function fmtNavMs(navMs) {
  return navMs === null || navMs === undefined ? 'unknown' : String(Math.round(navMs));
}

async function runLegacy(page, baseUrl) {
  console.log('# Render-churn measurement (issue #666)\n');
  console.log(`Target: ${baseUrl} (SPA with sample corpus, 18 sessions)`);
  console.log('');

  const results = [];
  for (const view of VIEWS) {
    process.stdout.write(`  measuring ${view.name.padEnd(20)}`);
    try {
      const r = await measureView(page, view, baseUrl);
      results.push(r);
      console.log(`  navMs=${fmtNavMs(r.navMs)} initialLT=${r.initialLongtaskCount}(${r.initialLongtaskTotalMs.toFixed(0)}ms) resizeLT=${r.resizeLongtaskCount}(${r.resizeLongtaskTotalMs.toFixed(0)}ms) CLS=${r.initialCLS.toFixed(4)}+${r.resizeCLS.toFixed(4)} raw=${r.initialRawCLS.toFixed(4)}+${r.resizeRawCLS.toFixed(4)}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      results.push({ name: view.name, error: err.message });
    }
  }

  // --- Summary table ---
  console.log('\n## Summary\n');
  console.log('View                 | nav(ms) | init LT tasks | init LT ms | resize LT tasks | resize LT ms | init CLS  | resize CLS');
  console.log('---------------------|---------|---------------|------------|-----------------|--------------|-----------|----------');
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(20)} | ERROR: ${r.error}`);
      continue;
    }
    console.log(
      `${r.name.padEnd(20)} | ${fmtNavMs(r.navMs).padStart(7)} | ${String(r.initialLongtaskCount).padStart(13)} | ${String(r.initialLongtaskTotalMs.toFixed(0)).padStart(10)} | ${String(r.resizeLongtaskCount).padStart(15)} | ${String(r.resizeLongtaskTotalMs.toFixed(0)).padStart(12)} | ${r.initialCLS.toFixed(4).padStart(9)} | ${r.resizeCLS.toFixed(4)}`
    );
  }

  // --- Verdict ---
  const maxResizeLT = Math.max(...results.filter(r => !r.error).map(r => r.resizeLongtaskTotalMs));
  const maxInitLT = Math.max(...results.filter(r => !r.error).map(r => r.initialLongtaskTotalMs));
  const totalResizeCLS = results.filter(r => !r.error).reduce((s, r) => s + r.resizeCLS, 0);
  const totalRawResizeCLS = results.filter(r => !r.error).reduce((s, r) => s + r.resizeRawCLS, 0);
  const resizeClsBudgetExceeded = totalResizeCLS > 1;
  const longtaskBudgetExceeded = maxResizeLT > 200 || maxInitLT > 500;

  console.log('\n## Verdict\n');
  console.log(`Max single-view resize-storm longtask total: ${maxResizeLT.toFixed(0)} ms`);
  console.log(`Max single-view initial-render longtask total: ${maxInitLT.toFixed(0)} ms`);
  console.log(`Cumulative resize-storm CLS across all views: ${totalResizeCLS.toFixed(4)}`);
  console.log(`Cumulative raw resize-storm layout shift: ${totalRawResizeCLS.toFixed(4)}`);
  if (resizeClsBudgetExceeded) {
    console.log('\n=> MEASURABLE resize layout shift detected (see finding doc for budget).');
  } else if (longtaskBudgetExceeded) {
    console.log('\n=> Resize CLS is stable; longtask budget is still exceeded on this dataset.');
  } else {
    console.log('\n=> Layout thrash is NOT measurable at a budget-worthy level on this dataset.');
  }

  // Emit machine-readable JSON for the finding doc
  const out = {
    dataset: '18-session sample corpus (build-corpus.mjs seed 0x5eed1234)',
    timestamp: new Date().toISOString(),
    results,
    summary: {
      maxResizeLTMs: maxResizeLT,
      maxInitLTMs: maxInitLT,
      totalResizeCLS,
      totalRawResizeCLS,
    },
  };
  process.stdout.write('\n');
  console.log('## JSON\n');
  console.log(JSON.stringify(out, null, 2));
}

// Tear down a spawned `vite preview` without hanging. Skipping the close-wait
// when the child already exited (exitCode !== null) avoids waiting forever for
// a 'close' event that will never fire, and the timeout races a slow shutdown.
async function stopPreview(previewProc) {
  if (!previewProc) return;
  if (previewProc.exitCode !== null || previewProc.signalCode !== null) return;
  previewProc.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    previewProc.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function printHelp() {
  console.log(`measure-render-churn — render-churn / warm-nav-settle measurement harness

Usage:
  npm run build:spa
  node scripts/measure-render-churn.mjs [options]

Options:
  --base <url>            Measure an already-running target instead of spawning
                         'vite preview' (e.g. a live server).
  --port <n>             Preview port when spawning (default ${DEFAULT_PORT}).
  --sweep                Run the warm-navigation settle sweep (issue #2395)
                         instead of the legacy resize-storm run (issue #666).
  --views <a,b,...>      Restrict the sweep to these view ids/labels.
  --limit <n>            Cap the number of swept routes.
  --times <a,b,...>      Time filters to sweep (default ${DEFAULT_SWEEP_TIMES.join(',')};
                         valid: ${[...VALID_SWEEP_TIMES].join(', ')}).
  --settle-idle-ms <n>   DOM/fetch idle window that counts as settled
                         (default ${DEFAULT_SETTLE_IDLE_MS}).
  --settle-timeout-ms <n> Max wait before a route is reported LIVE
                         (default ${DEFAULT_SETTLE_TIMEOUT_MS}).
  --json                 Emit machine-readable JSON. In --sweep mode all
                         human/progress output is routed to stderr so stdout is
                         PURE JSON (safe to pipe into jq).
  --help, -h             Show this help.

Notes:
  Routes whose required capability the target lacks (e.g. 'liveServer' views on
  the default SPA/preview target) are reported with status REDIRECTED because
  the app funnels them to 'home'; their metrics do not reflect the named route.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  // Declare handles up front so the finally block can tear down whatever got
  // created, even if setup (resolveTarget → spawns preview, browser launch,
  // context/page/addInitScript) throws partway through. Leaking the preview
  // server here is what makes the next run silently measure a stale bundle via
  // the "port already in use" path.
  let previewProc = null;
  let browser = null;
  try {
    const target = await resolveTarget(opts);
    previewProc = target.previewProc;
    const { baseUrl } = target;

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    // Inject metrics instrumentation on every new page/frame
    await page.addInitScript(INJECT_SCRIPT);

    if (opts.sweep) {
      await runSweep(page, baseUrl, opts);
    } else {
      await runLegacy(page, baseUrl);
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await stopPreview(previewProc);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
