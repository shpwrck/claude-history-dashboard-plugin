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
  });
  it('stays silent below threshold', () => {
    expect(detector.rule(input(['a', 'b']), 1_780_100_000_000)).toBeNull();
  });
});
