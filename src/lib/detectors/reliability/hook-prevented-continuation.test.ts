import { describe, it, expect } from 'vitest';
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
