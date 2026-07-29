import { describe, expect, it } from 'vitest';
import { detector } from './retry-storms';
import { MIN_RETRY_GROUP_COUNT } from '../shared';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';

function input(toolData: ToolUsageData[]): RecommendationInput {
  return {
    tokenData: [],
    toolData,
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
  };
}

describe('reliability.retry-storms structured provenance (#3216)', () => {
  it('cites consecutive same-tool error groups without claiming the arguments were identical', () => {
    const calls = Array.from({ length: MIN_RETRY_GROUP_COUNT }, (_, i) => ({
      timestamp: `2026-06-09T10:00:0${i}.000Z`,
      toolName: 'Bash',
      input: { command: `echo attempt-${i}` },
      toolUseId: `retry-${i}`,
      isError: i === 0,
      resultBytes: 0,
    })) as ToolCall[];
    const rec = detector.rule(
      input([{ sessionId: 'session-retry', calls }]),
      Date.parse('2026-06-10T00:00:00.000Z')
    );

    expect(rec?.id).toBe('reliability.retry-storms');
    expect(rec?.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
    expect(rec?.provenance?.asOf).toBe('2026-06-09');
    expect(rec?.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'detectRetryGroups().{count,hasErrors}',
          value: 1,
        }),
        expect.objectContaining({
          field: 'MIN_RETRY_GROUP_COUNT',
          value: MIN_RETRY_GROUP_COUNT,
        }),
      ])
    );
    expect(rec?.detail).not.toMatch(/same operation retried/i);
    expect(rec?.provenance?.inference).toMatch(/arguments are not compared/i);
  });
});
