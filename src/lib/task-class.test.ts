import { describe, it, expect } from 'vitest';
import {
  classifyTaskClass,
  classifyTaskClassDetailed,
  TASK_CLASSES,
  DEFAULT_TASK_CLASS,
  type TaskClass,
} from './task-class';

describe('classifyTaskClass (#2139, epic #2138)', () => {
  it('buckets reviewer-role openers as review', () => {
    const reviewOpeners = [
      'reviewer, go: review the open PRs',
      'be the reviewer and approve and merge what is ready',
      '/reviewer',
      'review and merge the ready PR',
      'review the diff and comment findings',
    ];
    for (const opener of reviewOpeners) {
      expect(classifyTaskClass({ entrypoint: 'sdk-cli', opener })).toBe('review');
    }
  });

  it('buckets coder / burn-epic code-write openers as authoring', () => {
    const authoringOpeners = [
      'coder, implement the next for-agent issue',
      'burn the epic: implement the best eligible sub-issue',
      'burn-epic iteration for the active release',
      '/coder',
      'code the next issue in the queue',
    ];
    for (const opener of authoringOpeners) {
      expect(classifyTaskClass({ entrypoint: 'sdk-cli', opener })).toBe('authoring');
    }
  });

  it('buckets pickers / classify / status-writes / log-only replay as mechanical', () => {
    const mechanicalOpeners = [
      'run the route-loose classify pass',
      'groom-pick dry-run to inspect the next issue',
      'route-pick --dry-run',
      'run pick.mjs to select the next eligible issue',
      'write the SPRINT_STATUS.md status file after this round',
      'log-only replay of a past task',
      'replay-run one experiment from the corpus',
      'planReplayBatch over idle capacity',
    ];
    for (const opener of mechanicalOpeners) {
      expect(classifyTaskClass({ entrypoint: 'sdk-cli', opener })).toBe('mechanical');
    }
  });

  it('falls to the documented default (authoring) for an unknown entrypoint / no opener', () => {
    expect(DEFAULT_TASK_CLASS).toBe('authoring');
    // Unknown entrypoint, no opener.
    expect(classifyTaskClass({ entrypoint: 'sdk-weird' })).toBe('authoring');
    // Absent opener entirely.
    expect(classifyTaskClass({})).toBe('authoring');
    // Opener present but matching no role signal.
    expect(classifyTaskClass({ entrypoint: 'sdk-cli', opener: 'do the thing please' })).toBe(
      'authoring'
    );
    // The result cites that the default (not a signal) drove it.
    const detailed = classifyTaskClassDetailed({ entrypoint: 'sdk-cli', opener: 'do the thing' });
    expect(detailed.taskClass).toBe('authoring');
    expect(detailed.signal).toBe('default');
  });

  it('biases to authoring on a keyword collision (the conservative direction)', () => {
    // `burn-epic-pick` contains both a picker word and the authoring `burn-epic`
    // role; authoring is checked first so real code work is never mis-labelled
    // lower-risk merely from picker vocabulary.
    expect(classifyTaskClass({ entrypoint: 'sdk-cli', opener: 'burn-epic-pick --dry-run' })).toBe(
      'authoring'
    );
    // "implement the picker" is code-writing that mentions a picker.
    expect(
      classifyTaskClass({ entrypoint: 'sdk-cli', opener: 'implement the picker logic' })
    ).toBe('authoring');
  });

  it('lets authoring signals beat review vocabulary and never leaks code work to mechanical (#2373 review)', () => {
    // A coder addressing review feedback is authoring, not review, despite "code-review".
    expect(
      classifyTaskClass({ entrypoint: 'sdk-cli', opener: 'coder: implement code-review feedback' })
    ).toBe('authoring');
    // "add --dry-run support to X" is real code work; a bare dry-run must NOT
    // bucket it mechanical (a dangerous risk-classification error).
    expect(
      classifyTaskClass({
        entrypoint: 'sdk-cli',
        opener: 'add --dry-run support to scripts/deploy.sh',
      })
    ).toBe('authoring');
    // A genuine picker dry-run (names the picker) still buckets mechanical.
    expect(
      classifyTaskClass({ entrypoint: 'sdk-cli', opener: 'run route-pick --dry-run' })
    ).toBe('mechanical');
  });

  it('cites the driving signal for auditability', () => {
    const r = classifyTaskClassDetailed({ entrypoint: 'sdk-cli', opener: 'route-loose classify' });
    expect(r.taskClass).toBe('mechanical');
    expect(r.signal).toBe('opener');
    expect(r.reason).toMatch(/route-loose|classify/i);
  });

  it('partitions a mixed sdk-* opener set into exactly one class each, nothing dropped', () => {
    const openers = [
      'coder implement #1',
      'burn the epic',
      'route-loose classify',
      'groom-pick dry-run',
      'reviewer review and merge',
      'write the status file',
      'log-only replay',
      'unrecognized automation prompt',
    ];
    const counts: Record<TaskClass, number> = { authoring: 0, mechanical: 0, review: 0 };
    for (const opener of openers) {
      const cls = classifyTaskClass({ entrypoint: 'sdk-cli', opener });
      expect(TASK_CLASSES).toContain(cls); // always one of the three
      counts[cls] += 1;
    }
    // Every opener was assigned; the class counts sum to the input size.
    expect(counts.authoring + counts.mechanical + counts.review).toBe(openers.length);
    // Sanity: each class got exactly the ones we expect.
    expect(counts.review).toBe(1); // reviewer review-and-merge
    // route-loose, groom-pick, status-file write, log-only replay.
    expect(counts.mechanical).toBe(4);
    // 2 authoring openers (coder, burn the epic) + the 1 unknown → default.
    expect(counts.authoring).toBe(3);
  });

  it('exposes an exhaustive, stable class order', () => {
    expect([...TASK_CLASSES]).toEqual(['authoring', 'mechanical', 'review']);
  });
});
