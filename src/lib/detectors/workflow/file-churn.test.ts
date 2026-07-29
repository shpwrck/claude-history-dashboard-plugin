/**
 * Tests for workflow.file-churn, added with its provenance migration (#3232).
 *
 * The detector had no test file at all before this: the HIGH_CHURN gate, the
 * per-file aggregation, and the reproducibility of the emitted count were all
 * unexercised.
 */
import { describe, it, expect } from 'vitest';
import { detector } from './file-churn';
import { validateRecommendationProvenance } from '../provenance';
import { HIGH_CHURN } from '../shared';
import type { RecommendationInput } from '../types';
import type { ToolCall, ToolUsageData } from '../../parse-tools';

const edit = (file_path: string, timestamp: string): ToolCall => ({
  timestamp,
  toolName: 'Edit',
  input: { file_path },
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
});

/** `n` Edit calls against one path, all stamped `timestamp`. */
const churnFile = (
  sessionId: string,
  file_path: string,
  n: number,
  timestamp: string
): ToolUsageData => ({
  sessionId,
  calls: Array.from({ length: n }, () => edit(file_path, timestamp)),
});

const input = (toolData: ToolUsageData[]): RecommendationInput =>
  ({
    tokenData: [],
    toolData,
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
  }) as unknown as RecommendationInput;

/** Two files over the gate, the higher-churn one declared SECOND. */
const firing = (): ToolUsageData[] => [
  churnFile('s1', '/repo/src/low.ts', HIGH_CHURN + 1, '2026-06-01T09:00:00.000Z'),
  churnFile('s2', '/repo/src/high.ts', HIGH_CHURN + 20, '2026-06-09T18:00:00.000Z'),
  // Below the gate — present in the corpus, absent from the finding.
  churnFile('s3', '/repo/src/calm.ts', 2, '2026-06-02T09:00:00.000Z'),
];

describe('workflow.file-churn', () => {
  it('stays silent with no tool data', () => {
    expect(detector.rule(input([]), 0)).toBeNull();
  });

  it('stays silent when every file is below the churn gate', () => {
    expect(
      detector.rule(input([churnFile('s', '/repo/a.ts', HIGH_CHURN - 1, '2026-06-01T09:00:00.000Z')]), 0)
    ).toBeNull();
  });

  it('fires at exactly the gate and counts only qualifying files', () => {
    const rec = detector.rule(input(firing()), 0);
    expect(rec?.id).toBe('workflow.file-churn');
    expect(rec?.affected).toBe(2); // calm.ts excluded
    expect(rec?.evidence?.[0]).toContain('high.ts'); // ranked by churn
  });

  // ── Provenance (#3232) ──────────────────────────────────────────────────────
  describe('provenance', () => {
    it('passes the contract when it fires', () => {
      const rec = detector.rule(input(firing()), 0);
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
      expect(rec!.provenance!.observations.length).toBeGreaterThan(0);
    });

    it('reproduces the displayed file count from the cited field', () => {
      const rec = detector.rule(input(firing()), 0);
      const count = rec!.provenance!.observations.find((o) =>
        o.claim.includes('ranked file path(s) reached')
      );
      expect(count!.value).toBe(rec!.affected);
      expect(count!.value).toBe(2);
      expect(count!.field).toBe('churn');
    });

    it('cites the true maximum churn, not the head of the corpus order', () => {
      const rec = detector.rule(input(firing()), 0);
      const worst = rec!.provenance!.observations.find((o) =>
        o.claim.includes('highest churn observed')
      );
      expect(worst!.value).toBe(HIGH_CHURN + 20);
      expect(worst!.claim).toContain('high.ts');
      expect(worst!.claim).not.toContain('low.ts');
    });

    it('discloses the ranked-window cap rather than implying a corpus-wide total', () => {
      // `topChurnFiles` returns only the top N paths, so the count is a FLOOR
      // once more than N files clear the gate. Saying so is the honest fix;
      // silently widening the window would change the number the card shows.
      const many = Array.from({ length: 25 }, (_, i) =>
        churnFile(`s${i}`, `/repo/src/f${i}.ts`, HIGH_CHURN + i, '2026-06-09T18:00:00.000Z')
      );
      const rec = detector.rule(input(many), 0);
      expect(rec!.affected).toBe(20); // capped, not 25
      const count = rec!.provenance!.observations.find((o) => o.field === 'churn');
      expect(count!.claim).toContain('of the 20 ranked file path(s)');
      expect(count!.claim).toMatch(/capped at 20.*floor/);
      // The floor claim is established by the 21-row probe, so the citation
      // must name that limit or it cannot be reproduced.
      expect(count!.source).toContain('probed at limit 21');
      expect(rec!.provenance!.inference).toMatch(/floor/i);
    });

    it('states the real denominator on a corpus smaller than the window', () => {
      // Only three paths exist, so "2 of the 20" would assert a ranking window
      // that never existed (Codex review, PR #3472). The denominator is the
      // number of rows actually ranked, and there is no floor caveat because
      // nothing was dropped.
      const rec = detector.rule(input(firing()), 0);
      const count = rec!.provenance!.observations.find((o) => o.field === 'churn');
      expect(count!.claim).toContain('2 of the 3 ranked file path(s)');
      expect(count!.claim).not.toContain('20');
      expect(count!.claim).not.toMatch(/floor/);
    });

    it('calls the count a floor only when the window was ACTUALLY truncated', () => {
      // Exactly RANKED_LIMIT distinct paths: the window is full but nothing was
      // dropped, so declaring a floor would be false (Codex review, PR #3472).
      const exactly20 = Array.from({ length: 20 }, (_, i) =>
        churnFile(`s${i}`, `/repo/src/e${i}.ts`, HIGH_CHURN + i, '2026-06-09T18:00:00.000Z')
      );
      const rec = detector.rule(input(exactly20), 0);
      expect(rec!.affected).toBe(20);
      const count = rec!.provenance!.observations.find((o) => o.field === 'churn');
      expect(count!.claim).toContain('20 of the 20 ranked file path(s)');
      expect(count!.claim).not.toMatch(/floor/);
      expect(rec!.provenance!.inference).not.toMatch(/is a floor/);
    });

    it('calls the count a floor only when an OMITTED path would have qualified', () => {
      // 21 mutated paths but only one over the gate: the 21st fell off the
      // ranking, yet nothing QUALIFYING was omitted, so the count is exact and
      // the floor caveat would be a false claim (Codex review, PR #3472).
      const oneHotManyCalm: ToolUsageData[] = [
        churnFile('s-hot', '/repo/src/hot.ts', HIGH_CHURN + 5, '2026-06-09T18:00:00.000Z'),
        ...Array.from({ length: 20 }, (_, i) =>
          churnFile(`s${i}`, `/repo/src/calm${i}.ts`, 2, '2026-06-09T18:00:00.000Z')
        ),
      ];
      const rec = detector.rule(input(oneHotManyCalm), 0);
      expect(rec!.affected).toBe(1);
      const count = rec!.provenance!.observations.find((o) => o.field === 'churn');
      expect(count!.claim).not.toMatch(/floor/);
      expect(rec!.provenance!.inference).not.toMatch(/is a floor/);
    });

    it('dates from the contributing MUTATIONS, not from later unrelated calls', () => {
      // A Read long after the last Edit says nothing about when the file was
      // churned; anchoring to it would assert a freshness the churn evidence
      // does not have (Codex review, PR #3472).
      const withLaterRead: ToolUsageData[] = [
        churnFile('s1', '/repo/src/high.ts', HIGH_CHURN + 5, '2026-06-09T18:00:00.000Z'),
        {
          sessionId: 's2',
          calls: [
            {
              timestamp: '2026-12-25T09:00:00.000Z',
              toolName: 'Read',
              input: { file_path: '/repo/src/high.ts' },
              toolUseId: 'r1',
              isError: null,
              resultBytes: 10,
            },
          ],
        },
      ];
      const rec = detector.rule(input(withLaterRead), Date.parse('2027-01-01T00:00:00.000Z'));
      expect(rec!.provenance!.asOf).toBe('2026-06-09');
      expect(rec!.provenance!.asOf).not.toBe('2026-12-25');
    });

    it('dates only from ranked paths that actually clear the churn gate', () => {
      // A recent low-churn path participates in the ranking but contributes to
      // none of this recommendation's count, evidence, or highest-churn claim.
      // Letting it set asOf would make old qualifying evidence look current
      // (Codex review, PR #3472).
      const oldHotRecentCalm: ToolUsageData[] = [
        churnFile('s-hot', '/repo/src/hot.ts', HIGH_CHURN + 5, '2026-06-09T18:00:00.000Z'),
        churnFile('s-calm', '/repo/src/calm.ts', 2, '2026-12-25T09:00:00.000Z'),
      ];
      const rec = detector.rule(input(oldHotRecentCalm), Date.parse('2027-01-01T00:00:00.000Z'));
      expect(rec!.provenance!.asOf).toBe('2026-06-09');
      expect(rec!.provenance!.asOf).not.toBe('2026-12-25');
    });

    it('anchors asOf to the newest observed tool call, not to now', () => {
      const rec = detector.rule(input(firing()), Date.parse('2027-01-01T00:00:00.000Z'));
      expect(rec!.provenance!.asOf).toBe('2026-06-09');
    });

    it('keeps a valid mutation date when a later malformed one cannot evict it', () => {
      // A coercible-but-malformed timestamp ('2026-02-30' rolls to Mar 2) must
      // not win the parser's preselection and evict the genuinely valid date,
      // which would lose asOf entirely instead of falling back (Codex review,
      // PR #3472).
      const withMalformed: ToolUsageData[] = [
        {
          sessionId: 's1',
          calls: [
            ...Array.from({ length: HIGH_CHURN + 1 }, () =>
              edit('/repo/src/high.ts', '2026-06-09T18:00:00.000Z')
            ),
            edit('/repo/src/high.ts', '2026-02-30'),
            edit('/repo/src/high.ts', '9999'),
          ],
        },
      ];
      const rec = detector.rule(input(withMalformed), 0);
      expect(rec!.provenance!.asOf).toBe('2026-06-09');
    });

    it('omits asOf when no call carries a readable timestamp', () => {
      const undated = [churnFile('s', '/repo/a.ts', HIGH_CHURN + 1, 'not-a-date')];
      const rec = detector.rule(input(undated), 0);
      expect(rec!.provenance!.asOf).toBeUndefined();
      expect(validateRecommendationProvenance(rec!)).toEqual([]);
    });
  });
});
