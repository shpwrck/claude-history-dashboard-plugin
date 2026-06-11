// Isolated per-view render churn measurements (issue #666).
// Each view gets a fresh browser context to avoid cumulative PerformanceObserver bleed.
// Usage: node scripts/measure-isolated-views.mjs [--port 4477]
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { createServer } from 'net';

const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  return idx >= 0 ? Number(process.argv[idx + 1]) : 4477;
})();

async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function startPreview() {
  if (!(await isPortFree(PORT))) {
    process.stderr.write(`port ${PORT} in use, assuming server running\n`);
    return null;
  }
  const proc = spawn('node', ['node_modules/.bin/vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!(await isPortFree(PORT))) break;
  }
  return proc;
}

const INJECT = `
  window.__m = { lt: [], cls: [] };
  try {
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__m.lt.push({start: e.startTime, dur: e.duration}))).observe({type:'longtask', buffered:false});
  } catch(e) {}
  try {
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__m.cls.push(e.value))).observe({type:'layout-shift', buffered:false});
  } catch(e) {}
`;

async function measureViewIsolated(hash, runs = 3) {
  const browser = await chromium.launch({ headless: true });
  const allRuns = [];
  for (let run = 0; run < runs; run++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.addInitScript(INJECT);

    const t0 = performance.now();
    await page.goto(`http://127.0.0.1:${PORT}/${hash}`, { waitUntil: 'networkidle', timeout: 15000 });
    const navDoneMs = performance.now() - t0;

    // Wait for charts to render + ResizeObserver callbacks to fire
    await page.waitForTimeout(1500);

    const loadMetrics = await page.evaluate(() => {
      const lt = window.__m.lt.map(e => ({ dur: e.dur }));
      const cls = window.__m.cls.reduce((s, v) => s + v, 0);
      window.__m.lt = []; window.__m.cls = [];
      return { lt, cls };
    });

    // Resize storm: 5 narrow<->wide cycles
    for (let i = 0; i < 5; i++) {
      await page.setViewportSize({ width: 400, height: 720 });
      await page.waitForTimeout(80);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(300);

    const resizeMetrics = await page.evaluate(() => {
      const lt = window.__m.lt.map(e => ({ dur: e.dur }));
      const cls = window.__m.cls.reduce((s, v) => s + v, 0);
      return { lt, cls };
    });

    allRuns.push({
      navDoneMs,
      loadLTCount: loadMetrics.lt.length,
      loadLTTotalMs: loadMetrics.lt.reduce((s, e) => s + e.dur, 0),
      loadLTDurs: loadMetrics.lt.map(e => e.dur.toFixed(0)),
      loadCLS: loadMetrics.cls,
      resizeLTCount: resizeMetrics.lt.length,
      resizeLTTotalMs: resizeMetrics.lt.reduce((s, e) => s + e.dur, 0),
      resizeLTDurs: resizeMetrics.lt.map(e => e.dur.toFixed(0)),
      resizeCLS: resizeMetrics.cls,
    });
    await ctx.close();
  }
  await browser.close();

  // Compute medians
  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
  return {
    median: {
      loadLTTotalMs: median(allRuns.map(r => r.loadLTTotalMs)),
      loadLTCount: median(allRuns.map(r => r.loadLTCount)),
      resizeLTTotalMs: median(allRuns.map(r => r.resizeLTTotalMs)),
      resizeLTCount: median(allRuns.map(r => r.resizeLTCount)),
      navDoneMs: median(allRuns.map(r => r.navDoneMs)),
    },
    runs: allRuns,
  };
}

// The highest-priority views: those with multiple useContainerWidth calls
// or large table renders
const VIEWS_TO_MEASURE = [
  { name: 'Tokens (3x useContainerWidth, chart-heavy)',       hash: '#/tokens' },
  { name: 'Tool Usage (2x useContainerWidth)',                hash: '#/tool-usage' },
  { name: 'Context Health (2x useContainerWidth + large)',    hash: '#/context-health' },
  { name: 'Sessions (large table, no charts)',                hash: '#/sessions' },
  { name: 'Patterns (1x useContainerWidth + histograms)',     hash: '#/conversation' },
  { name: 'Agents (1x useContainerWidth)',                    hash: '#/agents' },
  { name: 'Errors (1x useContainerWidth)',                    hash: '#/errors' },
  { name: 'File Impact (2x useContainerWidth)',               hash: '#/file-impact' },
];

const proc = await startPreview();

console.log('# Isolated render-churn measurements (issue #666)');
console.log(`# SPA with 18-session sample corpus, 3 runs per view, medians reported`);
console.log(`# Port: ${PORT}\n`);

const summary = [];
for (const v of VIEWS_TO_MEASURE) {
  process.stdout.write(`Measuring: ${v.name}...\n`);
  const r = await measureViewIsolated(v.hash, 3);
  summary.push({ ...v, ...r.median });
  console.log(`  runs: ${r.runs.map(run => `load=${run.loadLTTotalMs.toFixed(0)}ms(${run.loadLTCount}lt) resize=${run.resizeLTTotalMs.toFixed(0)}ms(${run.resizeLTCount}lt)`).join(' | ')}`);
  console.log(`  MEDIAN: load=${r.median.loadLTTotalMs.toFixed(0)}ms(${r.median.loadLTCount}lt) resize=${r.median.resizeLTTotalMs.toFixed(0)}ms(${r.median.resizeLTCount}lt) nav=${r.median.navDoneMs.toFixed(0)}ms\n`);
}

console.log('\n## Final summary table\n');
console.log('View                                           | nav(ms) | load LT total | load LT count | resize LT total | resize LT count');
console.log('-----------------------------------------------|---------|---------------|---------------|-----------------|----------------');
for (const r of summary) {
  console.log(`${r.name.padEnd(46)} | ${String(r.navDoneMs.toFixed(0)).padStart(7)} | ${String(r.loadLTTotalMs.toFixed(0)).padStart(13)} | ${String(r.loadLTCount).padStart(13)} | ${String(r.resizeLTTotalMs.toFixed(0)).padStart(15)} | ${r.resizeLTCount}`);
}

if (proc) { proc.kill(); await new Promise(r => proc.on('close', r)); }
