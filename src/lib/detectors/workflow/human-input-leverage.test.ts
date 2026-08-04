import { describe, expect, it } from 'vitest';
import { detector } from './human-input-leverage';
import { effectiveFixKind, validateFixSnippet } from '../fix-validity';
import type { RecommendationInput } from '../types';
import type { TaskSteering } from '../../parse-steering';
import type { TaskSuccessProxy } from '../../parse-task-success';
import type { LiveConfig, SessionTokenData } from '../../../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import type { ToolUsageData } from '../../parse-tools';

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
function tokens(sessionId: string, total: number, ts = MID): SessionTokenData {
  return tokensByPool(sessionId, { input: total }, ts);
}

function tokensByPool(
  sessionId: string,
  parts: {
    input?: number;
    output?: number;
    cacheCreation?: number;
    cacheRead?: number;
  },
  ts = MID
): SessionTokenData {
  const inputTokens = parts.input ?? 0;
  const outputTokens = parts.output ?? 0;
  const cacheCreationTokens = parts.cacheCreation ?? 0;
  const cacheReadTokens = parts.cacheRead ?? 0;
  return {
    sessionId,
    entrypoint: 'cli',
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalCacheCreationTokens: cacheCreationTokens,
    totalCacheReadTokens: cacheReadTokens,
    model: 'claude-opus-4-8',
    messageCount: 1,
    entries: [
      {
        timestamp: ts,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheCreation1hTokens: 0,
        cacheReadTokens,
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
  toolData?: ToolUsageData[];
  timelines?: SessionTimeline[];
  liveConfig?: LiveConfig | null;
}): RecommendationInput {
  return {
    tokenData: parts.tokenData,
    toolData: parts.toolData ?? [],
    timelines: parts.timelines,
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    taskSteering: parts.steering,
    taskSuccess: parts.success ?? [],
    liveConfig: parts.liveConfig ?? null,
  } as RecommendationInput;
}

function timeline(sessionId: string, entries: TimelineEntry[]): SessionTimeline {
  return {
    sessionId,
    startTime: entries[0]?.timestamp ?? START,
    endTime: entries[entries.length - 1]?.timestamp ?? END,
    entries,
  };
}

const user = (ms: string, summary = 'go'): TimelineEntry => ({ timestamp: ms, kind: 'user', summary });
const assistant = (ms: string, summary = 'Working on it…'): TimelineEntry => ({
  timestamp: ms,
  kind: 'assistant',
  summary,
});
const toolUse = (ms: string): TimelineEntry => ({ timestamp: ms, kind: 'tool_use', toolName: 'Read', summary: '{}' });
const interrupt = (ms: string): TimelineEntry => ({
  timestamp: ms,
  kind: 'user',
  interrupted: true,
  summary: '[Request interrupted by user]',
});

function failedThenSuccessFix(sessionId: string): ToolUsageData {
  return {
    sessionId,
    calls: [
      {
        timestamp: '2026-06-12T10:05:00.000Z',
        toolName: 'Read',
        input: { file_path: 'packages/core/src/FooType.scala' },
        toolUseId: 'u-fail',
        isError: true,
        resultBytes: 0,
      },
      {
        timestamp: '2026-06-12T10:20:00.000Z',
        toolName: 'Read',
        input: { file_path: 'packages/lib/src/FooType.scala' },
        toolUseId: 'u-fix',
        isError: false,
        resultBytes: 0,
      },
    ],
  };
}

// Four typical small spans (10k each) + one large excursion (300k by default).
function corpusWith(
  excursion: Partial<TaskSteering>,
  excursionTokens = 300_000,
  opts: {
    excursionSuccess?: Partial<TaskSuccessProxy>;
    end?: string;
    toolData?: ToolUsageData[];
    timelines?: SessionTimeline[];
  } = {}
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
  return input({
    steering: steeringRows,
    success: successRows,
    tokenData,
    toolData: opts.toolData,
    timelines: opts.timelines,
  });
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
    expect(
      rec?.provenance?.observations.some((o) => o.source === 'parse-steering')
    ).toBe(true);
  });

  it('cites the outlier excess in evidence and provenance (auditable)', () => {
    const rec = detector.rule(corpusWith({}), NOW);
    expect(rec?.evidence?.[0]).toContain('/repo/app');
    expect(rec?.evidence?.[0]).toContain('non-cache outlier excess');
    const obs = rec?.provenance?.observations ?? [];
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.some((o) => o.source === 'parse-sessions')).toBe(true);
    expect(rec?.provenance?.inference).toMatch(/causal hypothesis/i);
  });

  it('cannot turn cache-read-only throughput into an avoidable-token headline', () => {
    const base = corpusWith({});
    const rec = detector.rule(
      {
        ...base,
        tokenData: base.tokenData.map((row) =>
          row.sessionId === 'sess-excursion'
            ? tokensByPool(row.sessionId, {
                input: 10_000,
                cacheRead: 10_000_000,
              })
            : row
        ),
      },
      NOW
    );
    expect(rec).toBeNull();
  });

  it('reports non-cache excess by component and cache reads as excluded reuse', () => {
    const base = corpusWith({});
    const rec = detector.rule(
      {
        ...base,
        tokenData: base.tokenData.map((row) =>
          row.sessionId === 'sess-excursion'
            ? tokensByPool(row.sessionId, {
                input: 150_000,
                output: 90_000,
                cacheCreation: 60_000,
                cacheRead: 5_000_000,
              })
            : row
        ),
      },
      NOW
    );
    expect(rec?.evidence?.[0]).toContain('290,000 non-cache outlier excess');
    expect(rec?.evidence?.[0]).toContain(
      'proportional excess allocation estimate: input 145,000'
    );
    expect(rec?.evidence?.[0]).toContain('output 87,000');
    expect(rec?.evidence?.[0]).toContain('cache creation 58,000');
    expect(rec?.evidence?.[0]).toContain(
      'measured excursion throughput: input 150,000, output 90,000, cache creation 60,000'
    );
    expect(rec?.evidence?.[0]).toContain(
      'cache-read context reuse excluded: 5,000,000'
    );
    expect(rec?.detail).toContain(
      '5,000,000 cache-read tokens were measured but explicitly excluded'
    );
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.field === 'TokenEntry.cacheReadTokens'
      )?.value
    ).toBe(5_000_000);
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.field === 'TokenEntry.inputTokens'
      )?.value
    ).toBe(150_000);
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.field === 'TokenEntry.outputTokens'
      )?.value
    ).toBe(90_000);
    expect(
      rec?.provenance?.observations.find(
        (observation) => observation.field === 'TokenEntry.cacheCreationTokens'
      )?.value
    ).toBe(60_000);
    expect(rec?.provenance?.inference).toContain('proportional allocation');
  });

  it('surfaces the interruption-cost threshold as a named, uncalibrated assumption (not a gate)', () => {
    const rec = detector.rule(corpusWith({}), NOW);
    expect(rec?.detail).toMatch(/uncalibrated/i);
    expect(rec?.detail).toMatch(/interruption-cost threshold/i);
    // Surfaced, not subtracted: the full outlier excess is still reported.
    expect(rec?.detail).toMatch(/290,000 non-cache tokens of outlier excess/i);
  });

  it('stays silent when there is no late corrective turn (mere approval)', () => {
    const rec = detector.rule(
      corpusWith({ corrective: 0, clarifyingAnswer: 0, approving: 1, humanTurns: 1 }),
      NOW
    );
    expect(rec).toBeNull();
  });

  it('fires from correction-mining even when no corrective steering turn exists', () => {
    const rec = detector.rule(
      corpusWith(
        { corrective: 0, clarifyingAnswer: 0, approving: 1, humanTurns: 1 },
        300_000,
        { toolData: [failedThenSuccessFix('sess-excursion')] }
      ),
      NOW
    );
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(rec?.evidence?.[0]).toContain('correction-mining');
    expect(
      rec?.provenance?.observations.some(
        (o) => o.source === 'parse-tools' && o.field === 'toolData[].calls[].isError'
      )
    ).toBe(true);
  });

  it('fires from a mid-turn interrupt even when other steering signals are absent', () => {
    const rec = detector.rule(
      corpusWith(
        { corrective: 0, clarifyingAnswer: 0, approving: 1, humanTurns: 1 },
        300_000,
        {
          timelines: [
            timeline('sess-excursion', [
              user('2026-06-12T10:00:10.000Z'),
              assistant('2026-06-12T10:10:00.000Z'),
              toolUse('2026-06-12T10:10:10.000Z'),
              interrupt('2026-06-12T10:20:00.000Z'),
            ]),
          ],
        }
      ),
      NOW
    );
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(
      rec?.provenance?.observations.some(
        (o) => o.source === 'parse-timeline' && o.field === 'TimelineEntry.interrupted'
      )
    ).toBe(true);
    expect(rec?.evidence?.[0]).toContain('mid-turn interruption');
  });

  it('fires on a slim-shape interrupt entry (interrupted flag, no summary)', () => {
    // The recs engine consumes bulk timelines where `summary` is stripped
    // (parse-timeline slimSessionTimeline; asserted by
    // session-blob-cache-parity). The signal must fire from `interrupted` alone,
    // never re-checking sentinel text — otherwise it never fires in production.
    const slimInterrupt = (ms: string): TimelineEntry => ({
      timestamp: ms,
      kind: 'user',
      interrupted: true,
    });
    const rec = detector.rule(
      corpusWith(
        { corrective: 0, clarifyingAnswer: 0, approving: 1, humanTurns: 1 },
        300_000,
        {
          timelines: [
            timeline('sess-excursion', [
              user('2026-06-12T10:00:10.000Z'),
              assistant('2026-06-12T10:10:00.000Z'),
              toolUse('2026-06-12T10:10:10.000Z'),
              slimInterrupt('2026-06-12T10:20:00.000Z'),
            ]),
          ],
        }
      ),
      NOW
    );
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(
      rec?.provenance?.observations.some(
        (o) => o.source === 'parse-timeline' && o.field === 'TimelineEntry.interrupted'
      )
    ).toBe(true);
    expect(rec?.evidence?.[0]).toContain('mid-turn interruption');
  });

  it('fires from token-burning deliberation when no corrective turn is present', () => {
    const rec = detector.rule(
      corpusWith(
        { corrective: 0, clarifyingAnswer: 1, approving: 0, humanTurns: 2 },
        300_000
      ),
      NOW
    );
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(rec?.evidence?.[0]).toContain('deliberation');
    expect(
      rec?.provenance?.observations.some(
        (o) => o.source === 'parse-steering' && o.field === 'TaskSteering.clarifyingAnswer'
      )
    ).toBe(true);
  });

  it('adds new signal joins without reducing base corrective coverage', () => {
    const steeringRows: TaskSteering[] = [];
    const successRows: TaskSuccessProxy[] = [];
    const tokenData: SessionTokenData[] = [];
    const toolData: ToolUsageData[] = [];

    for (let i = 0; i < 4; i += 1) {
      const sessionId = `base-${i}`;
      steeringRows.push(steering({ sessionId, taskIndex: 0 }));
      tokenData.push(tokens(sessionId, 10_000));
    }

    steeringRows.push(
      steering({
        sessionId: 'exc-core',
        taskIndex: 0,
        corrective: 2,
        approving: 0,
      }),
      steering({
        sessionId: 'exc-mining',
        taskIndex: 0,
        corrective: 0,
        clarifyingAnswer: 0,
        approving: 1,
        humanTurns: 1,
      } as Partial<TaskSteering>)
    );
    successRows.push(
      success({ sessionId: 'exc-core', taskIndex: 0, verdict: 'correct' }),
      success({ sessionId: 'exc-mining', taskIndex: 0, verdict: 'correct' })
    );
    tokenData.push(
      tokens('exc-core', 300_000),
      tokens('exc-mining', 300_000)
    );
    toolData.push(failedThenSuccessFix('exc-mining'));

    const rec = detector.rule(
      input({
        steering: steeringRows,
        success: successRows,
        tokenData,
        toolData,
      }),
      NOW
    );

    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(rec?.evidence?.[0]).toContain('/repo/app');
    // One old-path corrective excursion, one correction-mining-only excursion.
    expect(rec?.affected).toBe(2);
    expect(
      rec?.provenance?.observations.some((o) => o.source === 'parse-tools')
    ).toBe(true);
    expect(
      rec?.provenance?.observations.some((o) => o.source === 'parse-steering' && o.field.includes('corrective'))
    ).toBe(true);
    expect(
      rec?.provenance?.observations.some((o) => o.source === 'parse-timeline')
    ).toBe(false);
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
        steering: [steering({ sessionId: 'a', corrective: 2 }), steering({ sessionId: 'b' })],
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
      steering({
        sessionId: 'big-exc',
        project: '/repo/big',
        corrective: 2,
        humanTurns: 2,
        approving: 0,
      })
    );
    tokenData.push(tokens('big-exc', 500_000));
    const successRows = [success({ sessionId: 'big-exc', project: '/repo/big', verdict: 'correct' })];
    const rec = detector.rule(
      input({ steering: steeringRows, success: successRows, tokenData }),
      NOW
    );
    expect(rec?.id).toBe('workflow.human-input-leverage');
    expect(rec?.affected).toBe(1);
    // Avoidable = 500k − 120k class baseline = 380k (NOT 500k − global median).
    expect(rec?.evidence?.[0]).toContain('380,000 non-cache outlier excess');
    expect(rec?.evidence?.[0]).toContain('class baseline of 120,000');
  });

  // ── Stale-data handling ────────────────────────────────────────────────────
  it('demotes present-tense wording to "as of <date>" when the excursion is stale', () => {
    const staleEnd = '2026-04-01T11:00:00.000Z'; // > 30 days before NOW
    const rec = corpusWith({}, 300_000, { end: staleEnd });
    const result = detector.rule(rec, NOW);
    expect(result?.detail).toMatch(/^As of 2026-04-01,/);
    expect(result?.provenance?.asOf).toBe('2026-04-01');
    expect(result?.provenance?.stale).toBe(true);
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
      steering({
        sessionId: session,
        taskIndex: 1,
        corrective: 2,
        humanTurns: 2,
        approving: 0,
        ...w1,
      }),
    ];
    const rec = detector.rule(
      input({
        steering: steeringRows,
        success: [success({ sessionId: session, taskIndex: 1, ...w1, verdict: 'correct' })],
        tokenData: [
          tokens('f0', 10_000),
          tokens('f1', 10_000),
          tokens('f2', 10_000),
          {
            ...tokens(session, 0),
            entries: [
              { ...tokens(session, 10_000).entries[0], timestamp: '2026-06-12T10:30:00.000Z', inputTokens: 10_000 },
              { ...tokens(session, 300_000).entries[0], timestamp: '2026-06-12T11:30:00.000Z', inputTokens: 300_000 },
            ],
          } as unknown as SessionTokenData,
        ],
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

// ---------------------------------------------------------------------------
// #3235 — span sizing rescanned all token entries for every span.
//
// `spanTokenPoolsFor` walked a session's rows from index 0 for EVERY steering
// span. The rows were already timestamp-sorted, and the partition does not
// depend on which span is asking, so S spans over T entries cost O(S x T) to
// recompute a lookup.
//
// The probe counts READS of `entry.timestamp` via a getter rather than timing
// anything, so it is deterministic and immune to host contention. Prefix sums
// touch each entry exactly ONCE at build time; every span query afterwards is
// two binary searches over the index and touches no entry at all.
// ---------------------------------------------------------------------------
describe('workflow.human-input-leverage sizes spans without rescanning (#3235)', () => {
  const SESSION = 'sess-scale';
  const BASE = Date.parse('2026-06-12T10:00:00.000Z');

  /** One session whose entries count every timestamp read. */
  function countingTokenData(entryCount: number, counter: { reads: number }): SessionTokenData {
    const entries = Array.from({ length: entryCount }, (_, i) => {
      const ts = new Date(BASE + i * 1000).toISOString();
      return {
        get timestamp() {
          counter.reads += 1;
          return ts;
        },
        inputTokens: 10,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
        model: 'claude-opus-4-8',
      };
    });
    return {
      sessionId: SESSION,
      entrypoint: 'cli',
      totalInputTokens: entryCount * 10,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      model: 'claude-opus-4-8',
      messageCount: entryCount,
      entries,
      compactionEvents: [],
      hasUnknownModel: false,
    } as unknown as SessionTokenData;
  }

  /** `spanCount` spans spread across the session, each covering a slice. */
  function spans(spanCount: number, entryCount: number): TaskSteering[] {
    const width = Math.floor(entryCount / spanCount);
    return Array.from({ length: spanCount }, (_, i) =>
      steering({
        sessionId: SESSION,
        taskIndex: i,
        startTime: new Date(BASE + i * width * 1000).toISOString(),
        endTime: new Date(BASE + ((i + 1) * width - 1) * 1000).toISOString(),
      })
    );
  }

  it('sizes 1,000 spans over 100,000 entries without a per-span rescan', () => {
    // The acceptance asks for >= 1,000 spans and >= 100,000 entries in one
    // session. Correctness is what is asserted here, NOT a read count: the old
    // per-span walk read only internal state, so it is indistinguishable from
    // the indexed version at this boundary except by wall-clock (measured 231
    // ms -> 47 ms, but timing is host-sensitive and not evidence on a shared
    // host). The DETERMINISTIC complexity proof lives on the primitive both
    // detectors delegate to — see `buildWindowSumIndex / sumInWindow` in
    // detectors/shared.test.ts, which pins the query at ~34 element reads over
    // 100,000 entries instead of a linear scan.
    const ENTRIES = 100_000;
    const SPANS = 1_000;
    const counter = { reads: 0 };
    const td = countingTokenData(ENTRIES, counter);

    detector.rule(input({ steering: spans(SPANS, ENTRIES), tokenData: [td] }), NOW);

    // Each entry is read exactly once, at index-build time — the span queries
    // never touch the entries again. (The pre-fix code also built its rows in
    // one pass, so this pins the build, not the fix.)
    expect(counter.reads).toBe(ENTRIES);
  });

  it('routes repeated span queries through the index instead of copied-row scans', () => {
    const ENTRIES = 2_000;
    const SPANS = 64;
    const counter = { coercions: 0 };
    const endTime = new Date(BASE + (ENTRIES - 1) * 1000).toISOString();
    const sourceReads = { reads: 0 };
    const td = countingTokenData(ENTRIES, sourceReads);

    // A source-timestamp getter cannot distinguish the implementations: both
    // parse each timestamp once while building their private rows. A numeric
    // object can. Prefix construction coerces each input-token value once,
    // while the old consumer coerced it again inside every overlapping span's
    // copied-row scan (S x T).
    for (const entry of td.entries) {
      entry.inputTokens = {
        [Symbol.toPrimitive]() {
          counter.coercions += 1;
          return 10;
        },
      } as unknown as number;
    }
    const repeated = Array.from({ length: SPANS }, (_, taskIndex) =>
      steering({
        sessionId: SESSION,
        taskIndex,
        startTime: new Date(BASE).toISOString(),
        endTime,
      })
    );

    detector.rule(input({ steering: repeated, tokenData: [td] }), NOW);

    // The index consumes every numeric field once at build time. Restoring the
    // original consumer while leaving this test/helper intact yields
    // ENTRIES x SPANS coercions instead.
    expect(sourceReads.reads).toBe(ENTRIES);
    expect(counter.coercions).toBe(ENTRIES);
  });

  /**
   * Four typical 10k spans plus one 300k excursion whose ONLY token entry sits
   * at `exTs`. If the span window stopped including a bound, that entry is
   * dropped, the excursion sizes to 0 tokens, it is filtered out before the
   * outlier test, and the detector goes silent — so firing is a real assertion
   * about the bound, not a tautology.
   */
  function corpusWithExcursionTokenAt(exTs: string) {
    const steeringRows: TaskSteering[] = [];
    const successRows: TaskSuccessProxy[] = [];
    const tokenData: SessionTokenData[] = [];
    for (let i = 0; i < 4; i += 1) {
      const sessionId = `sess-typ-${i}`;
      steeringRows.push(steering({ sessionId, taskIndex: 0 }));
      tokenData.push(tokens(sessionId, 10_000));
    }
    steeringRows.push(
      steering({ sessionId: 'sess-excursion', taskIndex: 0, corrective: 2 })
    );
    successRows.push(
      success({ sessionId: 'sess-excursion', taskIndex: 0, verdict: 'correct' })
    );
    tokenData.push(tokens('sess-excursion', 300_000, exTs));
    return input({ steering: steeringRows, success: successRows, tokenData });
  }

  it('includes a token entry sitting exactly on the span START bound', () => {
    // The old walk skipped only `row.ms < start`, so an entry AT start counted.
    expect(detector.rule(corpusWithExcursionTokenAt(START), NOW)?.id).toBe(
      'workflow.human-input-leverage'
    );
  });

  it('includes a token entry sitting exactly on the span END bound', () => {
    // The old walk stopped only on `row.ms > end`, so an entry AT end counted.
    expect(detector.rule(corpusWithExcursionTokenAt(END), NOW)?.id).toBe(
      'workflow.human-input-leverage'
    );
  });

  it('excludes a token entry one millisecond outside each bound', () => {
    // The complement, so the two tests above cannot pass by the window simply
    // being unbounded.
    const before = new Date(Date.parse(START) - 1).toISOString();
    const after = new Date(Date.parse(END) + 1).toISOString();
    expect(detector.rule(corpusWithExcursionTokenAt(before), NOW)).toBeNull();
    expect(detector.rule(corpusWithExcursionTokenAt(after), NOW)).toBeNull();
  });
});
