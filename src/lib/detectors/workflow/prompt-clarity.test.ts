import { describe, expect, it } from 'vitest';
import { detector } from './prompt-clarity';
import { validateRecommendationProvenance } from '../provenance';
import type { PromptAnalysis, RecommendationInput } from '../types';
import type {
  SessionTimeline,
  TimelineEntry,
} from '../../parse-timeline';
import type { ApiErrorEvent } from '../../parse-errors';

const prompt = (
  sessionId: string,
  lowSpecificityTurnCount: number
): PromptAnalysis => ({
  sessionId,
  promptTurnCount: 2,
  lowSpecificityTurnCount,
});

const timeline = (
  sessionId: string,
  date: string,
  userTurns: number
): SessionTimeline => {
  const entries: TimelineEntry[] = Array.from(
    { length: userTurns },
    (_, i) => ({
      timestamp: `${date}T00:00:0${i}Z`,
      kind: 'user',
      summary: `prompt ${i}`,
    })
  );
  return {
    sessionId,
    startTime: `${date}T00:00:00Z`,
    endTime: `${date}T00:00:10Z`,
    entries,
  };
};

const apiError = (sessionId: string, date: string): ApiErrorEvent => ({
  sessionId,
  timestamp: `${date}T00:00:05Z`,
  summary: 'rate limited',
});

function input(date: string): RecommendationInput {
  const low = ['low-1', 'low-2', 'low-3'];
  const comparison = ['cmp-1', 'cmp-2', 'cmp-3'];
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    promptAnalysis: [
      ...low.map((id) => prompt(id, 2)),
      ...comparison.map((id) => prompt(id, 0)),
    ],
    timelines: [
      ...low.map((id) => timeline(id, date, 3)),
      ...comparison.map((id) => timeline(id, date, 1)),
    ],
    apiErrors: low.map((id) => apiError(id, date)),
    liveConfig: null,
  };
}

describe('workflow.prompt-clarity', () => {
  it('stays silent without enough comparable sessions', () => {
    expect(
      detector.rule(
        {
          ...input('2026-06-09'),
          promptAnalysis: [prompt('one', 2)],
          timelines: [timeline('one', '2026-06-09', 3)],
          apiErrors: [],
        },
        0
      )
    ).toBeNull();
  });

  it('cites every input field used in the means and correlation', () => {
    const rec = detector.rule(
      input('2026-06-09'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;

    expect(rec.id).toBe('workflow.prompt-clarity');
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance?.asOf).toBe('2026-06-09');
    expect(rec.provenance?.stale).toBe(false);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'promptAnalysis[].sessionId',
          value: 'cmp-1,cmp-2,cmp-3,low-1,low-2,low-3',
        }),
        expect.objectContaining({
          field:
            'promptAnalysis[].{sessionId,lowSpecificityTurnCount,promptTurnCount}',
          value: expect.stringContaining('"lowSpecificityTurnCount":2'),
        }),
        expect.objectContaining({
          field: 'timelines[].entries[].{kind,timestamp}',
          value: expect.stringContaining('"followUpTurns":2'),
        }),
        expect.objectContaining({
          field: 'apiErrors[].{sessionId,timestamp}',
          value: expect.stringContaining('"apiErrorCount":1'),
        }),
        expect.objectContaining({
          field:
            'samples[].{isLowSpecificity,followUpTurns,proxyScore}',
          value: expect.stringMatching(/^3\/3\//),
        }),
      ])
    );
    expect(rec.provenance?.inference).toMatch(/correlation.*causation/i);
  });

  it('demotes stale history and keeps fresh history in current wording', () => {
    const stale = detector.rule(
      input('2026-01-01'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;
    expect(stale.detail).toMatch(/^As of 2026-01-01,/);
    expect(stale.provenance?.asOf).toBe('2026-01-01');
    expect(stale.provenance?.stale).toBe(true);

    const fresh = detector.rule(
      input('2026-06-09'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;
    expect(fresh.detail).not.toMatch(/^As of /);
    expect(fresh.provenance?.stale).toBe(false);
  });

  it('does not let an unrelated recent event refresh the contributing set', () => {
    const data = input('2026-01-01');
    data.apiErrors.push(apiError('not-a-sample', '2026-06-09'));

    const rec = detector.rule(
      data,
      Date.parse('2026-06-10T00:00:00Z')
    )!;
    expect(rec.provenance?.asOf).toBe('2026-01-01');
    expect(rec.provenance?.stale).toBe(true);
  });
});
