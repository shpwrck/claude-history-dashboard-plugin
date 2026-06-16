// Unit tests for the bundle-size budget gate (#1002, epic #718).
//
// #1400 removed the heavy Victory/PatternFly chart stack and replaced it with
// a tiny in-house SVG chart helper. These tests pin the post-migration budget by
// feeding `evaluateBudget` synthetic chunk sizes — no real build required — and
// asserting that the new lightweight chart chunk is guarded while the old
// ChartContainer/ChartBar vendor chunks are no longer budgeted.
//
// `evaluateBudget` / `chunkBaseName` are the pure core of
// scripts/check-bundle-size.mjs (the CLI just wires them to the filesystem).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error - plain .mjs script, no type declarations.
import { evaluateBudget, chunkBaseName, findServerMarkers, SERVER_ONLY_MARKERS } from '../../scripts/check-bundle-size.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const budget = JSON.parse(
  readFileSync(join(REPO_ROOT, 'bundle-budget.json'), 'utf8'),
);

// Real measured sizes from clean 2026-06-13 builds after #1400. The matcher
// keys on the logical chunk name (filename minus the trailing 8-char hash), so
// we hand it hashed-looking names. Index differs by build flavor, so the test
// fixture is split per flavor.
const MEASURED_BY_FLAVOR = {
  server: {
    'index-DBubzID8.js': 463239,
    'LightweightCharts-CC58yk5J.js': 7198,
    'recommendations-D0c4yRum.js': 154000,
    'Insights-Dhfcm9BC.js': 40353,
  },
  spa: {
    'index-DmhzAPGJ.js': 456726,
    'LightweightCharts-Bos7EVXd.js': 7198,
    'recommendations-C8hASoW5.js': 154000,
    'Insights-Dhfcm9BC.js': 40353,
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
    expect(chunkBaseName('index-DBubzID8.js')).toBe('index');
  });
});

describe('bundle-budget.json — lightweight chart gate (#1400)', () => {
  for (const flavor of ['server', 'spa'] as const) {
    it(`${flavor}: budgets the lightweight chart chunk with real headroom`, () => {
      const chunks = budget[flavor].chunks;
      expect(chunks.LightweightCharts).toBeGreaterThanOrEqual(7198);
      expect(chunks.LightweightCharts).toBeLessThanOrEqual(8192);
      expect(chunks).not.toHaveProperty('ChartContainer');
      expect(chunks).not.toHaveProperty('ChartBar');
    });

    it(`${flavor}: passes at the committed ceilings against the real measured sizes`, () => {
      const { files, sizeOf } = fixtureFor(flavor);
      const { ok, rows, failures } = evaluateBudget(files, sizeOf, budget[flavor]);
      expect(failures).toEqual([]);
      expect(ok).toBe(true);
      const chart = rows.find((r: { name: string }) => r.name === 'LightweightCharts');
      expect(chart?.actual).toBe(7198);
      expect(chart?.ok).toBe(true);
    });

    it(`${flavor}: FAILS (non-zero) when the lightweight chart chunk grows past its ceiling`, () => {
      const { files, sizeOf } = fixtureFor(flavor);
      const tightened = {
        ...budget[flavor],
        chunks: { ...budget[flavor].chunks, LightweightCharts: 6000 },
      };
      const { ok, failures } = evaluateBudget(files, sizeOf, tightened);
      expect(ok).toBe(false);
      expect(failures.some((f: string) => f.includes('LightweightCharts'))).toBe(true);
    });
  }

  it('findServerMarkers flags a server dist measured against the spa budget (#1702)', () => {
    // A real upload-only SPA build carries none of the boundary markers.
    const spaLike = ['index-DmhzAPGJ.js', 'LightweightCharts-Bos7EVXd.js'];
    const cleanContent = () => 'const x=1;export{x};';
    expect(findServerMarkers(spaLike, cleanContent)).toBeNull();

    // A server dist (the stale-dist mismatch from #1702) carries them.
    const serverLike = ['index-DBubzID8.js'];
    const serverContent = () => 'fetch("/api/dataset.json")';
    const hit = findServerMarkers(serverLike, serverContent);
    expect(hit).not.toBeNull();
    expect(hit?.file).toBe('index-DBubzID8.js');
    expect(SERVER_ONLY_MARKERS).toContain(hit?.marker);
  });

  it('a budgeted chunk that is absent from the build is reported as a failure (rename guard)', () => {
    const { files, sizeOf } = fixtureFor('server');
    const withGhost = {
      totalJsMaxBytes: budget.server.totalJsMaxBytes,
      chunks: { LightweightCharts: 8192, NotARealChunk: 1000 },
    };
    const { ok, failures, rows } = evaluateBudget(files, sizeOf, withGhost);
    expect(ok).toBe(false);
    expect(failures.some((f: string) => f.includes('NotARealChunk'))).toBe(true);
    const ghost = rows.find((r: { name: string }) => r.name === 'NotARealChunk');
    expect(ghost?.actual).toBeNull();
  });
});
