import { describe, it, expect } from 'vitest';
import { detector } from './unused-installed-commands';
import type { RecommendationInput } from '../types';

const command = (id: string) => ({ id, scope: 'user', path: `/home/u/.claude/commands/${id}.md` });
const liveConfig = (ids: string[]) =>
  ({
    skills: [],
    subagents: [],
    commands: ids.map(command),
    plugins: [],
    mcpServers: [],
    settings: {},
    claudeMd: { global: '' },
  } as unknown as RecommendationInput['liveConfig']);

const input = (ids: string[]): RecommendationInput => ({
  tokenData: [], toolData: [],
  sessions: [{ sessionId: 's1', startTime: 1_780_000_000_000 }] as unknown as RecommendationInput['sessions'],
  projects: [], permissionRows: [], apiErrors: [],
  attribution: [], // no invocations → every command is window-unused
  liveConfig: liveConfig(ids),
});

describe('workflow.unused-installed-commands (#634)', () => {
  it('fires when 3+ installed commands are unused in the window', () => {
    const rec = detector.rule(input(['a', 'b', 'c', 'd']), 1_780_100_000_000);
    expect(rec?.id).toBe('workflow.unused-installed-commands');
    expect(rec?.affected).toBeGreaterThanOrEqual(3);
    expect(rec?.fix?.target).toBe('command');
    expect(rec?.fix?.snippet).toBe(
      [
        "rm -- '/home/u/.claude/commands/a.md'",
        "rm -- '/home/u/.claude/commands/b.md'",
        "rm -- '/home/u/.claude/commands/c.md'",
        "rm -- '/home/u/.claude/commands/d.md'",
      ].join('\n\n')
    );
  });
  it('stays silent below threshold', () => {
    expect(detector.rule(input(['a', 'b']), 1_780_100_000_000)).toBeNull();
  });
  // ── Bounded-window wording (#3249) ───────────────────────────────────────
  it('bounds the claim to the observed interval when history is shorter than 30 days', () => {
    // The standard fixture retains only ~1.16 days of sessions.
    const rec = detector.rule(input(['a', 'b', 'c', 'd']), 1_780_100_000_000)!;
    const asOf = new Date(1_780_000_000_000).toISOString().slice(0, 10);
    expect(rec.title).toBe('Installed slash-commands unused in the available history');
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
    expect(rec.title).toBe('Installed slash-commands unused in the last 30 days');
    expect(rec.detail).toContain('zero invocations in the last 30 days');
  });

  it('tolerates attribution rows cached before the commands field existed', () => {
    // A pre-#634 cached attribution row has no `commands` key; the engine must
    // not throw on Object.entries(undefined). See the `?? {}` guard.
    const legacy = input(['a', 'b', 'c']);
    legacy.attribution = [
      { sessionId: 's1', agents: {}, skills: {}, mcpServers: {}, mcpTools: {} },
    ] as unknown as RecommendationInput['attribution'];
    expect(() => detector.rule(legacy, 1_780_100_000_000)).not.toThrow();
    expect(detector.rule(legacy, 1_780_100_000_000)?.affected).toBe(3);
  });
});
