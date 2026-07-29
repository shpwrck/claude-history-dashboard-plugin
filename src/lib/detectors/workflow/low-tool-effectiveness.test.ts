import { describe, it, expect } from 'vitest';
import { detector } from './low-tool-effectiveness';
import type { RecommendationInput } from '../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';
import { validateRecommendationProvenance } from '../provenance';
import { validateFixSnippet } from '../fix-validity';

// 11 identical Bash calls → each retries the prior, no forward motion → low score.
const toolData = (date = '2026-01-01'): ToolUsageData[] => [{
  sessionId: 's1',
  calls: Array.from({ length: 11 }, (_, i): ToolCall => ({
    timestamp: `${date}T00:00:${String(i).padStart(2, '0')}Z`,
    toolName: 'Bash',
    input: { command: 'npm test' },
    toolUseId: `u${i}`,
    isError: null,
    resultBytes: 0,
  })),
}];

const input = (postHook = false, date = '2026-01-01'): RecommendationInput => ({
  tokenData: [], toolData: toolData(date), sessions: [], projects: [], permissionRows: [], apiErrors: [], timelines: [],
  liveConfig: postHook ? ({ settings: { hooks: { PostToolUse: [{ matcher: 'Edit|Write' }] } } } as unknown as RecommendationInput['liveConfig']) : null,
});

describe('workflow.low-tool-effectiveness (#423)', () => {
  it('fires for a tool with effectiveness < 0.4 over >=10 invocations', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('workflow.low-tool-effectiveness');
    expect(rec?.detail).toContain('Bash');
  });
  it('self-suppresses when a post-edit validation hook exists', () => {
    expect(detector.rule(input(true), 0)).toBeNull();
  });

  it('cites every component of the composite score and validates its illustrative fix', () => {
    const rec = detector.rule(
      input(false, '2026-06-09'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;

    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance?.asOf).toBe('2026-06-09');
    expect(rec.provenance?.stale).toBe(false);
    expect(rec.provenance?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'computeToolEffectiveness().tool',
          value: 'Bash',
        }),
        expect.objectContaining({
          field: 'computeToolEffectiveness().invocations',
          value: 11,
        }),
        expect.objectContaining({
          field: 'rows.length',
          value: 1,
        }),
        expect.objectContaining({
          field:
            'computeToolEffectiveness().{immediatelyFollowedByError,immediatelyFollowedByRetry,immediatelyFollowedByUndo,immediatelyFollowedByProgress}',
          value: '0/10/0/0',
        }),
        expect.objectContaining({
          field: 'computeToolEffectiveness().effectivenessScore',
          value: expect.any(Number),
        }),
      ])
    );
    expect(rec.provenance?.inference).toMatch(/proxy|ground truth/i);
    expect(rec.fix?.fixKind).toBe('illustrative');
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
  });

  it('demotes old tool history while leaving fresh detail undated', () => {
    const stale = detector.rule(
      input(false, '2026-01-01'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;
    expect(stale.detail).toMatch(/^As of 2026-01-01,/);
    expect(stale.provenance?.asOf).toBe('2026-01-01');
    expect(stale.provenance?.stale).toBe(true);

    const fresh = detector.rule(
      input(false, '2026-06-09'),
      Date.parse('2026-06-10T00:00:00Z')
    )!;
    expect(fresh.detail).not.toMatch(/^As of /);
    expect(fresh.provenance?.stale).toBe(false);
  });
});
