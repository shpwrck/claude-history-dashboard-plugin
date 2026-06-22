import { describe, expect, it } from 'vitest';
import {
  blockedContinuationSessions,
  detector,
} from './continuation-blocked';
import { parseRuntimeEvents, type RuntimeEvents } from '../../parse-runtime-events';
import type { RecommendationInput } from '../types';

const line = (entry: Record<string, unknown>) =>
  JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    hookCount: 1,
    hookInfos: [],
    hookErrors: [],
    timestamp: '2026-06-12T10:00:00.000Z',
    ...entry,
  });

function runtime(
  sessionId: string,
  preventedContinuations: boolean[]
): RuntimeEvents {
  const text = preventedContinuations
    .map((preventedContinuation, index) =>
      line({
        preventedContinuation,
        timestamp: `2026-06-12T10:00:0${index}.000Z`,
      })
    )
    .join('\n');
  return parseRuntimeEvents(text, `${sessionId}.jsonl`)!;
}

function input(runtimeEvents?: RuntimeEvents[]): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    runtimeEvents,
  };
}

describe('safety.continuation-blocked', () => {
  it('fires on repeated blocked continuations from runtime-event fixtures (#1800)', () => {
    const rec = detector.rule(input([runtime('sess-a', [true, true])]), 0);

    expect(rec).toMatchObject({
      id: 'safety.continuation-blocked',
      category: 'safety',
      severity: 'warning',
      affected: 2,
      view: 'permissions',
    });
    expect(rec?.title).toContain('Safety guards');
    expect(rec?.detail).toContain('2 stop-hook block(s)');
    expect(rec?.evidence).toEqual(['sess-a: 2 blocked continuation(s)']);
    expect(rec?.provenance?.observations[0].field).toBe(
      'runtimeEvents[].stopHooks[].preventedContinuation'
    );
  });

  it('stays silent on one-offs, non-blocking stop hooks, and missing runtime data', () => {
    expect(detector.rule(input([runtime('sess-a', [true])]), 0)).toBeNull();
    expect(detector.rule(input([runtime('sess-a', [false, false])]), 0)).toBeNull();
    expect(detector.rule(input([]), 0)).toBeNull();
    expect(detector.rule(input(), 0)).toBeNull();
  });

  it('summarizes contributing sessions in descending blocked-count order', () => {
    expect(
      blockedContinuationSessions([
        runtime('sess-a', [true, true]),
        runtime('sess-b', [true, true, true]),
      ]).map((session) => [session.sessionId, session.blockedCount])
    ).toEqual([
      ['sess-b', 3],
      ['sess-a', 2],
    ]);
  });
});
