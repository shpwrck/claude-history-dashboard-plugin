import { describe, it, expect } from 'vitest';
import { buildRecommendations } from '../../recommendations';
import type { RecommendationInput } from '../types';
import type { ConfigSection } from '../../parse-config-sections';
import type {
  RepoMapDataset,
  RepoMapFileJoin,
  RepoMapProjectJoin,
} from '../../parse-repo-map-join';
import { parseShadowCalls } from '../../parse-shadow-calls';
import type { ShadowCallAggregate } from '../../parse-shadow-calls';
import { validateRecommendationProvenance } from '../provenance';
import { detector } from './over-scoped-config-section';

const section = (over: Partial<ConfigSection> & { id: string; heading: string }): ConfigSection => ({
  sourceScope: 'AGENTS.md',
  level: 2,
  mtime: null,
  hash: 'hash',
  references: [],
  ...over,
});

const file = (
  path: string,
  configSections: string[]
): RepoMapFileJoin => ({
  path,
  symbols: [],
  imports: [],
  configSections,
  recommendations: [],
});

const project = (
  configSections: ConfigSection[],
  files: RepoMapFileJoin[]
): RepoMapProjectJoin => ({
  root: '/repo',
  generatedAtGitSha: 'abc123',
  fileCount: files.length,
  truncated: false,
  text: '(map)',
  files,
  configSections,
  configAttribution: [],
});

const dataset = (...projects: RepoMapProjectJoin[]): RepoMapDataset => ({ projects });

const input = (
  repoMap: RepoMapDataset | null | undefined,
  shadowCalls?: ShadowCallAggregate
): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  repoMap,
  shadowCalls,
});

const overScopedRecs = (i: RecommendationInput) =>
  buildRecommendations(i).filter((rec) =>
    rec.id.startsWith('context.over-scoped-config-section')
  );

describe('context.over-scoped-config-section (#1267)', () => {
  it('emits one advisory recommendation per root section scoped to one subtree', () => {
    const api = section({
      id: 'AGENTS.md#spa-server-boundary',
      heading: 'SPA server boundary',
    });
    const ui = section({
      id: 'CLAUDE.md#session-ui',
      sourceScope: 'CLAUDE.md',
      heading: 'Session UI rules',
    });
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [api, ui],
            [
              file('src/lib/api-client.ts', [api.id]),
              file('src/lib/api-client.test.ts', [api.id]),
              file('src/components/SessionList.tsx', [ui.id]),
            ]
          )
        )
      )
    );

    expect(recs).toHaveLength(2);
    expect(new Set(recs.map((rec) => rec.id)).size).toBe(2);
    expect(recs.map((rec) => rec.severity)).toEqual(['info', 'info']);

    const apiRec = recs.find((rec) => rec.title.includes('SPA server boundary'))!;
    expect(apiRec.title).toContain('src/lib');
    expect(apiRec.detail).toContain('SPA server boundary');
    expect(apiRec.detail).toContain('src/lib');
    expect(apiRec.action).toContain('paths: ["src/lib/**"]');
    expect(apiRec.evidence?.[0]).toContain('AGENTS.md#spa-server-boundary');
    expect(apiRec.fix?.target).toBe('CLAUDE.md');
    expect(apiRec.fix?.fixKind).toBe('illustrative');
    expect(apiRec.fix?.snippet).toContain('paths: ["src/lib/**"]');
    expect(apiRec.fix?.snippet).toContain('.claude/rules/spa-server-boundary.md');
    expect(apiRec.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(validateRecommendationProvenance(apiRec)).toEqual([]);
  });

  it('keeps the compatibility rule path on the base detector id', () => {
    const api = section({
      id: 'AGENTS.md#spa-server-boundary',
      heading: 'SPA server boundary',
    });
    const rec = detector.rule(
      input(dataset(project([api], [file('src/lib/api-client.ts', [api.id])]))),
      0
    );

    expect(rec?.id).toBe('context.over-scoped-config-section');
  });

  it('does not fire for a genuinely cross-cutting root section', () => {
    const crossCutting = section({
      id: 'AGENTS.md#shared-discipline',
      heading: 'Shared discipline',
    });
    const recs = overScopedRecs(
      input(
        dataset(
          project(
            [crossCutting],
            [
              file('src/lib/api-client.ts', [crossCutting.id]),
              file('src/components/Recommendations.tsx', [crossCutting.id]),
            ]
          )
        )
      )
    );

    expect(recs).toHaveLength(0);
  });

  it('does not fire for an already path-scoped rule section', () => {
    const scoped = section({
      id: '.claude/rules/api.md#api-client',
      sourceScope: '.claude/rules/api.md',
      heading: 'API client',
    });
    const recs = overScopedRecs(
      input(dataset(project([scoped], [file('src/lib/api-client.ts', [scoped.id])])))
    );

    expect(recs).toHaveLength(0);
  });

  it('emits nothing without a repo map or without governed files', () => {
    const lonely = section({
      id: 'AGENTS.md#lonely',
      heading: 'Lonely root section',
    });

    expect(detector.rule(input(null), 0)).toBeNull();
    expect(detector.rule(input(dataset(project([lonely], []))), 0)).toBeNull();
  });
});

describe('context.over-scoped-config-section — adherence-gated graduation (#1270)', () => {
  /** One config-scoping ledger line; omit `adherence` to drop the judged dimension. */
  const scopingLine = (
    winner: 'main' | 'shadow' | 'tie',
    adherence?: number,
    mode: 'live' | 'replay' = 'live'
  ): string =>
    JSON.stringify({
      mode,
      axis: 'config-scoping',
      judge: { winner, ...(adherence === undefined ? {} : { adherenceRegressions: adherence }) },
    });

  const ledger = (...lines: string[]) => parseShadowCalls(lines.join('\n'));

  const overScopedInput = (shadowCalls?: ShadowCallAggregate): RecommendationInput => {
    const api = section({
      id: 'AGENTS.md#spa-server-boundary',
      heading: 'SPA server boundary',
    });
    return input(
      dataset(project([api], [file('src/lib/api-client.ts', [api.id])])),
      shadowCalls
    );
  };

  const rec = (shadowCalls?: ShadowCallAggregate) => {
    const found = overScopedRecs(overScopedInput(shadowCalls));
    expect(found).toHaveLength(1);
    return found[0];
  };

  /** 6 samples, 5 shadow wins / 1 main — clears MIN_SAMPLES, MIN_DECIDED, 60% win rate. */
  const winningLines = (adherence: () => number | undefined) => [
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence()),
    scopingLine('shadow', adherence(), 'replay'),
    scopingLine('main', adherence()),
  ];

  it('graduates to recommended / tier-1-before-after when thresholds clear with ZERO regression', () => {
    const graduated = rec(ledger(...winningLines(() => 0)));
    expect(graduated.savingsAttribution?.tier).toBe('tier-1-before-after');
    expect(graduated.savingsAttribution?.confidence).toBe('high');
    expect(graduated.severity).toBe('warning');
    expect(graduated.detail).toMatch(/zero adherence regressions/i);
    expect(graduated.evidence?.some((e) => e.includes('config-scoping axis'))).toBe(true);
    expect(validateRecommendationProvenance(graduated)).toEqual([]);
  });

  it('stays advisory when thresholds clear but ANY adherence regression exists (hard gate)', () => {
    // Identical cost/speed win, but one judged record dropped a rule.
    let i = 0;
    const blocked = rec(ledger(...winningLines(() => (i++ === 1 ? 1 : 0))));
    expect(blocked.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(blocked.savingsAttribution?.confidence).toBe('medium');
    expect(blocked.severity).toBe('info');
    expect(blocked.detail).not.toMatch(/proved/i);
  });

  it('stays advisory below the evidence thresholds, even with zero regressions', () => {
    // Only 2 samples (< MIN_SAMPLES) — a clean adherence record cannot rescue thin evidence.
    const thin = rec(ledger(scopingLine('shadow', 0), scopingLine('shadow', 0)));
    expect(thin.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(thin.severity).toBe('info');
  });

  it('fails closed when adherence data is absent or partial', () => {
    // Same winning verdicts but NO adherence dimension on any record.
    const absent = rec(ledger(...winningLines(() => undefined)));
    expect(absent.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(absent.severity).toBe('info');

    // Partial coverage: one judged record missing the dimension blocks certification.
    let i = 0;
    const partial = rec(ledger(...winningLines(() => (i++ === 2 ? undefined : 0))));
    expect(partial.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(partial.severity).toBe('info');
  });

  it('ignores wins on OTHER axes — only config-scoping evidence graduates this rec', () => {
    const otherAxis = parseShadowCalls(
      Array.from({ length: 6 }, () =>
        JSON.stringify({ mode: 'live', axis: 'model', judge: { winner: 'shadow', adherenceRegressions: 0 } })
      ).join('\n')
    );
    const unaffected = rec(otherAxis);
    expect(unaffected.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(unaffected.severity).toBe('info');
  });

  it('stays advisory with no shadow-calls data at all', () => {
    const noData = rec(undefined);
    expect(noData.savingsAttribution?.tier).toBe('tier-0-estimate');
    expect(noData.severity).toBe('info');
  });
});
