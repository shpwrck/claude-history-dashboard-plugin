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
//
// The script starts `vite preview` on --port (default 4476), waits for it,
// runs measurements, then kills the preview server and prints a summary.

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { createServer } from 'net';

const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  return idx >= 0 ? Number(process.argv[idx + 1]) : 4476;
})();
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
async function startPreview() {
  if (!(await isPortFree(PORT))) {
    console.log(`  port ${PORT} already in use — assuming a preview server is running`);
    return null;
  }
  const proc = spawn(
    'node',
    ['node_modules/.bin/vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  // Wait until the server starts (poll for up to 15 s)
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const free = await isPortFree(PORT);
    if (!free) break;
  }
  return proc;
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
  window.__churnMetrics = {
    longtasks: [],
    shifts: [],
    paintTime: null,
  };
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
`;

async function measureView(page, view) {
  // Navigate to root first so sample data is loaded (the SPA auto-loads it on mount)
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });

  // Wait for sample data to load: the app mounts and parses the corpus
  await page.waitForFunction(
    () => document.body.innerText.length > 200,
    { timeout: 10000 }
  ).catch(() => {}); // soft: if no data, still measure

  // Reset metrics before navigating to the view
  await page.evaluate(() => {
    window.__churnMetrics = { longtasks: [], shifts: [], paintTime: null };
  });

  const t0 = Date.now();

  // Navigate to the specific view (hash routing)
  await page.evaluate((hash) => { window.location.hash = hash; }, view.hash);

  // Wait for the view to settle: wait for at least one chart/table element or 2s
  await page.waitForTimeout(2000);

  const navMs = Date.now() - t0;

  // Read metrics collected so far
  const metricsBefore = await page.evaluate(() => ({
    longtasks: window.__churnMetrics.longtasks.slice(),
    shifts: window.__churnMetrics.shifts.slice(),
    paintTime: window.__churnMetrics.paintTime,
  }));

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

async function main() {
  console.log('# Render-churn measurement (issue #666)\n');
  console.log(`Target: ${BASE_URL} (SPA with sample corpus, 18 sessions)`);
  console.log('');

  const previewProc = await startPreview();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  // Inject metrics instrumentation on every new page/frame
  await page.addInitScript(INJECT_SCRIPT);

  const results = [];
  for (const view of VIEWS) {
    process.stdout.write(`  measuring ${view.name.padEnd(20)}`);
    try {
      const r = await measureView(page, view);
      results.push(r);
      console.log(`  navMs=${r.navMs} initialLT=${r.initialLongtaskCount}(${r.initialLongtaskTotalMs.toFixed(0)}ms) resizeLT=${r.resizeLongtaskCount}(${r.resizeLongtaskTotalMs.toFixed(0)}ms) CLS=${r.initialCLS.toFixed(4)}+${r.resizeCLS.toFixed(4)} raw=${r.initialRawCLS.toFixed(4)}+${r.resizeRawCLS.toFixed(4)}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      results.push({ name: view.name, error: err.message });
    }
  }

  await browser.close();
  if (previewProc) {
    previewProc.kill();
    await new Promise((r) => previewProc.on('close', r));
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
      `${r.name.padEnd(20)} | ${String(r.navMs).padStart(7)} | ${String(r.initialLongtaskCount).padStart(13)} | ${String(r.initialLongtaskTotalMs.toFixed(0)).padStart(10)} | ${String(r.resizeLongtaskCount).padStart(15)} | ${String(r.resizeLongtaskTotalMs.toFixed(0)).padStart(12)} | ${r.initialCLS.toFixed(4).padStart(9)} | ${r.resizeCLS.toFixed(4)}`
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

main().catch((err) => { console.error(err); process.exit(1); });
