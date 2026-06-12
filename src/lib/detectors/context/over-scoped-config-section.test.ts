import { describe, it, expect } from 'vitest';
import { buildRecommendations } from '../../recommendations';
import type { RecommendationInput } from '../types';
import type { ConfigSection } from '../../parse-config-sections';
import type {
  RepoMapDataset,
  RepoMapFileJoin,
  RepoMapProjectJoin,
} from '../../parse-repo-map-join';
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

const input = (repoMap: RepoMapDataset | null | undefined): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
  repoMap,
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
