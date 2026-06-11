// Unit tests for the bundle-size budget gate (#1002, epic #718).
//
// The per-chunk gate had become vacuous: it budgeted the ~11 KB `ChartBar`
// chunk at 340 KB while the real ~243 KB victory/react-charts weight lived in
// the unbudgeted `ChartContainer` chunk, so no growth in the heavy chart code
// could ever trip the gate. These tests pin the corrected budget and prove the
// guard's intent by feeding `evaluateBudget` synthetic chunk sizes — no real
// build required — asserting the heavy chart chunk now has a budgeted line that
// fails when it grows past its headroom and passes at the committed ceiling.
//
// `evaluateBudget` / `chunkBaseName` are the pure core of
// scripts/check-bundle-size.mjs (the CLI just wires them to the filesystem).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// @ts-expect-error - plain .mjs script, no type declarations.
import { evaluateBudget, chunkBaseName } from '../../scripts/check-bundle-size.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const budget = JSON.parse(
  readFileSync(join(REPO_ROOT, 'bundle-budget.json'), 'utf8'),
);

// Real measured sizes: ChartContainer is the heavy chunk, ChartBar is small.
// The matcher keys on the logical chunk name (filename minus the trailing
// `-<8 hash chars>.js`), so we hand it hashed-looking names. The `index` size
// was re-measured after #1015 moved the Settings/FileUpload modals + fflate off
// the entry chunk (463,907 -> 416,383 B server / 414,227 B spa); we use the
// server value here as it must pass both flavors' (now tighter) index ceilings.
const MEASURED = {
  'index-DsPRUUwg.js': 416383,
  'ChartContainer-CF-J6Wa-.js': 243156,
  'ChartBar-M0eWbe84.js': 11080,
  'recommendations-kv7vJetP.js': 99608,
  'Insights-Dhfcm9BC.js': 40353,
};
const sizeOf = (f: string): number => {
  const n = (MEASURED as Record<string, number>)[f];
  if (n == null) throw new Error(`no synthetic size for ${f}`);
  return n;
};
const files = Object.keys(MEASURED);

describe('chunkBaseName', () => {
  it('strips exactly the trailing 8-char hash, even when the name has dashes', () => {
    expect(chunkBaseName('ChartContainer-CF-J6Wa-.js')).toBe('ChartContainer');
    expect(chunkBaseName('ChartBar-M0eWbe84.js')).toBe('ChartBar');
    expect(chunkBaseName('index-DsPRUUwg.js')).toBe('index');
  });
});

describe('bundle-budget.json — chart chunk gate (#1002)', () => {
  for (const flavor of ['server', 'spa'] as const) {
    it(`${flavor}: budgets the heavy ChartContainer chunk with real headroom`, () => {
      const chunks = budget[flavor].chunks;
      // The 243 KB chart chunk is now a budgeted line...
      expect(chunks.ChartContainer).toBeGreaterThanOrEqual(243156);
      // ...at ~256 KB, i.e. real (not vacuous) headroom over the measured size.
      expect(chunks.ChartContainer).toBeLessThanOrEqual(262144);
    });

    it(`${flavor}: ChartBar ceiling is shrunk to its real ~11 KB size, not the vacuous 340 KB`, () => {
      const chunks = budget[flavor].chunks;
      expect(chunks.ChartBar).toBeGreaterThanOrEqual(11080);
      expect(chunks.ChartBar).toBeLessThan(20000);
    });

    it(`${flavor}: passes at the committed ceilings against the real measured sizes`, () => {
      const { ok, rows, failures } = evaluateBudget(files, sizeOf, budget[flavor]);
      expect(failures).toEqual([]);
      expect(ok).toBe(true);
      // The chart chunk is genuinely represented, not MISSING.
      const cc = rows.find((r: { name: string }) => r.name === 'ChartContainer');
      expect(cc?.actual).toBe(243156);
      expect(cc?.ok).toBe(true);
    });

    it(`${flavor}: FAILS (non-zero) when the ChartContainer chunk grows past its ceiling`, () => {
      // Lower the ceiling below the measured size — the exact "verified by
      // lowering the ceiling and seeing a non-zero exit" Acceptance check.
      const tightened = {
        ...budget[flavor],
        chunks: { ...budget[flavor].chunks, ChartContainer: 200000 },
      };
      const { ok, failures } = evaluateBudget(files, sizeOf, tightened);
      expect(ok).toBe(false);
      expect(failures.some((f: string) => f.includes('ChartContainer'))).toBe(true);
    });
  }

  it('a budgeted chunk that is absent from the build is reported as a failure (rename guard)', () => {
    const withGhost = {
      totalJsMaxBytes: budget.server.totalJsMaxBytes,
      chunks: { ChartContainer: 262144, NotARealChunk: 1000 },
    };
    const { ok, failures, rows } = evaluateBudget(files, sizeOf, withGhost);
    expect(ok).toBe(false);
    expect(failures.some((f: string) => f.includes('NotARealChunk'))).toBe(true);
    const ghost = rows.find((r: { name: string }) => r.name === 'NotARealChunk');
    expect(ghost?.actual).toBeNull();
  });
});
