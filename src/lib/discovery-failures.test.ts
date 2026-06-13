import { describe, it, expect } from 'vitest';
import { detectDiscoveryFailures } from './discovery-failures';
import type { ToolUsageData, ToolCall } from './parse-tools';
import type { LiveResource } from '../types';

const call = (over: Partial<ToolCall>): ToolCall => ({
  timestamp: 't',
  toolName: 'Bash',
  input: {},
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
  ...over,
});

const bash = (command: string): ToolCall => call({ toolName: 'Bash', input: { command } });
const skillCall = (skill: string): ToolCall => call({ toolName: 'Skill', input: { skill } });

const session = (sessionId: string, calls: ToolCall[]): ToolUsageData => ({ sessionId, calls });

const SKILLS: LiveResource[] = [
  {
    id: 'session-usage',
    scope: 'user',
    path: '/x',
    description:
      'Reports how much of the subscription plan limits remain by reading rate-limit headers. Use when the user asks about usage, limits, or quota.',
  },
];

const PROJECT_SKILL: LiveResource = {
  id: 'build-helper',
  scope: 'project',
  projectPath: '/repo/a',
  path: '/repo/a/.claude/skills/build-helper',
  description: 'Runs project build helper commands for generated assets.',
};

describe('detectDiscoveryFailures', () => {
  it('flags a session with 3+ repeated Bash calls matching an un-invoked skill', () => {
    const data = [
      session('s1', [
        bash('node check-usage.mjs --plan limits quota'),
        bash('node check-usage.mjs --plan limits quota'),
        bash('node check-usage.mjs --plan limits quota'),
      ]),
    ];
    const out = detectDiscoveryFailures(data, SKILLS);
    expect(out).toHaveLength(1);
    expect(out[0].skillId).toBe('session-usage');
    expect(out[0].sessions).toBe(1);
    // multi-token overlap: "limits" + "quota" (and "usage" from the command path)
    expect(out[0].matchedKeywords).toEqual(expect.arrayContaining(['limits', 'quota']));
    expect(out[0].matchedKeywords.length).toBeGreaterThanOrEqual(2);
  });

  it('produces no entry when the matching skill WAS invoked in the session', () => {
    const data = [
      session('s1', [
        bash('node check-usage.mjs --plan limits quota'),
        bash('node check-usage.mjs --plan limits quota'),
        bash('node check-usage.mjs --plan limits quota'),
        skillCall('session-usage'),
      ]),
    ];
    expect(detectDiscoveryFailures(data, SKILLS)).toHaveLength(0);
  });

  it('does not flag a command repeated fewer than 3 times', () => {
    const data = [
      session('s1', [
        bash('node check-usage.mjs --plan limits quota'),
        bash('node check-usage.mjs --plan limits quota'),
      ]),
    ];
    expect(detectDiscoveryFailures(data, SKILLS)).toHaveLength(0);
  });

  it('does not flag on a single shared keyword (requires 2+ overlap)', () => {
    const data = [
      session('s1', [bash('grep limits log'), bash('grep limits log'), bash('grep limits log')],
      ),
    ];
    expect(detectDiscoveryFailures(data, SKILLS)).toHaveLength(0);
  });

  it('returns nothing when there are no skills', () => {
    const data = [
      session('s1', [
        bash('node check-usage.mjs --plan limits quota'),
        bash('node check-usage.mjs --plan limits quota'),
        bash('node check-usage.mjs --plan limits quota'),
      ]),
    ];
    expect(detectDiscoveryFailures(data, [])).toHaveLength(0);
  });

  it('does not flag a project skill from another project (#1063)', () => {
    const data = [
      session('s-b', [
        bash('node build-helper generated assets'),
        bash('node build-helper generated assets'),
        bash('node build-helper generated assets'),
      ]),
    ];

    expect(
      detectDiscoveryFailures(data, [PROJECT_SKILL], [
        { sessionId: 's-b', project: '/repo/b' },
      ])
    ).toHaveLength(0);
  });

  it('flags a project skill when the matching session is in that project (#1063)', () => {
    const data = [
      session('s-a', [
        bash('node build-helper generated assets'),
        bash('node build-helper generated assets'),
        bash('node build-helper generated assets'),
      ]),
    ];

    const out = detectDiscoveryFailures(data, [PROJECT_SKILL], [
      { sessionId: 's-a', project: '/repo/a' },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].skillId).toBe('build-helper');
  });

  it('does not treat project skills as global when session metadata is absent (#1063)', () => {
    const data = [
      session('s-a', [
        bash('node build-helper generated assets'),
        bash('node build-helper generated assets'),
        bash('node build-helper generated assets'),
      ]),
    ];

    expect(detectDiscoveryFailures(data, [PROJECT_SKILL])).toHaveLength(0);
  });
});
