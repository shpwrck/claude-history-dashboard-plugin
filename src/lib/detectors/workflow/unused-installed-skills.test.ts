import { describe, it, expect } from 'vitest';
import { detector } from './unused-installed-skills';
import type { RecommendationInput } from '../types';

const skill = (id: string) => ({
  id,
  scope: 'user',
  path: `/home/u/.claude/skills/${id}`,
  removalSafety: {
    configuredRoot: '/home/u/.claude/skills',
    canonicalPathContained: true,
  },
});
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

  // ── Bounded-window wording (#3249) ───────────────────────────────────────
  it('bounds the claim to the observed interval when history is shorter than 30 days', () => {
    const rec = detector.rule(input(['a', 'b', 'c', 'd']), 1_780_100_000_000)!;
    const asOf = new Date(1_780_000_000_000).toISOString().slice(0, 10);
    expect(rec.title).toBe('Installed skills unused in the available history');
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
    expect(rec.title).toBe('Installed skills unused in the last 30 days');
    expect(rec.detail).toContain('zero invocations in the last 30 days');
  });

  // PR #3530 review regression: a PROJECT-scoped finding is hedged on its
  // project's OWN coverage, so on a mixed corpus (thin new project + >= 30
  // days of global history) the demoted wording must quote the hedged
  // project's span — quoting the global span would emit the internally false
  // "~40 day(s) … shorter than the 30-day threshold".
  it('quotes the hedged PROJECT scope span, not the >=30-day global span', () => {
    const NOW = 1_780_100_000_000;
    const DAY = 24 * 60 * 60 * 1000;
    const rec = detector.rule(
      {
        ...input(['a', 'b', 'c']),
        // Global corpus spans 40 days (no hedge for the user-scoped skills);
        // /repo/new has only 2 days of its own history (hedged).
        sessions: [
          { sessionId: 's-old', project: '/repo/other', startTime: NOW - 40 * DAY },
          { sessionId: 's-new', project: '/repo/new', startTime: NOW - 2 * DAY },
        ] as unknown as RecommendationInput['sessions'],
        attribution: [],
        liveConfig: {
          ...liveConfig(['a', 'b', 'c']),
          skills: [
            ...liveConfig(['a', 'b', 'c']).skills,
            {
              id: 'proj-skill',
              scope: 'project',
              projectPath: '/repo/new',
              path: '/repo/new/.claude/skills/proj-skill',
            },
          ],
        } as unknown as RecommendationInput['liveConfig'],
      },
      NOW
    )!;
    // The hedge came from /repo/new's own 2-day coverage — the wording quotes
    // THAT span and stays internally consistent with the threshold clause.
    expect(rec.title).toBe('Installed skills unused in the available history');
    expect(rec.detail).toContain('~2 day(s) of retained coverage');
    expect(rec.detail).toContain('shorter than the 30-day threshold');
    expect(rec.detail).not.toContain('~40');
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
