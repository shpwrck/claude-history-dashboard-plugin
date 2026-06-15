import { describe, it, expect } from 'vitest';
import { detector } from './unused-installed-subagents';
import type { RecommendationInput } from '../types';

const subagent = (id: string) => ({ id, scope: 'user', path: `/home/u/.claude/agents/${id}` });
const liveConfig = (ids: string[]) =>
  ({
    skills: [],
    subagents: ids.map(subagent),
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
  attribution: [], // no invocations → every subagent is window-unused
  liveConfig: liveConfig(ids),
});

describe('workflow.unused-installed-subagents (#633)', () => {
  it('fires when 3+ installed subagents are unused in the window', () => {
    const rec = detector.rule(input(['a', 'b', 'c', 'd']), 1_780_100_000_000);
    expect(rec?.id).toBe('workflow.unused-installed-subagents');
    expect(rec?.affected).toBeGreaterThanOrEqual(3);
    expect(rec?.fix?.target).toBe('command');
    expect(rec?.fix?.snippet).toBe(
      'rm ~/.claude/agents/a\nrm ~/.claude/agents/b\nrm ~/.claude/agents/c\nrm ~/.claude/agents/d'
    );
  });
  it('stays silent below threshold', () => {
    expect(detector.rule(input(['a', 'b']), 1_780_100_000_000)).toBeNull();
  });
});
