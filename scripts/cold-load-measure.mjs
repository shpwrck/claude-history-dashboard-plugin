#!/usr/bin/env node
// Cold-load budget gate (#663, epic #638).
//
// Bundle-size (#664) caps how many bytes ship; this caps how long a COLD first
// load actually takes to paint and become interactive — the user-felt number a
// bundle-size regression, a render-blocking import, or a boot-path change can
// silently blow without tripping the byte budget.
//
// It measures, per SPA flavor, against the PUBLISHED build served by `vite
// preview` (NOT dev — dev's unbundled module graph is not representative):
//   - First Contentful Paint (FCP) — performance.getEntriesByType('paint')
//   - Time-to-Interactive proxy (TTI) — domInteractive, the moment the parser
//     finished and the document is interactive. A real PerformanceObserver
//     longtask TTI needs sustained network/CPU-idle heuristics that are noisy in
//     a sample-data SPA with no server; domInteractive is the stable, repeatable
//     proxy the bundle-budget sibling's spirit calls for.
//   - Content-Painted (CP) — time until #root first has a rendered child element
//     (a MutationObserver fires the instant React mounts its first node). For
//     this app the <body> ships as an empty <div id="root">, so FCP fires on a
//     BLANK page — it cannot see the real "user sees content" moment, which only
//     arrives after ~430KB of JS plus a fetch/unzip/parse pipeline. CP is the
//     metric that actually tracks that experience; FCP/TTI are kept alongside it
//     so a blank-paint regression is still visible. (See #1867 — blank-root FCP
//     under-measures real cold load.)
//
// Each flavor is loaded COLD several times (a fresh browser context per run, so
// no warm HTTP/disk/module cache carries over) and we take the MEDIAN of each
// metric — medians shrug off the odd GC/scheduler outlier the way a single load
// can't. The medians are checked against cold-load-budget.json; any metric over
// its ceiling fails the process (exit 1) and prints which flavor/metric blew it.
//
// Run it locally (builds both flavors itself unless --no-build):
//   node scripts/cold-load-measure.mjs                 # both flavors, gate
//   node scripts/cold-load-measure.mjs --flavor spa    # one flavor
//   node scripts/cold-load-measure.mjs --json out.json # also write JSON results
//   node scripts/cold-load-measure.mjs --no-build      # reuse existing dist-*/
//   node scripts/cold-load-measure.mjs --measure-only  # print numbers, no gate
//   node scripts/cold-load-measure.mjs --cpu-throttle 4 # CDP CPU slowdown ×N (default off)
//
// Wired into .github/workflows/cold-load.yml so a PR that regresses past the
// budget fails CI. Raise a ceiling deliberately — with a note on why — in
// cold-load-budget.json + docs/perf-sprint/cold-load.md when growth is real; the
// budgets carry headroom so normal churn does not trip the gate.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

// Per-flavor preview config. Distinct ports so both flavors can be measured in
// one run without collision (server → 4473, spa → 4474, per #663). Each flavor
// builds into its own dist dir so the two builds never clobber each other (both
// default to `dist`).
const FLAVORS = {
  server: {
    label: 'server SPA',
    dist: 'dist-server',
    port: 4473,
    buildArgs: ['vite', 'build', '--outDir', 'dist-server'],
  },
  spa: {
    label: 'upload SPA',
    dist: 'dist-spa',
    port: 4474,
    buildArgs: ['vite', 'build', '--mode', 'spa', '--outDir', 'dist-spa'],
  },
};

// Cold loads per flavor — odd so the median is a real sample, small enough to
// stay fast in CI.
const RUNS = 5;

function parseArgs(argv) {
  const out = {
    flavors: Object.keys(FLAVORS),
    build: true,
    gate: true,
    json: null,
    budget: join(REPO_ROOT, 'cold-load-budget.json'),
    cpuThrottle: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--flavor') {
      const f = argv[++i];
      if (!FLAVORS[f]) die(`--flavor must be one of: ${Object.keys(FLAVORS).join(', ')}`);
      out.flavors = [f];
    } else if (a === '--no-build') out.build = false;
    else if (a === '--measure-only') out.gate = false;
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--budget') out.budget = argv[++i];
    else if (a === '--cpu-throttle') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) die('--cpu-throttle must be a number >= 1 (CDP slowdown multiplier).');
      out.cpuThrottle = n;
    } else die(`Unknown argument: ${a}`);
  }
  return out;
}

function die(msg) {
  console.error(`\n✗ Cold-load gate ERROR — ${msg}\n`);
  process.exit(2);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmtMs(n) {
  return `${Math.round(n)} ms`;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
  });
}

// Build one flavor into its own dist dir.
async function buildFlavor(flavor) {
  const cfg = FLAVORS[flavor];
  console.log(`Building ${cfg.label} → ${cfg.dist}/ ...`);
  await run('npx', cfg.buildArgs);
}

// Wait until the preview server answers an HTTP request on 127.0.0.1:port.
// We poll an actual GET (not a bare TCP connect): on a CI runner a socket can
// accept before vite is ready to serve, and — more importantly — this matches
// the IPv4 host vite is told to bind (`--host 127.0.0.1`) and that Playwright
// later navigates, so there is no localhost→::1 ambiguity. `onTimeout` is given
// any captured preview output so a stuck/crashed server is diagnosable in CI
// rather than a bare "never came up".
function waitForHttp(port, { timeoutMs = 60000, onTimeout } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.once('error', retry);
      req.once('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        const extra = onTimeout ? onTimeout() : '';
        reject(new Error(`preview on :${port} never answered HTTP within ${timeoutMs}ms${extra}`));
      } else setTimeout(tryOnce, 250);
    };
    tryOnce();
  });
}

// Spawn `vite preview` for a built flavor on its fixed port. Binds explicitly to
// 127.0.0.1 (the host the readiness poll and Playwright both use) and captures
// output so a startup failure is reported instead of silently timing out — a
// CI-stuck preview was the failure mode this gate hit on its first run. Returns
// a handle with a kill() that tears the whole process group down.
async function startPreview(flavor) {
  const cfg = FLAVORS[flavor];
  if (!existsSync(join(REPO_ROOT, cfg.dist, 'index.html'))) {
    die(`${cfg.dist}/index.html missing — build the ${flavor} flavor first (drop --no-build).`);
  }
  const child = spawn(
    'npx',
    ['vite', 'preview', '--outDir', cfg.dist, '--host', '127.0.0.1', '--port', String(cfg.port), '--strictPort'],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let output = '';
  const cap = (buf) => {
    output += buf.toString();
  };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  let exitedEarly = null;
  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) exitedEarly = `exited ${code}${signal ? ` (${signal})` : ''}`;
  });
  child.on('error', (err) => die(`failed to start preview for ${flavor}: ${err.message}`));
  await waitForHttp(cfg.port, {
    onTimeout: () => {
      const tail = output.trim().split('\n').slice(-10).join('\n');
      return (exitedEarly ? ` — preview process ${exitedEarly}` : '') +
        (tail ? `\n--- preview output ---\n${tail}` : ' (no preview output captured)');
    },
  });
  return {
    url: `http://127.0.0.1:${cfg.port}/`,
    kill() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

// Measure FCP + TTI + Content-Painted (+ LCP) for one cold load in a brand-new
// context (no warm cache).
//
// FCP is captured via a buffered PerformanceObserver armed BEFORE navigation
// (addInitScript). Reading performance.getEntriesByType('paint') after `load`
// is unreliable in headless chromium — the paint entry is intermittently not yet
// flushed, yielding a spurious null that would make a gate flaky. The buffered
// observer resolves as soon as first-contentful-paint is recorded, deterministically.
//
// Content-Painted (CP) is the real "user sees content" signal: a MutationObserver
// on #root resolves with performance.now() the instant the app mounts its first
// child element. Because <body> ships as an empty <div id="root">, FCP fires on a
// blank page and is blind to this moment — CP is what actually tracks the cold
// experience (#1867). LCP is captured opportunistically from the
// largest-contentful-paint observer as a cross-check; it is reported but not gated
// (it can be null on tiny content and is noisier than CP).
async function measureOnce(browser, url, { cpuThrottle = 1 } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Defeat any HTTP/disk cache so every run is genuinely cold.
  await context.route('**/*', (route) => route.continue());
  // Optional CPU throttling via CDP — a slower CPU makes the JS-bound boot path
  // (the real cold cost FCP can't see) closer to a mid-tier client. Off by
  // default (rate 1) to keep the CI baseline stable; opt in with --cpu-throttle.
  let cdp = null;
  if (cpuThrottle > 1) {
    cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
  }
  await page.addInitScript(() => {
    window.__coldLoadFcp = new Promise((resolve) => {
      try {
        const obs = new PerformanceObserver((list, observer) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-contentful-paint') {
              observer.disconnect();
              resolve(entry.startTime);
            }
          }
        });
        obs.observe({ type: 'paint', buffered: true });
      } catch {
        resolve(null);
      }
    });
    // Largest Contentful Paint — keep the latest entry; read after load settles.
    window.__coldLoadLcp = null;
    try {
      const lcpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length) window.__coldLoadLcp = entries[entries.length - 1].startTime;
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      /* unsupported — stays null */
    }
    // Content-Painted: first time #root gets a child element. Arm a
    // MutationObserver as early as possible (init script runs before the app
    // bundle), and also check synchronously in case #root already has content.
    window.__coldLoadCp = new Promise((resolve) => {
      const check = () => {
        const root = document.getElementById('root');
        if (root && root.children.length > 0) {
          resolve(performance.now());
          return true;
        }
        return false;
      };
      const start = () => {
        if (check()) return;
        const mo = new MutationObserver(() => {
          if (check()) mo.disconnect();
        });
        // Observe document until #root exists, then it (subtree covers both).
        mo.observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.documentElement) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
    });
  });
  await page.goto(url, { waitUntil: 'load' });
  const metrics = await page.evaluate(async () => {
    const fcp = await Promise.race([
      window.__coldLoadFcp,
      new Promise((r) => setTimeout(() => r(null), 15000)),
    ]);
    // Content-Painted has a longer ceiling than FCP — the JS+parse pipeline it
    // waits on is exactly the seconds-scale cost the old gate missed.
    const cp = await Promise.race([
      window.__coldLoadCp,
      new Promise((r) => setTimeout(() => r(null), 15000)),
    ]);
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      fcp: fcp == null ? null : fcp,
      // TTI proxy: domInteractive (parser done, document interactive). Falls
      // back to domContentLoadedEventEnd if a browser reports 0.
      tti: nav ? nav.domInteractive || nav.domContentLoadedEventEnd : null,
      cp: cp == null ? null : cp,
      lcp: window.__coldLoadLcp,
    };
  });
  if (cdp) {
    try {
      await cdp.detach();
    } catch {
      /* context closing anyway */
    }
  }
  await context.close();
  return metrics;
}

async function measureFlavor(browser, flavor, preview, { cpuThrottle = 1 } = {}) {
  const opts = { cpuThrottle };
  // One discarded warmup load: the first navigation after a browser launch pays
  // a one-time cost (JIT warm-up, first compositor frame, font load) that is not
  // representative of a steady cold load — it skews FCP by an order of magnitude.
  // Discarding it makes the median stable.
  await measureOnce(browser, preview.url, opts);

  const fcps = [];
  const ttis = [];
  const cps = [];
  const lcps = [];
  for (let i = 0; i < RUNS; i++) {
    const m = await measureOnce(browser, preview.url, opts);
    if (m.fcp == null) die(`${flavor}: no First Contentful Paint recorded — did the app render?`);
    if (m.tti == null) die(`${flavor}: no navigation timing recorded.`);
    if (m.cp == null) die(`${flavor}: #root never got a child element — did the app mount?`);
    fcps.push(m.fcp);
    ttis.push(m.tti);
    cps.push(m.cp);
    if (m.lcp != null) lcps.push(m.lcp);
  }
  return {
    fcp: { runs: fcps.map(Math.round), median: Math.round(median(fcps)) },
    tti: { runs: ttis.map(Math.round), median: Math.round(median(ttis)) },
    cp: { runs: cps.map(Math.round), median: Math.round(median(cps)) },
    // LCP is opportunistic — null entries are dropped; report only if we got any.
    lcp: lcps.length
      ? { runs: lcps.map(Math.round), median: Math.round(median(lcps)) }
      : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let budget = null;
  if (args.gate) {
    try {
      budget = JSON.parse(readFileSync(args.budget, 'utf8'));
    } catch (err) {
      die(`could not read budget file ${args.budget} (${err.message}).`);
    }
  }

  if (args.build) {
    for (const flavor of args.flavors) await buildFlavor(flavor);
  }

  const browser = await chromium.launch();
  const results = {};
  const previews = [];
  try {
    for (const flavor of args.flavors) {
      const preview = await startPreview(flavor);
      previews.push(preview);
      const throttleNote = args.cpuThrottle > 1 ? `, CPU ×${args.cpuThrottle}` : '';
      console.log(`Measuring ${FLAVORS[flavor].label} (${RUNS} cold loads${throttleNote}) at ${preview.url} ...`);
      results[flavor] = await measureFlavor(browser, flavor, preview, { cpuThrottle: args.cpuThrottle });
    }
  } finally {
    await browser.close();
    for (const p of previews) p.kill();
  }

  // Report.
  console.log('\nCold-load measurement (median of cold loads)');
  for (const flavor of args.flavors) {
    const r = results[flavor];
    console.log(`  ${FLAVORS[flavor].label}:`);
    console.log(`    FCP  median ${fmtMs(r.fcp.median).padStart(8)}   runs [${r.fcp.runs.join(', ')}]`);
    console.log(`    TTI  median ${fmtMs(r.tti.median).padStart(8)}   runs [${r.tti.runs.join(', ')}]`);
    console.log(`    CP   median ${fmtMs(r.cp.median).padStart(8)}   runs [${r.cp.runs.join(', ')}]`);
    if (r.lcp) {
      console.log(`    LCP  median ${fmtMs(r.lcp.median).padStart(8)}   runs [${r.lcp.runs.join(', ')}]  (cross-check, not gated)`);
    }
  }

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify({ measuredAt: new Date().toISOString(), runs: RUNS, results }, null, 2) + '\n',
    );
    console.log(`\nWrote JSON results → ${args.json}`);
  }

  if (!args.gate) {
    console.log('\n(measure-only: no budget gate applied)\n');
    return;
  }

  // Gate against the budget.
  const failures = [];
  console.log('\nCold-load budget gate');
  for (const flavor of args.flavors) {
    const flavorBudget = budget[flavor];
    if (!flavorBudget) die(`budget file has no "${flavor}" block.`);
    const r = results[flavor];
    for (const metric of ['fcp', 'tti', 'cp']) {
      const actual = r[metric].median;
      const max = flavorBudget[`${metric}MaxMs`];
      if (max == null) die(`budget["${flavor}"] missing "${metric}MaxMs".`);
      const ok = actual <= max;
      const mark = ok ? '✓' : '✗';
      console.log(
        `  ${mark} ${FLAVORS[flavor].label.padEnd(11)} ${metric.toUpperCase().padEnd(3)} ` +
          `${fmtMs(actual).padStart(8)}  / budget ${fmtMs(max)}`,
      );
      if (!ok) failures.push(`${FLAVORS[flavor].label} ${metric.toUpperCase()} ${fmtMs(actual)} exceeds budget ${fmtMs(max)}`);
    }
  }

  if (failures.length > 0) {
    console.error('\n✗ Cold-load gate BLOCKED:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      '\nA cold-load metric regressed past its budget. Common causes: a heavier ' +
        'entry chunk (check the bundle-size gate too), a render-blocking import ' +
        'pulled onto the boot path, or a change to index.html / src/main.tsx. If ' +
        'the regression is genuinely justified, raise the ceiling in ' +
        'cold-load-budget.json with a note and update docs/perf-sprint/cold-load.md.\n',
    );
    process.exit(1);
  }

  console.log('\n✓ Cold-load gate PASSED: all flavors within budget.\n');
}

main().catch((err) => die(err.stack || err.message));
