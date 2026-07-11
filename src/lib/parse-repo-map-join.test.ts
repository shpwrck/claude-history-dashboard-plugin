import { describe, expect, it } from 'vitest';
import { buildRepoMapDataset } from './parse-repo-map-join';
import type { Recommendation } from './detectors/types';
import type { RepoMap } from './repo-map/types';

const map: RepoMap = {
  root: '/repo',
  generatedAtGitSha: 'abc123',
  fileCount: 2,
  truncated: false,
  text: 'src/api.ts\nsrc/unused.ts',
  files: [
    {
      path: 'src/api.ts',
      mtimeMs: 1_700_000_000_000,
      symbols: [
        {
          name: 'fetchDataset',
          kind: 'function',
          exported: true,
          signature: 'function fetchDataset()',
          line: 1,
        },
      ],
      imports: ['./types'],
    },
    { path: 'src/unused.ts', symbols: [], imports: [] },
  ],
};

describe('buildRepoMapDataset', () => {
  it('joins repo-map files to rereads, churn, config sections, and recommendations', () => {
    const rec = {
      id: 'context.pin-api',
      category: 'context',
      severity: 'warning',
      title: 'Pin src/api.ts',
      action: 'Load src/api.ts once before related work.',
    } as Recommendation;

    const dataset = buildRepoMapDataset({
      maps: [map],
      configSections: [
        {
          id: '/repo/AGENTS.md#key-files',
          sourceScope: '/repo/AGENTS.md',
          heading: 'Key files',
          level: 2,
          mtime: 10,
          hash: 'aabbccdd',
          references: [{ kind: 'file', target: 'src/api.ts' }],
        },
      ],
      configAttribution: [
        {
          sectionId: '/repo/AGENTS.md#key-files',
          sourceScope: '/repo/AGENTS.md',
          heading: 'Key files',
          signatureId: 'key-file-pin/references-before-parsers',
          signatureClass: 'key-file-pin',
          signature: 'Read the key file before governed files.',
          attributability: 'attributable',
          evidence: 'tier-0-estimate',
          observation: {
            compliant: 1,
            violating: 1,
            complianceRate: 0.5,
            sessions: 2,
          },
          note: 'Attributable.',
        },
      ],
      fileReread: {
        threshold: 3,
        sessionsAffected: 1,
        filesAffected: 1,
        totalEstimatedTokenWaste: 300,
        noByteData: false,
        repeats: [
          {
            sessionId: 's1',
            path: '/repo/src/api.ts',
            readCount: 4,
            firstRead: '2026-01-01T00:00:00.000Z',
            lastRead: '2026-01-01T00:10:00.000Z',
            totalBytes: 1200,
            avgBytesPerRead: 400,
            estimatedTokenWaste: 300,
            tokenEstimateSource: 'direct',
            compactions: 1,
          },
        ],
      },
      churnFiles: [
        {
          filePath: '/repo/src/api.ts',
          churn: 2,
          edits: 2,
          writes: 0,
          sessions: 1,
          editsPerSession: 2,
        },
      ],
      recommendations: [rec],
    });

    const project = dataset.projects[0];
    expect(project.root).toBe('/repo');
    expect(project.configSections).toHaveLength(1);
    expect(project.configAttribution).toHaveLength(1);
    expect(project.files[0]).toMatchObject({
      path: 'src/api.ts',
      mtimeMs: 1_700_000_000_000,
      reread: {
        sessions: 1,
        totalReads: 4,
        totalEstimatedTokenWaste: 300,
        maxPerSession: 4,
      },
      churn: {
        filePath: '/repo/src/api.ts',
        churn: 2,
      },
      configSections: ['/repo/AGENTS.md#key-files'],
      recommendations: ['context.pin-api'],
    });
    expect(project.files[1]).not.toHaveProperty('mtimeMs');
  });

  it('does not include source bodies or config bodies in the join', () => {
    const dataset = buildRepoMapDataset({
      maps: [map],
      configSections: [
        {
          id: '/repo/CLAUDE.md#secret',
          sourceScope: '/repo/CLAUDE.md',
          heading: 'Secret',
          level: 2,
          mtime: null,
          hash: '11223344',
          references: [],
        },
      ],
    });
    const serialized = JSON.stringify(dataset);
    expect(serialized).not.toContain('do-not-leak-body');
    expect(serialized).toContain('function fetchDataset()');
  });
});
