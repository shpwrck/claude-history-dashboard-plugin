import { describe, expect, it } from 'vitest';
import { computeSessionOverview } from './session-overview';
import type { SessionTimeline } from './parse-timeline';

describe('computeSessionOverview', () => {
  it('counts user turns from derived summary lengths when summaries are stripped', () => {
    const timeline: SessionTimeline = {
      sessionId: 'sess-derived',
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:02:00.000Z',
      slim: true,
      entries: [
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          kind: 'user',
          summaryLen: 14,
          hasCode: false,
          isQuestion: false,
        },
        {
          timestamp: '2026-01-01T00:01:00.000Z',
          kind: 'user',
          summaryLen: 0,
          hasCode: false,
          isQuestion: false,
        },
        {
          timestamp: '2026-01-01T00:02:00.000Z',
          kind: 'assistant',
          summaryLen: 0,
          hasCode: false,
          isQuestion: false,
        },
      ],
    };

    const overview = computeSessionOverview(
      timeline.sessionId,
      undefined,
      undefined,
      timeline,
      []
    );

    expect(overview.userTurns).toBe(1);
  });
});
