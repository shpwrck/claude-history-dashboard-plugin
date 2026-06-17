import { describe, it, expect } from 'vitest';
import { detector } from './unused-installed-skills';
import type { RecommendationInput } from '../types';

const skill = (id: string) => ({ id, scope: 'user', path: `/home/u/.claude/skills/${id}` });
const liveConfig = (ids: string[]) =>
  ({
    skills: ids.map(skill),
    subagents: [],
    commands: [],
    plugins: [],
    mcpServers: [],
    settings: {},
    claudeMd: { global: '' },
  } as unknown as RecommendationInput['liveConfig']);

const input = (ids: string[]): RecommendationInput => ({
  tokenData: [], toolData: [],
  sessions: [{ sessionId: 's1', startTime: 1_780_000_000_000 }] as unknown as RecommendationInput['sessions'],
  projects: [], permissionRows: [], apiErrors: [],
  attribution: [], // no invocations → every skill is window-unused
  liveConfig: liveConfig(ids),
});

describe('workflow.unused-installed-skills (#421)', () => {
  it('fires when 3+ installed skills are unused in the window', () => {
    const rec = detector.rule(input(['a', 'b', 'c', 'd']), 1_780_100_000_000);
    expect(rec?.id).toBe('workflow.unused-installed-skills');
    expect(rec?.affected).toBeGreaterThanOrEqual(3);
    expect(rec?.fix?.target).toBe('command');
    expect(rec?.fix?.snippet).toBe(
      [
        "rm -rf -- '/home/u/.claude/skills/a'",
        "rm -rf -- '/home/u/.claude/skills/b'",
        "rm -rf -- '/home/u/.claude/skills/c'",
        "rm -rf -- '/home/u/.claude/skills/d'",
      ].join('\n\n')
    );
  });
  it('stays silent below threshold', () => {
    expect(detector.rule(input(['a', 'b']), 1_780_100_000_000)).toBeNull();
  });

  it('does not count a project-scoped skill as unused when that project used it', () => {
    const rec = detector.rule(
      {
        ...input(['a', 'b']),
        sessions: [
          { sessionId: 's1', project: '/repo/a', startTime: 1_780_000_000_000 },
        ] as unknown as RecommendationInput['sessions'],
        attribution: [
          {
            sessionId: 's1',
            agents: {},
            skills: { 'build-helper': { invocations: 1 } },
            commands: {},
            mcpServers: {},
          },
        ] as unknown as RecommendationInput['attribution'],
        liveConfig: {
          ...liveConfig(['a', 'b']),
          skills: [
            ...liveConfig(['a', 'b']).skills,
            {
              id: 'build-helper',
              scope: 'project',
              projectPath: '/repo/a',
              path: '/repo/a/.claude/skills/build-helper',
            },
          ],
        } as unknown as RecommendationInput['liveConfig'],
      },
      1_780_100_000_000
    );

    expect(rec).toBeNull();
  });
});
