import { describe, expect, it } from 'vitest';
import { detector } from './churn-geometry';
import type { RecommendationInput } from '../types';
import type { ChurnGeometrySession } from '../../parse-churn-geometry';

function input(churnGeometry?: ChurnGeometrySession[]): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    churnGeometry,
  };
}

describe('workflow.churn-geometry (#597)', () => {
  it('fires on high gross-low-net churn and stop-boundary re-edits', () => {
    const rec = detector.rule(
      input([
        {
          sessionId: 'session-abcdef',
          edits: [],
          files: [
            {
              sessionId: 'session-abcdef',
              filePath: 'src/payment.ts',
              tasks: 2,
              edits: 2,
              userModifiedEdits: 1,
              emptyPatchWrites: 0,
              grossLines: 42,
              netLines: 0,
              netAbsLines: 0,
              reeditRanges: 1,
              postStopReeditRanges: 1,
              reworkDistance: 42,
            },
          ],
        },
      ]),
      0
    );

    expect(rec?.id).toBe('workflow.churn-geometry');
    expect(rec?.severity).toBe('warning');
    expect(rec?.detail).toContain('gross-low-net churn');
    expect(rec?.detail).toContain('after a stop boundary');
    expect(rec?.evidence?.[0]).toContain('payment.ts');
  });

  it('stays dark for low churn geometry', () => {
    expect(
      detector.rule(
        input([
          {
            sessionId: 'calm',
            edits: [],
            files: [
              {
                sessionId: 'calm',
                filePath: 'src/calm.ts',
                tasks: 1,
                edits: 1,
                userModifiedEdits: 0,
                emptyPatchWrites: 0,
                grossLines: 4,
                netLines: 4,
                netAbsLines: 4,
                reeditRanges: 0,
                postStopReeditRanges: 0,
                reworkDistance: 1,
              },
            ],
          },
        ]),
        0
      )
    ).toBeNull();
  });
});
