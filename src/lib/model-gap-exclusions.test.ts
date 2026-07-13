import { describe, it, expect } from 'vitest';
import {
  classifyGapExclusion,
  classifyGapExclusions,
  partitionGapCandidates,
  buildGapExclusionSignals,
  GAP_NOISE_CLASSES,
  IDLE_GAP_MS,
  type GapExclusionSignals,
} from './model-gap-exclusions';
import { sanitizeModelEvalResult } from './model-eval-result';
import type { ModelGapCandidate } from './model-gap-mining';
import type { SessionTokenData, TokenEntry } from '../types';
import type { SessionTimeline } from './parse-timeline';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';

function signals(over: Partial<GapExclusionSignals>): GapExclusionSignals {
  return {
    runId: 'r',
    durationMs: 60_000,
    idleMs: 0,
    userTurns: 2,
    toolCalls: 4,
    mutatingToolCalls: 2,
    toolErrors: 0,
    baselineFailureToolErrors: 0,
    apiErrors: 0,
    externalApiErrors: 0,
    churnMarkers: 0,
    totalTokens: 10_000,
    cacheReadTokens: 5_000,
    outputTokens: 1_000,
    ...over,
  };
}

function candidate(runId: string): ModelGapCandidate {
  return {
    runId,
    modelId: 'claude-sonnet-4-6',
    direction: 'sonnet->opus',
    discoveryScore: 0.5,
    evidence: [],
  };
}

describe('classifyGapExclusion (six noise classes)', () => {
  it('keeps a clean working run with an auditable kept reason', () => {
    const v = classifyGapExclusion(signals({}));
    expect(v.disposition).toBe('kept');
    expect(v.noiseClasses).toEqual([]);
    expect(v.reason).toMatch(/^kept: no human\/process noise/);
  });

  it('filters human-waiting: idle-dominated long wall-clock', () => {
    const v = classifyGapExclusion(
      signals({ durationMs: 60 * 60 * 1000, idleMs: 45 * 60 * 1000 })
    );
    expect(v.disposition).toBe('filtered');
    expect(v.noiseClasses).toContain('human-waiting');
    expect(v.reason).toContain('idle 75% of 60min');
  });

  it('does not call a short pause human-waiting', () => {
    const v = classifyGapExclusion(
      signals({ durationMs: 5 * 60 * 1000, idleMs: 4 * 60 * 1000 })
    );
    expect(v.noiseClasses).not.toContain('human-waiting');
  });

  it('filters exploration-design-debate: many turns, nothing mutated', () => {
    const v = classifyGapExclusion(
      signals({ userTurns: 8, toolCalls: 3, mutatingToolCalls: 0 })
    );
    expect(v.disposition).toBe('filtered');
    expect(v.noiseClasses).toContain('exploration-design-debate');
  });

  it('keeps a chatty session that still mutated files', () => {
    const v = classifyGapExclusion(
      signals({ userTurns: 8, toolCalls: 3, mutatingToolCalls: 1 })
    );
    expect(v.noiseClasses).not.toContain('exploration-design-debate');
  });

  it('filters external-blocker: failure signal dominated by 429/529/connection', () => {
    const v = classifyGapExclusion(
      signals({ apiErrors: 3, externalApiErrors: 3, toolErrors: 1 })
    );
    expect(v.disposition).toBe('filtered');
    expect(v.noiseClasses).toContain('external-blocker');
    expect(v.reason).toContain('3/3 API errors');
  });

  it('keeps a run whose failures are mostly its own tool errors', () => {
    const v = classifyGapExclusion(
      signals({ apiErrors: 2, externalApiErrors: 2, toolErrors: 8 })
    );
    expect(v.noiseClasses).not.toContain('external-blocker');
  });

  it('filters requirement-churn at two or more redirect markers', () => {
    const v = classifyGapExclusion(signals({ churnMarkers: 2 }));
    expect(v.disposition).toBe('filtered');
    expect(v.noiseClasses).toContain('requirement-churn');
  });

  it('filters harness-overhead: near-total cache reads, negligible output', () => {
    const v = classifyGapExclusion(
      signals({
        totalTokens: 1_000_000,
        cacheReadTokens: 990_000,
        outputTokens: 2_000,
      })
    );
    expect(v.disposition).toBe('filtered');
    expect(v.noiseClasses).toContain('harness-overhead');
  });

  it('does not call a normal cache-heavy run harness-overhead', () => {
    // 84%-ish cache share is the NORMAL shape of a working session.
    const v = classifyGapExclusion(
      signals({
        totalTokens: 1_000_000,
        cacheReadTokens: 840_000,
        outputTokens: 50_000,
      })
    );
    expect(v.noiseClasses).not.toContain('harness-overhead');
  });

  it('filters baseline-build-test-failure when known failures explain the errors', () => {
    const v = classifyGapExclusion(
      signals({ toolErrors: 2, baselineFailureToolErrors: 2 })
    );
    expect(v.disposition).toBe('filtered');
    expect(v.noiseClasses).toContain('baseline-build-test-failure');
  });

  it('reports every fired class, not just the first', () => {
    const v = classifyGapExclusion(
      signals({
        durationMs: 60 * 60 * 1000,
        idleMs: 45 * 60 * 1000,
        churnMarkers: 3,
      })
    );
    expect(v.noiseClasses).toEqual(
      expect.arrayContaining(['human-waiting', 'requirement-churn'])
    );
    expect(v.reason).toContain('human-waiting:');
    expect(v.reason).toContain('requirement-churn:');
  });

  it('covers exactly the six classes the epic names', () => {
    expect(GAP_NOISE_CLASSES).toHaveLength(6);
  });

  it('keeps a no-signal run for manual audit without claiming classifiers ran', () => {
    const verdict = classifyGapExclusion(
      signals({ evaluatedNoiseClasses: [] })
    );
    expect(verdict.disposition).toBe('kept');
    expect(verdict.reason).toContain('no exclusion signals available');
    expect(verdict.reason).toContain('audit manually');
  });
});

describe('classifyGapExclusions / partitionGapCandidates', () => {
  it('gives every candidate a verdict; missing signals are kept with a manual-audit reason', () => {
    const verdicts = classifyGapExclusions(
      [candidate('a'), candidate('orphan')],
      [signals({ runId: 'a', churnMarkers: 5 })]
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0].disposition).toBe('filtered');
    expect(verdicts[1].disposition).toBe('kept');
    expect(verdicts[1].reason).toContain('no exclusion signals available');
  });

  it('partitions survivors and emits one exclusion record per candidate', () => {
    const { kept, exclusions } = partitionGapCandidates(
      [candidate('noisy'), candidate('clean')],
      [
        signals({ runId: 'noisy', userTurns: 9, toolCalls: 0, mutatingToolCalls: 0 }),
        signals({ runId: 'clean' }),
      ]
    );
    expect(kept.map((c) => c.runId)).toEqual(['clean']);
    expect(exclusions).toHaveLength(2);
    expect(exclusions.every((e) => e.reason.length > 0)).toBe(true);
  });

  it('exclusion records survive the committed eval-result sanitizer verbatim', () => {
    const { exclusions } = partitionGapCandidates(
      [candidate('noisy'), candidate('clean')],
      [
        signals({
          runId: 'noisy',
          durationMs: 60 * 60 * 1000,
          idleMs: 45 * 60 * 1000,
          churnMarkers: 3,
          apiErrors: 4,
          externalApiErrors: 4,
        }),
        signals({ runId: 'clean' }),
      ]
    );
    const result = sanitizeModelEvalResult({
      kind: 'model-eval-result',
      batchPath: 'batches/test.json',
      runs: [],
      exclusions,
      recommendations: [],
    });
    expect(result).not.toBeNull();
    // Nothing dropped, nothing truncated: the audit trail is schema-clean.
    expect(result!.exclusions).toEqual(exclusions);
  });
});

// ── Signal building from parsed dashboard data ───────────────────────────────

function entry(model: string, over: Partial<TokenEntry> = {}): TokenEntry {
  return {
    timestamp: '2026-06-01T00:00:00Z',
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    ...over,
  } as unknown as TokenEntry;
}

function tokenSession(sessionId: string, entries: TokenEntry[]): SessionTokenData {
  return {
    sessionId,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: entries[0]?.model ?? 'unknown',
    messageCount: entries.length,
    entries,
    compactionEvents: [],
    hasUnknownModel: false,
  } as unknown as SessionTokenData;
}

describe('buildGapExclusionSignals (adapter)', () => {
  it('derives idle, churn, mutating-call, baseline-failure and external-error signals', () => {
    const tokenData = [
      tokenSession('s1', [
        entry('claude-sonnet-4-6', {
          inputTokens: 1_000,
          outputTokens: 500,
          cacheReadTokens: 8_000,
        }),
      ]),
    ];
    const timelines = [
      {
        sessionId: 's1',
        startTime: '2026-06-01T00:00:00Z',
        endTime: '2026-06-01T00:30:00Z',
        entries: [
          { timestamp: '2026-06-01T00:00:00Z', kind: 'user', summary: 'build the widget' },
          // 20-minute gap >= IDLE_GAP_MS → counted as idle.
          { timestamp: '2026-06-01T00:20:00Z', kind: 'user', summary: 'actually, scrap the widget — do a gadget instead' },
          { timestamp: '2026-06-01T00:21:00Z', kind: 'user', summary: 'never mind, widget was right' },
        ],
      } as unknown as SessionTimeline,
    ];
    const toolData: ToolUsageData[] = [
      {
        sessionId: 's1',
        calls: [
          { timestamp: 't', toolName: 'Edit', input: {}, toolUseId: 'u1', isError: null, resultBytes: 0 },
          { timestamp: 't', toolName: 'Read', input: {}, toolUseId: 'u2', isError: null, resultBytes: 0 },
          { timestamp: 't', toolName: 'Bash', input: { command: 'npm run build' }, toolUseId: 'u3', isError: true, resultBytes: 0 },
          { timestamp: 't', toolName: 'Bash', input: { command: 'git status' }, toolUseId: 'u4', isError: true, resultBytes: 0 },
        ],
      },
    ];
    const apiErrors = [
      { sessionId: 's1', timestamp: 't', summary: 'rate limited', status: 429 },
      { sessionId: 's1', timestamp: 't', summary: 'model exploded', status: 400 },
    ] as unknown as ApiErrorEvent[];

    const [s] = buildGapExclusionSignals({
      tokenData,
      timelines,
      toolData,
      apiErrors,
      knownBaselineFailures: ['npm run build'],
    });
    expect(s.runId).toBe('s1');
    expect(s.durationMs).toBe(30 * 60 * 1000);
    expect(s.idleMs).toBe(20 * 60 * 1000);
    expect(s.idleMs).toBeGreaterThanOrEqual(IDLE_GAP_MS);
    expect(s.userTurns).toBe(3);
    expect(s.churnMarkers).toBe(2); // "actually… instead" + "never mind"
    expect(s.toolCalls).toBe(4);
    expect(s.mutatingToolCalls).toBe(3); // Edit + 2 Bash
    expect(s.toolErrors).toBe(2);
    expect(s.baselineFailureToolErrors).toBe(1); // only the npm run build error
    expect(s.apiErrors).toBe(2);
    expect(s.externalApiErrors).toBe(1); // 429 yes, 400 no
    expect(s.totalTokens).toBe(9_500);
    expect(s.cacheReadTokens).toBe(8_000);
    expect(s.outputTokens).toBe(500);
    expect(s.evaluatedNoiseClasses).toEqual(GAP_NOISE_CLASSES);
  });

  it('reads zero churn markers off slim timelines (summary stripped)', () => {
    const tokenData = [tokenSession('s1', [entry('claude-sonnet-4-6')])];
    const timelines = [
      {
        sessionId: 's1',
        startTime: '2026-06-01T00:00:00Z',
        endTime: '2026-06-01T00:10:00Z',
        slim: true,
        entries: [
          { timestamp: '2026-06-01T00:00:00Z', kind: 'user', summaryLen: 40 },
          { timestamp: '2026-06-01T00:05:00Z', kind: 'user', summaryLen: 60 },
        ],
      } as unknown as SessionTimeline,
    ];
    const [s] = buildGapExclusionSignals({ tokenData, timelines });
    expect(s.churnMarkers).toBe(0);
    expect(s.userTurns).toBe(2);
    expect(s.evaluatedNoiseClasses).toEqual([
      'human-waiting',
      'harness-overhead',
    ]);
  });

  it('filters API-only external blockers while treating absent tool data as zero errors', () => {
    const [s] = buildGapExclusionSignals({
      tokenData: [tokenSession('api-only', [entry('claude-haiku-4-5-20251001')])],
      apiErrors: [
        {
          sessionId: 'api-only',
          timestamp: '2026-06-01T00:00:00Z',
          summary: 'rate limited',
          status: 429,
        },
        {
          sessionId: 'api-only',
          timestamp: '2026-06-01T00:00:01Z',
          summary: 'provider overloaded',
          status: 529,
        },
        {
          sessionId: 'api-only',
          timestamp: '2026-06-01T00:00:02Z',
          summary: 'connection reset',
          causeCode: 'ECONNRESET',
        },
      ] as ApiErrorEvent[],
    });

    expect(s.toolCalls).toBe(0);
    expect(s.toolErrors).toBe(0);
    expect(s.apiErrors).toBe(3);
    expect(s.externalApiErrors).toBe(3);
    expect(s.evaluatedNoiseClasses).toEqual([
      'external-blocker',
      'harness-overhead',
    ]);
    const verdict = classifyGapExclusion(s);
    expect(verdict.disposition).toBe('filtered');
    expect(verdict.noiseClasses).toEqual(['external-blocker']);
    expect(verdict.reason).toContain('3/3 API errors');
  });

  it('reports partial coverage for token-only sessions instead of claiming all six checks ran', () => {
    const [s] = buildGapExclusionSignals({
      tokenData: [tokenSession('bare', [entry('claude-sonnet-4-6')])],
    });
    expect(s.runId).toBe('bare');
    expect(s.durationMs).toBe(0);
    expect(s.userTurns).toBe(0);
    expect(s.evaluatedNoiseClasses).toEqual(['harness-overhead']);
    const verdict = classifyGapExclusion(s);
    expect(verdict.disposition).toBe('kept');
    expect(verdict.reason).toContain('evaluated 1/6 classes');
    expect(verdict.reason).toContain('not evaluated: human-waiting');
    expect(verdict.reason).toContain('baseline-build-test-failure');
  });
});
