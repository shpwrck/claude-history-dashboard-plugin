import { createHash } from 'node:crypto';

import {
  canonicalJson,
  decodeDefinitionV1,
  EMPTY_SHA256,
  withDocumentDigest
} from '../../contracts/v1';
import type {
  ContractIssue,
  ContractRegistryV1,
  DefinitionRef,
  ExperimentDefinition,
  JsonObject,
  JsonSchema,
  RegisteredSemantics,
  SelectionReceiptBindingV1,
  Sha256Digest
} from '../../contracts/v1';

export const GATE_2702_C5_DEFINITION_ID = 'experiments/gate-2702-c5';
export const GATE_2702_C5_DEFINITION_VERSION = 1;
export const GATE_2702_C5_HARNESS = 'claude-code';

export const GATE_2702_C5_SUBJECTS = [
  2760, 2719, 2713, 2706, 2710, 2670
] as const;

export const GATE_2702_C5_TREATMENTS = [
  { id: 'haiku-solo', label: 'Haiku solo', control: true },
  {
    id: 'haiku-sonnet-sidekick',
    label: 'Haiku plus Sonnet Sidekick',
    control: false
  }
] as const;

export const GATE_2702_C5_METRIC_IDS = [
  'metrics/gate-2702-all-in-cost',
  'metrics/gate-2702-wall-time',
  'metrics/gate-2702-quality-loss',
  'metrics/gate-2702-sidekick-triggers',
  'metrics/gate-2702-sidekick-paid-calls',
  'metrics/gate-2702-sidekick-shipped-interventions',
  'metrics/gate-2702-attributable-ships'
] as const;

export const GATE_2702_C5_CHECK_IDS = [
  'checks/gate-2702-vitest',
  'checks/gate-2702-typecheck'
] as const;

export const GATE_2702_C5_LIMITS = {
  wallTimeMs: 3_000_000,
  costUsd: 18
} as const;

export const GATE_2702_C5_COST_CAPS = {
  workerUsd: 15,
  sidekickSessionUsd: 2,
  sidekickPerCallUsd: 1,
  // Sidekick checks its session budget before a call, so one final bounded
  // call may cross $2. The strict all-in Run ceiling therefore rounds to $18.
  allInUsd: 18
} as const;

export const GATE_2702_C5_VERDICT_GATES = {
  parityFloor: { maximumHeavyTaskLosses: 0 },
  netPositiveCost: {
    comparison: 'treatment-all-in-cost-lt-control-all-in-cost'
  },
  attributableShips: {
    minimumAttributableTreatmentWins: 1,
    requireShippedInterventionForEveryTreatmentWin: true
  },
  minimumSample: { runsPerTreatment: 6 }
} as const;

export const GATE_2702_C5_PAIRING_RULE = {
  key: 'subjectRef',
  requireBothTreatments: true,
  excludeIncompletePairs: true
} as const;

export const GATE_2702_C5_JUDGE_PROTOCOL = {
  mode: 'blind-position-swapped',
  armOrders: ['forward', 'swapped'],
  agreementRequired: true,
  objectiveChecksAuthoritative: true,
  retries: {
    retryableFailureClasses: ['timeout', 'non-json', 'schema-invalid'],
    maximumAdditionalAttempts: 2
  }
} satisfies JsonObject;

export const GATE_2702_C5_PRIMARY_EFFECT = {
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
} as const;

export const GATE_2702_C5_VERDICT_PARAMETERS = {
  ...GATE_2702_C5_VERDICT_GATES,
  pairing: GATE_2702_C5_PAIRING_RULE,
  judgeProtocol: GATE_2702_C5_JUDGE_PROTOCOL,
  primaryEffect: GATE_2702_C5_PRIMARY_EFFECT
} satisfies JsonObject;

const CONTROL_CONFIGURATION = {
  workerTier: 'haiku',
  workerBudgetUsd: GATE_2702_C5_COST_CAPS.workerUsd,
  sidekick: {
    enabled: false,
    sessionBudgetUsd: 0,
    perCallBudgetUsd: 0
  }
} as const;

const TREATMENT_CONFIGURATION = {
  workerTier: 'haiku',
  workerBudgetUsd: GATE_2702_C5_COST_CAPS.workerUsd,
  sidekick: {
    enabled: true,
    reviewerTier: 'sonnet',
    gate: 'checkpoint',
    sessionBudgetUsd: GATE_2702_C5_COST_CAPS.sidekickSessionUsd,
    perCallBudgetUsd: GATE_2702_C5_COST_CAPS.sidekickPerCallUsd
  }
} as const;

const CHECK_PARAMETERS = [
  {
    argv: ['npx', 'vitest', 'run'],
    timeoutMs: 720_000
  },
  {
    argv: ['npm', 'run', 'typecheck'],
    timeoutMs: 360_000
  }
] as const;

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function semanticsDigest(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(value), 'utf8')
    .digest('hex')}`;
}

/** Build exact schemas without object-valued const/enum (#2838). */
function literalSchema(value: unknown): JsonSchema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      minItems: value.length,
      maxItems: value.length,
      prefixItems: value.map(literalSchema),
      items: false
    };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(value),
      properties: Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, literalSchema(child)])
      )
    };
  }
  return { const: value };
}

function registerSemantics(
  value: Omit<RegisteredSemantics, 'contentDigest'>,
  digestSource: unknown = value
): RegisteredSemantics {
  return deepFreeze({ ...value, contentDigest: semanticsDigest(digestSource) });
}

function capability(semantics: RegisteredSemantics) {
  return {
    semanticsRef: {
      id: semantics.id,
      version: semantics.version,
      contentDigest: semantics.contentDigest
    }
  };
}

const WORKLOAD_SELECTOR_PARAMETERS = {
  repository: 'shpwrck/claude-history-dashboard',
  weight: 'heavy',
  issues: GATE_2702_C5_SUBJECTS
} as const;

const WORKLOAD_SEMANTICS_MANIFEST = {
  id: 'capabilities/gate-2702-workload-selection',
  version: 1,
  portability: 'harness-specific'
} as const;

const WORKLOAD_SEMANTICS = registerSemantics(WORKLOAD_SEMANTICS_MANIFEST, {
  semantics: WORKLOAD_SEMANTICS_MANIFEST,
  selector: {
    id: 'selectors/gate-2702-c5-heavy-issues',
    version: 1,
    parameters: WORKLOAD_SELECTOR_PARAMETERS
  }
});

export const GATE_2702_C5_FINGERPRINT_POLICY = {
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
    'gate-2702-claude-code-adapter': GATE_2702_C5_HARNESS
  }
} as const;

const FINGERPRINT_SEMANTICS_MANIFEST = {
  id: 'capabilities/gate-2702-behavior-fingerprint',
  version: 1,
  portability: 'harness-specific'
} as const;

const FINGERPRINT_SEMANTICS = registerSemantics(
  FINGERPRINT_SEMANTICS_MANIFEST,
  {
    semantics: FINGERPRINT_SEMANTICS_MANIFEST,
    fingerprintPolicy: GATE_2702_C5_FINGERPRINT_POLICY
  }
);

const TREATMENT_SEMANTICS = registerSemantics({
  id: 'capabilities/gate-2702-treatment-application',
  version: 1,
  portability: 'harness-specific',
  // The v1 codec uses this marker, together with allowsHarnessComparison on
  // the Verdict policy, to admit the treatment-induced fingerprint change.
  selectedHarnessOperations: ['configure'],
  interventionOperations: {
    configure: {
      oneOf: [
        literalSchema(CONTROL_CONFIGURATION),
        literalSchema(TREATMENT_CONFIGURATION)
      ]
    }
  },
  usage: {
    measures: [],
    enforces: ['costUsd']
  }
});

const METRIC_SEMANTICS = registerSemantics({
  id: 'capabilities/gate-2702-metric-collection',
  version: 1,
  portability: 'harness-specific',
  collectorOperations: {
    collect: {
      type: 'object',
      additionalProperties: false,
      required: ['metric', 'source'],
      properties: {
        metric: { enum: GATE_2702_C5_METRIC_IDS },
        source: { const: 'sealed-c5-run' }
      }
    }
  },
  usage: {
    measures: ['costUsd'],
    enforces: []
  }
});

const CHECK_SEMANTICS = registerSemantics({
  id: 'capabilities/gate-2702-objective-checks',
  version: 1,
  portability: 'harness-specific',
  checkOperations: {
    run: {
      oneOf: CHECK_PARAMETERS.map(literalSchema)
    }
  }
});

const SAFEGUARD_POLICY = registerSemantics({
  id: 'policies/gate-2702-safeguard-ceiling',
  version: 1,
  portability: 'harness-specific'
});

const VERDICT_POLICY = registerSemantics({
  id: 'policies/gate-2702-c5-graduation',
  version: 1,
  portability: 'harness-specific',
  allowsHarnessComparison: true,
  verdictParametersSchema: literalSchema(GATE_2702_C5_VERDICT_PARAMETERS),
  verdictResultSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['basis', 'parameters'],
    properties: {
      basis: { const: 'policies/gate-2702-c5-graduation' },
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'gates'],
        properties: {
          decision: {
            enum: [
              'sidekick-clears',
              'sidekick-does-not-clear',
              'inconclusive',
              'invalid'
            ]
          },
          gates: {
            type: 'object',
            additionalProperties: false,
            required: [
              'parityFloor',
              'netPositiveCost',
              'attributableShips',
              'minimumSample'
            ],
            properties: {
              parityFloor: { $ref: '#/$defs/gateResult' },
              netPositiveCost: { $ref: '#/$defs/gateResult' },
              attributableShips: { $ref: '#/$defs/gateResult' },
              minimumSample: { $ref: '#/$defs/gateResult' }
            }
          }
        }
      }
    },
    $defs: {
      gateResult: {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'basis', 'observed'],
        properties: {
          state: { enum: ['passed', 'failed', 'not-evaluable'] },
          basis: { type: 'string', minLength: 1 },
          observed: { type: 'object' }
        }
      }
    }
  },
  estimators: [{ id: 'estimators/gate-2702-c5-graduation', version: 1 }]
});

export const GATE_2702_C5_CONTRACT_REGISTRY: ContractRegistryV1 = deepFreeze({
  semantics: [
    WORKLOAD_SEMANTICS,
    FINGERPRINT_SEMANTICS,
    TREATMENT_SEMANTICS,
    METRIC_SEMANTICS,
    CHECK_SEMANTICS,
    SAFEGUARD_POLICY,
    VERDICT_POLICY
  ],
  selectors: [
    {
      id: 'selectors/gate-2702-c5-heavy-issues',
      version: 1,
      portability: 'harness-specific',
      parametersSchema: literalSchema(WORKLOAD_SELECTOR_PARAMETERS)
    }
  ],
  fingerprintPolicies: [GATE_2702_C5_FINGERPRINT_POLICY]
});

function metric(
  id: (typeof GATE_2702_C5_METRIC_IDS)[number],
  unit: 'usd' | 'ms' | 'count',
  scope: 'run' | 'subject',
  basis: string
) {
  return {
    id,
    unit,
    scope,
    basis,
    semanticsVersion: 1,
    collector: {
      capability: capability(METRIC_SEMANTICS),
      operation: 'collect',
      parameters: { metric: id, source: 'sealed-c5-run' }
    }
  };
}

function buildDefinition(): ExperimentDefinition {
  const candidate: ExperimentDefinition = {
    schemaVersion: 1,
    kind: 'ExperimentDefinition',
    definitionId: GATE_2702_C5_DEFINITION_ID,
    definitionVersion: GATE_2702_C5_DEFINITION_VERSION,
    contentDigest: EMPTY_SHA256,
    title: '#2702 C5 Haiku Sidekick ablation',
    description:
      'A fixed heavy-task comparison of Haiku solo against Haiku with the Sonnet Sidekick at the checkpoint gate.',
    createdAt: '2026-07-20T15:00:00.000Z',
    createdBy: 'github:shpwrck/claude-history-dashboard/issues/2818',
    portability: {
      class: 'harness-specific',
      allowedHarnesses: [GATE_2702_C5_HARNESS]
    },
    studyDesign: {
      kind: 'cohort',
      assignment: { kind: 'explicit' },
      minimumRunsPerTreatment: 6,
      maximumRunsPerTreatment: 6
    },
    workload: {
      selector: {
        id: 'selectors/gate-2702-c5-heavy-issues',
        version: 1,
        capability: capability(WORKLOAD_SEMANTICS),
        parameters: {
          ...WORKLOAD_SELECTOR_PARAMETERS,
          issues: [...GATE_2702_C5_SUBJECTS]
        }
      }
    },
    requiredCapabilities: [
      capability(WORKLOAD_SEMANTICS),
      capability(FINGERPRINT_SEMANTICS),
      capability(TREATMENT_SEMANTICS),
      capability(METRIC_SEMANTICS),
      capability(CHECK_SEMANTICS)
    ],
    treatments: [
      {
        ...GATE_2702_C5_TREATMENTS[0],
        interventions: [
          {
            capability: capability(TREATMENT_SEMANTICS),
            operation: 'configure',
            value: CONTROL_CONFIGURATION
          }
        ]
      },
      {
        ...GATE_2702_C5_TREATMENTS[1],
        interventions: [
          {
            capability: capability(TREATMENT_SEMANTICS),
            operation: 'configure',
            value: TREATMENT_CONFIGURATION
          }
        ]
      }
    ],
    metrics: [
      metric(
        'metrics/gate-2702-all-in-cost',
        'usd',
        'run',
        'basis/gate-2702-all-in-cost'
      ),
      metric(
        'metrics/gate-2702-wall-time',
        'ms',
        'run',
        'basis/gate-2702-monotonic-wall-time'
      ),
      metric(
        'metrics/gate-2702-quality-loss',
        'count',
        'subject',
        'basis/gate-2702-objective-and-blind-quality-loss'
      ),
      metric(
        'metrics/gate-2702-sidekick-triggers',
        'count',
        'run',
        'basis/gate-2702-sidekick-triggers'
      ),
      metric(
        'metrics/gate-2702-sidekick-paid-calls',
        'count',
        'run',
        'basis/gate-2702-sidekick-paid-calls'
      ),
      metric(
        'metrics/gate-2702-sidekick-shipped-interventions',
        'count',
        'run',
        'basis/gate-2702-sidekick-shipped-interventions'
      ),
      metric(
        'metrics/gate-2702-attributable-ships',
        'count',
        'subject',
        'basis/gate-2702-attributable-ships'
      )
    ],
    checks: [
      {
        id: GATE_2702_C5_CHECK_IDS[0],
        capability: capability(CHECK_SEMANTICS),
        operation: 'run',
        parameters: {
          argv: [...CHECK_PARAMETERS[0].argv],
          timeoutMs: CHECK_PARAMETERS[0].timeoutMs
        }
      },
      {
        id: GATE_2702_C5_CHECK_IDS[1],
        capability: capability(CHECK_SEMANTICS),
        operation: 'run',
        parameters: {
          argv: [...CHECK_PARAMETERS[1].argv],
          timeoutMs: CHECK_PARAMETERS[1].timeoutMs
        }
      }
    ],
    estimatedUsage: {
      wallTimeMs: 1_800_000,
      costUsd: 8
    },
    limits: GATE_2702_C5_LIMITS,
    safeguards: {
      policy: {
        id: SAFEGUARD_POLICY.id,
        version: SAFEGUARD_POLICY.version,
        contentDigest: SAFEGUARD_POLICY.contentDigest
      },
      relaxationRequests: []
    },
    verdictPolicy: {
      id: VERDICT_POLICY.id,
      version: VERDICT_POLICY.version,
      contentDigest: VERDICT_POLICY.contentDigest,
      parameters: GATE_2702_C5_VERDICT_PARAMETERS
    },
    extensions: {}
  };

  const decoded = decodeDefinitionV1(withDocumentDigest(candidate), {
    registry: GATE_2702_C5_CONTRACT_REGISTRY
  });
  if (!decoded.ok) {
    throw new Error(
      `invalid checked-in gate-2702 Definition: ${JSON.stringify(decoded.issues)}`
    );
  }
  return decoded.value;
}

export const GATE_2702_C5_DEFINITION = buildDefinition();

const DEFINITION_REF: DefinitionRef = deepFreeze({
  definitionId: GATE_2702_C5_DEFINITION.definitionId,
  definitionVersion: GATE_2702_C5_DEFINITION.definitionVersion,
  contentDigest: GATE_2702_C5_DEFINITION.contentDigest
});

const PLAN_SLOTS = GATE_2702_C5_SUBJECTS.flatMap((subject) =>
  GATE_2702_C5_TREATMENTS.map((treatment) => ({
    planSlotId: `issue-${subject}.${treatment.id}`,
    kind: 'treatment-run' as const,
    treatmentId: treatment.id
  }))
);

export interface Gate2702C5Plan {
  readonly definitionRef: DefinitionRef;
  readonly selectedHarness: typeof GATE_2702_C5_HARNESS;
  readonly subjects: readonly number[];
  readonly treatments: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly control: boolean;
    readonly configuration:
      typeof CONTROL_CONFIGURATION | typeof TREATMENT_CONFIGURATION;
  }>;
  readonly limits: {
    readonly wallTimeMs: number;
    readonly costUsd: number;
  };
  readonly costCaps: typeof GATE_2702_C5_COST_CAPS;
  readonly checks: ReadonlyArray<{
    readonly id: string;
    readonly argv: readonly string[];
    readonly timeoutMs: number;
  }>;
  readonly metricIds: readonly string[];
  readonly verdictParameters: typeof GATE_2702_C5_VERDICT_PARAMETERS;
  readonly planSlots: SelectionReceiptBindingV1['planSlots'];
}

export const GATE_2702_C5_PLAN: Gate2702C5Plan = deepFreeze({
  definitionRef: DEFINITION_REF,
  selectedHarness: GATE_2702_C5_HARNESS,
  subjects: [...GATE_2702_C5_SUBJECTS],
  treatments: [
    {
      ...GATE_2702_C5_TREATMENTS[0],
      configuration: CONTROL_CONFIGURATION
    },
    {
      ...GATE_2702_C5_TREATMENTS[1],
      configuration: TREATMENT_CONFIGURATION
    }
  ],
  limits: { ...GATE_2702_C5_LIMITS },
  costCaps: { ...GATE_2702_C5_COST_CAPS },
  checks: [
    { id: GATE_2702_C5_CHECK_IDS[0], ...CHECK_PARAMETERS[0] },
    { id: GATE_2702_C5_CHECK_IDS[1], ...CHECK_PARAMETERS[1] }
  ],
  metricIds: [...GATE_2702_C5_METRIC_IDS],
  verdictParameters: GATE_2702_C5_VERDICT_PARAMETERS,
  planSlots: PLAN_SLOTS
});

export type Gate2702DefinitionErrorCode =
  | 'definition-invalid'
  | 'definition-id-mismatch'
  | 'definition-version-mismatch'
  | 'definition-digest-mismatch';

export type Gate2702ProjectionResult =
  | {
      readonly ok: true;
      readonly definition: ExperimentDefinition;
      readonly plan: Gate2702C5Plan;
    }
  | {
      readonly ok: false;
      readonly code: Gate2702DefinitionErrorCode;
      readonly issues: readonly ContractIssue[];
    };

function identityIssue(
  code: Gate2702DefinitionErrorCode,
  path: string,
  message: string
): ContractIssue {
  return {
    stage: 'intrinsic',
    code: `gate-2702.${code}`,
    path,
    message
  };
}

/** Decode and accept only the one immutable C5 Definition before any runner side effect. */
export function projectGate2702C5Definition(
  input: unknown
): Gate2702ProjectionResult {
  const decoded = decodeDefinitionV1(input, {
    registry: GATE_2702_C5_CONTRACT_REGISTRY
  });
  if (!decoded.ok) {
    return { ok: false, code: 'definition-invalid', issues: decoded.issues };
  }
  if (decoded.value.definitionId !== GATE_2702_C5_DEFINITION_ID) {
    return {
      ok: false,
      code: 'definition-id-mismatch',
      issues: [
        identityIssue(
          'definition-id-mismatch',
          '$/definitionId',
          'the C5 bridge accepts only its checked-in Definition ID'
        )
      ]
    };
  }
  if (decoded.value.definitionVersion !== GATE_2702_C5_DEFINITION_VERSION) {
    return {
      ok: false,
      code: 'definition-version-mismatch',
      issues: [
        identityIssue(
          'definition-version-mismatch',
          '$/definitionVersion',
          'the C5 bridge accepts only its checked-in Definition version'
        )
      ]
    };
  }
  if (decoded.value.contentDigest !== GATE_2702_C5_DEFINITION.contentDigest) {
    return {
      ok: false,
      code: 'definition-digest-mismatch',
      issues: [
        identityIssue(
          'definition-digest-mismatch',
          '$/contentDigest',
          'the C5 bridge accepts only the checked-in canonical Definition bytes'
        )
      ]
    };
  }
  return {
    ok: true,
    definition: decoded.value,
    plan: GATE_2702_C5_PLAN
  };
}

export interface Gate2702SelectionBindingInput {
  readonly receiptId: string;
  readonly receiptDigest: Sha256Digest;
  readonly trialId: string;
  readonly behaviorFingerprintDigest: Sha256Digest;
  readonly treatmentId: (typeof GATE_2702_C5_TREATMENTS)[number]['id'];
}

/** Build the minimal immutable Selection Receipt binding later Runs must resolve. */
export function createGate2702C5SelectionBinding(
  input: Gate2702SelectionBindingInput
): SelectionReceiptBindingV1 {
  if (
    !GATE_2702_C5_TREATMENTS.some(
      (treatment) => treatment.id === input.treatmentId
    )
  ) {
    throw new TypeError(`unknown gate-2702 treatment: ${input.treatmentId}`);
  }
  return deepFreeze({
    receiptId: input.receiptId,
    receiptDigest: input.receiptDigest,
    outcome: 'selected',
    definitionRef: DEFINITION_REF,
    trialId: input.trialId,
    selectedHarness: GATE_2702_C5_HARNESS,
    adapterBinding: {
      adapterId: 'gate-2702-claude-code-adapter',
      behaviorFingerprintDigest: input.behaviorFingerprintDigest
    },
    // One Receipt binds one fingerprint. Control and treatment therefore get
    // separate Receipts rather than mixing both behavior contexts in one.
    planSlots: PLAN_SLOTS.filter(
      (slot) => slot.treatmentId === input.treatmentId
    ).map((slot) => ({ ...slot }))
  });
}
