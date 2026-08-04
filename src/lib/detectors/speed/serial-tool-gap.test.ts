import { describe, expect, it } from 'vitest';
import { detector, summarizeSerialGaps } from './serial-tool-gap';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTimeline } from '../../parse-timeline';

function baseInput(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    ...over,
  };
}

const minute = 60 * 1000;
function ts(sec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
}

/** A serialized read whose result does NOT reveal the next path → independent. */
function read(idSec: number, path: string, result: string): SessionTimeline['entries'] {
  return [
    {
      timestamp: ts(idSec),
      kind: 'tool_use',
      summary: `{"file_path":"${path}"}`,
      toolName: 'Read',
      toolUseId: `u${idSec}`,
    },
    {
      timestamp: ts(idSec + 1),
      kind: 'tool_result',
      summary: result,
      toolUseId: `u${idSec}`,
      isError: false,
    },
  ];
}

function timeline(sessionId: string, entries: SessionTimeline['entries']): SessionTimeline {
  return {
    sessionId,
    startTime: entries[0].timestamp,
    endTime: entries[entries.length - 1].timestamp,
    entries,
  };
}

// runtimeEvents with a non-zero active-turn p50 — the SPA-dark gate + the
// per-inference latency anchor.
const ACTIVE_TURNS: RecommendationInput['runtimeEvents'] = [
  {
    sessionId: 's',
    turns: [
      { sessionId: 's', timestamp: ts(0), durationMs: 2 * minute, messageCount: 2 },
      { sessionId: 's', timestamp: ts(30), durationMs: 3 * minute, messageCount: 2 },
    ],
    stopHooks: [],
    awaySummaries: [],
    scheduledFires: [],
  },
] as unknown as RecommendationInput['runtimeEvents'];

describe('speed.serial-tool-gap (#1753, epic #1910)', () => {
  it('flags independent serialized read pairs, not dependent ones', () => {
    // Three independent reads (each result is unrelated to the next path) ⇒ two
    // avoidable adjacent pairs.
    const entries = [
      ...read(0, '/src/a.ts', 'contents of a — no other paths here'),
      ...read(4, '/src/b.ts', 'contents of b — unrelated'),
      ...read(8, '/src/c.ts', 'contents of c — unrelated'),
    ];
    const summary = summarizeSerialGaps([timeline('indep', entries)]);
    expect(summary.naive).toBe(2);
    expect(summary.independent).toBe(2);
  });

  it('does NOT flag a dependent Read -> Read of a path the first result revealed', () => {
    // call-1 reads an index whose RESULT reveals /src/target.ts; call-2 reads it.
    const entries = [
      ...read(0, '/src/index.ts', 'export * from "/src/target.ts"'),
      ...read(4, '/src/target.ts', 'contents of target'),
    ];
    const summary = summarizeSerialGaps([timeline('dep', entries)]);
    expect(summary.naive).toBe(1); // serialized + different path
    expect(summary.independent).toBe(0); // but dependency caught → dropped
  });

  it('counts a pair after an empty result (empty result provably reveals no path)', () => {
    // A Grep with zero matches returns '' — the next read cannot depend on it.
    const entries = [
      ...read(0, '/src/a.ts', ''), // empty result
      ...read(4, '/src/b.ts', 'contents of b — unrelated'),
    ];
    const summary = summarizeSerialGaps([timeline('empty', entries)]);
    expect(summary.naive).toBe(1);
    expect(summary.independent).toBe(1);
  });

  it('does NOT count a pair when the earlier result summary is stripped/absent (unverifiable, #3228)', () => {
    // Bulk timelines strip `summary`; an absent summary cannot prove the later
    // path was independent, so it must not be treated as a provably-empty result.
    const entries: SessionTimeline['entries'] = [
      { timestamp: ts(0), kind: 'tool_use', summary: '{"file_path":"/src/a.ts"}', toolName: 'Read', toolUseId: 'u0' },
      // tool_result with NO summary field (stripped in the bulk dataset).
      { timestamp: ts(1), kind: 'tool_result', toolUseId: 'u0', isError: false },
      ...read(4, '/src/b.ts', 'contents of b — unrelated'),
    ];
    const summary = summarizeSerialGaps([timeline('stripped', entries)]);
    expect(summary.naive).toBe(1); // still a serialized, different-path adjacency
    expect(summary.independent).toBe(0); // but the earlier result is unverifiable
  });

  it('does not count batched calls issued in the same assistant message', () => {
    const entries: SessionTimeline['entries'] = [
      {
        timestamp: ts(0),
        kind: 'tool_use',
        summary: '{"file_path":"/src/a.ts"}',
        toolName: 'Read',
        toolUseId: 'b1',
      },
      {
        timestamp: ts(0), // same timestamp = same assistant message = batched
        kind: 'tool_use',
        summary: '{"file_path":"/src/b.ts"}',
        toolName: 'Read',
        toolUseId: 'b2',
      },
      { timestamp: ts(1), kind: 'tool_result', summary: 'a', toolUseId: 'b1', isError: false },
      { timestamp: ts(1), kind: 'tool_result', summary: 'b', toolUseId: 'b2', isError: false },
    ];
    const summary = summarizeSerialGaps([timeline('batched', entries)]);
    expect(summary.naive).toBe(0);
    expect(summary.independent).toBe(0);
  });

  it('breaks the run on an intervening edit', () => {
    const entries: SessionTimeline['entries'] = [
      ...read(0, '/src/a.ts', 'a'),
      { timestamp: ts(4), kind: 'tool_use', summary: '{"file_path":"/src/a.ts"}', toolName: 'Edit', toolUseId: 'e1' },
      { timestamp: ts(5), kind: 'tool_result', summary: 'edited', toolUseId: 'e1', isError: false },
      ...read(6, '/src/b.ts', 'b'),
    ];
    const summary = summarizeSerialGaps([timeline('edited', entries)]);
    expect(summary.naive).toBe(0);
    expect(summary.independent).toBe(0);
  });

  it('fires as a summary-based heuristic with no guaranteed reclaimed-time claim (#3228)', () => {
    const entries = [
      ...read(0, '/src/a.ts', 'a'),
      ...read(4, '/src/b.ts', 'b'),
      ...read(8, '/src/c.ts', 'c'),
      ...read(12, '/src/d.ts', 'd'),
    ];
    const rec = detector.rule(
      baseInput({ timelines: [timeline('many', entries)], runtimeEvents: ACTIVE_TURNS }),
      0
    );
    expect(rec?.id).toBe('speed.serial-tool-gap');
    expect(rec?.category).toBe('speed');
    // Relabeled as a candidate heuristic over clipped summaries — no proven
    // lower bound and no reclaimed-time credit is asserted (#3228).
    expect(rec?.detail).toMatch(/heuristic/i);
    expect(rec?.detail).toMatch(/candidate/i);
    expect(rec?.detail).not.toMatch(/lower bound/i);
    expect(rec?.detail).not.toMatch(/avoidable model round-trip/i);
    expect(rec?.estTimeReclaimedMin).toBeUndefined();
    expect(rec?.provenance?.observations.length).toBeGreaterThanOrEqual(2);
    // Provenance stays well-formed under the #3205 contract.
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('stays dark below the noise floor', () => {
    const entries = [...read(0, '/src/a.ts', 'a'), ...read(4, '/src/b.ts', 'b')];
    expect(
      detector.rule(
        baseInput({ timelines: [timeline('two', entries)], runtimeEvents: ACTIVE_TURNS }),
        0
      )
    ).toBeNull();
  });

  it('stays dark on the transcript-free SPA dataset (no runtimeEvents)', () => {
    const entries = [
      ...read(0, '/src/a.ts', 'a'),
      ...read(4, '/src/b.ts', 'b'),
      ...read(8, '/src/c.ts', 'c'),
      ...read(12, '/src/d.ts', 'd'),
    ];
    expect(detector.rule(baseInput({ timelines: [timeline('spa', entries)] }), 0)).toBeNull();
  });
});
