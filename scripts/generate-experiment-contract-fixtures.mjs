import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  withBehaviorFingerprintDigest,
  withDocumentDigest,
} from '../src/lib/experiment-runtime/contracts/v1/canonical.ts'

const OUTPUT_ROOT = fileURLToPath(
  new URL('../fixtures/experiment-runtime/v1/', import.meta.url),
)
const EMPTY_DIGEST = `sha256:${'0'.repeat(64)}`

const FLOWS = [
  'enrollment',
  'race',
  'replay',
  'proof-model-evaluation',
  'speed-background-first',
]
const HARNESSES = ['claude-code', 'codex']

function digest(seed) {
  return `sha256:${createHash('sha256').update(seed).digest('hex')}`
}

function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function instant(offsetMinutes, offsetSeconds = 0) {
  return new Date(
    Date.UTC(2026, 6, 1, 12, offsetMinutes, offsetSeconds),
  ).toISOString()
}

function semantics(id, portability = 'portable') {
  return {
    id,
    version: 1,
    contentDigest: digest(`semantics:${id}:1`),
    portability,
  }
}

const SEMANTICS = {
  workload: semantics('capabilities/workload-selection'),
  intervention: {
    ...semantics('capabilities/treatment-application'),
    interventionOperations: {
      apply: {
        type: 'object',
        additionalProperties: false,
        required: ['flow', 'enabled'],
        properties: {
          flow: { type: 'string', minLength: 1 },
          enabled: { const: true },
        },
      },
    },
  },
  metric: {
    ...semantics('capabilities/metric-collection'),
    collectorOperations: {
      collect: {
        type: 'object',
        additionalProperties: false,
        required: ['clock'],
        properties: { clock: { const: 'monotonic' } },
      },
    },
    usage: {
      measures: ['totalTokens', 'costUsd'],
      enforces: ['totalTokens', 'costUsd'],
    },
  },
  check: {
    ...semantics('capabilities/quality-check'),
    checkOperations: {
      verify: {
        type: 'object',
        additionalProperties: false,
        required: ['minimumScore'],
        properties: {
          minimumScore: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
  safeguards: {
    ...semantics('policies/safeguard-ceiling'),
    safeguardRequestSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['requestId', 'safeguard', 'requestedValue', 'reason'],
      properties: {
        requestId: { type: 'string', minLength: 1 },
        safeguard: { type: 'string', minLength: 1 },
        requestedValue: {},
        reason: { type: 'string', minLength: 1 },
      },
    },
  },
  verdict: {
    ...semantics('policies/paired-effect'),
    verdictParametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['direction', 'minimumEffectMs'],
      properties: {
        direction: { const: 'lower-is-better' },
        minimumEffectMs: { type: 'number', minimum: 0 },
      },
    },
    verdictResultSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['basis', 'parameters'],
      properties: {
        basis: { const: 'policies/paired-effect' },
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['observedDifferenceMs'],
          properties: {
            observedDifferenceMs: { type: 'number' },
          },
        },
      },
    },
    estimators: [{ id: 'estimators/paired-difference', version: 1 }],
  },
}

const REGISTRY = {
  semantics: Object.values(SEMANTICS),
  selectors: FLOWS.map((flow) => ({
    id: `selectors/${flow}`,
    version: 1,
    portability: 'portable',
    parametersSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['flow'],
      properties: { flow: { const: flow } },
    },
  })),
  fingerprintPolicies: [
    {
      id: 'fingerprints/behavior-context',
      version: 1,
      factorIdsByAdapter: {
        'claude-code-adapter': ['context/flow', 'context/harness-config'],
        'codex-adapter': ['context/flow', 'context/harness-config'],
      },
      fingerprintSchemaVersionByAdapter: {
        'claude-code-adapter': 1,
        'codex-adapter': 1,
      },
      harnessByAdapter: {
        'claude-code-adapter': 'claude-code',
        'codex-adapter': 'codex',
      },
    },
  ],
}

function ref(value) {
  return {
    id: value.id,
    version: value.version,
    contentDigest: value.contentDigest,
  }
}

function requirement(value) {
  return { semanticsRef: ref(value) }
}

const CAPABILITY_REFS = [
  ref(SEMANTICS.workload),
  ref(SEMANTICS.intervention),
  ref(SEMANTICS.metric),
  ref(SEMANTICS.check),
]

function buildDefinition(flow, flowIndex) {
  return withDocumentDigest({
    schemaVersion: 1,
    kind: 'ExperimentDefinition',
    definitionId: `experiments/${flow}`,
    definitionVersion: 1,
    contentDigest: EMPTY_DIGEST,
    title: `${flow} portable contract fixture`,
    description: `A deterministic ${flow} fixture used to prove the v1 wire contract across harnesses.`,
    createdAt: instant(flowIndex * 20),
    createdBy: 'fixture-generator',
    portability: { class: 'portable' },
    studyDesign:
      flow === 'proof-model-evaluation'
        ? {
            kind: 'cohort',
            assignment: { kind: 'explicit' },
            minimumRunsPerTreatment: 1,
            maximumRunsPerTreatment: 3,
          }
        : { kind: 'paired' },
    workload: {
      selector: {
        id: `selectors/${flow}`,
        version: 1,
        capability: requirement(SEMANTICS.workload),
        parameters: { flow },
      },
    },
    requiredCapabilities: CAPABILITY_REFS.map((semanticsRef) => ({
      semanticsRef,
    })),
    treatments: [
      {
        id: 'control',
        label: 'Control',
        control: true,
        interventions: [],
      },
      {
        id: 'treatment',
        label: 'Treatment',
        control: false,
        interventions: [
          {
            capability: requirement(SEMANTICS.intervention),
            operation: 'apply',
            value: { flow, enabled: true },
          },
        ],
      },
    ],
    metrics: [
      {
        id: 'metrics/wall-time-ms',
        unit: 'ms',
        scope: 'run',
        basis: 'metrics/terminal-wall-time',
        semanticsVersion: 1,
        collector: {
          capability: requirement(SEMANTICS.metric),
          operation: 'collect',
          parameters: { clock: 'monotonic' },
        },
      },
    ],
    checks: [
      {
        id: 'checks/quality-floor',
        capability: requirement(SEMANTICS.check),
        operation: 'verify',
        parameters: { minimumScore: 0.9 },
      },
    ],
    estimatedUsage: {
      wallTimeMs: 12_000,
      totalTokens: 1_200,
      turns: 8,
      toolCalls: 12,
      costUsd: 0.5,
    },
    limits: {
      wallTimeMs: 30_000,
      totalTokens: 3_000,
      turns: 20,
      toolCalls: 40,
      costUsd: 2,
    },
    safeguards: {
      policy: ref(SEMANTICS.safeguards),
      relaxationRequests: [],
    },
    verdictPolicy: {
      ...ref(SEMANTICS.verdict),
      parameters: {
        direction: 'lower-is-better',
        minimumEffectMs: 500,
      },
    },
    extensions: { 'fixtures/flow': flow },
  })
}

function definitionRef(definition) {
  return {
    definitionId: definition.definitionId,
    definitionVersion: definition.definitionVersion,
    contentDigest: definition.contentDigest,
  }
}

function buildFingerprint(flow, harness, observedAt) {
  return withBehaviorFingerprintDigest({
    schemaVersion: 1,
    policy: { id: 'fingerprints/behavior-context', version: 1 },
    digest: EMPTY_DIGEST,
    observedAt,
    completeness: 'complete',
    runtime: {
      id: 'experiment-runtime/reference',
      behaviorVersion: '1.0.0',
    },
    adapter: {
      id: `${harness}-adapter`,
      behaviorVersion: 'fixture-1',
      fingerprintSchemaVersion: 1,
    },
    model: {
      qualifiedId:
        harness === 'claude-code'
          ? 'anthropic/claude-sonnet'
          : 'openai/gpt-codex',
      revision: 'fixture',
    },
    factors: [
      {
        id: 'context/flow',
        valueDigest: digest(`factor:flow:${flow}`),
        displayValue: flow,
      },
      {
        id: 'context/harness-config',
        valueDigest: digest(`factor:harness:${harness}`),
        displayValue: `${harness} fixture config`,
      },
    ],
  })
}

function buildRun({
  definition,
  flow,
  flowIndex,
  harness,
  harnessIndex,
  treatmentId,
  treatmentIndex,
}) {
  const sequence = flowIndex * 100 + harnessIndex * 10 + treatmentIndex + 1
  const selectionSequence = flowIndex * 10 + harnessIndex
  const createdAt = instant(flowIndex * 20 + harnessIndex * 5 + treatmentIndex * 2)
  const startedAt = instant(
    flowIndex * 20 + harnessIndex * 5 + treatmentIndex * 2,
    10,
  )
  const finishedAt = instant(
    flowIndex * 20 + harnessIndex * 5 + treatmentIndex * 2,
    40,
  )
  const sessionRef = {
    harness,
    sourceId: 'local',
    sessionId: `shared-session-${flow}-${treatmentId}`,
  }
  const evidenceRef = {
    kind: 'session',
    contentDigest: digest(`session:${flow}:${harness}:${treatmentId}`),
    sessionRef,
  }

  return withDocumentDigest({
    schemaVersion: 1,
    kind: 'ExperimentRun',
    runId: uuid(10_000 + sequence),
    trialId: uuid(20_000 + flowIndex * 10 + harnessIndex),
    contentDigest: EMPTY_DIGEST,
    definitionRef: definitionRef(definition),
    treatmentId,
    retryOf: null,
    status: 'succeeded',
    createdAt,
    startedAt,
    finishedAt,
    subjectRef: {
      harness,
      sourceId: 'local',
      artifactId: `shared-subject-${flow}`,
      contentDigest: digest(`subject:${flow}:${harness}`),
      mediaType: 'application/json',
    },
    assignment:
      flow === 'proof-model-evaluation'
        ? { kind: 'explicit' }
        : { kind: 'paired' },
    selectedHarness: harness,
    harnessProvenance: {
      origin:
        flow === 'race'
          ? harness === 'claude-code'
            ? 'codex'
            : 'claude-code'
          : harness,
      driver: harness,
      worker: harness,
      judge: harness,
    },
    selectionRef: {
      receiptId: uuid(30_000 + selectionSequence),
      receiptDigest: digest(`selection:${flow}:${harness}`),
      planSlotId: treatmentId,
    },
    triggerRef:
      flow === 'enrollment' || flow === 'speed-background-first'
        ? {
            receiptId: uuid(40_000 + sequence),
            receiptDigest: digest(
              `trigger:${flow}:${harness}:${treatmentId}`,
            ),
          }
        : null,
    behaviorFingerprint: buildFingerprint(
      flow,
      harness,
      instant(flowIndex * 20 + harnessIndex * 5),
    ),
    capabilitySnapshot: CAPABILITY_REFS.map((semanticsRef) => ({
      semanticsRef,
      state: 'available',
      observedAt: createdAt,
      validUntil: instant(flowIndex * 20 + harnessIndex * 5 + 10),
    })),
    effectiveLimits: { ...definition.limits },
    safeguardAuthorizations: [],
    sessionRef,
    observations: [
      {
        metricId: 'metrics/wall-time-ms',
        value: treatmentId === 'control' ? 10_000 : 7_500,
        unit: 'ms',
        scope: 'run',
        basis: 'metrics/terminal-wall-time',
        semanticsVersion: 1,
        confidence: 'high',
        observedAt: instant(
          flowIndex * 20 + harnessIndex * 5 + treatmentIndex * 2,
          30,
        ),
        evidenceRefs: [evidenceRef],
      },
    ],
    checkResults: [
      {
        checkId: 'checks/quality-floor',
        outcome: 'passed',
        startedAt: instant(
          flowIndex * 20 + harnessIndex * 5 + treatmentIndex * 2,
          20,
        ),
        finishedAt: instant(
          flowIndex * 20 + harnessIndex * 5 + treatmentIndex * 2,
          25,
        ),
        evidenceRefs: [evidenceRef],
      },
    ],
    usage: {
      wallTimeMs: treatmentId === 'control' ? 10_000 : 7_500,
      totalTokens: treatmentId === 'control' ? 1_000 : 700,
      turns: treatmentId === 'control' ? 7 : 5,
      toolCalls: treatmentId === 'control' ? 10 : 7,
      costUsd: treatmentId === 'control' ? 0.4 : 0.25,
    },
    error: null,
    extensions: { 'fixtures/flow': flow },
  })
}

function buildFailedReplayRun(run) {
  const failed = structuredClone(run)
  failed.status = 'failed'
  failed.observations = []
  failed.checkResults = []
  failed.error = {
    code: 'runtime/worker-failed',
    message: 'Deterministic replay fixture failure before evidence collection.',
    evidenceRefs: [
      {
        kind: 'session',
        contentDigest: digest(`failed:${run.runId}`),
        sessionRef: failed.sessionRef,
      },
    ],
  }
  return withDocumentDigest(failed)
}

function buildReplayRetry(template, parent, flowIndex, harnessIndex) {
  const retry = structuredClone(template)
  retry.runId = uuid(90_000 + flowIndex * 10 + harnessIndex)
  retry.retryOf = runRef(parent)
  retry.selectionRef.planSlotId = 'treatment-retry-1'
  retry.createdAt = instant(flowIndex * 20 + harnessIndex * 5 + 3)
  retry.startedAt = instant(flowIndex * 20 + harnessIndex * 5 + 3, 10)
  retry.finishedAt = instant(flowIndex * 20 + harnessIndex * 5 + 3, 40)
  retry.sessionRef.sessionId = 'shared-session-replay-treatment-retry-1'
  retry.observations[0].observedAt = instant(
    flowIndex * 20 + harnessIndex * 5 + 3,
    30,
  )
  retry.checkResults[0].startedAt = instant(
    flowIndex * 20 + harnessIndex * 5 + 3,
    20,
  )
  retry.checkResults[0].finishedAt = instant(
    flowIndex * 20 + harnessIndex * 5 + 3,
    25,
  )
  for (const evidence of [
    ...retry.observations[0].evidenceRefs,
    ...retry.checkResults[0].evidenceRefs,
  ]) {
    evidence.sessionRef = retry.sessionRef
    evidence.contentDigest = digest(`retry:${retry.runId}`)
  }
  return withDocumentDigest(retry)
}

function runRef(run) {
  return { runId: run.runId, contentDigest: run.contentDigest }
}

function buildVerdict({ definition, flow, flowIndex, harness, harnessIndex, runs }) {
  const sequence = flowIndex * 10 + harnessIndex
  const createdAt = instant(flowIndex * 20 + harnessIndex * 5 + 4)
  const includedRuns = runs.filter((run) => run.status === 'succeeded')
  const excludedRuns = runs
    .filter((run) => run.status !== 'succeeded')
    .map((run) => ({ run: runRef(run), reason: 'runtime/retry-superseded' }))
  return withDocumentDigest({
    schemaVersion: 1,
    kind: 'ExperimentVerdict',
    verdictId: uuid(50_000 + sequence),
    trialId: runs[0].trialId,
    contentDigest: EMPTY_DIGEST,
    definitionRef: definitionRef(definition),
    policy: ref(SEMANTICS.verdict),
    evidence: {
      includedRuns: includedRuns.map(runRef),
      excludedRuns,
    },
    outcome: { kind: 'winner', winningTreatmentId: 'treatment' },
    policyResult: {
      basis: 'policies/paired-effect',
      parameters: { observedDifferenceMs: 2_500 },
    },
    evidenceBasis: {
      evidenceHarness: harness,
      satisfiedCapabilitySemantics: CAPABILITY_REFS,
    },
    primaryEffect: {
      contrast: {
        controlTreatmentId: 'control',
        treatmentId: 'treatment',
      },
      metricRef: { id: 'metrics/wall-time-ms', semanticsVersion: 1 },
      estimator: { id: 'estimators/paired-difference', version: 1 },
      scale: 'absolute',
      unit: 'ms',
      estimate: 2_500,
      uncertainty: {
        kind: 'interval',
        level: 0.95,
        lower: 2_000,
        upper: 3_000,
      },
      sampleCounts: [
        { treatmentId: 'control', n: 1 },
        { treatmentId: 'treatment', n: 1 },
      ],
    },
    judge: {
      harness,
      sessionRef: {
        harness,
        sourceId: 'local',
        sessionId: `judge-${flow}`,
      },
    },
    createdAt,
    updatedAt: createdAt,
    updateReason: 'Initial deterministic fixture verdict.',
    extensions: { 'fixtures/flow': flow },
  })
}

export function buildValidCorpus() {
  const bundles = []
  FLOWS.forEach((flow, flowIndex) => {
    const definition = buildDefinition(flow, flowIndex)
    HARNESSES.forEach((harness, harnessIndex) => {
      const runs = ['control', 'treatment'].map((treatmentId, treatmentIndex) =>
        buildRun({
          definition,
          flow,
          flowIndex,
          harness,
          harnessIndex,
          treatmentId,
          treatmentIndex,
        }),
      )
      if (flow === 'replay' && harness === 'claude-code') {
        const failed = buildFailedReplayRun(runs[1])
        const retry = buildReplayRetry(
          runs[1],
          failed,
          flowIndex,
          harnessIndex,
        )
        runs.splice(1, 1, failed, retry)
      }
      bundles.push({
        flow,
        harness,
        registry: REGISTRY,
        definition,
        selectionReceipts: [
          {
            receiptId: runs[0].selectionRef.receiptId,
            receiptDigest: runs[0].selectionRef.receiptDigest,
            outcome: 'selected',
            definitionRef: definitionRef(definition),
            trialId: runs[0].trialId,
            selectedHarness: harness,
            adapterBinding: {
              adapterId: runs[0].behaviorFingerprint.adapter.id,
              behaviorFingerprintDigest: runs[0].behaviorFingerprint.digest,
            },
            planSlots: runs.map((run) => ({
              planSlotId: run.selectionRef.planSlotId,
              kind: 'treatment-run',
              treatmentId: run.treatmentId,
            })),
          },
        ],
        triggerReceipts: runs
          .filter((run) => run.triggerRef !== null)
          .map((run) => ({
            receiptId: run.triggerRef.receiptId,
            receiptDigest: run.triggerRef.receiptDigest,
            outcome: 'admitted',
            definitionRef: definitionRef(definition),
            trialId: run.trialId,
            selectedHarness: harness,
          })),
        operatorSafeguardAuthorizations: [],
        runs,
        verdict: buildVerdict({
          definition,
          flow,
          flowIndex,
          harness,
          harnessIndex,
          runs,
        }),
      })
    })
  })
  return bundles
}

export function buildInvalidCases() {
  const base = 'valid/enrollment.claude-code.json'
  return [
    {
      name: 'unknown-field',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'none',
      expectedCode: 'schema.additional-properties',
      mutations: [{ op: 'add', path: '/surprise', value: true }],
    },
    {
      name: 'invalid-enum',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'none',
      expectedCode: 'schema.enum',
      mutations: [{ op: 'replace', path: '/status', value: 'running' }],
    },
    {
      name: 'malformed-identity',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'none',
      expectedCode: 'schema.pattern',
      mutations: [{ op: 'replace', path: '/runId', value: 'not-a-uuid' }],
    },
    {
      name: 'non-canonical-number',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'none',
      expectedCode: 'json.negative-zero',
      mutations: [
        {
          op: 'replace',
          path: '/usage/wallTimeMs',
          value: { $special: 'negative-zero' },
        },
      ],
    },
    {
      name: 'missing-provenance',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'none',
      expectedCode: 'schema.required',
      mutations: [{ op: 'remove', path: '/harnessProvenance/driver' }],
    },
    {
      name: 'provenance-disagrees-with-binding',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'run.provenance-mismatch',
      mutations: [
        {
          op: 'replace',
          path: '/harnessProvenance/driver',
          value: 'codex',
        },
      ],
    },
    {
      name: 'stale-capability-semantics',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'capability.not-available',
      mutations: [
        {
          op: 'replace',
          path: '/capabilitySnapshot/0/state',
          value: 'stale',
        },
      ],
    },
    {
      name: 'missing-evidence',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'none',
      expectedCode: 'schema.min-items',
      mutations: [
        {
          op: 'replace',
          path: '/observations/0/evidenceRefs',
          value: [],
        },
      ],
    },
    {
      name: 'invalid-behavior-fingerprint',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'fingerprint.digest-mismatch',
      mutations: [
        {
          op: 'replace',
          path: '/behaviorFingerprint/factors/0/valueDigest',
          value: digest('tampered-factor'),
        },
      ],
    },
    {
      name: 'retry-parent-missing',
      contract: 'run',
      base,
      target: '/runs/1',
      recompute: 'document',
      expectedCode: 'retry.parent-missing',
      mutations: [
        {
          op: 'replace',
          path: '/retryOf',
          value: {
            runId: uuid(999_999),
            contentDigest: digest('missing-retry-parent'),
          },
        },
      ],
    },
    {
      name: 'retry-boundary-mismatch',
      contract: 'run',
      base,
      target: '/runs/1',
      recompute: 'document',
      expectedCode: 'retry.boundary-mismatch',
      mutations: [
        {
          op: 'copy-run-ref',
          path: '/retryOf',
          from: '/runs/0',
        },
      ],
    },
    {
      name: 'verdict-source-digest-mismatch',
      contract: 'verdict',
      base,
      target: '/verdict',
      recompute: 'document',
      expectedCode: 'verdict.run-digest-mismatch',
      mutations: [
        {
          op: 'replace',
          path: '/evidence/includedRuns/0/contentDigest',
          value: digest('wrong-source-run'),
        },
      ],
    },
    {
      name: 'immutable-run-identity-collision',
      contract: 'run',
      base,
      target: '/runs/1',
      recompute: 'document',
      expectedCode: 'run.identity-collision',
      mutations: [
        {
          op: 'replace',
          path: '/runId',
          value: uuid(10_001),
        },
      ],
    },
    {
      name: 'capability-semantics-digest-mismatch',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'capability.semantics-digest-mismatch',
      mutations: [
        {
          op: 'replace',
          path: '/capabilitySnapshot/0/semanticsRef/contentDigest',
          value: digest('wrong-capability-semantics'),
        },
      ],
    },
    {
      name: 'hard-limit-omitted',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'run.effective-limit-loosened',
      mutations: [{ op: 'remove', path: '/effectiveLimits/totalTokens' }],
    },
    {
      name: 'limited-usage-omitted',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'run.usage-missing',
      mutations: [{ op: 'remove', path: '/usage/totalTokens' }],
    },
    {
      name: 'retry-self-cycle',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'retry.self-cycle',
      mutations: [
        {
          op: 'copy-run-ref',
          path: '/retryOf',
          from: '/runs/0',
        },
      ],
    },
    {
      name: 'conclusive-verdict-missing-primary-effect',
      contract: 'verdict',
      base,
      target: '/verdict',
      recompute: 'document',
      expectedCode: 'verdict.primary-effect-required',
      mutations: [{ op: 'replace', path: '/primaryEffect', value: null }],
    },
    {
      name: 'authoritative-cross-harness-applicability',
      contract: 'verdict',
      base,
      target: '/verdict',
      recompute: 'none',
      expectedCode: 'schema.additional-properties',
      mutations: [
        {
          op: 'add',
          path: '/applicability',
          value: { harnesses: ['codex'] },
        },
      ],
    },
    {
      name: 'secret-like-fingerprint-display',
      contract: 'run',
      base,
      target: '/runs/0',
      recompute: 'document',
      expectedCode: 'fingerprint.secret-like-display',
      mutations: [
        {
          op: 'replace',
          path: '/behaviorFingerprint/factors/0/displayValue',
          value: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      ],
    },
  ]
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function buildVerdictCorrectionFixtures(valid) {
  const base = valid.find(
    (bundle) =>
      bundle.flow === 'enrollment' && bundle.harness === 'claude-code',
  )
  if (!base) throw new Error('missing enrollment Claude fixture')

  const corrected = structuredClone(base.verdict)
  corrected.updatedAt = new Date(
    Date.parse(corrected.updatedAt) + 60_000,
  ).toISOString()
  corrected.updateReason = 'corrected evidence accounting'
  const validCorrection = withDocumentDigest(corrected)
  return {
    base: 'valid/enrollment.claude-code.json',
    valid: validCorrection,
    invalid: [
      {
        name: 'replacement-verdict-id-changed',
        expectedCode: 'verdict.replacement-id-mismatch',
        verdict: withDocumentDigest({
          ...structuredClone(validCorrection),
          verdictId: uuid(99_998),
        }),
      },
      {
        name: 'replacement-created-at-changed',
        expectedCode: 'verdict.replacement-created-at-mismatch',
        verdict: withDocumentDigest({
          ...structuredClone(validCorrection),
          createdAt: new Date(
            Date.parse(validCorrection.createdAt) + 1_000,
          ).toISOString(),
        }),
      },
      {
        name: 'replacement-updated-at-not-advanced',
        expectedCode: 'verdict.replacement-not-newer',
        verdict: withDocumentDigest({
          ...structuredClone(base.verdict),
          updateReason: 'attempted correction without a newer timestamp',
        }),
      },
    ],
  }
}

export function writeCorpus() {
  const validRoot = `${OUTPUT_ROOT}valid`
  mkdirSync(validRoot, { recursive: true })
  const valid = buildValidCorpus()
  for (const bundle of valid) {
    writeJson(`${validRoot}/${bundle.flow}.${bundle.harness}.json`, bundle)
  }
  const invalid = buildInvalidCases()
  const corrections = buildVerdictCorrectionFixtures(valid)
  writeJson(`${OUTPUT_ROOT}invalid-cases.json`, invalid)
  writeJson(`${OUTPUT_ROOT}verdict-corrections.json`, corrections)
  writeJson(`${OUTPUT_ROOT}manifest.json`, {
    schemaVersion: 1,
    valid: valid.map(({ flow, harness, runs }) => ({
      flow,
      harness,
      path: `valid/${flow}.${harness}.json`,
      runCount: runs.length,
      verdictCount: 1,
    })),
    invalid: invalid.map(({ name, expectedCode }) => ({ name, expectedCode })),
    corrections: {
      path: 'verdict-corrections.json',
      validCount: 1,
      invalidCount: corrections.invalid.length,
    },
  })
  writeFileSync(
    `${OUTPUT_ROOT}type-witness.ts`,
    `/* Generated by scripts/generate-experiment-contract-fixtures.mjs. */\n` +
      `import type { ContractRegistryV1, OperatorSafeguardAuthorizationV1, SelectionReceiptBindingV1, TriggerReceiptBindingV1 } from '../../../src/lib/experiment-runtime/contracts/v1/codec';\n` +
      `import type { ExperimentDefinition, ExperimentRun, ExperimentVerdict } from '../../../src/lib/experiment-runtime/contracts/v1/types';\n\n` +
      `interface FixtureTypeWitness {\n` +
      `  flow: string;\n` +
      `  harness: string;\n` +
      `  registry: ContractRegistryV1;\n` +
      `  definition: ExperimentDefinition;\n` +
      `  selectionReceipts: SelectionReceiptBindingV1[];\n` +
      `  triggerReceipts: TriggerReceiptBindingV1[];\n` +
      `  operatorSafeguardAuthorizations: OperatorSafeguardAuthorizationV1[];\n` +
      `  runs: ExperimentRun[];\n` +
      `  verdict: ExperimentVerdict;\n` +
      `}\n\n` +
      `export const fixtureTypeWitnesses = ${JSON.stringify(valid, null, 2)} satisfies FixtureTypeWitness[];\n\n` +
      `export const verdictCorrectionTypeWitness = ${JSON.stringify(corrections, null, 2)} satisfies { base: string; valid: ExperimentVerdict; invalid: Array<{ name: string; expectedCode: string; verdict: ExperimentVerdict }> };\n`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeCorpus()
}
