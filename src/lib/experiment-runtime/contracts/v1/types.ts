/**
 * Harness-neutral experiment contract v1.
 *
 * These are wire types, not dashboard view models. Keep them independent of
 * transcript parsers, harness homes, vendor CLIs, and mutable runtime state.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export type Sha256Digest = `sha256:${string}`;
export type HarnessId = string;
export type Uuid = string;
export type UtcTimestamp = string;
export type Extensions = Record<string, JsonValue>;

export interface DefinitionRef {
  definitionId: string;
  definitionVersion: number;
  contentDigest: Sha256Digest;
}

export interface SemanticsRef {
  id: string;
  version: number;
  contentDigest: Sha256Digest;
}

export interface CapabilityRequirement {
  semanticsRef: SemanticsRef;
}

export interface CapabilityCertification {
  semanticsRef: SemanticsRef;
  state: 'available' | 'unavailable' | 'disabled' | 'unsupported' | 'stale';
  observedAt: UtcTimestamp;
  validUntil?: UtcTimestamp;
}

export interface SessionRef {
  harness: HarnessId;
  sourceId: string;
  sessionId: string;
}

export interface ArtifactRef {
  harness: HarnessId;
  sourceId: string;
  artifactId: string;
  contentDigest: Sha256Digest;
  mediaType?: string;
}

export interface SelectionRef {
  receiptId: Uuid;
  receiptDigest: Sha256Digest;
  planSlotId: string;
}

export interface TriggerRef {
  receiptId: Uuid;
  receiptDigest: Sha256Digest;
}

export type EvidenceRef =
  | {
      kind: 'session';
      contentDigest: Sha256Digest;
      sessionRef: SessionRef;
    }
  | {
      kind: 'artifact';
      artifactRef: ArtifactRef;
    };

export interface UsageBounds {
  wallTimeMs?: number;
  totalTokens?: number;
  turns?: number;
  toolCalls?: number;
  costUsd?: number;
}

export type Portability =
  | { class: 'portable' }
  | { class: 'harness-specific'; allowedHarnesses: HarnessId[] };

export type StudyDesign =
  | { kind: 'paired' }
  | {
      kind: 'cohort';
      assignment: { kind: 'explicit' | 'randomized' };
      minimumRunsPerTreatment: number;
      maximumRunsPerTreatment?: number;
    };

export interface WorkloadSelector {
  id: string;
  version: number;
  capability: CapabilityRequirement;
  parameters: JsonObject;
}

export interface TreatmentIntervention {
  capability: CapabilityRequirement;
  operation: string;
  value: JsonValue;
}

export interface ExperimentTreatment {
  id: string;
  label: string;
  control: boolean;
  interventions: TreatmentIntervention[];
}

export interface MetricDeclaration {
  id: string;
  unit: string;
  scope: 'run' | 'subject';
  basis: string;
  semanticsVersion: number;
  collector: {
    capability: CapabilityRequirement;
    operation: string;
    parameters: JsonObject;
  };
}

export interface CheckDeclaration {
  id: string;
  capability: CapabilityRequirement;
  operation: string;
  parameters: JsonObject;
}

export interface SafeguardRelaxationRequest {
  requestId: string;
  safeguard: string;
  requestedValue: JsonValue;
  reason: string;
}

export interface ExperimentDefinition {
  schemaVersion: 1;
  kind: 'ExperimentDefinition';
  definitionId: string;
  definitionVersion: number;
  contentDigest: Sha256Digest;
  title: string;
  description: string;
  createdAt: UtcTimestamp;
  createdBy: string;
  portability: Portability;
  studyDesign: StudyDesign;
  workload: { selector: WorkloadSelector };
  requiredCapabilities: CapabilityRequirement[];
  treatments: ExperimentTreatment[];
  metrics: MetricDeclaration[];
  checks: CheckDeclaration[];
  estimatedUsage: UsageBounds;
  limits: UsageBounds;
  safeguards: {
    policy: SemanticsRef;
    relaxationRequests: SafeguardRelaxationRequest[];
  };
  verdictPolicy: SemanticsRef & { parameters: JsonObject };
  extensions: Extensions;
}

export interface BehaviorFingerprint {
  schemaVersion: 1;
  policy: { id: string; version: number };
  digest: Sha256Digest;
  observedAt: UtcTimestamp;
  completeness: 'complete' | 'incomplete';
  runtime: { id: string; behaviorVersion: string };
  adapter: {
    id: string;
    behaviorVersion: string;
    fingerprintSchemaVersion: number;
  };
  model: { qualifiedId: string; revision?: string };
  factors: Array<{
    id: string;
    valueDigest: Sha256Digest;
    displayValue?: string;
  }>;
}

export type RunAssignment =
  | { kind: 'paired' }
  | { kind: 'explicit' }
  | { kind: 'randomized'; seed: string };

export interface MetricObservation {
  metricId: string;
  value: number;
  unit: string;
  scope: 'run' | 'subject';
  basis: string;
  semanticsVersion: number;
  confidence: 'high' | 'medium' | 'low';
  observedAt: UtcTimestamp;
  evidenceRefs: EvidenceRef[];
}

export interface CheckResult {
  checkId: string;
  outcome: 'passed' | 'failed' | 'skipped';
  startedAt: UtcTimestamp;
  finishedAt: UtcTimestamp;
  evidenceRefs: EvidenceRef[];
}

export interface RunError {
  code: string;
  message: string;
  evidenceRefs: EvidenceRef[];
}

export interface ExperimentRun {
  schemaVersion: 1;
  kind: 'ExperimentRun';
  runId: Uuid;
  trialId: Uuid;
  contentDigest: Sha256Digest;
  definitionRef: DefinitionRef;
  treatmentId: string;
  retryOf: RunRef | null;
  status: 'succeeded' | 'failed' | 'cancelled';
  createdAt: UtcTimestamp;
  startedAt: UtcTimestamp;
  finishedAt: UtcTimestamp;
  subjectRef: ArtifactRef;
  assignment: RunAssignment;
  selectedHarness: HarnessId;
  harnessProvenance: {
    origin: HarnessId;
    driver: HarnessId;
    worker: HarnessId;
    judge: HarnessId;
  };
  selectionRef: SelectionRef;
  triggerRef: TriggerRef | null;
  behaviorFingerprint: BehaviorFingerprint;
  capabilitySnapshot: CapabilityCertification[];
  effectiveLimits: UsageBounds;
  safeguardAuthorizations: Array<{
    requestId: string;
    approvedBy: string;
    approvedAt: UtcTimestamp;
    reason: string;
  }>;
  sessionRef: SessionRef;
  observations: MetricObservation[];
  checkResults: CheckResult[];
  usage: UsageBounds;
  error: RunError | null;
  extensions: Extensions;
}

export interface RunRef {
  runId: Uuid;
  contentDigest: Sha256Digest;
}

export interface PrimaryEffect {
  contrast: {
    controlTreatmentId: string;
    treatmentId: string;
  };
  metricRef: { id: string; semanticsVersion: number };
  estimator: { id: string; version: number };
  scale: 'absolute' | 'relative';
  unit: string;
  /** Normalized so a positive estimate means the Treatment is better. */
  estimate: number;
  uncertainty:
    | { kind: 'interval'; level: number; lower: number; upper: number }
    | { kind: 'not-estimated'; reason: string };
  sampleCounts: Array<{ treatmentId: string; n: number }>;
}

export type VerdictOutcome =
  | { kind: 'winner'; winningTreatmentId: string }
  | { kind: 'tie' }
  | { kind: 'inconclusive'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface ExperimentVerdict {
  schemaVersion: 1;
  kind: 'ExperimentVerdict';
  verdictId: Uuid;
  trialId: Uuid;
  contentDigest: Sha256Digest;
  definitionRef: DefinitionRef;
  policy: SemanticsRef;
  evidence: {
    includedRuns: RunRef[];
    excludedRuns: Array<{ run: RunRef; reason: string }>;
  };
  outcome: VerdictOutcome;
  policyResult: { basis: string; parameters: JsonObject };
  /** Source-only facts. Target applicability is a rebuildable read model. */
  evidenceBasis: {
    evidenceHarness: HarnessId;
    satisfiedCapabilitySemantics: SemanticsRef[];
  };
  primaryEffect: PrimaryEffect | null;
  judge: { harness: HarnessId; sessionRef: SessionRef };
  createdAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
  updateReason: string;
  extensions: Extensions;
}

export type ExperimentDocument =
  | ExperimentDefinition
  | ExperimentRun
  | ExperimentVerdict;
