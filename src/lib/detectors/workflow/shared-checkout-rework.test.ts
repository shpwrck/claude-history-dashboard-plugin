import { describe, it, expect } from 'vitest';
import { detector } from './shared-checkout-rework';
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

  it('catches an S1 sequence chained in a single Bash call', () => {
    const rec = detector.rule(
      input([session('s3', ['git stash && git checkout master && git stash pop'])]),
      0,
    );
    // Single-call chain: stash + switch + pop in one command string still matches.
    expect(rec).not.toBeNull();
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
    expect(rec.provenance?.observations[0].field).toBe('toolData[].calls[].commandPreview');
    expect(rec.provenance?.observations[0].value).toBe(1);
    expect(rec.provenance?.asOf).toBe('2026-06-09');
  });

  it('emits nothing on an empty / transcript-free dataset', () => {
    expect(detector.rule(input([]), 0)).toBeNull();
    expect(detector.rule(input([session('empty', ['ls', 'npm test'])]), 0)).toBeNull();
  });
});
