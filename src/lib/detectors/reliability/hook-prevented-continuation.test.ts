import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { detector } from './hook-prevented-continuation';
import type { RecommendationInput } from '../types';
import type { RuntimeEvents } from '../../parse-runtime-events';

const stop = (prevented: boolean) => ({
  sessionId: 's1', timestamp: 't', hookCount: 1, totalDurationMs: 0,
  hadErrors: false, preventedContinuation: prevented,
});
const runtime = (n: number): RuntimeEvents =>
  ({ sessionId: 's1', turns: [], stopHooks: Array.from({ length: n }, () => stop(true)), awaySummaries: [], scheduledFires: [] } as unknown as RuntimeEvents);
const input = (runtimeEvents?: RuntimeEvents[]): RecommendationInput => ({
  tokenData: [], toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  liveConfig: null, runtimeEvents,
});

describe('reliability.hook-prevented-continuation (#420)', () => {
  it('fires at 5+ blocking events with a hook fix', () => {
    const rec = detector.rule(input([runtime(5)]), 0);
    expect(rec?.id).toBe('reliability.hook-prevented-continuation');
    expect(rec?.fix?.target).toBe('hook');
  });
  it('stays silent below 5 or with no events', () => {
    expect(detector.rule(input([runtime(4)]), 0)).toBeNull();
    expect(detector.rule(input(), 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The emitted fix must not disable the failures it promises to keep (#3211)
// ---------------------------------------------------------------------------

/**
 * Run the hook command the detector actually emits, with the user's check
 * replaced by an inert `exit <code>`.
 *
 * SAFETY: the stub is a bare `exit N` — never a real command, never a
 * redirection, never anything that touches the filesystem. The only thing under
 * test is the decision logic wrapped around the check's status. Do not
 * "improve" this by substituting a real command for `your-check.sh`.
 */
function hookExitCodeFor(command: string, checkExit: number, advisory?: string): number {
  const script = command
    .replace('your-check.sh', `sh -c 'exit ${checkExit}'`)
    .replace('ADVISORY_EXIT_CODE', advisory ?? 'ADVISORY_EXIT_CODE');
  const res = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  return res.status ?? -1;
}

function emittedHookCommand(): string {
  const rec = detector.rule(input([runtime(5)]), 0);
  const parsed = JSON.parse(rec!.fix!.snippet) as {
    hooks: { Stop: { hooks: { command: string }[] }[] };
  };
  return parsed.hooks.Stop[0].hooks[0].command;
}

describe('the emitted hook fix (#3211)', () => {
  it('is labelled illustrative, because the advisory code is the user\'s to supply', () => {
    const rec = detector.rule(input([runtime(5)]), 0);
    // Absent fixKind means 'validated' (copy-paste-safe) — which this cannot
    // be: the detector sees only a per-event boolean, never an exit code.
    expect(rec?.fix?.fixKind).toBe('illustrative');
  });

  it('never converts a genuine failure into success', () => {
    const command = emittedHookCommand();
    // The regression this pins: the old snippet was `your-check.sh || true`,
    // which returned 0 for every one of these.
    for (const genuine of [1, 2, 3, 7, 42, 127]) {
      expect(hookExitCodeFor(command, genuine)).toBe(genuine);
    }
  });

  it('passes success through as success', () => {
    expect(hookExitCodeFor(emittedHookCommand(), 0)).toBe(0);
  });

  it('is safe UNEDITED — the placeholder exempts nothing', () => {
    const command = emittedHookCommand();
    expect(command).toContain('ADVISORY_EXIT_CODE');
    // A copied-but-unedited snippet must block exactly as the hook does today,
    // so copying it can never be the thing that silences a real failure.
    expect(hookExitCodeFor(command, 0)).toBe(0);
    expect(hookExitCodeFor(command, 1)).toBe(1);
    expect(hookExitCodeFor(command, 9)).toBe(9);
  });

  it('exempts ONLY the advisory code once the user substitutes one', () => {
    const command = emittedHookCommand();
    // User declares 7 as their "nothing to do" outcome.
    expect(hookExitCodeFor(command, 7, '7')).toBe(0);
    expect(hookExitCodeFor(command, 0, '7')).toBe(0);
    // ...and genuine failures still block.
    expect(hookExitCodeFor(command, 1, '7')).toBe(1);
    expect(hookExitCodeFor(command, 2, '7')).toBe(2);
    expect(hookExitCodeFor(command, 8, '7')).toBe(8);
  });

  it('supports several advisory codes', () => {
    const command = emittedHookCommand();
    expect(hookExitCodeFor(command, 10, '10|20')).toBe(0);
    expect(hookExitCodeFor(command, 20, '10|20')).toBe(0);
    expect(hookExitCodeFor(command, 11, '10|20')).toBe(11);
  });

  it('keeps the "|| true" advice out of the action and note as well', () => {
    const rec = detector.rule(input([runtime(5)]), 0);
    // The contradiction lived in three places, not just the snippet.
    expect(rec?.action).not.toContain('|| true');
    expect(rec?.fix?.note).not.toContain('|| true');
    expect(rec?.fix?.snippet).not.toContain('|| true');
  });
});
