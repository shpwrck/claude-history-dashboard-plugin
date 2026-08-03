import { describe, expect, it } from 'vitest';
import {
  computeConfigHygiene,
  effectiveDataWindowDays,
  observedWindowDaysForScope,
} from './config-hygiene';
import type { LiveConfig } from '../types';
import type { SessionAttribution } from './parse-agents';

const now = Date.UTC(2026, 0, 15);
const DAY_MS = 24 * 60 * 60 * 1000;

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

function mcpAttribution(
  sessionId: string,
  mcpServers: Record<string, number>
): SessionAttribution {
  return {
    sessionId,
    agents: {},
    skills: {},
    commands: {},
    mcpServers: Object.fromEntries(
      Object.entries(mcpServers).map(([id, invocations]) => [
        id,
        { invocations, outputTokens: 0 },
      ])
    ),
    mcpTools: {},
  };
}

describe('computeConfigHygiene project-scoped resources (#1063)', () => {
  const projectSkill = {
    id: 'build-helper',
    scope: 'project' as const,
    projectPath: '/repo/a',
    path: '/repo/a/.claude/skills/build-helper',
  };

  /**
   * #1063's original assertion — one project's usage must not suppress
   * another's unused finding — on a fixture where it is EARNED.
   *
   * The fixture this replaces gave a retained session only to `/repo/b` and
   * then asserted a `/repo/a` finding, so it pinned the #3118 defect: it
   * demanded an "unused" claim about a project we had never observed. Adding an
   * unrelated `/repo/a` session keeps the independence property under test
   * (b's three invocations still do not suppress a's finding) while giving the
   * claim about `/repo/a` something to rest on. Changed deliberately in #3388,
   * not quietly — see that issue for the decision.
   */
  it('does not let another project suppress an unused project skill', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({ skills: [projectSkill] }),
      attribution: [
        attribution('s-b', { 'build-helper': 3 }),
        // /repo/a was observed, and did not use the skill.
        attribution('s-a', {}),
      ],
      sessions: [
        { sessionId: 's-b', project: '/repo/b', startTime: now },
        { sessionId: 's-a', project: '/repo/a', startTime: now },
      ],
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

  it('claims nothing about a project with no retained sessions (#3388)', () => {
    // The guard the test above used to contradict. `/repo/a` is installed but
    // never observed, so "unused" would be a statement about our data rather
    // than about the skill — zero observation is not evidence of disuse
    // (#3118), and this is the exact fixture that used to assert otherwise.
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({ skills: [projectSkill] }),
      attribution: [attribution('s-b', { 'build-helper': 3 })],
      sessions: [{ sessionId: 's-b', project: '/repo/b', startTime: now }],
      now,
    });

    expect(findings).toEqual([]);
  });

  it('claims nothing about a project observed only OUTSIDE the window (#3388)', () => {
    // A project whose only session predates the active window is exactly as
    // unobserved-in-window as one with no session at all.
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({ skills: [projectSkill] }),
      attribution: [attribution('s-old', {}), attribution('s-b', {})],
      sessions: [
        { sessionId: 's-old', project: '/repo/a', startTime: now - 200 * DAY_MS },
        { sessionId: 's-b', project: '/repo/b', startTime: now },
      ],
      now,
    });

    expect(findings.filter((f) => f.scope.kind === 'project')).toEqual([]);
  });

  it('resolves guard and usage from the SAME project identity (#3388)', () => {
    // The guard matches by canonical identity, so usage matching must too.
    // If the guard said "observed" via `/repo/a/` while usage still demanded a
    // raw `/repo/a` string match, the skill would be called unused on a
    // project where we can plainly see it being used.
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({ skills: [projectSkill] }),
      attribution: [attribution('s-a', { 'build-helper': 2 })],
      sessions: [{ sessionId: 's-a', project: '/repo/a/', startTime: now }],
      now,
    });

    expect(findings).toEqual([]);
  });

  it('applies the guard to project-scoped subagents and commands too (#3388)', () => {
    // The families that were missing it. Same unobserved project, three
    // resource types, nothing claimed about any of them.
    const unobserved = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [projectSkill],
        subagents: [
          { id: 'helper', scope: 'project', projectPath: '/repo/a', path: '/repo/a/.claude/agents/helper.md' },
        ],
        commands: [
          { id: 'deploy', scope: 'project', projectPath: '/repo/a', path: '/repo/a/.claude/commands/deploy.md' },
        ],
      }),
      attribution: [attribution('s-b', {})],
      sessions: [{ sessionId: 's-b', project: '/repo/b', startTime: now }],
      now,
    });
    expect(unobserved).toEqual([]);

    // And still flag all three once that project HAS been observed, so the
    // guard suppresses unearned claims rather than all claims.
    const observed = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [projectSkill],
        subagents: [
          { id: 'helper', scope: 'project', projectPath: '/repo/a', path: '/repo/a/.claude/agents/helper.md' },
        ],
        commands: [
          { id: 'deploy', scope: 'project', projectPath: '/repo/a', path: '/repo/a/.claude/commands/deploy.md' },
        ],
      }),
      attribution: [attribution('s-a', {})],
      sessions: [{ sessionId: 's-a', project: '/repo/a', startTime: now }],
      now,
    });
    expect(observed.map((f) => f.resourceType).sort()).toEqual([
      'command',
      'skill',
      'subagent',
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

describe('computeConfigHygiene no-session input (#3118)', () => {
  it('emits no findings when there are no retained sessions at all, even with installed resources', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          { id: 'build-helper', scope: 'user', path: '/u/.claude/skills/build-helper' },
        ],
        mcpServers: [
          { id: 'server-a', scope: 'global', sourcePath: '/u/.claude.json' },
        ],
      }),
      // Empty sessions AND empty attribution — zero observation window, so
      // nothing can be honestly called "unused".
      attribution: [],
      sessions: [],
      now,
    });

    expect(findings).toEqual([]);
  });

  it('treats a nonempty invalid-only global corpus as zero observation (#3559)', () => {
    const sessions = [
      { sessionId: 's-nan', startTime: Number.NaN },
      { sessionId: 's-positive-infinity', startTime: Number.POSITIVE_INFINITY },
      { sessionId: 's-negative-infinity', startTime: Number.NEGATIVE_INFINITY },
      { sessionId: 's-zero', startTime: 0 },
      { sessionId: 's-negative', startTime: -DAY_MS },
      { sessionId: 's-future', startTime: now + DAY_MS },
    ];
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          { id: 'build-helper', scope: 'user', path: '/u/.claude/skills/build-helper' },
        ],
      }),
      attribution: [],
      sessions,
      now,
    });

    expect(findings).toEqual([]);
    expect(effectiveDataWindowDays(sessions, now)).toBeNull();
    expect(observedWindowDaysForScope({ kind: 'global' }, sessions, now)).toBeNull();
  });

  it('ignores invalid global rows when valid recent coverage exists (#3559)', () => {
    const sessions = [
      { sessionId: 's-nan', startTime: Number.NaN },
      { sessionId: 's-infinity', startTime: Number.POSITIVE_INFINITY },
      { sessionId: 's-zero', startTime: 0 },
      { sessionId: 's-future', startTime: now + DAY_MS },
      { sessionId: 's-valid', startTime: now - 2 * DAY_MS },
    ];
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          { id: 'build-helper', scope: 'user', path: '/u/.claude/skills/build-helper' },
        ],
      }),
      attribution: [],
      sessions,
      now,
    });

    expect(findings).toMatchObject([
      {
        id: 'skill.unused:build-helper',
        scope: { kind: 'global' },
        hedge: 'window-shorter-than-threshold',
      },
    ]);
    expect(effectiveDataWindowDays(sessions, now)).toBe(2);
    expect(observedWindowDaysForScope({ kind: 'global' }, sessions, now)).toBe(2);
  });

  it('preserves an unhedged global finding when valid coverage spans the window (#3559)', () => {
    const sessions = [
      { sessionId: 's-old', startTime: now - 40 * DAY_MS },
      { sessionId: 's-recent', startTime: now - DAY_MS },
      { sessionId: 's-future', startTime: now + DAY_MS },
    ];
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          { id: 'build-helper', scope: 'user', path: '/u/.claude/skills/build-helper' },
        ],
      }),
      attribution: [],
      sessions,
      now,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'skill.unused:build-helper',
      scope: { kind: 'global' },
    });
    expect(findings[0].hedge).toBeUndefined();
    expect(effectiveDataWindowDays(sessions, now)).toBe(40);
  });

  it('still applies the window-shorter-than-threshold hedge for a non-empty sub-30-day dataset', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        skills: [
          { id: 'build-helper', scope: 'user', path: '/u/.claude/skills/build-helper' },
        ],
      }),
      attribution: [],
      // One session, 2 days of retained history — well short of the 30-day
      // active window, so the finding must still fire but carry the hedge.
      sessions: [{ sessionId: 's1', startTime: now - 2 * DAY_MS }],
      now,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      resourceId: 'build-helper',
      hedge: 'window-shorter-than-threshold',
    });
  });
});

describe('computeConfigHygiene project-scoped MCP servers (#3119)', () => {
  it('does not let usage in an unrelated project suppress a project-scoped server finding', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      // Same server id "db" invoked in an entirely different project.
      attribution: [mcpAttribution('s-b', { db: 5 })],
      // Both projects have a retained session — /repo/a's is genuinely
      // unused, /repo/b's is the unrelated invocation that must not bleed
      // into /repo/a's finding.
      sessions: [
        { sessionId: 's-a', project: '/repo/a', startTime: now },
        { sessionId: 's-b', project: '/repo/b', startTime: now },
      ],
      now,
    });

    expect(findings).toMatchObject([
      {
        id: 'mcpServer.unused:db@/repo/a',
        resourceType: 'mcpServer',
        resourceId: 'db',
        scope: { kind: 'project', project: '/repo/a' },
        lifetimeCount: 0,
        windowCount: 0,
      },
    ]);
  });

  it('suppresses the project-scoped finding when usage is inside that project', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [mcpAttribution('s-a', { db: 5 })],
      sessions: [{ sessionId: 's-a', project: '/repo/a', startTime: now }],
      now,
    });

    expect(findings).toEqual([]);
  });

  it('evaluates every entry in enabledByProjects independently, one finding per still-unused observed project', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            // Same server id owned by two different projects — usage in one
            // must not suppress the finding for the other, and both must be
            // considered rather than only enabledByProjects[0].
            enabledByProjects: ['/repo/a', '/repo/b'],
          },
        ],
      }),
      attribution: [mcpAttribution('s-a', { db: 5 })],
      // Both projects have retained sessions, so both are legitimately
      // observed; only /repo/a actually used the server.
      sessions: [
        { sessionId: 's-a', project: '/repo/a', startTime: now },
        { sessionId: 's-b', project: '/repo/b', startTime: now },
      ],
      now,
    });

    // /repo/a used it => no finding for /repo/a; /repo/b never used it (but
    // was observed) => finding fires.
    expect(findings).toMatchObject([
      {
        resourceType: 'mcpServer',
        resourceId: 'db',
        scope: { kind: 'project', project: '/repo/b' },
        lifetimeCount: 0,
        windowCount: 0,
      },
    ]);
    expect(findings).toHaveLength(1);
  });

  it('does not claim a project-scoped server is unused when its project has no retained sessions at all (#3118 pattern one level down)', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [],
      // Only a session in a *different* project — /repo/a itself has zero
      // retained sessions, so there is no observation window for it at all.
      // An empty window is not evidence of disuse, so no finding may fire.
      sessions: [{ sessionId: 's-b', project: '/repo/b', startTime: now }],
      now,
    });

    expect(findings).toEqual([]);
  });

  it('does not claim a project-scoped server is unused when its only session for that project is stale (outside the 30-day window)', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [],
      sessions: [
        // /repo/a's ONLY session is 40 days old — outside the active 30-day
        // window — so there is no in-window observation for /repo/a even
        // though /repo/b's recent session means the (global) hedge would
        // not fire either. Zero in-window data is exactly as unfounded a
        // basis for "unused" as zero data at all (generalizing #3118).
        { sessionId: 's-a-stale', project: '/repo/a', startTime: now - 40 * DAY_MS },
        { sessionId: 's-b-recent', project: '/repo/b', startTime: now - 1 * DAY_MS },
      ],
      now,
    });

    expect(findings).toEqual([]);
  });

  it("hedges a project-scoped finding from its OWN project's coverage, not a different project's longer history", () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [],
      sessions: [
        // /repo/a's only session is 2 days old — well short of the 30-day
        // window — so its finding must carry the hedge. /repo/b's session
        // is 40 days old (older than the window, so /repo/b itself is not
        // even in-window-observed) — but critically, if the hedge were
        // still computed globally across every session, the GLOBAL oldest
        // session would be /repo/b's 40-day-old one, making the overall
        // "data window" look >= 30 days and wrongly suppressing the hedge
        // /repo/a's own two days of history should carry (the reviewer's
        // exact residual on top of #3118/#3119).
        { sessionId: 's-a-recent', project: '/repo/a', startTime: now - 2 * DAY_MS },
        { sessionId: 's-b-old', project: '/repo/b', startTime: now - 40 * DAY_MS },
      ],
      now,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: 'mcpServer.unused:db@/repo/a',
      resourceType: 'mcpServer',
      resourceId: 'db',
      scope: { kind: 'project', project: '/repo/a' },
      lifetimeCount: 0,
      windowCount: 0,
      hedge: 'window-shorter-than-threshold',
    });
  });

  it('ignores NaN when deriving a project hedge from a valid recent session', () => {
    const sessions = [
      { sessionId: 's-malformed', project: '/repo/a', startTime: Number.NaN },
      { sessionId: 's-recent', project: '/repo/a', startTime: now - 2 * DAY_MS },
    ];
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [],
      sessions,
      now,
    });

    expect(findings).toMatchObject([
      {
        id: 'mcpServer.unused:db@/repo/a',
        hedge: 'window-shorter-than-threshold',
      },
    ]);
    expect(
      observedWindowDaysForScope(
        { kind: 'project', project: '/repo/a' },
        sessions,
        now
      )
    ).toBe(2);
  });

  it('does not let a non-finite-only project corpus qualify as observed', () => {
    const sessions = [
      { sessionId: 's-nan', project: '/repo/a', startTime: Number.NaN },
      {
        sessionId: 's-positive-infinity',
        project: '/repo/a',
        startTime: Number.POSITIVE_INFINITY,
      },
      {
        sessionId: 's-negative-infinity',
        project: '/repo/a',
        startTime: Number.NEGATIVE_INFINITY,
      },
    ];
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [],
      sessions,
      now,
    });

    expect(findings).toEqual([]);
    expect(
      observedWindowDaysForScope(
        { kind: 'project', project: '/repo/a' },
        sessions,
        now
      )
    ).toBeNull();
  });

  it('matches usage by canonical project identity, not raw string spelling — a session under a differently-spelled but equivalent project root still counts as usage', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [
        // s-plain never invoked db; s-slash — an equivalent, differently-
        // spelled project root (trailing slash) — DID invoke it. Raw string
        // equality would admit /repo/a through the observation gate via
        // s-plain while excluding s-slash's invocation from the usage
        // summary (its spelling doesn't strictly equal the enabledByProjects
        // entry), falsely reporting db as unused despite being demonstrably
        // used inside /repo/a.
        mcpAttribution('s-slash', { db: 5 }),
      ],
      sessions: [
        { sessionId: 's-plain', project: '/repo/a', startTime: now },
        { sessionId: 's-slash', project: '/repo/a/', startTime: now },
      ],
      now,
    });

    expect(findings).toEqual([]);
  });

  it('does not treat infinity or a future timestamp as in-window observation', () => {
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['/repo/a'],
          },
        ],
      }),
      attribution: [],
      // /repo/a's ONLY session is timestamped an hour AFTER `now` — clock
      // skew, or malformed imported data — so there is no valid current-or-
      // historical observation of /repo/a at all. A lower-bound-only window
      // check would still admit it (a future timestamp is >= windowStart).
      sessions: [
        {
          sessionId: 's-infinity',
          project: '/repo/a',
          startTime: Number.POSITIVE_INFINITY,
        },
        { sessionId: 's-future', project: '/repo/a', startTime: now + 60 * 60 * 1000 },
      ],
      now,
    });

    expect(findings).toEqual([]);
    expect(
      observedWindowDaysForScope(
        { kind: 'project', project: '/repo/a' },
        [
          {
            sessionId: 's-infinity',
            project: '/repo/a',
            startTime: Number.POSITIVE_INFINITY,
          },
          {
            sessionId: 's-future',
            project: '/repo/a',
            startTime: now + 60 * 60 * 1000,
          },
        ],
        now
      )
    ).toBeNull();
  });
});

describe('computeConfigHygiene project key namespacing (#3119)', () => {
  it('does not let an uncanonicalizable project spelling collide with a canonical key', () => {
    const now = Date.now();
    // 'posix:/repo/a' is the serialized form of the canonical key for
    // '/repo/a'. If the raw fallback returned it unchanged, this config entry
    // and the /repo/a session would land in the same map bucket: the session
    // would admit the entry through the observation gate, while
    // usagesForProject -- which compares by identity, not by this key --
    // correctly excludes its usage. The result is an "unused" finding with no
    // evidence behind it, which is the exact failure this PR exists to close.
    const findings = computeConfigHygiene({
      liveConfig: liveConfig({
        mcpServers: [
          {
            id: 'db',
            scope: 'project',
            sourcePath: '/home/u/.claude.json',
            enabledByProjects: ['posix:/repo/a'],
          },
        ],
      }),
      attribution: [],
      sessions: [{ sessionId: 's1', project: '/repo/a', startTime: now }],
      now,
    });

    expect(findings.filter((f) => f.id.startsWith('mcpServer.unused'))).toEqual([]);
  });
});
