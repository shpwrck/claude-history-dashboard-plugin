// Unit tests for the STRUCTURAL bundle-size budget gate (#1852 Phase C, ADR 0016).
//
// The gate replaced the single rising `totalJsMaxBytes` (whose bump-note
// changelog was the warp #1852 exists to retire) with three INDEPENDENT classes
// — shell (FROZEN first-paint set), vendor (FROZEN shared chunks), and routes
// (per-lazy-chunk caps that each stand ALONE, never summed). These tests feed
// `evaluateStructuredBudget` synthetic chunk sizes — no real build required —
// and prove each class gates on its own and that a new lazy route cannot inflate
// a shared number (the whole point of the restructure).
//
// `evaluateStructuredBudget` / `evaluateBudget` / `chunkBaseName` /
// `findServerMarkers` are the pure core of scripts/check-bundle-size.mjs (the
// CLI just wires them to the filesystem).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error - plain .mjs script, no type declarations.
import {
  evaluateStructuredBudget,
  evaluateBudget,
  chunkBaseName,
  findServerMarkers,
  SERVER_ONLY_MARKERS,
} from '../../scripts/check-bundle-size.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const budget = JSON.parse(
  readFileSync(join(REPO_ROOT, 'bundle-budget.json'), 'utf8'),
);

// Real measured sizes from clean origin/master (e321189) builds. The matcher
// keys on the logical chunk name (filename minus the trailing 8-char hash), so
// we hand it hashed-looking names. Index differs by flavor; the fixture is split.
const MEASURED_BY_FLAVOR = {
  server: {
    'index-hEGllWjd.js': 474756,
    'LightweightCharts-CC58yk5J.js': 8156,
    'Td-bFoBaAnL.js': 69499,
    'FlexItem-BNF1Yxa1.js': 24287,
    'MenuList-aaaaaaaa.js': 18530,
    'recommendations-UfDmvBmg.js': 159744,
    'Recommendations-bw21B0pw.js': 65137,
    'upload-pipeline-worker-BITohlXt.js': 82319,
    'AskClaude-FlL7G4vj.js': 31034,
    'CostAttribution-DNVO2py3.js': 29701,
    'SessionList-CXENs-RU.js': 32753,
    'TokenUsage-CgNAb11x.js': 26226,
    'Permissions-CPjVHr7T.js': 24737,
  },
  spa: {
    'index-CzC7uEtR.js': 465640,
    'LightweightCharts-Bos7EVXd.js': 8156,
    'Td-CHlWUViI.js': 69495,
    'FlexItem-BpXImNgo.js': 24287,
    'MenuList-22n1dG9Q.js': 18529,
    'recommendations-B0UrwUTf.js': 159744,
    'Recommendations-BytKFQei.js': 65142,
    'upload-pipeline-worker-BITohlXt.js': 82319,
    'AskClaude-CWmj1sbA.js': 31034,
    'CostAttribution-Bf2aqhBm.js': 29696,
    'SessionList-B7FXrTZ6.js': 28967,
    'TokenUsage-I7qW9vTp.js': 26227,
    'Permissions-Cx_SHffO.js': 24493,
  },
};
type Flavor = keyof typeof MEASURED_BY_FLAVOR;

function fixtureFor(flavor: Flavor) {
  const measured = MEASURED_BY_FLAVOR[flavor] as Record<string, number>;
  const sizeOf = (f: string): number => {
    const n = measured[f];
    if (n == null) throw new Error(`no synthetic size for ${f}`);
    return n;
  };
  return { files: Object.keys(measured), sizeOf };
}

describe('chunkBaseName', () => {
  it('strips exactly the trailing 8-char hash, even when the name has dashes', () => {
    expect(chunkBaseName('LightweightCharts-CC58yk5J.js')).toBe('LightweightCharts');
    expect(chunkBaseName('index-hEGllWjd.js')).toBe('index');
    // A logical name that itself contains dashes is preserved.
    expect(chunkBaseName('upload-pipeline-worker-BITohlXt.js')).toBe('upload-pipeline-worker');
  });
});

describe('evaluateStructuredBudget (#1852 Phase C / ADR 0016)', () => {
  for (const flavor of ['server', 'spa'] as const) {
    it(`${flavor}: passes at the committed class budgets against real measured sizes`, () => {
      const { files, sizeOf } = fixtureFor(flavor);
      const { ok, failures } = evaluateStructuredBudget(files, sizeOf, budget[flavor]);
      expect(failures).toEqual([]);
      expect(ok).toBe(true);
    });

    it(`${flavor}: the FROZEN shell sum ignores lazy route chunks`, () => {
      // Add a fat new lazy route — the shell row must not move, and the gate
      // must still pass (a new route never inflates a shared total).
      const { files, sizeOf } = fixtureFor(flavor);
      const fatRoute = 'BrandNewHeavyView-zzzzzzzz.js';
      const sizeOf2 = (f: string) => (f === fatRoute ? 38000 : sizeOf(f));
      const { ok, rows } = evaluateStructuredBudget([...files, fatRoute], sizeOf2, budget[flavor]);
      const shellRow = rows.find((r: { cls: string }) => r.cls === 'shell');
      expect(shellRow.actual).toBe(flavor === 'server' ? 474756 : 465640);
      expect(ok).toBe(true); // 38000 < defaults.routeMaxBytes (40000)
    });

    it(`${flavor}: a per-route cap trips on that route ALONE`, () => {
      const { files, sizeOf } = fixtureFor(flavor);
      const tightened = {
        ...budget[flavor],
        routes: { ...budget[flavor].routes, recommendations: 100000 },
      };
      const { ok, failures, rows } = evaluateStructuredBudget(files, sizeOf, tightened);
      expect(ok).toBe(false);
      expect(failures.some((f: string) => f.includes('recommendations'))).toBe(true);
      // Shell + vendor + every OTHER route remain green.
      expect(rows.filter((r: { ok: boolean }) => !r.ok)).toHaveLength(1);
    });

    it(`${flavor}: a FROZEN vendor ceiling trips independently`, () => {
      const { files, sizeOf } = fixtureFor(flavor);
      const tightened = {
        ...budget[flavor],
        vendor: { chunks: { ...budget[flavor].vendor.chunks, LightweightCharts: 6000 } },
      };
      const { ok, failures } = evaluateStructuredBudget(files, sizeOf, tightened);
      expect(ok).toBe(false);
      expect(failures.some((f: string) => f.includes('LightweightCharts'))).toBe(true);
    });

    it(`${flavor}: the FROZEN shell cap trips when eager code lands in index`, () => {
      const { files, sizeOf } = fixtureFor(flavor);
      const indexFile = files.find((f) => chunkBaseName(f) === 'index')!;
      const sizeOf2 = (f: string) => (f === indexFile ? sizeOf(f) + 50000 : sizeOf(f));
      const { ok, failures } = evaluateStructuredBudget(files, sizeOf2, budget[flavor]);
      expect(ok).toBe(false);
      expect(failures.some((f: string) => f.toLowerCase().includes('shell'))).toBe(true);
    });
  }

  it('a NEW unbudgeted route auto-passes under the default and is flagged', () => {
    const { files, sizeOf } = fixtureFor('server');
    const newRoute = 'SomeNewView-yyyyyyyy.js';
    const sizeOf2 = (f: string) => (f === newRoute ? 30000 : sizeOf(f));
    const { ok, rows } = evaluateStructuredBudget([...files, newRoute], sizeOf2, budget.server);
    expect(ok).toBe(true);
    const row = rows.find((r: { name: string }) => r.name === 'SomeNewView');
    expect(row.isNew).toBe(true);
    expect(row.max).toBe(budget.server.defaults.routeMaxBytes);
  });

  it('a NEW route that exceeds the default route cap FAILS', () => {
    const { files, sizeOf } = fixtureFor('server');
    const newRoute = 'RunawayView-xxxxxxxx.js';
    const sizeOf2 = (f: string) => (f === newRoute ? 55000 : sizeOf(f));
    const { ok, failures } = evaluateStructuredBudget([...files, newRoute], sizeOf2, budget.server);
    expect(ok).toBe(false);
    expect(failures.some((f: string) => f.includes('RunawayView'))).toBe(true);
  });

  it('a missing SHELL chunk is a hard failure (the shell sum would otherwise be 0)', () => {
    const { files, sizeOf } = fixtureFor('server');
    const shellGhost = { ...budget.server, shell: { chunks: ['index', 'NotShell'], maxBytes: 482000 } };
    const { ok, failures } = evaluateStructuredBudget(files, sizeOf, shellGhost);
    expect(ok).toBe(false);
    expect(failures.some((f: string) => f.includes('NotShell'))).toBe(true);
  });

  it('a missing VENDOR or ROUTE chunk is a non-blocking WARNING, not a failure', () => {
    const { files, sizeOf } = fixtureFor('server');
    // A renamed auto-named vendor split must not red CI — it warns and the gate
    // stays green (a heavy renamed chunk is still caught by the route size cap).
    const vendorGhost = {
      ...budget.server,
      vendor: { chunks: { ...budget.server.vendor.chunks, NotVendor: 1000 } },
    };
    const v = evaluateStructuredBudget(files, sizeOf, vendorGhost);
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.warnings.some((w: string) => w.includes('NotVendor'))).toBe(true);

    const routeGhost = { ...budget.server, routes: { ...budget.server.routes, NotARoute: 1000 } };
    const r = evaluateStructuredBudget(files, sizeOf, routeGhost);
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w: string) => w.includes('NotARoute'))).toBe(true);
  });

  it('a malformed budget fails LOUD (missing shell.maxBytes / defaults.routeMaxBytes), not open', () => {
    const { files, sizeOf } = fixtureFor('server');
    const noShellCap = { ...budget.server, shell: { chunks: ['index'] } };
    expect(evaluateStructuredBudget(files, sizeOf, noShellCap).ok).toBe(false);
    const noRouteDefault = { ...budget.server, defaults: { totalAdvisoryMaxBytes: 9_000_000 } };
    expect(evaluateStructuredBudget(files, sizeOf, noRouteDefault).ok).toBe(false);
  });

  it('a chunk in two classes is a config error (deterministic membership)', () => {
    const { files, sizeOf } = fixtureFor('server');
    const dup = {
      ...budget.server,
      routes: { ...budget.server.routes, Td: 80000 }, // Td is also a vendor chunk
    };
    const { ok, failures } = evaluateStructuredBudget(files, sizeOf, dup);
    expect(ok).toBe(false);
    expect(failures.some((f: string) => f.includes('BOTH vendor and routes'))).toBe(true);
  });

  it('the advisory total is reported but NEVER gates', () => {
    const { files, sizeOf } = fixtureFor('server');
    // Set the advisory ceiling absurdly low; the gate must still pass.
    const tiny = { ...budget.server, defaults: { ...budget.server.defaults, totalAdvisoryMaxBytes: 1 } };
    const { ok, rows } = evaluateStructuredBudget(files, sizeOf, tiny);
    expect(ok).toBe(true);
    const advisory = rows.find((r: { cls: string }) => r.cls === 'advisory');
    expect(advisory.advisory).toBe(true);
  });

  it('the budget file carries NO gated global total (totalJsMaxBytes is gone)', () => {
    for (const flavor of ['server', 'spa'] as const) {
      expect(budget[flavor]).not.toHaveProperty('totalJsMaxBytes');
      expect(budget[flavor]).toHaveProperty('shell');
      expect(budget[flavor]).toHaveProperty('vendor');
      expect(budget[flavor]).toHaveProperty('routes');
    }
  });
});

describe('boundary guard + legacy evaluator', () => {
  it('findServerMarkers flags a server dist measured against the spa budget (#1702)', () => {
    const spaLike = ['index-CzC7uEtR.js', 'LightweightCharts-Bos7EVXd.js'];
    const cleanContent = () => 'const x=1;export{x};';
    expect(findServerMarkers(spaLike, cleanContent)).toBeNull();

    const serverLike = ['index-hEGllWjd.js'];
    const serverContent = () => 'fetch("/api/dataset.json")';
    const hit = findServerMarkers(serverLike, serverContent);
    expect(hit).not.toBeNull();
    expect(hit?.file).toBe('index-hEGllWjd.js');
    expect(SERVER_ONLY_MARKERS).toContain(hit?.marker);
  });

  it('legacy evaluateBudget still works against a synthetic v1 block (migration shim)', () => {
    // Kept only so stragglers resolve during migration; not used by the CLI.
    const files = ['index-aaaaaaaa.js', 'LightweightCharts-bbbbbbbb.js'];
    const sizeOf = (f: string) => (f.startsWith('index') ? 1000 : 500);
    const v1 = { totalJsMaxBytes: 2000, chunks: { LightweightCharts: 600 } };
    const { ok } = evaluateBudget(files, sizeOf, v1);
    expect(ok).toBe(true);
  });
});
