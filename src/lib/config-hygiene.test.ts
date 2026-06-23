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

describe('computeConfigHygiene structural exclusions (#2015)', () => {
  const skill = (id: string) => ({
    id,
    scope: 'user' as const,
    path: `/u/.claude/skills/${id}`,
  });
  const agent = (id: string) => ({
    id,
    scope: 'user' as const,
    path: `/u/.claude/agents/${id}.md`,
  });

  it('drops _-dirs, subskills, and test fixtures but keeps genuinely-unused resources', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          skill('_shared'), // utility dir — not invocable
          skill('burn-epic'), // parent skill, genuinely unused
          skill('burn-epic-pick'), // subskill of installed burn-epic
          skill('groom-release'), // parent skill, genuinely unused
          skill('groom-release-loose-floor'), // multi-word-phase subskill
          skill('handoff-to-agent'), // genuinely-unused top-level skill
        ],
        subagents: [
          agent('test-echo-validator'), // built-in test fixture
          agent('ponytail-lite'), // directly-invocable variant, no skill parent
        ],
      }),
      // No attribution => everything is unused; only structural exclusions filter.
      attribution: [],
      sessions: [{ sessionId: 's', startTime: now }],
      now,
    });
    const got = findings.map((f) => f.resourceId);

    // Structurally excluded — permanent false positives, never removal candidates.
    expect(got).not.toContain('_shared');
    expect(got).not.toContain('burn-epic-pick');
    expect(got).not.toContain('groom-release-loose-floor');
    expect(got).not.toContain('test-echo-validator');

    // Still flagged — genuinely unused, directly invocable (regression guard).
    expect(got).toContain('burn-epic');
    expect(got).toContain('groom-release');
    expect(got).toContain('handoff-to-agent');
    expect(got).toContain('ponytail-lite');
  });
});
