import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  computeDocumentDigest,
  decodeDefinitionV1,
  EMPTY_SHA256,
  withDocumentDigest
} from '../../contracts/v1';
import type { ExperimentDefinition } from '../../contracts/v1';
import {
  createGate2702C5SelectionBinding,
  GATE_2702_C5_CONTRACT_REGISTRY,
  GATE_2702_C5_DEFINITION,
  GATE_2702_C5_PLAN,
  projectGate2702C5Definition
} from './definition';

const PINNED_DIGEST =
  'sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba';

function scalarLeaves(
  value: unknown,
  path: Array<string | number> = []
): Array<{
  path: Array<string | number>;
  value: null | boolean | number | string;
}> {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return [{ path, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      scalarLeaves(child, [...path, index])
    );
  }
  if (typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    scalarLeaves(child, [...path, key])
  );
}

function setAtPath(
  root: unknown,
  path: Array<string | number>,
  value: unknown
) {
  let parent = root as Record<string | number, unknown>;
  for (const segment of path.slice(0, -1)) {
    parent = parent[segment] as Record<string | number, unknown>;
  }
  parent[path.at(-1) as string | number] = value;
}

function changedScalar(value: null | boolean | number | string): unknown {
  if (value === null) return true;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  return `${value}-mutated`;
}

function objectKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...objectKeys(child)
  ]);
}

describe('#2702 C5 Definition bridge', () => {
  it('decodes the checked-in Definition and pins its canonical digest', () => {
    expect(GATE_2702_C5_DEFINITION.contentDigest).toBe(PINNED_DIGEST);
    expect(computeDocumentDigest(GATE_2702_C5_DEFINITION)).toBe(PINNED_DIGEST);
    expect(
      decodeDefinitionV1(GATE_2702_C5_DEFINITION, {
        registry: GATE_2702_C5_CONTRACT_REGISTRY
      })
    ).toMatchObject({ ok: true });
    expect(Object.isFrozen(GATE_2702_C5_DEFINITION)).toBe(true);
    expect(Object.isFrozen(GATE_2702_C5_CONTRACT_REGISTRY)).toBe(true);
  });

  it('projects the exact pre-registered C5 plan', () => {
    const result = projectGate2702C5Definition(GATE_2702_C5_DEFINITION);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;

    expect(result.plan).toEqual({
      definitionRef: {
        definitionId: 'experiments/gate-2702-c5',
        definitionVersion: 1,
        contentDigest: PINNED_DIGEST
      },
      selectedHarness: 'claude-code',
      subjects: [2760, 2719, 2713, 2706, 2710, 2670],
      treatments: [
        {
          id: 'haiku-solo',
          label: 'Haiku solo',
          control: true,
          configuration: {
            workerTier: 'haiku',
            workerBudgetUsd: 15,
            sidekick: {
              enabled: false,
              sessionBudgetUsd: 0,
              perCallBudgetUsd: 0
            }
          }
        },
        {
          id: 'haiku-sonnet-sidekick',
          label: 'Haiku plus Sonnet Sidekick',
          control: false,
          configuration: {
            workerTier: 'haiku',
            workerBudgetUsd: 15,
            sidekick: {
              enabled: true,
              reviewerTier: 'sonnet',
              gate: 'checkpoint',
              sessionBudgetUsd: 2,
              perCallBudgetUsd: 1
            }
          }
        }
      ],
      limits: { wallTimeMs: 3_000_000, costUsd: 18 },
      costCaps: {
        workerUsd: 15,
        sidekickSessionUsd: 2,
        sidekickPerCallUsd: 1,
        allInUsd: 18
      },
      checks: [
        {
          id: 'checks/gate-2702-vitest',
          argv: ['npx', 'vitest', 'run'],
          timeoutMs: 720_000
        },
        {
          id: 'checks/gate-2702-typecheck',
          argv: ['npm', 'run', 'typecheck'],
          timeoutMs: 360_000
        }
      ],
      metricIds: [
        'metrics/gate-2702-all-in-cost',
        'metrics/gate-2702-wall-time',
        'metrics/gate-2702-quality-loss',
        'metrics/gate-2702-sidekick-triggers',
        'metrics/gate-2702-sidekick-paid-calls',
        'metrics/gate-2702-sidekick-shipped-interventions',
        'metrics/gate-2702-attributable-ships'
      ],
      verdictParameters: {
        parityFloor: { maximumHeavyTaskLosses: 0 },
        netPositiveCost: {
          comparison: 'treatment-all-in-cost-lt-control-all-in-cost'
        },
        attributableShips: {
          minimumAttributableTreatmentWins: 1,
          requireShippedInterventionForEveryTreatmentWin: true
        },
        minimumSample: { runsPerTreatment: 6 },
        pairing: {
          key: 'subjectRef',
          requireBothTreatments: true,
          excludeIncompletePairs: true
        },
        judgeProtocol: {
          mode: 'blind-position-swapped',
          armOrders: ['forward', 'swapped'],
          agreementRequired: true,
          objectiveChecksAuthoritative: true,
          retries: {
            retryableFailureClasses: ['timeout', 'non-json', 'schema-invalid'],
            maximumAdditionalAttempts: 2
          }
        },
        primaryEffect: {
          contrast: {
            controlTreatmentId: 'haiku-solo',
            treatmentId: 'haiku-sonnet-sidekick'
          },
          metricRef: {
            id: 'metrics/gate-2702-all-in-cost',
            semanticsVersion: 1
          },
          estimator: {
            id: 'estimators/gate-2702-c5-graduation',
            version: 1
          },
          scale: 'relative',
          unit: 'usd',
          direction: 'lower-is-better'
        }
      },
      planSlots: ['2760', '2719', '2713', '2706', '2710', '2670'].flatMap(
        (issue) => [
          {
            planSlotId: `issue-${issue}.haiku-solo`,
            kind: 'treatment-run',
            treatmentId: 'haiku-solo'
          },
          {
            planSlotId: `issue-${issue}.haiku-sonnet-sidekick`,
            kind: 'treatment-run',
            treatmentId: 'haiku-sonnet-sidekick'
          }
        ]
      )
    });
    expect(result.plan).toBe(GATE_2702_C5_PLAN);
  });

  it('binds the exact subject selector and behavior factors into the registry', () => {
    const workload = GATE_2702_C5_CONTRACT_REGISTRY.semantics.find(
      (entry) => entry.id === 'capabilities/gate-2702-workload-selection'
    );
    expect(workload).toBeDefined();
    const manifest = {
      semantics: {
        id: 'capabilities/gate-2702-workload-selection',
        version: 1,
        portability: 'harness-specific'
      },
      selector: {
        id: 'selectors/gate-2702-c5-heavy-issues',
        version: 1,
        parameters: {
          repository: 'shpwrck/claude-history-dashboard',
          weight: 'heavy',
          issues: [2760, 2719, 2713, 2706, 2710, 2670]
        }
      }
    };
    const expectedDigest = `sha256:${createHash('sha256')
      .update(canonicalJson(manifest), 'utf8')
      .digest('hex')}`;
    expect(workload?.contentDigest).toBe(expectedDigest);

    const treatmentSemantics = GATE_2702_C5_CONTRACT_REGISTRY.semantics.find(
      (entry) => entry.id === 'capabilities/gate-2702-treatment-application'
    );
    const metricSemantics = GATE_2702_C5_CONTRACT_REGISTRY.semantics.find(
      (entry) => entry.id === 'capabilities/gate-2702-metric-collection'
    );
    expect(treatmentSemantics?.usage).toEqual({
      measures: [],
      enforces: ['costUsd']
    });
    expect(metricSemantics?.usage).toEqual({
      measures: ['costUsd'],
      enforces: []
    });

    const changedManifest = structuredClone(manifest);
    changedManifest.selector.parameters.issues.reverse();
    expect(
      `sha256:${createHash('sha256')
        .update(canonicalJson(changedManifest), 'utf8')
        .digest('hex')}`
    ).not.toBe(expectedDigest);

    const expectedFingerprintPolicy = {
      id: 'fingerprints/gate-2702-c5',
      version: 1,
      factorIdsByAdapter: {
        'gate-2702-claude-code-adapter': [
          'runtime/claude-cli-version',
          'model/worker-qualified-id',
          'runtime/worker-invocation-digest',
          'sidekick/enabled',
          'sidekick/model-qualified-id',
          'sidekick/gate',
          'sidekick/version',
          'sidekick/resolved-config-digest',
          'sidekick/instructions-digest',
          'budget/worker-usd',
          'budget/sidekick-session-usd',
          'budget/sidekick-per-call-usd',
          'checks/environment-digest',
          'repository/base-sha'
        ]
      },
      fingerprintSchemaVersionByAdapter: {
        'gate-2702-claude-code-adapter': 1
      },
      harnessByAdapter: {
        'gate-2702-claude-code-adapter': 'claude-code'
      }
    };
    expect(GATE_2702_C5_CONTRACT_REGISTRY.fingerprintPolicies).toEqual([
      expectedFingerprintPolicy
    ]);

    const fingerprintSemantics = GATE_2702_C5_CONTRACT_REGISTRY.semantics.find(
      (entry) => entry.id === 'capabilities/gate-2702-behavior-fingerprint'
    );
    const expectedFingerprintDigest = `sha256:${createHash('sha256')
      .update(
        canonicalJson({
          semantics: {
            id: 'capabilities/gate-2702-behavior-fingerprint',
            version: 1,
            portability: 'harness-specific'
          },
          fingerprintPolicy: expectedFingerprintPolicy
        }),
        'utf8'
      )
      .digest('hex')}`;
    expect(fingerprintSemantics?.contentDigest).toBe(expectedFingerprintDigest);
    expect(GATE_2702_C5_DEFINITION.requiredCapabilities).toContainEqual({
      semanticsRef: {
        id: 'capabilities/gate-2702-behavior-fingerprint',
        version: 1,
        contentDigest: expectedFingerprintDigest
      }
    });

    const changedFingerprintManifest = {
      semantics: {
        id: 'capabilities/gate-2702-behavior-fingerprint',
        version: 1,
        portability: 'harness-specific'
      },
      fingerprintPolicy: structuredClone(expectedFingerprintPolicy)
    };
    changedFingerprintManifest.fingerprintPolicy.factorIdsByAdapter[
      'gate-2702-claude-code-adapter'
    ].pop();
    const changedFingerprintDigest = `sha256:${createHash('sha256')
      .update(canonicalJson(changedFingerprintManifest), 'utf8')
      .digest('hex')}`;
    expect(changedFingerprintDigest).not.toBe(expectedFingerprintDigest);

    const changedDefinition = structuredClone(GATE_2702_C5_DEFINITION);
    const fingerprintCapability = changedDefinition.requiredCapabilities.find(
      (entry) =>
        entry.semanticsRef.id === 'capabilities/gate-2702-behavior-fingerprint'
    );
    if (!fingerprintCapability) {
      throw new Error('fingerprint capability missing from Definition');
    }
    fingerprintCapability.semanticsRef.contentDigest =
      changedFingerprintDigest as ExperimentDefinition['contentDigest'];
    expect(computeDocumentDigest(changedDefinition)).not.toBe(PINNED_DIGEST);
  });

  it('leaves resolved execution identity to each Run', () => {
    const keys = objectKeys(GATE_2702_C5_PLAN).map((key) => key.toLowerCase());
    expect(keys).not.toEqual(
      expect.arrayContaining([
        'runtime',
        'model',
        'config',
        'env',
        'command',
        'cwd',
        'worktree',
        'behaviorfingerprint',
        'capabilitysnapshot'
      ])
    );
    const planJson = JSON.stringify(GATE_2702_C5_PLAN);
    expect(planJson).not.toMatch(/claude-(?:haiku|sonnet)-[0-9]/i);
    expect(planJson).not.toMatch(/SIDEKICK_[A-Z_]+/);
    expect(planJson).not.toMatch(/\/(?:home|Users)\//);

    const definitionJson = JSON.stringify(GATE_2702_C5_DEFINITION);
    expect(definitionJson).not.toMatch(/claude-(?:haiku|sonnet)-[0-9]/i);
    expect(definitionJson).not.toMatch(/SIDEKICK_[A-Z_]+/);
  });

  it('rejects every stale-digest preregistration mutation', () => {
    const leaves = scalarLeaves(GATE_2702_C5_DEFINITION).filter(
      ({ path }) => !(path.length === 1 && path[0] === 'contentDigest')
    );
    expect(leaves.length).toBeGreaterThan(50);

    for (const leaf of leaves) {
      const candidate = structuredClone(GATE_2702_C5_DEFINITION);
      setAtPath(candidate, leaf.path, changedScalar(leaf.value));
      const label = leaf.path.join('/');
      expect(computeDocumentDigest(candidate), label).not.toBe(PINNED_DIGEST);
      expect(projectGate2702C5Definition(candidate), label).toMatchObject({
        ok: false
      });
    }
  });

  it('rejects a coherent but redigested preregistration mutation', () => {
    const candidate = structuredClone(GATE_2702_C5_DEFINITION);
    candidate.title = `${candidate.title} changed`;
    const redigested = withDocumentDigest(candidate);
    expect(
      decodeDefinitionV1(redigested, {
        registry: GATE_2702_C5_CONTRACT_REGISTRY
      })
    ).toMatchObject({ ok: true });
    expect(projectGate2702C5Definition(redigested)).toMatchObject({
      ok: false,
      code: 'definition-digest-mismatch'
    });
  });

  it('rejects foreign Definition identity and invalid digest independently', () => {
    const foreignId = structuredClone(GATE_2702_C5_DEFINITION);
    foreignId.definitionId = 'experiments/gate-2702-c5-foreign';
    expect(
      projectGate2702C5Definition(withDocumentDigest(foreignId))
    ).toMatchObject({
      ok: false,
      code: 'definition-id-mismatch'
    });

    const foreignVersion = structuredClone(GATE_2702_C5_DEFINITION);
    foreignVersion.definitionVersion += 1;
    expect(
      projectGate2702C5Definition(withDocumentDigest(foreignVersion))
    ).toMatchObject({
      ok: false,
      code: 'definition-version-mismatch'
    });

    const invalidDigest: ExperimentDefinition = {
      ...structuredClone(GATE_2702_C5_DEFINITION),
      contentDigest: EMPTY_SHA256
    };
    expect(projectGate2702C5Definition(invalidDigest)).toMatchObject({
      ok: false,
      code: 'definition-invalid',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'document.digest-mismatch' })
      ])
    });
  });

  it('builds the minimal immutable Selection Receipt binding for later Runs', () => {
    const binding = createGate2702C5SelectionBinding({
      receiptId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f442',
      receiptDigest: EMPTY_SHA256,
      trialId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f443',
      behaviorFingerprintDigest: EMPTY_SHA256,
      treatmentId: 'haiku-solo'
    });
    expect(binding).toEqual({
      receiptId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f442',
      receiptDigest: EMPTY_SHA256,
      outcome: 'selected',
      definitionRef: {
        definitionId: 'experiments/gate-2702-c5',
        definitionVersion: 1,
        contentDigest: PINNED_DIGEST
      },
      trialId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f443',
      selectedHarness: 'claude-code',
      adapterBinding: {
        adapterId: 'gate-2702-claude-code-adapter',
        behaviorFingerprintDigest: EMPTY_SHA256
      },
      planSlots: GATE_2702_C5_PLAN.planSlots.filter(
        (slot) => slot.treatmentId === 'haiku-solo'
      )
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.planSlots)).toBe(true);

    const sidekickBinding = createGate2702C5SelectionBinding({
      receiptId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f444',
      receiptDigest: EMPTY_SHA256,
      trialId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f443',
      behaviorFingerprintDigest: EMPTY_SHA256,
      treatmentId: 'haiku-sonnet-sidekick'
    });
    expect(binding.planSlots).toHaveLength(6);
    expect(sidekickBinding.planSlots).toHaveLength(6);
    expect(sidekickBinding.planSlots).toEqual(
      GATE_2702_C5_PLAN.planSlots.filter(
        (slot) => slot.treatmentId === 'haiku-sonnet-sidekick'
      )
    );
    expect(
      sidekickBinding.planSlots.some((sidekickSlot) =>
        binding.planSlots.some(
          (controlSlot) => controlSlot.planSlotId === sidekickSlot.planSlotId
        )
      )
    ).toBe(false);

    expect(() =>
      createGate2702C5SelectionBinding({
        receiptId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f442',
        receiptDigest: EMPTY_SHA256,
        trialId: '018f5e38-9e2f-7d22-8c63-54ecfbd0f443',
        behaviorFingerprintDigest: EMPTY_SHA256,
        treatmentId: 'unknown-treatment' as never
      })
    ).toThrowError('unknown gate-2702 treatment: unknown-treatment');
  });

  it('keeps the preregistration seam effect-free', () => {
    const source = readFileSync(
      new URL('./definition.ts', import.meta.url),
      'utf8'
    );
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1]
    );
    expect(imports).toEqual([
      'node:crypto',
      '../../contracts/v1',
      '../../contracts/v1'
    ]);
    expect(source).not.toMatch(/node:fs|node:child_process|child_process/);
    expect(source).not.toMatch(
      /\bfetch\s*\(|\bprocess\.|~\/\.(?:claude|codex)/i
    );
  });
});
