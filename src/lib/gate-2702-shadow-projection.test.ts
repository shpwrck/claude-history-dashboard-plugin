import { describe, expect, it } from "vitest";
import {
  projectGate2702C5,
  type Gate2702ProjectionSource,
} from "./gate-2702-shadow-projection";

const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest:
    "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba",
};
const TRIAL = "11111111-1111-5111-8111-111111111111";
const BUNDLE = `sha256:${"c".repeat(64)}`;

function digest(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function run(
  id: string,
  subject: number,
  options: {
    treatmentId?: "haiku-solo" | "haiku-sonnet-sidekick";
    status?: "succeeded" | "failed" | "cancelled";
    checkOutcome?: "passed" | "failed";
    errorCode?: string | null;
    qualityLoss?: number;
    triggerCount?: number;
    paidCallCount?: number;
    shippedInterventionCount?: number;
    finishedAt?: string;
  } = {},
) {
  const metric = (metricId: string, value: number) => ({ metricId, value });
  return {
    schemaVersion: 1,
    kind: "ExperimentRun",
    runId: id,
    trialId: TRIAL,
    contentDigest: digest(id[0]),
    definitionRef: DEFINITION_REF,
    treatmentId: options.treatmentId ?? "haiku-solo",
    status: options.status ?? "succeeded",
    finishedAt:
      options.finishedAt ??
      `2026-07-20T18:${String(subject % 60).padStart(2, "0")}:00Z`,
    subjectRef: {
      artifactId: `github:shpwrck/claude-history-dashboard/issues/${subject}`,
      prompt: "private prompt sentinel",
    },
    observations: [
      metric("metrics/gate-2702-quality-loss", options.qualityLoss ?? 0),
      metric("metrics/gate-2702-sidekick-triggers", options.triggerCount ?? 0),
      metric(
        "metrics/gate-2702-sidekick-paid-calls",
        options.paidCallCount ?? 0,
      ),
      metric(
        "metrics/gate-2702-sidekick-shipped-interventions",
        options.shippedInterventionCount ?? 0,
      ),
    ],
    checkResults: [
      {
        checkId: "checks/gate-2702-vitest",
        outcome: options.checkOutcome ?? "passed",
        stdout: "private stdout sentinel",
      },
      { checkId: "checks/gate-2702-typecheck", outcome: "passed" },
    ],
    usage: { wallTimeMs: 12_000, costUsd: 1.25 },
    error: options.errorCode
      ? { code: options.errorCode, message: "private error prose sentinel" }
      : null,
    extensions: {
      "gate-2702/judgeResultDigest": digest("b"),
      "private/rawDiff": "diff --git private sentinel",
    },
  };
}

type FixtureRun = ReturnType<typeof run>;

function candidate(value: FixtureRun, attempt: 1 | 2 = 1) {
  return {
    subject: Number(value.subjectRef.artifactId.split("/").at(-1)),
    treatmentId: value.treatmentId,
    attempt,
    status: value.status,
    runId: value.runId,
    runDigest: value.contentDigest,
  };
}

function sealOnlyCandidate(subject: number, exclusion: string) {
  return {
    subject,
    treatmentId: "haiku-solo",
    attempt: 1,
    status: "succeeded",
    exclusion,
  };
}

function judgeResult(subject: number, contentDigest = digest("a")) {
  return { subject, contentDigest };
}

function verified(
  runs: FixtureRun[],
  candidates: Array<Record<string, unknown>>,
  outcome: Record<string, unknown> = {
    kind: "winner",
    winningTreatmentId: "haiku-sonnet-sidekick",
  },
  updatedAt = "2026-07-20T19:00:00Z",
  judgeSubjects = [
    ...new Set(
      runs.map((value) =>
        Number(value.subjectRef.artifactId.split("/").at(-1)),
      ),
    ),
  ],
): Gate2702ProjectionSource {
  return {
    state: "verified",
    marker: {
      verified: true,
      trialId: TRIAL,
      definitionRef: DEFINITION_REF,
      bundleDigest: BUNDLE,
      sealedAt: "2026-07-20T18:59:00Z",
    },
    manifest: {
      trialId: TRIAL,
      definitionRef: DEFINITION_REF,
      contentDigest: BUNDLE,
      runCandidates: candidates,
      judgeResults: judgeSubjects.map((subject) => ({
        subject,
        contentDigest: digest("e"),
      })),
    },
    runs,
    evaluation: {
      schemaVersion: 1,
      kind: "ExperimentVerdict",
      trialId: TRIAL,
      definitionRef: DEFINITION_REF,
      contentDigest: digest("d"),
      updatedAt,
      outcome,
      evidence: {
        includedRuns: runs
          .filter((value) => value.status === "succeeded")
          .map((value) => ({
            runId: value.runId,
            contentDigest: value.contentDigest,
          })),
        excludedRuns: runs
          .filter((value) => value.status !== "succeeded")
          .map((value) => ({
            run: { runId: value.runId, contentDigest: value.contentDigest },
            reason:
              value.status === "cancelled"
                ? "run/status-cancelled"
                : "run/status-failed",
          })),
      },
      primaryEffect: {
        sampleCounts: [
          { treatmentId: "haiku-solo", n: 6 },
          { treatmentId: "haiku-sonnet-sidekick", n: 6 },
        ],
      },
      policyResult: {
        parameters: {
          decision: "sidekick-clears",
          gates: {
            parityFloor: {
              state: "passed",
              basis: "private basis",
              observed: {},
            },
            netPositiveCost: {
              state: "passed",
              basis: "private basis",
              observed: {},
            },
            attributableShips: {
              state: "passed",
              basis: "private basis",
              observed: {},
            },
            minimumSample: {
              state: "passed",
              basis: "private basis",
              observed: { controlRuns: 6, treatmentRuns: 6 },
            },
          },
        },
      },
      extensions: {
        "gate-2702/bundleDigest": BUNDLE,
        "private/rawArtifact": "private artifact sentinel",
      },
    },
  };
}

describe("projectGate2702C5 (#2834)", () => {
  it("distinguishes terminal evidence and emits only the redacted allowlist", () => {
    const success = run("10000000-0000-5000-8000-000000000001", 2760);
    const checkFailure = run("20000000-0000-5000-8000-000000000002", 2719, {
      treatmentId: "haiku-sonnet-sidekick",
      checkOutcome: "failed",
      triggerCount: 3,
      paidCallCount: 2,
      shippedInterventionCount: 1,
    });
    const tooling = run("30000000-0000-5000-8000-000000000003", 2713, {
      status: "failed",
      errorCode: "gate-2702/tooling-artifact",
    });
    const cancelled = run("40000000-0000-5000-8000-000000000004", 2706, {
      status: "cancelled",
      errorCode: "gate-2702/timeout",
    });
    const runs = [success, checkFailure, tooling, cancelled];
    const candidates: Array<Record<string, unknown>> = runs.map((value) =>
      candidate(value),
    );
    candidates.push({
      subject: 2710,
      treatmentId: "haiku-sonnet-sidekick",
      attempt: 1,
      status: "succeeded",
      exclusion: "unknown-all-in-cost:sidekick-ledger-unsettled",
    });

    const projected = projectGate2702C5([verified(runs, candidates)]);
    expect(
      projected.rows.map((value) => value.terminalClassification).sort(),
    ).toEqual([
      "cancelled",
      "check-failed",
      "cost-unknown",
      "succeeded",
      "tooling-invalid",
    ]);
    expect(
      projected.rows.find((value) => value.subject === 2719),
    ).toMatchObject({
      objectiveChecks: [
        { checkId: "checks/gate-2702-typecheck", outcome: "passed" },
        { checkId: "checks/gate-2702-vitest", outcome: "failed" },
      ],
      judgeState: "quality-held",
      wallTimeMs: 12_000,
      allInCostUsd: 1.25,
      sidekick: {
        triggerCount: 3,
        paidCallCount: 2,
        shippedInterventionCount: 1,
      },
    });
    expect(
      projected.rows.find((value) => value.subject === 2710),
    ).toMatchObject({
      runId: null,
      terminalClassification: "cost-unknown",
      allInCostUsd: null,
      exclusionReason: "unknown-all-in-cost:sidekick-ledger-unsettled",
    });
    const wire = JSON.stringify(projected);
    for (const forbidden of [
      "private prompt",
      "private stdout",
      "private error",
      "diff --git",
      "private basis",
      "private artifact",
    ]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it.each([
    [{ kind: "winner", winningTreatmentId: "haiku-solo" }, "winner"],
    [{ kind: "tie" }, "tie"],
    [
      { kind: "inconclusive", reason: "sample/minimum-not-met" },
      "inconclusive",
    ],
    [{ kind: "invalid", reason: "evidence/ambiguous-run-slot" }, "invalid"],
  ])("keeps the v1 %s outcome distinct", (outcome, kind) => {
    const value = run("50000000-0000-5000-8000-000000000005", 2760);
    expect(
      projectGate2702C5([verified([value], [candidate(value)], outcome)])
        .evaluations[0].outcome.kind,
    ).toBe(kind);
  });

  it("labels seal-only judge evidence without inventing a per-run result", () => {
    const candidates = [
      {
        subject: 2760,
        treatmentId: "haiku-sonnet-sidekick",
        attempt: 1,
        status: "succeeded",
        exclusion: "judge-quality-not-evaluable",
      },
      {
        subject: 2719,
        treatmentId: "haiku-solo",
        attempt: 1,
        status: "succeeded",
        exclusion: "selected-pair-judge-unavailable",
      },
      {
        subject: 2713,
        treatmentId: "haiku-sonnet-sidekick",
        attempt: 1,
        status: "succeeded",
        exclusion: "unknown-all-in-cost:sidekick-ledger-unsettled",
      },
      {
        subject: 2706,
        treatmentId: "haiku-solo",
        attempt: 1,
        status: "failed",
        exclusion: "complete-behavior-fingerprint-unavailable",
      },
    ];

    const projected = projectGate2702C5([
      verified([], candidates, undefined, "2026-07-20T20:01:00Z", [2760, 2713]),
    ]);
    const judgeState = new Map(
      projected.rows.map((row) => [row.subject, row.judgeState]),
    );
    expect(judgeState).toEqual(
      new Map([
        [2760, "not-evaluable"],
        [2719, "unavailable"],
        [2713, "subject-sealed-result"],
        [2706, "not-available-in-run-summary"],
      ]),
    );
    expect(
      projected.rows.some(({ judgeState }) => judgeState === "exhausted"),
    ).toBe(false);
    expect(
      projected.rows.some(({ judgeState }) => judgeState === "not-evaluated"),
    ).toBe(false);
  });

  it.each([
    {
      name: "not-evaluable candidate without a manifest judge result",
      candidates: [sealOnlyCandidate(2760, "judge-quality-not-evaluable")],
      judgeResults: [],
    },
    {
      name: "judge-unavailable candidate with a manifest judge result",
      candidates: [sealOnlyCandidate(2719, "selected-pair-judge-unavailable")],
      judgeResults: [judgeResult(2719)],
    },
    {
      name: "manifest judge subject absent from the candidates",
      candidates: [
        sealOnlyCandidate(2760, "unknown-all-in-cost:worker-cost-unknown"),
      ],
      judgeResults: [judgeResult(2719)],
    },
    {
      name: "duplicate manifest judge subjects",
      candidates: [
        sealOnlyCandidate(2760, "unknown-all-in-cost:worker-cost-unknown"),
      ],
      judgeResults: [judgeResult(2760), judgeResult(2760, digest("b"))],
    },
    {
      name: "unsupported manifest judge subject",
      candidates: [
        sealOnlyCandidate(2760, "unknown-all-in-cost:worker-cost-unknown"),
      ],
      judgeResults: [judgeResult(9999)],
    },
    {
      name: "invalid manifest judge digest",
      candidates: [
        sealOnlyCandidate(2760, "unknown-all-in-cost:worker-cost-unknown"),
      ],
      judgeResults: [judgeResult(2760, "not-a-digest")],
    },
  ])("fails closed for $name", ({ candidates, judgeResults }) => {
    const source = verified([], candidates);
    if (source.state !== "verified") throw new Error("invalid test fixture");
    source.manifest.judgeResults = judgeResults;

    expect(projectGate2702C5([source])).toMatchObject({
      total: 0,
      rows: [],
      evaluationTotal: 0,
      evaluations: [],
      reconciliation: {
        scanned: 1,
        validated: 0,
        unsealed: 0,
        malformed: 1,
      },
    });
  });

  it("excludes malformed/unsealed sources and surfaces the newest-row bound", () => {
    const older = run("60000000-0000-5000-8000-000000000006", 2760, {
      finishedAt: "2026-07-20T18:00:00Z",
    });
    const newer = run("70000000-0000-5000-8000-000000000007", 2719, {
      finishedAt: "2026-07-20T20:00:00Z",
    });
    const malformed = verified([older], [candidate(older)]);
    if (malformed.state === "verified")
      malformed.marker.bundleDigest = digest("9");
    const projected = projectGate2702C5(
      [
        { state: "unsealed" },
        { state: "malformed" },
        malformed,
        verified(
          [older, newer],
          [candidate(older), candidate(newer)],
          undefined,
          "2026-07-20T20:01:00Z",
        ),
      ],
      { maxRows: 1 },
    );
    expect(projected.reconciliation).toEqual({
      scanned: 4,
      validated: 1,
      unsealed: 1,
      malformed: 2,
    });
    expect(projected).toMatchObject({ total: 2, returned: 1, dropped: 1 });
    expect(projected.rows[0].subject).toBe(2719);
  });
});
