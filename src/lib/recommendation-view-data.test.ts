import { describe, expect, it } from 'vitest';
import {
  CLIENT_ABSENT_ENGINE_FIELDS,
  recommendationViewsFromViewData,
} from './recommendation-view-data';
import {
  assembleRecommendationInput,
  engineConsumedFields,
  listOmittedEngineSignals,
} from './recommendations';
import type { SecretsAtRestSignal } from './parse-secrets-at-rest';
import type { DocGraph } from './parse-docs';
import type { ViewData } from './view-registry';

/**
 * #2352 parity contract: the canonical client envelope must supply every
 * field any detector consumes, except the documented server-only artifacts.
 * `engineConsumedFields()` is derived from the live detector catalog
 * (required base fields + declared dataDeps), so a NEW detector that starts
 * consuming a client-carried signal fails this test until the envelope (and
 * therefore Home Digest, Recommendations, and Ask Claude together) carries it.
 */

// Fully-populated ViewData stand-in: every engine field gets a non-undefined
// value. Values are shape-irrelevant here — the contract under test is key
// coverage, not detector behavior.
function fullViewData(overrides: Partial<ViewData> = {}): ViewData {
  return {
    entries: [],
    sessions: [],
    projects: [],
    tokenData: [],
    toolData: [],
    toolInventories: [],
    timelines: [],
    apiErrors: [],
    permissionRows: [],
    permissionChanges: [],
    agentSettings: [],
    attribution: [],
    runtimeEvents: [],
    taskSteering: [],
    churnGeometry: [],
    valueFlow: [],
    taskSuccess: [],
    assistantFeatures: [],
    promptAnalysis: [],
    deceitSignals: [],
    secretsAtRest: [],
    liveConfig: null,
    repoMap: null,
    docGraph: null,
    shadowCalls: null,
    memories: [],
    workflows: [],
    tasks: [],
    teams: [],
    reviewEvents: null,
    sessionRegistry: [],
    telemetry: [],
    modelLatency: [],
    debugLogs: [],
    statsCache: null,
    fileHistory: [],
    plans: [],
    modelEvalSummary: null,
    updateResults: [],
    mcpAuth: null,
    configBackups: [],
    externalGuidance: [],
    enterpriseSession: null,
    sampleAdoptionReceipts: [],
    ...overrides,
  };
}

describe('recommendationViewsFromViewData (#2352 parity contract)', () => {
  it('projects the already-sanitized secrets-at-rest signal into the canonical envelope', () => {
    const secretsAtRest: SecretsAtRestSignal[] = [
      {
        sessionId: 'session-safe-coordinates',
        totalCount: 2,
        countsByKind: { 'anthropic-key': 1, 'private-key': 1 },
        evidenceRefs: [
          {
            sessionId: 'session-safe-coordinates',
            entryIndex: 4,
            timestamp: '2026-07-15T10:00:00.000Z',
            toolUseId: 'tool-use-coordinate',
          },
        ],
        lastObserved: '2026-07-15T10:00:00.000Z',
      },
    ];
    const envelope = recommendationViewsFromViewData(fullViewData({ secretsAtRest }));
    const detectorInput = assembleRecommendationInput(envelope);

    expect(envelope.secretsAtRest).toBe(secretsAtRest);
    expect(detectorInput.secretsAtRest).toBe(secretsAtRest);
    expect(CLIENT_ABSENT_ENGINE_FIELDS).not.toContain('secretsAtRest');
    expect(listOmittedEngineSignals(envelope)).not.toContain('secretsAtRest');
  });

  it('preserves the empty signal used for legacy and SPA datasets', () => {
    const envelope = recommendationViewsFromViewData(fullViewData());
    const legacyEnvelope = recommendationViewsFromViewData({
      ...fullViewData(),
      secretsAtRest: undefined,
    } as unknown as ViewData);

    expect(envelope.secretsAtRest).toEqual([]);
    expect(assembleRecommendationInput(envelope).secretsAtRest).toEqual([]);
    expect(legacyEnvelope.secretsAtRest).toEqual([]);
  });

  it('carries the server dataset doc graph through every client recommendation surface', () => {
    const docGraph: DocGraph = {
      root: '/repo',
      nodes: [
        {
          slug: 'README',
          path: 'README.md',
          category: 'root',
          frontmatter: {},
          headings: ['Readme'],
          gitMtimeIso: '2026-07-15T12:00:00.000Z',
        },
      ],
      edges: [],
    };
    const envelope = recommendationViewsFromViewData(fullViewData({ docGraph }));

    expect(envelope.docGraph).toBe(docGraph);
    expect(assembleRecommendationInput(envelope).docGraph).toBe(docGraph);
    expect(CLIENT_ABSENT_ENGINE_FIELDS).not.toContain('docGraph');
    expect(listOmittedEngineSignals(envelope)).not.toContain('docGraph');
  });

  it('supplies every engine-consumed field the client dataset carries', () => {
    const envelope = recommendationViewsFromViewData(fullViewData());
    const record = envelope as unknown as Record<string, unknown>;
    const missing = engineConsumedFields().filter(
      (field) =>
        record[field] === undefined &&
        !CLIENT_ABSENT_ENGINE_FIELDS.includes(field)
    );
    expect(missing).toEqual([]);
  });

  it('documents exactly the server-only fields as omitted', () => {
    const envelope = recommendationViewsFromViewData(fullViewData());
    const omitted = listOmittedEngineSignals(envelope);
    // Every omission must be a documented client-absent field; fields the
    // engine does not consume may not appear here either.
    for (const field of omitted) {
      expect(CLIENT_ABSENT_ENGINE_FIELDS).toContain(field);
    }
  });

  it('labels the base-six fallback with its omitted signals', () => {
    const omitted = listOmittedEngineSignals({
      tokenData: [],
      toolData: [],
      sessions: [],
      projects: [],
      permissionRows: [],
      apiErrors: [],
    });
    // The narrow Ask Claude fallback omits every declared optional signal —
    // spot-check a few that the audit called out as parity gaps.
    expect(omitted).toContain('repoMap');
    expect(omitted).toContain('modelEvalSummary');
    expect(omitted.length).toBeGreaterThan(10);
  });
});
