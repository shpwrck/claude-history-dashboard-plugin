import { describe, it, expect } from 'vitest';
import {
  detector,
  skillHookIntegrityCacheValidity,
  skillHookIntegrityCacheValidityContains,
} from './skill-hook-integrity';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { LiveConfig, LiveResource, LiveSettingsHook } from '../../../types';

const CHECKED_AT = '2026-07-10T12:34:56.000Z';

// ── Fixture builders ───────────────────────────────────────────────────────

/** A hook group whose single command references the given path tokens. */
function hookGroup(
  command: string,
  referencedPaths?: unknown[]
): LiveSettingsHook {
  return {
    hooks: [{ type: 'command', command, ...(referencedPaths ? { referencedPaths } : {}) }],
  } as unknown as LiveSettingsHook;
}

function skill(id: string, danglingRefs?: string[]): LiveResource {
  return {
    id,
    scope: 'user',
    path: `/home/u/.claude/skills/${id}`,
    ...(danglingRefs ? { danglingRefs } : {}),
  };
}

function config(over: Partial<LiveConfig> = {}): LiveConfig {
  return {
    settings: {},
    claudeMd: { global: null, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
    ...over,
  } as unknown as LiveConfig;
}

function run(liveConfig: LiveConfig | null | undefined, now = 0) {
  const input = { liveConfig } as unknown as RecommendationInput;
  return detector.rule(input, now);
}

// ── Silence cases ──────────────────────────────────────────────────────────

describe('maintenance.skill-hook-integrity — silence', () => {
  it('emits nothing when liveConfig is absent (filter-nothing degrade)', () => {
    expect(run(null)).toBeNull();
    expect(run(undefined)).toBeNull();
  });

  it('emits nothing on a config with no hooks and no skills', () => {
    expect(run(config())).toBeNull();
  });

  it('stays silent for present and unverifiable hook paths', () => {
    const c = config({
      settings: {
        hooks: {
          Stop: [
            hookGroup('node ~/.claude/hooks/ok.mjs', [
              { path: '~/.claude/hooks/ok.mjs', state: 'present', checkedAt: CHECKED_AT },
              {
                path: '~/.claude/skills/unmounted/run.mjs',
                state: 'unverifiable',
                checkedAt: CHECKED_AT,
              },
            ]),
          ],
        },
      },
    });
    expect(run(c)).toBeNull();
  });

  it('stays silent when a hook command carries NO referencedPaths (opaque/pre-#2500)', () => {
    // An env-var-opaque command (e.g. `$MY_TOOL check`) is skipped at ingest and
    // reaches the detector with no referencedPaths — it must never be flagged.
    const c = config({
      settings: { hooks: { PreToolUse: [hookGroup('"$MY_TOOL" check --fast')] } },
    });
    expect(run(c)).toBeNull();
  });

  it('stays silent when no skill has dangling references', () => {
    expect(run(config({ skills: [skill('clean-skill')] }))).toBeNull();
  });
});

// ── Signal 1: dangling hook script ─────────────────────────────────────────

describe('maintenance.skill-hook-integrity — dangling hook script', () => {
  it('flags a hook script missing at ingest with EXACT settings-key provenance', () => {
    const c = config({
      settings: {
        hooks: {
          Stop: [
            hookGroup('node ~/.claude/hooks/gone.mjs', [
              { path: '~/.claude/hooks/gone.mjs', state: 'missing', checkedAt: CHECKED_AT },
            ]),
          ],
        },
      },
    });
    const rec = run(c);
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning'); // structural breakage
    expect(rec!.title).toContain('Recorded');
    expect(rec!.title).not.toContain('broken');
    // Exact settings key path down to the command.
    expect(rec!.evidence![0]).toContain('hooks.Stop[0].hooks[0].command');
    expect(rec!.evidence![0]).toContain('~/.claude/hooks/gone.mjs');
    expect(rec!.evidence![0]).toContain('hook references a missing script');
    expect(rec!.evidence![0]).toContain(CHECKED_AT);
    expect(rec!.provenance!.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'liveConfig.settings.hooks.Stop[0].hooks[0].referencedPaths[0].state',
        value: 'missing',
      }),
      expect.objectContaining({
        field: 'liveConfig.settings.hooks.Stop[0].hooks[0].referencedPaths[0].checkedAt',
        value: CHECKED_AT,
      }),
    ]));
  });

  it('flags project-scoped hooks with a projectSettings key path', () => {
    const c = config({
      projectSettings: {
        '/repo/app': {
          hooks: {
            PostToolUse: [
              hookGroup('$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh', [
                {
                  path: '$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh',
                  state: 'missing',
                  checkedAt: CHECKED_AT,
                },
              ]),
            ],
          },
        },
      },
    });
    const rec = run(c);
    expect(rec).not.toBeNull();
    expect(rec!.evidence![0]).toContain(
      'projectSettings["/repo/app"].hooks.PostToolUse[0].hooks[0].command'
    );
    expect(rec!.provenance!.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field:
          'liveConfig.projectSettings["/repo/app"].hooks.PostToolUse[0].hooks[0].referencedPaths[0].state',
      }),
    ]));
    expect(rec!.provenance!.observations[0].field).toContain(
      'liveConfig.projectSettings[*].hooks'
    );
  });

  it('does not flag a present path even alongside a missing one', () => {
    const c = config({
      settings: {
        hooks: {
          Stop: [
            hookGroup('node ~/.claude/hooks/a.mjs ~/.claude/hooks/b.mjs', [
              { path: '~/.claude/hooks/a.mjs', state: 'present', checkedAt: CHECKED_AT },
              { path: '~/.claude/hooks/b.mjs', state: 'missing', checkedAt: CHECKED_AT },
            ]),
          ],
        },
      },
    });
    const rec = run(c);
    expect(rec!.affected).toBe(1); // only the missing one
    expect(rec!.evidence![0]).toContain('~/.claude/hooks/b.mjs');
  });

  it('fails closed for legacy or malformed path-state records', () => {
    const malformed = [
      { path: '~/.claude/hooks/legacy.mjs', exists: false },
      { path: '~/.claude/hooks/no-time.mjs', state: 'missing' },
      { path: '~/.claude/hooks/bad-time.mjs', state: 'missing', checkedAt: 'yesterday' },
      { path: 42, state: 'missing', checkedAt: CHECKED_AT },
      { path: '~/.claude/hooks/bad-state.mjs', state: 'gone', checkedAt: CHECKED_AT },
    ];
    const c = config({
      settings: { hooks: { Stop: [hookGroup('node hook.mjs', malformed)] } },
    });
    expect(run(c)).toBeNull();
  });
});

// ── Signal 2: dangling skill reference ─────────────────────────────────────

describe('maintenance.skill-hook-integrity — dangling skill reference', () => {
  it('flags a skill whose SKILL.md references a removed bundled path', () => {
    const rec = run(config({ skills: [skill('my-skill', ['scripts/gone.py'])] }));
    expect(rec).not.toBeNull();
    expect(rec!.affected).toBe(1);
    expect(rec!.severity).toBe('warning');
    expect(rec!.evidence![0]).toContain('skills["my-skill"]/SKILL.md');
    expect(rec!.evidence![0]).toContain('scripts/gone.py');
    expect(rec!.evidence![0]).toContain('skill references a removed bundled path');
  });

  it('aggregates dangling refs across multiple skills', () => {
    const rec = run(
      config({
        skills: [
          skill('a', ['references/x.md']),
          skill('b', ['scripts/y.sh', 'data/z.json']),
        ],
      })
    );
    expect(rec!.affected).toBe(3);
  });
});

// ── Grouped card + auditability contract ───────────────────────────────────

describe('maintenance.skill-hook-integrity — grouped card + contract', () => {
  function kitchenSink(): LiveConfig {
    return config({
      settings: {
        hooks: {
          Stop: [
            hookGroup('node ~/.claude/hooks/gone.mjs', [
              { path: '~/.claude/hooks/gone.mjs', state: 'missing', checkedAt: CHECKED_AT },
            ]),
          ],
        },
      },
      skills: [skill('my-skill', ['scripts/gone.py'])],
    });
  }

  it('emits ONE recommendation covering both signals', () => {
    const rec = run(kitchenSink());
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe('maintenance.skill-hook-integrity');
    expect(rec!.category).toBe('maintenance');
    expect(rec!.affected).toBe(2); // one hook + one skill
    expect(rec!.severity).toBe('warning');
    expect(rec!).toMatchObject({
      claimClass: 'accounting',
      proofTier: 'accounting',
    });
    expect(rec!.detail).toContain('1 hook references a missing script');
    expect(rec!.detail).toContain('1 skill references a removed bundled path');
  });

  it('is recommend-only — never ships an auto-apply fix', () => {
    const rec = run(kitchenSink());
    expect(rec!.fix).toBeUndefined();
  });

  it('carries auditable provenance that passes the contract', () => {
    const rec = run(kitchenSink());
    expect(rec!.provenance).toBeDefined();
    expect(rec!.provenance!.observations[0].source).toBe('config-loader (assembleLiveConfig)');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('dates the claim to the actual path check instead of detector time', () => {
    const now = Date.parse('2026-07-11T00:00:00Z');
    const rec = run(kitchenSink(), now);
    expect(rec!.provenance!.asOf).toBe('2026-07-10');
    expect(rec!.detail).toContain(CHECKED_AT);
    expect(rec!.detail).not.toMatch(/is currently missing/i);
    expect(rec!.provenance!.stale).toBeUndefined();
  });

  it('marks an old path check stale and keeps stale wording tied to its timestamp', () => {
    const rec = run(kitchenSink(), Date.parse('2026-09-15T00:00:00Z'));
    expect(rec!.provenance).toMatchObject({ asOf: '2026-07-10', stale: true });
    expect(rec!.detail).toContain(CHECKED_AT);
    expect(rec!.detail).toMatch(/recheck/i);
  });
});

describe('maintenance.skill-hook-integrity — cache validity', () => {
  const input = {
    liveConfig: config({
      settings: {
        hooks: {
          Stop: [
            hookGroup('node ~/.claude/hooks/gone.mjs', [
              {
                path: '~/.claude/hooks/gone.mjs',
                state: 'missing',
                checkedAt: CHECKED_AT,
              },
            ]),
          ],
        },
      },
    }),
  } as RecommendationInput;
  const staleAfter =
    Date.parse(CHECKED_AT) + 28 * 24 * 60 * 60 * 1000;

  it('uses the exact fresh/stale boundary in both clock directions', () => {
    const fresh = skillHookIntegrityCacheValidity(input, staleAfter);
    expect(fresh).toEqual({ after: null, through: staleAfter });
    expect(skillHookIntegrityCacheValidityContains(fresh, staleAfter)).toBe(true);
    expect(skillHookIntegrityCacheValidityContains(fresh, staleAfter + 1)).toBe(false);

    const stale = skillHookIntegrityCacheValidity(input, staleAfter + 1);
    expect(stale).toEqual({ after: staleAfter, through: null });
    expect(skillHookIntegrityCacheValidityContains(stale, staleAfter + 1)).toBe(true);
    expect(skillHookIntegrityCacheValidityContains(stale, staleAfter)).toBe(false);
  });

  it('has no clock transition without a valid missing hook observation', () => {
    const noMissingHook = {
      liveConfig: config({
        settings: {
          hooks: {
            Stop: [
              hookGroup('node ~/.claude/hooks/ok.mjs', [
                {
                  path: '~/.claude/hooks/ok.mjs',
                  state: 'present',
                  checkedAt: CHECKED_AT,
                },
              ]),
            ],
          },
        },
      }),
    } as RecommendationInput;
    expect(skillHookIntegrityCacheValidity(noMissingHook, staleAfter)).toEqual({
      after: null,
      through: null,
    });
  });
});
