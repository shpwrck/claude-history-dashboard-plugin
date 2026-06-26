import { describe, it, expect } from 'vitest';
import { detector } from './conversational-availability';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';

const T0 = Date.parse('2026-06-10T00:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const SEC = 1000;

function timeline(sessionId: string, entries: TimelineEntry[]): SessionTimeline {
  return {
    sessionId,
    startTime: entries[0]?.timestamp ?? iso(0),
    endTime: entries[entries.length - 1]?.timestamp ?? iso(0),
    entries,
  };
}

function input(timelines?: SessionTimeline[]): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    timelines,
  };
}

const userE = (ms: number, summary = 'go'): TimelineEntry => ({ timestamp: iso(ms), kind: 'user', summary });
const assistantE = (ms: number, summary = 'working'): TimelineEntry => ({ timestamp: iso(ms), kind: 'assistant', summary });
const bashE = (ms: number, command: string): TimelineEntry =>
  ({ timestamp: iso(ms), kind: 'tool_use', toolName: 'Bash', summary: JSON.stringify({ command }) });
const bgBashE = (ms: number, command: string): TimelineEntry =>
  ({
    timestamp: iso(ms),
    kind: 'tool_use',
    toolName: 'Bash',
    summary: JSON.stringify({ command, run_in_background: true }),
    backgrounded: true,
  });
const toolResultE = (ms: number): TimelineEntry => ({ timestamp: iso(ms), kind: 'tool_result', summary: 'output' });

/**
 * One Backgroundable-Foreground Call: an assistant turn fires a long-running
 * foreground Bash command, then `blockSec` later the assistant resumes.
 */
function bfcSession(sessionId: string, command: string, blockSec: number): SessionTimeline {
  return timeline(sessionId, [
    userE(0, 'build it'),
    assistantE(1 * SEC),
    bashE(2 * SEC, command),
    toolResultE(2 * SEC + blockSec * SEC),
    assistantE(2 * SEC + blockSec * SEC + 100, 'done'),
  ]);
}

describe('workflow.conversational-availability — guards', () => {
  it('returns null when timelines are absent or empty', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent below the 3-BFC floor', () => {
    expect(
      detector.rule(input([bfcSession('a', 'npm run build', 30), bfcSession('b', 'vitest run', 30)]), 0)
    ).toBeNull();
  });
});

describe('workflow.conversational-availability — fires', () => {
  it('emits a workflow rec when long foreground backgroundable calls block the turn', () => {
    const rec = detector.rule(
      input([
        bfcSession('aaaaaaaa1', 'npm run build', 30),
        bfcSession('bbbbbbbb2', 'vitest run', 45),
        bfcSession('cccccccc3', 'podman compose up --build', 60),
      ]),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('workflow.conversational-availability');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(3);
    expect(rec?.view).toBe('timeline');
    // Evidence is block-ranked: the 60s compose call leads, with its session prefix.
    expect(rec?.evidence?.[0]).toContain('cccccccc');
    expect(rec?.evidence?.[0]).toContain('60s');
  });

  it('scales severity by total blocked time — info when small, warning when egregious', () => {
    const small = detector.rule(
      input([
        bfcSession('a', 'npm run build', 30),
        bfcSession('b', 'vitest run', 30),
        bfcSession('c', 'tsc -b', 30),
      ]),
      0
    );
    expect(small?.severity).toBe('info'); // 90s total < 10min

    const egregious = detector.rule(
      input([
        bfcSession('a', 'npm run build', 240),
        bfcSession('b', 'vitest run', 240),
        bfcSession('c', 'podman compose up --build', 240),
      ]),
      0
    );
    expect(egregious?.severity).toBe('warning'); // 12min total >= 10min
  });

  it('carries auditable provenance citing the parse-timeline fields', () => {
    const rec = detector.rule(
      input([
        bfcSession('a', 'npm run build', 40),
        bfcSession('b', 'vitest run', 40),
        bfcSession('c', 'npm ci', 40),
      ]),
      0
    );
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec!.provenance!.observations[0].source).toBe('parse-timeline');
    expect(rec!.provenance!.observations[0].field).toContain('backgrounded');
    expect(rec!.claimClass).toBe('accounting');
    expect(rec!.proofTier).toBe('accounting');
  });
});

describe('workflow.conversational-availability — parallel-batch dedup', () => {
  // The production shape: one assistant message emits text + a tool_use block at
  // the SAME timestamp, then the turn resumes later. This must count as ONE block
  // window — not double-count the text and the tool entry.
  function textPlusToolSession(sessionId: string, blockSec: number): SessionTimeline {
    const fireMs = 2 * SEC;
    const resumeMs = fireMs + blockSec * SEC;
    return timeline(sessionId, [
      userE(0, 'build it'),
      // assistant text + the tool_use it spawned share the SAME timestamp (parse-timeline
      // emits them from one message with one timestamp).
      assistantE(fireMs, 'running the build'),
      bashE(fireMs, 'npm run build'),
      toolResultE(resumeMs),
      assistantE(resumeMs + 100, 'done'),
    ]);
  }

  it('counts a same-timestamp assistant-text + tool_use pair as ONE block window', () => {
    const rec = detector.rule(
      input([
        textPlusToolSession('aaaaaaaa1', 30),
        textPlusToolSession('bbbbbbbb2', 30),
        textPlusToolSession('cccccccc3', 30),
      ]),
      0
    );
    expect(rec).not.toBeNull();
    // 3 sessions × ONE window each = 3, not 6 (would be 6 if the text entry's
    // forward-scan and the tool entry's forward-scan each booked the window).
    expect(rec?.affected).toBe(3);
    // 3 windows × 30s = 90s ~= 1 (rounded) minute, NOT 180s.
    expect(rec?.estTimeReclaimedMin).toBe(Math.round((3 * 30 * SEC) / 60000));
  });

  it('collapses N parallel same-timestamp tool_use blocks into ONE window', () => {
    // One assistant message fires three parallel backgroundable Bash calls at the
    // same timestamp; the turn resumes once 60s later.
    const fireMs = 2 * SEC;
    const resumeMs = fireMs + 60 * SEC;
    const parallel = (sessionId: string): SessionTimeline =>
      timeline(sessionId, [
        userE(0, 'do it all'),
        assistantE(1 * SEC),
        bashE(fireMs, 'npm run build'),
        bashE(fireMs, 'vitest run'),
        bashE(fireMs, 'tsc -b'),
        toolResultE(resumeMs),
        assistantE(resumeMs + 100, 'done'),
      ]);

    const rec = detector.rule(input([parallel('aaaaaaaa1')]), 0);
    // Three parallel calls in one window: BUT the MIN_BFC floor is on distinct
    // WINDOWS, so a single 1-window session stays silent (this is the dedup
    // working — pre-fix it would have booked 3 BFCs and fired).
    expect(rec).toBeNull();

    // Three such sessions = three windows = clears the floor, and each window is
    // counted ONCE (affected 3), not 9 (3 parallel calls × 3 sessions).
    const rec3 = detector.rule(
      input([parallel('aaaaaaaa1'), parallel('bbbbbbbb2'), parallel('cccccccc3')]),
      0
    );
    expect(rec3).not.toBeNull();
    expect(rec3?.affected).toBe(3);
    // 3 windows × 60s = 180s = 3 minutes, NOT 9 windows × 60s.
    expect(rec3?.estTimeReclaimedMin).toBe(3);
  });
});

describe('workflow.conversational-availability — regex matches the invocation, not bare words', () => {
  // Each command blocked 30s; only a real toolchain INVOCATION should count.
  const blockSec = 30;

  it('does NOT match toolchain words that are mere arguments', () => {
    const innocuous = [
      'ls deploy/',
      'cat build.log',
      'find . -name "*.test.ts"',
      'grep -n test src/foo.ts',
      'watch -n5 cat status', // standalone `watch` was dropped
      'echo "running the build and test deploy"',
    ];
    // Use 3 distinct sessions per command set so we are well over MIN_BFC IF any matched.
    const sessions = innocuous.flatMap((cmd, k) => [
      bfcSession(`s${k}a`, cmd, blockSec),
      bfcSession(`s${k}b`, cmd, blockSec),
      bfcSession(`s${k}c`, cmd, blockSec),
    ]);
    expect(detector.rule(input(sessions), 0)).toBeNull();
  });

  it('DOES match real toolchain invocations (incl. cd-prefixed and npx forms)', () => {
    const real = [
      'cd /repo && npm run build',
      'npx vitest run',
      'sudo podman compose up --build',
      'CI=1 npm test',
    ];
    const sessions = real.slice(0, 3).map((cmd, k) => bfcSession(`r${k}`, cmd, blockSec));
    const rec = detector.rule(input(sessions), 0);
    expect(rec).not.toBeNull();
    expect(rec?.affected).toBe(3);
  });
});

describe('workflow.conversational-availability — false-positive guards', () => {
  it('is SILENT when the same calls were backgrounded (run_in_background)', () => {
    const bgSession = (sessionId: string): SessionTimeline =>
      timeline(sessionId, [
        userE(0, 'build it'),
        assistantE(1 * SEC),
        bgBashE(2 * SEC, 'npm run build'),
        toolResultE(2 * SEC + 60 * SEC),
        assistantE(2 * SEC + 60 * SEC + 100, 'done'),
      ]);
    expect(detector.rule(input([bgSession('a'), bgSession('b'), bgSession('c')]), 0)).toBeNull();
  });

  it('is SILENT on sub-second foreground reads (Read/Grep/Glob, quick status)', () => {
    const quick = (sessionId: string): SessionTimeline =>
      timeline(sessionId, [
        userE(0, 'look'),
        assistantE(1 * SEC),
        { timestamp: iso(2 * SEC), kind: 'tool_use', toolName: 'Read', summary: '{"file_path":"x.ts"}' },
        { timestamp: iso(2 * SEC + 200), kind: 'tool_result', summary: 'contents' },
        // fast Bash status that does not match a backgroundable kind AND finishes fast
        { timestamp: iso(2 * SEC + 300), kind: 'tool_use', toolName: 'Bash', summary: '{"command":"git status"}' },
        assistantE(2 * SEC + 500, 'ok'),
      ]);
    expect(detector.rule(input([quick('a'), quick('b'), quick('c')]), 0)).toBeNull();
  });

  it('does NOT count a long foreground call that is NOT a backgroundable kind', () => {
    // A long `git status` (10s+) is not build/test/deploy — excluded even though it blocked.
    const longStatus = (sessionId: string): SessionTimeline =>
      timeline(sessionId, [
        userE(0, 'status'),
        assistantE(1 * SEC),
        { timestamp: iso(2 * SEC), kind: 'tool_use', toolName: 'Bash', summary: '{"command":"git status"}' },
        assistantE(2 * SEC + 30 * SEC, 'ok'),
      ]);
    expect(detector.rule(input([longStatus('a'), longStatus('b'), longStatus('c')]), 0)).toBeNull();
  });

  it('does NOT count a backgroundable call below the 10s block floor', () => {
    // npm run build that resumed in 5s — fast enough to not have blocked the human.
    expect(
      detector.rule(
        input([
          bfcSession('a', 'npm run build', 5),
          bfcSession('b', 'vitest run', 5),
          bfcSession('c', 'npm ci', 5),
        ]),
        0
      )
    ).toBeNull();
  });

  it('is SILENT on a slim timeline where the command text is stripped', () => {
    // No `summary` => Bash kind cannot be classified => no BFC.
    const slim = (sessionId: string): SessionTimeline =>
      timeline(sessionId, [
        userE(0, 'build'),
        assistantE(1 * SEC),
        { timestamp: iso(2 * SEC), kind: 'tool_use', toolName: 'Bash' },
        assistantE(2 * SEC + 60 * SEC, 'done'),
      ]);
    expect(detector.rule(input([slim('a'), slim('b'), slim('c')]), 0)).toBeNull();
  });
});
