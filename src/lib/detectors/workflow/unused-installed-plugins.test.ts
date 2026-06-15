import { describe, it, expect } from 'vitest';
import { detector } from './unused-installed-plugins';
import type { RecommendationInput } from '../types';

const plugin = (id: string) => ({
  id,
  scope: 'user',
  version: '1.0.0',
  installPath: `/home/u/.claude/plugins/${id}`,
  installedAt: '2026-01-01T00:00:00.000Z',
  bundled: { skills: [`${id}-skill`], agents: [] },
});

const liveConfig = (ids: string[]) =>
  ({
    skills: [],
    subagents: [],
    commands: [],
    plugins: ids.map(plugin),
    mcpServers: [],
    settings: {},
    claudeMd: { global: '' },
  } as unknown as RecommendationInput['liveConfig']);

const input = (
  ids: string[],
  usedSkills: Record<string, { invocations: number }> = {}
): RecommendationInput => ({
  tokenData: [],
  toolData: [],
  sessions: [{ sessionId: 's1', startTime: 1_780_000_000_000 }] as unknown as RecommendationInput['sessions'],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  attribution: [
    {
      sessionId: 's1',
      agents: {},
      skills: usedSkills,
      commands: {},
      mcpServers: {},
    },
  ] as unknown as RecommendationInput['attribution'],
  liveConfig: liveConfig(ids),
});

describe('workflow.unused-installed-plugins (#1660)', () => {
  it('fires with one rm line per unused plugin', () => {
    const rec = detector.rule(input(['plugin-a', 'plugin-b']), 1_780_100_000_000);
    expect(rec?.id).toBe('workflow.unused-installed-plugins');
    expect(rec?.affected).toBe(2);
    expect(rec?.fix?.target).toBe('command');
    expect(rec?.fix?.snippet).toBe(
      'rm ~/.claude/plugins/plugin-a\nrm ~/.claude/plugins/plugin-b'
    );
  });

  it('stays silent when bundled plugin artifacts were used in the window', () => {
    const rec = detector.rule(
      input(['plugin-a'], { 'plugin-a-skill': { invocations: 1 } }),
      1_780_100_000_000
    );
    expect(rec).toBeNull();
  });
});
