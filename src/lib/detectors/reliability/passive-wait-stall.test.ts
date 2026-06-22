import { describe, it, expect } from 'vitest';
import { detector } from './passive-wait-stall';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';

const T0 = Date.parse('2026-06-10T00:00:00Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

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

const userE = (ms: number, summary = 'msg'): TimelineEntry => ({ timestamp: iso(ms), kind: 'user', summary });
const assistantWait = (ms: number, summary = "I'll wait and report back."): TimelineEntry =>
  ({ timestamp: iso(ms), kind: 'assistant', summary, waitLanguage: true });
const assistantPlain = (ms: number, summary = 'Done — here is the result.'): TimelineEntry =>
  ({ timestamp: iso(ms), kind: 'assistant', summary });
const bgTool = (ms: number): TimelineEntry =>
  ({ timestamp: iso(ms), kind: 'tool_use', toolName: 'Bash', summary: '{"run_in_background":true}', backgrounded: true });
const toolResult = (ms: number): TimelineEntry => ({ timestamp: iso(ms), kind: 'tool_result', summary: 'output' });

/** One passive-wait stall: assistant wait-end, then a real human prompt `gapMin` later. */
function passiveStall(sessionId: string, gapMin: number): SessionTimeline {
  return timeline(sessionId, [
    userE(0, 'kick it off'),
    assistantWait(1000),
    userE(1000 + gapMin * MIN, 'status?'),
  ]);
}

describe('reliability.passive-wait-stall — guards', () => {
  it('returns null when timelines are absent or empty', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent below the 3-stall floor', () => {
    const recs = detector.rule(input([passiveStall('a', 2), passiveStall('b', 2)]), 0);
    expect(recs).toBeNull();
  });
});

describe('reliability.passive-wait-stall — fires', () => {
  it('emits a reliability rec when passive-wait turn-ends force human turns', () => {
    const rec = detector.rule(
      input([passiveStall('a', 2), passiveStall('b', 3), passiveStall('c', 4)]),
      0
    );
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('reliability.passive-wait-stall');
    expect(rec?.category).toBe('reliability');
    expect(rec?.affected).toBe(3);
    expect(rec?.view).toBe('timeline');
  });

  it('weights by silence gap — escalates to warning with a >5min stall, info otherwise', () => {
    const allShort = detector.rule(
      input([passiveStall('a', 1), passiveStall('b', 2), passiveStall('c', 3)]),
      0
    );
    expect(allShort?.severity).toBe('info');

    const oneLong = detector.rule(
      input([passiveStall('a', 1), passiveStall('b', 2), passiveStall('c', 16)]),
      0
    );
    expect(oneLong?.severity).toBe('warning');
    // Evidence is gap-ranked: the 16-minute stall leads.
    expect(oneLong?.evidence?.[0]).toContain('16m');
    expect(oneLong?.estTimeReclaimedMin).toBe(19); // 1 + 2 + 16
  });

  it('carries auditable provenance citing the parse-timeline flags', () => {
    const rec = detector.rule(
      input([passiveStall('a', 6), passiveStall('b', 7), passiveStall('c', 8)]),
      0
    );
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec!.provenance!.observations[0].source).toBe('parse-timeline');
    expect(rec!.provenance!.observations[0].field).toContain('waitLanguage');
  });
});

describe('reliability.passive-wait-stall — clean-separation control', () => {
  it('does NOT flag a wait that dispatched harness-backed background work', () => {
    // assistant says "I'll wait" AND issues a run_in_background Bash, then a human
    // happens to follow — still excluded, because the session could self-resume.
    const backed = timeline('backed', [
      userE(0, 'go'),
      assistantWait(1000),
      bgTool(1500),
      userE(1000 + 20 * MIN, 'status?'),
    ]);
    // Two real stalls + one harness-backed → only the two real ones count, which
    // is below the floor, so nothing fires (the backed turn contributed zero).
    expect(detector.rule(input([passiveStall('a', 9), passiveStall('b', 9), backed]), 0)).toBeNull();

    // With three real stalls added alongside the backed turn, affected is 3 — the
    // backed turn is never counted.
    const rec = detector.rule(
      input([passiveStall('a', 9), passiveStall('b', 9), passiveStall('c', 9), backed]),
      0
    );
    expect(rec?.affected).toBe(3);
  });

  it('does NOT flag a turn that did not end on wait language', () => {
    const plain = timeline('plain', [userE(0, 'go'), assistantPlain(1000), userE(1000 + 30 * MIN, 'next')]);
    expect(detector.rule(input([plain, plain, plain]), 0)).toBeNull();
  });
});

describe('reliability.passive-wait-stall — forced human turn excludes tool_result', () => {
  it('does NOT count a tool_result `user` record as the forced human turn', () => {
    // Wait-end followed ONLY by a tool_result (the turn kept going via a tool
    // result, no human re-engaged) → not a stall, even ×3.
    const toolFollowed = timeline('tr', [userE(0, 'go'), assistantWait(1000), toolResult(2000)]);
    expect(detector.rule(input([toolFollowed, toolFollowed, toolFollowed]), 0)).toBeNull();
  });

  it('still detects the stall when a real human prompt follows a mid-run tool_result', () => {
    // tool_result sits inside the run; the real human prompt is the forced turn,
    // and the gap is measured to that human prompt.
    const mixed = timeline('mixed', [
      userE(0, 'go'),
      assistantWait(1000),
      toolResult(2000),
      userE(2000 + 10 * MIN, 'status?'),
    ]);
    const rec = detector.rule(input([mixed, mixed, mixed]), 0);
    expect(rec?.affected).toBe(3);
    expect(rec?.severity).toBe('warning'); // 10min gap > 5min floor
  });
});
