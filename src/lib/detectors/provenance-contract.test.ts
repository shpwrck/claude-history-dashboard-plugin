/**
 * Provenance contract test (#1049, epic #866 keystone; inverted by #3204/#3205).
 *
 * Enforces the auditability contract at the schema level:
 *  1. The validator accepts well-formed provenance and rejects each malformed
 *     shape — including, since #3204, a source-only citation with no `field`, a
 *     numeric claim with no scalar `value`, and an `asOf` that matches the digit
 *     shape but is not a real calendar date.
 *  2. Provenance is REQUIRED by default. `PROVENANCE_EXEMPT` is the only way
 *     out, and it is checked for rot, duplication, overlap, and growth.
 *  3. Every detector with a trigger fixture emits compliant provenance when it
 *     actually runs, and every recommendation that fires on the SPA sample
 *     corpus is compliant-or-exempt on realistic input.
 *
 * ## What changed, and why the shape of this file changed with it
 *
 * Until #3205 `PROVENANCE_DETECTORS` was an opt-in allowlist and the validator
 * treated every id NOT on it as compliant, so the contract only bound detectors
 * whose authors had enlisted them. Measured at the flip: 33 enlisted, 52 emitted
 * nothing, and 17 emitted valid provenance while sitting outside the list —
 * unprotected against regression despite having done the work. That default is
 * the mechanism behind ~29 separate v0.6 audit findings, so the fix inverts it
 * rather than enlisting 29 more ids.
 *
 * The three tiers of proof, weakest to strongest, are all here on purpose:
 * the exemption register (declared), the sample-corpus sweep (realistic input),
 * and the trigger-fixture harness (the detector actually run). None subsumes
 * another — a detector that fires on neither corpus nor fixture is bound by the
 * default but not exercised by it, which the sweep says out loud.
 */
import { describe, it, expect } from 'vitest';
import { DETECTORS } from './index';
import {
  PROVENANCE_DETECTORS,
  PROVENANCE_EXEMPT,
  validateRecObservation,
  validateRecProvenance,
  validateRecommendationProvenance,
  isAsOfStale,
  demoteStaleAttribution,
} from './provenance';
import { emittableIdsFor } from './dual-emit';
import { MIN_STALE_SESSIONS } from './shared';
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
// @ts-expect-error - plain ESM build helper, no .d.ts (same import as sample-corpus.test.ts)
import { buildSampleCorpus } from '../../../scripts/sample-data/build-corpus.mjs';
import { parseHistoryJsonl, groupBySessions, groupByProjects } from '../parse-history';
import { parseSessionJsonl } from '../parse-sessions';
import { parseToolUsage } from '../parse-tools';
import { parseApiErrors } from '../parse-errors';
import { parsePermissionData } from '../parse-permissions';
import { assembleRecommendationInput } from '../recommendations';

/**
 * A full {@link RecommendationInput} assembled from the SPA sample corpus by
 * running the real parsers over it — the same path `sample-corpus.test.ts`
 * uses, so the sweep below sees what the product sees.
 */
function sampleCorpusInput(): RecommendationInput {
  const corpus = buildSampleCorpus() as { historyJsonl: string; sessions: { sessionId: string; jsonl: string }[] };
  const files = corpus.sessions.map((s) => ({ name: `${s.sessionId}.jsonl`, text: s.jsonl }));
  const flat = <T,>(fn: (text: string, name: string) => T[]): T[] =>
    files.flatMap((f) => fn(f.text, f.name));
  const collect = <T,>(fn: (text: string, name: string) => T | null): T[] =>
    files.map((f) => fn(f.text, f.name)).filter((d): d is T => d !== null);
  const history = parseHistoryJsonl(corpus.historyJsonl);
  return assembleRecommendationInput({
    tokenData: collect(parseSessionJsonl) as RecommendationInput['tokenData'],
    toolData: collect(parseToolUsage) as RecommendationInput['toolData'],
    sessions: groupBySessions(history) as unknown as RecommendationInput['sessions'],
    projects: groupByProjects(history) as unknown as RecommendationInput['projects'],
    permissionRows: collect(parsePermissionData) as RecommendationInput['permissionRows'],
    apiErrors: flat(parseApiErrors) as RecommendationInput['apiErrors'],
  });
}

// ── Validator unit tests ─────────────────────────────────────────────────

const goodObs = { claim: '18 of 18 assignments unread', source: 'teams/', field: 'unreadCount', value: 18 };

describe('validateRecObservation', () => {
  it('accepts a fully-specified observation', () => {
    expect(validateRecObservation(goodObs)).toEqual([]);
  });
  it('accepts a qualitative claim with no value (nothing to reproduce)', () => {
    expect(validateRecObservation({ claim: 'a Stop hook is configured', source: 'settings.json', field: 'hooks.Stop' })).toEqual([]);
  });
  it('rejects a source-only observation — the citation must be locatable (#3204)', () => {
    // Previously accepted. A `source` alone says WHICH artifact but not where
    // in it, so the reader cannot get back to the evidence.
    expect(validateRecObservation({ claim: 'x', source: 'parse-tools' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a blank field', () => {
    expect(validateRecObservation({ claim: 'x', source: 's', field: '  ' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a numeric claim with no scalar value to reproduce it (#3204)', () => {
    const errs = validateRecObservation({ claim: '18 of 18 assignments unread', source: 'teams/', field: 'unreadCount' } as never);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/states a figure/);
  });
  it('accepts that same numeric claim once it cites its value', () => {
    expect(validateRecObservation(goodObs)).toEqual([]);
  });
  it('rejects a missing/blank claim', () => {
    expect(validateRecObservation({ claim: '  ', source: 's', field: 'f' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a missing source (the citation is the point)', () => {
    expect(validateRecObservation({ claim: 'x', field: 'f' } as never).length).toBeGreaterThan(0);
  });
  it('rejects a non-scalar value', () => {
    expect(validateRecObservation({ claim: 'x', source: 's', field: 'f', value: {} } as never).length).toBeGreaterThan(0);
  });
  it('rejects a non-finite numeric value (NaN is not auditable)', () => {
    expect(validateRecObservation({ claim: 'x', source: 's', field: 'f', value: NaN } as never).length).toBeGreaterThan(0);
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
  it('rejects an impossible asOf that still matches the digit shape (#3204)', () => {
    // `2026-99-99` fails to parse at all; `2026-02-30` and `2026-06-31` DO
    // parse — JS rolls them over to Mar 2 / Jul 1 — which is exactly why the
    // shape regex was not enough and the check round-trips.
    for (const asOf of ['2026-99-99', '2026-13-01', '2026-02-30', '2026-06-31']) {
      expect(
        validateRecProvenance({ observations: [goodObs], asOf }).length,
        `${asOf} should be rejected as a non-calendar date`
      ).toBeGreaterThan(0);
    }
  });
  it('applies the real leap-year rule rather than the digit shape', () => {
    // 2026 is not a leap year; 2024 is.
    expect(validateRecProvenance({ observations: [goodObs], asOf: '2026-02-29' }).length).toBeGreaterThan(0);
    expect(validateRecProvenance({ observations: [goodObs], asOf: '2024-02-29' })).toEqual([]);
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

// ── Inverted default: provenance is required unless exempt (#3205) ─────────

/** Every rec id the catalog can emit, including dual-emit branches. */
const EMITTABLE_IDS = new Set(DETECTORS.flatMap((d) => emittableIdsFor(d.id)));

/**
 * The size of the debt register the day the default was inverted.
 *
 * Pinned with `toBeLessThanOrEqual` so migrations (which shrink it) pass
 * untouched while an ADDITION fails — the list is the only way to emit an
 * unauditable recommendation, so growing it must be a deliberate edit rather
 * than the path of least resistance. Update this number DOWNWARD only.
 */
const EXEMPT_AT_INVERSION = 43;

describe('PROVENANCE_EXEMPT debt register (#3205)', () => {
  it('only lists ids the catalog can actually emit', () => {
    for (const id of PROVENANCE_EXEMPT) {
      expect(
        EMITTABLE_IDS.has(id),
        `${id} is exempt from the provenance contract but no registered detector emits it — ` +
          `a renamed or deleted detector left its exemption behind`
      ).toBe(true);
    }
  });

  it('is shrink-only', () => {
    expect(
      PROVENANCE_EXEMPT.length,
      `PROVENANCE_EXEMPT grew past ${EXEMPT_AT_INVERSION}. Adding an id here opts a ` +
        `recommendation OUT of being auditable, which is the defect #3205 fixed. ` +
        `Emit provenance instead; only lower this pin.`
    ).toBeLessThanOrEqual(EXEMPT_AT_INVERSION);
  });

  it('never exempts a detector that is separately proven compliant', () => {
    // A fixture-proven detector that is ALSO exempt would silently stop being
    // required if its fixture were ever deleted.
    const both = PROVENANCE_DETECTORS.filter((id) => PROVENANCE_EXEMPT.includes(id));
    expect(both).toEqual([]);
  });

  it('has no duplicate entries', () => {
    expect(new Set(PROVENANCE_EXEMPT).size).toBe(PROVENANCE_EXEMPT.length);
  });
});

describe('provenance is required by default (#3205)', () => {
  const bare = (id: string): Recommendation =>
    ({
      id,
      category: 'workflow',
      severity: 'info',
      title: 't',
      detail: 'd',
      action: 'a',
      view: 'sessions',
    }) as Recommendation;

  it('rejects an unrecognised id that emits no provenance', () => {
    // The exact hole #3205 closed: before the inversion an id nobody had
    // enlisted was treated as compliant, so a detector could make a
    // quantitative claim with nothing behind it by never joining a list.
    const errs = validateRecommendationProvenance(bare('workflow.brand-new-detector'));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/emitted no provenance/);
  });

  it('still allows an explicitly exempt id through', () => {
    expect(validateRecommendationProvenance(bare(PROVENANCE_EXEMPT[0]))).toEqual([]);
  });

  it('validates the block when one IS present, exempt or not', () => {
    const rec = bare(PROVENANCE_EXEMPT[0]);
    rec.provenance = { observations: [] };
    expect(validateRecommendationProvenance(rec).length).toBeGreaterThan(0);
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
      { name: 'kept', description: '', type: 'project', body: '', file: 'kept.md' },
    ],
    // Index points to a file that isn't on disk → dangling-index-link (structural).
    index: [{ title: 'Gone', file: 'gone.md', hook: 'x', raw: '- [Gone](gone.md) — x' }],
    indexRaw: '- [Gone](gone.md) — x',
    indexPresent: true,
    archiveIndex: [],
    archiveIndexRaw: '',
    archiveIndexPresent: false,
    readCompleteness: { facts: true, mainIndex: true, archiveIndex: true },
  },
];

// Report-card fixture parts (#3205) — mirrors agent-report-card.test.ts: a
// committed project carrying retry storms + slow TTFB, which blends to MOVE.
const RC_ENV = {
  node_version: 'v22.0.0',
  terminal: 'tmux',
  wsl_version: '2',
  linux_distro_id: 'ubuntu',
  arch: 'x64',
  build_time: '2026-06-01',
};
const rcSession = (cwd: string, sessionId: string) =>
  ({
    pid: 1000 + sessionId.length,
    sessionId,
    cwd,
    startedAt: Date.parse('2026-06-01T00:00:00.000Z'),
    procStart: '12345',
    version: '2.1.161',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
  }) as unknown as RecommendationInput['sessionRegistry'][number];
const rcTelemetry = (sessionId: string, attempt: number, elapsedMs: number) =>
  ({
    event_name: 'tengu_api_slow_first_byte',
    client_timestamp: '2026-06-01T00:00:00Z',
    model: 'claude-opus-4-8',
    betas: '',
    session_id: sessionId,
    attempt,
    elapsed_ms: elapsedMs,
    env: RC_ENV,
  }) as unknown as RecommendationInput['telemetry'][number];
const rcDebug = (sessionId: string) =>
  ({
    sessionId,
    ttfbP50: 6500,
    ttfbP90: 13000,
    ttfbMax: 13000,
    ttfbSampleCount: 5,
    maxRetryAttempt: 1,
    slowFirstByteCount: 0,
    fastModeLostCount: 5,
  }) as unknown as RecommendationInput['debugLogs'][number];

// ── context/activity migration fixtures (#3180, #3183, #3185, #3188, #3189) ──
//
// Nine detectors migrated off the debt register together. Six of them do not
// fire on the sample corpus, so a trigger fixture is the ONLY tier of proof
// that runs them — hence one per detector rather than leaning on the sweep.
// Timestamps are real ISO dates so the `asOf` path (newest OBSERVED entry,
// never `now`) is exercised rather than skipped.

const CTX_TS = '2026-06-09T12:00:00.000Z';
const CTX_ASOF = '2026-06-09';

/** A session token record with one entry, sized to hit a chosen context peak. */
const ctxSession = (
  sessionId: string,
  over: {
    inputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    totalCacheCreationTokens?: number;
    totalCacheReadTokens?: number;
    compactions?: number;
    timestamp?: string;
  } = {}
): RecommendationInput['tokenData'][number] =>
  ({
    sessionId,
    totalOutputTokens: 5_000,
    totalCacheCreationTokens: over.totalCacheCreationTokens ?? over.cacheCreationTokens ?? 0,
    totalCacheReadTokens: over.totalCacheReadTokens ?? over.cacheReadTokens ?? 0,
    entries: [
      {
        timestamp: over.timestamp ?? CTX_TS,
        model: 'claude-sonnet-4-6',
        inputTokens: over.inputTokens ?? 1_000,
        outputTokens: 5_000,
        cacheCreationTokens: over.cacheCreationTokens ?? 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: over.cacheReadTokens ?? 0,
        webSearchRequests: 0,
        webFetchRequests: 0,
      },
    ],
    compactionEvents: Array.from({ length: over.compactions ?? 0 }, () => ({})),
  }) as unknown as RecommendationInput['tokenData'][number];

/** `n` Read calls returning `bytesEach` bytes — a large-tool-output profile. */
const ctxReads = (
  sessionId: string,
  n: number,
  bytesEach: number,
  path = '/repo/src/lib/reclaim.ts'
): RecommendationInput['toolData'][number] =>
  ({
    sessionId,
    calls: Array.from({ length: n }, (_, i) => ({
      timestamp: `2026-06-09T12:00:0${i}.000Z`,
      toolName: 'Read',
      input: { file_path: path },
      toolUseId: `ctx-r${i}`,
      isError: null,
      resultBytes: bytesEach,
    })),
  }) as unknown as RecommendationInput['toolData'][number];

const PROVENANCE_TRIGGER_FIXTURES: Record<string, () => ProvenanceFixture> = {
  'activity.stale-projects': () => {
    // Two projects over the session floor whose last activity predates the
    // 4-week cutoff, and no `cleanupPeriodDays` ageing history out.
    const now = Date.parse('2026-06-10T00:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;
    const project = (projectShort: string, daysQuiet: number) => ({
      project: `/home/u/${projectShort}`,
      projectShort,
      sessionCount: MIN_STALE_SESSIONS + 2,
      messageCount: 120,
      firstSeen: now - 300 * DAY,
      lastSeen: now - daysQuiet * DAY,
      sessions: [],
    });
    return {
      input: baseInput({
        projects: [
          project('quiet-one', 40),
          project('quiet-two', 95),
        ] as unknown as RecommendationInput['projects'],
        liveConfig: liveConfig(),
      }),
      now,
    };
  },

  'context.bloated-claude-md': () => {
    // A merged CLAUDE.md past the 200-line target. Split across a global file
    // AND a per-project file so the "this is a merge" observation is exercised
    // on a genuine merge rather than a single document.
    return {
      input: baseInput({
        liveConfig: liveConfig({
          claudeMd: {
            global: 'global rule line\n'.repeat(180),
            perProject: { '/repo': 'project rule line\n'.repeat(60) },
          },
        } as unknown as Partial<LiveConfig>),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'context.compaction-hot-sessions': () => {
    // Two sessions near the window that have already compacted twice → both
    // land in the hot band, clearing MIN_HOT_SESSIONS. Cache writes with no
    // reads back give the reclaim arm a non-zero grounded fraction.
    const hot = (id: string) =>
      ctxSession(id, {
        inputTokens: 180_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 0,
        compactions: 2,
      });
    return {
      input: baseInput({
        tokenData: [hot('ch-1'), hot('ch-2')],
        timelines: [],
        liveConfig: liveConfig(),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'context.compaction-large-tool-outputs': () => {
    // Three hot sessions whose tool calls all return >5K-token results, so
    // tool-output is the dominant compaction factor on each (MIN_DOMINANT = 3).
    const ids = ['lt-1', 'lt-2', 'lt-3'];
    return {
      input: baseInput({
        tokenData: ids.map((id) => ctxSession(id, { inputTokens: 140_000 })),
        toolData: ids.map((id) => ctxReads(id, 4, 50_000)),
        timelines: [],
        liveConfig: liveConfig(),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'context.low-cache-hit': () => {
    // Two sessions reading back far less than the 50% reuse floor, with real
    // cache-write volume so the reclaim observation is exercised too.
    return {
      input: baseInput({
        tokenData: [
          ctxSession('lc-1', { cacheCreationTokens: 1_000_000, cacheReadTokens: 100_000 }),
          ctxSession('lc-2', { cacheCreationTokens: 500_000, cacheReadTokens: 20_000 }),
        ],
        liveConfig: liveConfig(),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'context.low-health': () => {
    // Score 20: -20 low cache hit, -20 two compactions, -20 peak over the warn
    // line, -20 peak over the window — comfortably under LOW_HEALTH_SCORE (50).
    return {
      input: baseInput({
        tokenData: [
          ctxSession('lh-1', {
            inputTokens: 210_000,
            cacheCreationTokens: 1_000,
            cacheReadTokens: 0,
            compactions: 2,
          }),
        ],
        liveConfig: liveConfig(),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'context.over-window': () => {
    // Peak context 260K, past the 200K window.
    return {
      input: baseInput({
        tokenData: [
          ctxSession('ow-1', { inputTokens: 250_000, cacheReadTokens: 10_000 }),
          ctxSession('ow-2', { inputTokens: 60_000 }),
        ],
        liveConfig: liveConfig(),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'context.repeated-compactions': () => {
    // DELIBERATELY ordered against the claim: `computeCompactionRisk` sorts by
    // riskScore, so the near-window session (2 compactions) outranks the
    // low-context one (5 compactions). A "most-compacted = rows[0]" reading
    // would report 2 here; the correct max is 5.
    return {
      input: baseInput({
        tokenData: [
          ctxSession('rc-low-risk', { inputTokens: 2_000, compactions: 5 }),
          ctxSession('rc-high-risk', { inputTokens: 190_000, compactions: 2 }),
        ],
        timelines: [],
        liveConfig: liveConfig(),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'context.repo-map-context-waste': () => {
    // One stable, read-only, exported-API file that is re-read across sessions,
    // plus the tool calls that re-read it so the priced reclaim arm fires.
    const path = 'src/lib/reclaim.ts';
    const repoMap = {
      projects: [
        {
          root: '/repo',
          generatedAtGitSha: 'abc123',
          fileCount: 1,
          truncated: false,
          text: '(map)',
          configSections: [],
          configAttribution: [],
          files: [
            {
              path,
              imports: [],
              configSections: [],
              recommendations: [],
              symbols: [
                { name: 'runReclaimCascade', kind: 'function', exported: true, signature: 'f()', line: 1 },
                { name: 'scopeKeyOf', kind: 'function', exported: true, signature: 'f()', line: 2 },
              ],
              reread: { sessions: 3, totalReads: 9, totalEstimatedTokenWaste: 5_000, maxPerSession: 3 },
            },
          ],
        },
      ],
    } as unknown as RecommendationInput['repoMap'];
    return {
      input: baseInput({
        repoMap,
        toolData: [ctxReads('rm-1', 3, 4_000, `/repo/${path}`)],
        tokenData: [ctxSession('rm-1', { cacheReadTokens: 50_000 })],
        liveConfig: liveConfig(),
      }),
      now: Date.parse('2026-06-10T00:00:00.000Z'),
    };
  },

  'reliability.api-errors': () => {
    // Recorded errors with NO rate-limit status, so the rule takes its
    // detector-id branch rather than dual-emitting `reliability.rate-limits`.
    const apiErrors = [
      { sessionId: 'ae-1', timestamp: '2026-06-09T00:00:00.000Z', summary: 'internal error', status: 500 },
      { sessionId: 'ae-1', timestamp: '2026-06-10T00:00:00.000Z', summary: 'internal error', status: 500 },
      { sessionId: 'ae-2', timestamp: '2026-06-08T00:00:00.000Z', summary: 'bad gateway', status: 502 },
    ] as unknown as RecommendationInput['apiErrors'];
    return {
      input: baseInput({ apiErrors, liveConfig: liveConfig() }),
      now: Date.parse('2026-06-11T00:00:00.000Z'),
    };
  },
  'reliability.config-drift': () => {
    // One recent project-scoped drift event that disabled an MCP server — the
    // "my tool stopped working" case, inside the 7-day window.
    const now = Date.parse('2026-06-10T00:00:00.000Z');
    const configBackups = [
      {
        kind: 'server-disabled',
        project: '/repo/payments',
        server: 'postgres',
        from: true,
        to: false,
        timestamp: now - 3_600_000,
        severity: 'warning',
      },
    ] as unknown as RecommendationInput['configBackups'];
    return { input: baseInput({ configBackups }), now };
  },
  'reliability.agent-report-card': () => {
    const ids = ['rc1', 'rc2', 'rc3', 'rc4'];
    return {
      input: baseInput({
        sessionRegistry: ids.map((id) => rcSession('/repo/heavy', id)) as RecommendationInput['sessionRegistry'],
        telemetry: ids.flatMap((id) => [
          rcTelemetry(id, 9, 30_000),
          rcTelemetry(id, 2, 1_000),
        ]) as RecommendationInput['telemetry'],
        debugLogs: ids.map(rcDebug) as RecommendationInput['debugLogs'],
      }),
      now: Date.parse('2026-06-11T00:00:00.000Z'),
    };
  },
  'workflow.shadow-prompt': () => {
    // A qualifying prompt VARIATION (#2643 receipts): 5/6 decided shadow wins,
    // dated fresh, no current proof → observational lead with cited provenance.
    const now = Date.parse('2026-06-20T00:00:00.000Z');
    return {
      now,
      input: baseInput({
        shadowCalls: {
          total: 6,
          counted: 6,
          synthetic: 0,
          skipped: 0,
          live: 4,
          replay: 2,
          byAxis: [],
          bySourceAxis: [],
          variationSkipped: 0,
          byVariation: [
            {
              axis: 'prompt',
              variation: 'structured',
              samples: 6,
              live: 4,
              trustedLive: 4,
              replay: 2,
              shadowWins: 5,
              mainWins: 1,
              ties: 0,
              decided: 6,
              costDeltaSum: -0.6,
              costDeltaCount: 6,
              latestTs: '2026-06-19T00:00:00.000Z',
              untimed: 0,
              proofStatusCounts: { unknown: 6, current: 0, stale: 0, revoked: 0 },
            },
          ],
        } as unknown as RecommendationInput['shadowCalls'],
      }),
    };
  },
  'cost.edit-format-churn': () => {
    // 12 recent formatting-only Edit hunks (pure reindent) on a non-excluded
    // extension → clears every floor gate with cited parse-tools provenance.
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const calls = Array.from({ length: 12 }, (_, i) => ({
      timestamp: '2026-01-09T00:00:00.000Z',
      toolName: 'Edit',
      input: { file_path: '/repo/src/churn.ts' },
      toolUseId: `efc${i}`,
      isError: false,
      resultBytes: 0,
      editFormatChurn: {
        hunks: 1,
        formattingOnlyHunks: 1,
        lines: 12,
        formattingOnlyLines: 12,
        chars: 600,
        formattingOnlyChars: 600,
      },
    }));
    return {
      input: baseInput({ toolData: [{ sessionId: 's-churn', calls }] }),
      now,
    };
  },
  'cost.local-downroute': () => {
    // A FRESH, fully-corroborated Tier B `pass` row → a proven down-route rec
    // with cited calibration-report provenance.
    const now = Date.parse('2026-06-20T00:00:00.000Z');
    return {
      now,
      input: baseInput({
        localCalibration: {
          version: 1,
          kind: 'tier-b-calibration',
          thresholds: { minSamples: 5, minAgreement: 0.8 },
          asOf: '2026-06-15',
          classes: [
            {
              taskClass: 'mechanical',
              localModel: 'local/qwen2.5-coder',
              baselineModel: 'claude-opus-4-8',
              nRecords: 8,
              nSamples: 8,
              blindJudgeAgreement: 0.9,
              costLocal: 0.001,
              costClaude: 0.12,
              savingsUsdPerTask: 0.119,
              latency: { localMeanMs: 1200, claudeMeanMs: 3400 },
              parity: {
                held: true,
                source: 'judge-scores',
                baselineMeanScore: 8.1,
                candidateMeanScore: 8.0,
                delta: -0.1,
                rationale: null,
              },
              asOf: '2026-06-15',
              verdict: 'pass',
              reasons: ['quality parity held (delta -0.1)'],
            },
          ],
        } as unknown as RecommendationInput['localCalibration'],
      }),
    };
  },
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
  'maintenance.skill-hook-integrity': () => {
    // A Stop hook whose referenced script did not exist at ingest →
    // dangling-hook-script (structural), with cited liveConfig provenance.
    const liveConfig = {
      settings: {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node ~/.claude/hooks/gone.mjs',
                  referencedPaths: [{
                    path: '~/.claude/hooks/gone.mjs',
                    state: 'missing',
                    checkedAt: '1970-01-01T00:00:00.000Z',
                  }],
                },
              ],
            },
          ],
        },
      },
      claudeMd: { global: null, perProject: {} },
      plugins: [],
      mcpServers: [],
      skills: [],
      subagents: [],
      commands: [],
    } as unknown as RecommendationInput['liveConfig'];
    return { input: baseInput({ liveConfig }), now: 0 };
  },
  'reliability.workflow-ratelimit-burst': () => {
    // One Workflow run that lost 3 agents to plan-limit exhaustion ("You've hit
    // your session limit") → a rate-limit failure burst with cited
    // parse-workflows provenance.
    const rlAgent = (i: number) => ({
      index: i, label: null, phaseIndex: null, phaseTitle: null, model: null,
      state: 'error', agentType: null, startedAt: null, durationMs: null,
      tokens: 41_000, toolCalls: null, promptPreview: null,
      resultPreview: "You've hit your session limit.",
    });
    const workflows = [
      {
        runId: 'wf_burst', workflowName: 'adversarial-review', status: 'failed',
        startTime: 1, durationMs: 1, agentCount: 8, totalTokens: 400_000,
        totalToolCalls: 1, defaultModel: null, sessionId: 'f8f7788b', phases: [],
        agents: [rlAgent(0), rlAgent(1), rlAgent(2)],
      },
    ] as unknown as RecommendationInput['workflows'];
    return { input: baseInput({ workflows }), now: 0 };
  },
  'workflow.native-bypass': () => {
    const toolData = [
      {
        sessionId: 'native-bypass-provenance',
        calls: Array.from({ length: 12 }, (_, index) => ({
          timestamp: `2026-06-10T00:00:${String(index).padStart(2, '0')}Z`,
          toolName: 'Bash',
          input: { command: 'grep -rn fixture src/' },
          toolUseId: `native-bypass-${index}`,
          isError: null,
          resultBytes: 100,
        })),
      },
    ] as RecommendationInput['toolData'];
    return {
      input: baseInput({ toolData }),
      now: Date.parse('2026-06-11T00:00:00Z'),
    };
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
                "ssh deploy@app 'sudo tee /etc/app/config.yaml >/dev/null'",
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
  'workflow.session-restart-retype': () => {
    // Two DISTINCT same-project sessions whose long human openers are
    // near-identical (well above the token-shingle floor), one day apart.
    const mkTok = (
      sessionId: string,
      opener: string,
      ts: string
    ): RecommendationInput['tokenData'][number] =>
      ({
        sessionId,
        project: '/repo/app',
        entrypoint: 'cli',
        opener,
        entries: [
          {
            timestamp: ts,
            inputTokens: 0,
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
      }) as unknown as RecommendationInput['tokenData'][number];
    const tokenData = [
      mkTok(
        'retype-a',
        'Continue implementing the OAuth login flow for the dashboard and wire up the session cookie and the redirect handler and cover it with tests',
        '2026-07-07T00:00:00.000Z'
      ),
      mkTok(
        'retype-b',
        'Continue implementing the OAuth login flow for the dashboard and wire up the session cookie and the redirect handler and finish the tests',
        '2026-07-08T00:00:00.000Z'
      ),
    ];
    return {
      input: baseInput({ tokenData }),
      now: Date.parse('2026-07-09T00:00:00Z'),
    };
  },
  'security.secrets-at-rest': () => ({
    // A session whose transcript carried secret-shaped values (counts + coords
    // only — the parser never stored the value). No cleanupPeriodDays set, so
    // the retention-bounding fix is not self-suppressed.
    input: baseInput({
      secretsAtRest: [
        {
          sessionId: 'leaky-1',
          totalCount: 3,
          countsByKind: { 'anthropic-key': 2, 'aws-access-key-id': 1 },
          evidenceRefs: [
            {
              sessionId: 'leaky-1',
              entryIndex: 4,
              timestamp: '2026-07-08T00:00:00.000Z',
            },
          ],
          lastObserved: '2026-07-08T00:00:00.000Z',
        },
      ] as unknown as RecommendationInput['secretsAtRest'],
    }),
    now: Date.parse('2026-07-09T00:00:00Z'),
  }),
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
  'safety.dangerous-bypass': () => ({
    input: baseInput({
      toolData: [
        {
          sessionId: 'dangerous-bypass-1',
          calls: [
            {
              timestamp: '2026-07-08T00:00:00.000Z',
              toolName: 'Bash',
              input: { command: 'rm -rf ~' },
              toolUseId: 'dangerous-bypass-tool-1',
              isError: null,
              resultBytes: 0,
            },
          ],
        },
      ] as RecommendationInput['toolData'],
      permissionRows: [
        { sessionId: 'dangerous-bypass-1', mode: 'bypassPermissions' },
      ],
      liveConfig: liveConfig(),
    }),
    now: Date.parse('2026-07-09T00:00:00.000Z'),
  }),
  'speed.hook-overhead': () => {
    const now = Date.parse('2026-07-14T12:00:00Z');
    const timedStop = {
      ...stopHookEvent(false),
      timestamp: '2026-07-13T12:00:00Z',
      totalDurationMs: 6000,
    };
    return {
      input: baseInput({
        runtimeEvents: [runtime(Array.from({ length: 5 }, () => ({ ...timedStop })))],
        liveConfig: stopHookConfig(),
      }),
      now,
    };
  },
  'reliability.settings-json-invalid': () => ({
    input: baseInput({
      liveConfig: {
        settingsHealth: {
          filePath: '~/.claude/settings.json',
          present: true,
          ok: false,
          findings: [
            { kind: 'type', severity: 'error', path: 'model', message: 'expected string' },
          ],
        },
      } as unknown as RecommendationInput['liveConfig'],
    }),
    now: 0,
  }),
  'cost.automation-share': () => {
    // Two unattended sdk-* sessions on the strong model (autoCost >= $1,
    // share = 100%) so the estimate-only rec fires with cited provenance.
    const autoEntry = (input: number, output: number, ts: string) => ({
      timestamp: ts,
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      model: 'claude-opus-4-8',
    });
    const autoSession = (
      sessionId: string,
      opener: string,
      entries: ReturnType<typeof autoEntry>[]
    ) => ({
      sessionId,
      entrypoint: 'sdk-cli',
      opener,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      model: entries[0].model,
      messageCount: entries.length,
      entries,
      compactionEvents: [],
      hasUnknownModel: false,
    });
    const tokenData = [
      autoSession('auto-mech', 'route-loose classify + groom-pick dry-run', [
        autoEntry(3_000_000, 600_000, '2026-06-02T00:00:00.000Z'),
      ]),
      autoSession('auto-auth', 'coder: implement issue #2548', [
        autoEntry(3_000_000, 600_000, '2026-06-03T00:00:00.000Z'),
      ]),
    ] as unknown as RecommendationInput['tokenData'];
    return { input: baseInput({ tokenData }), now: 0 };
  },
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
  'reliability.ghost-session': () => {
    const now = Date.parse('2026-06-10T01:00:00Z');
    const sessionId = 'ghost-session-fixture';
    const toolData = [{
      sessionId,
      calls: Array.from({ length: 5 }, (_, index) => ({
        timestamp: `2026-06-10T00:0${index}:00.000Z`,
        toolName: 'Read',
        input: { file_path: `/repo/src/file-${index}.ts` },
        toolUseId: `ghost-read-${index}`,
        isError: false,
        resultBytes: 100,
      })),
    }] as RecommendationInput['toolData'];
    const timelines: SessionTimeline[] = [{
      sessionId,
      startTime: '2026-06-10T00:00:00.000Z',
      endTime: '2026-06-10T00:10:00.000Z',
      firstPromptPreview: 'Please implement the parser fix',
      entries: [
        { timestamp: '2026-06-10T00:00:00.000Z', kind: 'user', summary: 'Please implement the parser fix' },
        { timestamp: '2026-06-10T00:10:00.000Z', kind: 'assistant', summary: 'I inspected the files.' },
      ],
    }];
    return { input: baseInput({ toolData, timelines }), now };
  },
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
  'safety.deny-rule-never-triggered': () => {
    // Deny rules that no retained call matched. One guards a DESTRUCTIVE
    // command on purpose: since #3221 the detector gives no removal advice, so
    // it reports every evaluable rule rather than trying to classify command
    // safety. History is dated (so asOf/stale are exercised rather than
    // skipped) and clears the 20-call coverage floor — a thin window suppresses
    // the finding outright. The calls deliberately run a DIFFERENT command from
    // the deny rules, which is what leaves those rules never-triggered.
    const calls = Array.from({ length: 24 }, (_, i) => ({
      timestamp: i === 0 ? '2026-06-18T09:00:00.000Z' : '2026-06-19T09:00:00.000Z',
      toolName: 'Bash',
      input: { command: 'echo build-step' },
      toolUseId: `dnt${i}`,
      isError: false,
      resultBytes: 0,
    })) as unknown as RecommendationInput['toolData'][number]['calls'];
    return {
      input: baseInput({
        toolData: [{ sessionId: 's-deny', calls }],
        liveConfig: liveConfig({
          settings: {
            permissions: { deny: ['Bash(terraform destroy:*)', 'WebFetch'] },
          },
        }),
      }),
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

/**
 * `asOf` must come from the newest OBSERVED datum, never from `now`.
 *
 * The validator cannot tell the difference — both are well-formed dates — so
 * without this the easiest wrong implementation (`new Date(now)`) passes the
 * whole contract while asserting a freshness the corpus does not have. Each
 * fixture below observes 2026-06-09 and runs at `now` = 2026-06-10, so a
 * now-derived date is off by exactly one day and fails here.
 */
describe('migrated context/activity detectors date claims from observed data', () => {
  const tokenDerived = [
    'context.compaction-hot-sessions',
    'context.compaction-large-tool-outputs',
    'context.low-cache-hit',
    'context.low-health',
    'context.over-window',
    'context.repeated-compactions',
    'context.repo-map-context-waste',
  ];

  it.each(tokenDerived)('%s anchors asOf to the newest observed entry, not today', (id) => {
    const rec = runAllowlistedDetector(id);
    expect(rec.provenance!.asOf).toBe(CTX_ASOF);
  });

  it('activity.stale-projects dates from the freshest project activity', () => {
    // Its corpus is `projects[].lastSeen`, not token entries: the newest
    // project was last active 40 days before the 2026-06-10 run.
    const rec = runAllowlistedDetector('activity.stale-projects');
    expect(rec.provenance!.asOf).toBe('2026-05-01');
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

// ── Sample-corpus sweep: realistic data, not a hand-built fixture (#3205) ──

/**
 * The fixture harness above proves the strongest tier, but it can only reach a
 * detector someone wrote a fixture for. This sweep runs the WHOLE catalog over
 * the synthetic corpus that backs the marketing SPA — a corpus already
 * maintained to light up every dashboard section (`sample-corpus.test.ts`,
 * #526) — and holds every recommendation that actually fires to the contract.
 *
 * Why this and not another bespoke fixture: it is the closest thing the repo
 * has to real input, it is kept alive by a different suite for a different
 * reason, and it exercised 16 detectors at the time of writing — 9 of which
 * emitted no provenance and are on the debt register. Each future migration is
 * therefore proven against realistic data, not only against the fixture its own
 * author chose.
 *
 * HONEST LIMIT: a detector that does not fire on this corpus is not covered
 * here. Coverage is the fixture harness ∪ this sweep ∪ each detector's own
 * suite — not the full catalog. The sweep is a floor that rises as the corpus
 * grows, not a proof of total compliance.
 */
describe('sample-corpus sweep (#3205)', () => {
  const input = sampleCorpusInput();
  const NOW = Date.parse('2026-07-29T00:00:00.000Z');

  const fired = DETECTORS.map((d) => d.rule(input, NOW)).filter(
    (r): r is Recommendation => r !== null
  );

  it('fires a meaningful slice of the catalog (the sweep is not vacuous)', () => {
    // Without this, a corpus that stopped triggering anything would report
    // green while checking nothing at all.
    expect(fired.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fired.map((r) => [r.id, r] as const))(
    '%s satisfies the provenance contract on realistic input',
    (_id, rec) => {
      expect(validateRecommendationProvenance(rec)).toEqual([]);
    }
  );

  it('every firing id is either compliant or on the debt register', () => {
    const unaccounted = fired
      .filter((r) => !r.provenance && !PROVENANCE_EXEMPT.includes(r.id))
      .map((r) => r.id);
    expect(unaccounted).toEqual([]);
  });
});
