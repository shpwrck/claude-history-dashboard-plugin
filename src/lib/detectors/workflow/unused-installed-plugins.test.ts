import { describe, it, expect } from 'vitest';
import { detector } from './unused-installed-plugins';
import type { RecommendationInput } from '../types';

const plugin = (id: string) => ({
  id,
  scope: 'user',
  version: '1.0.0',
  sourcePath: '/home/u/.claude/plugins/installed_plugins.json',
  installPath: `/home/u/.claude/plugins/${id}`,
  removalSafety: {
    configuredRoot: '/home/u/.claude/plugins',
    canonicalPathContained: true,
  },
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
    expect(rec?.fix?.snippet).toContain(
      'const path = "/home/u/.claude/plugins/installed_plugins.json";'
    );
    expect(rec?.fix?.snippet).toContain('const plugin = "plugin-a";');
    expect(rec?.fix?.snippet).toContain(
      "rm -rf -- '/home/u/.claude/plugins/plugin-a'"
    );
    expect(rec?.fix?.snippet).toContain('const plugin = "plugin-b";');
    expect(rec?.fix?.snippet).toContain(
      "rm -rf -- '/home/u/.claude/plugins/plugin-b'"
    );
  });

  // ── Bounded-window wording (#3249) ───────────────────────────────────────
  it('bounds the claim to the observed interval when history is shorter than 30 days', () => {
    const rec = detector.rule(input(['plugin-a', 'plugin-b']), 1_780_100_000_000)!;
    const asOf = new Date(1_780_000_000_000).toISOString().slice(0, 10);
    expect(rec.title).toBe('Installed plugins unused in the available history');
    expect(rec.title).not.toContain('last 30 days');
    expect(rec.detail).not.toContain('last 30 days');
    expect(rec.detail).toContain('day(s) of retained coverage');
    expect(rec.detail).toContain(`as of ${asOf}`);
  });

  it('keeps the 30-day wording when the retained history covers the window', () => {
    const full = input(['plugin-a', 'plugin-b']);
    full.sessions = [
      { sessionId: 's-old', startTime: 1_780_100_000_000 - 31 * 24 * 60 * 60 * 1000 },
      { sessionId: 's1', startTime: 1_780_000_000_000 },
    ] as unknown as RecommendationInput['sessions'];
    const rec = detector.rule(full, 1_780_100_000_000)!;
    expect(rec.title).toBe('Installed plugins unused in the last 30 days');
    expect(rec.detail).toContain('invocations in the last 30 days');
  });

  it('stays silent when bundled plugin artifacts were used in the window', () => {
    const rec = detector.rule(
      input(['plugin-a'], { 'plugin-a-skill': { invocations: 1 } }),
      1_780_100_000_000
    );
    expect(rec).toBeNull();
  });
});
