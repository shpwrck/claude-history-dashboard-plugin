import { describe, it, expect } from 'vitest';
import { detector } from './shared-checkout-rework';
import {
  deriveBashCommandSignals,
  stripToolCommandBodies,
} from '../../parse-tools';
import type { RecommendationInput } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

let seq = 0;
const bash = (command: string, ts?: string): ToolCall => ({
  timestamp: ts ?? `2026-06-09T00:00:${String(seq++).padStart(2, '0')}Z`,
  toolName: 'Bash',
  input: { command },
  toolUseId: `u${seq}`,
  isError: null,
  resultBytes: 0,
});

const session = (sessionId: string, commands: string[]): ToolUsageData => {
  seq = 0;
  return { sessionId, calls: commands.map((c, i) => bash(c, `2026-06-09T00:00:${String(i).padStart(2, '0')}Z`)) };
};

const input = (toolData: ToolUsageData[]): RecommendationInput => ({
  tokenData: [],
  toolData,
  sessions: [],
  projects: [],
  permissionRows: [],
  apiErrors: [],
  liveConfig: null,
});

// S1 — stash, switch branch, pop: moving a tree across a branch switch.
const S1_COMMANDS = [
  'git status',
  'git stash',
  'git checkout master',
  'npm ci',
  'git stash pop',
];

// S2 — reflog + cherry-pick: recovering an orphaned commit after a foreign HEAD swap.
const S2_COMMANDS = [
  'git status',
  'git reflog | head -20',
  'git cherry-pick 8519e3f',
  'npx vite build',
];

// Clean worktree session — the structural cure; must NOT fire.
const CLEAN_WORKTREE_COMMANDS = [
  'git worktree add -b feature/x ../wt origin/master',
  'npm ci',
  'git add src/foo.ts',
  'git commit -m "feat: x"',
  'git push -u origin feature/x',
];

describe('workflow.shared-checkout-rework (#956)', () => {
  it('fires on the S1 stash-transport signature', () => {
    const rec = detector.rule(input([session('s1', S1_COMMANDS)]), 0)!;
    expect(rec).not.toBeNull();
    expect(rec.id).toBe('workflow.shared-checkout-rework');
    expect(rec.category).toBe('workflow');
    expect(rec.affected).toBe(1);
    expect(rec.evidence?.[0]).toContain('S1');
    expect(rec.action).toMatch(/worktree/i);
  });

  it('fires on the S2 reflog-recovery signature', () => {
    const rec = detector.rule(input([session('s2', S2_COMMANDS)]), 0)!;
    expect(rec).not.toBeNull();
    expect(rec.evidence?.[0]).toContain('S2');
  });

  it('prescribes reflog recovery and worktree-first prevention without over-claiming Rewind', () => {
    const rec = detector.rule(input([session('s2', S2_COMMANDS)]), 0)!;

    expect(rec.action).toMatch(/worktree-first prevention/i);
    expect(rec.action).toMatch(/git-reflog-guided recovery/i);
    expect(rec.action).toMatch(/Rewind only helps with self-inflicted checkpointed edits/i);
    expect(rec.action).toMatch(/does not recover another concurrent session's checkout/i);
    expect(rec.action).not.toMatch(/Rewind recovers (a )?foreign-HEAD-swap/i);

    expect(rec.fix?.target).toBe('command');
    expect(rec.fix?.fixKind).toBe('manual');
    expect(rec.fix?.label).toMatch(/git reflog/i);
    expect(rec.fix?.snippet).toContain('git reflog --date=iso');
    expect(rec.fix?.snippet).toContain('git merge --ff-only');
    expect(rec.fix?.snippet).toContain('git cherry-pick');
    expect(rec.fix?.note).toMatch(/not another session's checkout/i);
  });

  it('fails closed on conditionally reachable git arms without per-arm results', () => {
    const command = 'git stash && git checkout master && git stash pop';
    const parsed: ToolUsageData = {
      sessionId: 'conditional-chain',
      calls: [{ ...bash(command), ...deriveBashCommandSignals(command) }],
    };

    expect(parsed.calls[0].commandGitSegments).toBeUndefined();
    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(detector.rule(input([data]), 0)).toBeNull();
    }
  });

  it('preserves an ordinary semicolon-separated S1 sequence', () => {
    const command = 'git stash; git checkout master; git stash pop';
    const parsed: ToolUsageData = {
      sessionId: 'semicolon-chain',
      calls: [{ ...bash(command), ...deriveBashCommandSignals(command) }],
    };

    expect(parsed.calls[0].commandGitSegments).toEqual([
      'git stash',
      'git checkout master',
      'git stash pop',
    ]);
    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(detector.rule(input([data]), 0)).not.toBeNull();
    }
  });

  it('fires from compact git segments after raw command bodies are stripped', () => {
    const rec = detector.rule(
      input([
        {
          sessionId: 'stripped',
          calls: [
            {
              timestamp: '2026-06-09T00:00:00Z',
              toolName: 'Bash',
              input: {},
              toolUseId: 'u1',
              isError: null,
              resultBytes: 0,
              commandPreview: 'echo setup '.repeat(20).slice(0, 200),
              commandGitSegments: ['git stash', 'git checkout master', 'git stash pop'],
            },
          ],
        },
      ]),
      0,
    );
    expect(rec).not.toBeNull();
    expect(rec?.evidence?.[0]).toContain('S1');
  });

  it('ignores quoted and non-command git argv before and after stripping', () => {
    const parsed = (sessionId: string, commands: string[]): ToolUsageData => ({
      sessionId,
      calls: commands.map((command, index) => ({
        ...bash(command, `2026-06-09T00:00:0${index}Z`),
        ...deriveBashCommandSignals(command),
      })),
    });
    const quoted = parsed('quoted-git-argv', [
      'printf %s "git stash"',
      'printf %s "git checkout main"',
      'printf %s "git stash pop"',
    ]);
    const unquoted = parsed('unquoted-git-argv', [
      'printf %s git stash',
      'printf %s git checkout main',
      'printf %s git stash pop',
    ]);
    const actual = parsed('actual-git-commands', [
      'git stash',
      'git checkout main',
      'git stash pop',
    ]);

    for (const falseSequence of [quoted, unquoted]) {
      expect(
        falseSequence.calls.every(
          (call) => call.commandGitSegments === undefined
        )
      ).toBe(true);
      for (const data of [
        falseSequence,
        stripToolCommandBodies(falseSequence),
      ]) {
        expect(detector.rule(input([data]), 0)).toBeNull();
      }
    }
    expect(actual.calls.map((call) => call.commandGitSegments)).toEqual([
      ['git stash'],
      ['git checkout main'],
      ['git stash pop'],
    ]);
    for (const data of [actual, stripToolCommandBodies(actual)]) {
      expect(detector.rule(input([data]), 0)).not.toBeNull();
    }
  });

  it.each([
    {
      label: 'backward',
      timestamps: [
        '2026-06-09T00:00:03Z',
        '2026-06-09T00:00:01Z',
        '2026-06-09T00:00:02Z',
      ],
    },
    {
      label: 'equal',
      timestamps: [
        '2026-06-09T00:00:01Z',
        '2026-06-09T00:00:01Z',
        '2026-06-09T00:00:01Z',
      ],
    },
    {
      label: 'missing',
      timestamps: ['2026-06-09T00:00:03Z', '', '2026-06-09T00:00:02Z'],
    },
  ])(
    'uses transcript order rather than $label timestamps before and after stripping',
    ({ label, timestamps }) => {
      const parsed = (
        sessionId: string,
        commands: string[]
      ): ToolUsageData => ({
        sessionId,
        calls: commands.map((command, index) => ({
          ...bash(command, timestamps[index]),
          ...deriveBashCommandSignals(command),
        })),
      });
      // Sorting these clocks can fabricate stash -> switch -> pop. In the
      // transcript, pop happened first and the later stash was never popped.
      const notTransported = parsed(`${label}-negative`, [
        'git stash pop',
        'git stash',
        'git checkout main',
      ]);
      const transported = parsed(`${label}-positive`, [
        'git stash',
        'git checkout main',
        'git stash pop',
      ]);

      for (const data of [
        notTransported,
        stripToolCommandBodies(notTransported),
      ]) {
        expect(detector.rule(input([data]), 0)).toBeNull();
      }
      for (const data of [transported, stripToolCommandBodies(transported)]) {
        expect(detector.rule(input([data]), 0)).not.toBeNull();
      }
    }
  );

  it('does not attribute a pop to an older pre-switch stash after a new stash', () => {
    const commands = [
      'git stash',
      'git checkout feature-b',
      'git stash push',
      'git stash pop',
    ];
    const parsed: ToolUsageData = {
      sessionId: 'newer-stash-after-switch',
      calls: commands.map((command, index) => ({
        ...bash(command, `2026-06-09T00:00:0${index}Z`),
        ...deriveBashCommandSignals(command),
      })),
    };

    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(detector.rule(input([data]), 0)).toBeNull();
    }
  });

  it.each([
    'git checkout HEAD -- src/foo.ts',
    'git checkout HEAD src/foo.ts',
    'git checkout main src/foo.ts',
    'git checkout ./src/foo.ts',
    'git checkout ../src/foo.ts',
    'git checkout /tmp/foo.ts',
    'git checkout :/src/foo.ts',
    "git checkout ':(top)src/foo.ts'",
    'git checkout .gitignore',
    'git checkout docs/.hidden',
    'git checkout foo.lock',
    'git checkout docs/foo.lock',
    'git checkout foo..bar',
    'git checkout feature//foo',
    'git checkout @',
    "git checkout 'feature@{upstream}'",
    "git checkout 'src/*.ts'",
    "git checkout 'src/foo bar.ts'",
    'git checkout src/',
    'git checkout -q -- src/foo.ts',
    'git checkout -q .',
  ])('does not treat a normalized checkout path restore as a branch switch: %s', (restore) => {
    const commands = ['git stash', restore, 'git stash pop'];
    const parsed: ToolUsageData = {
      sessionId: 'checkout-path-restore',
      calls: commands.map((command, index) => ({
        ...bash(command, `2026-06-09T00:00:0${index}Z`),
        ...deriveBashCommandSignals(command),
      })),
    };

    expect(parsed.calls[1].commandGitSegments).toBeUndefined();
    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(detector.rule(input([data]), 0)).toBeNull();
    }
  });

  it('preserves an option-prefixed real branch switch', () => {
    const commands = ['git stash', 'git checkout -q main', 'git stash pop'];
    const parsed: ToolUsageData = {
      sessionId: 'quiet-branch-switch',
      calls: commands.map((command, index) => ({
        ...bash(command, `2026-06-09T00:00:0${index}Z`),
        ...deriveBashCommandSignals(command),
      })),
    };

    expect(parsed.calls[1].commandGitSegments).toEqual(['git checkout main']);
    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(detector.rule(input([data]), 0)).not.toBeNull();
    }
  });

  it.each([
    {
      label: 'help-only operations',
      commands: [
        'git stash --help',
        'git checkout --help',
        'git stash pop --help',
      ],
    },
    {
      label: 'stash create',
      commands: ['git stash create', 'git checkout main', 'git stash pop'],
    },
    {
      label: 'conditional substitution',
      commands: [
        'echo "${x:-$(git stash)}"',
        'git checkout main',
        'git stash pop',
      ],
    },
    {
      label: 'arithmetic short circuit',
      commands: [
        'echo "$((0 && $(git stash)))"',
        'git checkout main',
        'git stash pop',
      ],
    },
  ])('does not seed S1 from $label before or after stripping', ({ label, commands }) => {
    const parsed: ToolUsageData = {
      sessionId: `non-seed-${label}`,
      calls: commands.map((command, index) => ({
        ...bash(command, `2026-06-09T00:00:0${index}Z`),
        ...deriveBashCommandSignals(command),
      })),
    };

    expect(parsed.calls[0].commandGitSegments).toBeUndefined();
    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(detector.rule(input([data]), 0)).toBeNull();
    }
  });

  it.each([
    'true || git stash',
    'exit 0; git stash',
    'exec true; git stash',
  ])(
    'does not invent a stash after an unreachable shell branch: %s',
    (firstCommand) => {
      const commands = [
        firstCommand,
        'git checkout main',
        'git stash pop',
      ];
      const parsed: ToolUsageData = {
        sessionId: 'unreachable-stash',
        calls: commands.map((command, index) => ({
          ...bash(command, `2026-06-09T00:00:0${index}Z`),
          isError: false,
          ...deriveBashCommandSignals(command),
        })),
      };

      expect(parsed.calls[0].commandGitSegments).toBeUndefined();
      for (const data of [parsed, stripToolCommandBodies(parsed)]) {
        expect(detector.rule(input([data]), 0)).toBeNull();
      }
    }
  );

  it.each([0, 1, 2])(
    'ignores a known-failed S1 operation at index %s',
    (failedIndex) => {
      const commands = ['git stash', 'git checkout main', 'git stash pop'];
      const parsed: ToolUsageData = {
        sessionId: `failed-s1-${failedIndex}`,
        calls: commands.map((command, index) => ({
          ...bash(command, `2026-06-09T00:00:0${index}Z`),
          isError: index === failedIndex,
          ...deriveBashCommandSignals(command),
        })),
      };

      for (const data of [parsed, stripToolCommandBodies(parsed)]) {
        expect(detector.rule(input([data]), 0)).toBeNull();
      }
    }
  );

  it('ignores a known-failed reflog recovery operation', () => {
    const commands = ['git reflog', 'git cherry-pick deadbeef'];
    const parsed: ToolUsageData = {
      sessionId: 'failed-s2',
      calls: commands.map((command, index) => ({
        ...bash(command, `2026-06-09T00:00:0${index}Z`),
        isError: index === 1,
        ...deriveBashCommandSignals(command),
      })),
    };

    for (const data of [parsed, stripToolCommandBodies(parsed)]) {
      expect(detector.rule(input([data]), 0)).toBeNull();
    }
  });

  it.each([
    ['git reflog expire --expire=now --all', 'git cherry-pick --abort'],
    ['git reflog delete HEAD@{0}', 'git cherry-pick --continue'],
    ['git reflog exists refs/heads/main', 'git cherry-pick --quit'],
    ['git reflog show', 'git cherry-pick --skip'],
    ['git reflog show', 'git merge --ff-only'],
    ['git reflog show', 'git merge --ff-only --abort'],
  ])(
    'does not treat maintenance/control commands as S2 recovery: %s; %s',
    (reflog, recovery) => {
      const commands = [reflog, recovery];
      const parsed: ToolUsageData = {
        sessionId: 's2-control-negative',
        calls: commands.map((command, index) => ({
          ...bash(command, `2026-06-09T00:00:0${index}Z`),
          isError: false,
          ...deriveBashCommandSignals(command),
        })),
      };

      for (const data of [parsed, stripToolCommandBodies(parsed)]) {
        expect(detector.rule(input([data]), 0)).toBeNull();
      }
    }
  );

  it.each([
    ['git reflog show', 'git cherry-pick deadbeef'],
    ['git reflog show', 'git merge --ff-only origin/main'],
  ])(
    'retains an action-specific S2 recovery signature: %s; %s',
    (reflog, recovery) => {
      const commands = [reflog, recovery];
      const parsed: ToolUsageData = {
        sessionId: 's2-action-positive',
        calls: commands.map((command, index) => ({
          ...bash(command, `2026-06-09T00:00:0${index}Z`),
          isError: false,
          ...deriveBashCommandSignals(command),
        })),
      };

      for (const data of [parsed, stripToolCommandBodies(parsed)]) {
        expect(detector.rule(input([data]), 0)).not.toBeNull();
      }
    }
  );

  it('honors parser-owned malformed-shell negatives before and after stripping', () => {
    const command = 'true > ; git stash; git checkout master; git stash pop';
    const parsed: ToolUsageData = {
      sessionId: 'malformed',
      calls: [
        {
          ...bash(command, '2026-06-09T00:00:00Z'),
          isError: true,
          ...deriveBashCommandSignals(command),
        },
      ],
    };

    expect(parsed.calls[0].commandAnalysisComplete).toBe(true);
    expect(parsed.calls[0].commandGitSegments).toBeUndefined();
    expect(detector.rule(input([parsed]), 0)).toBeNull();
    expect(
      detector.rule(input([stripToolCommandBodies(parsed)]), 0)
    ).toBeNull();

    // A marker-less legacy row still uses its raw command fallback.
    expect(
      detector.rule(input([session('legacy', [command])]), 0)
    ).not.toBeNull();
  });

  it('does not resurrect a skipped git branch after an unproven redirect', () => {
    const skippedCommands = [
      [
        'true 2>&foo && git stash',
        'git checkout master',
        'git stash pop',
      ],
      [
        'if false; then git stash; fi',
        'git checkout master',
        'git stash pop',
      ],
      [
        'if true; then false; fi && git stash',
        'git checkout master',
        'git stash pop',
      ],
      [
        'if false; then true; fi || git stash',
        'git checkout master',
        'git stash pop',
      ],
      [
        'f(){ git stash; }; true',
        'git checkout master',
        'git stash pop',
      ],
    ];
    const independentCommands = [
      'true 2>&foo; git stash',
      'git checkout master',
      'git stash pop',
    ];
    const parsed = (sessionId: string, commands: string[]): ToolUsageData => ({
      sessionId,
      calls: commands.map((command, index) => ({
        ...bash(command, `2026-06-09T00:00:0${index}Z`),
        ...deriveBashCommandSignals(command),
      })),
    });
    const independent = parsed('redirect-independent', independentCommands);
    const skipped = skippedCommands.map((commands, index) =>
      parsed(`redirect-skipped-${index}`, commands)
    );

    expect(
      skipped.every((data) => data.calls[0].commandGitSegments === undefined)
    ).toBe(true);
    expect(independent.calls[0].commandGitSegments).toEqual(['git stash']);
    for (const skippedData of skipped) {
      for (const data of [
        skippedData,
        stripToolCommandBodies(skippedData),
      ]) {
        expect(detector.rule(input([data]), 0)).toBeNull();
      }
    }
    for (const data of [independent, stripToolCommandBodies(independent)]) {
      expect(detector.rule(input([data]), 0)).not.toBeNull();
    }
  });

  it('does NOT fire on a clean worktree-based session (negative fixture)', () => {
    const rec = detector.rule(input([session('clean', CLEAN_WORKTREE_COMMANDS)]), 0);
    expect(rec).toBeNull();
  });

  it('does NOT fire on a benign same-branch stash round-trip (no branch switch)', () => {
    const rec = detector.rule(
      input([session('benign', ['git stash', 'npm test', 'git stash pop'])]),
      0,
    );
    expect(rec).toBeNull();
  });

  it('does NOT fire on a bare git checkout of a file (not a branch move)', () => {
    const rec = detector.rule(
      input([session('filerestore', ['git stash', 'git checkout -- src/foo.ts', 'git stash pop'])]),
      0,
    );
    expect(rec).toBeNull();
  });

  it('does NOT fire on reflog inspection without a cherry-pick/ff-merge recovery', () => {
    const rec = detector.rule(input([session('inspect', ['git reflog', 'git log --oneline'])]), 0);
    expect(rec).toBeNull();
  });

  it('scales severity with the count of flagged sessions', () => {
    const one = detector.rule(input([session('a', S2_COMMANDS)]), 0)!;
    expect(one.severity).toBe('info');
    const three = detector.rule(
      input([
        session('a', S2_COMMANDS),
        session('b', S1_COMMANDS),
        session('c', S2_COMMANDS),
      ]),
      0,
    )!;
    expect(three.severity).toBe('warning');
    expect(three.affected).toBe(3);
  });

  it('carries auditable provenance citing the command artifact/field', () => {
    const rec = detector.rule(input([session('s2', S2_COMMANDS)]), 0)!;
    expect(rec.provenance?.observations[0].source).toBe('parse-tools');
    expect(rec.provenance?.observations[0].field).toBe(
      'toolData[].calls[].commandGitSegments/input.command/commandPreview'
    );
    expect(rec.provenance?.observations[0].value).toBe(1);
    expect(rec.provenance?.asOf).toBe('2026-06-09');
  });

  it('emits nothing on an empty / transcript-free dataset', () => {
    expect(detector.rule(input([]), 0)).toBeNull();
    expect(detector.rule(input([session('empty', ['ls', 'npm test'])]), 0)).toBeNull();
  });
});
