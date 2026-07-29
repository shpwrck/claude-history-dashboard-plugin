import { describe, expect, it } from 'vitest';
import { detector } from './churn-geometry';
import type { RecommendationInput } from '../types';
import {
  parseChurnGeometry,
  type ChurnGeometryFile,
  type ChurnGeometrySession,
  type StructuredPatchEdit,
} from '../../parse-churn-geometry';
import { validateRecommendationProvenance } from '../provenance';

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
              latestTimestamp: null,
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
                latestTimestamp: null,
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

// ── Provenance (#3232) ──────────────────────────────────────────────────────

describe('workflow.churn-geometry provenance (#3232)', () => {
  const NOW = Date.parse('2026-06-20T00:00:00.000Z');

  const file = (
    over: Partial<ChurnGeometryFile> & { sessionId: string; filePath: string }
  ): ChurnGeometryFile => ({
    latestTimestamp: null,
    tasks: 1,
    edits: 1,
    userModifiedEdits: 0,
    emptyPatchWrites: 0,
    grossLines: 40,
    netLines: 2,
    netAbsLines: 2,
    reeditRanges: 0,
    postStopReeditRanges: 0,
    reworkDistance: 30,
    ...over,
  });

  const edit = (
    sessionId: string,
    timestamp: string,
    filePath: string
  ): StructuredPatchEdit =>
    ({
      sessionId,
      timestamp,
      toolUseId: 'u',
      toolName: 'Edit',
      filePath,
      userModified: false,
      taskIndex: 0,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: 1,
      grossLines: 1,
      netLines: 1,
      emptyPatch: false,
    });

  /**
   * Two qualifying files, the higher-scoring one declared SECOND. The
   * composite `rowScore` weights post-stop re-edits 100x, so `src/hot.ts`
   * outranks `src/big.ts` despite having FEWER gross lines — which is exactly
   * why the citation must state the ranking basis instead of calling the head
   * of the list "the most churned file".
   */
  const sessions = (): ChurnGeometrySession[] => [
    {
      sessionId: 'sess-big',
      edits: [edit('sess-big', '2026-06-01T09:00:00.000Z', 'src/big.ts')],
      files: [
        file({
          sessionId: 'sess-big',
          filePath: 'src/big.ts',
          latestTimestamp: '2026-06-01T09:00:00.000Z',
          grossLines: 400,
          netLines: 10,
          reworkDistance: 60,
        }),
      ],
    },
    {
      sessionId: 'sess-hot',
      edits: [edit('sess-hot', '2026-06-09T15:00:00.000Z', 'src/hot.ts')],
      files: [
        file({
          sessionId: 'sess-hot',
          filePath: 'src/hot.ts',
          latestTimestamp: '2026-06-09T15:00:00.000Z',
          grossLines: 40,
          netLines: 1,
          reeditRanges: 2,
          postStopReeditRanges: 2,
          reworkDistance: 25,
        }),
      ],
    },
  ];

  it('passes the contract when it fires', () => {
    const rec = detector.rule(input(sessions()), NOW)!;
    expect(validateRecommendationProvenance(rec)).toEqual([]);
    expect(rec.provenance!.observations.length).toBeGreaterThan(0);
  });

  it('reproduces the displayed file count from the cited field', () => {
    const rec = detector.rule(input(sessions()), NOW)!;
    const count = rec.provenance!.observations.find((o) =>
      o.claim.includes('cleared at least one churn-geometry gate')
    );
    expect(count!.value).toBe(rec.affected);
    expect(count!.value).toBe(2);
  });

  it('names the composite ranking basis instead of claiming a single-field maximum', () => {
    const rec = detector.rule(input(sessions()), NOW)!;
    const head = rec.provenance!.observations.find((o) =>
      o.claim.includes('highest-ranked file')
    );
    expect(head).toBeDefined();
    // The head of the list is hot.ts (2 post-stop re-edits x 100 dominates),
    // NOT big.ts, which has 10x the gross lines. A claim worded "the most
    // churned file" would therefore be false; the wording must cite the score.
    expect(head!.claim).toContain('hot.ts');
    expect(head!.claim).toContain('composite score');
    expect(head!.value).toBe(40);
    const biggestGross = Math.max(
      ...sessions().flatMap((s) => s.files.map((f) => f.grossLines))
    );
    expect(head!.value).not.toBe(biggestGross);
    // …and the score itself is cited so a reader can recompute the ordering.
    const score = rec.provenance!.observations.find((o) => o.field === 'rowScore');
    expect(score!.value).toBe(2 * 100 + 2 * 20 + 25 + 40 / 100);
  });

  it('anchors asOf to the newest observed edit, not to now', () => {
    const rec = detector.rule(input(sessions()), NOW)!;
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    expect(rec.provenance!.asOf).not.toBe('2026-06-20');
  });

  it('ignores edits to files that did not qualify when dating the finding', () => {
    // A recent edit to a calm file produces no reported row, so it must not
    // make old churn geometry look freshly observed (Codex review, PR #3472).
    const withCalmFile: ChurnGeometrySession[] = [
      {
        sessionId: 'sess-hot',
        edits: [
          edit('sess-hot', '2026-06-09T15:00:00.000Z', 'src/hot.ts'),
          edit('sess-hot', '2026-12-25T09:00:00.000Z', 'src/calm.ts'),
        ],
        files: [
          file({
            sessionId: 'sess-hot',
            filePath: 'src/hot.ts',
            latestTimestamp: '2026-06-09T15:00:00.000Z',
            reeditRanges: 2,
            postStopReeditRanges: 2,
          }),
          // Below every gate, so `isFinding` drops it from `files`.
          file({
            sessionId: 'sess-hot',
            filePath: 'src/calm.ts',
            latestTimestamp: '2026-12-25T09:00:00.000Z',
            grossLines: 3,
            netLines: 3,
            reworkDistance: 1,
            reeditRanges: 0,
            postStopReeditRanges: 0,
          }),
        ],
      },
    ];
    const rec = detector.rule(input(withCalmFile), Date.parse('2027-01-01T00:00:00.000Z'))!;
    expect(rec.affected).toBe(1); // only hot.ts qualified
    expect(rec.provenance!.asOf).toBe('2026-06-09');
    expect(rec.provenance!.asOf).not.toBe('2026-12-25');
  });

  it('dates from contributing edits beyond the parser display-row cap', () => {
    // `parseChurnGeometry` deliberately exposes only 200 edit rows for display,
    // but summarizes file geometry over the complete edit set. The 201st edit
    // therefore has to carry its timestamp through the complete file summary;
    // scanning the capped display rows makes current churn appear stale
    // (Codex review, PR #3472).
    const rawEdit = (timestamp: string, i: number) =>
      JSON.stringify({
        type: 'user',
        timestamp,
        toolUseResult: {
          toolUseId: `u-${i}`,
          toolName: 'Edit',
          filePath: 'src/hot.ts',
          structuredPatch: {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: 1,
          },
        },
        message: { role: 'user', content: [] },
      });
    const text = [
      ...Array.from({ length: 200 }, (_, i) =>
        rawEdit('2026-06-09T15:00:00.000Z', i)
      ),
      rawEdit('2026-12-25T09:00:00.000Z', 200),
    ].join('\n');
    const parsed = parseChurnGeometry(text, 'sess-capped.jsonl')!;
    expect(parsed.edits).toHaveLength(200); // display cap is still intentional
    expect(parsed.files[0].latestTimestamp).toBe('2026-12-25T09:00:00.000Z');

    const rec = detector.rule(input([parsed]), Date.parse('2027-01-01T00:00:00.000Z'))!;
    expect(rec.provenance!.asOf).toBe('2026-12-25');
    expect(rec.provenance!.asOf).not.toBe('2026-06-09');
  });

  it('omits asOf when no structured-patch edit carries a readable timestamp', () => {
    const undated = sessions().map((s) => ({
      ...s,
      edits: [],
      files: s.files.map((f) => ({ ...f, latestTimestamp: null })),
    }));
    const rec = detector.rule(input(undated), NOW)!;
    expect(rec.provenance!.asOf).toBeUndefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });
});
