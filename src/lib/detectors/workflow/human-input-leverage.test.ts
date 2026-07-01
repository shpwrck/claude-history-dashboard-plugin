import { describe, expect, it } from 'vitest';
import { detector } from './human-input-leverage';
import { effectiveFixKind, validateFixSnippet } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { TaskSteering } from '../../parse-steering';
import type { TaskSuccessProxy } from '../../parse-task-success';
import type { LiveConfig, SessionTokenData } from '../../../types';

const START = '2026-06-12T10:00:00.000Z';
const END = '2026-06-12T11:00:00.000Z';
const MID = '2026-06-12T10:30:00.000Z';
const NOW = Date.parse('2026-06-20T00:00:00.000Z'); // fresh relative to the spans

function steering(overrides: Partial<TaskSteering> = {}): TaskSteering {
  return {
    sessionId: 'sess-typical',
    project: '/repo/app',
    taskIndex: 0,
    startTime: START,
    endTime: END,
    wallClockMs: 60 * 60 * 1000,
    costUsd: 1,
    humanTurns: 1,
    corrective: 0,
    clarifyingAnswer: 0,
    approving: 1,
    other: 0,
    interruptions: 0,
    divergenceRate: 0,
    ...overrides,
  };
}

function success(overrides: Partial<TaskSuccessProxy> = {}): TaskSuccessProxy {
  return {
    sessionId: 'sess-typical',
    project: '/repo/app',
    taskIndex: 0,
    startTime: START,
    endTime: END,
    wallClockMs: 60 * 60 * 1000,
    verdict: 'correct',
    agentClaim: 'completed',
    confidence: 'high',
    successScore: 0.5,
    backedByMutation: true,
    mutatingToolCount: 1,
    toolCallCount: 4,
    toolResultCount: 4,
    toolErrorCount: 0,
    toolErrorRate: 0,
    errorPenalty: 0,
    ...overrides,
  };
}

/** One token-data session carrying `tokens` inside the [START,END] window. */
function tokens(
  sessionId: string,
  total: number,
  ts = MID
): SessionTokenData {
  return {
    sessionId,
    entrypoint: 'cli',
    totalInputTokens: total,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'claude-opus-4-8',
    messageCount: 1,
    entries: [
      {
        timestamp: ts,
        inputTokens: total,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: 'claude-opus-4-8',
      },
    ],
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

function input(parts: {
  steering: TaskSteering[];
  success?: TaskSuccessProxy[];
  tokenData: SessionTokenData[];
  liveConfig?: LiveConfig | null;
}): RecommendationInput {
  return {
    tokenData: parts.tokenData,
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    taskSteering: parts.steering,
    taskSuccess: parts.success ?? [],
    liveConfig: parts.liveConfig ?? null,
  } as RecommendationInput;
}

// Four typical small spans (10k each) + one large corrected excursion (300k).
// Median over the five sized spans is 10k, so the excursion clears 3x + the
// 50k floor.
function corpusWith(
  excursion: Partial<TaskSteering>,
  excursionTokens = 300_000,
  opts: { excursionSuccess?: Partial<TaskSuccessProxy>; end?: string } = {}
) {
  const steeringRows: TaskSteering[] = [];
  const successRows: TaskSuccessProxy[] = [];
  const tokenData: SessionTokenData[] = [];
  for (let i = 0; i < 4; i += 1) {
    const sessionId = `sess-typ-${i}`;
    steeringRows.push(steering({ sessionId, taskIndex: 0 }));
    tokenData.push(tokens(sessionId, 10_000));
  }
  const exSession = excursion.sessionId ?? 'sess-excursion';
  // When the excursion is dated (stale test), shift the whole window so start
  // precedes end and the token entry lands inside it.
  const exStart = opts.end
    ? new Date(Date.parse(opts.end) - 60 * 60_000).toISOString()
    : START;
  steeringRows.push(
    steering({
      sessionId: exSession,
      taskIndex: 0,
      corrective: 2,
      clarifyingAnswer: 1,
      humanTurns: 3,
      approving: 0,
      ...excursion,
      ...(opts.end ? { startTime: exStart, endTime: opts.end } : {}),
    })
  );
  successRows.push(
    success({
      sessionId: exSession,
      taskIndex: 0,
      verdict: 'correct',
      ...opts.excursionSuccess,
    })
  );
  tokenData.push(
    tokens(
      exSession,
      excursionTokens,
      opts.end ? new Date(Date.parse(opts.end) - 30 * 60_000).toISOString() : MID
    )
  );
  return input({ steering: steeringRows, success: successRows, tokenData });
}

describe('workflow.human-input-leverage', () => {
  it('fires on a costly span that ended in a late human correction', () => {
    const rec = detector.rule(corpusWith({}), NOW);
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(rec?.category).toBe('workflow');
    expect(rec?.claimClass).toBe('causal');
    expect(rec?.proofTier).toBe('auditable');
    // No dollar claim: a causal cost win above the accounting tier is not asserted.
    expect(rec?.estSavingsUsd).toBeUndefined();
    expect(rec?.affected).toBe(1);
  });

  it('cites the outlier excess in evidence and provenance (auditable)', () => {
    const rec = detector.rule(corpusWith({}), NOW);
    expect(rec?.evidence?.[0]).toContain('/repo/app');
    expect(rec?.evidence?.[0]).toContain('tokens avoidable upfront');
    const obs = rec?.provenance?.observations ?? [];
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.some((o) => o.field?.includes('corrective'))).toBe(true);
    expect(obs.some((o) => o.source === 'tokenData')).toBe(true);
    expect(rec?.provenance?.inference).toMatch(/causal hypothesis/i);
  });

  it('surfaces the interruption-cost threshold as a named, uncalibrated assumption (not a gate)', () => {
    const rec = detector.rule(corpusWith({}), NOW);
    expect(rec?.detail).toMatch(/uncalibrated/i);
    expect(rec?.detail).toMatch(/interruption-cost threshold/i);
    // Surfaced, not subtracted: the full outlier excess is still reported.
    expect(rec?.detail).toMatch(/agent tokens sit in the outlier/i);
  });

  it('stays silent when there is no late corrective turn (mere approval)', () => {
    const rec = detector.rule(
      corpusWith({ corrective: 0, clarifyingAnswer: 0, approving: 1, humanTurns: 1 }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('stays silent when the span is not a token outlier', () => {
    // Excursion tokens just above the typical median but below 3x + the floor.
    const rec = detector.rule(corpusWith({}, 12_000), NOW);
    expect(rec).toBeNull();
  });

  it('excludes spans the human explicitly accepted (steering was not a misdirection)', () => {
    const rec = detector.rule(
      corpusWith({}, 300_000, { excursionSuccess: { verdict: 'accept' } }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('stays silent below the baseline span count (median not meaningful)', () => {
    const rec = detector.rule(
      input({
        steering: [
          steering({ sessionId: 'a', corrective: 2 }),
          steering({ sessionId: 'b' }),
        ],
        tokenData: [tokens('a', 300_000), tokens('b', 10_000)],
      }),
      NOW
    );
    expect(rec).toBeNull();
  });

  // ── Per-class baseline (mixed-workload confound) ────────────────────────────
  // Avoidable cost is attributed to a task class, so the outlier is judged
  // against that class's OWN median span — not a global median that a large-span
  // project would clear just by being normally large.
  it('does not flag a span that is normal for its own (large-span) task class', () => {
    const steeringRows: TaskSteering[] = [];
    const successRows: TaskSuccessProxy[] = [];
    const tokenData: SessionTokenData[] = [];
    // Class B: 8 small 10k spans, dragging the GLOBAL median down to 10k.
    for (let i = 0; i < 8; i += 1) {
      const s = `small-${i}`;
      steeringRows.push(steering({ sessionId: s, project: '/repo/small' }));
      tokenData.push(tokens(s, 10_000));
    }
    // Class A: 4 uniformly-large 120k spans; one carries a late correction.
    for (let i = 0; i < 4; i += 1) {
      const s = `big-${i}`;
      const corrective = i === 0 ? 2 : 0;
      steeringRows.push(
        steering({
          sessionId: s,
          project: '/repo/big',
          corrective,
          humanTurns: corrective ? 2 : 1,
          approving: corrective ? 0 : 1,
        })
      );
      tokenData.push(tokens(s, 120_000));
      if (corrective) {
        successRows.push(success({ sessionId: s, project: '/repo/big', verdict: 'correct' }));
      }
    }
    // 120k clears 3x the 10k GLOBAL median, but NOT 3x its own class's 120k
    // median — so it must not be flagged.
    const rec = detector.rule(
      input({ steering: steeringRows, success: successRows, tokenData }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('still fires on a class-local outlier and nets it against the class baseline', () => {
    const steeringRows: TaskSteering[] = [];
    const tokenData: SessionTokenData[] = [];
    // Class A baseline: 4 typical 120k spans.
    for (let i = 0; i < 4; i += 1) {
      const s = `big-${i}`;
      steeringRows.push(steering({ sessionId: s, project: '/repo/big' }));
      tokenData.push(tokens(s, 120_000));
    }
    // A genuine class-local outlier: 500k (> 3x the 120k class median) + corrected.
    steeringRows.push(
      steering({ sessionId: 'big-exc', project: '/repo/big', corrective: 2, humanTurns: 2, approving: 0 })
    );
    tokenData.push(tokens('big-exc', 500_000));
    const successRows = [
      success({ sessionId: 'big-exc', project: '/repo/big', verdict: 'correct' }),
    ];
    const rec = detector.rule(
      input({ steering: steeringRows, success: successRows, tokenData }),
      NOW
    );
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(rec?.affected).toBe(1);
    // Avoidable = 500k − 120k class baseline = 380k (NOT 500k − global median).
    expect(rec?.evidence?.[0]).toContain('380,000 tokens avoidable upfront');
    expect(rec?.evidence?.[0]).toContain('class baseline of 120,000');
  });

  // ── Stale-data handling ────────────────────────────────────────────────────
  it('demotes present-tense wording to "as of <date>" when the excursion is stale', () => {
    const staleEnd = '2026-04-01T11:00:00.000Z'; // > 30 days before NOW
    const rec = detector.rule(corpusWith({}, 300_000, { end: staleEnd }), NOW);
    expect(rec?.detail).toMatch(/^As of 2026-04-01,/);
    expect(rec?.provenance?.asOf).toBe('2026-04-01');
    expect(rec?.provenance?.stale).toBe(true);
  });

  it('does not demote a fresh excursion', () => {
    const rec = detector.rule(corpusWith({}), NOW);
    expect(rec?.detail).not.toMatch(/^As of /);
    expect(rec?.provenance?.stale).toBe(false);
  });

  // ── Suppression ────────────────────────────────────────────────────────────
  it('suppresses when CLAUDE.md already documents an ask-upfront policy', () => {
    const claudeMd =
      '## Ask upfront on correction-prone task classes\n' +
      'For these classes, ask the human upfront before the agent starts.';
    const base = corpusWith({});
    const rec = detector.rule(
      { ...base, liveConfig: { claudeMd: { global: claudeMd } } as unknown as LiveConfig },
      NOW
    );
    expect(rec).toBeNull();
  });

  // The span→token join is by sessionId + [startTime,endTime] window, so two
  // spans that share a session (distinct taskIndex, non-overlapping windows —
  // the shape parse-steering actually emits) must each get only their own
  // window's tokens, never the sibling's.
  it('attributes per-window tokens when two spans share a session', () => {
    const session = 'multi-span';
    const w0 = { startTime: '2026-06-12T10:00:00.000Z', endTime: '2026-06-12T10:59:00.000Z' };
    const w1 = { startTime: '2026-06-12T11:00:00.000Z', endTime: '2026-06-12T11:59:00.000Z' };
    const steeringRows: TaskSteering[] = [
      // Three filler sessions for the baseline (10k each).
      steering({ sessionId: 'f0' }),
      steering({ sessionId: 'f1' }),
      steering({ sessionId: 'f2' }),
      // taskIndex 0: small, not corrected.
      steering({ sessionId: session, taskIndex: 0, ...w0 }),
      // taskIndex 1: the corrected excursion.
      steering({ sessionId: session, taskIndex: 1, corrective: 2, humanTurns: 2, approving: 0, ...w1 }),
    ];
    const tokenData: SessionTokenData[] = [
      tokens('f0', 10_000),
      tokens('f1', 10_000),
      tokens('f2', 10_000),
      // Two entries in the SAME session, one per window.
      {
        ...tokens(session, 0),
        entries: [
          { ...tokens(session, 10_000).entries[0], timestamp: '2026-06-12T10:30:00.000Z', inputTokens: 10_000 },
          { ...tokens(session, 300_000).entries[0], timestamp: '2026-06-12T11:30:00.000Z', inputTokens: 300_000 },
        ],
      } as unknown as SessionTokenData,
    ];
    const rec = detector.rule(
      input({
        steering: steeringRows,
        success: [success({ sessionId: session, taskIndex: 1, ...w1, verdict: 'correct' })],
        tokenData,
      }),
      NOW
    );
    // Only the taskIndex-1 window (300k) is the excursion; the 10k sibling window
    // must not be folded in (would read as 310k).
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(rec?.affected).toBe(1);
    expect(rec?.evidence?.[0]).toContain('300,000 tokens');
  });

  // ── Fix validity ───────────────────────────────────────────────────────────
  it('ships an illustrative, portable CLAUDE.md fix', () => {
    const rec = detector.rule(corpusWith({}), NOW);
    expect(rec?.fix?.target).toBe('CLAUDE.md');
    expect(effectiveFixKind(rec!.fix!)).toBe('illustrative');
    // The snippet itself carries no non-portable reference (host path, slash cmd).
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
  });
});
