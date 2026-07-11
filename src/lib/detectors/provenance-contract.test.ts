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
  isAsOfStale,
  demoteStaleAttribution,
} from './provenance';
import type {
  Recommendation,
  RecommendationInput,
  RecProvenance,
  RecommendationSavingsAttribution,
} from './types';
import { detector as activityTrend } from './activity/activity-trend';
import type { LiveConfig } from '../../types';
import type { RuntimeEvents } from '../parse-runtime-events';
import { isBackgroundableBashCommand, type SessionTimeline } from '../parse-timeline';
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
import type { ProjectMemoryStore } from '../parse-memories';

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

// ── Stale-input freshness + demotion (#2142, #1102 path) ──────────────────

describe('isAsOfStale', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const asOf = '2026-05-10';
  const asOfMs = Date.parse('2026-05-10T00:00:00.000Z');

  it('is false inside the freshness window', () => {
    expect(isAsOfStale(asOf, asOfMs + 10 * DAY_MS, 30)).toBe(false);
  });
  it('is true past the freshness window', () => {
    expect(isAsOfStale(asOf, asOfMs + 40 * DAY_MS, 30)).toBe(true);
  });
  it('treats an absent or malformed date as not stale (only demote against a readable date)', () => {
    expect(isAsOfStale(undefined, asOfMs + 999 * DAY_MS, 30)).toBe(false);
    expect(isAsOfStale('2026-05-10T00:00:00Z', asOfMs + 999 * DAY_MS, 30)).toBe(false);
    expect(isAsOfStale('nonsense', asOfMs + 999 * DAY_MS, 30)).toBe(false);
  });
});

describe('demoteStaleAttribution', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const asOfMs = Date.parse('2026-05-10T00:00:00.000Z');
  const measured = (): RecommendationSavingsAttribution => ({
    interventionKey: 'cost.automation-share',
    signatureId: 'automation-model-pin.mechanical',
    tier: 'tier-1-before-after',
    predictedSavingsUsd: 12,
    realizedSavingsUsd: 9,
    confidence: 'medium',
    sampleSize: 7,
    window: { comparison: { start: 'a', end: 'b' } },
    asOf: '2026-05-10',
  });

  it('demotes a stale measured proof to a dated estimate, dropping the confidence fields', () => {
    const out = demoteStaleAttribution(measured(), asOfMs + 100 * DAY_MS, 30);
    expect(out.tier).toBe('tier-0-estimate');
    expect(out.stale).toBe(true);
    expect(out.confidence).toBeUndefined();
    expect(out.realizedSavingsUsd).toBeUndefined();
    expect(out.window).toBeUndefined();
    // Auditable metadata survives so the reader still sees "as of <date>".
    expect(out.asOf).toBe('2026-05-10');
    expect(out.sampleSize).toBe(7);
    expect(out.predictedSavingsUsd).toBe(12);
    expect(out.interventionKey).toBe('cost.automation-share');
    expect(out.signatureId).toBe('automation-model-pin.mechanical');
  });

  it('leaves a fresh measured proof unchanged (still a live claim)', () => {
    const attr = measured();
    const out = demoteStaleAttribution(attr, asOfMs + 5 * DAY_MS, 30);
    expect(out).toBe(attr); // same reference — untouched
    expect(out.tier).toBe('tier-1-before-after');
    expect(out.stale).toBeUndefined();
  });

  it('leaves an already-honest tier-0 estimate unchanged even when its date is old', () => {
    const attr: RecommendationSavingsAttribution = {
      interventionKey: 'cost.automation-share',
      signatureId: 'automation-model-pin.authoring',
      tier: 'tier-0-estimate',
      predictedSavingsUsd: 3,
      sampleSize: 2,
      asOf: '2026-05-10',
    };
    const out = demoteStaleAttribution(attr, asOfMs + 100 * DAY_MS, 30);
    expect(out).toBe(attr);
    expect(out.stale).toBeUndefined();
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

// One passive-wait stall: an assistant turn ending on wait language `gapMinutes`
// before a real human prompt, with no harness-backed tool in the run.
function passiveWaitTimeline(sessionId: string, gapMinutes: number): SessionTimeline {
  const t0 = Date.parse('2026-06-10T00:00:00Z');
  const turnEnd = new Date(t0).toISOString();
  const humanPrompt = new Date(t0 + gapMinutes * 60_000).toISOString();
  return {
    sessionId,
    startTime: turnEnd,
    endTime: humanPrompt,
    entries: [
      { timestamp: new Date(t0 - 1000).toISOString(), kind: 'user', summary: 'kick off the push' },
      { timestamp: turnEnd, kind: 'assistant', summary: "I'll wait for it to finish and report back.", waitLanguage: true },
      { timestamp: humanPrompt, kind: 'user', summary: 'status?' },
    ],
  };
}

function conversationalAvailabilityTimeline(
  sessionId: string,
  command: string,
  blockSec: number
): SessionTimeline {
  const t0 = Date.parse('2026-06-10T00:00:00Z');
  const at = (s: number) => new Date(t0 + s * 1000).toISOString();
  return {
    sessionId,
    startTime: at(0),
    endTime: at(2 + blockSec + 1),
    entries: [
      { timestamp: at(0), kind: 'user', summary: 'build it' },
      { timestamp: at(1), kind: 'assistant', summary: 'working' },
      {
        timestamp: at(2),
        kind: 'tool_use',
        toolName: 'Bash',
        summary: JSON.stringify({ command }),
        // Mirror parse-timeline: backgroundableKind is set from the raw command.
        ...(isBackgroundableBashCommand(command) ? { backgroundableKind: true } : {}),
      },
      { timestamp: at(2 + blockSec), kind: 'tool_result', summary: 'output' },
      { timestamp: at(2 + blockSec + 1), kind: 'assistant', summary: 'done' },
    ],
  };
}

const memoryHygieneStore = (): ProjectMemoryStore[] => [
  {
    project: 'proj-a',
    memories: [
      { name: 'kept', description: '', type: 'project', body: 'links [[ghost-memory]]', file: 'kept.md' },
    ],
    // Index points to a file that isn't on disk → dangling-index-link (structural).
    index: [{ title: 'Gone', file: 'gone.md', hook: 'x', raw: '- [Gone](gone.md) — x' }],
    indexRaw: '- [Gone](gone.md) — x',
  },
];

const PROVENANCE_TRIGGER_FIXTURES: Record<string, () => ProvenanceFixture> = {
  'maintenance.memory-hygiene': () => ({
    input: baseInput({ memoryStores: memoryHygieneStore() }),
    now: 0,
  }),
  'maintenance.doc-hygiene': () => {
    // A doc whose in-scope `md-link` resolves to a slug with no node on disk →
    // broken-internal-link (structural), with cited docGraph provenance.
    const docGraph = {
      nodes: [
        {
          slug: 'docs/guide',
          path: 'docs/guide.md',
          category: 'doc',
          frontmatter: {},
          headings: [],
          gitMtimeIso: null,
        },
      ],
      edges: [{ from: 'docs/guide', to: 'docs/missing', kind: 'md-link' }],
    } as unknown as RecommendationInput['docGraph'];
    return { input: baseInput({ docGraph }), now: 0 };
  },
  'workflow.procedural-memory': () => {
    // The same contiguous 3-step Bash procedure recurs across 3 sessions with a
    // present-but-empty skill inventory (liveConfig is REQUIRED — the finding
    // asserts "no backing skill") → an uncaptured procedural-memory finding with
    // cited recurrence provenance.
    const proc = ['git pull', 'npm run build', 'docker push app:latest'];
    const sess = (id: string) => ({
      sessionId: id,
      calls: proc.map((command) => ({
        timestamp: 't',
        toolName: 'Bash',
        input: { command },
        toolUseId: 'u',
        // Completed successfully — only isError===false continues a procedure run (:277).
        isError: false,
        resultBytes: 0,
      })),
    });
    const toolData = [
      sess('pm-a'),
      sess('pm-b'),
      sess('pm-c'),
    ] as unknown as RecommendationInput['toolData'];
    // Same-project recurrence: the detector now buckets unresolved-project sessions
    // uniquely, so map all three to ONE project (:547).
    const sessions = [
      { sessionId: 'pm-a', project: '/repo/pm' },
      { sessionId: 'pm-b', project: '/repo/pm' },
      { sessionId: 'pm-c', project: '/repo/pm' },
    ] as unknown as RecommendationInput['sessions'];
    const liveConfig = {
      settings: {},
      claudeMd: { global: null, perProject: {} },
      plugins: [],
      mcpServers: [],
      skills: [],
      subagents: [],
      commands: [],
    } as unknown as RecommendationInput['liveConfig'];
    return {
      input: baseInput({ toolData, sessions, liveConfig }),
      now: Date.parse('2026-07-09T00:00:00Z'),
    };
  },
  'workflow.value-of-agent-handoff': () => {
    const toolData = [
      {
        sessionId: 'handoff-setup',
        calls: [
          {
            timestamp: '2026-07-01T00:00:00.000Z',
            toolName: 'Bash',
            input: {
              command:
                "ssh deploy@app 'sudo tee /etc/app/config.yaml >/dev/null && sudo systemctl restart app'",
            },
            toolUseId: 'handoff-tool-1',
            isError: false,
            resultBytes: 1200,
          },
        ],
      },
    ] as unknown as RecommendationInput['toolData'];
    const sessions = [
      { sessionId: 'handoff-setup', project: '/repo/handoff' },
    ] as unknown as RecommendationInput['sessions'];
    const tokenData = [
      {
        sessionId: 'handoff-setup',
        project: '/repo/handoff',
        entries: [
          {
            timestamp: '2026-07-01T00:00:00.000Z',
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheCreation1hTokens: 0,
            cacheReadTokens: 0,
            webSearchRequests: 0,
            webFetchRequests: 0,
            model: 'claude-opus-4-8',
            toolUseIds: ['handoff-tool-1'],
            toolResultBytes: 1200,
          },
        ],
        contextToolResultTokensSum: 4000,
        compactionEvents: [],
      },
    ] as unknown as RecommendationInput['tokenData'];
    return {
      input: baseInput({ toolData, sessions, tokenData }),
      now: Date.parse('2026-07-09T00:00:00Z'),
    };
  },
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
  'reliability.passive-wait-stall': () => ({
    input: baseInput({
      timelines: [
        passiveWaitTimeline('stall-1', 16),
        passiveWaitTimeline('stall-2', 7),
        passiveWaitTimeline('stall-3', 3),
      ],
    }),
    now: 0,
  }),
  'workflow.conversational-availability': () => ({
    input: baseInput({
      timelines: [
        conversationalAvailabilityTimeline('ca-1', 'npm run build', 30),
        conversationalAvailabilityTimeline('ca-2', 'vitest run', 45),
        conversationalAvailabilityTimeline('ca-3', 'podman compose up --build', 60),
      ],
    }),
    now: 0,
  }),
  'workflow.reclaim-wait-windows': () => {
    // Three passive-wait stalls, each carrying a parsed wait class, so the
    // ruleset detector groups them into reclaimable classes and fires.
    const t0 = Date.parse('2026-06-10T00:00:00Z');
    const classedStall = (
      sessionId: string,
      waitClass: 'ci' | 'deploy' | 'push',
      gapMin: number
    ): SessionTimeline => {
      const turnEnd = new Date(t0).toISOString();
      const humanPrompt = new Date(t0 + gapMin * 60_000).toISOString();
      return {
        sessionId,
        startTime: turnEnd,
        endTime: humanPrompt,
        entries: [
          { timestamp: new Date(t0 - 1000).toISOString(), kind: 'user', summary: 'go' },
          { timestamp: turnEnd, kind: 'assistant', summary: "I'll wait and report back.", waitLanguage: true, waitClass },
          { timestamp: humanPrompt, kind: 'user', summary: 'status?' },
        ],
      };
    };
    return {
      input: baseInput({
        timelines: [
          classedStall('rww-1', 'ci', 16),
          classedStall('rww-2', 'deploy', 7),
          classedStall('rww-3', 'push', 3),
        ],
      }),
      now: 0,
    };
  },
  'reliability.cwd-drift-execution': () => {
    // Three sessions each running an unanchored git read (no -C / cd / -R).
    const driftRead = (sessionId: string) =>
      ({
        sessionId,
        calls: [
          {
            timestamp: '2026-06-10T00:00:01Z',
            toolName: 'Bash',
            input: { command: 'git log origin/master --oneline -5' },
            toolUseId: 'u',
            isError: null,
            resultBytes: 0,
          },
        ],
      }) as unknown as RecommendationInput['toolData'][number];
    return {
      input: baseInput({
        toolData: [driftRead('cwd1'), driftRead('cwd2'), driftRead('cwd3')],
      }),
      now: 0,
    };
  },
  'reliability.stale-state-assertion': () => {
    // Three sessions each reading an integration-branch ref with no prior fetch.
    const staleRead = (sessionId: string) =>
      ({
        sessionId,
        calls: [
          {
            timestamp: '2026-06-10T00:00:01Z',
            toolName: 'Bash',
            input: { command: 'git log origin/master --oneline -5' },
            toolUseId: 'u',
            isError: null,
            resultBytes: 0,
          },
        ],
      }) as unknown as RecommendationInput['toolData'][number];
    return {
      input: baseInput({
        toolData: [staleRead('ssa1'), staleRead('ssa2'), staleRead('ssa3')],
      }),
      now: 0,
    };
  },
  'reliability.discovery-freshness': () => {
    // Three sessions, each: Read a repo-mapped file, a `git pull` moves the tree,
    // then Edit the same file with no re-Read → an acted-on stale read.
    const staleEdit = (sessionId: string) =>
      ({
        sessionId,
        calls: [
          {
            timestamp: '2026-06-10T00:00:01Z',
            toolName: 'Read',
            input: { file_path: '/repo/src/lib/reclaim.ts' },
            toolUseId: 'u',
            isError: null,
            resultBytes: 400,
          },
          {
            timestamp: '2026-06-10T00:00:02Z',
            toolName: 'Bash',
            input: { command: 'git pull --rebase' },
            toolUseId: 'u',
            isError: null,
            resultBytes: 0,
          },
          {
            timestamp: '2026-06-10T00:00:03Z',
            toolName: 'Edit',
            input: { file_path: '/repo/src/lib/reclaim.ts' },
            toolUseId: 'u',
            isError: null,
            resultBytes: 0,
          },
        ],
      }) as unknown as RecommendationInput['toolData'][number];
    const repoMap = {
      projects: [
        {
          root: '/repo',
          generatedAtGitSha: 'abc1234567890def',
          fileCount: 1,
          truncated: false,
          text: '',
          files: [
            { path: 'src/lib/reclaim.ts', symbols: [], imports: [], configSections: [], recommendations: [] },
          ],
          configSections: [],
          configAttribution: [],
        },
      ],
    } as unknown as RecommendationInput['repoMap'];
    return {
      input: baseInput({
        toolData: [staleEdit('df1'), staleEdit('df2'), staleEdit('df3')],
        repoMap,
      }),
      now: 0,
    };
  },
  'context.cross-session-reread': () => {
    // A doc cold-read once per session across 6 sessions, read-only, big enough
    // that the NET cross-session tax clears the savings floor.
    const toolData = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `xsr${i}`,
      calls: [
        {
          timestamp: 't',
          toolName: 'Read',
          input: { file_path: 'docs/guide.md' },
          toolUseId: 'u',
          isError: null,
          resultBytes: 200_000,
        },
      ],
    })) as RecommendationInput['toolData'];
    const tokenData = Array.from({ length: 6 }, (_, i) => ({
      sessionId: `xsr${i}`,
      entrypoint: 'cli',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 100_000,
      model: 'claude-opus-4-8',
      messageCount: 1,
      entries: [
        {
          timestamp: 't',
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 100_000,
          webSearchRequests: 0,
          webFetchRequests: 0,
          model: 'claude-opus-4-8',
        },
      ],
      compactionEvents: [],
      hasUnknownModel: false,
    })) as unknown as RecommendationInput['tokenData'];
    return { input: baseInput({ toolData, tokenData }), now: 0 };
  },
  'context.last-n-runs-audit': () => {
    // 5 baseline runs (~40k peak) then 10 more-recent window runs (~80k peak),
    // chronological by entry timestamp, with `now` just after the last run so
    // the trend is fresh (not stale) and the rec fires.
    const base = Date.parse('2026-05-01T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const make = (i: number, peak: number) => ({
      sessionId: `lnr${i}`,
      entrypoint: 'cli',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: peak,
      model: 'claude-opus-4-8',
      messageCount: 1,
      entries: [
        {
          timestamp: new Date(base + i * day).toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheCreation1hTokens: 0,
          cacheReadTokens: peak,
          webSearchRequests: 0,
          webFetchRequests: 0,
          model: 'claude-opus-4-8',
        },
      ],
      compactionEvents: [],
      hasUnknownModel: false,
    });
    const tokenData = [
      ...Array.from({ length: 5 }, (_, i) => make(i, 40_000)),
      ...Array.from({ length: 10 }, (_, i) => make(5 + i, 80_000)),
    ] as unknown as RecommendationInput['tokenData'];
    return { input: baseInput({ tokenData }), now: base + 15 * day };
  },
  'context.reclaim-potential': () => {
    // One session re-fetching the same large Bash output 3x (duplicate bucket),
    // big enough that the reclaim clears the dollar floor.
    const toolData = [
      {
        sessionId: 'rp1',
        calls: Array.from({ length: 3 }, () => ({
          timestamp: '2026-06-10T00:00:01Z',
          toolName: 'Bash',
          input: { command: 'cat huge.log' },
          toolUseId: 'u',
          isError: null,
          resultBytes: 800_000,
          commandFingerprint: 'cat-huge-log',
        })),
      },
    ] as unknown as RecommendationInput['toolData'];
    const tokenData = [
      {
        sessionId: 'rp1',
        entrypoint: 'cli',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 100_000,
        model: 'claude-opus-4-8',
        messageCount: 1,
        entries: [
          {
            timestamp: 't',
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheCreation1hTokens: 0,
            cacheReadTokens: 100_000,
            webSearchRequests: 0,
            webFetchRequests: 0,
            model: 'claude-opus-4-8',
          },
        ],
        compactionEvents: [],
        hasUnknownModel: false,
      },
    ] as unknown as RecommendationInput['tokenData'];
    return { input: baseInput({ toolData, tokenData }), now: 0 };
  },
  'workflow.human-input-leverage': () => {
    // Four typical 10k spans + one 300k excursion that ran > 3x its class median
    // and carried a late human corrective turn (not accepted) → an auditable
    // value-of-human-input finding with cited, per-signal provenance.
    const start = '2026-06-12T10:00:00.000Z';
    const end = '2026-06-12T11:00:00.000Z';
    const mid = '2026-06-12T10:30:00.000Z';
    const steering = (sessionId: string, over: Record<string, unknown> = {}) => ({
      sessionId,
      project: '/repo/app',
      taskIndex: 0,
      startTime: start,
      endTime: end,
      wallClockMs: 3_600_000,
      costUsd: 1,
      humanTurns: 1,
      corrective: 0,
      clarifyingAnswer: 0,
      approving: 1,
      other: 0,
      interruptions: 0,
      divergenceRate: 0,
      ...over,
    });
    const tokens = (sessionId: string, total: number) => ({
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
          timestamp: mid,
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
    });
    const taskSteering = [
      steering('hil-typ-0'),
      steering('hil-typ-1'),
      steering('hil-typ-2'),
      steering('hil-typ-3'),
      steering('hil-exc', { corrective: 2, humanTurns: 2, approving: 0 }),
    ] as unknown as RecommendationInput['taskSteering'];
    const taskSuccess = [
      {
        sessionId: 'hil-exc',
        project: '/repo/app',
        taskIndex: 0,
        startTime: start,
        endTime: end,
        wallClockMs: 3_600_000,
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
      },
    ] as unknown as RecommendationInput['taskSuccess'];
    const tokenData = [
      tokens('hil-typ-0', 10_000),
      tokens('hil-typ-1', 10_000),
      tokens('hil-typ-2', 10_000),
      tokens('hil-typ-3', 10_000),
      tokens('hil-exc', 300_000),
    ] as unknown as RecommendationInput['tokenData'];
    return {
      input: baseInput({ taskSteering, taskSuccess, tokenData }),
      now: Date.parse('2026-06-20T00:00:00.000Z'),
    };
  },
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
