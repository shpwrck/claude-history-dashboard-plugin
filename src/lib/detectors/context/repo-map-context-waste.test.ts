import { describe, it, expect } from 'vitest';
import { detector } from './repo-map-context-waste';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData } from '../../parse-tools';
import type {
  RepoMapDataset,
  RepoMapFileJoin,
  RepoMapProjectJoin,
} from '../../parse-repo-map-join';
import type { RepoSymbol } from '../../repo-map/types';
import type { ChurnStat } from '../../parse-files';
import { runReclaimCascade, scopeKeyOf } from '../../reclaim';

// ── Fixture builders ────────────────────────────────────────────────────────
const sym = (name: string, exported = true): RepoSymbol => ({
  name,
  kind: 'function',
  exported,
  signature: `function ${name}()`,
  line: 1,
});

const churn = (n: number): ChurnStat => ({
  filePath: 'x',
  churn: n,
  edits: n,
  writes: 0,
  sessions: 1,
  editsPerSession: n,
});

const file = (over: Partial<RepoMapFileJoin> & { path: string }): RepoMapFileJoin => ({
  symbols: [],
  imports: [],
  configSections: [],
  recommendations: [],
  ...over,
});

const reread = (
  sessions: number,
  tokens: number
): NonNullable<RepoMapFileJoin['reread']> => ({
  sessions,
  totalReads: sessions * 3,
  totalEstimatedTokenWaste: tokens,
  maxPerSession: 3,
});

const project = (files: RepoMapFileJoin[]): RepoMapProjectJoin => ({
  root: '/repo',
  generatedAtGitSha: 'abc123',
  fileCount: files.length,
  truncated: false,
  text: '(map)',
  files,
  configSections: [],
  configAttribution: [],
});

const dataset = (...projects: RepoMapProjectJoin[]): RepoMapDataset => ({ projects });

// Tool reads of a path within a session (N reads → reread waste for that scope).
const reads = (sessionId: string, path: string, n: number, bytesEach = 4000): ToolUsageData => ({
  sessionId,
  calls: Array.from({ length: n }, (_, i) => ({
    timestamp: `2026-06-09T00:00:0${i}Z`,
    toolName: 'Read',
    input: { file_path: path },
    toolUseId: `t${i}`,
    isError: null,
    resultBytes: bytesEach,
  })) as unknown as ToolUsageData['calls'],
});

const token = (sessionId: string, model: string, cacheRead: number): SessionTokenData =>
  ({
    sessionId,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: cacheRead,
    entries: [
      {
        timestamp: 't',
        model,
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: cacheRead,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: [],
  } as unknown as SessionTokenData);

const input = (over: Partial<RecommendationInput>): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  ...over,
});

const find = (i: RecommendationInput) => detector.rule(i, 0);

describe('context.repo-map-context-waste (#890, epic #871 + #944)', () => {
  it('emits nothing when no repo map is present (SPA dataset)', () => {
    expect(find(input({ repoMap: null }))).toBeNull();
    expect(find(input({}))).toBeNull();
    expect(find(input({ repoMap: dataset() }))).toBeNull();
  });

  it('selects a stable exported-API, read-only file re-read across sessions', () => {
    const map = dataset(
      project([
        file({
          path: 'src/lib/reclaim.ts',
          symbols: [sym('runReclaimCascade'), sym('scopeKeyOf')],
          reread: reread(3, 5000),
        }),
      ])
    );
    const rec = find(input({ repoMap: map }));
    expect(rec?.id).toBe('context.repo-map-context-waste');
    expect(rec?.category).toBe('context');
    // Names the specific file AND its symbols, not a bare path list.
    expect(rec?.evidence?.[0]).toContain('src/lib/reclaim.ts');
    expect(rec?.evidence?.[0]).toContain('runReclaimCascade');
    expect(rec?.affected).toBe(1);
  });

  it('selects a config-backed read-only file even without exported symbols', () => {
    const map = dataset(
      project([
        file({
          path: 'config/limits.json',
          symbols: [],
          configSections: ['rate-limits'],
          reread: reread(2, 3000),
        }),
      ])
    );
    const rec = find(input({ repoMap: map }));
    expect(rec).not.toBeNull();
    expect(rec?.evidence?.[0]).toContain('config/limits.json');
    expect(rec?.evidence?.[0]).toContain('config section');
  });

  it('selects a high-centrality read-only file (imported by >=2 siblings)', () => {
    const target = file({
      path: 'src/lib/util.ts',
      symbols: [sym('helper', false)], // not exported → not stable-api
      reread: reread(2, 2000),
    });
    const map = dataset(
      project([
        target,
        file({ path: 'src/a.ts', imports: ['./lib/util'] }),
        file({ path: 'src/b.ts', imports: ['../lib/util'] }),
      ])
    );
    const rec = find(input({ repoMap: map }));
    expect(rec).not.toBeNull();
    expect(rec?.evidence?.[0]).toContain('src/lib/util.ts');
    expect(rec?.evidence?.[0]).toContain('imported by 2 files');
  });

  it('skips a churned (actively-edited) file — not stable to pin', () => {
    const map = dataset(
      project([
        file({
          path: 'src/lib/reclaim.ts',
          symbols: [sym('runReclaimCascade')],
          churn: churn(5),
          reread: reread(3, 5000),
        }),
      ])
    );
    expect(find(input({ repoMap: map }))).toBeNull();
  });

  it('skips a re-read file with no structural signal (no API, no config, low centrality)', () => {
    const map = dataset(
      project([
        file({
          path: 'src/scratch.ts',
          symbols: [sym('internal', false)],
          reread: reread(3, 5000),
        }),
      ])
    );
    expect(find(input({ repoMap: map }))).toBeNull();
  });

  it('skips a stable file that was NOT re-read', () => {
    const map = dataset(
      project([file({ path: 'src/lib/reclaim.ts', symbols: [sym('x')] })])
    );
    expect(find(input({ repoMap: map }))).toBeNull();
  });

  it('self-suppresses on the stable-reference CLAUDE.md note', () => {
    const map = dataset(
      project([
        file({ path: 'src/lib/reclaim.ts', symbols: [sym('x')], reread: reread(3, 5000) }),
      ])
    );
    const md =
      '## Stable reference files\n\nReference these stable files instead of re-reading them each session: @src/lib/reclaim.ts';
    const rec = find(
      input({
        repoMap: map,
        liveConfig: { claudeMd: { global: md } } as unknown as RecommendationInput['liveConfig'],
      })
    );
    expect(rec).toBeNull();
  });

  describe('reclaim metadata (epic #944, PR3)', () => {
    // A stable file re-read 4× in one session, with cache-read tokens to book against.
    const buildScoped = () => {
      const path = 'src/lib/reclaim.ts';
      const map = dataset(
        project([file({ path, symbols: [sym('runReclaimCascade')], reread: reread(1, 3000) })])
      );
      const toolData = [reads('s1', `/repo/${path}`, 4)];
      const tokenData = [token('s1', 'claude-opus-4-8', 1_000_000)];
      return { map, toolData, tokenData };
    };

    it('carries a structural-prefix scaleTokens claim the cascade books to a positive marginal', () => {
      const { map, toolData, tokenData } = buildScoped();
      const rec = find(input({ repoMap: map, toolData, tokenData }));
      expect(rec?.reclaim).toBeDefined();
      const claim = rec!.reclaim!;
      expect(claim.leverId).toBe('context.repo-map-context-waste');
      expect(claim.category).toBe('context');
      expect(claim.cause).toBe('structural-prefix');
      expect(claim.orderKey).toBeGreaterThanOrEqual(40);
      expect(claim.orderKey).toBeLessThan(90);
      expect(claim.counterfactual.kind).toBe('scaleTokens');
      expect(claim.ownedPools).toEqual(['cacheRead']);
      expect(claim.scopeKeys).toEqual([scopeKeyOf('s1', 'claude-opus-4-8')]);
      expect(claim.evidenceTokens).toBeGreaterThan(0);

      const result = runReclaimCascade([claim], tokenData);
      const booked = result.booked[0];
      expect(booked.rejected).toBe(false);
      expect(booked.marginalUsd).toBeGreaterThan(0);
      // Identity: sum(marginal) ≡ billOriginal − billFinal, residual ≥ 0.
      expect(result.total).toBeCloseTo(result.billOriginal - result.billFinal, 9);
      expect(result.billFinal).toBeGreaterThanOrEqual(0);
    });

    it('omits the reclaim claim when the candidate file maps to no re-reading scope', () => {
      // Stable + re-read in the MAP, but no tool/token data → no scope to book.
      const map = dataset(
        project([
          file({ path: 'src/lib/reclaim.ts', symbols: [sym('x')], reread: reread(3, 5000) }),
        ])
      );
      const rec = find(input({ repoMap: map }));
      expect(rec).not.toBeNull(); // advisory finding still fires
      expect(rec?.reclaim).toBeUndefined();
    });

    it('grounds the deletion fraction in the measured reread tokens (not a constant)', () => {
      const { map, toolData, tokenData } = buildScoped();
      const rec = find(input({ repoMap: map, toolData, tokenData }));
      const frac = (
        rec!.reclaim!.counterfactual as { poolDeltaFrac: Record<string, number> }
      ).poolDeltaFrac.cacheRead;
      // 4 reads of 4000 bytes → waste = (4-1)*4000/4 = 3000 tokens over 1M cacheRead.
      expect(frac).toBeCloseTo(3000 / 1_000_000, 9);
      expect([0, 0.1, 0.25, 0.5, 1]).not.toContain(frac);
    });

    it('clamps the deletion fraction to [0,1] when reread waste exceeds the cache-read pool (dc-reclaim-3)', () => {
      // Re-read CONTENT tokens (3000 waste from 4 reads) and the cacheRead PREFIX
      // pool (1000) are different token populations, so the raw ratio is 3.0.
      // Unclamped, scaleTokens(keep=max(0,1-3)=0) would delete the ENTIRE pool.
      const path = 'src/lib/reclaim.ts';
      const map = dataset(
        project([file({ path, symbols: [sym('runReclaimCascade')], reread: reread(1, 3000) })])
      );
      const toolData = [reads('s1', `/repo/${path}`, 4)]; // waste = (4-1)*4000/4 = 3000 tokens
      const tokenData = [token('s1', 'claude-opus-4-8', 1000)]; // pool = 1000 cacheRead < waste
      const rec = find(input({ repoMap: map, toolData, tokenData }));
      const frac = (
        rec!.reclaim!.counterfactual as { poolDeltaFrac: Record<string, number> }
      ).poolDeltaFrac.cacheRead;
      expect(frac).toBe(1); // clamped; raw ratio would be 3.0
      // The cascade can never delete more than the owned pool: residual stays >= 0.
      const result = runReclaimCascade([rec!.reclaim!], tokenData);
      expect(result.billFinal).toBeGreaterThanOrEqual(0);
    });

    it('carries the reread-token estimate in the detail and evidence', () => {
      const map = dataset(
        project([file({ path: 'src/lib/reclaim.ts', symbols: [sym('x')], reread: reread(3, 5000) })])
      );
      const rec = find(input({ repoMap: map }));
      expect(rec?.detail).toContain('5,000 tokens');
      expect(rec?.evidence?.[0]).toContain('5,000 tokens');
    });
  });

  describe('centrality — single linear pass, identical numbers/ordering (#718)', () => {
    it('reports the exact in-degree count (3 importing siblings → "imported by 3 files")', () => {
      const target = file({
        path: 'src/lib/util.ts',
        symbols: [sym('helper', false)], // not exported → centrality is the only signal
        reread: reread(2, 2000),
      });
      const map = dataset(
        project([
          target,
          file({ path: 'src/a.ts', imports: ['./lib/util'] }),
          file({ path: 'src/b.ts', imports: ['../lib/util'] }),
          file({ path: 'src/c.ts', imports: ['./util', './lib/util'] }), // dup spec → counts once
          file({ path: 'src/d.ts', imports: ['react'] }), // bare pkg → no match
        ])
      );
      const rec = find(input({ repoMap: map }));
      // a, b, c each import util once (c's duplicate specs collapse) → 3, not 4.
      expect(rec?.evidence?.[0]).toContain('imported by 3 files');
    });

    it('excludes the file itself from its own centrality (self-import nets out)', () => {
      // util imports its own basename; it must NOT count toward its centrality.
      // One real sibling importer remains, which is below CENTRALITY_FLOOR (2),
      // so with no other structural signal the file is not selected.
      const map = dataset(
        project([
          file({
            path: 'src/lib/util.ts',
            symbols: [sym('helper', false)],
            imports: ['./util'], // self-import by basename
            reread: reread(2, 2000),
          }),
          file({ path: 'src/a.ts', imports: ['./lib/util'] }),
        ])
      );
      expect(find(input({ repoMap: map }))).toBeNull();
    });

    it('counts a same-basename sibling toward centrality (only the candidate is excluded by path)', () => {
      // Two distinct files share basename "util". A third file imports "util";
      // the OTHER same-basename file (b/util) imports it too. For a/util the
      // count is: c.ts (1) + b/util (1) = 2 ≥ floor → selected.
      const map = dataset(
        project([
          file({
            path: 'src/a/util.ts',
            symbols: [sym('helper', false)],
            reread: reread(2, 2000),
          }),
          file({ path: 'src/b/util.ts', imports: ['./util'] }),
          file({ path: 'src/c.ts', imports: ['./util'] }),
        ])
      );
      const rec = find(input({ repoMap: map }));
      expect(rec).not.toBeNull();
      expect(rec?.evidence?.[0]).toContain('imported by 2 files');
    });

    it('preserves candidate ordering across many files (centrality is the tiebreak)', () => {
      // Two equally-priced reread candidates; the higher-centrality one ranks
      // first. Build a wide project so a quadratic rescan would diverge if the
      // single-pass index were wrong — assert the order is unchanged.
      const importers = (target: string, n: number) =>
        Array.from({ length: n }, (_, i) =>
          file({ path: `src/imp-${target}-${i}.ts`, imports: [`./${target}`] })
        );
      const map = dataset(
        project([
          file({ path: 'src/low.ts', symbols: [sym('a')], reread: reread(1, 5000) }),
          file({ path: 'src/high.ts', symbols: [sym('b')], reread: reread(1, 5000) }),
          ...importers('low', 2),
          ...importers('high', 5),
        ])
      );
      const rec = find(input({ repoMap: map }));
      // Equal reread tokens → centrality breaks the tie → high.ts first.
      expect(rec?.evidence?.[0]).toContain('src/high.ts');
      expect(rec?.evidence?.[1]).toContain('src/low.ts');
    });
  });

  it('ranks candidates by reread-token waste, surfacing the costliest first', () => {
    const map = dataset(
      project([
        file({ path: 'src/cheap.ts', symbols: [sym('a')], reread: reread(1, 100) }),
        file({ path: 'src/pricey.ts', symbols: [sym('b')], reread: reread(1, 9000) }),
      ])
    );
    const rec = find(input({ repoMap: map }));
    expect(rec?.evidence?.[0]).toContain('src/pricey.ts');
    expect(rec?.affected).toBe(2);
  });
});
