// Sessions large-history render-churn measurement (#3287, epic #1930).
//
// The isolated-view benchmark (scripts/measure-isolated-views.mjs) measures
// the 18-session sample corpus — which stays on the Sessions view's FIRST page
// (PAGE_SIZE 20), so it can never exercise the >=300-rendered-row regime where
// the resize-storm budget was blown (311ms at 300 rendered rows, 670ms at
// 1000, vs <=100ms). This script measures exactly that regime:
//
//   1. Serves the verified sample-SPA preview (same provenance gates as the
//      isolated benchmark: shell title + hashed entry + real corpus zip).
//   2. For each target scale, intercepts the page's `/sample-data.zip` fetch
//      and fulfills it with a SCALED corpus: the deterministic 18-session
//      sample plus clones of those sessions under fresh session ids (content
//      otherwise identical), zipped in-memory. The served preview build is
//      untouched; only this page's corpus differs, and its identity (session
//      count + sha256) is printed with the results.
//   3. Navigates to #/sessions, asserts the route identity (<h1>Sessions</h1>),
//      pages through EVERY `Load more` click so the full history is rendered,
//      records the table's <tr> composition (full rows vs coalesced spacers),
//      then runs the standard resize storm (5x 400<->1280px cycles) and
//      collects longtask totals.
//
// Three fresh browser contexts per scale; medians reported. Budget: <=100ms
// median resize-storm longtask total at every scale
// (docs/perf-sprint/render-churn.md).
//
// Usage:
//   npm run build:sample
//   node scripts/measure-sessions-scale.mjs [--port 4489] [--scales 18,300,1000]
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyTarget } from './measure-isolated-views.mjs';
import {
  buildSampleCorpus,
  corpusZipEntries,
} from './sample-data/build-corpus.mjs';

const PORT = (() => {
  const idx = process.argv.indexOf('--port');
  return idx >= 0 ? Number(process.argv[idx + 1]) : 4489;
})();

const SCALES = (() => {
  const idx = process.argv.indexOf('--scales');
  const raw = idx >= 0 ? process.argv[idx + 1] : '18,100,300,1000';
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
})();

const RUNS = 3;

async function isPortFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => {
      s.close();
      resolve(true);
    });
    s.listen(port, '127.0.0.1');
  });
}

async function startPreview() {
  if (!(await isPortFree(PORT))) {
    const provenance = await verifyTarget(PORT);
    process.stderr.write(
      `port ${PORT} already serves this SPA preview (build ${provenance.build}); reusing it\n`
    );
    return { proc: null, provenance };
  }
  const proc = spawn(
    'node',
    ['node_modules/.bin/vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await isPortFree(PORT))) break;
  }
  try {
    const provenance = await verifyTarget(PORT);
    return { proc, provenance };
  } catch (err) {
    proc.kill();
    throw err;
  }
}

/**
 * The deterministic sample corpus plus clones of its sessions under fresh ids
 * until `target` sessions exist. Clones rewrite every occurrence of the source
 * session id inside the transcript (message ids embed it), so each clone
 * parses as a distinct session; timestamps are left as-is, which the Sessions
 * view's recency sort and day-grouping handle like any same-day sessions.
 */
export function scaledCorpus(target) {
  const corpus = buildSampleCorpus();
  const base = corpus.sessions;
  const sessions = [...base];
  let k = 0;
  while (sessions.length < target) {
    const src = base[k % base.length];
    const gen = Math.floor(k / base.length) + 1;
    const newId = `${src.sessionId}-x${gen}`;
    sessions.push({
      project: src.project,
      slug: src.slug,
      sessionId: newId,
      jsonl: src.jsonl.split(src.sessionId).join(newId),
    });
    k++;
  }
  return { historyJsonl: corpus.historyJsonl, sessions: sessions.slice(0, Math.max(target, base.length)) };
}

function corpusZipBytes(corpus) {
  const entries = corpusZipEntries(corpus);
  return zipSync(entries, { level: 6, mtime: new Date('2026-01-01T00:00:00Z') });
}

const INJECT = `
  window.__m = { lt: [] };
  try {
    new PerformanceObserver(l => l.getEntries().forEach(e => window.__m.lt.push(e.duration))).observe({type:'longtask', buffered:false});
  } catch(e) {}
`;

async function measureScale(browser, zipBytes, sessionCount) {
  const runs = [];
  for (let run = 0; run < RUNS; run++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.addInitScript(INJECT);
    await page.route('**/sample-data.zip', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/zip',
        body: Buffer.from(zipBytes),
      })
    );

    await page.goto(`http://127.0.0.1:${PORT}/#/sessions`, {
      waitUntil: 'networkidle',
      timeout: 90000,
    });
    // Route identity: this must be the Sessions view, not a fallback shell.
    await page.waitForSelector('h1:has-text("Sessions")', { timeout: 60000 });
    await page.waitForSelector('table[aria-label="Sessions"]', { timeout: 60000 });

    // The global time-range filter defaults to 24h, which hides most of the
    // corpus (the sample spans days). Widen to All so rendered rows can cover
    // every session.
    await page.getByRole('button', { name: 'All', exact: true }).first().click();
    await page.waitForTimeout(300);

    // The SPA parses the corpus PROGRESSIVELY after the table first mounts, so
    // "the Load more button is gone" can mean "the rest is not parsed yet",
    // not "everything is rendered" — an early sample here measured a partial
    // list under the full corpus's name. Page through, and only accept
    // exhaustion once the row count has been stable with no button for
    // several consecutive samples.
    const rowCount = () =>
      page.evaluate(
        () =>
          document.querySelectorAll('table[aria-label="Sessions"] tbody tr')
            .length
      );
    let clicks = 0;
    let stable = 0;
    let lastRows = -1;
    for (let i = 0; i < 600 && stable < 5; i++) {
      const btn = page.getByRole('button', { name: /Load more/ });
      if ((await btn.count()) > 0) {
        await btn.first().click();
        clicks++;
        stable = 0;
        await page.waitForTimeout(60);
        continue;
      }
      const n = await rowCount();
      if (n === lastRows) stable++;
      else {
        stable = 0;
        lastRows = n;
      }
      await page.waitForTimeout(300);
    }
    // Let the row-window observer settle after the pagination churn.
    await page.waitForTimeout(500);

    const composition = await page.evaluate(() => {
      const table = document.querySelector('table[aria-label="Sessions"]');
      const trs = table ? table.querySelectorAll('tbody tr') : [];
      let spacers = 0;
      let spacerRowsCovered = 0;
      for (const tr of trs) {
        if (tr.hasAttribute('data-windowed-out')) {
          spacers++;
          const run = (tr.getAttribute('data-window-run') ?? '0-0').split('-');
          spacerRowsCovered += Number(run[1]) - Number(run[0]) + 1;
        }
      }
      return {
        totalTrs: trs.length,
        spacerTrs: spacers,
        fullTrs: trs.length - spacers,
        spacerRowsCovered,
      };
    });

    // Quiescence gate: after heavy pagination the app can still be finishing
    // background work (derived datasets, deferred renders). Wait until no
    // longtask has landed for a full second (capped) so the storm window
    // measures RESIZE cost, not a parse tail.
    for (let i = 0; i < 20; i++) {
      const before = await page.evaluate(() => window.__m.lt.length);
      await page.waitForTimeout(1000);
      const after = await page.evaluate(() => window.__m.lt.length);
      if (after === before) break;
    }

    // Fresh window for the resize storm only.
    await page.evaluate(() => {
      window.__m.lt = [];
    });
    for (let i = 0; i < 5; i++) {
      await page.setViewportSize({ width: 400, height: 720 });
      await page.waitForTimeout(80);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(300);
    const lt = await page.evaluate(() => window.__m.lt);

    const renderedRowEquivalent =
      composition.fullTrs + composition.spacerRowsCovered;
    if (renderedRowEquivalent < sessionCount) {
      // Full rows + rows covered by spacers must account for at least every
      // session (day headers push it higher). Anything less means the page
      // was measured before the corpus finished rendering — refuse the run.
      throw new Error(
        `under-rendered: ${renderedRowEquivalent} row-equivalents for a ` +
          `${sessionCount}-session corpus — parse/pagination did not finish`
      );
    }
    runs.push({
      clicks,
      ...composition,
      renderedRowEquivalent,
      resizeLTTotalMs: lt.reduce((s, d) => s + d, 0),
      resizeLTCount: lt.length,
    });
    await ctx.close();
  }
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return {
    sessionCount,
    runs,
    medianResizeLTMs: median(runs.map((r) => r.resizeLTTotalMs)),
  };
}

async function main() {
  let started;
  try {
    started = await startPreview();
  } catch (err) {
    process.stderr.write(
      `measure-sessions-scale: refusing to measure port ${PORT} — ${err.message}\n`
    );
    process.exitCode = 1;
    return;
  }
  const { proc, provenance } = started;

  console.log('# Sessions large-history resize-storm measurements (#3287)');
  console.log(`# Verified build:       ${provenance.build}`);
  console.log(`# Verified base corpus: ${provenance.corpus.id}`);
  console.log(`# Scales: ${SCALES.join(', ')} sessions; ${RUNS} fresh contexts each`);
  console.log('# Budget: <=100ms median resize-storm longtask total\n');

  const browser = await chromium.launch({ headless: true });
  const summary = [];
  for (const scale of SCALES) {
    const corpus = scaledCorpus(scale);
    const zipBytes = corpusZipBytes(corpus);
    const sha = createHash('sha256').update(zipBytes).digest('hex').slice(0, 16);
    process.stdout.write(
      `Measuring ${scale} sessions (scaled corpus ${zipBytes.length} bytes sha256:${sha})...\n`
    );
    const r = await measureScale(browser, zipBytes, scale);
    summary.push(r);
    for (const run of r.runs) {
      console.log(
        `  run: rows=${run.fullTrs} full + ${run.spacerTrs} spacers (covering ${run.spacerRowsCovered} rows), ` +
          `loadMore x${run.clicks}, resize=${run.resizeLTTotalMs.toFixed(0)}ms (${run.resizeLTCount} lt)`
      );
    }
    console.log(`  MEDIAN resize: ${r.medianResizeLTMs.toFixed(0)}ms\n`);
  }
  await browser.close();

  console.log('## Summary\n');
  console.log('sessions | full <tr> (median) | spacer <tr> (median) | resize LT median | <=100ms budget');
  console.log('---------|--------------------|----------------------|------------------|---------------');
  const median = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  for (const r of summary) {
    const fullMed = median(r.runs.map((x) => x.fullTrs));
    const spacerMed = median(r.runs.map((x) => x.spacerTrs));
    console.log(
      `${String(r.sessionCount).padStart(8)} | ${String(fullMed).padStart(18)} | ${String(spacerMed).padStart(20)} | ${String(r.medianResizeLTMs.toFixed(0) + 'ms').padStart(16)} | ${r.medianResizeLTMs <= 100 ? 'MET' : 'EXCEEDED'}`
    );
  }

  if (proc) {
    proc.kill();
    await new Promise((r) => proc.on('close', r));
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) await main();
