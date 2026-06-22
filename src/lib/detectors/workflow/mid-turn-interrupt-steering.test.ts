import { describe, it, expect } from 'vitest';
import { detector } from './mid-turn-interrupt-steering';
import { isInterruptSentinel } from '../../parse-timeline';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import type { SessionTokenData, TokenEntry } from '../../../types';

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

const userE = (ms: number, summary = 'go'): TimelineEntry => ({ timestamp: iso(ms), kind: 'user', summary });
const interruptE = (ms: number): TimelineEntry =>
  ({ timestamp: iso(ms), kind: 'user', summary: '[Request interrupted by user]', interrupted: true });
const assistantE = (ms: number, summary = 'Working on it…'): TimelineEntry =>
  ({ timestamp: iso(ms), kind: 'assistant', summary });
const toolUseE = (ms: number): TimelineEntry =>
  ({ timestamp: iso(ms), kind: 'tool_use', toolName: 'Bash', summary: '{}' });
const toolResultE = (ms: number): TimelineEntry => ({ timestamp: iso(ms), kind: 'tool_result', summary: 'output' });

/** Token entry for one assistant message at `ms` with `out` output tokens. */
function tokenEntry(ms: number, out: number, model = 'claude-opus-4-8'): TokenEntry {
  return {
    timestamp: iso(ms),
    inputTokens: 100,
    outputTokens: out,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model,
  };
}

function tokenData(sessionId: string, entries: TokenEntry[]): SessionTokenData {
  return { sessionId, entries } as unknown as SessionTokenData;
}

function input(
  timelines?: SessionTimeline[],
  tokens: SessionTokenData[] = []
): RecommendationInput {
  return {
    tokenData: tokens,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    timelines,
  };
}

/**
 * One mid-turn interrupt: human prompt → assistant tool_use (in-flight) →
 * interrupt sentinel, with `out` output tokens billed by the orphaned turn.
 */
function interrupted(sessionId: string, out = 800): { tl: SessionTimeline; td: SessionTokenData } {
  return {
    tl: timeline(sessionId, [userE(0), assistantE(10 * SEC), toolUseE(20 * SEC), interruptE(30 * SEC)]),
    td: tokenData(sessionId, [tokenEntry(10 * SEC, out)]),
  };
}

describe('parse-timeline isInterruptSentinel matcher', () => {
  it('matches the literal interrupt sentinels, anchored to the start', () => {
    expect(isInterruptSentinel('[Request interrupted by user]')).toBe(true);
    expect(isInterruptSentinel('[Request interrupted by user for tool use]')).toBe(true);
  });
  it('does NOT match a prompt that merely quotes the phrase or is whitespace-prefixed', () => {
    expect(isInterruptSentinel('Read the doc about the [Request interrupted by user] sentinel')).toBe(false);
    // Genuine harness markers carry no leading whitespace — a space-prefixed
    // variant is a quote/paste, not the sentinel.
    expect(isInterruptSentinel('  [Request interrupted by user]')).toBe(false);
    expect(isInterruptSentinel('continue the task')).toBe(false);
    expect(isInterruptSentinel(undefined)).toBe(false);
  });
});

describe('workflow.mid-turn-interrupt-steering — guards', () => {
  it('returns null when timelines are absent or empty', () => {
    expect(detector.rule(input(), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent below the 3-interrupt floor', () => {
    const a = interrupted('a');
    const b = interrupted('b');
    expect(detector.rule(input([a.tl, b.tl], [a.td, b.td]), 0)).toBeNull();
  });
});

describe('workflow.mid-turn-interrupt-steering — fires', () => {
  it('emits a workflow rec dollarizing the discarded in-flight output', () => {
    const a = interrupted('aaaaaaaa', 1000);
    const b = interrupted('bbbbbbbb', 500);
    const c = interrupted('cccccccc', 1500);
    const rec = detector.rule(input([a.tl, b.tl, c.tl], [a.td, b.td, c.td]), 0);
    expect(rec).not.toBeNull();
    expect(rec?.id).toBe('workflow.mid-turn-interrupt-steering');
    expect(rec?.category).toBe('workflow');
    expect(rec?.affected).toBe(3);
    expect(rec?.view).toBe('timeline');
    // 3000 output tokens billed and discarded → a positive (but small) dollar figure.
    expect(rec?.estSavingsUsd).toBeGreaterThan(0);
    expect(rec?.provenance?.observations[1].value).toBe(3000);
    // Evidence is wasted-token ranked: the 1500-token interrupt leads.
    expect(rec?.evidence?.[0]).toContain('cccccccc');
  });

  it('attributes only the orphaned turn, not a later completed turn in the same session', () => {
    // Turn 1 interrupted (800 wasted); turn 2 is a clean prompt→assistant→done that
    // must NOT be counted as wasted.
    const tl = timeline('s1', [
      userE(0),
      assistantE(10 * SEC),
      interruptE(20 * SEC),
      userE(30 * SEC, 'try again differently'),
      assistantE(40 * SEC, 'Done.'),
    ]);
    const td = tokenData('s1', [tokenEntry(10 * SEC, 800), tokenEntry(40 * SEC, 5000)]);
    const x = interrupted('x');
    const y = interrupted('y');
    const rec = detector.rule(input([tl, x.tl, y.tl], [td, x.td, y.td]), 0);
    // 3 interrupts total (s1 once, x, y once each); s1 wasted reflects ONLY the
    // 800-token orphaned turn, never the 5000-token completed turn.
    expect(rec?.affected).toBe(3);
    const s1ev = rec?.evidence?.find((e) => e.startsWith('s1'));
    expect(s1ev).toContain('800');
    expect(rec?.evidence?.join(' ')).not.toContain('5,000');
  });

  it('carries auditable provenance citing both parser sources', () => {
    const a = interrupted('a');
    const b = interrupted('b');
    const c = interrupted('c');
    const rec = detector.rule(input([a.tl, b.tl, c.tl], [a.td, b.td, c.td]), 0)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations[0].source).toBe('parse-timeline');
    expect(rec.provenance!.observations[0].field).toContain('interrupted');
    expect(rec.provenance!.observations[1].source).toBe('parse-sessions');
    // Honest framing — never books a cost-census reclaim claim.
    expect(rec.reclaim).toBeUndefined();
    expect(rec.severity).toBe('info');
  });
});

describe('workflow.mid-turn-interrupt-steering — cadence', () => {
  it('does NOT flag a normal user message following a tool_result (no sentinel)', () => {
    // Clean cadence: prompt → assistant → tool_use → tool_result → real prompt.
    const clean = timeline('clean', [
      userE(0),
      assistantE(10 * SEC),
      toolUseE(20 * SEC),
      toolResultE(30 * SEC),
      userE(40 * SEC, 'now do the next thing'),
    ]);
    const td = tokenData('clean', [tokenEntry(10 * SEC, 900)]);
    expect(detector.rule(input([clean, clean, clean], [td, td, td]), 0)).toBeNull();
  });

  it('does NOT count an interrupt with no in-flight assistant work', () => {
    // Sentinel arrives immediately after a human prompt — nothing was produced, so
    // nothing was discarded; below the floor with these alone → null.
    const noWork = timeline('nw', [userE(0), interruptE(5 * SEC)]);
    const real = interrupted('r');
    const real2 = interrupted('r2');
    // Only the two genuine mid-flight interrupts count → below the 3 floor → null.
    expect(detector.rule(input([noWork, real.tl, real2.tl], [real.td, real2.td]), 0)).toBeNull();
  });
});
