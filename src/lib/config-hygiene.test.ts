import { describe, expect, it } from 'vitest';
import { computeConfigHygiene } from './config-hygiene';
import type { LiveConfig } from '../types';
import type { SessionAttribution } from './parse-agents';

const now = Date.UTC(2026, 0, 15);

function liveConfig(overrides: Partial<LiveConfig> = {}): LiveConfig {
  return {
    settings: {},
    claudeMd: { global: null, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
    ...overrides,
  };
}

function attribution(
  sessionId: string,
  skills: Record<string, number>
): SessionAttribution {
  return {
    sessionId,
    agents: {},
    skills: Object.fromEntries(
      Object.entries(skills).map(([id, invocations]) => [
        id,
        { invocations, outputTokens: 0 },
      ])
    ),
    commands: {},
    mcpServers: {},
    mcpTools: {},
  };
}

describe('computeConfigHygiene project-scoped resources (#1063)', () => {
  it('does not let another project suppress an unused project skill', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          {
            id: 'build-helper',
            scope: 'project',
            projectPath: '/repo/a',
            path: '/repo/a/.claude/skills/build-helper',
          },
        ],
      }),
      attribution: [attribution('s-b', { 'build-helper': 3 })],
      sessions: [{ sessionId: 's-b', project: '/repo/b', startTime: now }],
      now,
    });

    expect(findings).toMatchObject([
      {
        id: 'skill.unused:build-helper@/repo/a',
        resourceType: 'skill',
        resourceId: 'build-helper',
        scope: { kind: 'project', project: '/repo/a' },
        lifetimeCount: 0,
        windowCount: 0,
        sourcePath: '/repo/a/.claude/skills/build-helper/SKILL.md',
        removalPath: '/repo/a/.claude/skills/build-helper',
      },
    ]);
  });

  it('suppresses a project skill only when it is used inside that project', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          {
            id: 'build-helper',
            scope: 'project',
            projectPath: '/repo/a',
            path: '/repo/a/.claude/skills/build-helper',
          },
        ],
      }),
      attribution: [attribution('s-a', { 'build-helper': 3 })],
      sessions: [{ sessionId: 's-a', project: '/repo/a', startTime: now }],
      now,
    });

    expect(findings).toEqual([]);
  });
});
