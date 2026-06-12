import { describe, it, expect } from 'vitest';
import {
  assembleRecommendationInput,
  automationCostShare,
  buildRecommendations,
  bumpSeverity,
  buildSessionProjectIndex,
  recommendationProjects,
  filterRecommendationsByProject,
  totalEstimatedSavings,
  rollupReclaim,
  rollupReclaimCascade,
  reclaimCascade,
  backfillReclaimSavings,
  rankRecommendations,
  scopeKeyOf,
  type Recommendation,
  type AppliedMarkers,
  type RecommendationInput,
  type RecommendationSavingsAttribution,
  type ReclaimClaim,
} from './recommendations';
import type { ToolCall, ToolUsageData } from './parse-tools';
import type { SessionTokenData, TokenEntry } from '../types';
import type { SessionTimeline } from './parse-timeline';
import { CHEAPEST_MODEL } from './pricing';

const call = (command: string): ToolCall => ({
  timestamp: 't',
  toolName: 'Bash',
  input: { command },
  toolUseId: 'u',
  isError: null,
  resultBytes: 0,
});

const toolSession = (sessionId: string, commands: string[]): ToolUsageData => ({
  sessionId,
  calls: commands.map(call),
});

/** Minimal SessionTokenData carrying just the dimensions the rule reads. */
const tokenSession = (
  sessionId: string,
  entrypoint: string | undefined
): SessionTokenData =>
  ({
    sessionId,
    entrypoint,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    model: 'unknown',
    messageCount: 1,
    entries: [],
    compactionEvents: [],
    hasUnknownModel: false,
  }) as unknown as SessionTokenData;

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

/** A permission row putting a session into bypassPermissions mode. */
const bypassRow = (sessionId: string) => ({
  mode: 'bypassPermissions',
  sessionId,
});

describe('rankRecommendations time fallback (#1290)', () => {
  const rec = (
    id: string,
    extra: Partial<Recommendation> = {}
  ): Recommendation => ({
    id,
    category: 'workflow',
    severity: 'info',
    title: id,
    detail: 'detail',
    action: 'action',
    ...extra,
  });

  it('sorts time-only recs by reclaimed minutes while dollar recs stay ahead', () => {
    const ranked = rankRecommendations([
      rec('time-low', { estTimeReclaimedMin: 15 }),
      rec('dollar', { estSavingsUsd: 1 }),
      rec('time-high', { estTimeReclaimedMin: 45 }),
    ]);

    expect(ranked.map((r) => r.id)).toEqual([
      'dollar',
      'time-high',
      'time-low',
    ]);
  });
});

describe('bumpSeverity', () => {
  it('raises one level and caps at critical', () => {
    expect(bumpSeverity('info')).toBe('warning');
    expect(bumpSeverity('warning')).toBe('critical');
    expect(bumpSeverity('critical')).toBe('critical');
  });
});

describe('ruleDangerousBypass entrypoint-scaled severity (#197)', () => {
  it('keeps the warning baseline for an interactive-only dangerous-commands finding', () => {
    const input = baseInput({
      toolData: [toolSession('s1', ['rm -rf /tmp/x'])],
      tokenData: [tokenSession('s1', 'cli')],
    });
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'safety.dangerous-commands'
    );
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe('warning');
    expect(rec?.unattended).toBeFalsy();
  });

  it('bumps warning → critical when a dangerous command ran under an sdk-* entrypoint', () => {
    const input = baseInput({
      toolData: [toolSession('s1', ['rm -rf /tmp/x'])],
      tokenData: [tokenSession('s1', 'sdk-cli')],
    });
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'safety.dangerous-commands'
    );
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe('critical');
    expect(rec?.unattended).toBe(true);
  });

  it('caps the bypass finding at critical even when run unattended', () => {
    const input = baseInput({
      toolData: [toolSession('s1', ['rm -rf /tmp/x'])],
      tokenData: [tokenSession('s1', 'sdk-py')],
      permissionRows: [bypassRow('s1')],
    });
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'safety.dangerous-bypass'
    );
    expect(rec).toBeDefined();
    // Baseline is already critical; the bump must not invent a new level.
    expect(rec?.severity).toBe('critical');
    expect(rec?.unattended).toBe(true);
  });

  it('leaves the bypass finding unmarked when the bypass session is interactive', () => {
    const input = baseInput({
      toolData: [toolSession('s1', ['rm -rf /tmp/x'])],
      tokenData: [tokenSession('s1', 'cli')],
      permissionRows: [bypassRow('s1')],
    });
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'safety.dangerous-bypass'
    );
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe('critical');
    expect(rec?.unattended).toBeFalsy();
  });
});

describe('automationCostShare shared helper (#299)', () => {
  const entry = (
    model: string,
    inputTokens: number,
    outputTokens: number,
    timestamp = 't'
  ): TokenEntry => ({
    timestamp,
    inputTokens,
    outputTokens,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    model,
  });

  // A billable token session carrying real entries so estimateCost > 0.
  const costingSession = (
    sessionId: string,
    entrypoint: string | undefined,
    entries: TokenEntry[]
  ): SessionTokenData =>
    ({
      sessionId,
      entrypoint,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      model: entries[0]?.model ?? 'unknown',
      messageCount: entries.length,
      entries,
      compactionEvents: [],
      hasUnknownModel: false,
    }) as unknown as SessionTokenData;

  it('returns 0 share for an empty/all-zero total without dividing by zero', () => {
    expect(automationCostShare([])).toEqual({ autoCost: 0, total: 0, share: 0 });
  });

  it('sums automation spend and its % share of total across entrypoints', () => {
    const tokenData = [
      costingSession('auto', 'sdk-cli', [entry('claude-opus-4-8', 2_000_000, 400_000)]),
      costingSession('human', 'cli', [entry('claude-opus-4-8', 1_000_000, 200_000)]),
    ];
    const { autoCost, total, share } = automationCostShare(tokenData);
    expect(autoCost).toBeGreaterThan(0);
    expect(total).toBeGreaterThan(autoCost);
    // The automation session is twice the size of the interactive one, so it
    // should be ~2/3 of the total spend.
    expect(share).toBeGreaterThan(60);
    expect(share).toBeLessThan(70);
  });

  it('feeds the same autoCost/share into ruleAutomationCost (no duplicated math)', () => {
    // Sized so the rule fires (autoCost ≥ $1, share ≥ 15%).
    const tokenData = [
      costingSession('auto1', 'sdk-cli', [
        entry('claude-opus-4-8', 5_000_000, 1_000_000),
      ]),
      costingSession('auto2', 'sdk-py', [
        entry('claude-opus-4-8', 3_000_000, 600_000),
      ]),
      costingSession('human', 'cli', [
        entry('claude-opus-4-8', 1_000_000, 200_000),
      ]),
    ];
    const helper = automationCostShare(tokenData);

    const rec = buildRecommendations(baseInput({ tokenData })).find(
      (r) => r.id === 'cost.automation-share'
    );
    expect(rec).toBeDefined();

    // The rule must surface the exact figures the helper computed — same dollar
    // amount and same rounded percentage. If the rule recomputed cost inline
    // and drifted, these substrings would no longer match.
    const usd =
      helper.autoCost > 0 && helper.autoCost < 0.01
        ? `$${helper.autoCost.toFixed(4)}`
        : `$${helper.autoCost.toFixed(2)}`;
    expect(rec?.detail).toContain(usd);
    expect(rec?.detail).toContain(`${helper.share.toFixed(0)}% of total`);
    expect(rec?.savingsAttribution).toBeUndefined();
  });

  it('attaches model-pin before/after attribution when a measurement window is available', () => {
    const tokenData = [
      costingSession('baseline-auto', 'sdk-cli', [
        entry('claude-opus-4-8', 5_000_000, 1_000_000, '2026-05-02T12:00:00Z'),
      ]),
      costingSession('comparison-auto', 'sdk-cli', [
        entry('claude-haiku-4-5', 5_000_000, 1_000_000, '2026-05-09T12:00:00Z'),
      ]),
    ];

    const rec = buildRecommendations(baseInput({
      tokenData,
      modelPinSavings: {
        baseline: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
        comparison: { start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' },
      },
    })).find((r) => r.id === 'cost.automation-share');

    expect(rec).toBeDefined();
    expect(rec?.estSavingsUsd).toBeGreaterThan(0);
    expect(rec?.savingsAttribution).toMatchObject({
      interventionKey: 'cost.automation-share',
      signatureId: 'automation-model-pin',
      tier: 'tier-1-before-after',
      confidence: 'medium',
      predictedSavingsUsd: 0,
      window: {
        baseline: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
        comparison: { start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' },
      },
    });
    expect(rec?.savingsAttribution?.realizedSavingsUsd).toBeGreaterThan(0);
  });

  it('derives model-pin savings data automatically and exposes observed savings on the recommendation', () => {
    const tokenData = [
      costingSession('baseline-auto', 'sdk-cli', [
        entry('claude-opus-4-8', 5_000_000, 1_000_000, '2026-05-02T12:00:00Z'),
      ]),
      costingSession('comparison-auto', 'sdk-cli', [
        entry(CHEAPEST_MODEL, 5_000_000, 1_000_000, '2026-05-09T12:00:00Z'),
      ]),
    ];

    const input = assembleRecommendationInput(baseInput({ tokenData }));
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'cost.automation-share'
    );

    expect(input.modelPinSavings).toMatchObject({
      baseline: {
        start: '2026-05-02T12:00:00.000Z',
        end: '2026-05-09T12:00:00.000Z',
      },
      comparison: {
        start: '2026-05-09T12:00:00.000Z',
        end: '2026-05-09T12:00:00.001Z',
      },
      targetModel: CHEAPEST_MODEL,
    });
    expect(rec?.savingsAttribution?.realizedSavingsUsd).toBeGreaterThan(0);
  });

  it('preserves explicit null model-pin savings as an opt-out from derivation', () => {
    const tokenData = [
      costingSession('baseline-auto', 'sdk-cli', [
        entry('claude-opus-4-8', 5_000_000, 1_000_000, '2026-05-02T12:00:00Z'),
      ]),
      costingSession('comparison-auto', 'sdk-cli', [
        entry(CHEAPEST_MODEL, 5_000_000, 1_000_000, '2026-05-09T12:00:00Z'),
      ]),
    ];

    const input = assembleRecommendationInput(
      baseInput({ tokenData, modelPinSavings: null })
    );
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'cost.automation-share'
    );

    expect(input.modelPinSavings).toBeNull();
    expect(rec?.savingsAttribution).toBeUndefined();
  });

  it('keeps measured model-pin wins visible after Haiku is already pinned', () => {
    const tokenData = [
      costingSession('baseline-auto', 'sdk-cli', [
        entry('claude-opus-4-8', 5_000_000, 1_000_000, '2026-05-02T12:00:00Z'),
      ]),
      costingSession('comparison-auto', 'sdk-cli', [
        entry(CHEAPEST_MODEL, 5_000_000, 1_000_000, '2026-05-09T12:00:00Z'),
      ]),
    ];
    const input = assembleRecommendationInput(
      baseInput({
        tokenData,
        liveConfig: liveConfigShell({ settings: { model: 'claude-haiku-4-5' } }),
      })
    );
    const rec = buildRecommendations(input).find(
      (r) => r.id === 'cost.automation-share'
    );

    expect(rec).toBeDefined();
    expect(rec?.savingsAttribution?.realizedSavingsUsd).toBeGreaterThan(0);
    expect(rec?.action).toContain('observed before/after savings');
    expect(rec?.fix).toBeUndefined();
  });

  it('keeps automation-share estimate-only when the measurement window is insufficient', () => {
    const tokenData = [
      costingSession('baseline-auto', 'sdk-cli', [
        entry('claude-opus-4-8', 5_000_000, 1_000_000, '2026-05-02T12:00:00Z'),
      ]),
    ];

    const rec = buildRecommendations(baseInput({
      tokenData,
      modelPinSavings: {
        baseline: { start: '2026-05-01T00:00:00Z', end: '2026-05-08T00:00:00Z' },
        comparison: { start: '2026-05-08T00:00:00Z', end: '2026-05-15T00:00:00Z' },
      },
    })).find((r) => r.id === 'cost.automation-share');

    expect(rec).toBeDefined();
    expect(rec?.savingsAttribution).toBeUndefined();
  });
});

describe('recommendation savings attribution contract (#858)', () => {
  it('keeps calibration metadata separate from the ranking savings value', () => {
    const attribution: RecommendationSavingsAttribution = {
      interventionKey: 'cost.automation-share',
      signatureId: 'automation-model-pin',
      tier: 'tier-1-before-after',
      predictedSavingsUsd: 12,
      realizedSavingsUsd: 8,
      confidence: 'medium',
      window: {
        baseline: { start: '2026-05-01', end: '2026-05-08' },
        comparison: { start: '2026-05-08', end: '2026-05-15' },
      },
    };

    const rec: Recommendation = {
      id: 'cost.automation-share',
      category: 'cost',
      severity: 'info',
      title: 'Automation drives a large share of spend',
      detail: 'Measured savings are attached as metadata.',
      action: 'Keep automation on the cheapest model that meets the quality bar.',
      estSavingsUsd: 12,
      savingsAttribution: attribution,
    };

    expect(rec.savingsAttribution?.tier).toBe('tier-1-before-after');
    expect(rec.savingsAttribution?.realizedSavingsUsd).toBe(8);
    expect(totalEstimatedSavings([rec])).toBe(12);
  });
});

describe('per-project recommendation attribution (#330)', () => {
  // sessionIds chosen so short() (first 8 chars) is the readable prefix below.
  const sessions = [
    { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', project: '/repo/alpha' },
    { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', project: '/repo/beta' },
    { sessionId: 'cccccccc-1111-2222-3333-444444444444', project: '/repo/alpha' },
  ];

  const rec = (id: string, evidence: string[]): Recommendation => ({
    id,
    category: 'cost',
    severity: 'medium',
    title: id,
    detail: '',
    action: '',
    evidence,
  });

  it('indexes short(sessionId) → project', () => {
    const index = buildSessionProjectIndex(sessions);
    expect(index.get('aaaaaaaa')).toBe('/repo/alpha');
    expect(index.get('bbbbbbbb')).toBe('/repo/beta');
    expect(index.size).toBe(3);
  });

  it('derives a rec\'s projects from the session-ids leading its evidence', () => {
    const index = buildSessionProjectIndex(sessions);
    // Evidence rows mirror the engine's `${short(id)}, …` formatting.
    const r = rec('cost.x', ['aaaaaaaa, $0.42, Bash', 'cccccccc, $0.10, Read']);
    expect(recommendationProjects(r, index)).toEqual(['/repo/alpha']);

    const mixed = rec('cost.y', ['bbbbbbbb, $1.00', 'aaaaaaaa, $0.05']);
    expect(recommendationProjects(mixed, index)).toEqual(['/repo/beta', '/repo/alpha']);
  });

  it('ignores evidence rows that are not session-ids', () => {
    const index = buildSessionProjectIndex(sessions);
    // Permission/tool-category rows (no leading session-id) resolve to nothing.
    const r = rec('perm.z', ['Bash  ⊂  deny Bash(rm)', 'Edit → Write: 4×']);
    expect(recommendationProjects(r, index)).toEqual([]);
  });

  it('filters recs to the requested project and populates projects', () => {
    const recs = [
      rec('alpha-only', ['aaaaaaaa, $0.42']),
      rec('beta-only', ['bbbbbbbb, $1.00']),
      rec('unattributable', ['Bash  ⊂  deny Bash(rm)']),
    ];
    const alpha = filterRecommendationsByProject(recs, '/repo/alpha', sessions);
    expect(alpha.map((r) => r.id)).toEqual(['alpha-only']);
    expect(alpha[0].projects).toEqual(['/repo/alpha']);

    // A rec touching multiple projects shows up under each.
    const shared = [rec('shared', ['aaaaaaaa, $0.42', 'bbbbbbbb, $1.00'])];
    expect(filterRecommendationsByProject(shared, '/repo/alpha', sessions)).toHaveLength(1);
    expect(filterRecommendationsByProject(shared, '/repo/beta', sessions)).toHaveLength(1);

    // Unattributable / non-matching recs are dropped.
    expect(filterRecommendationsByProject(recs, '/repo/gamma', sessions)).toEqual([]);
  });
});

describe('assembleRecommendationInput (#411/#468 — single data-source seam)', () => {
  it('passes through the additional parsed signals and normalises optional config', async () => {
    const { assembleRecommendationInput } = await import('./recommendations');
    const timelines = [{ sessionId: 's1' }] as unknown as RecommendationInput['timelines'];
    const runtimeEvents = [{ sessionId: 's1' }] as unknown as RecommendationInput['runtimeEvents'];
    const taskSteering = [{ sessionId: 's1' }] as unknown as RecommendationInput['taskSteering'];
    const churnGeometry = [{ sessionId: 's1' }] as unknown as RecommendationInput['churnGeometry'];
    const taskSuccess = [{ sessionId: 's1' }] as unknown as RecommendationInput['taskSuccess'];
    const toolInventories = [{ sessionId: 's1' }] as unknown as RecommendationInput['toolInventories'];
    const promptAnalysis = [{ sessionId: 's1', promptTurnCount: 1, lowSpecificityTurnCount: 0 }] as unknown as RecommendationInput['promptAnalysis'];
    const externalGuidance = [{ id: 'g1' }] as unknown as RecommendationInput['externalGuidance'];
    const mapped = assembleRecommendationInput({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      // liveConfig/assistantFeatures intentionally omitted → normalise to null.
      timelines,
      runtimeEvents,
      taskSteering,
      churnGeometry,
      taskSuccess,
      toolInventories,
      promptAnalysis,
      externalGuidance,
    });
    expect(mapped.timelines).toBe(timelines);
    expect(mapped.runtimeEvents).toBe(runtimeEvents);
    expect(mapped.taskSteering).toBe(taskSteering);
    expect(mapped.churnGeometry).toBe(churnGeometry);
    expect(mapped.taskSuccess).toBe(taskSuccess);
    expect(mapped.toolInventories).toBe(toolInventories);
    expect(mapped.promptAnalysis).toBe(promptAnalysis);
    expect(mapped.externalGuidance).toBe(externalGuidance);
    expect(mapped.liveConfig).toBeNull();
    expect(mapped.assistantFeatures).toBeNull();
    // The engine runs on a clean (well-formed, empty) mapped input without error.
    const clean = assembleRecommendationInput({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    });
    expect(Array.isArray(buildRecommendations(clean, 0))).toBe(true);
    expect(clean.promptAnalysis).toBeNull();
  });

  it('(#524 slice 3) flows an arbitrary new field through automatically (spread, not a hand-listed mapper)', async () => {
    const { assembleRecommendationInput } = await import('./recommendations');
    const probe = [{ k: 'v' }];
    const mapped = assembleRecommendationInput({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
      // A field the mapper does NOT list explicitly — under the slice-3 spread it
      // must still flow through, which is what lets a new detector-consumed signal
      // reach the engine with only a descriptor + a RecommendationInput type field.
      futureSignal: probe,
    } as unknown as RecommendationInput);
    expect((mapped as unknown as Record<string, unknown>).futureSignal).toBe(probe);
  });

  it('(#524 slice 3) signal datasetKeys + non-signal fields cover exactly the RecommendationInput keys', async () => {
    const { makeSessionSignals } = await import('./signals');
    const noop = () => undefined;
    const signals = makeSessionSignals({
      parseSessionJsonl: noop,
      parseToolUsage: noop,
      parseSessionTimeline: noop,
      parseApiErrors: noop,
      parsePermissionData: noop,
      parseAgentSettings: noop,
      parseAttribution: noop,
      parseRuntimeEvents: noop,
      parseChurnGeometry: noop,
      parseToolInventory: noop,
      parseAssistantFeatures: noop,
      parseDeceitSignals: noop,
      parseTaskSuccess: noop,
      deriveEntries: noop,
    } as unknown as Parameters<typeof makeSessionSignals>[0]);
    // The ingest caller builds RecommendationInput from the signal datasetKeys
    // plus these non-signal fields (sessions/projects derived from entries,
    // permissionRows from the perm fan-out, liveConfig/modelPinSavings assembled
    // apart).
    const covered = new Set([
      ...signals.map((s) => s.datasetKey).filter(Boolean),
      'sessions',
      'projects',
      'permissionRows',
      'liveConfig',
      'modelPinSavings',
      'repoMap',
      'taskSteering',
      'externalGuidance',
    ]);
    const EXPECTED = [
      'tokenData',
      'toolData',
      'sessions',
      'projects',
      'permissionRows',
      'apiErrors',
      'liveConfig',
      'assistantFeatures',
      'deceitSignals',
      'timelines',
      'agentSettings',
      'attribution',
      'runtimeEvents',
      'taskSteering',
      'churnGeometry',
      'taskSuccess',
      'toolInventories',
      'modelPinSavings',
      'repoMap',
      'externalGuidance',
    ];
    expect([...covered].sort()).toEqual([...EXPECTED].sort());
  });
});

describe('workflow.prompt-clarity (#1275)', () => {
  const promptRow = (
    sessionId: string,
    lowSpecificityTurnCount: number
  ): NonNullable<RecommendationInput['promptAnalysis']>[number] => ({
    sessionId,
    promptTurnCount: 1,
    lowSpecificityTurnCount,
    specificityMarkerCount: lowSpecificityTurnCount > 0 ? 0 : 2,
  });

  const timeline = (sessionId: string, userTurns: number): SessionTimeline =>
    ({
      sessionId,
      startTime: '2026-01-01T00:00:00Z',
      endTime: '2026-01-01T00:01:00Z',
      entries: Array.from({ length: userTurns }, (_, i) => ({
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
        kind: 'user',
        summary: `turn ${i}`,
      })),
    }) as SessionTimeline;

  const find = (input: RecommendationInput) =>
    buildRecommendations(input, 0).filter(
      (rec) => rec.id === 'workflow.prompt-clarity'
    );

  it('stays silent below the minimum sample size', () => {
    const sessionIds = ['low-a', 'low-b', 'specific-a', 'specific-b', 'specific-c'];
    const recs = find(
      baseInput({
        promptAnalysis: [
          promptRow('low-a', 1),
          promptRow('low-b', 1),
          promptRow('specific-a', 0),
          promptRow('specific-b', 0),
          promptRow('specific-c', 0),
        ],
        timelines: sessionIds.map((id) =>
          timeline(id, id.startsWith('low') ? 5 : 1)
        ),
      })
    );
    expect(recs).toEqual([]);
  });

  it('emits one correlational finding when low-specificity prompts co-occur with high follow-up density', () => {
    const low = ['low-a', 'low-b', 'low-c'];
    const specific = ['specific-a', 'specific-b', 'specific-c'];
    const recs = find(
      baseInput({
        promptAnalysis: [
          ...low.map((id) => promptRow(id, 1)),
          ...specific.map((id) => promptRow(id, 0)),
        ],
        timelines: [
          ...low.map((id) => timeline(id, 5)),
          ...specific.map((id) => timeline(id, 1)),
        ],
      })
    );

    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('workflow.prompt-clarity');
    expect(recs[0].severity).toBe('info');
    expect(recs[0].detail).toMatch(/correlation, not causation/i);
    expect(recs[0].detail).toContain('patterns worth noticing');
  });
});

describe('security.model-deceit (#686, epic #683 slice B)', () => {
  const deceit = (over: Record<string, unknown>) =>
    ({
      sessionId: 's1',
      assistantTurnCount: 12,
      unbackedClaimCount: 0,
      contradictedClaimCount: 0,
      claimSnippets: [],
      ...over,
    }) as unknown as NonNullable<RecommendationInput['deceitSignals']>[number];

  const find = (input: RecommendationInput) =>
    buildRecommendations(input, 0).find((r) => r.id === 'security.model-deceit');

  it('fires (warning) on a contradicted success claim, in the security category', () => {
    const rec = find(
      baseInput({
        deceitSignals: [
          deceit({ contradictedClaimCount: 1, claimSnippets: ['all tests pass'] }),
        ],
      })
    );
    expect(rec).toBeDefined();
    expect(rec?.category).toBe('security');
    expect(rec?.severity).toBe('warning');
    expect(rec?.evidence?.[0]).toContain('all tests pass');
  });

  it('fires (info) on an unbacked action claim only', () => {
    const rec = find(
      baseInput({
        deceitSignals: [
          deceit({ unbackedClaimCount: 2, claimSnippets: ['I ran the suite'] }),
        ],
      })
    );
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe('info');
    expect(rec?.affected).toBe(2);
  });

  // The four honest classes all reduce to zero counts at the detector boundary
  // (the ingest parser, #685, excludes scoped-disclosure / stale-but-true /
  // real-background-completion before they ever reach here), plus the empty
  // (SPA) dataset — none may fire.
  it('stays dark on the honest fixtures and the empty dataset', () => {
    // scoped-disclosure, stale-but-true, background-completion → parser zeroes them
    expect(find(baseInput({ deceitSignals: [deceit({})] }))).toBeUndefined();
    // a session with turns but zero flagged claims
    expect(
      find(baseInput({ deceitSignals: [deceit({ sessionId: 'clean', assistantTurnCount: 30 })] }))
    ).toBeUndefined();
    // no deceit signals at all (transcript-free SPA dataset)
    expect(find(baseInput({ deceitSignals: [] }))).toBeUndefined();
    expect(find(baseInput({}))).toBeUndefined();
  });

  it('does not flag a count carried on a session with no assistant turns', () => {
    const rec = find(
      baseInput({
        deceitSignals: [deceit({ assistantTurnCount: 0, contradictedClaimCount: 3 })],
      })
    );
    expect(rec).toBeUndefined();
  });
});

describe('speed.hook-overhead (#710, epic #708 — the clock, ADR 0006)', () => {
  // n stop events, each carrying `overheadMs` of measured per-turn hook time.
  const slowStops = (n: number, overheadMs: number) =>
    [
      {
        sessionId: 's1',
        turns: [],
        stopHooks: Array.from({ length: n }, () => ({
          sessionId: 's1',
          timestamp: 't',
          hookCount: 1,
          totalDurationMs: overheadMs,
          hadErrors: false,
          preventedContinuation: false,
        })),
        awaySummaries: [],
        scheduledFires: [],
      },
    ] as unknown as RecommendationInput['runtimeEvents'];

  const find = (input: RecommendationInput) =>
    buildRecommendations(input, 0).find((r) => r.id === 'speed.hook-overhead');

  it('fires (warning) on heavy per-turn overhead, in the speed category, with an actionable fix', () => {
    const rec = find(baseInput({ runtimeEvents: slowStops(5, 6000) }));
    expect(rec).toBeDefined();
    expect(rec?.category).toBe('speed');
    expect(rec?.severity).toBe('warning');
    expect(rec?.view).toBe('agents');
    expect(rec?.fix?.target).toBe('hook');
    expect(rec?.fix?.snippet).toContain('"Stop"');
  });

  it('fires (info) on a meaningful-but-not-heavy overhead', () => {
    // 3s mean per turn: above the 2s meaningful bar, below the 5s heavy bar.
    const rec = find(baseInput({ runtimeEvents: slowStops(6, 3000) }));
    expect(rec).toBeDefined();
    expect(rec?.severity).toBe('info');
  });

  it('stays dark below the meaningful threshold, below the min sample, and on the empty dataset', () => {
    // overhead under 2s → not worth surfacing
    expect(find(baseInput({ runtimeEvents: slowStops(8, 1500) }))).toBeUndefined();
    // heavy overhead but only 4 timed events → below MIN_TIMED_EVENTS
    expect(find(baseInput({ runtimeEvents: slowStops(4, 6000) }))).toBeUndefined();
    // hooks ran but none carried a measured duration (the ~93% untimed case)
    expect(find(baseInput({ runtimeEvents: slowStops(20, 0) }))).toBeUndefined();
    // transcript-free SPA dataset
    expect(find(baseInput({ runtimeEvents: [] }))).toBeUndefined();
    expect(find(baseInput({}))).toBeUndefined();
  });
});

// ── each-fires coverage bank (#507) ──────────────────────────────────────
// One curated `RecommendationInput` per detector (some cover several at once),
// reusing the same fixture shapes the per-detector co-located tests use. The
// registry self-test asserts EVERY registered detector fires on at least one
// of these, so the bank is provably exhaustive over the catalog.
type Fixture = { input: RecommendationInput; now: number };

function bankBase(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return baseInput(over);
}

/**
 * A complete `liveConfig` shell — every array field present so detectors that
 * iterate them (e.g. unused-installed-skills → computeConfigHygiene over
 * `lc.skills`) don't throw when run against a fixture aimed at a different
 * detector. Pass the fields the fixture actually exercises; the rest default to
 * empty/null.
 */
function liveConfigShell(
  over: Record<string, unknown> = {}
): NonNullable<RecommendationInput['liveConfig']> {
  return {
    settings: {},
    settingsHealth: null,
    claudeMd: { global: null, perProject: {} },
    plugins: [],
    mcpServers: [],
    skills: [],
    subagents: [],
    commands: [],
    ...over,
  } as unknown as NonNullable<RecommendationInput['liveConfig']>;
}

const richEntry = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  extra: Record<string, number> = {}
) =>
  ({
    timestamp: 't',
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    ...extra,
  }) as never;

const richSession = (
  sessionId: string,
  entrypoint: string | undefined,
  entries: unknown[],
  extra: Record<string, unknown> = {}
): SessionTokenData =>
  ({
    sessionId,
    entrypoint,
    totalOutputTokens: 5000,
    entries,
    compactionEvents: [],
    ...extra,
  }) as unknown as SessionTokenData;

function fixtureBank(): Fixture[] {
  const out: Fixture[] = [];
  const now = 1_780_100_000_000;

  // ── Broad legacy spread (covers most of the 20 ported rules at once) ────
  const stale = now - 6 * 7 * 24 * 60 * 60 * 1000;
  const editChurn: ToolCall[] = [];
  for (let i = 0; i < 18; i++) {
    editChurn.push({
      timestamp: 't',
      toolName: 'Edit',
      input: { file_path: '/repo/x/churn.ts' },
      toolUseId: 'u',
      isError: false,
      resultBytes: 0,
    });
  }
  const erroringReads: ToolCall[] = [];
  for (let i = 0; i < 8; i++) {
    erroringReads.push({
      timestamp: 't',
      toolName: 'Read',
      input: { file_path: '/repo/x/missing.ts' },
      toolUseId: 'u',
      isError: i < 6,
      resultBytes: 0,
    });
  }
  const retryStorm: ToolCall[] = [];
  for (let i = 0; i < 6; i++) {
    retryStorm.push({
      timestamp: 't',
      toolName: 'Grep',
      input: { pattern: 'foo' } as unknown as { command?: string },
      toolUseId: 'u',
      isError: true,
      resultBytes: 0,
    });
  }
  const automationSession: ToolUsageData = {
    sessionId: 'automate',
    calls: [
      call('grep -r foo .'),
      call('grep -r bar .'),
      call('grep -r baz .'),
      call('find . -name "*.ts"'),
      call('find . -name "*.js"'),
      call('cat package.json'),
      call('cat tsconfig.json'),
      call('cat README.md'),
      call('grep -r qux .'),
      call('find . -name "*.json"'),
      call('grep -r quux .'),
      call('cat src/index.ts'),
      call('npm run build'),
      call('npm run build'),
      call('npm run build'),
      call('npm run build'),
      call('rm -rf /tmp/scratch'),
      call('git reset --hard HEAD'),
      ...editChurn,
      ...erroringReads,
      ...retryStorm,
    ],
  };
  const readSession: ToolUsageData = {
    sessionId: 'reader',
    calls: [
      { timestamp: 't', toolName: 'Read', input: { file_path: '/repo/x/conf.ts' }, toolUseId: 'u', isError: false, resultBytes: 0 },
      { timestamp: 't', toolName: 'Read', input: { file_path: '/repo/x/conf.ts' }, toolUseId: 'u', isError: false, resultBytes: 0 },
      { timestamp: 't', toolName: 'Read', input: { file_path: '/repo/x/conf.ts' }, toolUseId: 'u', isError: false, resultBytes: 0 },
      { timestamp: 't', toolName: 'Read', input: { file_path: '/repo/x/conf.ts' }, toolUseId: 'u', isError: false, resultBytes: 0 },
    ],
  };
  out.push({
    now,
    input: bankBase({
      tokenData: [
        richSession('automate', 'sdk-cli', [
          richEntry('claude-opus-4-8', 6_000_000, 1_200_000, {
            cacheCreationTokens: 4_000_000,
            cacheCreation1hTokens: 4_000_000,
          }),
        ]),
        richSession('reader', 'cli', [richEntry('claude-opus-4-8', 1_000_000, 200_000)]),
        richSession('mystery', 'cli', [richEntry('some-unknown-model', 500_000, 100_000)], {
          hasUnknownModel: true,
        }),
        richSession('extra1', 'cli', [richEntry('claude-opus-4-8', 100_000, 20_000)]),
        richSession('extra2', 'cli', [richEntry('claude-opus-4-8', 100_000, 20_000)]),
      ],
      toolData: [automationSession, readSession],
      projects: [
        {
          project: '/repo/stale',
          projectShort: 'stale',
          sessionCount: 5,
          messageCount: 100,
          firstSeen: 0,
          lastSeen: stale,
          sessions: [],
        } as unknown as RecommendationInput['projects'][number],
      ],
      permissionRows: [{ mode: 'bypassPermissions', sessionId: 'automate' }],
      apiErrors: [
        { sessionId: 'automate', status: 429, timestamp: 't', summary: 'rate limited' },
        { sessionId: 'automate', status: 500, timestamp: 't', summary: 'server error' },
      ] as unknown as RecommendationInput['apiErrors'],
      liveConfig: liveConfigShell({
        settings: {
          permissions: {
            allow: ['Bash(npm test:*)'],
            deny: ['Bash(npm test:*)', 'Bash(yarn install:*)'],
          },
        },
      }),
      assistantFeatures: [
        {
          sessionId: 'automate',
          assistantTurnCount: 100,
          textLength: 0,
          codeBlockCount: 0,
          toolCallCount: 0,
          refusalCount: 30,
          hedgingCount: 0,
          endsWithQuestionCount: 0,
          thinkingByteLen: 0,
        },
      ],
    }),
  });

  // ── context.low-cache-hit + context.low-health ─────────────────────────
  // Session-level cache totals give hitRate = 1k / (1k + 100k) ≈ 1% (< 50%),
  // and a 250K peak context spills past the window — low score + low cache hit.
  out.push({
    now,
    input: bankBase({
      tokenData: [
        richSession('lc', 'cli', [richEntry('claude-sonnet-4-6', 250_000, 5_000)], {
          totalCacheReadTokens: 1_000,
          totalCacheCreationTokens: 100_000,
        }),
      ],
    }),
  });

  // ── reliability.retry-storms (4+ back-to-back same-tool calls with errors) ─
  {
    const grep = (i: number): ToolCall =>
      ({
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
        toolName: 'Grep',
        input: { pattern: 'foo' } as unknown as { command?: string },
        toolUseId: `g${i}`,
        isError: true,
        resultBytes: 0,
      });
    out.push({
      now,
      input: bankBase({
        toolData: [{ sessionId: 'rs', calls: [grep(0), grep(1), grep(2), grep(3), grep(4)] }],
      }),
    });
  }

  // ── reliability.retry-prefix-rewaste (#950): an errored retry group with a ─
  // priced cache-read token entry inside its [start,end] window.
  {
    const tBase = '2026-02-01T00:00:0';
    const erroredCall = (i: number): ToolCall =>
      ({
        timestamp: `${tBase}${i}Z`,
        toolName: 'Bash',
        input: { command: 'flaky' } as unknown as { command?: string },
        toolUseId: `rpw${i}`,
        isError: true,
        resultBytes: 0,
      });
    const tokenEntry = {
      timestamp: `${tBase}1Z`,
      model: 'claude-opus-4-7',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 2_000_000,
      webSearchRequests: 0,
      webFetchRequests: 0,
    };
    out.push({
      now,
      input: bankBase({
        toolData: [{ sessionId: 'rpw', calls: [erroredCall(0), erroredCall(2)] }],
        tokenData: [richSession('rpw', 'cli', [tokenEntry], { model: 'claude-opus-4-7' })],
      }),
    });
  }

  // ── reliability.overload-reretry (#950): a 529 with retryAttempt>1 and a ───
  // priced cache-read entry within the event window.
  {
    const t = '2026-02-02T00:00:00Z';
    const tokenEntry = {
      timestamp: t,
      model: 'claude-opus-4-7',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 2_000_000,
      webSearchRequests: 0,
      webFetchRequests: 0,
    };
    out.push({
      now,
      input: bankBase({
        apiErrors: [
          { sessionId: 'orr', status: 529, retryAttempt: 3, timestamp: t, summary: 'overloaded', source: 'native' },
        ] as unknown as RecommendationInput['apiErrors'],
        tokenData: [richSession('orr', 'cli', [tokenEntry], { model: 'claude-opus-4-7' })],
      }),
    });
  }

  // ── safety.prompt-friction (one tool dominates prompt-eligible calls) ───
  {
    const friction: ToolCall[] = [];
    for (let i = 0; i < 30; i++) friction.push(call(`echo step-${i}`));
    out.push({
      now,
      input: bankBase({
        toolData: [{ sessionId: 'pf', calls: friction }],
        permissionRows: Array.from({ length: 30 }, () => ({ mode: 'default', sessionId: 'pf' })),
      }),
    });
  }

  // ── workflow.correction-mining (#1040): a failed Read then the fixed Read ─
  out.push({
    now,
    input: bankBase({
      toolData: [
        {
          sessionId: 'cm',
          calls: [
            { timestamp: 't1', toolName: 'Read', input: { file_path: 'src/FirstClassEntity.java' }, toolUseId: 'cm1', isError: true, resultBytes: 0 },
            { timestamp: 't2', toolName: 'Read', input: { file_path: 'lib/FirstClassEntity.scala' }, toolUseId: 'cm2', isError: false, resultBytes: 10 },
          ],
        },
      ],
    }),
  });

  // ── context.bloated-claude-md (oversized merged global CLAUDE.md) ───────
  out.push({
    now,
    input: bankBase({
      liveConfig: liveConfigShell({
        claudeMd: { global: Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n'), perProject: {} },
      }),
    }),
  });

  // ── cost.legacy-model-overpay ──────────────────────────────────────────
  out.push({
    now,
    input: bankBase({
      tokenData: [richSession('lg', 'cli', [richEntry('claude-opus-4-1-20250414', 1_000_000, 0)], { hasUnknownModel: false })],
    }),
  });

  // ── cost.model-routing-rollup (24 trivial Opus turns → route to Haiku, #1165)
  {
    const mkTs = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const tokenEntries = Array.from({ length: 24 }, (_, i) => ({
      timestamp: mkTs(i),
      inputTokens: 200_000,
      outputTokens: 900,
      cacheCreationTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      model: 'claude-opus-4-8',
    }));
    const tlEntries = Array.from({ length: 24 }, (_, i) => ({
      timestamp: mkTs(i),
      kind: 'user',
      summary: 'fix a typo',
    }));
    out.push({
      now,
      input: bankBase({
        tokenData: [
          {
            sessionId: 'mrr',
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheCreationTokens: 0,
            totalCacheReadTokens: 0,
            model: 'claude-opus-4-8',
            messageCount: tokenEntries.length,
            entries: tokenEntries,
            compactionEvents: [],
            hasUnknownModel: false,
          },
        ] as unknown as RecommendationInput['tokenData'],
        timelines: [
          { sessionId: 'mrr', startTime: mkTs(0), endTime: mkTs(23), entries: tlEntries },
        ] as unknown as RecommendationInput['timelines'],
        attribution: [],
      }),
    });
  }

  // ── cost.web-search-spend (60 searches × $0.01 over near-zero spend) ────
  out.push({
    now,
    input: bankBase({
      tokenData: [
        richSession('ws', 'cli', [richEntry('claude-haiku-4-5-20251001', 1000, 0, { webSearchRequests: 60 })], {
          model: 'claude-haiku-4-5-20251001',
        }),
      ],
    }),
  });

  // ── cost.priority-tier-spend ───────────────────────────────────────────
  out.push({
    now,
    input: bankBase({
      tokenData: [
        richSession('p1', 'cli', [], { serviceTier: 'priority' }),
        richSession('p2', 'cli', [], { serviceTier: 'priority' }),
        richSession('p3', 'cli', [], { serviceTier: 'priority' }),
      ],
    }),
  });

  // ── context.compaction-hot-sessions + context.repeated-compactions ─────
  {
    const hot = (id: string): SessionTokenData =>
      ({
        sessionId: id,
        totalOutputTokens: 5000,
        entries: [richEntry('claude-sonnet-4-6', 180_000, 5_000)],
        compactionEvents: [{}, {}],
      }) as unknown as SessionTokenData;
    out.push({ now, input: bankBase({ tokenData: [hot('h1'), hot('h2')], timelines: [] }) });
  }

  // ── context.compaction-large-tool-outputs ──────────────────────────────
  {
    const sess = (id: string): SessionTokenData =>
      ({
        sessionId: id,
        totalOutputTokens: 5000,
        entries: [richEntry('claude-sonnet-4-6', 140_000, 5_000)],
        compactionEvents: [],
      }) as unknown as SessionTokenData;
    const bigRead = (i: number): ToolCall =>
      ({ timestamp: `2026-01-01T00:00:0${i}Z`, toolName: 'Read', input: { file_path: `/f${i}` } as unknown as { command?: string }, toolUseId: `r${i}`, isError: null, resultBytes: 50_000 });
    const ids = ['c1', 'c2', 'c3'];
    out.push({
      now,
      input: bankBase({
        tokenData: ids.map(sess),
        toolData: ids.map((id) => ({ sessionId: id, calls: [0, 1, 2, 3].map(bigRead) })),
        timelines: [],
      }),
    });
  }

  // ── cost.idle-mcp-tools ────────────────────────────────────────────────
  {
    const inv = (sessionId: string) =>
      ({ sessionId, toolsAvailable: ['mcp__foo__bar', 'Bash'], toolsUsed: ['Bash'], unusedTools: [], utilizationPct: 0 }) as unknown as NonNullable<RecommendationInput['toolInventories']>[number];
    out.push({ now, input: bankBase({ toolInventories: [inv('s1'), inv('s2'), inv('s3')] }) });
  }

  // ── cost.expensive-agent-type ──────────────────────────────────────────
  {
    const taskCall = (i: number): ToolCall =>
      ({ timestamp: `2026-01-01T00:00:0${i}Z`, toolName: 'Task', input: { subagent_type: 'researcher' } as unknown as { command?: string }, toolUseId: `u${i}`, isError: null, resultBytes: 0 });
    out.push({
      now,
      input: bankBase({
        toolData: [{ sessionId: 'a1', calls: Array.from({ length: 5 }, (_, i) => taskCall(i)) }],
        attribution: [
          { sessionId: 'a1', agents: { researcher: { invocations: 5, outputTokens: 100_000 } }, skills: {}, mcpServers: {}, mcpTools: {} },
        ] as unknown as RecommendationInput['attribution'],
        agentSettings: [],
        runtimeEvents: [],
        tokenData: [
          ({
            sessionId: 'a1',
            totalOutputTokens: 100_000,
            entries: [richEntry('claude-opus-4-7', 200_000, 100_000)],
            compactionEvents: [],
          }) as unknown as SessionTokenData,
        ],
      }),
    });
  }

  // ── reliability.settings-json-invalid ──────────────────────────────────
  out.push({
    now,
    input: bankBase({
      liveConfig: liveConfigShell({
        settingsHealth: {
          filePath: '~/.claude/settings.json',
          present: true,
          ok: false,
          findings: [{ kind: 'type', severity: 'error', path: 'model', message: 'expected string' }],
        },
      }),
    }),
  });

  // ── reliability.hook-errors ────────────────────────────────────────────
  {
    const stopHook = () => ({ sessionId: 's1', timestamp: 't', hookCount: 1, totalDurationMs: 0, hadErrors: true, preventedContinuation: false });
    out.push({
      now,
      input: bankBase({
        runtimeEvents: [
          { sessionId: 's1', turns: [], stopHooks: [stopHook(), stopHook(), stopHook()], awaySummaries: [], scheduledFires: [] },
        ] as unknown as RecommendationInput['runtimeEvents'],
      }),
    });
  }

  // ── reliability.hook-prevented-continuation ────────────────────────────
  {
    const stopHook = () => ({ sessionId: 's1', timestamp: 't', hookCount: 1, totalDurationMs: 0, hadErrors: false, preventedContinuation: true });
    out.push({
      now,
      input: bankBase({
        runtimeEvents: [
          { sessionId: 's1', turns: [], stopHooks: Array.from({ length: 5 }, stopHook), awaySummaries: [], scheduledFires: [] },
        ] as unknown as RecommendationInput['runtimeEvents'],
      }),
    });
  }

  // ── speed.hook-overhead (#710): 5 timed stop events, ~6s mean per-turn ─────
  {
    const slowStop = () => ({ sessionId: 's1', timestamp: 't', hookCount: 1, totalDurationMs: 6000, hadErrors: false, preventedContinuation: false });
    out.push({
      now,
      input: bankBase({
        runtimeEvents: [
          { sessionId: 's1', turns: [], stopHooks: Array.from({ length: 5 }, slowStop), awaySummaries: [], scheduledFires: [] },
        ] as unknown as RecommendationInput['runtimeEvents'],
      }),
    });
  }

  // ── speed.time-motion (#596): idle split + serial read-like tool gaps ───
  {
    const minute = 60 * 1000;
    const ts = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m, 0)).toISOString();
    out.push({
      now,
      input: bankBase({
        runtimeEvents: [
          {
            sessionId: 'tm',
            turns: [
              { sessionId: 'tm', timestamp: ts(1), durationMs: 12 * minute, messageCount: 4 },
              { sessionId: 'tm', timestamp: ts(20), durationMs: 16 * minute, messageCount: 1 },
              { sessionId: 'tm', timestamp: ts(50), durationMs: 8 * minute, messageCount: 3 },
            ],
            stopHooks: [],
            awaySummaries: [
              { sessionId: 'tm', timestamp: ts(21), content: 'AFK recap: resumed.' },
            ],
            scheduledFires: [],
          },
        ],
        timelines: [
          {
            sessionId: 'tm',
            startTime: ts(0),
            endTime: ts(80),
            entries: [
              { timestamp: ts(3), kind: 'tool_use', summary: '{}', toolName: 'Read' },
              { timestamp: ts(12), kind: 'tool_result', summary: 'file contents', isError: false },
              { timestamp: ts(13), kind: 'tool_use', summary: '{}', toolName: 'Grep' },
              { timestamp: ts(21), kind: 'tool_result', summary: 'matches', isError: false },
              { timestamp: ts(22), kind: 'tool_use', summary: '{}', toolName: 'Glob' },
              { timestamp: ts(29), kind: 'tool_result', summary: 'paths', isError: false },
            ],
          },
        ] as unknown as RecommendationInput['timelines'],
      }),
    });
  }

  // ── workflow.low-tool-effectiveness (11 identical Bash, no forward motion) ─
  {
    const calls: ToolCall[] = Array.from({ length: 11 }, (_, i) => ({
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      toolName: 'Bash',
      input: { command: 'npm test' },
      toolUseId: `u${i}`,
      isError: null,
      resultBytes: 0,
    }));
    out.push({ now, input: bankBase({ toolData: [{ sessionId: 'le', calls }], timelines: [] }) });
  }

  // ── workflow.shared-checkout-rework (reflog + cherry-pick recovery, #956) ─
  {
    const cmd = (i: number, command: string): ToolCall => ({
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      toolName: 'Bash',
      input: { command },
      toolUseId: `sc${i}`,
      isError: null,
      resultBytes: 0,
    });
    const calls: ToolCall[] = [
      cmd(0, 'git status'),
      cmd(1, 'git reflog | head -20'),
      cmd(2, 'git cherry-pick 8519e3f'),
    ];
    out.push({ now, input: bankBase({ toolData: [{ sessionId: 'scr', calls }], timelines: [] }) });
  }

  // ── workflow.tool-undo-rate (edits immediately rolled back) ─────────────
  {
    const edit = (i: number, file: string): ToolCall =>
      ({ timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, toolName: 'Edit', input: { file_path: file } as unknown as { command?: string }, toolUseId: `e${i}`, isError: null, resultBytes: 0 });
    const restore = (i: number): ToolCall =>
      ({ timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, toolName: 'Bash', input: { command: 'git restore .' }, toolUseId: `b${i}`, isError: null, resultBytes: 0 });
    const calls: ToolCall[] = [];
    let t = 0;
    calls.push(edit(t++, 'f0'), restore(t++));
    calls.push(edit(t++, 'f1'), restore(t++));
    for (let i = 2; i < 10; i++) calls.push(edit(t++, `f${i}`));
    out.push({ now, input: bankBase({ toolData: [{ sessionId: 'ur', calls }], timelines: [] }) });
  }

  // ── workflow.unused-installed-skills ───────────────────────────────────
  {
    const skill = (id: string) => ({ id, scope: 'user', path: `/home/u/.claude/skills/${id}` });
    out.push({
      now: 1_780_100_000_000,
      input: bankBase({
        sessions: [{ sessionId: 's1', startTime: 1_780_000_000_000 }] as unknown as RecommendationInput['sessions'],
        attribution: [],
        liveConfig: liveConfigShell({
          skills: ['a', 'b', 'c', 'd'].map(skill),
          claudeMd: { global: '' },
        }),
      }),
    });
  }

  // ── safety.config-hygiene-rollup (#1164): unused mcpServers + plugin ────
  {
    out.push({
      now: 1_780_100_000_000,
      input: bankBase({
        sessions: [{ sessionId: 's1', startTime: 1_780_000_000_000 }] as unknown as RecommendationInput['sessions'],
        attribution: [],
        liveConfig: liveConfigShell({
          mcpServers: [
            { id: 'srv-a', scope: 'global' },
            { id: 'srv-b', scope: 'global' },
          ],
          plugins: [{ id: 'plug-a', scope: 'global', bundled: { skills: ['plug-a-skill'], agents: [] } }],
          claudeMd: { global: '' },
        }),
      }),
    });
  }

  // ── workflow.failed-workflow-runs (#635): a run left an agent in error ──
  {
    const failRun = {
      runId: 'wf_fail', workflowName: 'wf', status: 'completed', startTime: 1,
      durationMs: 1, agentCount: 1, totalTokens: 1000, totalToolCalls: 1,
      defaultModel: null, sessionId: 's', phases: [],
      agents: [{
        index: 0, label: null, phaseIndex: null, phaseTitle: null, model: null,
        state: 'error', agentType: null, startedAt: null, durationMs: null,
        tokens: null, toolCalls: null, promptPreview: null, resultPreview: null,
      }],
    };
    out.push({ now, input: bankBase({ workflows: [failRun] as unknown as RecommendationInput['workflows'] }) });
  }

  // ── workflow.runaway-workflow-cost (#635): one run dwarfs the median ────
  {
    const wf = (runId: string, totalTokens: number) => ({
      runId, workflowName: 'wf', status: 'completed', startTime: 1, durationMs: 1,
      agentCount: 4, totalTokens, totalToolCalls: 1, defaultModel: null,
      sessionId: 's', phases: [], agents: [],
    });
    out.push({
      now,
      input: bankBase({
        workflows: [wf('a', 50_000), wf('b', 50_000), wf('c', 60_000), wf('d', 500_000)] as unknown as RecommendationInput['workflows'],
      }),
    });
  }

  // ── workflow.unused-installed-subagents (#633) ─────────────────────────
  {
    const sub = (id: string) => ({ id, scope: 'user', path: `/home/u/.claude/agents/${id}` });
    out.push({
      now: 1_780_100_000_000,
      input: bankBase({
        sessions: [{ sessionId: 's1', startTime: 1_780_000_000_000 }] as unknown as RecommendationInput['sessions'],
        attribution: [],
        liveConfig: liveConfigShell({
          subagents: ['a', 'b', 'c', 'd'].map(sub),
          claudeMd: { global: '' },
        }),
      }),
    });
  }

  // ── workflow.unused-installed-commands (#634) ──────────────────────────
  {
    const cmd = (id: string) => ({ id, scope: 'user', path: `/home/u/.claude/commands/${id}.md` });
    out.push({
      now: 1_780_100_000_000,
      input: bankBase({
        sessions: [{ sessionId: 's1', startTime: 1_780_000_000_000 }] as unknown as RecommendationInput['sessions'],
        attribution: [],
        liveConfig: liveConfigShell({
          commands: ['a', 'b', 'c', 'd'].map(cmd),
          claudeMd: { global: '' },
        }),
      }),
    });
  }

  // workflow.shadow-axis-wins (#513): an axis whose shadow variation wins ≥60%
  // over ≥5 samples, live-confirmed.
  out.push({
    now,
    input: bankBase({
      shadowCalls: {
        total: 6,
        byAxis: [
          {
            axis: 'model',
            samples: 6,
            live: 6,
            replay: 0,
            shadowWins: 5,
            mainWins: 1,
            ties: 0,
            liveShadowWins: 5,
            tokenDeltaSum: -3000,
            tokenDeltaCount: 6,
            costDeltaSum: 0,
            costDeltaCount: 0,
          },
        ],
      },
    }),
  });

  // workflow.uncovered-shadow-axis (#530): an UNCOVERED axis (skills) winning
  // strongly → propose a new rule class.
  out.push({
    now,
    input: bankBase({
      shadowCalls: {
        total: 6,
        byAxis: [
          {
            axis: 'skills',
            samples: 6,
            live: 5,
            replay: 1,
            shadowWins: 5,
            mainWins: 1,
            ties: 0,
            liveShadowWins: 4,
            tokenDeltaSum: -1200,
            tokenDeltaCount: 6,
            costDeltaSum: 0,
            costDeltaCount: 0,
          },
        ],
      },
    }),
  });

  // ── #539 ingest-artifact detectors (#559–#569, #572) ──────────────────────
  const day = 24 * 60 * 60 * 1000;
  const tRec = (over: Record<string, unknown>) => ({
    id: 'x', subject: 's', description: '', activeForm: '', owner: '',
    status: 'pending', blocks: [], blockedBy: [], sessionId: 'sx',
    mtimeMs: now - day, ...over,
  });

  // workflow.abandoned-tasks: a cold session (>=7d idle) still holding open tasks.
  out.push({
    now,
    input: bankBase({
      tasks: [
        tRec({ id: 't1', sessionId: 'cold1', status: 'pending', mtimeMs: now - 9 * day }),
        tRec({ id: 't2', sessionId: 'cold1', status: 'in_progress', mtimeMs: now - 9 * day }),
      ] as unknown as RecommendationInput['tasks'],
    }),
  });

  // workflow.blocked-task-pileup: >=2 open tasks behind an unfinished root.
  out.push({
    now,
    input: bankBase({
      tasks: [
        tRec({ id: 'root', sessionId: 'dag1', subject: 'Retrain model v7', status: 'pending' }),
        tRec({ id: 'a', sessionId: 'dag1', status: 'pending', blockedBy: ['root'] }),
        tRec({ id: 'b', sessionId: 'dag1', status: 'pending', blockedBy: ['root'] }),
      ] as unknown as RecommendationInput['tasks'],
    }),
  });

  // workflow.owner-concentration: one owner holds >=60% of a multi-owner queue.
  out.push({
    now,
    input: bankBase({
      tasks: [
        tRec({ id: 'oa1', sessionId: 'owner-a', subject: 'Review billing API', owner: 'alice', status: 'pending' }),
        tRec({ id: 'oa2', sessionId: 'owner-a', subject: 'Ship admin export', owner: 'alice', status: 'in_progress' }),
        tRec({ id: 'oa3', sessionId: 'owner-b', subject: 'Fix org switcher', owner: 'alice', status: 'pending' }),
        tRec({ id: 'oa4', sessionId: 'owner-b', subject: 'Harden invite flow', owner: 'alice', status: 'pending' }),
        tRec({ id: 'ob1', sessionId: 'owner-c', subject: 'Write rollout note', owner: 'bob', status: 'pending' }),
        tRec({ id: 'oc1', sessionId: 'owner-c', subject: 'Verify smoke tests', owner: 'carol', status: 'pending' }),
      ] as unknown as RecommendationInput['tasks'],
      sessions: [
        { sessionId: 'owner-a', projectShort: 'billing', project: '/repo/billing' },
        { sessionId: 'owner-b', projectShort: 'admin', project: '/repo/admin' },
        { sessionId: 'owner-c', projectShort: 'ops', project: '/repo/ops' },
      ] as unknown as RecommendationInput['sessions'],
    }),
  });

  // workflow.review-bottleneck: one reviewer owns multiple stale PR review requests.
  out.push({
    now,
    input: bankBase({
      reviewEvents: {
        source: 'github-review-sync',
        generatedAt: new Date(now).toISOString(),
        reviewRequests: [
          {
            repository: 'acme/app',
            pullRequestNumber: 1,
            pullRequestTitle: 'Ship admin export',
            pullRequestState: 'open',
            reviewerId: 'alice',
            reviewerDisplayName: 'Alice',
            requestedAt: new Date(now - 3 * day).toISOString(),
            state: 'pending',
          },
          {
            repository: 'acme/app',
            pullRequestNumber: 2,
            pullRequestTitle: 'Fix org switcher',
            pullRequestState: 'open',
            reviewerId: 'alice',
            reviewerDisplayName: 'Alice',
            requestedAt: new Date(now - 60 * 60 * 60 * 1000).toISOString(),
            state: 'pending',
          },
          {
            repository: 'acme/app',
            pullRequestNumber: 3,
            pullRequestTitle: 'Harden invite flow',
            pullRequestState: 'open',
            reviewerId: 'bob',
            reviewerDisplayName: 'Bob',
            requestedAt: new Date(now - 55 * 60 * 60 * 1000).toISOString(),
            state: 'pending',
          },
        ],
      } as unknown as RecommendationInput['reviewEvents'],
    }),
  });

  // reliability.dropped-assignments: a team with a stalled agent + dropped work.
  out.push({
    now,
    input: bankBase({
      teams: [
        {
          teamId: 'team1', totalAssignments: 2, droppedCount: 2, droppedPct: 100,
          droppedAssignments: [{ agent: 'w1', taskId: 'x1', subject: 'do x', ageMinutes: 30 }],
          stalledAgents: [{ agent: 'w1', unreadCount: 2 }],
        },
      ] as unknown as RecommendationInput['teams'],
    }),
  });

  // activity.activity-trend: this week >= +50% tool calls vs last week.
  {
    const dailyActivity = Array.from({ length: 14 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}`,
      messageCount: 10,
      sessionCount: 2,
      toolCallCount: i < 7 ? 100 : 400,
    }));
    out.push({
      now,
      input: bankBase({
        statsCache: {
          version: 3,
          lastComputedDate: '2026-05-31',
          dailyActivity,
        } as unknown as RecommendationInput['statsCache'],
      }),
    });
  }

  // workflow.rework-signature: >=3 sessions, top reworkScore >= 10, high burst.
  out.push({
    now,
    input: bankBase({
      fileHistory: [
        { sessionId: 'fh1', churn: 12, spanMin: 2, burstRate: 6, reworkScore: 84, firstMs: now - day, lastMs: now },
        { sessionId: 'fh2', churn: 3, spanMin: 30, burstRate: 0.1, reworkScore: 3.3, firstMs: now - day, lastMs: now },
        { sessionId: 'fh3', churn: 2, spanMin: 20, burstRate: 0.1, reworkScore: 2.2, firstMs: now - day, lastMs: now },
      ] as unknown as RecommendationInput['fileHistory'],
    }),
  });

  // workflow.churn-geometry: structuredPatch shows high gross-low-net rework
  // across a stop-hook boundary on the same file/range.
  out.push({
    now,
    input: bankBase({
      churnGeometry: [
        {
          sessionId: 'cg',
          edits: [],
          files: [
            {
              sessionId: 'cg',
              filePath: 'src/payment.ts',
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
      ] as unknown as RecommendationInput['churnGeometry'],
    }),
  });

  // workflow.plan-missing-verification: a large plan with no Verification section.
  out.push({
    now,
    input: bankBase({
      plans: [
        { name: 'big-refactor', id: 'big-refactor', sections: 8, fileRefs: 9, words: 1500, hasVerification: false },
        { name: 'tiny-fix', id: 'tiny-fix', sections: 2, fileRefs: 1, words: 120, hasVerification: true },
      ] as unknown as RecommendationInput['plans'],
    }),
  });

  // reliability.self-update-health: a failed update lowers the success rate.
  out.push({
    now,
    input: bankBase({
      updateResults: [
        { timestamp: '2026-05-20T00:00:00Z', outcome: 'success', version_from: '2.1.140', version_to: '2.1.150' },
        { timestamp: '2026-05-25T00:00:00Z', outcome: 'failure', error_code: 'EACCES', version_from: '2.1.150', version_to: '2.1.150' },
      ] as unknown as RecommendationInput['updateResults'],
    }),
  });

  // reliability.mcp-needs-auth: a server needs interactive re-auth.
  out.push({
    now,
    input: bankBase({
      mcpAuth: {
        serversNeedingAuth: ['github'],
        entries: { github: { needsAuth: true, reason: 'token expired' } },
      } as unknown as RecommendationInput['mcpAuth'],
    }),
  });

  // reliability.config-drift: a recent project-scoped server-disabled event.
  out.push({
    now,
    input: bankBase({
      configBackups: [
        { kind: 'server-disabled', project: '/repo/app', server: 'postgres', from: true, to: false, timestamp: now - day, severity: 'warning' },
      ] as unknown as RecommendationInput['configBackups'],
    }),
  });

  // reliability.agent-report-card (#572): a committed sdk-cli project with heavy
  // reliability drag → at least one non-KEEP verdict.
  {
    const ids = ['rc1', 'rc2', 'rc3', 'rc4'];
    const env = { node_version: 'v22', terminal: 'tmux', wsl_version: '2', linux_distro_id: 'ubuntu', arch: 'x64', build_time: '2026-05-01' };
    out.push({
      now,
      input: bankBase({
        sessionRegistry: ids.map((id) => ({
          pid: 1, sessionId: id, cwd: '/repo/rc', startedAt: now - day, procStart: '1',
          version: '2.1.161', peerProtocol: 1, kind: 'interactive', entrypoint: 'sdk-cli',
        })) as unknown as RecommendationInput['sessionRegistry'],
        telemetry: ids.map((id) => ({
          event_name: 'tengu_api_slow_first_byte', client_timestamp: '2026-05-30T00:00:00Z',
          model: 'claude-opus-4-8', betas: '', session_id: id, attempt: 9, elapsed_ms: 30000, env,
        })) as unknown as RecommendationInput['telemetry'],
        debugLogs: ids.map((id) => ({
          sessionId: id, ttfbP50: 6000, ttfbP90: 13000, ttfbMax: 14000, ttfbSampleCount: 5,
          maxRetryAttempt: 9, slowFirstByteCount: 3, fastModeLostCount: 5,
        })) as unknown as RecommendationInput['debugLogs'],
      }),
    });
  }

  // ── workflow.harmful-habit (#549): tool errors track with worse outcomes ──
  // 3 cheap error-free sessions vs 3 costly all-error ones → the tool-errors
  // habit side has a 0% proxy good-rate vs 100% clean → a `hurts` verdict.
  {
    const tl = (sessionId: string) =>
      ({ sessionId, startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:00Z', entries: [] }) as unknown as SessionTimeline;
    const tok = (sessionId: string, webSearchRequests: number) =>
      ({
        sessionId,
        entries: [{ timestamp: 't', model: 'unknown', inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0, webSearchRequests, webFetchRequests: 0 }],
        compactionEvents: [],
      }) as unknown as SessionTokenData;
    const tls = (sessionId: string, isError: boolean): ToolUsageData => ({
      sessionId,
      calls: Array.from({ length: 4 }, (_, i): ToolCall => ({
        timestamp: `2026-01-01T00:00:0${i}Z`, toolName: 'Bash',
        input: { command: `cmd-${sessionId}-${i}` }, toolUseId: `${sessionId}-${i}`, isError, resultBytes: 0,
      })),
    });
    const clean = ['hc1', 'hc2', 'hc3'];
    const errored = ['he1', 'he2', 'he3'];
    out.push({
      now,
      input: bankBase({
        tokenData: [...clean.map((id) => tok(id, 0)), ...errored.map((id) => tok(id, 100))],
        toolData: [...clean.map((id) => tls(id, false)), ...errored.map((id) => tls(id, true))],
        timelines: [...clean, ...errored].map(tl),
      }),
    });
  }

  // ── workflow.prompt-clarity (#1275): low-specificity prompts track with ───
  // more follow-up turns on the local effectiveness proxy.
  {
    const low = ['pcl1', 'pcl2', 'pcl3'];
    const specific = ['pcs1', 'pcs2', 'pcs3'];
    const promptRow = (sessionId: string, lowSpecificityTurnCount: number) => ({
      sessionId,
      promptTurnCount: 1,
      lowSpecificityTurnCount,
      specificityMarkerCount: lowSpecificityTurnCount > 0 ? 0 : 2,
    });
    const timeline = (sessionId: string, userTurns: number) =>
      ({
        sessionId,
        startTime: '2026-01-01T00:00:00Z',
        endTime: '2026-01-01T00:01:00Z',
        entries: Array.from({ length: userTurns }, (_, i) => ({
          timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
          kind: 'user',
          summary: `turn ${i}`,
        })),
      }) as unknown as SessionTimeline;
    out.push({
      now,
      input: bankBase({
        promptAnalysis: [
          ...low.map((id) => promptRow(id, 1)),
          ...specific.map((id) => promptRow(id, 0)),
        ] as unknown as RecommendationInput['promptAnalysis'],
        timelines: [
          ...low.map((id) => timeline(id, 5)),
          ...specific.map((id) => timeline(id, 1)),
        ],
      }),
    });
  }

  // workflow.autonomy-over-steered (#1297): a high-confidence successful task
  // with high normalized steering load should produce an autonomy recommendation.
  out.push({
    now,
    input: bankBase({
      taskSteering: [
        {
          sessionId: 'auto-os-1',
          project: '/repo/app',
          taskIndex: 0,
          startTime: '2026-06-12T10:00:00.000Z',
          endTime: '2026-06-12T10:20:00.000Z',
          wallClockMs: 20 * 60 * 1000,
          costUsd: 25,
          humanTurns: 4,
          corrective: 2,
          clarifyingAnswer: 1,
          approving: 1,
          other: 0,
          interruptions: 0,
        },
      ] as unknown as RecommendationInput['taskSteering'],
      taskSuccess: [
        {
          sessionId: 'auto-os-1',
          project: '/repo/app',
          taskIndex: 0,
          startTime: '2026-06-12T10:00:00.000Z',
          endTime: '2026-06-12T10:20:00.000Z',
          wallClockMs: 20 * 60 * 1000,
          verdict: 'accept',
          agentClaim: 'completed',
          confidence: 'high',
          successScore: 0.95,
          backedByMutation: true,
          mutatingToolCount: 1,
          toolCallCount: 2,
          toolResultCount: 2,
          toolErrorCount: 0,
          toolErrorRate: 0,
          errorPenalty: 0,
        },
      ] as unknown as RecommendationInput['taskSuccess'],
    }),
  });

  // security.model-deceit (#686): a session with a contradicted success claim
  // and an unbacked action claim → the detector fires.
  out.push({
    now,
    input: bankBase({
      deceitSignals: [
        {
          sessionId: 'deceit-1',
          assistantTurnCount: 14,
          unbackedClaimCount: 1,
          contradictedClaimCount: 1,
          claimSnippets: ['all tests pass', 'I ran the suite'],
        },
      ] as unknown as RecommendationInput['deceitSignals'],
    }),
  });

  // context.repo-map-context-waste (#890): a stable, exported-API, read-only
  // file in the repo map that is re-read across sessions → structural pin candidate.
  // It also gives context.over-scoped-config-section (#1267) a root config
  // section whose governed files all sit under one component subtree.
  out.push({
    now,
    input: bankBase({
      repoMap: {
        projects: [
          {
            root: '/repo',
            generatedAtGitSha: 'abc123',
            fileCount: 1,
            truncated: false,
            text: '(map)',
            files: [
              {
                path: 'src/lib/reclaim.ts',
                symbols: [
                  { name: 'runReclaimCascade', kind: 'function', exported: true, signature: 'function runReclaimCascade()', line: 1 },
                ],
                imports: [],
                configSections: ['AGENTS.md#stable-reference-files'],
                recommendations: [],
                reread: { sessions: 3, totalReads: 9, totalEstimatedTokenWaste: 5000, maxPerSession: 3 },
              },
            ],
            configSections: [
              {
                id: 'AGENTS.md#stable-reference-files',
                sourceScope: 'AGENTS.md',
                heading: 'Stable reference files',
                level: 2,
                mtime: null,
                hash: 'hash',
                references: [],
              },
            ],
            configAttribution: [],
          },
        ],
      } as unknown as RecommendationInput['repoMap'],
    }),
  });

  // cost.model-eval-routing-gap (#1086): a fresh eval-results rollup carrying a
  // non-vetoed scoped routing recommendation backed by shadow/replay evidence
  // above the act-now score floor → act-now routing-gap finding.
  out.push({
    now,
    input: bankBase({
      modelEvalSummary: {
        schemaVersion: 1,
        kind: 'model-eval-summary',
        generatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
        artifactCount: 1,
        runCount: 3,
        models: [
          {
            modelId: 'claude-sonnet-4-5',
            runCount: 3,
            candidateRuns: 2,
            baselineRuns: 1,
            vetoedRuns: 0,
            meanWeightedScore: 0.7,
            bestWeightedScore: 0.85,
            vetoes: [],
            strongestEvidence: 'shadow-replay-verdict',
            evidenceCount: 4,
          },
        ],
        vetoTotals: {
          'failed-required-gate': 0,
          'materially-worse-correctness': 0,
          'unknown-pricing-or-api': 0,
          'insufficient-evidence': 0,
        },
        exclusions: { kept: 2, filtered: 1 },
        recommendations: [
          {
            modelId: 'claude-sonnet-4-5',
            scope: 'gap:haiku-sonnet:failure:small',
            weightedScore: 0.82,
            strongestEvidence: 'shadow-replay-verdict',
            rationale: 'Candidate beat the baseline on the failure cluster.',
          },
        ],
      } as unknown as RecommendationInput['modelEvalSummary'],
    }),
  });

  return out;
}

describe('detector registry (#411/#468/#507 — static barrel)', () => {
  function phraseWordCount(phrase: string): number {
    return phrase.match(/[a-z0-9][a-z0-9'_-]*/gi)?.length ?? 0;
  }

  function markerSpecificityProblems(
    detectorId: string,
    markers: AppliedMarkers
  ): string[] {
    const problems: string[] = [];
    if (!Array.isArray(markers.headings) || markers.headings.length === 0) {
      problems.push(`${detectorId}: missing heading marker`);
    }
    const headings = markers.headings ?? [];
    for (const heading of headings) {
      if (!/^\\?\^##\\s\+/.test(heading.source)) {
        problems.push(`${detectorId}: heading marker is not anchored to a Markdown heading (${heading})`);
      }
    }

    if (!Array.isArray(markers.bodyPhrases) || markers.bodyPhrases.length === 0) {
      problems.push(`${detectorId}: missing body phrase marker`);
    }
    for (const phrase of markers.bodyPhrases ?? []) {
      if (phraseWordCount(phrase) < 4) {
        problems.push(`${detectorId}: body phrase is too generic (${JSON.stringify(phrase)})`);
      }
    }
    return problems;
  }

  it('every registered detector has a unique id matching its category', async () => {
    const { DETECTORS } = await import('./detectors');
    const seen = new Set<string>();
    for (const d of DETECTORS) {
      expect(typeof d.rule).toBe('function');
      expect(d.id.startsWith(`${d.category}.`)).toBe(true);
      expect(seen.has(d.id)).toBe(false);
      seen.add(d.id);
    }
  });

  it('NEW_DETECTORS aliases DETECTORS for back-compat (#507)', async () => {
    const { DETECTORS, NEW_DETECTORS } = await import('./detectors');
    expect(NEW_DETECTORS).toBe(DETECTORS);
  });

  // Detectors that legitimately emit a DIFFERENT id than their registry `id`
  // because the single rule body has multiple branches (#507 dual-emit). Every
  // other detector MUST emit `rec.id === d.id`.
  const DUAL_EMIT: Record<string, string[]> = {
    'safety.dangerous-bypass': ['safety.dangerous-bypass', 'safety.dangerous-commands'],
    'reliability.api-errors': ['reliability.api-errors', 'reliability.rate-limits'],
  };

  it('each detector emits its own id (except documented dual-emit), and every detector fires on the bank', async () => {
    const { DETECTORS } = await import('./detectors');
    const bank = fixtureBank();

    const firedIds = new Set<string>();
    for (const fixture of bank) {
      for (const d of DETECTORS) {
        const rec = d.rule(fixture.input, fixture.now);
        if (!rec) continue;
        firedIds.add(d.id);
        const allowed = DUAL_EMIT[d.id] ?? [d.id];
        // The emitted id must be the detector's own id, or — for an allowlisted
        // dual-emit detector — one of its documented alternates.
        expect(allowed).toContain(rec.id);
      }
    }

    // each-fires coverage: the bank must trigger EVERY registered detector. The
    // failure message lists any detector that never fired so the bank is
    // provably exhaustive.
    const never = DETECTORS.filter((d) => !firedIds.has(d.id)).map((d) => d.id);
    expect(never, `detectors that never fired on the bank: ${never.join(', ')}`).toEqual([]);
  });

  it('CLAUDE.md appliedMarkers are specific enough to avoid fake suppression wins (#580)', async () => {
    const { DETECTORS } = await import('./detectors');
    const bank = fixtureBank();
    const problems: string[] = [];

    for (const fixture of bank) {
      for (const d of DETECTORS) {
        const rec = d.rule(fixture.input, fixture.now);
        const markers = rec?.fix?.appliedMarkers;
        if (!markers) continue;
        problems.push(...markerSpecificityProblems(d.id, markers));
      }
    }

    expect(
      problems,
      `underspecified appliedMarkers:\n${problems.join('\n')}`
    ).toEqual([]);
  });
});

describe('reclaim rollup dedup + per-category breakdown (#946)', () => {
  const costRec = (
    id: string,
    estSavingsUsd: number,
    extra: Partial<Recommendation> = {}
  ): Recommendation => ({
    id,
    category: 'cost',
    severity: 'warning',
    title: id,
    detail: 'd',
    action: 'a',
    estSavingsUsd,
    ...extra,
  });

  it('does NOT double-count two detectors that claim the same priced pool', () => {
    // Two distinct detectors price the same ~$5,449 cache-read pool: they share
    // a savingsAttribution.signatureId, so the rollup must count it once.
    const sharedSignature = 'cache-read-pool';
    const detectorA = costRec('cost.cache-1h-waste', 5449, {
      savingsAttribution: {
        interventionKey: 'cost.cache-1h-waste',
        signatureId: sharedSignature,
        tier: 'tier-0-estimate',
      },
    });
    const detectorB = costRec('cost.cache-read-share', 5449, {
      savingsAttribution: {
        interventionKey: 'cost.cache-read-share',
        signatureId: sharedSignature,
        tier: 'tier-0-estimate',
      },
    });

    const rollup = rollupReclaim([detectorA, detectorB]);
    // Counted once (the larger of the two equal claims), NOT summed to 10898.
    expect(rollup.total).toBe(5449);
    expect(totalEstimatedSavings([detectorA, detectorB])).toBe(5449);
  });

  it('keeps the larger estimate when two views of a pool disagree', () => {
    const sig = 'web-search-pool';
    const low = costRec('cost.web-search', 100, {
      savingsAttribution: { interventionKey: 'k', signatureId: sig, tier: 'tier-0-estimate' },
    });
    const high = costRec('cost.web-search-dupe', 250, {
      savingsAttribution: { interventionKey: 'k', signatureId: sig, tier: 'tier-0-estimate' },
    });
    expect(rollupReclaim([low, high]).total).toBe(250);
  });

  it('produces a correct per-category breakdown', () => {
    // Distinct cost pools (no shared signature) each contribute once; the
    // descriptive cost.expensive-sessions and cache-economics audit findings are
    // excluded, as are non-cost and zero/absent claims.
    const recs: Recommendation[] = [
      costRec('cost.cache-1h-waste', 1000),
      costRec('cost.web-search-spend', 400),
      costRec('cost.expensive-sessions', 9999), // descriptive — excluded
      costRec('cost.cache-economics', 7777), // descriptive — excluded
      costRec('cost.zero', 0), // no recoverable spend — excluded
      { ...costRec('context.bloat', 50), category: 'context' }, // not cost — excluded
    ];

    const rollup = rollupReclaim(recs);
    expect(rollup.byCategory).toEqual({ cost: 1400 });
    expect(rollup.total).toBe(1400);
  });

  it('sums non-overlapping pools (no false dedup across distinct rule ids)', () => {
    const recs = [
      costRec('cost.a', 10),
      costRec('cost.b', 20),
      costRec('cost.c', 30),
    ];
    expect(rollupReclaim(recs).total).toBe(60);
  });

  it('empty / no-claim inputs roll up to zero with an empty map', () => {
    expect(rollupReclaim([])).toEqual({ total: 0, byCategory: {} });
  });

  it('legacy totalEstimatedSavings smoke: derives from the deduped rollup', () => {
    const rec = costRec('cost.single', 12);
    // Same single-claim value the pre-#946 reduce returned.
    expect(totalEstimatedSavings([rec])).toBe(12);
    expect(totalEstimatedSavings([rec])).toBe(rollupReclaim([rec]).total);
  });
});

describe('guarded-marginal cascade rollup (#947, epic #944)', () => {
  const opusInputSession = (
    sessionId: string,
    inputTokens: number,
    model = 'claude-opus-4-7'
  ): SessionTokenData =>
    ({
      sessionId,
      model,
      totalInputTokens: inputTokens,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      messageCount: 1,
      entries: [
        {
          timestamp: 't',
          inputTokens,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheCreation1hTokens: 0,
          cacheReadTokens: 0,
          webSearchRequests: 0,
          webFetchRequests: 0,
          model,
        } as TokenEntry,
      ],
      compactionEvents: [],
      hasUnknownModel: false,
    }) as unknown as SessionTokenData;

  const recWithClaim = (
    id: string,
    claim: ReclaimClaim,
    estSavingsUsd?: number
  ): Recommendation => ({
    id,
    category: claim.category,
    severity: 'warning',
    title: id,
    detail: 'd',
    action: 'a',
    ...(estSavingsUsd !== undefined ? { estSavingsUsd } : {}),
    reclaim: claim,
  });

  it('a cost detector emitting a reprice claim books the expected marginal', () => {
    // 1M input on Opus 4.7 ($5) repriced to Haiku ($1) ⇒ books $4.
    const td = [opusInputSession('s1', 1_000_000)];
    const rec = recWithClaim('cost.swap', {
      leverId: 'cost.swap',
      category: 'cost',
      orderKey: 80,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: CHEAPEST_MODEL },
      evidenceTokens: 1_000_000,
    });
    const rollup = rollupReclaimCascade([rec], td);
    expect(rollup.total).toBeCloseTo(4, 9);
    expect(rollup.totalBill).toBeCloseTo(5, 9);
    expect(rollup.byCategory.cost).toBeCloseTo(4, 9);
  });

  it('two overlapping claims on the same pool do NOT double-count (cascade)', () => {
    const td = [opusInputSession('s1', 1_000_000)];
    const a = recWithClaim('cost.a', {
      leverId: 'cost.a',
      category: 'cost',
      orderKey: 10,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: 'claude-sonnet-4-6' },
      evidenceTokens: 1_000_000,
    });
    const b = recWithClaim('cost.b', {
      leverId: 'cost.b',
      category: 'cost',
      orderKey: 20,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: CHEAPEST_MODEL },
      evidenceTokens: 1_000_000,
    });
    // 5 → 3 → 1, total $4 — NOT $5 + $5.
    expect(rollupReclaimCascade([a, b], td).total).toBeCloseTo(4, 9);
  });

  it('backfillReclaimSavings derives estSavingsUsd from the booked marginal', () => {
    const td = [opusInputSession('s1', 1_000_000)];
    // The detector's own estimate is deliberately wrong ($999); the back-fill
    // must overwrite it with the booked $4 marginal.
    const rec = recWithClaim(
      'cost.swap',
      {
        leverId: 'cost.swap',
        category: 'cost',
        orderKey: 80,
        ownedPools: ['input'],
        scopeKeys: [scopeKeyOf('s1', 'claude-opus-4-7')],
        counterfactual: { kind: 'reprice', toModel: CHEAPEST_MODEL },
        evidenceTokens: 1_000_000,
      },
      999
    );
    const [filled] = backfillReclaimSavings([rec], td);
    expect(filled.estSavingsUsd).toBeCloseTo(4, 9);
    // Original rec object is not mutated (new array of new objects).
    expect(rec.estSavingsUsd).toBe(999);
  });

  it('legacy recs WITHOUT a claim pass through back-fill unchanged', () => {
    const legacy: Recommendation = {
      id: 'cost.legacy',
      category: 'cost',
      severity: 'info',
      title: 't',
      detail: 'd',
      action: 'a',
      estSavingsUsd: 42,
    };
    const [out] = backfillReclaimSavings([legacy], []);
    expect(out).toBe(legacy); // same reference, untouched
    expect(out.estSavingsUsd).toBe(42);
  });

  it('reclaimCascade surfaces rejections without breaking the identity', () => {
    const td = [opusInputSession('s1', 1_000_000)];
    const ghost = recWithClaim('cost.ghost', {
      leverId: 'cost.ghost',
      category: 'cost',
      orderKey: 50,
      ownedPools: ['input'],
      scopeKeys: [scopeKeyOf('missing', 'claude-opus-4-7')],
      counterfactual: { kind: 'reprice', toModel: CHEAPEST_MODEL },
      evidenceTokens: 0,
    });
    const rejects: string[] = [];
    const result = reclaimCascade([ghost], td, (m) => rejects.push(m));
    expect(result.booked[0].rejected).toBe(true);
    expect(result.total).toBeCloseTo(0, 9);
    expect(rejects.length).toBeGreaterThan(0);
  });
});

// ── Repo-map recs as first-class entries in BOTH engine faces (#894) ─────────
// The repo-map substrate (#871) emits its structural-context-waste detector
// (#890) into the canonical engine. #894 is the delivery slice: the SAME
// recommendation object must reach the human Recommendations view face
// (`buildRecommendations(...)`, rendered by Recommendations.tsx) AND the
// agent-facing `/api/recommendations.json` face — which the server serves as
// `JSON.stringify(buildRecommendations(...))` (scripts/server.mjs → ingest.mjs
// `assembleRecommendations`). Both faces run the one pure engine over the one
// `assembleRecommendationInput({ ...repoMap })` seam, so the proof is: feed the
// shared input, take the human-face object, round-trip it through the wire
// encoding the agent face emits, and assert byte-equivalence + the #866
// actionability contract (concrete action, named targets, priced reclaim claim).
describe('repo-map recs are first-class in both engine faces (#894)', () => {
  // A stable, exported-API, read-only file re-read across sessions, WITH the
  // tool/token data so the cascade can price the reclaim claim — mirrors the
  // detector's own reclaim fixture (src/lib/detectors/context/repo-map-context-waste.test.ts).
  const REPO_PATH = 'src/lib/reclaim.ts';
  function repoMapInput(): RecommendationInput {
    const repoMap = {
      projects: [
        {
          root: '/repo',
          generatedAtGitSha: 'abc123',
          fileCount: 1,
          truncated: false,
          text: '(map)',
          files: [
            {
              path: REPO_PATH,
              symbols: [
                {
                  name: 'runReclaimCascade',
                  kind: 'function',
                  exported: true,
                  signature: 'function runReclaimCascade()',
                  line: 1,
                },
              ],
              imports: [],
              configSections: [],
              recommendations: [],
              reread: {
                sessions: 1,
                totalReads: 4,
                totalEstimatedTokenWaste: 3000,
                maxPerSession: 4,
              },
            },
          ],
          configSections: [],
          configAttribution: [],
        },
      ],
    } as unknown as RecommendationInput['repoMap'];

    const toolData = [
      {
        sessionId: 's1',
        calls: Array.from({ length: 4 }, (_, i) => ({
          timestamp: `2026-06-09T00:00:0${i}Z`,
          toolName: 'Read',
          input: { file_path: `/repo/${REPO_PATH}` },
          toolUseId: `t${i}`,
          isError: null,
          resultBytes: 4000,
        })),
      },
    ] as unknown as RecommendationInput['toolData'];

    const tokenData = [
      {
        sessionId: 's1',
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 1_000_000,
        entries: [
          {
            timestamp: 't',
            model: 'claude-opus-4-8',
            inputTokens: 1000,
            outputTokens: 500,
            cacheCreationTokens: 0,
            cacheCreation1hTokens: 0,
            cacheReadTokens: 1_000_000,
            webSearchRequests: 0,
            webFetchRequests: 0,
          },
        ],
        compactionEvents: [],
      },
    ] as unknown as RecommendationInput['tokenData'];

    return assembleRecommendationInput(
      baseInput({ repoMap, toolData, tokenData })
    );
  }

  // The agent face's wire encoding: scripts/server.mjs serves
  // `JSON.stringify(assembleRecommendations(...))`, and `assembleRecommendations`
  // is `buildRecommendations(assembleRecommendationInput(...))` over the same
  // fields the human face supplies. So the agent-face object a consumer parses is
  // exactly the round-trip of the human-face object through JSON.
  const repoMapRec = (recs: Recommendation[]) =>
    recs.find((r) => r.id === 'context.repo-map-context-waste');

  it('serves a byte-equivalent repo-map recommendation from the human and agent-facing faces', () => {
    const input = repoMapInput();

    // Human face: the object Recommendations.tsx renders.
    const humanRecs = buildRecommendations(input, 0);
    const humanRec = repoMapRec(humanRecs);
    expect(humanRec).toBeDefined();

    // Agent face: the object a `/api/recommendations.json` consumer parses off
    // the wire — the server's `JSON.stringify(...)` of the same engine output.
    const agentRecs = JSON.parse(JSON.stringify(humanRecs)) as Recommendation[];
    const agentRec = repoMapRec(agentRecs);
    expect(agentRec).toBeDefined();

    // Byte-equivalent: the two faces serialize to the identical string.
    expect(JSON.stringify(agentRec)).toBe(JSON.stringify(humanRec));
  });

  it('the surfaced repo-map rec satisfies the #866 actionability contract', () => {
    const rec = repoMapRec(buildRecommendations(repoMapInput(), 0));
    expect(rec).toBeDefined();
    // Concrete, imperative action.
    expect(typeof rec!.action).toBe('string');
    expect(rec!.action.length).toBeGreaterThan(0);
    // Named targets: the specific file AND its symbols, not a bare path list.
    expect(rec!.evidence?.some((e) => e.includes(REPO_PATH))).toBe(true);
    expect(rec!.evidence?.some((e) => e.includes('runReclaimCascade'))).toBe(true);
    // Source/confidence badge: a copy-pasteable, deep-linkable fix with its
    // applied-marker provenance (the engine's confidence/source path).
    expect(rec!.fix?.target).toBe('CLAUDE.md');
    expect(rec!.fix?.snippet).toContain(`@${REPO_PATH}`);
    expect(rec!.view).toBe('context');
    // Evidence-strength / priced contribution: a structural-prefix reclaim claim
    // (epic #944) so the finding feeds the coverage gauge (#952) with real dollars.
    expect(rec!.reclaim).toBeDefined();
    expect(rec!.reclaim!.cause).toBe('structural-prefix');
    expect(rec!.reclaim!.category).toBe('context');
    expect(rec!.reclaim!.evidenceTokens).toBeGreaterThan(0);
  });

  it("books the repo-map rec's priced contribution into the per-category dollar rollup", () => {
    const input = repoMapInput();
    const recs = buildRecommendations(input, 0);
    // The agent face serializes whatever the engine produced; the priced
    // contribution must survive the wire so both faces show the SAME dollars.
    const overWire = JSON.parse(JSON.stringify(recs)) as Recommendation[];

    const rollup = rollupReclaimCascade(overWire, input.tokenData);
    // The structural-prefix claim books a positive marginal into the `context`
    // category bucket — real reclaimable dollars, not unmeasured advice.
    expect(rollup.byCategory.context ?? 0).toBeGreaterThan(0);
    expect(rollup.total).toBeGreaterThan(0);
  });
});
