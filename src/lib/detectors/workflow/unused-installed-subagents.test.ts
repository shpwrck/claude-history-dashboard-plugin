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
      [
        "rm -- '/home/u/.claude/agents/a'",
        "rm -- '/home/u/.claude/agents/b'",
        "rm -- '/home/u/.claude/agents/c'",
        "rm -- '/home/u/.claude/agents/d'",
      ].join('\n\n')
    );
  });
  it('stays silent below threshold', () => {
    expect(detector.rule(input(['a', 'b']), 1_780_100_000_000)).toBeNull();
  });

  // ── Bounded-window wording (#3249) ───────────────────────────────────────
  it('bounds the claim to the observed interval when history is shorter than 30 days', () => {
    const rec = detector.rule(input(['a', 'b', 'c', 'd']), 1_780_100_000_000)!;
    const asOf = new Date(1_780_000_000_000).toISOString().slice(0, 10);
    expect(rec.title).toBe('Installed subagents unused in the available history');
    expect(rec.title).not.toContain('last 30 days');
    expect(rec.detail).not.toContain('last 30 days');
    expect(rec.detail).toContain('day(s) of retained coverage');
    expect(rec.detail).toContain(`as of ${asOf}`);
  });

  it('keeps the 30-day wording when the retained history covers the window', () => {
    const full = input(['a', 'b', 'c', 'd']);
    full.sessions = [
      { sessionId: 's-old', startTime: 1_780_100_000_000 - 31 * 24 * 60 * 60 * 1000 },
      { sessionId: 's1', startTime: 1_780_000_000_000 },
    ] as unknown as RecommendationInput['sessions'];
    const rec = detector.rule(full, 1_780_100_000_000)!;
    expect(rec.title).toBe('Installed subagents unused in the last 30 days');
    expect(rec.detail).toContain('zero invocations in the last 30 days');
  });
});
