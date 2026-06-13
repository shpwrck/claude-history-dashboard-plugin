/**
 * Provenance contract test (#1049, epic #866 keystone).
 *
 * Enforces the auditability contract at the schema level:
 *  1. The validator accepts well-formed provenance and rejects each
 *     malformed shape (so siblings #1101–#1105 can rely on it).
 *  2. Every id on the PROVENANCE_DETECTORS allowlist is a real registered
 *     detector — the allowlist can't rot.
 *  3. The exemplar (activity.activity-trend) carries cited observations, a
 *     distinct inference, and an as-of date that reflects staleness, and the
 *     recommendation it emits passes the full contract.
 *
 * NOTE: the "triggered ⇒ compliant" guarantee is proven for the exemplar by
 * name. As siblings #1101–#1105 append ids to PROVENANCE_DETECTORS, add a
 * generic trigger-and-validate harness so the guarantee extends to each.
 */
import { describe, it, expect } from 'vitest';
import { DETECTORS } from './index';
import {
  PROVENANCE_DETECTORS,
  validateRecObservation,
  validateRecProvenance,
  validateRecommendationProvenance,
} from './provenance';
import type { Recommendation, RecommendationInput, RecProvenance } from './types';
import { detector as activityTrend } from './activity/activity-trend';
import type { LiveConfig } from '../../types';
import type { RuntimeEvents } from '../parse-runtime-events';
import type { StatsCache } from '../parse-stats-cache';
import type { ToolInventory } from '../parse-tool-inventory';
import type {
  OrganizationReviewEventsDataset,
  PullRequestReviewRequest,
} from '../organization-review-events';
import type {
  ModelEvalModelRollup,
  ModelEvalSummary,
} from '../model-eval-ingest';
import type { EvalRoutingRecommendation } from '../model-eval-result';

// ── Validator unit tests ─────────────────────────────────────────────────

const goodObs = { claim: '18 of 18 assignments unread', source: 'teams/', field: 'unreadCount', value: 18 };

describe('validateRecObservation', () => {
  it('accepts a fully-specified observation', () => {
    expect(validateRecObservation(goodObs)).toEqual([]);
  });
  it('accepts a claim+source-only observation (field/value optional)', () => {
    expect(validateRecObservation({ claim: 'x', source: 'parse-tools' })).toEqual([]);
  });
  it('rejects a missing/blank claim', () => {
    expect(validateRecObservation({ claim: '  ', source: 's' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a missing source (the citation is the point)', () => {
    expect(validateRecObservation({ claim: 'x' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a non-scalar value', () => {
    expect(validateRecObservation({ claim: 'x', source: 's', value: {} } as never).length).toBeGreaterThan(0);
  });
  it('rejects a non-finite numeric value (NaN is not auditable)', () => {
    expect(validateRecObservation({ claim: 'x', source: 's', value: NaN } as never).length).toBeGreaterThan(0);
  });
});

describe('validateRecProvenance', () => {
  const good: RecProvenance = {
    observations: [goodObs],
    inference: 'so the inbox is stalled',
    asOf: '2026-06-10',
    stale: false,
  };
  it('accepts a well-formed block', () => {
    expect(validateRecProvenance(good)).toEqual([]);
  });
  it('requires a non-empty observations array', () => {
    expect(validateRecProvenance({ observations: [] }).length).toBeGreaterThan(0);
  });
  it('rejects a blank inference when present', () => {
    expect(validateRecProvenance({ observations: [goodObs], inference: '' }).length).toBeGreaterThan(0);
  });
  it('rejects a non-ISO asOf (e.g. a full timestamp)', () => {
    expect(
      validateRecProvenance({ observations: [goodObs], asOf: '2026-06-10T00:00:00Z' }).length
    ).toBeGreaterThan(0);
  });
  it('rejects stale=true without an asOf to demote against', () => {
    expect(validateRecProvenance({ observations: [goodObs], stale: true }).length).toBeGreaterThan(0);
  });
});

// ── Allowlist integrity ──────────────────────────────────────────────────

describe('PROVENANCE_DETECTORS allowlist', () => {
  it('only lists ids that are actually registered detectors', () => {
    const registered = new Set(DETECTORS.map((d) => d.id));
    for (const id of PROVENANCE_DETECTORS) {
      expect(registered.has(id), `${id} is on the allowlist but not registered`).toBe(true);
    }
  });
});

// ── Trigger fixtures for allowlisted detectors ────────────────────────────

function baseInput(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    liveConfig: null,
    ...overrides,
  };
}

function makeCache(
  thisWeekTc: number,
  lastWeekTc: number,
  lastComputedDate = '2026-06-03'
): StatsCache {
  const base = '2026-05-21';
  const makeDay = (offset: number, tc: number, week: 'last' | 'this') => {
    const d = new Date(base);
    d.setDate(d.getDate() + offset + (week === 'this' ? 7 : 0));
    return { date: d.toISOString().slice(0, 10), messageCount: tc * 2, sessionCount: Math.max(1, Math.round(tc / 200)), toolCallCount: tc };
  };
  const perDayLast = Math.round(lastWeekTc / 7);
  const perDayThis = Math.round(thisWeekTc / 7);
  return {
    version: 3,
    lastComputedDate,
    dailyActivity: [
      ...Array.from({ length: 7 }, (_, i) => makeDay(i, perDayLast, 'last')),
      ...Array.from({ length: 7 }, (_, i) => makeDay(i, perDayThis, 'this')),
    ],
  };
}

function activityInput(statsCache: StatsCache): RecommendationInput {
  return baseInput({ statsCache });
}

const stopHookEvent = (hadErrors: boolean, prevented = false) => ({
  sessionId: 's1',
  timestamp: 't',
  hookCount: 1,
  totalDurationMs: 0,
  hadErrors,
  preventedContinuation: prevented,
});

const runtime = (stopHooks: ReturnType<typeof stopHookEvent>[]): RuntimeEvents =>
  ({ sessionId: 's1', turns: [], stopHooks, awaySummaries: [], scheduledFires: [] } as unknown as RuntimeEvents);

const liveConfig = (overrides: Partial<LiveConfig> = {}): LiveConfig =>
  ({ settings: {}, mcpServers: [], ...overrides } as unknown as LiveConfig);

const stopHookConfig = (): LiveConfig =>
  liveConfig({ settings: { hooks: { Stop: [{ hooks: [{ command: 'x' }] }] } } });

const toolInventory = (sessionId: string, available: string[], used: string[]): ToolInventory =>
  ({ sessionId, toolsAvailable: available, toolsUsed: used, unusedTools: [], utilizationPct: 0 });

const mcpConfig = (serverIds: string[]): LiveConfig =>
  liveConfig({ mcpServers: serverIds.map((id) => ({ id, scope: 'global' })) });

const REVIEW_NOW = Date.parse('2026-06-10T12:00:00Z');
const MODEL_EVAL_NOW = Date.parse('2026-06-11T00:00:00.000Z');

function requestedHoursAgo(hours: number): string {
  return new Date(REVIEW_NOW - hours * 60 * 60 * 1000).toISOString();
}

function reviewRequest(
  overrides: Partial<PullRequestReviewRequest> & { reviewerId: string; pullRequestNumber: number }
): PullRequestReviewRequest {
  return {
    repository: 'acme/app',
    pullRequestTitle: `PR ${overrides.pullRequestNumber}`,
    pullRequestState: 'open',
    requestedAt: requestedHoursAgo(60),
    state: 'pending',
    ...overrides,
  };
}

function modelRollup(overrides: Partial<ModelEvalModelRollup> = {}): ModelEvalModelRollup {
  return {
    modelId: 'claude-sonnet-4-5',
    runCount: 6,
    candidateRuns: 4,
    baselineRuns: 2,
    vetoedRuns: 0,
    meanWeightedScore: 0.7,
    bestWeightedScore: 0.85,
    vetoes: [],
    strongestEvidence: 'shadow-replay-verdict',
    evidenceCount: 9,
    ...overrides,
  };
}

function routingRecommendation(
  overrides: Partial<EvalRoutingRecommendation> = {}
): EvalRoutingRecommendation {
  return {
    modelId: 'claude-sonnet-4-5',
    scope: 'gap:haiku-sonnet:failure:small',
    weightedScore: 0.82,
    strongestEvidence: 'shadow-replay-verdict',
    rationale: 'Candidate beat the baseline on the failure-dominant cluster.',
    ...overrides,
  };
}

function modelEvalSummary(overrides: Partial<ModelEvalSummary> = {}): ModelEvalSummary {
  return {
    schemaVersion: 1,
    kind: 'model-eval-summary',
    generatedAt: '2026-06-10T00:00:00.000Z',
    artifactCount: 2,
    runCount: 6,
    artifacts: [
      {
        batchPath: '/tmp/evals/batch-2.json',
        createdAt: '2026-06-09T00:00:00.000Z',
        runCount: 4,
        vetoedRuns: 0,
      },
      {
        batchPath: '/tmp/evals/batch-1.json',
        createdAt: '2026-06-08T00:00:00.000Z',
        runCount: 2,
        vetoedRuns: 1,
      },
    ],
    models: [modelRollup()],
    vetoTotals: {
      'failed-required-gate': 0,
      'materially-worse-correctness': 0,
      'unknown-pricing-or-api': 0,
      'insufficient-evidence': 0,
    },
    exclusions: { kept: 4, filtered: 2 },
    recommendations: [routingRecommendation()],
    ...overrides,
  };
}

type ProvenanceFixture = {
  input: RecommendationInput;
  now: number;
};

const PROVENANCE_TRIGGER_FIXTURES: Record<string, () => ProvenanceFixture> = {
  'activity.activity-trend': () => ({
    input: activityInput(makeCache(12576, 2373)),
    now: Date.parse('2026-06-04T00:00:00Z'),
  }),
  'reliability.hook-errors': () => ({
    input: baseInput({
      runtimeEvents: [runtime([stopHookEvent(true), stopHookEvent(true), stopHookEvent(true)])],
      liveConfig: stopHookConfig(),
    }),
    now: 0,
  }),
  'cost.idle-mcp-tools': () => ({
    input: baseInput({
      toolInventories: [
        toolInventory('s1', ['mcp__foo__bar', 'Bash'], ['Bash']),
        toolInventory('s2', ['mcp__foo__bar', 'Bash'], ['Bash']),
        toolInventory('s3', ['mcp__foo__bar', 'Bash'], ['Bash']),
      ],
      liveConfig: mcpConfig(['foo']),
    }),
    now: 0,
  }),
  'workflow.review-bottleneck': () => {
    const reviewEvents: OrganizationReviewEventsDataset = {
      source: 'github-review-sync',
      generatedAt: new Date(REVIEW_NOW).toISOString(),
      reviewRequests: [
        reviewRequest({ reviewerId: 'alice', reviewerDisplayName: 'Alice', pullRequestNumber: 1 }),
        reviewRequest({ reviewerId: 'alice', reviewerDisplayName: 'Alice', pullRequestNumber: 2 }),
        reviewRequest({ reviewerId: 'alice', reviewerDisplayName: 'Alice', pullRequestNumber: 3 }),
        reviewRequest({ reviewerId: 'bob', reviewerDisplayName: 'Bob', pullRequestNumber: 4 }),
      ],
    };
    return { input: baseInput({ reviewEvents }), now: REVIEW_NOW };
  },
  'cost.model-eval-routing-gap': () => ({
    input: baseInput({ modelEvalSummary: modelEvalSummary() }),
    now: MODEL_EVAL_NOW,
  }),
};

function runAllowlistedDetector(id: string): Recommendation {
  const detector = DETECTORS.find((d) => d.id === id);
  expect(detector, `${id} is on the provenance allowlist but not registered`).toBeDefined();

  const fixture = PROVENANCE_TRIGGER_FIXTURES[id];
  expect(fixture, `${id} needs a trigger fixture in PROVENANCE_TRIGGER_FIXTURES`).toBeDefined();

  const { input, now } = fixture();
  const rec = detector!.rule(input, now);
  expect(rec, `${id} trigger fixture did not fire`).not.toBeNull();
  expect(rec!.id).toBe(id);
  return rec!;
}

describe('PROVENANCE_DETECTORS trigger harness', () => {
  it('has exactly one trigger fixture per allowlisted detector', () => {
    expect(Object.keys(PROVENANCE_TRIGGER_FIXTURES).sort()).toEqual([...PROVENANCE_DETECTORS].sort());
  });

  it.each(PROVENANCE_DETECTORS)('%s emits compliant provenance when triggered', (id) => {
    const rec = runAllowlistedDetector(id);
    expect(rec.provenance, `${id} emitted no provenance`).toBeDefined();
    expect(validateRecommendationProvenance(rec)).toEqual([]);
  });
});

// ── Exemplar: activity.activity-trend emits compliant provenance ───────────

describe('activity.activity-trend provenance (exemplar)', () => {
  const NOW = new Date('2026-06-04T00:00:00Z').getTime();

  it('emits provenance that passes the contract when it fires', () => {
    const rec = activityTrend.rule(activityInput(makeCache(12576, 2373)), NOW);
    expect(rec).not.toBeNull();
    expect(rec!.provenance).toBeDefined();
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('cites stats-cache.json in every observation and keeps the inference separate', () => {
    const rec = activityTrend.rule(activityInput(makeCache(12576, 2373)), NOW);
    const p = rec!.provenance!;
    expect(p.observations.length).toBeGreaterThan(0);
    for (const o of p.observations) expect(o.source).toBe('stats-cache.json');
    expect(p.inference).toMatch(/%/); // the "so what", not a raw count
  });

  it('carries the lastComputedDate as asOf and flags staleness honestly', () => {
    const fresh = activityTrend.rule(activityInput(makeCache(12576, 2373, '2026-06-03')), NOW);
    expect(fresh!.provenance!.asOf).toBe('2026-06-03');
    expect(fresh!.provenance!.stale).toBe(false);

    const staleNow = new Date('2026-06-04T00:00:00Z').getTime();
    const stale = activityTrend.rule(activityInput(makeCache(12576, 2373, '2026-05-01')), staleNow);
    expect(stale!.provenance!.asOf).toBe('2026-05-01');
    expect(stale!.provenance!.stale).toBe(true);
    expect(validateRecommendationProvenance(stale!)).toEqual([]);
  });
});
