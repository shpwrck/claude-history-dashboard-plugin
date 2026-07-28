import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  bootstrapCI,
  median,
  pairedDeltas,
  pairedMedianDelta,
  pairedMedianPctDelta,
  wilcoxonSignedRank,
} from './proof-stats';

export type ProofEvidenceArm = 'control' | 'injected';

export interface ProofWorkerResultEvidence {
  session: number;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  resultDigest: string | null;
  resultType: string | null;
}

export interface ProofRunEvidence {
  runId: string;
  pairId: string;
  arm: ProofEvidenceArm;
  runIndex: number;
  modelVersion: string;
  startedAt: string;
  finishedAt: string;
  unresolved: boolean;
  unresolvedReason: string | null;
  decidedSuccess: boolean | null;
  gate: {
    kind: string;
    command: string;
    expectMatch: string | null;
    pass: boolean;
    exitCode: number;
    expectedExitCode: number;
  } | null;
  costUsd: number;
  costSources: string[];
  tokenCounts: {
    total: number;
    perStep: number[];
  };
  wallMs: number;
  sessions: number;
  stableReads: number;
  perStepCostUsd: number[];
  workerResults: ProofWorkerResultEvidence[];
}

export interface ProofEvidenceContent {
  schemaVersion: '1';
  experimentRef: string;
  preRegistrationRef: string;
  fixtureSetRef: string;
  modelVersion: string;
  createdAt: string;
  pairOrder: string[];
  analysisPlan: {
    bootstrapIters: number;
    bootstrapAlpha: number;
    bootstrapSeed: number;
    qualityTolerance: number;
    minDecidedPairs: number;
    minimumDetectableEffectPct: number;
    significanceAlpha: number;
    sessionsPerChain: number;
    observedUsdPerMo: number;
  };
  runs: ProofRunEvidence[];
}

export interface ProofEvidenceArtifact {
  schemaVersion: '1';
  kind: 'PROOF_EVIDENCE';
  artifactDigest: string;
  content: ProofEvidenceContent;
}

export interface ProofRederivedAnalysis {
  pairs: Array<{
    pairId: string;
    pairDecided: boolean;
    control: {
      nDecided: number;
      nSuccess: number;
      medianCostUsd: number;
      medianWallMs: number;
    };
    injected: {
      nDecided: number;
      nSuccess: number;
      medianCostUsd: number;
      medianWallMs: number;
    };
  }>;
  nDecided: number;
  controlSuccessRate: number;
  injectedSuccessRate: number;
  qualityHoldPass: boolean;
  medianCostDeltaUsd: number;
  medianCostDeltaPct: number;
  medianLatencyDeltaMs: number;
  bootstrap: {
    lo: number;
    hi: number;
    iters: number;
    alpha: number;
    seed: number;
  };
  wilcoxon: {
    statistic: number;
    pOneSided: number;
    n: number;
  };
  verdict: 'proven' | 'null' | 'refuted' | 'not-yet-provable';
  reclaimUsdPerMo: number;
  doseResponse: Array<{
    session: number;
    medianCumulativeDeltaUsd: number;
    n: number;
  }>;
}

type VerificationResult =
  | { ok: true }
  | { ok: false; error: string };

type ReceiptVerificationResult =
  | { ok: true; analysis: ProofRederivedAnalysis }
  | { ok: false; error: string };

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          canonicalValue((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digestContent(content: ProofEvidenceContent): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(content))
    .digest('hex')}`;
}

export function createProofEvidenceArtifact(
  content: ProofEvidenceContent
): ProofEvidenceArtifact {
  return {
    schemaVersion: '1',
    kind: 'PROOF_EVIDENCE',
    artifactDigest: digestContent(content),
    content,
  };
}

export function verifyProofEvidenceArtifact(
  artifact: ProofEvidenceArtifact
): VerificationResult {
  if (
    artifact?.schemaVersion !== '1' ||
    artifact?.kind !== 'PROOF_EVIDENCE' ||
    !artifact.content ||
    !DIGEST_PATTERN.test(artifact.artifactDigest ?? '')
  ) {
    return { ok: false, error: 'Malformed proof evidence envelope' };
  }
  const actual = digestContent(artifact.content);
  if (actual !== artifact.artifactDigest) {
    return {
      ok: false,
      error: `Proof evidence digest mismatch: expected ${artifact.artifactDigest}, computed ${actual}`,
    };
  }
  return { ok: true };
}

export function persistProofEvidenceArtifact(
  artifact: ProofEvidenceArtifact,
  directory: string
): { path: string; artifactDigest: string } {
  const verification = verifyProofEvidenceArtifact(artifact);
  if (!verification.ok) throw new Error(verification.error);

  mkdirSync(directory, { recursive: true });
  const digestHex = artifact.artifactDigest.slice('sha256:'.length);
  const path = join(directory, `proof-evidence-sha256-${digestHex}.json`);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  try {
    writeFileSync(path, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    const existing = readFileSync(path, 'utf8');
    if (existing !== serialized) {
      throw new Error(
        `Existing proof evidence path does not match its content digest: ${path}`,
        { cause: error }
      );
    }
  }
  return { path, artifactDigest: artifact.artifactDigest };
}

function rate(values: boolean[]): number {
  return values.length === 0
    ? 0
    : values.filter(Boolean).length / values.length;
}

function cumulative(values: number[]): number[] {
  const result: number[] = [];
  let total = 0;
  for (const value of values) {
    total += Number.isFinite(value) ? value : 0;
    result.push(total);
  }
  return result;
}

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Proof evidence field ${field} must be finite`);
  }
  return value;
}

function summarizeRuns(runs: ProofRunEvidence[]): {
  nDecided: number;
  nSuccess: number;
  armSuccess: boolean;
  medianCostUsd: number;
  medianWallMs: number;
  perStepMedianCostUsd: number[];
} {
  const decided = runs.filter((run) => !run.unresolved);
  for (const run of decided) {
    if (typeof run.decidedSuccess !== 'boolean' || !run.gate) {
      throw new Error(`DECIDED run ${run.runId} is missing its gate outcome`);
    }
  }
  const costs = decided.map((run) =>
    requireFinite(run.costUsd, `${run.runId}.costUsd`)
  );
  const wall = decided.map((run) =>
    requireFinite(run.wallMs, `${run.runId}.wallMs`)
  );
  const nSteps = decided.length
    ? Math.max(...decided.map((run) => run.perStepCostUsd.length))
    : 0;
  const perStepMedianCostUsd = Array.from({ length: nSteps }, (_, index) => {
    const values = decided
      .map((run) => run.perStepCostUsd[index])
      .filter((value): value is number => Number.isFinite(value));
    return values.length ? median(values) : Number.NaN;
  });
  return {
    nDecided: decided.length,
    nSuccess: decided.filter((run) => run.decidedSuccess).length,
    armSuccess: decided.some((run) => run.decidedSuccess),
    medianCostUsd: costs.length ? median(costs) : Number.NaN,
    medianWallMs: wall.length ? median(wall) : Number.NaN,
    perStepMedianCostUsd,
  };
}

function deriveVerdict(
  analysis: Pick<
    ProofRederivedAnalysis,
    | 'nDecided'
    | 'medianCostDeltaPct'
    | 'bootstrap'
    | 'wilcoxon'
    | 'qualityHoldPass'
  >,
  plan: ProofEvidenceContent['analysisPlan']
): ProofRederivedAnalysis['verdict'] {
  if (analysis.nDecided < plan.minDecidedPairs) return 'not-yet-provable';
  if (
    (Number.isFinite(analysis.bootstrap.lo) && analysis.bootstrap.lo > 0) ||
    !analysis.qualityHoldPass
  ) {
    return 'refuted';
  }
  if (
    analysis.medianCostDeltaPct <= -plan.minimumDetectableEffectPct &&
    Number.isFinite(analysis.bootstrap.hi) &&
    analysis.bootstrap.hi < 0 &&
    analysis.wilcoxon.pOneSided < plan.significanceAlpha
  ) {
    return 'proven';
  }
  return 'null';
}

export function rederiveProofAnalysis(
  content: ProofEvidenceContent
): ProofRederivedAnalysis {
  if (content.schemaVersion !== '1') {
    throw new Error('Unsupported proof evidence content schema');
  }
  if (new Set(content.pairOrder).size !== content.pairOrder.length) {
    throw new Error('Proof evidence pairOrder contains duplicates');
  }
  const knownPairs = new Set(content.pairOrder);
  for (const run of content.runs) {
    if (!knownPairs.has(run.pairId)) {
      throw new Error(`Run ${run.runId} references an unknown pair`);
    }
    if (run.modelVersion !== content.modelVersion) {
      throw new Error(`Run ${run.runId} model does not match the batch model`);
    }
  }

  const pairs = content.pairOrder.map((pairId) => {
    const control = summarizeRuns(
      content.runs.filter(
        (run) => run.pairId === pairId && run.arm === 'control'
      )
    );
    const injected = summarizeRuns(
      content.runs.filter(
        (run) => run.pairId === pairId && run.arm === 'injected'
      )
    );
    return {
      pairId,
      pairDecided: control.nDecided > 0 && injected.nDecided > 0,
      control,
      injected,
    };
  });
  const decidedPairs = pairs.filter((pair) => pair.pairDecided);

  const costPairs = decidedPairs.map((pair) => ({
    control: pair.control.medianCostUsd,
    treatment: pair.injected.medianCostUsd,
  }));
  const latencyPairs = decidedPairs.map((pair) => ({
    control: pair.control.medianWallMs,
    treatment: pair.injected.medianWallMs,
  }));
  const deltas = pairedDeltas(costPairs);
  const bootstrapResult = costPairs.length
    ? bootstrapCI(deltas, {
        iters: content.analysisPlan.bootstrapIters,
        alpha: content.analysisPlan.bootstrapAlpha,
        seed: content.analysisPlan.bootstrapSeed,
      })
    : {
        lo: Number.NaN,
        hi: Number.NaN,
        iters: content.analysisPlan.bootstrapIters,
      };
  const wilcoxon = costPairs.length
    ? wilcoxonSignedRank(costPairs)
    : { statistic: 0, pOneSided: 1, n: 0 };
  const controlSuccessRate = rate(
    decidedPairs.map((pair) => pair.control.armSuccess)
  );
  const injectedSuccessRate = rate(
    decidedPairs.map((pair) => pair.injected.armSuccess)
  );
  const nDecided = decidedPairs.length;
  const qualityHoldPass =
    nDecided > 0 &&
    injectedSuccessRate >=
      controlSuccessRate - content.analysisPlan.qualityTolerance;
  const medianCostDeltaUsd = costPairs.length
    ? pairedMedianDelta(costPairs)
    : Number.NaN;
  const medianCostDeltaPct = costPairs.length
    ? pairedMedianPctDelta(costPairs)
    : Number.NaN;
  const medianLatencyDeltaMs = latencyPairs.length
    ? pairedMedianDelta(latencyPairs)
    : Number.NaN;
  const bootstrap = {
    ...bootstrapResult,
    alpha: content.analysisPlan.bootstrapAlpha,
    seed: content.analysisPlan.bootstrapSeed,
  };

  const doseResponse = content.analysisPlan.sessionsPerChain
    ? Array.from(
        { length: content.analysisPlan.sessionsPerChain },
        (_, index) => {
          const sessionDeltas = decidedPairs
            .map((pair) => {
              const control =
                cumulative(pair.control.perStepMedianCostUsd)[index];
              const injected =
                cumulative(pair.injected.perStepMedianCostUsd)[index];
              return Number.isFinite(control) && Number.isFinite(injected)
                ? injected - control
                : null;
            })
            .filter((value): value is number => value !== null);
          return {
            session: index + 1,
            medianCumulativeDeltaUsd: sessionDeltas.length
              ? median(sessionDeltas)
              : Number.NaN,
            n: sessionDeltas.length,
          };
        }
      )
    : [];

  const partial = {
    nDecided,
    controlSuccessRate,
    injectedSuccessRate,
    qualityHoldPass,
    medianCostDeltaUsd,
    medianCostDeltaPct,
    medianLatencyDeltaMs,
    bootstrap,
    wilcoxon,
  };
  const verdict = deriveVerdict(partial, content.analysisPlan);
  const reclaimUsdPerMo =
    verdict === 'proven' && Number.isFinite(medianCostDeltaPct)
      ? Math.max(
          0,
          content.analysisPlan.observedUsdPerMo *
            (-medianCostDeltaPct / 100)
        )
      : 0;
  return {
    pairs: pairs.map(({ pairId, pairDecided, control, injected }) => ({
      pairId,
      pairDecided,
      control: {
        nDecided: control.nDecided,
        nSuccess: control.nSuccess,
        medianCostUsd: control.medianCostUsd,
        medianWallMs: control.medianWallMs,
      },
      injected: {
        nDecided: injected.nDecided,
        nSuccess: injected.nSuccess,
        medianCostUsd: injected.medianCostUsd,
        medianWallMs: injected.medianWallMs,
      },
    })),
    ...partial,
    verdict,
    reclaimUsdPerMo,
    doseResponse,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function verifyProofReceiptAgainstEvidence(
  receipt: Record<string, unknown>,
  artifact: ProofEvidenceArtifact
): ReceiptVerificationResult {
  const artifactVerification = verifyProofEvidenceArtifact(artifact);
  if (!artifactVerification.ok) return artifactVerification;

  let analysis: ProofRederivedAnalysis;
  try {
    analysis = rederiveProofAnalysis(artifact.content);
  } catch (error) {
    return {
      ok: false,
      error: `Could not rederive proof evidence: ${(error as Error).message}`,
    };
  }

  const experiment = record(receipt.experiment);
  const observed = record(receipt.observed);
  const result = record(receipt.result);
  const projection = record(receipt.projection);
  const dimensions = record(result?.perDimensionDeltas);
  const statistics = record(result?.statistics);
  const bootstrap = record(statistics?.bootstrap);
  const wilcoxon = record(statistics?.wilcoxon);
  const expectedVerdict =
    analysis.verdict === 'not-yet-provable' ? 'null' : analysis.verdict;
  const expectedStatistics = {
    nDecided: analysis.nDecided,
    controlSuccessRate: analysis.controlSuccessRate,
    injectedSuccessRate: analysis.injectedSuccessRate,
    qualityHoldPass: analysis.qualityHoldPass,
    bootstrap: {
      ...analysis.bootstrap,
      lo: Number.isFinite(analysis.bootstrap.lo)
        ? analysis.bootstrap.lo
        : null,
      hi: Number.isFinite(analysis.bootstrap.hi)
        ? analysis.bootstrap.hi
        : null,
    },
    wilcoxon: analysis.wilcoxon,
  };
  const actualStatistics = {
    nDecided: statistics?.nDecided,
    controlSuccessRate: statistics?.controlSuccessRate,
    injectedSuccessRate: statistics?.injectedSuccessRate,
    qualityHoldPass: statistics?.qualityHoldPass,
    bootstrap,
    wilcoxon,
  };
  const checks: Array<[boolean, string]> = [
    [
      receipt.evidenceDigest === artifact.artifactDigest,
      'receipt evidenceDigest does not bind the artifact',
    ],
    [
      typeof receipt.evidenceRef === 'string' &&
        receipt.evidenceRef.trim().length > 0,
      'receipt evidenceRef is missing',
    ],
    [
      receipt.experimentRef === artifact.content.experimentRef,
      'experimentRef differs from evidence',
    ],
    [
      receipt.preRegistrationRef === artifact.content.preRegistrationRef,
      'preRegistrationRef differs from evidence',
    ],
    [
      receipt.modelVersion === artifact.content.modelVersion,
      'modelVersion differs from evidence',
    ],
    [
      observed?.observedUsdPerMo ===
        artifact.content.analysisPlan.observedUsdPerMo,
      'observedUsdPerMo differs from evidence',
    ],
    [experiment?.n === analysis.nDecided, 'DECIDED-pair count differs'],
    [
      result?.effectSize ===
        (Number.isFinite(analysis.medianCostDeltaUsd)
          ? analysis.medianCostDeltaUsd
          : 0),
      'effectSize differs',
    ],
    [
      dimensions?.costUsd ===
        (Number.isFinite(analysis.medianCostDeltaUsd)
          ? analysis.medianCostDeltaUsd
          : 0),
      'costUsd delta differs',
    ],
    [
      dimensions?.costPct ===
        (Number.isFinite(analysis.medianCostDeltaPct)
          ? analysis.medianCostDeltaPct
          : 0),
      'costPct delta differs',
    ],
    [
      dimensions?.latencyMs ===
        (Number.isFinite(analysis.medianLatencyDeltaMs)
          ? analysis.medianLatencyDeltaMs
          : 0),
      'latency delta differs',
    ],
    [same(actualStatistics, expectedStatistics), 'statistics differ'],
    [result?.verdict === expectedVerdict, 'verdict differs'],
    [
      projection?.reclaimUsdPerMo === analysis.reclaimUsdPerMo,
      'projection differs',
    ],
  ];
  const failure = checks.find(([ok]) => !ok);
  return failure
    ? { ok: false, error: failure[1] }
    : { ok: true, analysis };
}
