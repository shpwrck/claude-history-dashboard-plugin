import { describe, it, expect } from 'vitest';
import { detector } from './compaction-large-tool-outputs';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type { SessionTokenData } from '../../../types';
import type { ToolUsageData, ToolCall } from '../../parse-tools';

// peakContext ~70% of the 200K window (a moderate peak factor) combined with an
// all-large tool-output profile so tool-output is the dominant compaction factor.
const sess = (id: string): SessionTokenData =>
  ({
    sessionId: id, totalOutputTokens: 5000,
    entries: [{ timestamp: 't', model: 'claude-sonnet-4-6', inputTokens: 140_000, outputTokens: 5_000, cacheCreationTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0, webSearchRequests: 0, webFetchRequests: 0 }],
    compactionEvents: [],
  } as unknown as SessionTokenData);

const bigRead = (i: number): ToolCall =>
  ({ timestamp: `2026-01-01T00:00:0${i}Z`, toolName: 'Read', input: { file_path: `/f${i}` }, toolUseId: `r${i}`, isError: null, resultBytes: 50_000 });
const tools = (id: string): ToolUsageData => ({ sessionId: id, calls: [0, 1, 2, 3].map(bigRead) });

const ids = ['s1', 's2', 's3'];
const input = (md?: string): RecommendationInput => ({
  tokenData: ids.map(sess), toolData: ids.map(tools),
  sessions: [], projects: [], permissionRows: [], apiErrors: [], timelines: [],
  liveConfig: md ? ({ claudeMd: { global: md } } as unknown as RecommendationInput['liveConfig']) : null,
});

describe('context.compaction-large-tool-outputs (#425)', () => {
  it('fires when tool output dominates compaction across 3+ hot sessions', () => {
    const rec = detector.rule(input(), 0);
    expect(rec?.id).toBe('context.compaction-large-tool-outputs');
    expect(rec?.fix?.target).toBe('CLAUDE.md');
  });
  it('stays silent with no data and when suppressed', () => {
    expect(detector.rule({ ...input(), tokenData: [], toolData: [] }, 0)).toBeNull();
    expect(
      detector.rule(
        input('## Tool output discipline\n- prefer Grep/Glob over unfiltered cat'),
        0
      )
    ).toBeNull();
  });

  // ── Provenance (#3180) ───────────────────────────────────────────────────
  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input(), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });

    it('states the population behind each figure — they are different cohorts', () => {
      // The mean is over the HOT cohort; the dominance count is over every
      // scored session. Reporting both without saying so is how a reader ends
      // up dividing one by the other.
      const rec = detector.rule(input(), 0);
      const obs = rec!.provenance!.observations;
      const mean = obs.find((o) => o.field === 'largeToolOutputRate');
      expect(mean!.claim).toContain('hot session(s)');
      const dominant = obs.find((o) => o.field === 'topFactor');
      expect(dominant!.claim).toContain('whole scored fleet');
      expect(dominant!.value).toBe(rec!.affected);
    });

    it('cites a mean that is genuinely a rate in [0,1] and clears the warn gate', () => {
      const rec = detector.rule(input(), 0);
      const mean = Number(
        rec!.provenance!.observations.find((o) => o.field === 'largeToolOutputRate')!.value
      );
      expect(mean).toBeGreaterThanOrEqual(0);
      expect(mean).toBeLessThanOrEqual(1);
      // The rule only fires above the warn threshold, so the cited value must
      // be consistent with the gate that let it through.
      expect(mean).toBeGreaterThanOrEqual(0.1);
    });

    it('does not claim tool output caused a measured number of context tokens', () => {
      const rec = detector.rule(input(), 0);
      expect(rec!.provenance!.inference).toMatch(/not an attribution of measured/i);
    });
  });
});
