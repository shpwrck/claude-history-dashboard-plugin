/**
 * blocked-task-pileup.test.ts
 *
 * Tests for the workflow.blocked-task-pileup detector.
 * Constructs minimal RecommendationInput with the `tasks` field.
 *
 * Issue #559.
 */
import { describe, it, expect } from 'vitest';
import { detector, toSingleLine, commentOnly } from './blocked-task-pileup';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { TaskRecord } from '../../parse-tasks';
import { PILEUP_MIN } from '../../parse-tasks';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<TaskRecord> & {
    id: string;
    sessionId: string;
    status: TaskRecord['status'];
  }
): TaskRecord {
  return {
    subject: 'Task ' + overrides.id,
    description: '',
    activeForm: '',
    owner: '',
    blocks: [],
    blockedBy: [],
    mtimeMs: Date.now(),
    ...overrides,
  };
}

function makeInput(tasks: TaskRecord[]): RecommendationInput & { tasks: TaskRecord[] } {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    tasks,
  } as unknown as RecommendationInput & { tasks: TaskRecord[] };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflow.blocked-task-pileup (#559)', () => {
  it('returns null when tasks array is empty', () => {
    expect(detector.rule(makeInput([]), 0)).toBeNull();
  });

  it('returns null when tasks field is absent', () => {
    const input = {
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    } as unknown as RecommendationInput;
    expect(detector.rule(input, 0)).toBeNull();
  });

  it('returns null when no tasks have blockedBy entries', () => {
    const tasks = [
      makeTask({ id: '1', sessionId: 's1', status: 'pending' }),
      makeTask({ id: '2', sessionId: 's1', status: 'in_progress' }),
    ];
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it('returns null when root task is completed (no actual pileup)', () => {
    // root is done => its dependents are NOT a pileup
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'completed', subject: 'Root' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it(`returns null when fewer than ${PILEUP_MIN} tasks are blocked behind an unfinished root`, () => {
    // Only 1 blocked task — below the threshold
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Root' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it(`fires when >= ${PILEUP_MIN} tasks are blocked behind an unfinished root`, () => {
    // Mirror the fraud-ml scenario from gen-mock.mjs
    const tasks = [
      makeTask({
        id: 'r7',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'Retrain fraud model v7',
      }),
      makeTask({
        id: 'c1',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'Shadow-deploy v7 scorer',
        blockedBy: ['r7'],
      }),
      makeTask({
        id: 'c2',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'A/B harness for v7',
        blockedBy: ['r7'],
      }),
      makeTask({
        id: 'c3',
        sessionId: 'fraud-ml-session',
        status: 'pending',
        subject: 'Cutover docs for v7',
        blockedBy: ['r7'],
      }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.id).toBe('workflow.blocked-task-pileup');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(3);
  });

  it('includes root subject in the detail', () => {
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Migrate DB schema' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.detail).toContain('Migrate DB schema');
  });

  it('includes a copy-pasteable fix snippet mentioning the root task', () => {
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Root Task Alpha' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'in_progress', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.fix?.snippet).toContain('Root Task Alpha');
  });

  it('sorts pileups largest-first in evidence', () => {
    // s1: 3 blocked; s2: 2 blocked — s1 should appear first
    const tasks: TaskRecord[] = [
      makeTask({ id: 'root1', sessionId: 's1', status: 'pending', subject: 'Root 1' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root1'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'pending', blockedBy: ['root1'] }),
      makeTask({ id: 'c3', sessionId: 's1', status: 'pending', blockedBy: ['root1'] }),

      makeTask({ id: 'root2', sessionId: 's2', status: 'pending', subject: 'Root 2' }),
      makeTask({ id: 'c4', sessionId: 's2', status: 'pending', blockedBy: ['root2'] }),
      makeTask({ id: 'c5', sessionId: 's2', status: 'pending', blockedBy: ['root2'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    expect(rec?.evidence?.[0]).toContain('3 task(s)');
    expect(rec?.affected).toBe(5); // 3 + 2
  });

  it('only matches blockedBy roots within the SAME session', () => {
    // Root is in session A, the blocked tasks are in session B — not a pileup
    const tasks: TaskRecord[] = [
      makeTask({ id: 'shared-root', sessionId: 'session-A', status: 'pending', subject: 'Shared Root' }),
      // These tasks reference the root id but live in a different session — no match
      makeTask({ id: 'c1', sessionId: 'session-B', status: 'pending', blockedBy: ['shared-root'] }),
      makeTask({ id: 'c2', sessionId: 'session-B', status: 'pending', blockedBy: ['shared-root'] }),
    ];
    // session-B doesn't contain 'shared-root', so no pileup
    expect(detector.rule(makeInput(tasks), 0)).toBeNull();
  });

  it('correctly counts only non-completed blocked tasks', () => {
    // Root not done; 2 children are pending, 1 child is completed — only 2 should count
    const tasks = [
      makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: 'Root' }),
      makeTask({ id: 'c1', sessionId: 's1', status: 'pending', blockedBy: ['root'] }),
      makeTask({ id: 'c2', sessionId: 's1', status: 'completed', blockedBy: ['root'] }), // done — not stalled
      makeTask({ id: 'c3', sessionId: 's1', status: 'in_progress', blockedBy: ['root'] }),
    ];
    const rec = detector.rule(makeInput(tasks), 0);
    // c2 is completed so it's excluded from blocked count; c1 + c3 = 2 >= PILEUP_MIN
    expect(rec?.id).toBe('workflow.blocked-task-pileup');
    expect(rec?.affected).toBe(2);
  });
});

// ── #3231: the comment-only snippet must stay comment-only ──────────────────
//
// Task subjects are arbitrary parsed strings. A subject containing a newline
// followed by shell text used to terminate the `#` comment and leave an
// executable line in the copy-paste snippet.

describe('workflow.blocked-task-pileup comment-only fix snippet (#3231)', () => {
  const INJECT = '\nprintf owned';

  function pileupWith(rootSubject: string, childSubject: string) {
    return detector.rule(
      makeInput([
        makeTask({ id: 'root', sessionId: 's1', status: 'pending', subject: rootSubject }),
        makeTask({
          id: 'c1',
          sessionId: 's1',
          status: 'pending',
          subject: childSubject,
          blockedBy: ['root'],
        }),
        makeTask({
          id: 'c2',
          sessionId: 's1',
          status: 'pending',
          subject: 'Benign child',
          blockedBy: ['root'],
        }),
      ]),
      0
    );
  }

  it('comments out every physical line when root and child subjects inject newlines', () => {
    const rec = pileupWith(`Root${INJECT}`, `Child${INJECT}`);
    const snippet = rec!.fix!.snippet;
    const lines = snippet.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('#')).toBe(true);
    }
  });

  it('cannot run the injected text — no line is executable', () => {
    const rec = pileupWith(`Root${INJECT}`, `Child${INJECT}`);
    const snippet = rec!.fix!.snippet;
    // The payload survives as inert prose on a commented line, never at the
    // start of a line.
    expect(snippet).toContain('printf owned');
    for (const line of snippet.split('\n')) {
      expect(line).not.toMatch(/^\s*printf/);
    }
    // Stripping comment lines leaves nothing to execute.
    const executable = snippet
      .split('\n')
      .map((l) => l.replace(/^#.*$/, '').trim())
      .filter(Boolean);
    expect(executable).toEqual([]);
  });

  it('flattens carriage returns, NUL, and unicode line separators too', () => {
    const rec = pileupWith(
      'Root\r\nprintf cr',
      'Child\u2028printf ls\u2029printf ps\u0000printf nul'
    );
    for (const line of rec!.fix!.snippet.split('\n')) {
      expect(line.startsWith('#')).toBe(true);
    }
    expect(rec!.fix!.snippet).toContain('printf cr');
    expect(rec!.fix!.snippet).toContain('printf ls');
    expect(rec!.fix!.snippet).toContain('printf nul');
  });

  it('keeps the blank separator between pileups commented', () => {
    const rec = detector.rule(
      makeInput([
        makeTask({ id: 'r1', sessionId: 's1', status: 'pending', subject: `A${INJECT}` }),
        makeTask({ id: 'a1', sessionId: 's1', status: 'pending', blockedBy: ['r1'] }),
        makeTask({ id: 'a2', sessionId: 's1', status: 'pending', blockedBy: ['r1'] }),
        makeTask({ id: 'r2', sessionId: 's2', status: 'pending', subject: `B${INJECT}` }),
        makeTask({ id: 'b1', sessionId: 's2', status: 'pending', blockedBy: ['r2'] }),
        makeTask({ id: 'b2', sessionId: 's2', status: 'pending', blockedBy: ['r2'] }),
      ]),
      0
    );
    const lines = rec!.fix!.snippet.split('\n');
    expect(lines.some((l) => l === '#')).toBe(true); // separator, still a comment
    for (const line of lines) expect(line.startsWith('#')).toBe(true);
  });

  it('keeps a benign snippet readable', () => {
    const rec = pileupWith('Ship the migration', 'Backfill rows');
    const snippet = rec!.fix!.snippet;
    expect(snippet).toContain('# Unblock: "Ship the migration"');
    expect(snippet).toContain('#   - Backfill rows');
    for (const line of snippet.split('\n')) expect(line.startsWith('#')).toBe(true);
  });

  it('DECLARES fixKind explicitly rather than inheriting the default', () => {
    const rec = pileupWith('Ship the migration', 'Backfill rows');
    // The literal field must be PRESENT. An absent fixKind silently defaults to
    // 'validated', leaving the one-click classification undeclared — the
    // implicit-classification defect this PR exists to close. An
    // effectiveFixKind() assertion would pass with the field deleted, so check
    // the raw property.
    expect(Object.prototype.hasOwnProperty.call(rec!.fix!, 'fixKind')).toBe(true);
    expect(rec!.fix!.fixKind).toBe('validated');
    // 'validated' is judged against the DECLARED TARGET. This is a command-target
    // fix whose snippet is entirely `#` lines, so pasting it into a shell is an
    // inert no-op — safe verbatim. (The same text against a settings.json target
    // would be 'manual', because `#` lines are not valid JSON.)
    expect(rec!.fix!.target).toBe('command');
    for (const line of rec!.fix!.snippet.split('\n')) {
      expect(line.startsWith('#')).toBe(true);
    }
  });
});

describe('toSingleLine / commentOnly helpers (#3231)', () => {
  it('collapses every line separator to a single space', () => {
    expect(toSingleLine('a\nb\r\nc d e')).toBe('a b c d e');
    expect(toSingleLine('  padded \n\n text  ')).toBe('padded text');
    expect(toSingleLine('null\u0000byte')).toBe('null byte');
    expect(toSingleLine('u\u2028sep\u2029s')).toBe('u sep s');
  });

  it('prefixes any line that is not already a comment', () => {
    expect(commentOnly('# ok\nrm -rf /\n')).toBe('# ok\n# rm -rf /\n#');
  });
});

// ── Provenance (#3232) ──────────────────────────────────────────────────────

describe('workflow.blocked-task-pileup provenance (#3232)', () => {
  const MTIME = Date.parse('2026-06-09T12:00:00.000Z');
  const NOW = Date.parse('2026-06-20T00:00:00.000Z');

  /**
   * Two pileups in one session, deliberately declared SMALLEST FIRST so the
   * "largest pileup" citation cannot pass by reading insertion order:
   * root-small holds 2 tasks, root-big holds 3.
   */
  const firing = (): TaskRecord[] => [
    makeTask({ id: 'root-small', sessionId: 's-1', status: 'pending', mtimeMs: MTIME }),
    makeTask({ id: 'a', sessionId: 's-1', status: 'pending', blockedBy: ['root-small'], mtimeMs: MTIME }),
    makeTask({ id: 'b', sessionId: 's-1', status: 'pending', blockedBy: ['root-small'], mtimeMs: MTIME }),
    makeTask({
      id: 'root-big',
      subject: 'Land the shared primitive',
      sessionId: 's-1',
      status: 'in_progress',
      mtimeMs: MTIME,
    }),
    makeTask({ id: 'c', sessionId: 's-1', status: 'pending', blockedBy: ['root-big'], mtimeMs: MTIME }),
    makeTask({ id: 'd', sessionId: 's-1', status: 'pending', blockedBy: ['root-big'], mtimeMs: MTIME }),
    makeTask({ id: 'e', sessionId: 's-1', status: 'pending', blockedBy: ['root-big'], mtimeMs: MTIME }),
  ];

  it('passes the contract when it fires', () => {
    const rec = detector.rule(makeInput(firing()), NOW);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec!.provenance!.observations.length).toBeGreaterThan(0);
  });

  it('reproduces the displayed stalled total and pileup count from the cited fields', () => {
    const rec = detector.rule(makeInput(firing()), NOW);
    const obs = rec!.provenance!.observations;
    const stalled = obs.find((o) => o.claim.includes('blocker relationship(s)'));
    const roots = obs.find((o) => o.claim.includes('root task(s)'));
    expect(stalled!.value).toBe(rec!.affected);
    expect(stalled!.value).toBe(5); // 2 behind root-small + 3 behind root-big
    // No task here lists two roots, so edges and distinct tasks agree.
    expect(obs.find((o) => o.claim.includes('distinct stalled task(s)'))!.value).toBe(5);
    expect(roots!.value).toBe(2);
    expect(stalled!.field).toBe('blockedBy / status');
  });

  it('cites the true largest pileup, not the first one encountered', () => {
    const rec = detector.rule(makeInput(firing()), NOW);
    const worst = rec!.provenance!.observations.find((o) =>
      o.claim.includes('largest pileup')
    );
    expect(worst).toBeDefined();
    expect(worst!.value).toBe(3);
    expect(worst!.claim).toContain('Land the shared primitive');
  });

  it('counts blocker relationships, and cites the deduplicated task count too', () => {
    // Two tasks, each blocked by TWO qualifying roots. The displayed figure
    // sums pileup membership, so it is 4 relationships across 2 tasks —
    // calling 4 a task count would be false (Codex review, PR #3472).
    const both = ['root-a', 'root-b'];
    const rec = detector.rule(
      makeInput([
        makeTask({ id: 'root-a', sessionId: 's-1', status: 'in_progress', mtimeMs: MTIME }),
        makeTask({ id: 'root-b', sessionId: 's-1', status: 'in_progress', mtimeMs: MTIME }),
        makeTask({ id: 'x', sessionId: 's-1', status: 'pending', blockedBy: both, mtimeMs: MTIME }),
        makeTask({ id: 'y', sessionId: 's-1', status: 'pending', blockedBy: both, mtimeMs: MTIME }),
      ]),
      NOW
    );
    const obs = rec!.provenance!.observations;
    const edges = obs.find((o) => o.claim.includes('blocker relationship(s)'));
    const distinct = obs.find((o) => o.claim.includes('distinct stalled task(s)'));
    expect(edges!.value).toBe(4);
    expect(edges!.value).toBe(rec!.affected); // the figure the card shows
    expect(distinct!.value).toBe(2); // …and the deduplicated truth beside it
    // The edge claim must not call itself a task count.
    expect(edges!.claim).not.toMatch(/\d+ (?:non-completed )?task\(s\)/);
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('anchors asOf to the newest observed task mtime, not to now', () => {
    const rec = detector.rule(makeInput(firing()), NOW);
    expect(rec!.provenance!.asOf).toBe('2026-06-09');
    expect(rec!.provenance!.asOf).not.toBe('2026-06-20');
  });

  it('ignores a task in a non-pileup session when dating the finding', () => {
    // A freshly written task in a session with no qualifying pileup takes part
    // in none of the reported relationships (Codex review, PR #3472).
    const rec = detector.rule(
      makeInput([
        ...firing(),
        makeTask({ id: 'lonely', sessionId: 's-other', status: 'pending', mtimeMs: NOW - 1000 }),
      ]),
      NOW
    );
    expect(rec!.provenance!.asOf).toBe('2026-06-09');
    expect(rec!.provenance!.asOf).not.toBe('2026-06-20');
  });

  it('keeps a multi-line root subject on one line inside the citation', () => {
    const hostile = firing().map((t) =>
      t.id === 'root-big'
        ? { ...t, subject: 'Land it\nrm -rf /\u2028second' }
        : t
    );
    const rec = detector.rule(makeInput(hostile), NOW);
    const worst = rec!.provenance!.observations.find((o) =>
      o.claim.includes('largest pileup')
    );
    expect(worst!.claim).not.toContain('\n');
    expect(worst!.claim).not.toContain('\u2028');
    expect(worst!.claim).toContain('Land it rm -rf / second');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });
});
