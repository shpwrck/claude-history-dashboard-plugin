import { describe, expect, it } from 'vitest';
import {
  CLIENT_ABSENT_ENGINE_FIELDS,
  recommendationViewsFromViewData,
} from './recommendation-view-data';
import {
  engineConsumedFields,
  listOmittedEngineSignals,
} from './recommendations';
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
function fullViewData(): ViewData {
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
    liveConfig: null,
    repoMap: null,
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
  };
}

describe('recommendationViewsFromViewData (#2352 parity contract)', () => {
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
