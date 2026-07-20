import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

await import("../register-ts.mjs");

const {
  GATE_2702_C5_CONTRACT_REGISTRY,
  GATE_2702_C5_DEFINITION,
  GATE_2702_C5_FINGERPRINT_POLICY,
  GATE_2702_C5_SUBJECTS,
  createGate2702C5SelectionBinding,
} =
  await import("../../src/lib/experiment-runtime/bridges/gate-2702/definition.ts");
const {
  canonicalJson,
  decodeRunV1,
  decodeVerdictV1,
  withBehaviorFingerprintDigest,
  withDocumentDigest,
} = await import("../../src/lib/experiment-runtime/contracts/v1/index.ts");

const TRIAL_ID = "018f5e38-9e2f-7d22-8c63-54ecfbd0f500";
const SEALED_AT = "2026-07-20T18:00:00.000Z";
const TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];

function digest(value) {
  return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function withReceiptDigest(candidate) {
  const body = structuredClone(candidate);
  delete body.contentDigest;
  return { ...candidate, contentDigest: digest(canonicalJson(body)) };
}

function uuid(sequence) {
  return `018f5e38-9e2f-7d22-8c63-${String(sequence).padStart(12, "0")}`;
}

function definitionRef() {
  return {
    definitionId: GATE_2702_C5_DEFINITION.definitionId,
    definitionVersion: GATE_2702_C5_DEFINITION.definitionVersion,
    contentDigest: GATE_2702_C5_DEFINITION.contentDigest,
  };
}

function fingerprint(treatmentId) {
  const factorIds =
    GATE_2702_C5_FINGERPRINT_POLICY.factorIdsByAdapter[
      "gate-2702-claude-code-adapter"
    ];
  return withBehaviorFingerprintDigest({
    schemaVersion: 1,
    policy: { id: "fingerprints/gate-2702-c5", version: 1 },
    digest: digest("placeholder"),
    observedAt: "2026-07-20T16:59:00.000Z",
    completeness: "complete",
    runtime: {
      id: "experiment-runtime/gate-2702-c5",
      behaviorVersion: "1",
    },
    adapter: {
      id: "gate-2702-claude-code-adapter",
      behaviorVersion: "1",
      fingerprintSchemaVersion: 1,
    },
    model: { qualifiedId: "anthropic/claude-haiku-4-5-20251001" },
    factors: factorIds.map((id) => ({
      id,
      valueDigest: digest(`${treatmentId}:${id}`),
    })),
  });
}

function metricValue(metricId, values) {
  if (metricId === "metrics/gate-2702-all-in-cost") return values.costUsd;
  if (metricId === "metrics/gate-2702-wall-time") return values.wallTimeMs;
  if (metricId === "metrics/gate-2702-quality-loss") {
    return values.qualityLoss;
  }
  if (metricId === "metrics/gate-2702-sidekick-triggers") {
    return values.triggerCount;
  }
  if (metricId === "metrics/gate-2702-sidekick-paid-calls") {
    return values.paidCallCount;
  }
  if (metricId === "metrics/gate-2702-sidekick-shipped-interventions") {
    return values.shippedInterventionCount;
  }
  if (metricId === "metrics/gate-2702-attributable-ships") {
    return values.attributableShips;
  }
  throw new Error(`unknown fixture metric ${metricId}`);
}

function buildFixture({ pairValues }) {
  const fingerprints = Object.fromEntries(
    TREATMENTS.map((treatmentId) => [treatmentId, fingerprint(treatmentId)]),
  );
  const bindings = Object.fromEntries(
    TREATMENTS.map((treatmentId, index) => [
      treatmentId,
      createGate2702C5SelectionBinding({
        receiptId: uuid(800 + index),
        receiptDigest: digest(`selection:${treatmentId}`),
        trialId: TRIAL_ID,
        behaviorFingerprintDigest: fingerprints[treatmentId].digest,
        treatmentId,
      }),
    ]),
  );
  const runs = [];
  for (const [subjectIndex, subject] of GATE_2702_C5_SUBJECTS.entries()) {
    for (const [treatmentIndex, treatmentId] of TREATMENTS.entries()) {
      const values = pairValues(subjectIndex, treatmentId);
      const status = values.status ?? "succeeded";
      const minute = subjectIndex * 2 + treatmentIndex;
      const startedAt = `2026-07-20T17:${String(minute).padStart(2, "0")}:00.000Z`;
      const finishedAt = `2026-07-20T17:${String(minute).padStart(2, "0")}:30.000Z`;
      const run = {
        schemaVersion: 1,
        kind: "ExperimentRun",
        runId: uuid(100 + subjectIndex * 2 + treatmentIndex),
        trialId: TRIAL_ID,
        contentDigest: digest("placeholder"),
        definitionRef: definitionRef(),
        treatmentId,
        retryOf: null,
        status,
        createdAt: "2026-07-20T16:59:30.000Z",
        startedAt,
        finishedAt,
        subjectRef: {
          harness: "claude-code",
          sourceId: "github:shpwrck/claude-history-dashboard",
          artifactId: `github:shpwrck/claude-history-dashboard/issues/${subject}`,
          contentDigest: digest(`subject:${subject}`),
          mediaType: "application/json",
        },
        assignment: { kind: "explicit" },
        selectedHarness: "claude-code",
        harnessProvenance: {
          origin: "claude-code",
          driver: "claude-code",
          worker: "claude-code",
          judge: "claude-code",
        },
        selectionRef: {
          receiptId: bindings[treatmentId].receiptId,
          receiptDigest: bindings[treatmentId].receiptDigest,
          planSlotId: `issue-${subject}.${treatmentId}`,
        },
        triggerRef: null,
        behaviorFingerprint: fingerprints[treatmentId],
        capabilitySnapshot: GATE_2702_C5_DEFINITION.requiredCapabilities.map(
          ({ semanticsRef }) => ({
            semanticsRef,
            state: "available",
            observedAt: "2026-07-20T16:59:00.000Z",
          }),
        ),
        effectiveLimits: { ...GATE_2702_C5_DEFINITION.limits },
        safeguardAuthorizations: [],
        sessionRef: {
          harness: "claude-code",
          sourceId: "local-gate-2702",
          sessionId: `worker-${subject}-${treatmentId}`,
        },
        observations:
          status === "succeeded"
            ? GATE_2702_C5_DEFINITION.metrics.map((metric) => ({
                metricId: metric.id,
                value: metricValue(metric.id, values),
                unit: metric.unit,
                scope: metric.scope,
                basis: metric.basis,
                semanticsVersion: metric.semanticsVersion,
                confidence: "high",
                observedAt: finishedAt,
                evidenceRefs: [
                  {
                    kind: "session",
                    contentDigest: digest(
                      `metric:${subject}:${treatmentId}:${metric.id}`,
                    ),
                    sessionRef: {
                      harness: "claude-code",
                      sourceId: "local-gate-2702",
                      sessionId: `worker-${subject}-${treatmentId}`,
                    },
                  },
                ],
              }))
            : [],
        checkResults:
          status === "succeeded"
            ? GATE_2702_C5_DEFINITION.checks.map((check) => ({
                checkId: check.id,
                outcome: "passed",
                startedAt,
                finishedAt,
                evidenceRefs: [
                  {
                    kind: "session",
                    contentDigest: digest(
                      `check:${subject}:${treatmentId}:${check.id}`,
                    ),
                    sessionRef: {
                      harness: "claude-code",
                      sourceId: "local-gate-2702",
                      sessionId: `worker-${subject}-${treatmentId}`,
                    },
                  },
                ],
              }))
            : [],
        usage: { wallTimeMs: values.wallTimeMs, costUsd: values.costUsd },
        error:
          status === "succeeded"
            ? null
            : {
                code: values.errorCode ?? `gate-2702/fixture-${status}`,
                message: `fixture ${status}`,
                evidenceRefs: [
                  {
                    kind: "session",
                    contentDigest: digest(
                      `error:${subject}:${treatmentId}:${status}`,
                    ),
                    sessionRef: {
                      harness: "claude-code",
                      sourceId: "local-gate-2702",
                      sessionId: `worker-${subject}-${treatmentId}`,
                    },
                  },
                ],
              },
        extensions: {
          "gate-2702/judgeResultDigest": digest(`judge:${subject}`),
        },
      };
      runs.push(withDocumentDigest(run));
    }
  }
  const manifest = {
    schemaVersion: 1,
    kind: "Gate2702SealBundle",
    contentDigest: digest("bundle:clearing"),
    trialId: TRIAL_ID,
    definitionRef: definitionRef(),
    selectionBindings: Object.values(bindings),
    canonicalRuns: runs.map((run) => ({
      sourcePath: `generated/runs/${run.runId}.json`,
      objectDigest: digest(`object:${run.runId}`),
      runId: run.runId,
      contentDigest: run.contentDigest,
    })),
    runCandidates: runs.map((run, index) => ({
      subject: GATE_2702_C5_SUBJECTS[Math.floor(index / 2)],
      treatmentId: run.treatmentId,
      attempt: 1,
      runId: run.runId,
      runDigest: run.contentDigest,
    })),
  };
  const marker = {
    schemaVersion: 1,
    kind: "Gate2702VerifiedSeal",
    contentDigest: digest("marker:clearing"),
    trialId: TRIAL_ID,
    definitionRef: definitionRef(),
    bundleDigest: manifest.contentDigest,
    sealedAt: SEALED_AT,
  };
  return {
    definition: GATE_2702_C5_DEFINITION,
    registry: GATE_2702_C5_CONTRACT_REGISTRY,
    runs,
    manifest,
    marker,
  };
}

function addRetry(
  fixture,
  { subjectIndex, treatmentId, values, runSequence = 700 + subjectIndex },
) {
  const subject = GATE_2702_C5_SUBJECTS[subjectIndex];
  const parent = fixture.runs.find(
    (run) =>
      run.subjectRef.artifactId.endsWith(`/${subject}`) &&
      run.treatmentId === treatmentId,
  );
  assert(parent, "retry fixture parent exists");
  const selectionBinding = {
    receiptId: uuid(900 + subjectIndex),
    receiptDigest: digest(`retry-selection:${subject}:${treatmentId}`),
    outcome: "selected",
    definitionRef: definitionRef(),
    trialId: TRIAL_ID,
    selectedHarness: "claude-code",
    adapterBinding: {
      adapterId: "gate-2702-claude-code-adapter",
      behaviorFingerprintDigest: parent.behaviorFingerprint.digest,
    },
    planSlots: [
      {
        planSlotId: `issue-${subject}.${treatmentId}.retry-2`,
        kind: "treatment-run",
        treatmentId,
      },
    ],
  };
  const startedAt = "2026-07-20T17:30:00.000Z";
  const finishedAt = "2026-07-20T17:30:30.000Z";
  const sessionRef = {
    harness: "claude-code",
    sourceId: "local-gate-2702",
    sessionId: `worker-${subject}-${treatmentId}-retry-2`,
  };
  const status = values.status ?? "succeeded";
  const retry = withDocumentDigest({
    ...structuredClone(parent),
    runId: uuid(runSequence),
    contentDigest: digest("placeholder"),
    retryOf: { runId: parent.runId, contentDigest: parent.contentDigest },
    status,
    createdAt: "2026-07-20T17:29:00.000Z",
    startedAt,
    finishedAt,
    selectionRef: {
      receiptId: selectionBinding.receiptId,
      receiptDigest: selectionBinding.receiptDigest,
      planSlotId: `issue-${subject}.${treatmentId}.retry-2`,
    },
    sessionRef,
    observations:
      status === "succeeded"
        ? GATE_2702_C5_DEFINITION.metrics.map((metric) => ({
            metricId: metric.id,
            value: metricValue(metric.id, values),
            unit: metric.unit,
            scope: metric.scope,
            basis: metric.basis,
            semanticsVersion: metric.semanticsVersion,
            confidence: "high",
            observedAt: finishedAt,
            evidenceRefs: [
              {
                kind: "session",
                contentDigest: digest(`retry-metric:${subject}:${metric.id}`),
                sessionRef,
              },
            ],
          }))
        : [],
    checkResults:
      status === "succeeded"
        ? GATE_2702_C5_DEFINITION.checks.map((check) => ({
            checkId: check.id,
            outcome: "passed",
            startedAt,
            finishedAt,
            evidenceRefs: [
              {
                kind: "session",
                contentDigest: digest(`retry-check:${subject}:${check.id}`),
                sessionRef,
              },
            ],
          }))
        : [],
    usage: { wallTimeMs: values.wallTimeMs, costUsd: values.costUsd },
    error:
      status === "succeeded"
        ? null
        : {
            code: values.errorCode ?? `gate-2702/fixture-${status}`,
            message: `fixture retry ${status}`,
            evidenceRefs: [
              {
                kind: "session",
                contentDigest: digest(
                  `retry-error:${subject}:${treatmentId}:${status}`,
                ),
                sessionRef,
              },
            ],
          },
  });
  fixture.runs.push(retry);
  fixture.manifest.selectionBindings.push(selectionBinding);
  fixture.manifest.canonicalRuns.push({
    sourcePath: `generated/runs/${retry.runId}.json`,
    objectDigest: digest(`object:${retry.runId}`),
    runId: retry.runId,
    contentDigest: retry.contentDigest,
  });
  fixture.manifest.runCandidates.push({
    subject,
    treatmentId,
    attempt: 2,
    runId: retry.runId,
    runDigest: retry.contentDigest,
  });
  return retry;
}

function addAmbiguousDuplicate(fixture, { subjectIndex, treatmentId }) {
  const subject = GATE_2702_C5_SUBJECTS[subjectIndex];
  const original = fixture.runs.find(
    (run) =>
      run.subjectRef.artifactId.endsWith(`/${subject}`) &&
      run.treatmentId === treatmentId,
  );
  assert(original, "duplicate fixture source exists");
  const binding = {
    receiptId: uuid(950 + subjectIndex),
    receiptDigest: digest(`duplicate-selection:${subject}:${treatmentId}`),
    outcome: "selected",
    definitionRef: definitionRef(),
    trialId: TRIAL_ID,
    selectedHarness: "claude-code",
    adapterBinding: {
      adapterId: "gate-2702-claude-code-adapter",
      behaviorFingerprintDigest: original.behaviorFingerprint.digest,
    },
    planSlots: [
      {
        planSlotId: `issue-${subject}.${treatmentId}.ambiguous`,
        kind: "treatment-run",
        treatmentId,
      },
    ],
  };
  const duplicate = withDocumentDigest({
    ...structuredClone(original),
    runId: uuid(60 + subjectIndex),
    contentDigest: digest("placeholder"),
    selectionRef: {
      receiptId: binding.receiptId,
      receiptDigest: binding.receiptDigest,
      planSlotId: binding.planSlots[0].planSlotId,
    },
    sessionRef: {
      ...original.sessionRef,
      sessionId: `${original.sessionRef.sessionId}-ambiguous`,
    },
  });
  fixture.runs.push(duplicate);
  fixture.manifest.selectionBindings.push(binding);
  fixture.manifest.canonicalRuns.push({
    sourcePath: `generated/runs/${duplicate.runId}.json`,
    objectDigest: digest(`object:${duplicate.runId}`),
    runId: duplicate.runId,
    contentDigest: duplicate.contentDigest,
  });
  fixture.manifest.runCandidates.push({
    subject,
    treatmentId,
    attempt: 1,
    runId: duplicate.runId,
    runDigest: duplicate.contentDigest,
  });
  return duplicate;
}

test("a powered, cheaper, attributable Sidekick arm clears every pre-registered gate", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: sidekick ? 20_000 : 30_000,
        qualityLoss: subjectIndex === 0 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.deepEqual(plain(verdict.outcome), {
    kind: "winner",
    winningTreatmentId: "haiku-sonnet-sidekick",
  });
  assert.equal(verdict.policyResult.parameters.decision, "sidekick-clears");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(verdict.policyResult.parameters.gates).map(
        ([key, value]) => [key, value.state],
      ),
    ),
    {
      parityFloor: "passed",
      netPositiveCost: "passed",
      attributableShips: "passed",
      minimumSample: "passed",
    },
  );
  assert.equal(verdict.evidence.includedRuns.length, 12);
  assert.equal(verdict.evidence.excludedRuns.length, 0);
  assert.equal(verdict.primaryEffect.estimate, 0.5);
  assert.deepEqual(plain(verdict.primaryEffect.sampleCounts), [
    { treatmentId: "haiku-solo", n: 6 },
    { treatmentId: "haiku-sonnet-sidekick", n: 6 },
  ]);
  assert.equal(verdict.createdAt, "2026-07-20T17:11:30.000Z");
  assert.equal(verdict.updatedAt, "2026-07-20T17:11:30.000Z");

  const decoded = decodeVerdictV1(verdict, {
    definition: fixture.definition,
    registry: fixture.registry,
    trialRuns: fixture.runs.reduce((priorRuns, run) => {
      const result = decodeRunV1(run, {
        definition: fixture.definition,
        registry: fixture.registry,
        selectionReceipts: fixture.manifest.selectionBindings,
        triggerReceipts: [],
        operatorSafeguardAuthorizations: [],
        priorRuns,
      });
      assert.equal(result.ok, true, JSON.stringify(result.issues));
      return [...priorRuns, result.value];
    }, []),
    previousVerdict: null,
  });
  assert.equal(decoded.ok, true, JSON.stringify(decoded.issues));
});

test("failed and cancelled arms exclude their incomplete counterparts and stay honestly underpowered", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      const status =
        subjectIndex === 0 && !sidekick
          ? "failed"
          : subjectIndex === 1 && sidekick
            ? "cancelled"
            : "succeeded";
      return {
        status,
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.deepEqual(plain(verdict.outcome), {
    kind: "inconclusive",
    reason: "sample/minimum-not-met",
  });
  assert.equal(verdict.policyResult.parameters.decision, "inconclusive");
  assert.equal(verdict.evidence.includedRuns.length, 8);
  assert.deepEqual(
    plain(verdict.evidence.excludedRuns)
      .map(({ reason }) => reason)
      .sort(),
    [
      "run/pair-incomplete",
      "run/pair-incomplete",
      "run/status-cancelled",
      "run/status-failed",
    ],
  );
  assert.deepEqual(
    plain(verdict.policyResult.parameters.gates.minimumSample.observed),
    {
      requiredRunsPerTreatment: 6,
      controlRuns: 4,
      treatmentRuns: 4,
      sealedCandidateExclusionCount: 0,
    },
  );
});

test("all strict terminal failures produce a decodable empty-evidence Verdict", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(_subjectIndex, treatmentId) {
      return {
        status: "failed",
        costUsd: treatmentId === "haiku-sonnet-sidekick" ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: 0,
        paidCallCount: 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.deepEqual(plain(verdict.outcome), {
    kind: "inconclusive",
    reason: "sample/minimum-not-met",
  });
  assert.deepEqual(plain(verdict.evidence.includedRuns), []);
  assert.equal(verdict.evidence.excludedRuns.length, 12);
  assert.deepEqual(
    plain(verdict.evidenceBasis.satisfiedCapabilitySemantics),
    [],
  );
});

test("a Run with a mismatched Definition reference is rejected before policy evaluation", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(_subjectIndex, treatmentId) {
      return {
        costUsd: treatmentId === "haiku-sonnet-sidekick" ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: 0,
        paidCallCount: 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });
  const mismatched = withDocumentDigest({
    ...structuredClone(fixture.runs[0]),
    definitionRef: {
      ...definitionRef(),
      contentDigest: digest("different-definition"),
    },
  });
  fixture.runs[0] = mismatched;
  fixture.manifest.canonicalRuns[0] = {
    ...fixture.manifest.canonicalRuns[0],
    contentDigest: mismatched.contentDigest,
  };

  await assert.rejects(
    evaluateTrialEvidence(fixture),
    /is not strict C5 v1 evidence/,
  );
});

test("an eligible retry supersedes its failed parent without double-counting the pair", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        status: subjectIndex === 0 && !sidekick ? "failed" : "succeeded",
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: subjectIndex === 1 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 1 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 1 && sidekick ? 1 : 0,
      };
    },
  });
  const retry = addRetry(fixture, {
    subjectIndex: 0,
    treatmentId: "haiku-solo",
    values: {
      costUsd: 2,
      wallTimeMs: 20_000,
      qualityLoss: 0,
      triggerCount: 0,
      paidCallCount: 0,
      shippedInterventionCount: 0,
      attributableShips: 0,
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.equal(verdict.policyResult.parameters.decision, "sidekick-clears");
  assert.equal(verdict.evidence.includedRuns.length, 12);
  assert(
    verdict.evidence.includedRuns.some((run) => run.runId === retry.runId),
  );
  assert.deepEqual(
    plain(verdict.evidence.excludedRuns).map(({ reason }) => reason),
    ["run/retry-superseded"],
  );
  assert.deepEqual(plain(verdict.primaryEffect.sampleCounts), [
    { treatmentId: "haiku-solo", n: 6 },
    { treatmentId: "haiku-sonnet-sidekick", n: 6 },
  ]);
});

test("a failed retry is excluded with its superseded parent and incomplete pair", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        status: subjectIndex === 0 && !sidekick ? "failed" : "succeeded",
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });
  const parent = fixture.runs.find(
    (run) =>
      run.subjectRef.artifactId.endsWith(`/${GATE_2702_C5_SUBJECTS[0]}`) &&
      run.treatmentId === "haiku-solo",
  );
  const pairedTreatment = fixture.runs.find(
    (run) =>
      run.subjectRef.artifactId.endsWith(`/${GATE_2702_C5_SUBJECTS[0]}`) &&
      run.treatmentId === "haiku-sonnet-sidekick",
  );
  assert(parent, "failed retry parent fixture exists");
  assert(pairedTreatment, "failed retry paired treatment fixture exists");
  const retry = addRetry(fixture, {
    subjectIndex: 0,
    treatmentId: "haiku-solo",
    values: {
      status: "failed",
      errorCode: "gate-2702/retry-worker-failed",
      costUsd: 2,
      wallTimeMs: 20_000,
      qualityLoss: 0,
      triggerCount: 0,
      paidCallCount: 0,
      shippedInterventionCount: 0,
      attributableShips: 0,
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);
  const exclusions = new Map(
    plain(verdict.evidence.excludedRuns).map(({ run, reason }) => [
      run.runId,
      reason,
    ]),
  );

  assert.equal(verdict.policyResult.parameters.decision, "inconclusive");
  assert.equal(exclusions.get(parent.runId), "run/retry-superseded");
  assert.equal(exclusions.get(retry.runId), "run/status-failed");
  assert.equal(exclusions.get(pairedTreatment.runId), "run/pair-incomplete");
  assert.deepEqual(
    plain(verdict.primaryEffect),
    null,
    "an excluded retry leaves the fixed cohort underpowered",
  );
});

test("canonical input reordering, including a retry before its parent, cannot change Verdict bytes", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const { canonicalDocumentJson } =
    await import("../../src/lib/experiment-runtime/contracts/v1/index.ts");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        status: subjectIndex === 0 && !sidekick ? "failed" : "succeeded",
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });
  addRetry(fixture, {
    subjectIndex: 0,
    treatmentId: "haiku-solo",
    runSequence: 50,
    values: {
      costUsd: 2,
      wallTimeMs: 20_000,
      qualityLoss: 1,
      triggerCount: 0,
      paidCallCount: 0,
      shippedInterventionCount: 0,
      attributableShips: 0,
    },
  });
  const reordered = {
    ...fixture,
    runs: [...fixture.runs].reverse(),
    marker: {
      ...fixture.marker,
      sealedAt: "2026-07-20T19:00:00.000Z",
    },
    manifest: {
      ...fixture.manifest,
      selectionBindings: [...fixture.manifest.selectionBindings].reverse(),
      canonicalRuns: [...fixture.manifest.canonicalRuns].reverse(),
      runCandidates: [...fixture.manifest.runCandidates].reverse(),
    },
  };

  const [first, second] = await Promise.all([
    evaluateTrialEvidence(fixture),
    evaluateTrialEvidence(reordered),
  ]);

  assert.equal(canonicalDocumentJson(first), canonicalDocumentJson(second));
  assert.equal(first.contentDigest, second.contentDigest);
});

test("ambiguous active Runs for one subject and treatment produce a typed invalid Verdict", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(_subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });
  addAmbiguousDuplicate(fixture, {
    subjectIndex: 0,
    treatmentId: "haiku-solo",
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.deepEqual(plain(verdict.outcome), {
    kind: "invalid",
    reason: "evidence/ambiguous-run-slot",
  });
  assert.equal(verdict.policyResult.parameters.decision, "invalid");
  assert.equal(verdict.primaryEffect, null);
  assert.equal(verdict.evidence.includedRuns.length, 12);
  assert.deepEqual(
    plain(verdict.evidence.excludedRuns)
      .map(({ reason }) => reason)
      .sort(),
    ["run/duplicate-slot"],
  );
  assert.equal(
    verdict.policyResult.parameters.gates.netPositiveCost.state,
    "not-evaluable",
  );
});

test("the known powered C5 failure shape is a control winner and explicit non-clear", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 3 : 1,
        wallTimeMs: sidekick ? 30_000 : 20_000,
        qualityLoss: subjectIndex === 0 && sidekick ? 1 : 0,
        triggerCount: sidekick ? 2 : 0,
        paidCallCount: sidekick ? 2 : 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.deepEqual(plain(verdict.outcome), {
    kind: "winner",
    winningTreatmentId: "haiku-solo",
  });
  assert.equal(
    verdict.policyResult.parameters.decision,
    "sidekick-does-not-clear",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(verdict.policyResult.parameters.gates).map(
        ([name, result]) => [name, result.state],
      ),
    ),
    {
      parityFloor: "failed",
      netPositiveCost: "failed",
      attributableShips: "failed",
      minimumSample: "passed",
    },
  );
  assert.equal(verdict.primaryEffect.estimate, -2);
});

test("a powered zero-cost control baseline reports an invalid relative effect without inventing an estimate", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 0,
        wallTimeMs: 20_000,
        qualityLoss: subjectIndex === 0 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.deepEqual(plain(verdict.outcome), {
    kind: "invalid",
    reason: "effect/relative-baseline-zero",
  });
  assert.equal(
    verdict.policyResult.parameters.decision,
    "sidekick-does-not-clear",
  );
  assert.equal(verdict.primaryEffect, null);
  assert.deepEqual(
    plain(verdict.policyResult.parameters.gates.netPositiveCost.observed),
    {
      controlAllInCostUsd: 0,
      treatmentAllInCostUsd: 6,
      savingsUsd: -6,
    },
  );
});

test("equal powered all-in cost emits a typed tie without clearing the strict cost gate", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: 1,
        wallTimeMs: 20_000,
        qualityLoss: subjectIndex === 0 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });

  const verdict = await evaluateTrialEvidence(fixture);

  assert.deepEqual(plain(verdict.outcome), { kind: "tie" });
  assert.equal(
    verdict.policyResult.parameters.decision,
    "sidekick-does-not-clear",
  );
  assert.equal(
    verdict.policyResult.parameters.gates.netPositiveCost.state,
    "failed",
  );
  assert.equal(verdict.primaryEffect.estimate, 0);
});

test("a corrected sealed Run set retains Verdict identity and records deterministic correction lineage", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        status: subjectIndex === 0 && !sidekick ? "failed" : "succeeded",
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });
  const initial = await evaluateTrialEvidence(fixture);
  assert.equal(initial.outcome.kind, "inconclusive");

  addRetry(fixture, {
    subjectIndex: 0,
    treatmentId: "haiku-solo",
    values: {
      costUsd: 2,
      wallTimeMs: 20_000,
      qualityLoss: 1,
      triggerCount: 0,
      paidCallCount: 0,
      shippedInterventionCount: 0,
      attributableShips: 0,
    },
  });
  fixture.manifest.contentDigest = digest("bundle:corrected");
  fixture.marker.bundleDigest = fixture.manifest.contentDigest;

  const corrected = await evaluateTrialEvidence({
    ...fixture,
    previousVerdict: initial,
  });

  assert.equal(corrected.verdictId, initial.verdictId);
  assert.equal(corrected.createdAt, initial.createdAt);
  assert.equal(corrected.updatedAt, "2026-07-20T17:30:30.000Z");
  assert.equal(
    corrected.updateReason,
    "Corrected deterministic #2702 C5 policy evaluation after the sealed Run set changed.",
  );
  assert.notEqual(corrected.contentDigest, initial.contentDigest);
  assert.equal(
    corrected.extensions["gate-2702/previousVerdictDigest"],
    initial.contentDigest,
  );
  assert.deepEqual(plain(corrected.outcome), {
    kind: "winner",
    winningTreatmentId: "haiku-sonnet-sidekick",
  });
  assert.equal(corrected.policyResult.parameters.decision, "sidekick-clears");
});

test("seal-only judge exhaustion and other candidate exclusions remain explicit and deterministic", async () => {
  const { evaluateTrialEvidence } = await import("./evaluate.mjs");
  const fixture = buildFixture({
    pairValues(_subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });
  const exhaustedRun = fixture.runs.find(
    (run) =>
      run.subjectRef.artifactId.endsWith(`/${GATE_2702_C5_SUBJECTS[0]}`) &&
      run.treatmentId === "haiku-sonnet-sidekick",
  );
  assert(exhaustedRun, "judge-exhausted candidate Run fixture exists");
  fixture.runs = fixture.runs.filter((run) => run.runId !== exhaustedRun.runId);
  fixture.manifest.canonicalRuns = fixture.manifest.canonicalRuns.filter(
    (entry) => entry.runId !== exhaustedRun.runId,
  );
  fixture.manifest.runCandidates = fixture.manifest.runCandidates.map(
    (candidate) =>
      candidate.runId === exhaustedRun.runId
        ? {
            subject: candidate.subject,
            treatmentId: candidate.treatmentId,
            attempt: candidate.attempt,
            exclusion: "judge-quality-not-evaluable",
          }
        : candidate,
  );
  fixture.manifest.runCandidates.push(
    {
      subject: 2719,
      treatmentId: "haiku-sonnet-sidekick",
      attempt: 2,
      exclusion: "unknown-all-in-cost:sidekick-ledger-pending",
    },
    {
      subject: 2760,
      treatmentId: "haiku-solo",
      attempt: 2,
      exclusion: "worker-session-id-unknown",
    },
  );

  const verdict = await evaluateTrialEvidence(fixture);

  assert.equal(verdict.outcome.kind, "inconclusive");
  assert.deepEqual(
    plain(verdict.evidence.excludedRuns)
      .map(({ reason }) => reason)
      .sort(),
    ["run/pair-incomplete"],
  );
  assert.deepEqual(
    plain(verdict.extensions["gate-2702/sealedCandidateExclusions"]),
    [
      {
        subject: 2719,
        treatmentId: "haiku-sonnet-sidekick",
        attempt: 2,
        reason: "unknown-all-in-cost:sidekick-ledger-pending",
      },
      {
        subject: 2760,
        treatmentId: "haiku-solo",
        attempt: 2,
        reason: "worker-session-id-unknown",
      },
      {
        subject: GATE_2702_C5_SUBJECTS[0],
        treatmentId: "haiku-sonnet-sidekick",
        attempt: 1,
        reason: "judge-quality-not-evaluable",
      },
    ],
  );
  assert.equal(
    verdict.policyResult.parameters.gates.minimumSample.observed
      .sealedCandidateExclusionCount,
    3,
  );
});

test("evaluate persists one canonical current Verdict and exposes one verified read seam", async () => {
  const { evaluateTrial, loadCurrentVerdict } = await import("./evaluate.mjs");
  const { canonicalDocumentJson } =
    await import("../../src/lib/experiment-runtime/contracts/v1/index.ts");
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-evaluate-"));
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: subjectIndex === 0 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });
  const dependencies = {
    loadVerifiedTrial: async () => fixture,
  };
  try {
    const first = await evaluateTrial(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    fixture.marker = {
      ...fixture.marker,
      sealedAt: "2026-07-20T23:59:59.000Z",
    };
    const second = await evaluateTrial(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    assert.equal(first.contentDigest, second.contentDigest);

    const evaluationRoot = join(
      stateRoot,
      GATE_2702_C5_DEFINITION.contentDigest.replace(":", "-"),
      TRIAL_ID,
      "evaluation",
    );
    const currentPath = join(evaluationRoot, "current.json");
    const objectPath = join(
      evaluationRoot,
      "results",
      `${first.contentDigest.replace(":", "-")}.json`,
    );
    assert.equal(existsSync(currentPath), true);
    assert.equal(existsSync(objectPath), true);
    const expectedBytes = `${canonicalDocumentJson(first)}\n`;
    assert.equal(readFileSync(currentPath, "utf8"), expectedBytes);
    assert.equal(readFileSync(objectPath, "utf8"), expectedBytes);
    assert.deepEqual(readdirSync(join(evaluationRoot, "results")), [
      `${first.contentDigest.replace(":", "-")}.json`,
    ]);

    const loaded = await loadCurrentVerdict(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    assert.equal(loaded.verdict.contentDigest, first.contentDigest);
    assert.equal(
      loaded.definition.contentDigest,
      fixture.definition.contentDigest,
    );
    assert.equal(loaded.runs.length, 12);
    assert.equal(loaded.manifest.contentDigest, fixture.manifest.contentDigest);
    assert.equal(loaded.marker.bundleDigest, fixture.marker.bundleDigest);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("durable evaluation rejects a changed verified bundle and requires a new trial", async () => {
  const { evaluateTrial, loadCurrentVerdict } = await import("./evaluate.mjs");
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-new-bundle-"));
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: subjectIndex === 0 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });
  const dependencies = { loadVerifiedTrial: async () => fixture };
  try {
    await evaluateTrial({ trial: TRIAL_ID, stateRoot }, dependencies);
    const currentPath = join(
      stateRoot,
      GATE_2702_C5_DEFINITION.contentDigest.replace(":", "-"),
      TRIAL_ID,
      "evaluation",
      "current.json",
    );
    const originalBytes = readFileSync(currentPath, "utf8");
    fixture.manifest.contentDigest = digest("bundle:replacement");
    fixture.marker.bundleDigest = fixture.manifest.contentDigest;

    await assert.rejects(
      evaluateTrial({ trial: TRIAL_ID, stateRoot }, dependencies),
      /durable corrections are unsupported; start a new trial/,
    );
    await assert.rejects(
      loadCurrentVerdict({ trial: TRIAL_ID, stateRoot }, dependencies),
      /durable corrections are unsupported; start a new trial/,
    );
    assert.equal(readFileSync(currentPath, "utf8"), originalBytes);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("durable evaluation rejects a persisted Verdict correction lineage", async () => {
  const { evaluateTrial, loadCurrentVerdict } = await import("./evaluate.mjs");
  const { canonicalDocumentJson } =
    await import("../../src/lib/experiment-runtime/contracts/v1/index.ts");
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-lineage-"));
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: subjectIndex === 0 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });
  const dependencies = { loadVerifiedTrial: async () => fixture };
  try {
    const genuine = await evaluateTrial(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    const evaluationRoot = join(
      stateRoot,
      GATE_2702_C5_DEFINITION.contentDigest.replace(":", "-"),
      TRIAL_ID,
      "evaluation",
    );
    const forgedCorrection = withDocumentDigest({
      ...structuredClone(genuine),
      extensions: {
        ...structuredClone(genuine.extensions),
        "gate-2702/previousVerdictDigest": genuine.contentDigest,
      },
    });
    const forgedBytes = `${canonicalDocumentJson(forgedCorrection)}\n`;
    writeFileSync(join(evaluationRoot, "current.json"), forgedBytes, {
      mode: 0o600,
    });
    writeFileSync(
      join(
        evaluationRoot,
        "results",
        `${forgedCorrection.contentDigest.replace(":", "-")}.json`,
      ),
      forgedBytes,
      { mode: 0o600 },
    );

    await assert.rejects(
      loadCurrentVerdict({ trial: TRIAL_ID, stateRoot }, dependencies),
      /persisted Verdict correction lineage is unsupported; start a new trial/,
    );
    await assert.rejects(
      evaluateTrial({ trial: TRIAL_ID, stateRoot }, dependencies),
      /persisted Verdict correction lineage is unsupported; start a new trial/,
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the verified read rejects a missing immutable object and a coherently re-digested false Verdict", async () => {
  const { evaluateTrial, loadCurrentVerdict } = await import("./evaluate.mjs");
  const { canonicalDocumentJson } =
    await import("../../src/lib/experiment-runtime/contracts/v1/index.ts");
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-tamper-"));
  const fixture = buildFixture({
    pairValues(subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: subjectIndex === 0 && !sidekick ? 1 : 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: subjectIndex === 0 && sidekick ? 1 : 0,
        attributableShips: subjectIndex === 0 && sidekick ? 1 : 0,
      };
    },
  });
  const dependencies = { loadVerifiedTrial: async () => fixture };
  try {
    const genuine = await evaluateTrial(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    const evaluationRoot = join(
      stateRoot,
      GATE_2702_C5_DEFINITION.contentDigest.replace(":", "-"),
      TRIAL_ID,
      "evaluation",
    );
    const currentPath = join(evaluationRoot, "current.json");
    const genuineObjectPath = join(
      evaluationRoot,
      "results",
      `${genuine.contentDigest.replace(":", "-")}.json`,
    );
    const genuineBytes = readFileSync(genuineObjectPath, "utf8");
    unlinkSync(genuineObjectPath);
    await assert.rejects(
      loadCurrentVerdict({ trial: TRIAL_ID, stateRoot }, dependencies),
      /immutable C5 evaluation object is missing/,
    );
    writeFileSync(genuineObjectPath, genuineBytes, { mode: 0o600 });

    const falseVerdict = withDocumentDigest({
      ...structuredClone(genuine),
      outcome: { kind: "tie" },
      policyResult: {
        ...structuredClone(genuine.policyResult),
        parameters: {
          ...structuredClone(genuine.policyResult.parameters),
          decision: "sidekick-does-not-clear",
          gates: {
            ...structuredClone(genuine.policyResult.parameters.gates),
            netPositiveCost: {
              ...structuredClone(
                genuine.policyResult.parameters.gates.netPositiveCost,
              ),
              state: "failed",
            },
          },
        },
      },
      primaryEffect: {
        ...structuredClone(genuine.primaryEffect),
        estimate: 0,
      },
    });
    const falseBytes = `${canonicalDocumentJson(falseVerdict)}\n`;
    const falseObjectPath = join(
      evaluationRoot,
      "results",
      `${falseVerdict.contentDigest.replace(":", "-")}.json`,
    );
    writeFileSync(currentPath, falseBytes, { mode: 0o600 });
    writeFileSync(falseObjectPath, falseBytes, { mode: 0o600 });

    await assert.rejects(
      loadCurrentVerdict({ trial: TRIAL_ID, stateRoot }, dependencies),
      /current C5 evaluation does not rederive from the verified seal/,
    );
    await assert.rejects(
      evaluateTrial({ trial: TRIAL_ID, stateRoot }, dependencies),
      /current C5 evaluation does not rederive from the verified seal/,
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("zero canonical Runs persist a deterministic, tamper-evident insufficient-evidence receipt", async () => {
  const {
    evaluateTrial,
    evaluateTrialEvidence,
    loadCurrentEvaluation,
    loadCurrentVerdict,
  } = await import("./evaluate.mjs");
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-empty-"));
  const fixture = buildFixture({
    pairValues(_subjectIndex, treatmentId) {
      const sidekick = treatmentId === "haiku-sonnet-sidekick";
      return {
        costUsd: sidekick ? 1 : 2,
        wallTimeMs: 20_000,
        qualityLoss: 0,
        triggerCount: sidekick ? 1 : 0,
        paidCallCount: sidekick ? 1 : 0,
        shippedInterventionCount: 0,
        attributableShips: 0,
      };
    },
  });
  fixture.runs = [];
  fixture.manifest.canonicalRuns = [];
  fixture.manifest.runCandidates = fixture.manifest.runCandidates.map(
    ({ runId: _runId, runDigest: _runDigest, ...candidate }) => ({
      ...candidate,
      exclusion: "complete-behavior-fingerprint-unavailable",
    }),
  );
  fixture.manifest.contentDigest = digest("bundle:zero-runs");
  fixture.marker.bundleDigest = fixture.manifest.contentDigest;
  const reordered = {
    ...fixture,
    manifest: {
      ...fixture.manifest,
      runCandidates: [...fixture.manifest.runCandidates].reverse(),
    },
  };
  const dependencies = { loadVerifiedTrial: async () => fixture };
  try {
    const [first, reorderedResult] = await Promise.all([
      evaluateTrialEvidence(fixture),
      evaluateTrialEvidence(reordered),
    ]);
    assert.deepEqual(plain(first), plain(reorderedResult));
    assert.equal(first.kind, "Gate2702InsufficientEvidence");
    assert.equal(first.state, "insufficient-evidence");
    assert.equal(first.reason, "evidence/no-canonical-runs");
    assert.equal(first.evaluatedAt, SEALED_AT);
    assert.deepEqual(plain(first.sampleCounts), [
      { treatmentId: "haiku-solo", n: 0 },
      { treatmentId: "haiku-sonnet-sidekick", n: 0 },
    ]);
    assert.equal(first.candidateExclusions.length, 12);

    const published = await evaluateTrial(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    const second = await evaluateTrial(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    assert.equal(published.contentDigest, second.contentDigest);
    const loaded = await loadCurrentEvaluation(
      { trial: TRIAL_ID, stateRoot },
      dependencies,
    );
    assert.equal(loaded.evaluation.contentDigest, published.contentDigest);
    await assert.rejects(
      loadCurrentVerdict({ trial: TRIAL_ID, stateRoot }, dependencies),
      /current C5 evaluation has no v1 Verdict/,
    );

    const evaluationRoot = join(
      stateRoot,
      GATE_2702_C5_DEFINITION.contentDigest.replace(":", "-"),
      TRIAL_ID,
      "evaluation",
    );
    const falseReceipt = withReceiptDigest({
      ...structuredClone(published),
      reason: "evidence/false-honest-null",
    });
    const falseBytes = `${canonicalJson(falseReceipt)}\n`;
    writeFileSync(join(evaluationRoot, "current.json"), falseBytes, {
      mode: 0o600,
    });
    writeFileSync(
      join(
        evaluationRoot,
        "results",
        `${falseReceipt.contentDigest.replace(":", "-")}.json`,
      ),
      falseBytes,
      { mode: 0o600 },
    );
    await assert.rejects(
      loadCurrentEvaluation({ trial: TRIAL_ID, stateRoot }, dependencies),
      /current C5 evaluation does not rederive from the verified seal/,
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
