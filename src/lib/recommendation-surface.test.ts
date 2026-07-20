import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseRecommendationResult,
  recommendationSurfaceQuery,
  type RecommendationSurfaceRequest,
} from './recommendation-surface';
import type { RouteFilter } from './routing';

// ── Query serializer contract (#2719) — the client half of the #2718 surface. ──
describe('recommendationSurfaceQuery', () => {
  it('serializes only the masthead filters on the global surface', () => {
    const q = recommendationSurfaceQuery({
      surface: 'global',
      dashboard: { time: '7d', project: 'alpha' },
    });
    const p = new URLSearchParams(q);
    expect(p.get('surface')).toBe('global');
    expect(p.get('dashboardTime')).toBe('7d');
    expect(p.get('dashboardProject')).toBe('alpha');
    expect(p.has('routeMode')).toBe(false);
  });

  it('adds only the truthy route filters on reclaim-compass — never rec/family', () => {
    const route = {
      mode: 'opus',
      project: 'beta',
      date: '2026-01-01',
      entrypoint: '',
      rec: 'cost.x',
      family: 'cost',
    } as RouteFilter;
    const q = recommendationSurfaceQuery({
      surface: 'reclaim-compass',
      dashboard: { time: '24h', project: 'All projects' },
      route,
    });
    const p = new URLSearchParams(q);
    expect(p.get('surface')).toBe('reclaim-compass');
    expect(p.get('dashboardTime')).toBe('24h');
    expect(p.get('routeMode')).toBe('opus');
    expect(p.get('routeProject')).toBe('beta');
    expect(p.get('routeDate')).toBe('2026-01-01');
    // Empty route value is omitted (server would treat it as no-op anyway).
    expect(p.has('routeEntrypoint')).toBe(false);
    // rec/family are NOT valid surface params — the #2718 server 400s on them.
    expect(p.has('rec')).toBe(false);
    expect(p.has('family')).toBe(false);
  });

  it('never serializes route params on the global surface', () => {
    const q = recommendationSurfaceQuery({
      surface: 'global',
      dashboard: { time: '24h', project: 'All projects' },
      route: { mode: 'opus' } as RouteFilter,
    });
    expect(new URLSearchParams(q).has('routeMode')).toBe(false);
  });

  it('is deterministic for a given scope (doubles as the loader scope key)', () => {
    const req: RecommendationSurfaceRequest = {
      surface: 'reclaim-compass',
      dashboard: { time: '30d', project: 'x' },
      route: { mode: 'opus', project: 'y' } as RouteFilter,
    };
    expect(recommendationSurfaceQuery(req)).toBe(recommendationSurfaceQuery(req));
  });
});

describe('parseRecommendationResult', () => {
  it('accepts only an envelope with explicit findings and coverage arrays', () => {
    expect(
      parseRecommendationResult({ recommendations: [], domainCoverage: [] })
    ).toEqual({ recommendations: [], domainCoverage: [] });

    for (const malformed of [
      {},
      [],
      { recommendations: null, domainCoverage: [] },
      { recommendations: [], domainCoverage: null },
    ]) {
      expect(() => parseRecommendationResult(malformed)).toThrow(
        'Invalid recommendation analysis response'
      );
    }
  });
});

// ── Viewer-only engine boundary (#2719) — source-contract proof, no build ──────
// A fast companion to the built-dist engine-absence gate
// (scripts/check-engine-absent.mjs): it catches a VALUE import of the engine
// reaching browser code at unit-test time, before a full build runs.
describe('viewer-only engine boundary (#2719)', () => {
  const read = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), 'utf8');
  const valueBarrelImports = (src: string, mod: string) =>
    src
      .split('\n')
      .filter(
        (l) =>
          /^\s*import\b/.test(l) &&
          l.includes(`from '${mod}'`) &&
          !/^\s*import\s+type\b/.test(l)
      );

  it('the loader hook never imports the engine or the detector catalog', () => {
    const s = read('./use-recommendations.ts');
    expect(s).not.toMatch(/from '\.\/recommendations'/);
    expect(s).not.toMatch(/from '\.\/detectors'/);
  });

  it('the Ask Claude context builder imports Recommendation type-only', () => {
    const s = read('./claude-context.ts');
    expect(valueBarrelImports(s, './recommendations')).toEqual([]);
    expect(s).not.toMatch(/^\s*import\b[^\n;]*from '\.\/detectors'/m);
  });

  it('the client-safe surface module type-only imports and never reaches detectors', () => {
    const s = read('./recommendation-surface.ts');
    expect(valueBarrelImports(s, './recommendations')).toEqual([]);
    expect(s).not.toMatch(/^\s*import\b[^\n;]*from '\.\/detectors'/m);
  });

  it('App gates every analysis on authenticated local data and keys reloads', () => {
    const app = read('../App.tsx');
    const wiringStart = app.indexOf(
      'const recommendationAnalysisLoadOptions'
    );
    const wiring = app.slice(
      wiringStart,
      app.indexOf('// #2450: the boot stand-in', wiringStart)
    );
    expect(wiring).toContain('enabled: dataAccessReady && activeSource !== null');
    expect(wiring).toContain('refreshKey: recommendationDatasetGeneration');
    expect(app).toContain(
      'analysisLoadOptions: recommendationAnalysisLoadOptions'
    );

    const registry = read('./view-registry.tsx');
    expect(registry).toContain('analysisLoadOptions={analysisLoadOptions}');

    const cost = read('../components/CostAttribution.tsx');
    expect(cost).toContain(
      'useRecommendationSurface(\n    {\n      surface: \'reclaim-compass\''
    );
    expect(cost).toContain('analysisLoadOptions\n  );');

    const applyDataset = app.slice(
      app.indexOf('const applyDataset = useCallback'),
      app.indexOf('const reloadFromDisk')
    );
    expect(applyDataset).toContain('setRecommendationDatasetGeneration');
  });
});
