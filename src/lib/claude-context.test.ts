/**
 * Bounded repo-map injection into Ask Claude project/session context (#891,
 * epic #871).
 *
 * Asserts the two acceptance bullets:
 * - a bounded repo map is included under a configurable token/size cap, and the
 *   cap is enforced strictly;
 * - the map is omitted cleanly (no error, no `repoMap` key) when the server-only
 *   dataset is absent — the SPA flavor behaves exactly as before.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContext,
  buildRepoMapSlice,
  matchRepoMapProject,
  DEFAULT_REPO_MAP_TOKEN_CAP,
  type ProjectPayload,
  type SessionPayload,
} from './claude-context';
import type { RepoMapDataset } from './parse-repo-map-join';
import type { ProjectStats, Session, SessionTokenData } from '../types';
import type { SessionOverview } from './session-overview';
import type { Recommendation } from './detectors/types';

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A repo-map dataset with many files so the cap has something to cut. */
function makeDataset(fileCount = 200): RepoMapDataset {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `src/module-${i}/file-${i}.ts`,
    symbols: [
      {
        name: `doThing${i}`,
        kind: 'function' as const,
        exported: true,
        signature: `function doThing${i}(arg: SomeReallyLongTypeName${i}): Promise<void>`,
        line: i + 1,
      },
      {
        name: `Helper${i}`,
        kind: 'class' as const,
        exported: true,
        signature: `class Helper${i} extends BaseHelper`,
        line: i + 10,
      },
    ],
    imports: ['react', './types', `../module-${i}/util`],
    configSections: [],
    recommendations: [],
  }));
  return {
    projects: [
      {
        root: '/home/me/project/widgets',
        generatedAtGitSha: 'deadbeef',
        fileCount,
        truncated: false,
        text: 'rendered map text',
        files,
        configSections: [],
        configAttribution: [],
      },
    ],
  };
}

const projectStats: ProjectStats = {
  // dashboard project key is the dash-encoded root
  project: '-home-me-project-widgets',
  projectShort: 'widgets',
  sessionCount: 3,
  messageCount: 42,
  firstSeen: 1,
  lastSeen: 2,
  sessions: [],
};

const session: Session = {
  sessionId: 's1',
  project: '-home-me-project-widgets',
  projectShort: 'widgets',
  entries: [],
  startTime: 1,
  endTime: 2,
  duration: 1,
  messageCount: 3,
};

const overview: SessionOverview = {
  model: 'claude-sonnet-4-6',
  totalTokens: 100,
  estimatedCost: 0.01,
  uniqueTools: 0,
  totalToolInvocations: 0,
  topTools: [],
  topFiles: [],
  errorCount: 0,
  toolErrorCount: 0,
  apiErrorCount: 0,
  compactionCount: 0,
  peakContextTokens: 0,
  peakContextPercent: 0,
} as unknown as SessionOverview;

function approxTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

// ── matchRepoMapProject ─────────────────────────────────────────────────────

describe('matchRepoMapProject', () => {
  it('matches a dash-encoded project key to the repo-map root', () => {
    const ds = makeDataset(1);
    expect(matchRepoMapProject(ds, '-home-me-project-widgets')?.root).toBe(
      '/home/me/project/widgets'
    );
  });

  it('returns null when the dataset is absent', () => {
    expect(matchRepoMapProject(null, '-home-me-project-widgets')).toBeNull();
    expect(matchRepoMapProject(undefined, 'x')).toBeNull();
  });

  it('returns null when no project matches', () => {
    const ds = makeDataset(1);
    expect(matchRepoMapProject(ds, '-home-me-project-other')).toBeNull();
  });
});

// ── buildRepoMapSlice (cap enforcement) ─────────────────────────────────────

describe('buildRepoMapSlice', () => {
  it('returns null when the dataset is absent (SPA flavor)', () => {
    expect(buildRepoMapSlice(null, '-home-me-project-widgets')).toBeNull();
    expect(
      buildRepoMapSlice(undefined, '-home-me-project-widgets')
    ).toBeNull();
  });

  it('enforces the default token cap and flags truncation', () => {
    const ds = makeDataset(200);
    const slice = buildRepoMapSlice(ds, '-home-me-project-widgets');
    expect(slice).not.toBeNull();
    expect(approxTokens(slice)).toBeLessThanOrEqual(DEFAULT_REPO_MAP_TOKEN_CAP);
    // The full map is far larger than the cap, so rows were dropped.
    expect(slice!.files.length).toBeLessThan(200);
    expect(slice!.truncated).toBe(true);
    // fileCount still reflects the true total, not the capped count.
    expect(slice!.fileCount).toBe(200);
  });

  it('honors a configurable, smaller cap (stricter -> fewer files)', () => {
    const ds = makeDataset(200);
    const big = buildRepoMapSlice(ds, '-home-me-project-widgets', {
      tokenCap: 1500,
    });
    const small = buildRepoMapSlice(ds, '-home-me-project-widgets', {
      tokenCap: 300,
    });
    expect(approxTokens(small)).toBeLessThanOrEqual(300);
    expect(small!.files.length).toBeLessThan(big!.files.length);
  });

  it('keeps the whole map (no truncation) when it fits under the cap', () => {
    const ds = makeDataset(2);
    const slice = buildRepoMapSlice(ds, '-home-me-project-widgets', {
      tokenCap: DEFAULT_REPO_MAP_TOKEN_CAP,
    });
    expect(slice!.files.length).toBe(2);
    expect(slice!.truncated).toBe(false);
  });

  it('carries only structural facts (no source bodies / map text)', () => {
    const ds = makeDataset(3);
    const slice = buildRepoMapSlice(ds, '-home-me-project-widgets');
    const json = JSON.stringify(slice);
    expect(json).not.toContain('rendered map text');
    expect(slice!.files[0]).toHaveProperty('path');
    expect(slice!.files[0]).toHaveProperty('symbols');
    expect(slice!.files[0]).toHaveProperty('imports');
  });
});

// ── buildContext integration ────────────────────────────────────────────────

describe('buildContext repo-map injection', () => {
  it('omits repoMap from project context when the dataset is absent (SPA)', () => {
    const payload: ProjectPayload = {
      project: projectStats,
      tokenData: [],
      toolData: [],
      // no repoMap — SPA flavor
    };
    const out = buildContext({ view: 'projects', data: payload }) as Record<
      string,
      unknown
    >;
    expect('repoMap' in out).toBe(false);
  });

  it('includes a capped repoMap in project context when present (server)', () => {
    const payload: ProjectPayload = {
      project: projectStats,
      tokenData: [],
      toolData: [],
      repoMap: makeDataset(200),
    };
    const out = buildContext({ view: 'projects', data: payload }) as Record<
      string,
      unknown
    >;
    expect('repoMap' in out).toBe(true);
    expect(approxTokens(out.repoMap)).toBeLessThanOrEqual(
      DEFAULT_REPO_MAP_TOKEN_CAP
    );
  });

  it('omits repoMap from session context when the dataset is absent (SPA)', () => {
    const payload: SessionPayload = {
      session,
      overview,
      apiErrors: [],
      // no repoMap — SPA flavor
    };
    const out = buildContext({ view: 'sessions', data: payload }) as Record<
      string,
      unknown
    >;
    expect('repoMap' in out).toBe(false);
  });

  it('includes a capped repoMap in session context when present (server)', () => {
    const payload: SessionPayload = {
      session,
      overview,
      apiErrors: [],
      repoMap: makeDataset(200),
    };
    const out = buildContext({ view: 'sessions', data: payload }) as Record<
      string,
      unknown
    >;
    expect('repoMap' in out).toBe(true);
    expect(approxTokens(out.repoMap)).toBeLessThanOrEqual(
      DEFAULT_REPO_MAP_TOKEN_CAP
    );
  });

  it('omits repoMap when the focused project has no matching map entry', () => {
    const payload: ProjectPayload = {
      project: { ...projectStats, project: '-home-me-project-unmapped' },
      tokenData: [],
      toolData: [],
      repoMap: makeDataset(5),
    };
    const out = buildContext({ view: 'projects', data: payload }) as Record<
      string,
      unknown
    >;
    expect('repoMap' in out).toBe(false);
  });
});

describe('buildContext version claims (#3653)', () => {
  // groupBySessions never sets Session.version, so the context builders must
  // source it from the transcript-derived token join (#3405's mechanism) or
  // the claims silently vanish in production.
  function makeTokenData(
    sessionId: string,
    version: string | undefined
  ): SessionTokenData {
    return {
      sessionId,
      version,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      model: 'claude-sonnet-4-6',
      messageCount: 2,
      entries: [],
      compactionEvents: [],
    } as unknown as SessionTokenData;
  }

  it('session context takes version from the token join when Session.version is absent (production shape)', () => {
    const payload: SessionPayload = {
      session, // no version — matches groupBySessions output
      overview,
      tokenData: makeTokenData('s1', '2.1.230'),
      apiErrors: [],
    };
    const out = buildContext({ view: 'sessions', data: payload }) as Record<
      string,
      unknown
    >;
    expect(out.version).toBe('2.1.230');
  });

  it('session context still honors an explicitly populated Session.version', () => {
    const payload: SessionPayload = {
      session: { ...session, version: '2.1.199' },
      overview,
      apiErrors: [],
    };
    const out = buildContext({ view: 'sessions', data: payload }) as Record<
      string,
      unknown
    >;
    expect(out.version).toBe('2.1.199');
  });

  it('project context folds token-row versions in for sessions of this project only', () => {
    const payload: ProjectPayload = {
      project: {
        ...projectStats,
        sessions: [session, { ...session, sessionId: 's2' }],
      },
      tokenData: [
        makeTokenData('s1', '2.1.230'),
        makeTokenData('s2', '2.1.199'),
        makeTokenData('s-other-project', '9.9.9'),
        makeTokenData('s2-noversion', undefined),
      ],
      toolData: [],
    };
    const out = buildContext({ view: 'projects', data: payload }) as {
      versions: string[];
    };
    expect(out.versions).toContain('2.1.230');
    expect(out.versions).toContain('2.1.199');
    expect(out.versions).not.toContain('9.9.9');
  });
});

describe('buildContext recommendations (viewer-only, #2719)', () => {
  // Ask Claude no longer runs the engine — the recommendations context is built
  // from the SAME server-computed findings the Recommendations page shows, passed
  // in pre-built. There are no "omitted signals" to label (the server computes the
  // full detector set), and buildRecommendationsContext never touches the engine.
  const recs = [
    {
      id: 'cost.output-heavy',
      category: 'cost',
      severity: 'warning',
      title: 'Trim output tokens on mechanical tasks',
      detail: 'Output tokens dominate spend on short tasks.',
      action: 'Ask for terser answers.',
      estSavingsUsd: 12.5,
      affected: 3,
    },
    {
      id: 'safety.dangerous-rule',
      category: 'safety',
      severity: 'critical',
      title: 'Remove a dangerous allow rule',
      detail: 'A broad allow rule bypasses confirmation.',
      action: 'Scope the rule down.',
      affected: 1,
    },
  ] as unknown as Recommendation[];

  it('formats the shared server findings without running the engine or labelling omitted signals', () => {
    const out = buildContext({
      view: 'recommendations',
      data: { recommendations: recs },
    }) as Record<string, unknown>;
    expect(out.view).toBe('recommendations');
    expect(out.totalRecommendations).toBe(2);
    expect(out.bySeverity).toEqual({ critical: 1, warning: 1, info: 0 });
    expect(out.totalEstimatedSavingsUsd).toBeCloseTo(12.5, 2);
    // Viewer-only: no signalCoverage key (the server sees the full detector set).
    expect(out.signalCoverage).toBeUndefined();
    expect(Array.isArray(out.recommendations)).toBe(true);
    expect((out.recommendations as unknown[]).length).toBe(2);
  });

  it('preserves bounded evidence, provenance, proof posture, and attribution (#3116)', () => {
    const evidence = ['session-1: Edit failed twice'];
    const evidenceRefs = [
      {
        sessionId: 'session-1',
        entryIndex: 4,
        entryId: 'record-1:0',
        timestamp: '2026-07-30T12:00:00.000Z',
        toolUseId: 'tool-1',
      },
    ];
    const provenance = {
      observations: [
        {
          claim: '2 Edit calls recorded an error outcome',
          source: 'parse-tools',
          record: 'session-1',
          field: 'toolData[].calls[].isError',
          value: 2,
        },
      ],
      inference: 'The observed errors warrant inspection.',
      asOf: '2026-07-30',
    };
    const savingsAttribution = {
      interventionKey: 'reliability.tool-errors',
      signatureId: 'edit-errors',
      tier: 'tier-0-estimate',
      predictedSavingsUsd: 1.25,
      sampleSize: 2,
      asOf: '2026-07-30',
    } as const;
    const recommendation = {
      id: 'reliability.tool-errors',
      category: 'reliability',
      severity: 'warning',
      title: 'Tools with high error rates',
      detail: 'Two Edit calls failed.',
      action: 'Inspect the failing calls.',
      evidence,
      evidenceRefs,
      provenance,
      claimClass: 'accounting',
      proofTier: 'auditable',
      savingsAttribution,
    } as unknown as Recommendation;

    const out = buildContext({
      view: 'recommendations',
      data: { recommendations: [recommendation] },
    }) as {
      recommendations: Array<Record<string, unknown>>;
    };

    expect(out.recommendations[0]).toMatchObject({
      evidence,
      evidenceRefs,
      provenance,
      claimClass: 'accounting',
      proofTier: 'auditable',
      savingsAttribution,
    });
  });

  it('keeps the complete recommendation projection under the context ceiling', () => {
    const huge = 'x'.repeat(5_000);
    const recommendation = {
      id: 'reliability.bounded-receipt',
      category: 'reliability',
      severity: 'warning',
      title: huge,
      detail: huge,
      action: huge,
      evidence: Array.from({ length: 20 }, () => huge),
      evidenceRefs: Array.from({ length: 20 }, (_, entryIndex) => ({
        sessionId: huge,
        entryIndex,
        timestamp: '2026-07-30T12:00:00.000Z',
        toolUseId: huge,
      })),
      provenance: {
        observations: Array.from({ length: 20 }, (_, index) => ({
          id: `${index}-${huge}`,
          claim: huge,
          source: huge,
          record: huge,
          field: huge,
          value: huge,
        })),
        derivations: Array.from({ length: 20 }, (_, index) => ({
          id: `${index}-${huge}`,
          formula: huge,
          operands: Object.fromEntries(
            Array.from({ length: 20 }, (__, operand) => [
              `${operand}-${huge}`,
              huge,
            ])
          ),
          value: huge,
        })),
        inference: huge,
        asOf: '2026-07-30',
      },
      claimClass: 'accounting',
      proofTier: 'auditable',
    } as unknown as Recommendation;
    const out = buildContext({
      view: 'recommendations',
      data: {
        recommendations: Array.from({ length: 20 }, (_, index) => ({
          ...recommendation,
          id: `reliability.bounded-receipt-${index}`,
        })),
      },
    }) as { recommendations: Array<Record<string, unknown>> };

    expect(out.recommendations.length).toBeGreaterThan(0);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(10 * 1024);
  });

  it('renders an empty context for an empty ready result', () => {
    const out = buildContext({
      view: 'recommendations',
      data: { recommendations: [], analysisStatus: 'ready' },
    }) as Record<string, unknown>;
    expect(out.totalRecommendations).toBe(0);
    expect(out.bySeverity).toEqual({ critical: 0, warning: 0, info: 0 });
    expect(out.signalCoverage).toBeUndefined();
  });

  it('preserves a non-ready analysis state instead of claiming zero findings', () => {
    const out = buildContext({
      view: 'recommendations',
      data: {
        recommendations: [],
        analysisStatus: 'error',
        analysisError: 'Analysis request failed',
      },
    }) as Record<string, unknown>;

    expect(out.analysisStatus).toBe('error');
    expect(out.analysisError).toBe('Analysis request failed');
    expect(out.totalRecommendations).toBeNull();
    expect(out.bySeverity).toBeUndefined();
  });
});
