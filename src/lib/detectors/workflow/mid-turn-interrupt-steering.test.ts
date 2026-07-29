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

// ---------------------------------------------------------------------------
// #3238 — every interrupt rescanned the session's whole token history.
//
// `wastedInWindow` walked ALL token entries for EVERY qualifying interrupt,
// re-parsing timestamps and re-resolving per-model pricing each time: O(I x T)
// on the detector hot path, to compute a partition that does not depend on
// which interrupt is asking.
//
// The probe counts reads of `entry.timestamp` via a getter rather than timing
// anything, so it is deterministic. The index touches each entry exactly ONCE
// per session; every interrupt window afterwards is two binary searches over
// the prefix sums and touches no entry at all.
// ---------------------------------------------------------------------------
describe('workflow.mid-turn-interrupt-steering indexes tokens once (#3238)', () => {
  /** Token entries whose timestamp reads are counted. */
  function countingEntries(count: number, counter: { reads: number }): TokenEntry[] {
    return Array.from({ length: count }, (_, i) => {
      const ts = iso(i * SEC);
      return {
        get timestamp() {
          counter.reads += 1;
          return ts;
        },
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: 'claude-opus-4-8',
      } as unknown as TokenEntry;
    });
  }

  /** `interrupts` mid-turn interrupts spread across one session's timeline. */
  function interruptTimeline(interrupts: number, spacing: number): SessionTimeline {
    const entries: TimelineEntry[] = [userE(0)];
    for (let i = 1; i <= interrupts; i++) {
      entries.push(assistantE(i * spacing - spacing / 2));
      entries.push(interruptE(i * spacing));
    }
    return timeline('s-scale', entries);
  }

  it('touches each token entry once regardless of how many interrupts ask', () => {
    const ENTRIES = 20_000;
    const INTERRUPTS = 500;
    const counter = { reads: 0 };
    const entries = countingEntries(ENTRIES, counter);

    const rec = detector.rule(
      input([interruptTimeline(INTERRUPTS, 20 * SEC)], [tokenData('s-scale', entries)]),
      Date.now()
    );

    expect(rec?.id).toBe('workflow.mid-turn-interrupt-steering');
    // Exactly one read per entry: the index build. The old rescan performed on
    // the order of INTERRUPTS x ENTRIES (~10,000,000) reads for this fixture.
    expect(counter.reads).toBe(ENTRIES);
  });

  it('touches no token entry at all in a session with no qualifying interrupt', () => {
    // The pre-index code only reached `tokenEntries` inside the
    // `inFlight && interrupted` branch, so a session with no qualifying
    // interrupt did ZERO token work. An eagerly-built index would have added
    // O(T log T) to that common path — relocating the cost, not removing it.
    const counter = { reads: 0 };
    const entries = countingEntries(5_000, counter);

    // Three sessions that each look busy but carry no interrupt sentinel, plus
    // one that does, so the detector still fires and the walk is exercised.
    const quiet = (id: string) =>
      timeline(id, [userE(0), assistantE(1 * SEC), toolUseE(2 * SEC), toolResultE(3 * SEC)]);

    detector.rule(
      input(
        [quiet('q1'), quiet('q2'), quiet('q3')],
        [
          tokenData('q1', entries),
          tokenData('q2', entries),
          tokenData('q3', entries),
        ]
      ),
      Date.now()
    );

    expect(counter.reads).toBe(0);
  });

  it('keeps the orphaned window lower-exclusive so two interrupts never double-bill', () => {
    // Two interrupts in one turn. The entry at exactly the FIRST interrupt's
    // timestamp belongs to the first window (upper bound inclusive) and must
    // NOT be counted again by the second (lower bound exclusive).
    const tl = timeline('s-dup', [
      userE(0),
      assistantE(1 * SEC),
      interruptE(2 * SEC),
      assistantE(3 * SEC),
      interruptE(4 * SEC),
      // A third interrupt so the detector clears MIN_INTERRUPTS.
      assistantE(5 * SEC),
      interruptE(6 * SEC),
    ]);
    const entries = [
      tokenEntry(1 * SEC, 100), // first window only
      tokenEntry(2 * SEC, 200), // exactly ON the first interrupt
      tokenEntry(3 * SEC, 400), // second window only
      tokenEntry(5 * SEC, 800), // third window only
    ];

    const rec = detector.rule(
      input([tl], [tokenData('s-dup', entries)]),
      Date.now()
    );
    expect(rec?.id).toBe('workflow.mid-turn-interrupt-steering');

    // Windows are (0,2s] -> 100+200, (2s,4s] -> 400, (4s,6s] -> 800.
    // Every output token is billed to exactly ONE window: 1,500 total.
    // Double-counting the 2s boundary entry would report 1,700; dropping it
    // would report 1,300.
    const wasted = rec?.provenance?.observations?.find(
      (o) => o.field === 'entries[].outputTokens'
    );
    expect(wasted?.value).toBe(1_500);
  });
});
