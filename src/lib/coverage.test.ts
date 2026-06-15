import { describe, expect, it } from 'vitest';

import { ACTION_DOMAINS } from './digest';
import {
  buildRecommendationResult,
  computeDomainCoverage,
  type RecommendationInput,
} from './recommendations';

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

const tokenRow = { sessionId: 's1', entries: [{}] } as unknown as
  RecommendationInput['tokenData'][number];
const toolRow = { sessionId: 's1', calls: [{}] } as unknown as
  RecommendationInput['toolData'][number];
const apiErrorRow = { sessionId: 's1' } as unknown as
  RecommendationInput['apiErrors'][number];
const runtimeRow = { sessionId: 's1', hookCount: 1 } as unknown as NonNullable<
  RecommendationInput['runtimeEvents']
>[number];
const modelLatencyRow = { model: 'claude', p95Ms: 1200 } as unknown as NonNullable<
  RecommendationInput['modelLatency']
>[number];
const timelineRow = { sessionId: 's1' } as unknown as NonNullable<
  RecommendationInput['timelines']
>[number];
const repoMap = { files: [] } as unknown as NonNullable<
  RecommendationInput['repoMap']
>;
const taskRow = { id: 'task-1' } as unknown as NonNullable<
  RecommendationInput['tasks']
>[number];
const workflowRow = { id: 'wf-1' } as unknown as NonNullable<
  RecommendationInput['workflows']
>[number];

function coverageFor(input: RecommendationInput, domain: string) {
  const coverage = computeDomainCoverage(input).find((row) => row.domain === domain);
  expect(coverage).toBeDefined();
  return coverage!;
}

describe('computeDomainCoverage', () => {
  it('returns one coverage row per digest action domain', () => {
    const coverage = computeDomainCoverage(baseInput());

    expect(coverage.map((row) => row.domain)).toEqual([...ACTION_DOMAINS]);
  });

  it('marks speed CANNOT_SEE when no speed artifact is present', () => {
    const speed = coverageFor(baseInput({ tokenData: [tokenRow] }), 'speed');

    expect(speed.status).toBe('CANNOT_SEE');
  });

  it('marks cost PROVE on a normal token dataset', () => {
    const cost = coverageFor(baseInput({ tokenData: [tokenRow] }), 'cost');

    expect(cost.status).toBe('PROVE');
  });

  it('marks a domain INFER when core signal exists but optional artifact evidence is missing', () => {
    const successRate = coverageFor(
      baseInput({
        toolData: [toolRow],
        apiErrors: [apiErrorRow],
        runtimeEvents: [runtimeRow],
      }),
      'success-rate'
    );

    expect(successRate.status).toBe('INFER');
  });

  it('adds a staleness note when debug logs are absent from success-rate coverage', () => {
    const successRate = coverageFor(
      baseInput({
        toolData: [toolRow],
        apiErrors: [apiErrorRow],
        runtimeEvents: [runtimeRow],
      }),
      'success-rate'
    );

    expect(successRate.staleNote).toContain('Debug logs are absent');
  });

  it('marks domains PROVE when their declared coverage inputs are present', () => {
    const input = baseInput({
      tokenData: [tokenRow],
      toolData: [toolRow],
      permissionRows: [{ mode: 'default', sessionId: 's1' }],
      apiErrors: [apiErrorRow],
      runtimeEvents: [runtimeRow],
      modelLatency: [modelLatencyRow],
      deceitSignals: [{ sessionId: 's1' }] as unknown as NonNullable<
        RecommendationInput['deceitSignals']
      >,
      timelines: [timelineRow],
      repoMap,
      tasks: [taskRow],
      workflows: [workflowRow],
      sessionRegistry: [{ sessionId: 's1' }] as unknown as NonNullable<
        RecommendationInput['sessionRegistry']
      >,
      telemetry: [{ session_id: 's1' }] as unknown as NonNullable<
        RecommendationInput['telemetry']
      >,
      debugLogs: [{ sessionId: 's1' }] as unknown as NonNullable<
        RecommendationInput['debugLogs']
      >,
      organizationIdentity: {} as unknown as NonNullable<
        RecommendationInput['organizationIdentity']
      >,
      reviewEvents: {} as unknown as NonNullable<
        RecommendationInput['reviewEvents']
      >,
      churnGeometry: [{ sessionId: 's1' }] as unknown as NonNullable<
        RecommendationInput['churnGeometry']
      >,
      promptAnalysis: [{ sessionId: 's1' }] as unknown as NonNullable<
        RecommendationInput['promptAnalysis']
      >,
      taskSteering: [{ sessionId: 's1' }] as unknown as NonNullable<
        RecommendationInput['taskSteering']
      >,
      taskSuccess: [{ sessionId: 's1' }] as unknown as NonNullable<
        RecommendationInput['taskSuccess']
      >,
    });

    expect(computeDomainCoverage(input).map((row) => row.status)).toEqual(
      ACTION_DOMAINS.map(() => 'PROVE')
    );
  });
});

describe('buildRecommendationResult', () => {
  it('exposes domain coverage beside the ranked recommendations', () => {
    const result = buildRecommendationResult(baseInput(), 0);

    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(result.domainCoverage.map((row) => row.domain)).toEqual([
      ...ACTION_DOMAINS,
    ]);
  });
});
