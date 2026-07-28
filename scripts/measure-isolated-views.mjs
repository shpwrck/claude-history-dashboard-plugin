// Isolated per-view render churn measurements (issue #666).
// Each view gets a fresh browser context to avoid cumulative PerformanceObserver bleed.
//
// Usage:
//   npm run build:sample                              # emits dist/sample-data.zip
//   node scripts/measure-isolated-views.mjs [--port 4477]
//
// `build:sample` — NOT `build:spa` — is the prerequisite: vite.config.ts applies
// sampleDataPlugin() only under `--mode sample`, so the spa/edge build ships no
// mock data at all (ADR 0014) and its preview renders the empty upload-first UI.
// Measuring that and calling it the sample-corpus benchmark is what this script
// now refuses to do.
//
// The benchmark FAILS CLOSED on an occupied port (#3091). It used to print
// "port in use, assuming server running" and then measure whatever answered,
// while the report unconditionally claimed an isolated SPA run over an
// 18-session sample corpus. An unrelated static server on that port produced
// plausible zero-long-task numbers under the target benchmark's name. Nothing
// is measured now until the responder is verified to be this dashboard's SPA
// preview, and the header prints the build + corpus identifiers read from that
// verified response instead of a hard-coded claim.
//
// Verification is deliberately specific, because a weak check is the same bug
// one level in (#3394 review):
//   - BUILD: a `#root` div plus a hashed `/assets/*.js` entry is the shape of
//     EVERY built Vite + React app, so the served `<title>` must also equal this
//     repo's own index.html title.
//   - CORPUS: `/sample-data.zip` must actually BE a ZIP. `npm run build:spa`
//     emits none, and vite preview answers the missing path with index.html at
//     HTTP 200 — "200 and non-empty" would hash that HTML and call it a corpus.
// Either failing ABORTS the run. An earlier revision labelled the corpus
// UNVERIFIED and measured anyway, which caveats the problem instead of cutting
// it: the label says the numbers are unsound and the script publishes them
// regardless. A benchmark that cannot establish what it measured must not
// publish a measurement.
import { chromium } from '@playwright/test';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// The SPA shell this benchmark measures: a Vite index.html with the app root and
// a hashed module entry. That entry filename carries the build's content hash,
// so it IS the build identifier — no separate stamp to keep in sync.
const ENTRY_RE = /<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/;
const TITLE_RE = /<title>([^<]*)<\/title>/i;

/**
 * The product-specific marker this repo's own shell carries: the `<title>` in
 * `index.html`, which Vite copies verbatim into every build flavour.
 *
 * `<div id="root">` plus a hashed `/assets/*.js` is the shape of EVERY built
 * Vite + React app, so on its own it identifies a bundler, not this dashboard —
 * any other such app listening on the port passed the reuse check. Reading the
 * expectation out of the repo rather than hard-coding it means a title change
 * cannot silently loosen the comparison.
 */
export function expectedShellTitle(projectDir = PROJECT_DIR) {
  try {
    const html = readFileSync(join(projectDir, 'index.html'), 'utf8');
    return TITLE_RE.exec(html)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Decide whether an index.html response is THIS dashboard's preview shell, and
 * derive the build identifier from it. Returns { ok: true, build } or
 * { ok: false, reason }.
 */
export function verifyPreviewShell({ status, contentType, body }, { expectedTitle } = {}) {
  if (status !== 200) return { ok: false, reason: `GET / returned HTTP ${status}` };
  if (!/text\/html/i.test(contentType ?? '')) {
    return { ok: false, reason: `GET / served "${contentType ?? 'no content-type'}", not HTML` };
  }
  if (!expectedTitle) {
    // With no marker of our own to compare against, identity cannot be
    // established. That is a refusal, not a pass.
    return {
      ok: false,
      reason: "cannot read this build's own index.html <title> to compare against",
    };
  }
  if (!/id="root"/.test(body)) {
    return { ok: false, reason: 'GET / has no #root mount point — not a Vite SPA shell' };
  }
  const served = TITLE_RE.exec(body)?.[1]?.trim() ?? null;
  if (served !== expectedTitle) {
    return {
      ok: false,
      reason:
        `GET / is a different app: <title> is ${JSON.stringify(served)}, ` +
        `expected ${JSON.stringify(expectedTitle)}`,
    };
  }
  const entry = ENTRY_RE.exec(body);
  if (!entry) {
    return {
      ok: false,
      reason: 'GET / has no hashed /assets/*.js module entry — not a built SPA preview',
    };
  }
  return { ok: true, build: entry[1] };
}

// ZIP local file header signature.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// The ONLY build mode that emits dist/sample-data.zip: vite.config.ts applies
// sampleDataPlugin() under `--mode sample` alone.
export const CORPUS_BUILD_COMMAND = 'npm run build:sample';

/**
 * Corpus identity of the responder: the sample-data archive the SPA loads. Its
 * digest and byte length are what can actually be verified over HTTP, so they
 * are what the report prints.
 *
 * The body must actually BE a ZIP. `sampleDataPlugin()` runs only under
 * `--mode sample` (vite.config.ts), so the documented `npm run build:spa` output
 * ships no `/sample-data.zip` at all — and Vite preview's SPA fallback answers
 * unknown paths with index.html at HTTP 200 with a non-empty body. Accepting
 * "200 and non-empty" hashed that HTML and reported it as a verified corpus: a
 * proxy asserted as the real thing, which is the defect class this file exists
 * to remove. Anything that is not a real archive is UNVERIFIED — never an
 * assumed session count.
 */
export function corpusIdentity({ status, contentType, body }) {
  if (status !== 200) {
    return {
      verified: false,
      id: `UNVERIFIED (GET /sample-data.zip returned HTTP ${status})`,
    };
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  const type = contentType ?? 'no content-type';
  if (/^text\//i.test(type) || /html/i.test(type)) {
    return {
      verified: false,
      id: `UNVERIFIED (/sample-data.zip served "${type}" — SPA fallback HTML, not an archive)`,
    };
  }
  if (buf.length < ZIP_MAGIC.length || !buf.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    return {
      verified: false,
      id: `UNVERIFIED (/sample-data.zip is not a ZIP archive: "${type}", ${buf.length} bytes)`,
    };
  }
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return { verified: true, id: `sample-data.zip ${buf.length} bytes sha256:${sha}` };
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type'), body };
}

/** Probe a listening port and return its verified provenance, or throw. */
export async function verifyTarget(
  port,
  fetchPath = get,
  { expectedTitle = expectedShellTitle() } = {}
) {
  let shellResponse;
  try {
    shellResponse = await fetchPath(port, '/');
  } catch (err) {
    throw new Error(`cannot reach http://127.0.0.1:${port}/ — ${err.message}`);
  }
  const shell = verifyPreviewShell(
    {
      status: shellResponse.status,
      contentType: shellResponse.contentType,
      body: Buffer.from(shellResponse.body ?? '').toString('utf8'),
    },
    { expectedTitle }
  );
  // The build identity is a hard gate already: verifyPreviewShell only returns
  // ok when it has matched BOTH the product marker and a hashed entry, so
  // `shell.build` is always a real identifier past this line. There is no
  // "build unknown but measure anyway" path.
  if (!shell.ok) throw new Error(shell.reason);
  let corpusResponse;
  try {
    corpusResponse = await fetchPath(port, '/sample-data.zip');
  } catch {
    corpusResponse = { status: 0, contentType: null, body: Buffer.alloc(0) };
  }
  const corpus = corpusIdentity(corpusResponse);
  // ...and so is the corpus. Labelling it UNVERIFIED and measuring anyway would
  // caveat the problem instead of cutting it: this benchmark's numbers are only
  // meaningful over the deterministic sample workload, and a preview without the
  // archive serves the EMPTY upload-first UI. A benchmark that cannot establish
  // what it measured must not publish a measurement.
  if (!corpus.verified) throw new Error(unverifiedCorpusMessage(corpus));
  return { build: shell.build, corpus };
}

/** Refusal text that names the build mode which actually emits the corpus. */
export function unverifiedCorpusMessage(corpus) {
  return (
    `${corpus.id}\n` +
    '  This benchmark reports render churn over the deterministic sample corpus,\n' +
    '  so it cannot publish numbers for a build that does not serve one — a\n' +
    '  preview without sample-data.zip renders the EMPTY upload-first UI.\n' +
    `  Rebuild with \`${CORPUS_BUILD_COMMAND}\` and re-run.\n` +
    '  Note `npm run build:spa` does NOT emit sample-data.zip: vite.config.ts\n' +
    '  applies sampleDataPlugin() only under `--mode sample`, because the edge\n' +
    '  upload build deliberately ships no mock data (ADR 0014 / epic #1852).'
  );
}

async function startPreview() {
  if (!(await isPortFree(PORT))) {
    // Something already listens here. It is usable only if it IS this SPA's
    // preview — otherwise we would publish another server's numbers under this
    // benchmark's name.
    const provenance = await verifyTarget(PORT);
    process.stderr.write(
      `port ${PORT} already serves this SPA preview (build ${provenance.build}); reusing it\n`
    );
    return { proc: null, provenance };
  }
  const proc = spawn('node', ['node_modules/.bin/vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 100));
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

async function main() {
  let started;
  try {
    started = await startPreview();
  } catch (err) {
    process.stderr.write(
      `measure-isolated-views: refusing to measure port ${PORT} — ${err.message}\n` +
        'The responder could not be verified as this SPA preview, so numbers ' +
        'collected from it would not be this benchmark.\n'
    );
    process.exitCode = 1;
    return;
  }
  const { proc, provenance } = started;

  console.log('# Isolated render-churn measurements (issue #666)');
  console.log(`# Verified build:  ${provenance.build}`);
  console.log(`# Verified corpus: ${provenance.corpus.id}`);
  console.log('# 3 runs per view, medians reported');
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
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) await main();
