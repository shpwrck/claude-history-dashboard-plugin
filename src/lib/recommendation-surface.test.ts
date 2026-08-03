import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseRecommendationResult,
  recommendationSurfaceQuery,
  type RecommendationSurfaceRequest,
} from './recommendation-surface';
import type { RouteFilter } from './routing';
import { PROVENANCE_EXEMPT } from './detectors/provenance';

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

  it('accepts an omitted expiry or a canonical snapshot expiry, but rejects malformed boundaries', () => {
    expect(
      parseRecommendationResult({
        recommendations: [],
        domainCoverage: [],
        validThrough: '2026-07-21T12:34:56.789Z',
      })
    ).toEqual({
      recommendations: [],
      domainCoverage: [],
      validThrough: '2026-07-21T12:34:56.789Z',
    });

    for (const validThrough of [
      null,
      0,
      '',
      'not-a-date',
      '2026-07-21T12:34:56Z',
      '2026-07-21T08:34:56.789-04:00',
    ]) {
      expect(() =>
        parseRecommendationResult({
          recommendations: [],
          domainCoverage: [],
          validThrough,
        })
      ).toThrow('Invalid recommendation analysis response');
    }
  });

  it('validates every recommendation and coverage member before calling the envelope ready (#3166)', () => {
    const recommendation = {
      id: 'reliability.tool-errors',
      category: 'reliability',
      severity: 'warning',
      title: 'Tools with high error rates',
      detail: '2 of 5 Edit calls recorded an error outcome.',
      action: 'Inspect the failing calls.',
      affected: 2,
      estSavingsUsd: 1.25,
      evidence: ['Edit: 40% of 5'],
      provenance: {
        observations: [
          {
            claim: '2 of 5 Edit calls recorded an error outcome',
            source: 'parse-tools',
            field: 'toolData[].calls[].isError',
            value: 2,
          },
        ],
        inference: 'The observed error rate warrants investigation.',
        asOf: '2026-07-30',
      },
      claimClass: 'accounting',
      proofTier: 'auditable',
    };
    const coverage = { domain: 'success-rate', status: 'PROVE' };
    const envelope = {
      recommendations: [recommendation],
      domainCoverage: [coverage],
    };

    expect(parseRecommendationResult(envelope)).toEqual(envelope);

    const malformedMembers = [
      { recommendations: [null], domainCoverage: [coverage] },
      { recommendations: ['claim'], domainCoverage: [coverage] },
      {
        recommendations: [{ id: 'partial' }],
        domainCoverage: [coverage],
      },
      {
        recommendations: [{ ...recommendation, affected: Number.NaN }],
        domainCoverage: [coverage],
      },
      {
        recommendations: [{ ...recommendation, affected: -1 }],
        domainCoverage: [coverage],
      },
      {
        recommendations: [
          {
            ...recommendation,
            evidenceRefs: [{ sessionId: 's', entryIndex: -1 }],
          },
        ],
        domainCoverage: [coverage],
      },
      {
        recommendations: [
          {
            ...recommendation,
            evidenceRefs: [
              {
                sessionId: 's',
                entryIndex: 1,
                timestamp: '2026-02-30T00:00:00.000Z',
              },
            ],
          },
        ],
        domainCoverage: [coverage],
      },
      {
        recommendations: [
          {
            ...recommendation,
            provenance: {
              ...recommendation.provenance,
              observations: [
                {
                  ...recommendation.provenance.observations[0],
                  value: Number.POSITIVE_INFINITY,
                },
              ],
            },
          },
        ],
        domainCoverage: [coverage],
      },
      {
        recommendations: [
          {
            ...recommendation,
            provenance: undefined,
          },
        ],
        domainCoverage: [coverage],
      },
      { recommendations: [recommendation], domainCoverage: [null] },
      { recommendations: [recommendation], domainCoverage: [7] },
      {
        recommendations: [recommendation],
        domainCoverage: [{ domain: 'cost', status: 'UNKNOWN' }],
      },
    ];

    for (const malformed of malformedMembers) {
      expect(() => parseRecommendationResult(malformed)).toThrow(
        'Invalid recommendation analysis response'
      );
    }
  });

  // #3492 regression. That change required `provenance` on every wire
  // recommendation, but the engine's own `PROVENANCE_EXEMPT` register (#3205)
  // is the reviewed, shrink-only set of ids that legitimately emit none. Because
  // the envelope is validated all-or-nothing, a single exempt finding —
  // `cost.cache-1h-waste` and `speed.time-motion` fire on ordinary local data —
  // invalidated the whole response, and every recommendation surface rendered
  // "Analysis unavailable. Invalid recommendation analysis response" instead of
  // the analysis. The viewer cannot see the register, so it must not duplicate
  // the policy: provenance is validated when present and required engine-side.
  it('accepts a provenance-less recommendation for every PROVENANCE_EXEMPT id (#3492)', () => {
    const coverage = { domain: 'cost', status: 'PROVE' };
    expect(PROVENANCE_EXEMPT.length).toBeGreaterThan(0);

    for (const id of PROVENANCE_EXEMPT) {
      const envelope = {
        recommendations: [
          {
            id,
            category: 'cost',
            severity: 'warning',
            title: 'Reduce 1-hour cache writes',
            detail: '0.22M tokens were written to the 1-hour cache.',
            action: 'Check whether that context is genuinely reused.',
            affected: 2,
          },
        ],
        domainCoverage: [coverage],
      };
      expect(parseRecommendationResult(envelope)).toEqual(envelope);
    }
  });

  it('still rejects a present-but-malformed provenance (#3492)', () => {
    const base = {
      id: 'cost.cache-1h-waste',
      category: 'cost',
      severity: 'warning',
      title: 'Reduce 1-hour cache writes',
      detail: '0.22M tokens were written to the 1-hour cache.',
      action: 'Check whether that context is genuinely reused.',
    };
    for (const provenance of [null, 7, {}, { observations: [] }, { observations: [{}] }]) {
      expect(() =>
        parseRecommendationResult({
          recommendations: [{ ...base, provenance }],
          domainCoverage: [],
        })
      ).toThrow('Invalid recommendation analysis response');
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
    expect(registry).toContain(
      'datasetGeneration={analysisLoadOptions.refreshKey}'
    );
    expect(registry).toContain(
      'sourceEnabled={analysisLoadOptions.enabled ?? true}'
    );

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
