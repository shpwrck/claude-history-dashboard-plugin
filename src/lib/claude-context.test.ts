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
import type { ProjectStats, Session } from '../types';
import type { SessionOverview } from './session-overview';

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

describe('buildContext recommendations signal coverage (#2352)', () => {
  const baseSix = {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
  };

  it('labels omitted engine signals when only the base fields are supplied', () => {
    const out = buildContext({
      view: 'recommendations',
      data: baseSix,
    }) as Record<string, unknown>;
    const coverage = out.signalCoverage as
      | { omitted: string[]; note: string }
      | undefined;
    expect(coverage).toBeDefined();
    expect(coverage!.omitted).toContain('repoMap');
    expect(coverage!.omitted).toContain('modelEvalSummary');
    // The note must not claim other client surfaces see these signals — they
    // don't (Codex review on #2359); it may only point at supplied surfaces.
    expect(coverage!.note).toMatch(/surfaces supplied with them/);
  });

  it('shrinks the omission list as the envelope widens', () => {
    const out = buildContext({
      view: 'recommendations',
      data: { ...baseSix, repoMap: null, modelEvalSummary: null },
    }) as Record<string, unknown>;
    const coverage = out.signalCoverage as
      | { omitted: string[] }
      | undefined;
    expect(coverage).toBeDefined();
    expect(coverage!.omitted).not.toContain('repoMap');
    expect(coverage!.omitted).not.toContain('modelEvalSummary');
  });
});
