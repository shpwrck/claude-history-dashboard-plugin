import {
  CanonicalizationError,
  canonicalDocumentJson,
  canonicalJson,
  computeBehaviorFingerprintDigest,
  computeDocumentDigest,
  normalizeDocument,
  toJsonValue,
} from './canonical';
import {
  validateContractSchema,
  validateRegistrySchema,
} from './schema';
import type { JsonSchema } from './schema';
import type {
  CapabilityRequirement,
  DefinitionRef,
  EvidenceRef,
  ExperimentDefinition,
  ExperimentRun,
  ExperimentVerdict,
  JsonValue,
  RunRef,
  SafeguardRelaxationRequest,
  SemanticsRef,
  Sha256Digest,
  UsageBounds,
} from './types';

export type ContractIssueStage =
  | 'json'
  | 'schema'
  | 'intrinsic'
  | 'definition-registry'
  | 'run-reference'
  | 'verdict-policy';

export interface ContractIssue {
  stage: ContractIssueStage;
  code: string;
  path: string;
  message: string;
}

export type ContractResult<T> =
  | { ok: true; value: T; canonicalJson: string }
  | { ok: false; issues: readonly ContractIssue[] };

declare const validatedRunV1Brand: unique symbol;
declare const validatedVerdictV1Brand: unique symbol;

/** Opaque, immutable Run value returned only after full v1 decoding. */
export type ValidatedExperimentRunV1 = ExperimentRun & {
  readonly [validatedRunV1Brand]: true;
};

/** Opaque, immutable Verdict value returned only after full v1 decoding. */
export type ValidatedExperimentVerdictV1 = ExperimentVerdict & {
  readonly [validatedVerdictV1Brand]: true;
};

const validatedRunValues = new WeakSet<object>();
const validatedVerdictValues = new WeakSet<object>();
const validatedRegistryValues = new WeakSet<object>();

export interface RegisteredSemantics extends SemanticsRef {
  portability: 'portable' | 'harness-specific';
  interventionOperations?: Readonly<Record<string, JsonSchema>>;
  collectorOperations?: Readonly<Record<string, JsonSchema>>;
  checkOperations?: Readonly<Record<string, JsonSchema>>;
  selectedHarnessOperations?: readonly string[];
  safeguardRequestSchema?: JsonSchema;
  verdictParametersSchema?: JsonSchema;
  verdictResultSchema?: JsonSchema;
  estimators?: ReadonlyArray<{ id: string; version: number }>;
  allowsHarnessComparison?: boolean;
  usage?: {
    measures: readonly ('totalTokens' | 'costUsd')[];
    enforces: readonly ('totalTokens' | 'costUsd')[];
  };
}

export interface RegisteredSelectorV1 {
  id: string;
  version: number;
  portability: 'portable' | 'harness-specific';
  parametersSchema: JsonSchema;
}

export interface RegisteredFingerprintPolicyV1 {
  id: string;
  version: number;
  factorIdsByAdapter: Readonly<Record<string, readonly string[]>>;
  fingerprintSchemaVersionByAdapter: Readonly<Record<string, number>>;
  harnessByAdapter: Readonly<Record<string, string>>;
}

/** Resolved immutable subset of a selected operational Receipt (#2610). */
export interface SelectionReceiptBindingV1 {
  receiptId: string;
  receiptDigest: Sha256Digest;
  outcome: 'selected';
  definitionRef: DefinitionRef;
  trialId: string;
  selectedHarness: string;
  adapterBinding: {
    adapterId: string;
    behaviorFingerprintDigest: Sha256Digest;
  };
  planSlots: ReadonlyArray<{
    planSlotId: string;
    kind: 'treatment-run';
    treatmentId: string;
  }>;
}

/** Resolved admitted Trigger Receipt subset; scheduler state remains external. */
export interface TriggerReceiptBindingV1 {
  receiptId: string;
  receiptDigest: Sha256Digest;
  outcome: 'admitted';
  definitionRef: DefinitionRef;
  trialId: string;
  selectedHarness: string;
}

export interface OperatorSafeguardAuthorizationV1 {
  definitionRef: DefinitionRef;
  trialId: string;
  runId: string;
  request: SafeguardRelaxationRequest;
  approvedBy: string;
  approvedAt: string;
  reason: string;
}

/** Immutable registry facts used while validating an exact v1 contract. */
export interface ContractRegistryV1 {
  semantics: readonly RegisteredSemantics[];
  selectors: readonly RegisteredSelectorV1[];
  fingerprintPolicies: readonly RegisteredFingerprintPolicyV1[];
}

export interface DefinitionDecodeContextV1 {
  registry: ContractRegistryV1;
}

export interface RunDecodeContextV1 {
  definition: ExperimentDefinition;
  registry: ContractRegistryV1;
  selectionReceipts: readonly SelectionReceiptBindingV1[];
  triggerReceipts: readonly TriggerReceiptBindingV1[];
  operatorSafeguardAuthorizations: readonly OperatorSafeguardAuthorizationV1[];
  priorRuns: readonly ValidatedExperimentRunV1[];
}

export interface VerdictDecodeContextV1 {
  definition: ExperimentDefinition;
  registry: ContractRegistryV1;
  trialRuns: readonly ValidatedExperimentRunV1[];
  previousVerdict: ValidatedExperimentVerdictV1 | null;
}

function add(
  issues: ContractIssue[],
  stage: ContractIssueStage,
  code: string,
  path: string,
  message: string
): void {
  issues.push({ stage, code, path, message });
}

function sameSemantics(left: SemanticsRef, right: SemanticsRef): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.contentDigest === right.contentDigest
  );
}

function semanticsKey(ref: SemanticsRef): string {
  return `${ref.id}\u0000${ref.version}\u0000${ref.contentDigest}`;
}

function sameDefinitionRef(
  left: DefinitionRef,
  right: DefinitionRef
): boolean {
  return (
    left.definitionId === right.definitionId &&
    left.definitionVersion === right.definitionVersion &&
    left.contentDigest === right.contentDigest
  );
}

function definitionRef(definition: ExperimentDefinition): DefinitionRef {
  return {
    definitionId: definition.definitionId,
    definitionVersion: definition.definitionVersion,
    contentDigest: definition.contentDigest,
  };
}

function timestamp(value: string, path: string, issues: ContractIssue[]): number {
  const parsed = Date.parse(value);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  const year = Number(parts?.[1]);
  const month = Number(parts?.[2]);
  const day = Number(parts?.[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = month >= 1 && month <= 12 ? monthLengths[month - 1] : 0;
  if (!Number.isFinite(parsed) || !parts || day < 1 || day > daysInMonth) {
    add(issues, 'intrinsic', 'timestamp.invalid', path, 'timestamp is not a real UTC instant');
  }
  return parsed;
}

/** Compare structurally valid fixed-offset UTC timestamps without truncating fractions. */
function compareUtcTimestamps(left: string, right: string): number {
  const leftSecond = left.slice(0, 19);
  const rightSecond = right.slice(0, 19);
  if (leftSecond !== rightSecond) {
    return leftSecond < rightSecond ? -1 : 1;
  }
  const leftFraction = /\.([0-9]+)Z$/.exec(left)?.[1] ?? '';
  const rightFraction = /\.([0-9]+)Z$/.exec(right)?.[1] ?? '';
  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, '0');
  const normalizedRight = rightFraction.padEnd(width, '0');
  return normalizedLeft === normalizedRight
    ? 0
    : normalizedLeft < normalizedRight
      ? -1
      : 1;
}

function requireOrder(
  values: Array<{ value: string; path: string }>,
  issues: ContractIssue[]
): void {
  let priorValue: string | undefined;
  let priorParsed = Number.NEGATIVE_INFINITY;
  for (const item of values) {
    const current = timestamp(item.value, item.path, issues);
    if (
      priorValue !== undefined &&
      Number.isFinite(current) &&
      Number.isFinite(priorParsed) &&
      compareUtcTimestamps(item.value, priorValue) < 0
    ) {
      add(
        issues,
        'intrinsic',
        'timestamp.out-of-order',
        item.path,
        'timestamp precedes the prior lifecycle timestamp'
      );
    }
    priorValue = item.value;
    priorParsed = current;
  }
}

function requireUnique<T>(
  values: readonly T[],
  identity: (value: T) => string,
  path: string,
  code: string,
  issues: ContractIssue[]
): void {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const key = identity(values[index]);
    if (seen.has(key)) {
      add(
        issues,
        'intrinsic',
        code,
        `${path}/${index}`,
        `duplicate identity ${JSON.stringify(key)}`
      );
    }
    seen.add(key);
  }
}

function checkDigest(
  document: ExperimentDefinition | ExperimentRun | ExperimentVerdict,
  issues: ContractIssue[],
  path = '$/contentDigest'
): void {
  const expected = computeDocumentDigest(document);
  if (document.contentDigest !== expected) {
    add(
      issues,
      'intrinsic',
      'document.digest-mismatch',
      path,
      `contentDigest does not match canonical document bytes (expected ${expected})`
    );
  }
}

function registryEntry(
  registry: ContractRegistryV1,
  ref: SemanticsRef
): RegisteredSemantics | undefined {
  return registry.semantics.find((candidate) => sameSemantics(candidate, ref));
}

function validateRegistryRef(
  ref: SemanticsRef,
  path: string,
  registry: ContractRegistryV1,
  portable: boolean,
  issues: ContractIssue[]
): void {
  const exact = registryEntry(registry, ref);
  if (!exact) {
    const sameIdentity = registry.semantics.find(
      (candidate) => candidate.id === ref.id && candidate.version === ref.version
    );
    add(
      issues,
      'definition-registry',
      sameIdentity ? 'semantics.digest-mismatch' : 'semantics.unregistered',
      path,
      sameIdentity
        ? 'the registered semantics digest does not match the exact reference'
        : 'the exact semantics reference is not registered'
    );
    return;
  }
  if (portable && exact.portability !== 'portable') {
    add(
      issues,
      'definition-registry',
      'semantics.not-portable',
      path,
      'portable Definitions may reference only portable semantics'
    );
  }
}

function validateRegisteredValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
  code: string,
  issues: ContractIssue[]
): void {
  const validation = validateRegistrySchema(value, schema);
  if (validation.schemaError) {
    add(
      issues,
      'definition-registry',
      'registry.schema-invalid',
      path,
      validation.schemaError
    );
    return;
  }
  for (const schemaIssue of validation.issues) {
    const suffix = schemaIssue.path === '$' ? '' : schemaIssue.path.slice(1);
    add(
      issues,
      'definition-registry',
      code,
      `${path}${suffix}`,
      schemaIssue.message
    );
  }
}

function registeredOperation(
  registry: ContractRegistryV1,
  ref: SemanticsRef,
  role: 'interventionOperations' | 'collectorOperations' | 'checkOperations',
  operation: string
): JsonSchema | undefined {
  const operations = registryEntry(registry, ref)?.[role];
  return operations && Object.hasOwn(operations, operation)
    ? operations[operation]
    : undefined;
}

function capabilityRefs(definition: ExperimentDefinition): SemanticsRef[] {
  const refs: SemanticsRef[] = [];
  const push = (requirement: CapabilityRequirement) =>
    refs.push(requirement.semanticsRef);
  definition.requiredCapabilities.forEach(push);
  push(definition.workload.selector.capability);
  for (const treatment of definition.treatments) {
    treatment.interventions.forEach((intervention) => push(intervention.capability));
  }
  definition.metrics.forEach((metric) => push(metric.collector.capability));
  definition.checks.forEach((check) => push(check.capability));
  return [...new Map(refs.map((ref) => [semanticsKey(ref), ref])).values()];
}

function allowsHarnessVariation(
  definition: ExperimentDefinition,
  registry: ContractRegistryV1
): boolean {
  const policy = registryEntry(registry, definition.verdictPolicy);
  if (policy?.allowsHarnessComparison !== true) return false;
  return definition.treatments.some((treatment) =>
    treatment.interventions.some((intervention) =>
      registryEntry(
        registry,
        intervention.capability.semanticsRef
      )?.selectedHarnessOperations?.includes(intervention.operation)
    )
  );
}

function validateBounds(
  estimated: UsageBounds,
  limits: UsageBounds,
  issues: ContractIssue[]
): void {
  const keys = [
    'wallTimeMs',
    'totalTokens',
    'turns',
    'toolCalls',
    'costUsd',
  ] as const;
  for (const key of keys) {
    const estimate = estimated[key];
    const limit = limits[key];
    if (estimate !== undefined && limit !== undefined && estimate > limit) {
      add(
        issues,
        'intrinsic',
        'usage.estimate-exceeds-limit',
        `$/estimatedUsage/${key}`,
        'estimated usage cannot exceed the corresponding hard limit'
      );
    }
  }
}

function validateDefinitionSemantics(
  definition: ExperimentDefinition,
  context: DefinitionDecodeContextV1,
  issues: ContractIssue[]
): void {
  checkDigest(definition, issues);
  timestamp(definition.createdAt, '$/createdAt', issues);
  requireUnique(
    context.registry.semantics,
    (entry) => `${entry.id}\u0000${entry.version}`,
    '$/registry/semantics',
    'semantics.identity-collision',
    issues
  );
  const semanticsIdentity = new Map<string, string>();
  context.registry.semantics.forEach((entry, index) => {
    const key = `${entry.id}\u0000${entry.version}`;
    const prior = semanticsIdentity.get(key);
    if (prior && prior !== entry.contentDigest) {
      add(
        issues,
        'definition-registry',
        'semantics.identity-collision',
        `$/registry/semantics/${index}`,
        'one semantics ID and version cannot identify multiple digests'
      );
    }
    semanticsIdentity.set(key, entry.contentDigest);
  });
  requireUnique(
    context.registry.selectors,
    (entry) => `${entry.id}\u0000${entry.version}`,
    '$/registry/selectors',
    'selector.identity-collision',
    issues
  );
  requireUnique(
    context.registry.fingerprintPolicies,
    (entry) => `${entry.id}\u0000${entry.version}`,
    '$/registry/fingerprintPolicies',
    'fingerprint.policy-identity-collision',
    issues
  );
  requireUnique(
    definition.treatments,
    (value) => value.id,
    '$/treatments',
    'definition.duplicate-treatment',
    issues
  );
  requireUnique(
    definition.metrics,
    (value) => value.id,
    '$/metrics',
    'definition.duplicate-metric',
    issues
  );
  requireUnique(
    definition.checks,
    (value) => value.id,
    '$/checks',
    'definition.duplicate-check',
    issues
  );
  requireUnique(
    definition.requiredCapabilities,
    (value) => semanticsKey(value.semanticsRef),
    '$/requiredCapabilities',
    'definition.duplicate-capability',
    issues
  );
  requireUnique(
    definition.safeguards.relaxationRequests,
    (value) => value.requestId,
    '$/safeguards/relaxationRequests',
    'definition.duplicate-relaxation',
    issues
  );
  for (let index = 0; index < definition.treatments.length; index++) {
    requireUnique(
      definition.treatments[index].interventions,
      (value) => `${semanticsKey(value.capability.semanticsRef)}\u0000${value.operation}`,
      `$/treatments/${index}/interventions`,
      'definition.duplicate-intervention',
      issues
    );
  }
  const controlCount = definition.treatments.filter((value) => value.control).length;
  if (controlCount !== 1) {
    add(
      issues,
      'intrinsic',
      'definition.control-count',
      '$/treatments',
      `exactly one Treatment must be control; found ${controlCount}`
    );
  }
  if (
    definition.studyDesign.kind === 'cohort' &&
    definition.studyDesign.maximumRunsPerTreatment !== undefined &&
    definition.studyDesign.maximumRunsPerTreatment <
      definition.studyDesign.minimumRunsPerTreatment
  ) {
    add(
      issues,
      'intrinsic',
      'definition.cohort-bounds',
      '$/studyDesign/maximumRunsPerTreatment',
      'maximumRunsPerTreatment must be at least the minimum'
    );
  }
  validateBounds(definition.estimatedUsage, definition.limits, issues);

  const portable = definition.portability.class === 'portable';
  const registryRefs = [
    ...capabilityRefs(definition),
    definition.safeguards.policy,
    definition.verdictPolicy,
  ];
  registryRefs.forEach((ref, index) =>
    validateRegistryRef(
      ref,
      `$/registryRefs/${index}`,
      context.registry,
      portable,
      issues
    )
  );

  const selector = context.registry.selectors.find(
    (candidate) =>
      candidate.id === definition.workload.selector.id &&
      candidate.version === definition.workload.selector.version
  );
  if (!selector) {
    add(
      issues,
      'definition-registry',
      'selector.unregistered',
      '$/workload/selector',
      'workload selector ID and version are not registered'
    );
  } else {
    if (portable && selector.portability !== 'portable') {
      add(
        issues,
        'definition-registry',
        'selector.not-portable',
        '$/workload/selector',
        'portable Definitions may use only portable selectors'
      );
    }
    validateRegisteredValue(
      definition.workload.selector.parameters,
      selector.parametersSchema,
      '$/workload/selector/parameters',
      'selector.parameters-invalid',
      issues
    );
  }

  definition.treatments.forEach((treatment, treatmentIndex) => {
    treatment.interventions.forEach((intervention, interventionIndex) => {
      const schema = registeredOperation(
        context.registry,
        intervention.capability.semanticsRef,
        'interventionOperations',
        intervention.operation
      );
      const path = `$/treatments/${treatmentIndex}/interventions/${interventionIndex}`;
      if (schema === undefined) {
        add(
          issues,
          'definition-registry',
          'intervention.operation-unregistered',
          `${path}/operation`,
          'intervention operation is not registered for this capability semantics'
        );
      } else {
        validateRegisteredValue(
          intervention.value,
          schema,
          `${path}/value`,
          'intervention.value-invalid',
          issues
        );
      }
    });
  });

  definition.metrics.forEach((metric, metricIndex) => {
    const schema = registeredOperation(
      context.registry,
      metric.collector.capability.semanticsRef,
      'collectorOperations',
      metric.collector.operation
    );
    const path = `$/metrics/${metricIndex}/collector`;
    if (schema === undefined) {
      add(
        issues,
        'definition-registry',
        'collector.operation-unregistered',
        `${path}/operation`,
        'collector operation is not registered for this capability semantics'
      );
    } else {
      validateRegisteredValue(
        metric.collector.parameters,
        schema,
        `${path}/parameters`,
        'collector.parameters-invalid',
        issues
      );
    }
  });

  definition.checks.forEach((check, checkIndex) => {
    const schema = registeredOperation(
      context.registry,
      check.capability.semanticsRef,
      'checkOperations',
      check.operation
    );
    const path = `$/checks/${checkIndex}`;
    if (schema === undefined) {
      add(
        issues,
        'definition-registry',
        'check.operation-unregistered',
        `${path}/operation`,
        'check operation is not registered for this capability semantics'
      );
    } else {
      validateRegisteredValue(
        check.parameters,
        schema,
        `${path}/parameters`,
        'check.parameters-invalid',
        issues
      );
    }
  });

  const safeguardPolicy = registryEntry(
    context.registry,
    definition.safeguards.policy
  );
  const safeguardRequestSchema = safeguardPolicy?.safeguardRequestSchema;
  if (
    definition.safeguards.relaxationRequests.length > 0 &&
    safeguardRequestSchema === undefined
  ) {
    add(
      issues,
      'definition-registry',
      'safeguard.policy-schema-missing',
      '$/safeguards/policy',
      'registered Safeguard Policy does not define a request schema'
    );
  } else if (safeguardRequestSchema !== undefined) {
    definition.safeguards.relaxationRequests.forEach((request, index) =>
      validateRegisteredValue(
        request,
        safeguardRequestSchema,
        `$/safeguards/relaxationRequests/${index}`,
        'safeguard.request-invalid',
        issues
      )
    );
  }

  const verdictPolicy = registryEntry(context.registry, definition.verdictPolicy);
  if (verdictPolicy?.verdictParametersSchema === undefined) {
    add(
      issues,
      'definition-registry',
      'verdict-policy.schema-missing',
      '$/verdictPolicy',
      'registered Verdict Policy does not define a parameter schema'
    );
  } else {
    validateRegisteredValue(
      definition.verdictPolicy.parameters,
      verdictPolicy.verdictParametersSchema,
      '$/verdictPolicy/parameters',
      'verdict-policy.parameters-invalid',
      issues
    );
  }

  const requirements = capabilityRefs(definition)
    .map((ref) => registryEntry(context.registry, ref))
    .filter((entry): entry is RegisteredSemantics => Boolean(entry));
  for (const dimension of ['totalTokens', 'costUsd'] as const) {
    if (definition.limits[dimension] === undefined) continue;
    const measured = requirements.some((entry) =>
      entry.usage?.measures.includes(dimension)
    );
    const enforced = requirements.some((entry) =>
      entry.usage?.enforces.includes(dimension)
    );
    if (!measured || !enforced) {
      add(
        issues,
        'definition-registry',
        'usage.enforcement-capability-missing',
        `$/limits/${dimension}`,
        `${dimension} limits require registered measurement and enforcement support`
      );
    }
  }
}

function sameArtifact(
  left: ExperimentRun['subjectRef'],
  right: ExperimentRun['subjectRef']
): boolean {
  return (
    left.harness === right.harness &&
    left.sourceId === right.sourceId &&
    left.artifactId === right.artifactId &&
    left.contentDigest === right.contentDigest
  );
}

function evidenceKey(evidence: EvidenceRef): string {
  if (evidence.kind === 'session') {
    return [
      evidence.kind,
      evidence.sessionRef.harness,
      evidence.sessionRef.sourceId,
      evidence.sessionRef.sessionId,
      evidence.contentDigest,
    ].join('\u0000');
  }
  return [
    evidence.kind,
    evidence.artifactRef.harness,
    evidence.artifactRef.sourceId,
    evidence.artifactRef.artifactId,
    evidence.artifactRef.contentDigest,
    evidence.artifactRef.mediaType ?? '',
  ].join('\u0000');
}

function validateEvidenceRefs(
  evidenceRefs: readonly EvidenceRef[],
  path: string,
  run: ExperimentRun,
  issues: ContractIssue[]
): void {
  requireUnique(
    evidenceRefs,
    evidenceKey,
    path,
    'run.duplicate-evidence-ref',
    issues
  );
  evidenceRefs.forEach((evidence, index) => {
    if (
      evidence.kind === 'session' &&
      evidence.sessionRef.harness !== run.selectedHarness
    ) {
      add(
        issues,
        'run-reference',
        'run.evidence-harness-mismatch',
        `${path}/${index}/sessionRef/harness`,
        'runtime-authored session evidence must use selectedHarness'
      );
    }
  });
}

const SECRET_LIKE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|glpat)[-_][A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\bxox[baprs]-[A-Za-z0-9-]{12,}|\bBearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[=:])/i;
const OPAQUE_TOKEN_LIKE = /^[A-Za-z0-9_./+=-]{32,}$/;

function validateFingerprint(
  run: ExperimentRun,
  registry: ContractRegistryV1,
  issues: ContractIssue[]
): void {
  const fingerprint = run.behaviorFingerprint;
  const expected = computeBehaviorFingerprintDigest(fingerprint);
  if (fingerprint.digest !== expected) {
    add(
      issues,
      'intrinsic',
      'fingerprint.digest-mismatch',
      '$/behaviorFingerprint/digest',
      `fingerprint digest does not match behavior manifest (expected ${expected})`
    );
  }
  const observedAt = timestamp(
    fingerprint.observedAt,
    '$/behaviorFingerprint/observedAt',
    issues
  );
  if (
    Number.isFinite(observedAt) &&
    Number.isFinite(Date.parse(run.startedAt)) &&
    compareUtcTimestamps(fingerprint.observedAt, run.startedAt) > 0
  ) {
    add(
      issues,
      'run-reference',
      'fingerprint.observed-after-dispatch',
      '$/behaviorFingerprint/observedAt',
      'behavior context must be observed no later than Run dispatch'
    );
  }
  requireUnique(
    fingerprint.factors,
    (value) => value.id,
    '$/behaviorFingerprint/factors',
    'fingerprint.duplicate-factor',
    issues
  );
  const policies = registry.fingerprintPolicies.filter(
    (candidate) =>
      candidate.id === fingerprint.policy.id &&
      candidate.version === fingerprint.policy.version
  );
  const policy = policies[0];
  if (policies.length > 1) {
    add(
      issues,
      'run-reference',
      'fingerprint.policy-identity-collision',
      '$/behaviorFingerprint/policy',
      'fingerprint policy identity resolves to multiple registry entries'
    );
  }
  if (!policy) {
    add(
      issues,
      'run-reference',
      'fingerprint.policy-unregistered',
      '$/behaviorFingerprint/policy',
      'Behavior Fingerprint policy ID and version are not registered'
    );
  } else {
    const adapterHarness = Object.hasOwn(
      policy.harnessByAdapter,
      fingerprint.adapter.id
    )
      ? policy.harnessByAdapter[fingerprint.adapter.id]
      : undefined;
    if (adapterHarness !== run.selectedHarness) {
      add(
        issues,
        'run-reference',
        'fingerprint.adapter-mismatch',
        '$/behaviorFingerprint/adapter/id',
        'registered certifying adapter must bind to selectedHarness'
      );
    }
    const declared = Object.hasOwn(
      policy.factorIdsByAdapter,
      fingerprint.adapter.id
    )
      ? policy.factorIdsByAdapter[fingerprint.adapter.id]
      : undefined;
    if (!declared) {
      add(
        issues,
        'run-reference',
        'fingerprint.adapter-manifest-missing',
        '$/behaviorFingerprint/adapter/id',
        'fingerprint policy has no factor manifest for this adapter'
      );
    } else {
      const expectedSchemaVersion = Object.hasOwn(
        policy.fingerprintSchemaVersionByAdapter,
        fingerprint.adapter.id
      )
        ? policy.fingerprintSchemaVersionByAdapter[fingerprint.adapter.id]
        : undefined;
      if (
        expectedSchemaVersion === undefined ||
        expectedSchemaVersion !== fingerprint.adapter.fingerprintSchemaVersion
      ) {
        add(
          issues,
          'run-reference',
          'fingerprint.schema-version-mismatch',
          '$/behaviorFingerprint/adapter/fingerprintSchemaVersion',
          'adapter fingerprint schema version does not match the registered policy'
        );
      }
      const actual = new Set(fingerprint.factors.map((factor) => factor.id));
      for (const factor of fingerprint.factors) {
        if (!declared.includes(factor.id)) {
          add(
            issues,
            'run-reference',
            'fingerprint.factor-undeclared',
            '$/behaviorFingerprint/factors',
            `factor ${factor.id} is not declared by the adapter policy`
          );
        }
      }
      if (fingerprint.completeness === 'complete') {
        for (const factorId of declared) {
          if (!actual.has(factorId)) {
            add(
              issues,
              'run-reference',
              'fingerprint.factor-missing',
              '$/behaviorFingerprint/factors',
              `complete fingerprint omits declared factor ${factorId}`
            );
          }
        }
      }
    }
  }
  fingerprint.factors.forEach((factor, index) => {
    if (
      factor.displayValue &&
      (SECRET_LIKE.test(factor.displayValue) ||
        OPAQUE_TOKEN_LIKE.test(factor.displayValue))
    ) {
      add(
        issues,
        'intrinsic',
        'fingerprint.secret-like-display',
        `$/behaviorFingerprint/factors/${index}/displayValue`,
        'displayValue appears to contain credential material'
      );
    }
  });
}

function validateRunAssignment(
  run: ExperimentRun,
  definition: ExperimentDefinition,
  issues: ContractIssue[]
): void {
  if (definition.studyDesign.kind === 'paired' && run.assignment.kind !== 'paired') {
    add(
      issues,
      'run-reference',
      'run.assignment-mismatch',
      '$/assignment',
      'paired Definitions require paired Run assignment'
    );
  }
  if (definition.studyDesign.kind === 'cohort') {
    const expected = definition.studyDesign.assignment.kind;
    if (run.assignment.kind !== expected) {
      add(
        issues,
        'run-reference',
        'run.assignment-mismatch',
        '$/assignment',
        `cohort Definition requires ${expected} assignment`
      );
    }
  }
}

function validateCertifications(
  run: ExperimentRun,
  definition: ExperimentDefinition,
  registry: ContractRegistryV1,
  issues: ContractIssue[]
): void {
  requireUnique(
    run.capabilitySnapshot,
    (value) => semanticsKey(value.semanticsRef),
    '$/capabilitySnapshot',
    'run.duplicate-certification',
    issues
  );
  const started = Date.parse(run.startedAt);
  run.capabilitySnapshot.forEach((certification, index) => {
    validateRegistryRef(
      certification.semanticsRef,
      `$/capabilitySnapshot/${index}/semanticsRef`,
      registry,
      false,
      issues
    );
    const observed = timestamp(
      certification.observedAt,
      `$/capabilitySnapshot/${index}/observedAt`,
      issues
    );
    if (
      Number.isFinite(observed) &&
      Number.isFinite(started) &&
      compareUtcTimestamps(certification.observedAt, run.startedAt) > 0
    ) {
      add(
        issues,
        'run-reference',
        'capability.observed-after-dispatch',
        `$/capabilitySnapshot/${index}/observedAt`,
        'dispatch certification must be observed no later than Run start'
      );
    }
    if (certification.validUntil) {
      const validUntil = timestamp(
        certification.validUntil,
        `$/capabilitySnapshot/${index}/validUntil`,
        issues
      );
      if (
        (Number.isFinite(validUntil) &&
          Number.isFinite(observed) &&
          compareUtcTimestamps(certification.validUntil, certification.observedAt) < 0) ||
        (Number.isFinite(validUntil) &&
          Number.isFinite(started) &&
          compareUtcTimestamps(certification.validUntil, run.startedAt) < 0)
      ) {
        add(
          issues,
          'run-reference',
          'capability.stale-at-dispatch',
          `$/capabilitySnapshot/${index}/validUntil`,
          'capability certification was not current at dispatch'
        );
      }
    }
  });
  for (const required of capabilityRefs(definition)) {
    const certification = run.capabilitySnapshot.find((candidate) =>
      sameSemantics(candidate.semanticsRef, required)
    );
    if (!certification) {
      const sameIdentity = run.capabilitySnapshot.find(
        (candidate) =>
          candidate.semanticsRef.id === required.id &&
          candidate.semanticsRef.version === required.version
      );
      add(
        issues,
        'run-reference',
        sameIdentity
          ? 'capability.semantics-digest-mismatch'
          : 'capability.certification-missing',
        '$/capabilitySnapshot',
        `missing exact certification for ${required.id}@${required.version}`
      );
    } else if (certification.state !== 'available') {
      add(
        issues,
        'run-reference',
        'capability.not-available',
        '$/capabilitySnapshot',
        `${required.id}@${required.version} is ${certification.state}`
      );
    }
  }
}

function validateRunEvidence(
  run: ExperimentRun,
  definition: ExperimentDefinition,
  issues: ContractIssue[]
): void {
  requireUnique(
    run.observations,
    (value) => value.metricId,
    '$/observations',
    'run.duplicate-observation',
    issues
  );
  run.observations.forEach((observation, index) => {
    const declared = definition.metrics.find((metric) => metric.id === observation.metricId);
    if (!declared) {
      add(
        issues,
        'run-reference',
        'run.undeclared-metric',
        `$/observations/${index}/metricId`,
        'observation metric is not declared by the Definition'
      );
      return;
    }
    if (
      declared.unit !== observation.unit ||
      declared.scope !== observation.scope ||
      declared.basis !== observation.basis ||
      declared.semanticsVersion !== observation.semanticsVersion
    ) {
      add(
        issues,
        'run-reference',
        'run.metric-semantics-mismatch',
        `$/observations/${index}`,
        'observation semantics do not match the Definition metric'
      );
    }
    const observed = timestamp(
      observation.observedAt,
      `$/observations/${index}/observedAt`,
      issues
    );
    if (
      (Number.isFinite(observed) &&
        Number.isFinite(Date.parse(run.startedAt)) &&
        compareUtcTimestamps(observation.observedAt, run.startedAt) < 0) ||
      (Number.isFinite(observed) &&
        Number.isFinite(Date.parse(run.finishedAt)) &&
        compareUtcTimestamps(observation.observedAt, run.finishedAt) > 0)
    ) {
      add(
        issues,
        'run-reference',
        'run.observation-outside-run',
        `$/observations/${index}/observedAt`,
        'observation time must fall within the Run'
      );
    }
    validateEvidenceRefs(
      observation.evidenceRefs,
      `$/observations/${index}/evidenceRefs`,
      run,
      issues
    );
  });

  requireUnique(
    run.checkResults,
    (value) => value.checkId,
    '$/checkResults',
    'run.duplicate-check-result',
    issues
  );
  run.checkResults.forEach((result, index) => {
    if (!definition.checks.some((check) => check.id === result.checkId)) {
      add(
        issues,
        'run-reference',
        'run.undeclared-check',
        `$/checkResults/${index}/checkId`,
        'check result is not declared by the Definition'
      );
    }
    requireOrder(
      [
        { value: run.startedAt, path: '$/startedAt' },
        { value: result.startedAt, path: `$/checkResults/${index}/startedAt` },
        { value: result.finishedAt, path: `$/checkResults/${index}/finishedAt` },
        { value: run.finishedAt, path: '$/finishedAt' },
      ],
      issues
    );
    validateEvidenceRefs(
      result.evidenceRefs,
      `$/checkResults/${index}/evidenceRefs`,
      run,
      issues
    );
  });

  if (run.status === 'succeeded') {
    definition.metrics.forEach((metric) => {
      if (!run.observations.some((value) => value.metricId === metric.id)) {
        add(
          issues,
          'run-reference',
          'run.observation-missing',
          '$/observations',
          `succeeded Run is missing declared metric ${metric.id}`
        );
      }
    });
    definition.checks.forEach((check) => {
      if (!run.checkResults.some((value) => value.checkId === check.id)) {
        add(
          issues,
          'run-reference',
          'run.check-result-missing',
          '$/checkResults',
          `succeeded Run is missing declared check ${check.id}`
        );
      }
    });
  }
  if (run.error) {
    validateEvidenceRefs(run.error.evidenceRefs, '$/error/evidenceRefs', run, issues);
  }
}

function validateUsageAgainstLimits(
  usage: UsageBounds,
  limits: UsageBounds,
  issues: ContractIssue[]
): void {
  const keys = [
    'wallTimeMs',
    'totalTokens',
    'turns',
    'toolCalls',
    'costUsd',
  ] as const;
  for (const key of keys) {
    if (limits[key] !== undefined && usage[key] === undefined) {
      add(
        issues,
        'intrinsic',
        'run.usage-missing',
        `$/usage/${key}`,
        'terminal usage must report every effective hard-limit dimension'
      );
    } else if (
      usage[key] !== undefined &&
      limits[key] !== undefined &&
      usage[key] > limits[key]
    ) {
      add(
        issues,
        'intrinsic',
        'run.hard-limit-exceeded',
        `$/usage/${key}`,
        'terminal Run usage exceeds its effective hard limit'
      );
    }
  }
}

function validateEffectiveLimits(
  run: ExperimentRun,
  definition: ExperimentDefinition,
  issues: ContractIssue[]
): void {
  const keys = [
    'wallTimeMs',
    'totalTokens',
    'turns',
    'toolCalls',
    'costUsd',
  ] as const;
  for (const key of keys) {
    const declared = definition.limits[key];
    if (declared === undefined) continue;
    const effective = run.effectiveLimits[key];
    if (effective === undefined || effective > declared) {
      add(
        issues,
        'run-reference',
        'run.effective-limit-loosened',
        `$/effectiveLimits/${key}`,
        'effective Run limits must retain or narrow every Definition limit'
      );
    }
  }
}

function validateSelectionBinding(
  run: ExperimentRun,
  context: RunDecodeContextV1,
  issues: ContractIssue[]
): void {
  const receipts = context.selectionReceipts.filter(
    (candidate) => candidate.receiptId === run.selectionRef.receiptId
  );
  const receipt = receipts[0];
  if (receipts.length > 1) {
    add(
      issues,
      'run-reference',
      'selection.receipt-identity-collision',
      '$/selectionRef/receiptId',
      'Selection Receipt ID resolves to multiple bindings'
    );
  }
  if (!receipt) {
    add(
      issues,
      'run-reference',
      'selection.receipt-missing',
      '$/selectionRef',
      'the referenced Selection Receipt was not supplied'
    );
    return;
  }
  if (receipt.receiptDigest !== run.selectionRef.receiptDigest) {
    add(
      issues,
      'run-reference',
      'selection.receipt-digest-mismatch',
      '$/selectionRef/receiptDigest',
      'Selection Reference does not pin the resolved Receipt bytes'
    );
  }
  const slotIds = new Set<string>();
  for (const candidate of receipt.planSlots) {
    if (slotIds.has(candidate.planSlotId)) {
      add(
        issues,
        'run-reference',
        'selection.plan-slot-identity-collision',
        '$/selectionRef/planSlotId',
        'Selection Receipt contains duplicate Plan Slot IDs'
      );
    }
    slotIds.add(candidate.planSlotId);
  }
  if (
    receipt.outcome !== 'selected' ||
    !sameDefinitionRef(receipt.definitionRef, run.definitionRef) ||
    receipt.trialId !== run.trialId ||
    receipt.selectedHarness !== run.selectedHarness
  ) {
    add(
      issues,
      'run-reference',
      'selection.binding-mismatch',
      '$/selectionRef',
      'Selection Receipt must bind the same Definition, trial, and harness'
    );
  }
  if (
    receipt.adapterBinding.adapterId !== run.behaviorFingerprint.adapter.id ||
    receipt.adapterBinding.behaviorFingerprintDigest !==
      run.behaviorFingerprint.digest
  ) {
    add(
      issues,
      'run-reference',
      'selection.adapter-binding-mismatch',
      '$/behaviorFingerprint',
      'Run behavior context must match the adapter binding selected by the Receipt'
    );
  }
  const slot = receipt.planSlots.find(
    (candidate) => candidate.planSlotId === run.selectionRef.planSlotId
  );
  if (!slot) {
    add(
      issues,
      'run-reference',
      'selection.plan-slot-missing',
      '$/selectionRef/planSlotId',
      'Selection Receipt does not authorize this Plan Slot'
    );
  } else if (slot.kind !== 'treatment-run' || slot.treatmentId !== run.treatmentId) {
    add(
      issues,
      'run-reference',
      'selection.plan-slot-mismatch',
      '$/selectionRef/planSlotId',
      'Plan Slot must authorize this exact Treatment Run'
    );
  }
}

function validateTriggerBinding(
  run: ExperimentRun,
  context: RunDecodeContextV1,
  issues: ContractIssue[]
): void {
  if (!run.triggerRef) return;
  const receipts = context.triggerReceipts.filter(
    (candidate) => candidate.receiptId === run.triggerRef?.receiptId
  );
  if (receipts.length !== 1) {
    add(
      issues,
      'run-reference',
      receipts.length === 0
        ? 'trigger.receipt-missing'
        : 'trigger.receipt-identity-collision',
      '$/triggerRef',
      'Trigger Reference must resolve to exactly one admitted Receipt'
    );
    return;
  }
  const receipt = receipts[0];
  if (receipt.receiptDigest !== run.triggerRef.receiptDigest) {
    add(
      issues,
      'run-reference',
      'trigger.receipt-digest-mismatch',
      '$/triggerRef/receiptDigest',
      'Trigger Reference does not pin the resolved Receipt bytes'
    );
  }
  if (
    receipt.outcome !== 'admitted' ||
    !sameDefinitionRef(receipt.definitionRef, run.definitionRef) ||
    receipt.trialId !== run.trialId ||
    receipt.selectedHarness !== run.selectedHarness
  ) {
    add(
      issues,
      'run-reference',
      'trigger.binding-mismatch',
      '$/triggerRef',
      'Trigger Receipt must admit the same Definition, trial, and harness'
    );
  }
}

function validateRetryLineage(
  run: ExperimentRun,
  priorRuns: readonly ExperimentRun[],
  issues: ContractIssue[]
): void {
  if (!run.retryOf) return;
  if (run.retryOf.runId === run.runId) {
    add(issues, 'run-reference', 'retry.self-cycle', '$/retryOf', 'a Run cannot retry itself');
    return;
  }
  const parent = priorRuns.find((candidate) => candidate.runId === run.retryOf?.runId);
  if (!parent) {
    add(issues, 'run-reference', 'retry.parent-missing', '$/retryOf', 'retry parent was not provided');
    return;
  }
  if (parent.contentDigest !== run.retryOf.contentDigest) {
    add(
      issues,
      'run-reference',
      'retry.parent-digest-mismatch',
      '$/retryOf/contentDigest',
      'retry reference does not pin the parent Run bytes'
    );
  }
  if (
    parent.trialId !== run.trialId ||
    !sameDefinitionRef(parent.definitionRef, run.definitionRef) ||
    parent.treatmentId !== run.treatmentId ||
    parent.selectedHarness !== run.selectedHarness ||
    !sameArtifact(parent.subjectRef, run.subjectRef)
  ) {
    add(
      issues,
      'run-reference',
      'retry.boundary-mismatch',
      '$/retryOf',
      'retry parent must share trial, Definition, Treatment, subject, and harness'
    );
  }
  if (compareUtcTimestamps(run.createdAt, parent.finishedAt) <= 0) {
    add(
      issues,
      'run-reference',
      'retry.precedes-parent',
      '$/createdAt',
      'a retry cannot be created before its terminal parent finishes'
    );
  }
  const byId = new Map(priorRuns.map((candidate) => [candidate.runId, candidate]));
  const seen = new Set([run.runId]);
  let cursor: ExperimentRun | undefined = parent;
  while (cursor) {
    if (seen.has(cursor.runId)) {
      add(issues, 'run-reference', 'retry.cycle', '$/retryOf', 'retry lineage contains a cycle');
      break;
    }
    seen.add(cursor.runId);
    cursor = cursor.retryOf ? byId.get(cursor.retryOf.runId) : undefined;
  }
}

function validateRunSemantics(
  run: ExperimentRun,
  context: RunDecodeContextV1,
  issues: ContractIssue[]
): void {
  checkDigest(run, issues);
  requireOrder(
    [
      { value: run.createdAt, path: '$/createdAt' },
      { value: run.startedAt, path: '$/startedAt' },
      { value: run.finishedAt, path: '$/finishedAt' },
    ],
    issues
  );
  if (!sameDefinitionRef(run.definitionRef, definitionRef(context.definition))) {
    add(
      issues,
      'run-reference',
      'run.definition-mismatch',
      '$/definitionRef',
      'Run does not reference the exact supplied immutable Definition'
    );
  }
  const collision = context.priorRuns.find(
    (candidate) => candidate.runId === run.runId
  );
  if (collision && collision.contentDigest !== run.contentDigest) {
    add(
      issues,
      'run-reference',
      'run.identity-collision',
      '$/runId',
      'immutable Run ID already identifies different canonical bytes'
    );
  }
  const siblings = context.priorRuns.filter(
    (candidate) =>
      candidate.runId !== run.runId &&
      candidate.trialId === run.trialId &&
      sameDefinitionRef(candidate.definitionRef, run.definitionRef)
  );
  if (
    !allowsHarnessVariation(context.definition, context.registry) &&
    siblings.some((candidate) => candidate.selectedHarness !== run.selectedHarness)
  ) {
    add(
      issues,
      'run-reference',
      'run.trial-harness-mismatch',
      '$/selectedHarness',
      'all Runs in one trial must retain the selected harness binding'
    );
  }
  if (
    context.definition.studyDesign.kind === 'paired' &&
    siblings.some((candidate) => !sameArtifact(candidate.subjectRef, run.subjectRef))
  ) {
    add(
      issues,
      'run-reference',
      'run.paired-subject-mismatch',
      '$/subjectRef',
      'all paired Run attempts must use the same content-pinned subject'
    );
  }
  if (
    context.definition.studyDesign.kind === 'paired' &&
    !allowsHarnessVariation(context.definition, context.registry) &&
    siblings.some(
      (candidate) =>
        candidate.selectionRef.receiptId !== run.selectionRef.receiptId ||
        candidate.selectionRef.receiptDigest !== run.selectionRef.receiptDigest
    )
  ) {
    add(
      issues,
      'run-reference',
      'selection.paired-trial-receipt-mismatch',
      '$/selectionRef',
      'all Runs in a paired trial must remain bound to one immutable Selection Receipt'
    );
  }
  if (
    siblings.some(
      (candidate) =>
        candidate.selectionRef.receiptId === run.selectionRef.receiptId &&
        candidate.selectionRef.planSlotId === run.selectionRef.planSlotId
    )
  ) {
    add(
      issues,
      'run-reference',
      'selection.plan-slot-reused',
      '$/selectionRef',
      'a Selection Receipt Plan Slot can authorize only one Run'
    );
  }
  if (!context.definition.treatments.some((value) => value.id === run.treatmentId)) {
    add(
      issues,
      'run-reference',
      'run.treatment-missing',
      '$/treatmentId',
      'Run Treatment is not declared by the Definition'
    );
  }
  if (
    context.definition.portability.class === 'harness-specific' &&
    !context.definition.portability.allowedHarnesses.includes(run.selectedHarness)
  ) {
    add(
      issues,
      'run-reference',
      'run.harness-not-allowed',
      '$/selectedHarness',
      'selectedHarness is not allowed by this harness-specific Definition'
    );
  }
  for (const [role, harness] of Object.entries(run.harnessProvenance)) {
    if (role !== 'origin' && harness !== run.selectedHarness) {
      add(
        issues,
        'intrinsic',
        'run.provenance-mismatch',
        `$/harnessProvenance/${role}`,
        'driver, worker, and judge must equal selectedHarness'
      );
    }
  }
  if (run.sessionRef.harness !== run.selectedHarness) {
    add(
      issues,
      'intrinsic',
      'run.session-harness-mismatch',
      '$/sessionRef/harness',
      'primary session must be namespaced to selectedHarness'
    );
  }
  validateFingerprint(run, context.registry, issues);
  validateSelectionBinding(run, context, issues);
  validateTriggerBinding(run, context, issues);
  validateRunAssignment(run, context.definition, issues);
  validateCertifications(run, context.definition, context.registry, issues);
  validateRunEvidence(run, context.definition, issues);
  validateEffectiveLimits(run, context.definition, issues);
  validateUsageAgainstLimits(run.usage, run.effectiveLimits, issues);
  requireUnique(
    run.safeguardAuthorizations,
    (value) => value.requestId,
    '$/safeguardAuthorizations',
    'run.duplicate-safeguard-authorization',
    issues
  );
  run.safeguardAuthorizations.forEach((authorization, index) => {
    const request = context.definition.safeguards.relaxationRequests.find(
      (candidate) => candidate.requestId === authorization.requestId
    );
    if (!request) {
      add(
        issues,
        'run-reference',
        'run.unknown-safeguard-authorization',
        `$/safeguardAuthorizations/${index}/requestId`,
        'authorization does not match a Definition relaxation request'
      );
    }
    const approved =
      request !== undefined &&
      context.operatorSafeguardAuthorizations.some(
        (candidate) =>
          sameDefinitionRef(candidate.definitionRef, run.definitionRef) &&
          candidate.trialId === run.trialId &&
          candidate.runId === run.runId &&
          canonicalJson(candidate.request) === canonicalJson(request) &&
          candidate.approvedBy === authorization.approvedBy &&
          candidate.approvedAt === authorization.approvedAt &&
          candidate.reason === authorization.reason
      );
    if (!approved) {
      add(
        issues,
        'run-reference',
        'run.safeguard-authorization-unresolved',
        `$/safeguardAuthorizations/${index}`,
        'Run safeguard authorization is not backed by exact operator authority'
      );
    }
    const approvedAt = timestamp(
      authorization.approvedAt,
      `$/safeguardAuthorizations/${index}/approvedAt`,
      issues
    );
    if (
      Number.isFinite(approvedAt) &&
      Number.isFinite(Date.parse(run.startedAt)) &&
      compareUtcTimestamps(authorization.approvedAt, run.startedAt) > 0
    ) {
      add(
        issues,
        'run-reference',
        'run.safeguard-authorization-late',
        `$/safeguardAuthorizations/${index}/approvedAt`,
        'safeguard relaxation must be authorized before dispatch'
      );
    }
  });
  if (run.status === 'succeeded' && run.error !== null) {
    add(
      issues,
      'intrinsic',
      'run.error-on-success',
      '$/error',
      'a succeeded Run cannot carry an error'
    );
  }
  if (run.status !== 'succeeded' && run.error === null) {
    add(
      issues,
      'intrinsic',
      'run.missing-error',
      '$/error',
      'failed and cancelled Runs must carry a structured error'
    );
  }
  validateRetryLineage(run, context.priorRuns, issues);
}

function refKey(ref: RunRef): string {
  return `${ref.runId}\u0000${ref.contentDigest}`;
}

function validateVerdictEffect(
  verdict: ExperimentVerdict,
  definition: ExperimentDefinition,
  includedRuns: ExperimentRun[],
  registry: ContractRegistryV1,
  issues: ContractIssue[]
): void {
  const effect = verdict.primaryEffect;
  const conclusive = verdict.outcome.kind === 'winner' || verdict.outcome.kind === 'tie';
  if (conclusive && !effect) {
    add(
      issues,
      'verdict-policy',
      'verdict.primary-effect-required',
      '$/primaryEffect',
      'winner and tie Verdicts require a typed primary effect'
    );
    return;
  }
  if (verdict.outcome.kind === 'invalid' && effect) {
    add(
      issues,
      'verdict-policy',
      'verdict.invalid-cannot-have-effect',
      '$/primaryEffect',
      'invalid Verdicts cannot assert an effect'
    );
  }
  if (!effect) return;

  const control = definition.treatments.find((value) => value.control);
  const treatment = definition.treatments.find(
    (value) => value.id === effect.contrast.treatmentId
  );
  if (!control || effect.contrast.controlTreatmentId !== control.id) {
    add(
      issues,
      'verdict-policy',
      'effect.control-mismatch',
      '$/primaryEffect/contrast/controlTreatmentId',
      'effect contrast must reference the declared control Treatment'
    );
  }
  if (!treatment || treatment.control) {
    add(
      issues,
      'verdict-policy',
      'effect.treatment-mismatch',
      '$/primaryEffect/contrast/treatmentId',
      'effect contrast must reference a non-control Treatment'
    );
  }
  const metric = definition.metrics.find((value) => value.id === effect.metricRef.id);
  if (
    !metric ||
    metric.semanticsVersion !== effect.metricRef.semanticsVersion ||
    metric.unit !== effect.unit
  ) {
    add(
      issues,
      'verdict-policy',
      'effect.metric-mismatch',
      '$/primaryEffect/metricRef',
      'effect metric semantics and unit must match the Definition'
    );
  }
  const policy = registryEntry(registry, verdict.policy);
  if (
    !policy?.estimators?.some(
      (candidate) =>
        candidate.id === effect.estimator.id &&
        candidate.version === effect.estimator.version
    )
  ) {
    add(
      issues,
      'verdict-policy',
      'effect.estimator-unregistered',
      '$/primaryEffect/estimator',
      'effect estimator is not registered for the Verdict Policy'
    );
  }
  if (
    effect.uncertainty.kind === 'interval' &&
    effect.uncertainty.lower > effect.uncertainty.upper
  ) {
    add(
      issues,
      'verdict-policy',
      'effect.interval-order',
      '$/primaryEffect/uncertainty',
      'uncertainty lower bound cannot exceed upper bound'
    );
  }
  requireUnique(
    effect.sampleCounts,
    (value) => value.treatmentId,
    '$/primaryEffect/sampleCounts',
    'effect.duplicate-sample-count',
    issues
  );
  const effectRuns = includedRuns.filter(
    (run) =>
      run.status === 'succeeded' &&
      run.observations.some(
        (observation) =>
          observation.metricId === effect.metricRef.id &&
          observation.semanticsVersion === effect.metricRef.semanticsVersion &&
          observation.unit === effect.unit
      )
  );
  const actualCounts = new Map<string, number>();
  effectRuns.forEach((run) =>
    actualCounts.set(run.treatmentId, (actualCounts.get(run.treatmentId) ?? 0) + 1)
  );
  for (const count of effect.sampleCounts) {
    if (!definition.treatments.some((value) => value.id === count.treatmentId)) {
      add(
        issues,
        'verdict-policy',
        'effect.undeclared-sample-count',
        '$/primaryEffect/sampleCounts',
        `sampleCounts names undeclared Treatment ${count.treatmentId}`
      );
    }
    if ((actualCounts.get(count.treatmentId) ?? 0) !== count.n) {
      add(
        issues,
        'verdict-policy',
        'effect.sample-count-mismatch',
        '$/primaryEffect/sampleCounts',
        `sample count for ${count.treatmentId} does not match included Runs`
      );
    }
  }
  for (const treatmentId of actualCounts.keys()) {
    if (!effect.sampleCounts.some((value) => value.treatmentId === treatmentId)) {
      add(
        issues,
        'verdict-policy',
        'effect.sample-count-missing',
        '$/primaryEffect/sampleCounts',
        `sampleCounts omits included Treatment ${treatmentId}`
      );
    }
  }
  if (verdict.outcome.kind === 'winner') {
    const winner = verdict.outcome.winningTreatmentId;
    const { controlTreatmentId, treatmentId } = effect.contrast;
    const directionMatches =
      (winner === treatmentId && effect.estimate > 0) ||
      (winner === controlTreatmentId && effect.estimate < 0);
    if (!directionMatches) {
      add(
        issues,
        'verdict-policy',
        'effect.winner-direction-mismatch',
        '$/primaryEffect/estimate',
        'normalized effect sign and contrast must agree with the winning Treatment'
      );
    }
  }
}

function validateVerdictReplacement(
  verdict: ExperimentVerdict,
  previous: ExperimentVerdict | null,
  issues: ContractIssue[]
): void {
  if (!previous) return;
  if (verdict.verdictId !== previous.verdictId) {
    add(
      issues,
      'verdict-policy',
      'verdict.replacement-id-mismatch',
      '$/verdictId',
      'a replacement Verdict must retain the current Verdict ID'
    );
  }
  if (verdict.trialId !== previous.trialId) {
    add(
      issues,
      'verdict-policy',
      'verdict.replacement-trial-mismatch',
      '$/trialId',
      'a replacement Verdict cannot move to another trial'
    );
  }
  if (!sameDefinitionRef(verdict.definitionRef, previous.definitionRef)) {
    add(
      issues,
      'verdict-policy',
      'verdict.replacement-definition-mismatch',
      '$/definitionRef',
      'a replacement Verdict must retain the exact Definition reference'
    );
  }
  if (verdict.createdAt !== previous.createdAt) {
    add(
      issues,
      'verdict-policy',
      'verdict.replacement-created-at-mismatch',
      '$/createdAt',
      'a replacement Verdict must retain the original creation time'
    );
  }
  if (compareUtcTimestamps(verdict.updatedAt, previous.updatedAt) <= 0) {
    add(
      issues,
      'verdict-policy',
      'verdict.replacement-not-newer',
      '$/updatedAt',
      'a replacement Verdict must advance updatedAt'
    );
  }
  if (verdict.contentDigest === previous.contentDigest) {
    add(
      issues,
      'verdict-policy',
      'verdict.replacement-digest-unchanged',
      '$/contentDigest',
      'a correction must invalidate the prior Verdict digest'
    );
  }
}

function validateVerdictSemantics(
  verdict: ExperimentVerdict,
  context: VerdictDecodeContextV1,
  issues: ContractIssue[]
): void {
  checkDigest(verdict, issues);
  validateVerdictReplacement(verdict, context.previousVerdict, issues);
  requireOrder(
    [
      { value: verdict.createdAt, path: '$/createdAt' },
      { value: verdict.updatedAt, path: '$/updatedAt' },
    ],
    issues
  );
  if (!sameDefinitionRef(verdict.definitionRef, definitionRef(context.definition))) {
    add(
      issues,
      'verdict-policy',
      'verdict.definition-mismatch',
      '$/definitionRef',
      'Verdict does not reference the exact supplied Definition'
    );
  }
  if (!sameSemantics(verdict.policy, context.definition.verdictPolicy)) {
    add(
      issues,
      'verdict-policy',
      'verdict.policy-mismatch',
      '$/policy',
      'Verdict policy must match the exact Definition policy reference'
    );
  }
  validateRegistryRef(
    verdict.policy,
    '$/policy',
    context.registry,
    false,
    issues
  );
  const registeredPolicy = registryEntry(context.registry, verdict.policy);
  if (registeredPolicy?.verdictResultSchema === undefined) {
    add(
      issues,
      'verdict-policy',
      'verdict.policy-result-schema-missing',
      '$/policyResult',
      'registered Verdict Policy does not define a result schema'
    );
  } else {
    validateRegisteredValue(
      verdict.policyResult,
      registeredPolicy.verdictResultSchema,
      '$/policyResult',
      'verdict.policy-result-invalid',
      issues
    );
  }
  requireUnique(
    verdict.evidence.includedRuns,
    refKey,
    '$/evidence/includedRuns',
    'verdict.duplicate-included-run',
    issues
  );
  requireUnique(
    verdict.evidence.excludedRuns,
    (value) => refKey(value.run),
    '$/evidence/excludedRuns',
    'verdict.duplicate-excluded-run',
    issues
  );
  const includedIds = new Set(verdict.evidence.includedRuns.map((value) => value.runId));
  for (const excluded of verdict.evidence.excludedRuns) {
    if (includedIds.has(excluded.run.runId)) {
      add(
        issues,
        'verdict-policy',
        'verdict.evidence-overlap',
        '$/evidence',
        `Run ${excluded.run.runId} is both included and excluded`
      );
    }
  }

  const relevantRuns = context.trialRuns.filter(
    (run) =>
      run.trialId === verdict.trialId &&
      sameDefinitionRef(run.definitionRef, verdict.definitionRef)
  );
  if (context.definition.studyDesign.kind === 'paired' && relevantRuns.length > 1) {
    const first = relevantRuns[0];
    if (relevantRuns.some((run) => !sameArtifact(run.subjectRef, first.subjectRef))) {
      add(
        issues,
        'verdict-policy',
        'verdict.paired-subject-mismatch',
        '$/evidence',
        'all evidence Runs in a paired trial must use one content-pinned subject'
      );
    }
    if (
      !allowsHarnessVariation(context.definition, context.registry) &&
      relevantRuns.some(
        (run) =>
          run.selectionRef.receiptId !== first.selectionRef.receiptId ||
          run.selectionRef.receiptDigest !== first.selectionRef.receiptDigest
      )
    ) {
      add(
        issues,
        'verdict-policy',
        'selection.paired-trial-receipt-mismatch',
        '$/evidence',
        'all evidence Runs in a paired trial must share one immutable Selection Receipt'
      );
    }
  }
  const selectionReceiptDigests = new Map<string, Sha256Digest>();
  const selectionSlots = new Set<string>();
  for (const run of relevantRuns) {
    const existingDigest = selectionReceiptDigests.get(
      run.selectionRef.receiptId
    );
    if (
      existingDigest !== undefined &&
      existingDigest !== run.selectionRef.receiptDigest
    ) {
      add(
        issues,
        'verdict-policy',
        'selection.receipt-identity-collision',
        '$/evidence',
        'one Selection Receipt ID cannot identify different immutable receipt bytes'
      );
    }
    selectionReceiptDigests.set(
      run.selectionRef.receiptId,
      run.selectionRef.receiptDigest
    );
    const key = `${run.selectionRef.receiptId}\u0000${run.selectionRef.planSlotId}`;
    if (selectionSlots.has(key)) {
      add(
        issues,
        'verdict-policy',
        'selection.plan-slot-reused',
        '$/evidence',
        'a Selection Receipt Plan Slot can authorize only one evidence Run'
      );
    }
    selectionSlots.add(key);
  }
  if (relevantRuns.length === 0) {
    add(
      issues,
      'verdict-policy',
      'verdict.trial-empty',
      '$/trialId',
      'a Verdict requires at least one terminal Run in the referenced trial'
    );
  }
  if (
    relevantRuns.some(
      (run) => compareUtcTimestamps(run.finishedAt, verdict.updatedAt) > 0
    )
  ) {
    add(
      issues,
      'verdict-policy',
      'verdict.precedes-evidence',
      '$/updatedAt',
      'current Verdict cannot predate terminal evidence it accounts for'
    );
  }
  const runById = new Map(relevantRuns.map((run) => [run.runId, run]));
  const resolve = (ref: RunRef, path: string): ExperimentRun | undefined => {
    const run = runById.get(ref.runId);
    if (!run) {
      add(
        issues,
        'verdict-policy',
        'verdict.run-missing',
        path,
        'evidence Run is absent from the supplied trial'
      );
      return undefined;
    }
    if (run.contentDigest !== ref.contentDigest) {
      add(
        issues,
        'verdict-policy',
        'verdict.run-digest-mismatch',
        `${path}/contentDigest`,
        'evidence reference does not pin the exact Run bytes'
      );
    }
    return run;
  };
  const includedRuns = verdict.evidence.includedRuns
    .map((ref, index) => {
      const run = resolve(ref, `$/evidence/includedRuns/${index}`);
      if (
        run?.status !== undefined &&
        run.status !== 'succeeded' &&
        (verdict.outcome.kind === 'winner' || verdict.outcome.kind === 'tie')
      ) {
        add(
          issues,
          'verdict-policy',
          'verdict.included-run-not-succeeded',
          `$/evidence/includedRuns/${index}`,
          'conclusive Verdict evidence may include only succeeded Runs'
        );
      }
      return run;
    })
    .filter((run): run is ExperimentRun => Boolean(run));
  verdict.evidence.excludedRuns.forEach((entry, index) =>
    resolve(entry.run, `$/evidence/excludedRuns/${index}/run`)
  );
  const accounted = new Set([
    ...verdict.evidence.includedRuns.map((value) => value.runId),
    ...verdict.evidence.excludedRuns.map((value) => value.run.runId),
  ]);
  for (const run of relevantRuns) {
    if (!accounted.has(run.runId)) {
      add(
        issues,
        'verdict-policy',
        'verdict.run-unaccounted',
        '$/evidence',
        `trial Run ${run.runId} is neither included nor excluded`
      );
    }
  }

  const harnesses = new Set(relevantRuns.map((run) => run.selectedHarness));
  const fingerprints = new Set(
    includedRuns.map((run) => run.behaviorFingerprint.digest)
  );
  const harnessVariation = allowsHarnessVariation(
    context.definition,
    context.registry
  );
  if (harnesses.size > 1 && !harnessVariation) {
    add(
      issues,
      'verdict-policy',
      'verdict.mixed-harnesses',
      '$/evidence/includedRuns',
      'ordinary per-harness Verdicts cannot pool harnesses'
    );
  }
  if (fingerprints.size > 1 && !harnessVariation) {
    add(
      issues,
      'verdict-policy',
      'verdict.mixed-fingerprints',
      '$/evidence/includedRuns',
      'ordinary Verdicts cannot pool behavior contexts'
    );
  }
  if (
    context.definition.studyDesign.kind === 'paired' &&
    includedRuns.length > 0
  ) {
    const subject = includedRuns[0].subjectRef;
    if (includedRuns.some((run) => !sameArtifact(run.subjectRef, subject))) {
      add(
        issues,
        'verdict-policy',
        'verdict.paired-subject-mismatch',
        '$/evidence/includedRuns',
        'paired evidence must use the same content-pinned subject'
      );
    }
    if (verdict.outcome.kind === 'winner' || verdict.outcome.kind === 'tie') {
      for (const treatment of context.definition.treatments) {
        const selected = includedRuns.filter(
          (run) => run.treatmentId === treatment.id && run.status === 'succeeded'
        );
        if (selected.length !== 1) {
          add(
            issues,
            'verdict-policy',
            'verdict.paired-treatment-coverage',
            '$/evidence/includedRuns',
            `conclusive paired Verdict requires one succeeded Run for ${treatment.id}`
          );
        }
      }
    }
  }
  if (
    includedRuns.some((run) => run.behaviorFingerprint.completeness !== 'complete') &&
    verdict.outcome.kind !== 'inconclusive' &&
    verdict.outcome.kind !== 'invalid'
  ) {
    add(
      issues,
      'verdict-policy',
      'verdict.incomplete-fingerprint',
      '$/evidence/includedRuns',
      'incomplete fingerprints cannot support a conclusive Verdict'
    );
  }
  const evidenceHarness = harnessVariation
    ? verdict.judge.harness
    : (includedRuns[0]?.selectedHarness ?? relevantRuns[0]?.selectedHarness);
  if (
    evidenceHarness &&
    verdict.evidenceBasis.evidenceHarness !== evidenceHarness
  ) {
    add(
      issues,
      'verdict-policy',
      'verdict.evidence-harness-mismatch',
      '$/evidenceBasis/evidenceHarness',
      'evidenceBasis must name the harness that produced included Runs'
    );
  }
  if (
    verdict.judge.harness !== verdict.evidenceBasis.evidenceHarness ||
    verdict.judge.sessionRef.harness !== verdict.judge.harness
  ) {
    add(
      issues,
      'verdict-policy',
      'verdict.judge-harness-mismatch',
      '$/judge',
      'judge provenance must remain bound to the evidence harness'
    );
  }

  requireUnique(
    verdict.evidenceBasis.satisfiedCapabilitySemantics,
    semanticsKey,
    '$/evidenceBasis/satisfiedCapabilitySemantics',
    'verdict.duplicate-capability-semantics',
    issues
  );
  const required =
    includedRuns.length === 0
      ? []
      : capabilityRefs(context.definition).filter((ref) =>
          includedRuns.every((run) =>
            run.capabilitySnapshot.some(
              (certification) =>
                certification.state === 'available' &&
                sameSemantics(certification.semanticsRef, ref)
            )
          )
        );
  const satisfied = verdict.evidenceBasis.satisfiedCapabilitySemantics;
  for (const ref of required) {
    if (!satisfied.some((candidate) => sameSemantics(candidate, ref))) {
      add(
        issues,
        'verdict-policy',
        'verdict.capability-basis-missing',
        '$/evidenceBasis/satisfiedCapabilitySemantics',
        `evidence basis omits ${ref.id}@${ref.version}`
      );
    }
  }
  for (const ref of satisfied) {
    if (!required.some((candidate) => sameSemantics(candidate, ref))) {
      add(
        issues,
        'verdict-policy',
        'verdict.capability-basis-extra',
        '$/evidenceBasis/satisfiedCapabilitySemantics',
        `evidence basis includes undeclared ${ref.id}@${ref.version}`
      );
    }
  }

  for (const run of includedRuns) {
    const seen = new Set<string>();
    let parent = run.retryOf ? runById.get(run.retryOf.runId) : undefined;
    while (parent && !seen.has(parent.runId)) {
      if (includedIds.has(parent.runId)) {
        add(
          issues,
          'verdict-policy',
          'verdict.retry-double-counted',
          '$/evidence/includedRuns',
          'a retry and any superseded ancestor cannot both be included'
        );
        break;
      }
      seen.add(parent.runId);
      parent = parent.retryOf ? runById.get(parent.retryOf.runId) : undefined;
    }
  }
  if (verdict.outcome.kind === 'winner') {
    const winningTreatmentId = verdict.outcome.winningTreatmentId;
    if (
      !context.definition.treatments.some(
        (value) => value.id === winningTreatmentId
      ) ||
      !includedRuns.some(
        (run) => run.treatmentId === winningTreatmentId
      )
    ) {
      add(
        issues,
        'verdict-policy',
        'verdict.winner-without-evidence',
        '$/outcome/winningTreatmentId',
        'winning Treatment must be declared and have included evidence'
      );
    }
  }
  if (
    context.definition.studyDesign.kind === 'cohort' &&
    verdict.outcome.kind !== 'inconclusive'
  ) {
    for (const treatment of context.definition.treatments) {
      const eligibleCount = includedRuns.filter(
        (run) =>
          run.treatmentId === treatment.id &&
          run.status === 'succeeded' &&
          context.definition.metrics.every((metric) =>
            run.observations.some(
              (observation) => observation.metricId === metric.id
            )
          )
      ).length;
      if (eligibleCount < context.definition.studyDesign.minimumRunsPerTreatment) {
        add(
          issues,
          'verdict-policy',
          'verdict.cohort-minimum-not-met',
          '$/evidence/includedRuns',
          `Treatment ${treatment.id} has ${eligibleCount} eligible included Runs`
        );
      }
    }
  }
  if (
    context.definition.studyDesign.kind === 'cohort' &&
    context.definition.studyDesign.maximumRunsPerTreatment !== undefined
  ) {
    for (const treatment of context.definition.treatments) {
      const count = includedRuns.filter((run) => run.treatmentId === treatment.id).length;
      if (count > context.definition.studyDesign.maximumRunsPerTreatment) {
        add(
          issues,
          'verdict-policy',
          'verdict.cohort-maximum-exceeded',
          '$/evidence/includedRuns',
          `Treatment ${treatment.id} has ${count} included Runs`
        );
      }
    }
  }
  validateVerdictEffect(
    verdict,
    context.definition,
    includedRuns,
    context.registry,
    issues
  );
}

function preflight(
  input: unknown
): { value?: JsonValue; issues: ContractIssue[] } {
  try {
    return { value: toJsonValue(input), issues: [] };
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      return {
        issues: [
          {
            stage: 'json',
            code: error.code,
            path: error.path,
            message: error.message,
          },
        ],
      };
    }
    return {
      issues: [
        {
          stage: 'json',
          code: 'json.invalid',
          path: '$',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child, seen);
  return value;
}

function structuralIssues(
  input: unknown,
  kind: 'ExperimentDefinition' | 'ExperimentRun' | 'ExperimentVerdict'
): ContractIssue[] {
  return validateContractSchema(input, kind).map((value) => ({
    stage: 'schema' as const,
    code: value.code,
    path: value.path,
    message: value.message,
  }));
}

function rebaseContextIssues(
  source: readonly ContractIssue[],
  basePath: string
): ContractIssue[] {
  return source.map((issue) => ({
    ...issue,
    path: issue.path === '$' ? basePath : `${basePath}${issue.path.slice(1)}`,
  }));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contextField(input: unknown, field: string): unknown {
  try {
    const context = recordValue(input);
    if (!context) return undefined;
    return context[field];
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function jsonSchemaShape(value: unknown): value is JsonSchema {
  return typeof value === 'boolean' || recordValue(value) !== undefined;
}

function semanticsRegistryEntryShape(value: unknown): boolean {
  const entry = recordValue(value);
  if (
    !entry ||
    typeof entry.id !== 'string' ||
    typeof entry.version !== 'number' ||
    typeof entry.contentDigest !== 'string' ||
    (entry.portability !== 'portable' && entry.portability !== 'harness-specific')
  ) {
    return false;
  }
  for (const field of [
    'interventionOperations',
    'collectorOperations',
    'checkOperations',
  ]) {
    const operations = entry[field];
    const operationRecord =
      operations === undefined ? undefined : recordValue(operations);
    if (
      operations !== undefined &&
      (!operationRecord ||
        !Object.values(operationRecord).every(jsonSchemaShape))
    ) {
      return false;
    }
  }
  for (const field of [
    'safeguardRequestSchema',
    'verdictParametersSchema',
    'verdictResultSchema',
  ]) {
    if (entry[field] !== undefined && !jsonSchemaShape(entry[field])) return false;
  }
  if (
    entry.selectedHarnessOperations !== undefined &&
    !stringArray(entry.selectedHarnessOperations)
  ) {
    return false;
  }
  if (entry.estimators !== undefined) {
    if (
      !Array.isArray(entry.estimators) ||
      !entry.estimators.every((candidate) => {
        const estimator = recordValue(candidate);
        return (
          estimator !== undefined &&
          typeof estimator.id === 'string' &&
          typeof estimator.version === 'number'
        );
      })
    ) {
      return false;
    }
  }
  if (entry.usage !== undefined) {
    const usage = recordValue(entry.usage);
    if (
      !usage ||
      !stringArray(usage.measures) ||
      !stringArray(usage.enforces)
    ) {
      return false;
    }
  }
  return (
    entry.allowsHarnessComparison === undefined ||
    typeof entry.allowsHarnessComparison === 'boolean'
  );
}

function selectorRegistryEntryShape(value: unknown): boolean {
  const entry = recordValue(value);
  return Boolean(
    entry &&
      typeof entry.id === 'string' &&
      typeof entry.version === 'number' &&
      (entry.portability === 'portable' ||
        entry.portability === 'harness-specific') &&
      jsonSchemaShape(entry.parametersSchema)
  );
}

function fingerprintRegistryEntryShape(value: unknown): boolean {
  const entry = recordValue(value);
  const factorIds = recordValue(entry?.factorIdsByAdapter);
  const schemaVersions = recordValue(entry?.fingerprintSchemaVersionByAdapter);
  const harnesses = recordValue(entry?.harnessByAdapter);
  return Boolean(
    entry &&
      typeof entry.id === 'string' &&
      typeof entry.version === 'number' &&
      factorIds &&
      Object.values(factorIds).every(stringArray) &&
      schemaVersions &&
      Object.values(schemaVersions).every(
        (candidate) => typeof candidate === 'number'
      ) &&
      harnesses &&
      Object.values(harnesses).every(
        (candidate) => typeof candidate === 'string'
      )
  );
}

function validatedContextRegistry(
  input: unknown,
  issues: ContractIssue[]
): ContractRegistryV1 | undefined {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = recordValue(input);
  } catch {
    add(
      issues,
      'definition-registry',
      'context.registry-invalid',
      '$/context/registry',
      'contract registry bindings must have the complete immutable v1 shape'
    );
    return undefined;
  }
  if (raw && validatedRegistryValues.has(raw)) {
    return raw as unknown as ContractRegistryV1;
  }
  if (!raw) {
    add(
      issues,
      'definition-registry',
      'context.registry-required',
      '$/context/registry',
      'contract decoding requires a registry with semantics, selector, and fingerprint policy arrays'
    );
    return undefined;
  }
  const prepared = preflight(input);
  const registry = recordValue(prepared.value);
  if (
    prepared.issues.length === 0 &&
    registry &&
    (!Array.isArray(registry.semantics) ||
      !Array.isArray(registry.selectors) ||
      !Array.isArray(registry.fingerprintPolicies))
  ) {
    add(
      issues,
      'definition-registry',
      'context.registry-required',
      '$/context/registry',
      'contract decoding requires a registry with semantics, selector, and fingerprint policy arrays'
    );
    return undefined;
  }
  try {
    if (
      prepared.issues.length > 0 ||
      !registry ||
      !Array.isArray(registry.semantics) ||
      !registry.semantics.every(semanticsRegistryEntryShape) ||
      !Array.isArray(registry.selectors) ||
      !registry.selectors.every(selectorRegistryEntryShape) ||
      !Array.isArray(registry.fingerprintPolicies) ||
      !registry.fingerprintPolicies.every(fingerprintRegistryEntryShape)
    ) {
      throw new Error('invalid registry binding shape');
    }
  } catch {
    add(
      issues,
      'definition-registry',
      'context.registry-invalid',
      '$/context/registry',
      'contract registry bindings must have the complete immutable v1 shape'
    );
    return undefined;
  }
  freezeDeep(registry);
  validatedRegistryValues.add(registry);
  return registry as unknown as ContractRegistryV1;
}

function definitionRefShape(value: unknown): boolean {
  const ref = recordValue(value);
  return Boolean(
    ref &&
      typeof ref.definitionId === 'string' &&
      typeof ref.definitionVersion === 'number' &&
      typeof ref.contentDigest === 'string'
  );
}

function selectionReceiptShape(value: unknown): boolean {
  const receipt = recordValue(value);
  const adapter = recordValue(receipt?.adapterBinding);
  return Boolean(
    receipt &&
      typeof receipt.receiptId === 'string' &&
      typeof receipt.receiptDigest === 'string' &&
      receipt.outcome === 'selected' &&
      definitionRefShape(receipt.definitionRef) &&
      typeof receipt.trialId === 'string' &&
      typeof receipt.selectedHarness === 'string' &&
      adapter &&
      typeof adapter.adapterId === 'string' &&
      typeof adapter.behaviorFingerprintDigest === 'string' &&
      Array.isArray(receipt.planSlots) &&
      receipt.planSlots.every((value) => {
        const slot = recordValue(value);
        return Boolean(
          slot &&
            typeof slot.planSlotId === 'string' &&
            slot.kind === 'treatment-run' &&
            typeof slot.treatmentId === 'string'
        );
      })
  );
}

function triggerReceiptShape(value: unknown): boolean {
  const receipt = recordValue(value);
  return Boolean(
    receipt &&
      typeof receipt.receiptId === 'string' &&
      typeof receipt.receiptDigest === 'string' &&
      receipt.outcome === 'admitted' &&
      definitionRefShape(receipt.definitionRef) &&
      typeof receipt.trialId === 'string' &&
      typeof receipt.selectedHarness === 'string'
  );
}

function operatorAuthorizationShape(value: unknown): boolean {
  const authorization = recordValue(value);
  const request = recordValue(authorization?.request);
  return Boolean(
    authorization &&
      definitionRefShape(authorization.definitionRef) &&
      typeof authorization.trialId === 'string' &&
      typeof authorization.runId === 'string' &&
      request &&
      typeof request.requestId === 'string' &&
      typeof request.safeguard === 'string' &&
      Object.hasOwn(request, 'requestedValue') &&
      typeof request.reason === 'string' &&
      typeof authorization.approvedBy === 'string' &&
      typeof authorization.approvedAt === 'string' &&
      typeof authorization.reason === 'string'
  );
}

function validatedContextDefinition(
  input: unknown,
  registry: ContractRegistryV1,
  issues: ContractIssue[]
): ExperimentDefinition | undefined {
  const result = decodeDefinitionV1(input, { registry });
  if (!result.ok) {
    issues.push(...rebaseContextIssues(result.issues, '$/context/definition'));
    return undefined;
  }
  return result.value;
}

function requiredContextArray<T>(
  input: unknown,
  issues: ContractIssue[],
  options: { path: string; code: string; message: string }
): readonly T[] {
  if (Array.isArray(input)) return input as readonly T[];
  add(issues, 'run-reference', options.code, options.path, options.message);
  return [];
}

function validatedContextBindings<T>(
  input: unknown,
  issues: ContractIssue[],
  options: {
    path: string;
    requiredCode: string;
    requiredMessage: string;
    invalidCode: string;
    invalidMessage: string;
    shape: (value: unknown) => boolean;
  }
): readonly T[] {
  const required = requiredContextArray<unknown>(input, issues, {
    path: options.path,
    code: options.requiredCode,
    message: options.requiredMessage,
  });
  if (!Array.isArray(input)) return [];
  const prepared = preflight(required);
  if (prepared.issues.length > 0 || !Array.isArray(prepared.value)) {
    add(
      issues,
      'run-reference',
      options.invalidCode,
      options.path,
      options.invalidMessage
    );
    return [];
  }
  const bindings: T[] = [];
  prepared.value.forEach((candidate, index) => {
    if (!options.shape(candidate)) {
      add(
        issues,
        'run-reference',
        options.invalidCode,
        `${options.path}/${index}`,
        options.invalidMessage
      );
      return;
    }
    bindings.push(candidate as unknown as T);
  });
  return bindings;
}

function validatedContextRuns(
  input: unknown,
  issues: ContractIssue[],
  options: {
    basePath: string;
    missingStage: ContractIssueStage;
    missingCode: string;
    missingMessage: string;
  }
): ValidatedExperimentRunV1[] {
  if (!Array.isArray(input)) {
    add(
      issues,
      options.missingStage,
      options.missingCode,
      options.basePath,
      options.missingMessage
    );
    return [];
  }

  const runs: ValidatedExperimentRunV1[] = [];
  for (let index = 0; index < input.length; index++) {
    const basePath = `${options.basePath}/${index}`;
    const candidate = input[index];
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      !validatedRunValues.has(candidate)
    ) {
      add(
        issues,
        options.missingStage,
        'context.run-not-decoded',
        basePath,
        'context Runs must be immutable values returned by decodeRunV1'
      );
      continue;
    }
    const run = candidate as ValidatedExperimentRunV1;
    const existing = runs.find((candidate) => candidate.runId === run.runId);
    if (existing) {
      add(
        issues,
        'run-reference',
        existing.contentDigest === run.contentDigest
          ? 'context.duplicate-run-id'
          : 'run.identity-collision',
        `${basePath}/runId`,
        existing.contentDigest === run.contentDigest
          ? 'the context supplies the same immutable Run more than once'
          : 'immutable Run ID identifies different canonical bytes in the context'
      );
      continue;
    }
    runs.push(run);
  }
  return runs;
}

function validatedContextVerdict(
  input: unknown,
  issues: ContractIssue[]
): ValidatedExperimentVerdictV1 | null | undefined {
  if (input === null) return null;
  if (input === undefined) {
    add(
      issues,
      'verdict-policy',
      'context.previous-verdict-required',
      '$/context/previousVerdict',
      'Verdict decoding requires null for an initial Verdict or the current Verdict for a replacement'
    );
    return undefined;
  }
  if (typeof input !== 'object' || !validatedVerdictValues.has(input)) {
    add(
      issues,
      'verdict-policy',
      'context.verdict-not-decoded',
      '$/context/previousVerdict',
      'a prior current Verdict must be the immutable value returned by decodeVerdictV1'
    );
    return undefined;
  }
  return input as ValidatedExperimentVerdictV1;
}

function success<T extends ExperimentDefinition | ExperimentRun | ExperimentVerdict>(
  value: T
): ContractResult<T> {
  const normalized = normalizeDocument(value) as T;
  return {
    ok: true,
    value: freezeDeep(normalized),
    canonicalJson: canonicalDocumentJson(normalized),
  };
}

function runSuccess(
  value: ExperimentRun
): ContractResult<ValidatedExperimentRunV1> {
  const result = success(value) as ContractResult<ValidatedExperimentRunV1>;
  if (result.ok) validatedRunValues.add(result.value);
  return result;
}

function verdictSuccess(
  value: ExperimentVerdict
): ContractResult<ValidatedExperimentVerdictV1> {
  const result = success(value) as ContractResult<ValidatedExperimentVerdictV1>;
  if (result.ok) validatedVerdictValues.add(result.value);
  return result;
}

export function decodeDefinitionV1(
  input: unknown,
  context: DefinitionDecodeContextV1
): ContractResult<ExperimentDefinition> {
  const prepared = preflight(input);
  const issues = prepared.issues;
  if (issues.length > 0) return { ok: false, issues };
  const candidate = prepared.value as JsonValue;
  issues.push(...structuralIssues(candidate, 'ExperimentDefinition'));
  if (issues.length > 0) return { ok: false, issues };
  const registry = validatedContextRegistry(
    contextField(context, 'registry'),
    issues
  );
  if (!registry) return { ok: false, issues };
  const definition = candidate as unknown as ExperimentDefinition;
  validateDefinitionSemantics(definition, { registry }, issues);
  return issues.length > 0 ? { ok: false, issues } : success(definition);
}

export function decodeRunV1(
  input: unknown,
  context: RunDecodeContextV1
): ContractResult<ValidatedExperimentRunV1> {
  const prepared = preflight(input);
  const issues = prepared.issues;
  if (issues.length > 0) return { ok: false, issues };
  const candidate = prepared.value as JsonValue;
  issues.push(...structuralIssues(candidate, 'ExperimentRun'));
  if (issues.length > 0) return { ok: false, issues };
  const registry = validatedContextRegistry(
    contextField(context, 'registry'),
    issues
  );
  const selectionReceipts = validatedContextBindings<SelectionReceiptBindingV1>(
    contextField(context, 'selectionReceipts'),
    issues,
    {
      path: '$/context/selectionReceipts',
      requiredCode: 'context.selection-receipts-required',
      requiredMessage:
        'Run decoding requires Selection Receipt bindings (use [] when none exist)',
      invalidCode: 'context.selection-receipt-invalid',
      invalidMessage:
        'Selection Receipt bindings must have the complete immutable selected-receipt shape',
      shape: selectionReceiptShape,
    }
  );
  const triggerReceipts = validatedContextBindings<TriggerReceiptBindingV1>(
    contextField(context, 'triggerReceipts'),
    issues,
    {
      path: '$/context/triggerReceipts',
      requiredCode: 'context.trigger-receipts-required',
      requiredMessage:
        'Run decoding requires Trigger Receipt bindings (use [] when none exist)',
      invalidCode: 'context.trigger-receipt-invalid',
      invalidMessage:
        'Trigger Receipt bindings must have the complete immutable admitted-receipt shape',
      shape: triggerReceiptShape,
    }
  );
  const operatorSafeguardAuthorizations =
    validatedContextBindings<OperatorSafeguardAuthorizationV1>(
      contextField(context, 'operatorSafeguardAuthorizations'),
      issues,
      {
        path: '$/context/operatorSafeguardAuthorizations',
        requiredCode: 'context.operator-authorizations-required',
        requiredMessage:
          'Run decoding requires operator safeguard authorizations (use [] when none exist)',
        invalidCode: 'context.operator-authorization-invalid',
        invalidMessage:
          'operator safeguard authorizations must have the complete immutable v1 shape',
        shape: operatorAuthorizationShape,
      }
    );
  const priorRuns = validatedContextRuns(
    contextField(context, 'priorRuns'),
    issues,
    {
      basePath: '$/context/priorRuns',
      missingStage: 'run-reference',
      missingCode: 'context.prior-runs-required',
      missingMessage:
        'Run decoding requires the complete ordered set of prior Runs (use [] for the first Run)',
    }
  );
  if (!registry || issues.length > 0) return { ok: false, issues };
  const definition = validatedContextDefinition(
    contextField(context, 'definition'),
    registry,
    issues
  );
  if (!definition) return { ok: false, issues };
  const run = candidate as unknown as ExperimentRun;
  validateRunSemantics(
    run,
    {
      definition,
      registry,
      selectionReceipts,
      triggerReceipts,
      operatorSafeguardAuthorizations,
      priorRuns,
    },
    issues
  );
  return issues.length > 0 ? { ok: false, issues } : runSuccess(run);
}

export function decodeVerdictV1(
  input: unknown,
  context: VerdictDecodeContextV1
): ContractResult<ValidatedExperimentVerdictV1> {
  const prepared = preflight(input);
  const issues = prepared.issues;
  if (issues.length > 0) return { ok: false, issues };
  const candidate = prepared.value as JsonValue;
  issues.push(...structuralIssues(candidate, 'ExperimentVerdict'));
  if (issues.length > 0) return { ok: false, issues };
  const registry = validatedContextRegistry(
    contextField(context, 'registry'),
    issues
  );
  if (!registry) return { ok: false, issues };
  const definition = validatedContextDefinition(
    contextField(context, 'definition'),
    registry,
    issues
  );
  const trialRuns = validatedContextRuns(
    contextField(context, 'trialRuns'),
    issues,
    {
      basePath: '$/context/trialRuns',
      missingStage: 'verdict-policy',
      missingCode: 'context.trial-runs-required',
      missingMessage: 'Verdict decoding requires the complete set of trial Runs',
    }
  );
  const previousVerdict = validatedContextVerdict(
    contextField(context, 'previousVerdict'),
    issues
  );
  if (!definition || previousVerdict === undefined || issues.length > 0) {
    return { ok: false, issues };
  }
  const verdict = candidate as unknown as ExperimentVerdict;
  validateVerdictSemantics(
    verdict,
    { definition, registry, trialRuns, previousVerdict },
    issues
  );
  return issues.length > 0 ? { ok: false, issues } : verdictSuccess(verdict);
}

/** Build an exact Run reference after a Run has passed the codec. */
export function runRef(run: ValidatedExperimentRunV1): RunRef {
  return { runId: run.runId, contentDigest: run.contentDigest };
}

/** Utility for fixture/building callers that need a typed digest placeholder. */
export const EMPTY_SHA256 = `sha256:${'0'.repeat(64)}` as Sha256Digest;

/** Type-only guard used by fixture builders. */
export function jsonValue<T extends JsonValue>(value: T): T {
  return value;
}
