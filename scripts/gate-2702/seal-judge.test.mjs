import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateGate2702JudgeEvidence } from "./seal-judge.mjs";

const TRIAL_ID = "4f503910-77de-4ac0-b454-3ac913d96288";
const SUBJECT = 2760;
const BASE_SHA = "1".repeat(40);
const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest:
    "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba",
};
const TREATMENTS = ["haiku-solo", "haiku-sonnet-sidekick"];
const DIMENSIONS = [
  [
    "correctness",
    "Does it achieve the outcome the user would accept as the solution, rather than mere plausibility?",
  ],
  [
    "design",
    "Is it well architected under CUPID, KISS, DRY, and GRASP? Score neutral 5 for non-code tasks.",
  ],
  [
    "completeness",
    "Does it cover the whole task, including edge cases the task implies?",
  ],
  ["clarity", "Is the result clear, well structured, and easy to act on?"],
  [
    "scopeFit",
    "Does it stay in scope, without over-building or unrequested changes?",
  ],
  [
    "autonomy",
    "How few user prompts or interventions would it take to reach the result?",
  ],
];
const RUBRIC = [
  "You are an impartial judge comparing two attempts (A and B) at the same task.",
  "Skeptic first: for each attempt, identify what is missing or wrong before giving credit.",
  "Judge output quality, not length, apparent effort, model, or cost. Return tie only when equivalent.",
  `Score 1-10 on: ${DIMENSIONS.map(([key, description]) => `${key} (${description})`).join("; ")}`,
].join("\n");
const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["winner", "scores", "rationale"],
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    scores: {
      type: "object",
      additionalProperties: false,
      required: ["A", "B"],
      properties: {
        A: { $ref: "#/$defs/dimensionScores" },
        B: { $ref: "#/$defs/dimensionScores" },
      },
    },
    rationale: { type: "string", minLength: 1, maxLength: 4096 },
  },
  $defs: {
    dimensionScores: {
      type: "object",
      additionalProperties: false,
      required: DIMENSIONS.map(([key]) => key),
      properties: Object.fromEntries(
        DIMENSIONS.map(([key]) => [
          key,
          { type: "integer", minimum: 1, maximum: 10 },
        ]),
      ),
    },
  },
};

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function valueDigest(value) {
  return sha256(Buffer.from(canonicalJson(value)));
}

function withDigest(receipt) {
  const withoutDigest = { ...receipt };
  delete withoutDigest.contentDigest;
  return { ...withoutDigest, contentDigest: valueDigest(withoutDigest) };
}

function scores(a, b) {
  return {
    A: Object.fromEntries(DIMENSIONS.map(([key]) => [key, a])),
    B: Object.fromEntries(DIMENSIONS.map(([key]) => [key, b])),
  };
}

function judgeArgv() {
  return [
    "-p",
    "--model",
    "claude-haiku-4-5-20251001",
    "--json-schema",
    JSON.stringify(JUDGE_SCHEMA),
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--tools",
    "",
    "--max-budget-usd",
    "0.25",
  ];
}

function captured(bytes) {
  return {
    encoding: "base64",
    capturedBytes: bytes.length,
    totalBytes: bytes.length,
    contentDigest: sha256(bytes),
    truncated: false,
    bytes: bytes.toString("base64"),
  };
}

function workerPrompt(snapshot, registration) {
  return [
    `You are executing the pre-registered #2702 C5 arm for issue #${snapshot.subject}.`,
    `Treatment: ${registration.treatmentId}. Attempt: ${registration.attempt}.`,
    `Work only in the provided disposable worktree at pinned commit ${registration.baseSha}.`,
    "Implement the bounded issue and verify the result locally.",
    "Do not push any branch or commit.",
    "Do not open, update, or merge a pull request.",
    "Do not edit the GitHub issue or make any other external durable write.",
    "Leave all result files in the disposable worktree; the bridge will preserve evidence.",
    "",
    `Issue title: ${snapshot.title}`,
    "Issue body:",
    snapshot.body,
    "",
  ].join("\n");
}

function workerArgv() {
  return [
    "claude",
    "-p",
    "--model",
    "claude-haiku-4-5-20251001",
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--max-budget-usd",
    "15",
  ];
}

function createFixture({
  executionMode = "production",
  frozenArtifact = null,
  resultState = "agreed",
  extraAttempt = false,
  worktreeAggregateBytes = 0,
  promptDigest = null,
  worktreeIdentityDigest = null,
} = {}) {
  const artifacts = new Map();
  const put = (path, receipt) => {
    const value = withDigest(receipt);
    artifacts.set(path, Buffer.from(`${JSON.stringify(value)}\n`));
    return value;
  };
  const putBytes = (path, bytes) => artifacts.set(path, Buffer.from(bytes));
  const registrations = {};
  const classifications = {};
  const checkResults = [
    { checkId: "checks/gate-2702-vitest", status: "passed" },
    { checkId: "checks/gate-2702-typecheck", status: "passed" },
  ];
  const snapshot = put(`subjects/issue-${SUBJECT}.json`, {
    schemaVersion: 1,
    kind: "Gate2702SubjectSnapshot",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    repository: "shpwrck/claude-history-dashboard",
    executionMode,
    subject: SUBJECT,
    baseSha: BASE_SHA,
    title: "Fixture issue",
    body: "Implement the requested behavior.",
    url: `https://example.invalid/issues/${SUBJECT}`,
  });
  for (const treatmentId of TREATMENTS) {
    const runDir = `/fixture/state/runs/issue-${SUBJECT}/${treatmentId}/attempt-1`;
    const registration = put(
      `runs/issue-${SUBJECT}/${treatmentId}/attempt-1/registration.json`,
      {
        schemaVersion: 1,
        kind: "Gate2702ArmRegistration",
        definitionRef: DEFINITION_REF,
        trialId: TRIAL_ID,
        subject: SUBJECT,
        subjectRef: `github:shpwrck/claude-history-dashboard#${SUBJECT}`,
        treatmentId,
        attempt: 1,
        baseSha: BASE_SHA,
        executionMode,
        runDir,
        worktreePath: `/fixture/worktrees/issue-${SUBJECT}.${treatmentId}.attempt-1`,
      },
    );
    registrations[treatmentId] = registration;
  }
  put("trial.json", {
    schemaVersion: 1,
    kind: "Gate2702Trial",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    repository: "shpwrck/claude-history-dashboard",
    executionMode,
    worktreeRoot: "/fixture/worktrees",
    baseSha: BASE_SHA,
    registrations: Object.values(registrations),
    subjectSnapshots: [
      { subject: SUBJECT, contentDigest: snapshot.contentDigest },
    ],
  });
  const behaviorContexts = Object.fromEntries(
    TREATMENTS.map((treatmentId) => [
      treatmentId,
      { treatmentId, stable: true },
    ]),
  );
  const preflight = put(`preflight/issue-${SUBJECT}.json`, {
    schemaVersion: 1,
    kind: "Gate2702PairPreflight",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    baseSha: BASE_SHA,
    status: "passed",
    arms: Object.fromEntries(
      TREATMENTS.map((treatmentId) => [
        treatmentId,
        {
          registrationDigest: registrations[treatmentId].contentDigest,
          behaviorContext: behaviorContexts[treatmentId],
        },
      ]),
    ),
  });
  const emptyWorktreeBody = {
    baseSha: BASE_SHA,
    trackedPatch: {
      sizeBytes: 0,
      contentDigest: sha256(Buffer.alloc(0)),
    },
    untracked: [],
    aggregateBytes: worktreeAggregateBytes,
  };
  const worktreeEvidence = {
    ...emptyWorktreeBody,
    contentDigest: valueDigest(emptyWorktreeBody),
  };
  for (const [index, treatmentId] of TREATMENTS.entries()) {
    const registration = registrations[treatmentId];
    const prefix = `runs/issue-${SUBJECT}/${treatmentId}/attempt-1`;
    const identity = put(`${prefix}/worktree-identity.json`, {
      schemaVersion: 1,
      kind: "Gate2702WorktreeIdentity",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId,
      attempt: 1,
      baseSha: BASE_SHA,
      executionMode,
      worktreePath: registration.worktreePath,
      gitDirectory: `/fixture/repo/.git/worktrees/arm-${index}`,
      identityToken: `${index + 1}${String(index + 1).repeat(7)}-${String(index + 1).repeat(4)}-4${String(index + 1).repeat(3)}-8${String(index + 1).repeat(3)}-${String(index + 1).repeat(12)}`,
      createdAt: "2026-07-20T11:00:00.000Z",
    });
    const preDispatch = put(`${prefix}/pre-dispatch.json`, {
      schemaVersion: 1,
      kind: "Gate2702PreDispatch",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId,
      attempt: 1,
      baseSha: BASE_SHA,
      executionMode,
      cwd: registration.worktreePath,
      argv: workerArgv(),
      promptDigest:
        promptDigest ??
        sha256(Buffer.from(workerPrompt(snapshot, registration))),
      worktreeIdentityDigest: worktreeIdentityDigest ?? identity.contentDigest,
    });
    const processReceipt = put(`${prefix}/process.json`, {
      schemaVersion: 1,
      kind: "Gate2702Process",
      definitionRef: DEFINITION_REF,
      registrationDigest: registration.contentDigest,
      preDispatchDigest: preDispatch.contentDigest,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId,
      attempt: 1,
      baseSha: BASE_SHA,
      pid: 500 + index,
    });
    const terminal = put(`${prefix}/terminal.json`, {
      schemaVersion: 1,
      kind: "Gate2702Terminal",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId,
      attempt: 1,
      baseSha: BASE_SHA,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      outcome: "exited",
      exitCode: 0,
      timedOut: false,
      processGroupQuiescent: true,
    });
    const workerResult = `Final result for ${treatmentId}.`;
    const stdoutBytes = Buffer.from(
      `${JSON.stringify({ result: workerResult })}\n`,
    );
    putBytes(`${prefix}/stdout.log`, stdoutBytes);
    classifications[treatmentId] = put(`${prefix}/classification.json`, {
      schemaVersion: 1,
      kind: "Gate2702ArmClassification",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      treatmentId,
      attempt: 1,
      baseSha: BASE_SHA,
      registrationDigest: registration.contentDigest,
      preflightDigest: preflight.contentDigest,
      terminalDigest: terminal.contentDigest,
      status: "succeeded",
      eligible: true,
      behaviorVerification: {
        behaviorContextDigest: valueDigest(behaviorContexts[treatmentId]),
        verifiedAt: "2026-07-20T11:30:00.000Z",
      },
      workerArtifacts: {
        stdout: {
          path: `${registration.runDir}/stdout.log`,
          byteLength: stdoutBytes.length,
          capturedBytes: stdoutBytes.length,
          contentDigest: sha256(stdoutBytes),
          truncated: false,
        },
      },
      worktreeEvidence,
      checkResults,
    });
  }
  const selection = put(`pair-selection/issue-${SUBJECT}.json`, {
    schemaVersion: 1,
    kind: "Gate2702PairSelection",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    baseSha: BASE_SHA,
    arms: Object.fromEntries(
      TREATMENTS.map((treatmentId) => [
        treatmentId,
        {
          treatmentId,
          attempt: 1,
          registrationDigest: registrations[treatmentId].contentDigest,
          classificationDigest: classifications[treatmentId].contentDigest,
        },
      ]),
    ),
  });

  const objectiveChecks = {};
  const armEvidence = {};
  const frozenArtifacts = {};
  for (const treatmentId of TREATMENTS) {
    const workerResult = `Final result for ${treatmentId}.`;
    const diff = {
      trackedPatch: {
        encoding: "base64",
        sizeBytes: 0,
        contentDigest: sha256(Buffer.alloc(0)),
        bytes: "",
      },
      untracked: [],
    };
    const artifact =
      frozenArtifact ?? "Final result for <arm>.\n\n[FINAL TRACKED DIFF]";
    const evidence = put(
      `judging/issue-${SUBJECT}/evidence/${treatmentId}.json`,
      {
        schemaVersion: 1,
        kind: "Gate2702JudgeArmEvidence",
        definitionRef: DEFINITION_REF,
        trialId: TRIAL_ID,
        subject: SUBJECT,
        treatmentId,
        attempt: 1,
        baseSha: BASE_SHA,
        executionMode,
        pairSelectionDigest: selection.contentDigest,
        registrationDigest: registrations[treatmentId].contentDigest,
        classificationDigest: classifications[treatmentId].contentDigest,
        workerResult,
        workerResultDigest: sha256(Buffer.from(workerResult)),
        worktreeEvidence,
        diff,
        artifact,
      },
    );
    armEvidence[treatmentId] = evidence.contentDigest;
    frozenArtifacts[treatmentId] = artifact;
    objectiveChecks[treatmentId] = {
      classificationDigest: classifications[treatmentId].contentDigest,
      results: checkResults,
      state: "passed",
    };
  }
  const input = put(`judging/issue-${SUBJECT}/input.json`, {
    schemaVersion: 1,
    kind: "Gate2702JudgeInput",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    baseSha: BASE_SHA,
    executionMode,
    pairSelectionDigest: selection.contentDigest,
    subjectSnapshotDigest: snapshot.contentDigest,
    task: "Fixture issue\n\nImplement the requested behavior.",
    armEvidence,
    objectiveChecks,
    artifacts: frozenArtifacts,
  });
  const payloads = {
    forward: {
      task: input.task,
      rubric: RUBRIC,
      artifacts: {
        A: frozenArtifacts[TREATMENTS[0]],
        B: frozenArtifacts[TREATMENTS[1]],
      },
    },
    swapped: {
      task: input.task,
      rubric: RUBRIC,
      artifacts: {
        A: frozenArtifacts[TREATMENTS[1]],
        B: frozenArtifacts[TREATMENTS[0]],
      },
    },
  };
  const requests = put(`judging/issue-${SUBJECT}/requests.json`, {
    schemaVersion: 1,
    kind: "Gate2702JudgeRequests",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    baseSha: BASE_SHA,
    executionMode,
    judgeInputDigest: input.contentDigest,
    judgeModel: "claude-haiku-4-5-20251001",
    timeoutMs: 600_000,
    maxBudgetUsd: 0.25,
    maxAttemptsPerOrder: 3,
    maxPayloadBytes: 128 * 1024,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    schema: JUDGE_SCHEMA,
    rubric: RUBRIC,
    requests: {
      forward: {
        payload: payloads.forward,
        payloadDigest: valueDigest(payloads.forward),
        order: { A: TREATMENTS[0], B: TREATMENTS[1] },
      },
      swapped: {
        payload: payloads.swapped,
        payloadDigest: valueDigest(payloads.swapped),
        order: { A: TREATMENTS[1], B: TREATMENTS[0] },
      },
    },
  });

  const attempts = {};
  for (const order of ["forward", "swapped"]) {
    const request = requests.requests[order];
    const prefix = `judging/issue-${SUBJECT}/${order}/attempt-1`;
    const absolutePrefix = `/fixture/state/${prefix}`;
    const preDispatch = put(`${prefix}.pre-dispatch.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgePreDispatch",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      baseSha: BASE_SHA,
      executionMode,
      requestSetDigest: requests.contentDigest,
      payloadDigest: request.payloadDigest,
      payload: request.payload,
      order,
      attempt: 1,
      executable: "claude",
      argv: judgeArgv(),
      judgeModel: "claude-haiku-4-5-20251001",
      sidekickEnabled: false,
      toolAccess: false,
      permissionBypass: false,
      maxBudgetUsd: 0.25,
      timeoutMs: 600_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 2 * 1024 * 1024,
      dispatchToken:
        order === "forward"
          ? "11111111-1111-4111-8111-111111111111"
          : "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-07-20T12:00:00.000Z",
    });
    const processReceipt = put(`${prefix}.process.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgeProcess",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      baseSha: BASE_SHA,
      executionMode,
      requestSetDigest: requests.contentDigest,
      payloadDigest: request.payloadDigest,
      order,
      attempt: 1,
      dispatchToken: preDispatch.dispatchToken,
      preDispatchDigest: preDispatch.contentDigest,
      executable: "/usr/bin/node",
      argv: [
        "/fixture/repo/scripts/gate-2702/judge.mjs",
        "__dispatch",
        `${absolutePrefix}.pre-dispatch.json`,
        `${absolutePrefix}.process.json`,
        `${absolutePrefix}.gate.json`,
        `${absolutePrefix}.outcome.json`,
      ],
      pid: order === "forward" ? 101 : 102,
      processStartTimeTicks: order === "forward" ? "1001" : "1002",
      launchedAt: "2026-07-20T12:00:00.010Z",
    });
    const gate = put(`${prefix}.gate.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgeGate",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      baseSha: BASE_SHA,
      executionMode,
      requestSetDigest: requests.contentDigest,
      payloadDigest: request.payloadDigest,
      order,
      attempt: 1,
      dispatchToken: preDispatch.dispatchToken,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      authorizedAt: "2026-07-20T12:00:00.020Z",
    });
    const response = {
      winner: order === "forward" ? "A" : "B",
      scores: order === "forward" ? scores(9, 7) : scores(7, 9),
      rationale: "The stronger implementation is more complete.",
    };
    const stdout = captured(
      Buffer.from(
        JSON.stringify({ structured_output: response, total_cost_usd: 0.1 }),
      ),
    );
    const stderr = captured(Buffer.alloc(0));
    const outcome = put(`${prefix}.outcome.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgeOutcome",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      baseSha: BASE_SHA,
      executionMode,
      requestSetDigest: requests.contentDigest,
      payloadDigest: request.payloadDigest,
      order,
      attempt: 1,
      dispatchToken: preDispatch.dispatchToken,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      gateDigest: gate.contentDigest,
      startedAt: "2026-07-20T12:00:00.030Z",
      endedAt: "2026-07-20T12:00:01.030Z",
      startedMonotonicNs: "1000000",
      endedMonotonicNs: "1001000",
      durationMs: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      spawnError: null,
      stdout,
      stderr,
    });
    attempts[order] = put(`${prefix}.json`, {
      schemaVersion: 1,
      kind: "Gate2702JudgeAttempt",
      definitionRef: DEFINITION_REF,
      trialId: TRIAL_ID,
      subject: SUBJECT,
      baseSha: BASE_SHA,
      executionMode,
      requestSetDigest: requests.contentDigest,
      payloadDigest: request.payloadDigest,
      order,
      attempt: 1,
      preDispatchDigest: preDispatch.contentDigest,
      processDigest: processReceipt.contentDigest,
      outcomeDigest: outcome.contentDigest,
      argv: ["claude", ...judgeArgv()],
      judgeModel: "claude-haiku-4-5-20251001",
      sidekickEnabled: false,
      startedAt: outcome.startedAt,
      endedAt: outcome.endedAt,
      startedMonotonicNs: outcome.startedMonotonicNs,
      endedMonotonicNs: outcome.endedMonotonicNs,
      durationMs: outcome.durationMs,
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr,
      outcome: "valid",
      retryable: false,
      failureClass: null,
      response,
      costUsd: 0.1,
    });
  }
  if (extraAttempt) {
    const first = JSON.parse(
      artifacts.get(
        `judging/issue-${SUBJECT}/forward/attempt-1.pre-dispatch.json`,
      ),
    );
    put(`judging/issue-${SUBJECT}/forward/attempt-2.pre-dispatch.json`, {
      ...first,
      contentDigest: undefined,
      attempt: 2,
      dispatchToken: "33333333-3333-4333-8333-333333333333",
    });
  }
  const result = put(`judging/issue-${SUBJECT}/result.json`, {
    schemaVersion: 1,
    kind: "Gate2702JudgeResult",
    definitionRef: DEFINITION_REF,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    baseSha: BASE_SHA,
    executionMode,
    judgeInputDigest: input.contentDigest,
    requestSetDigest: requests.contentDigest,
    attempts: {
      forward: [{ attempt: 1, contentDigest: attempts.forward.contentDigest }],
      swapped: [{ attempt: 1, contentDigest: attempts.swapped.contentDigest }],
    },
    state: resultState,
    subjectiveState: "agreed",
    forwardWinner: TREATMENTS[0],
    swappedWinner: TREATMENTS[0],
    subjectiveWinner: TREATMENTS[0],
    objectiveChecks,
    effectiveWinner: TREATMENTS[0],
    effectiveBasis: "blind-judge",
  });
  return { artifacts, input, requests, result };
}

function validate(fixture) {
  return validateGate2702JudgeEvidence({
    artifactBytesByPath: fixture.artifacts,
    trialId: TRIAL_ID,
    subject: SUBJECT,
    baseSha: BASE_SHA,
  });
}

test("a complete retained production judge chain rederives without filesystem access", () => {
  const fixture = createFixture();
  const verified = validate(fixture);

  assert.deepEqual(verified.result, fixture.result);
  assert.equal(verified.input.contentDigest, fixture.input.contentDigest);
  assert.equal(verified.requests.contentDigest, fixture.requests.contentDigest);
  assert.equal(verified.attempts.forward.length, 1);
  assert.equal(verified.attempts.swapped.length, 1);
});

test("production verification rejects a coherently re-digested test-mode source", () => {
  assert.throws(
    () => validate(createFixture({ executionMode: "test" })),
    /production execution mode/,
  );
});

test("the frozen artifact is independently rederived from worker result and diff", () => {
  assert.throws(
    () =>
      validate(createFixture({ frozenArtifact: "self-consistent forgery" })),
    /frozen artifact does not rederive/,
  );
});

test("prompt, worktree identity, and classification worktree evidence are source-bound", () => {
  assert.throws(
    () =>
      validate(
        createFixture({
          promptDigest: `sha256:${"a".repeat(64)}`,
        }),
      ),
    /worker dispatch prompt or invocation/,
  );
  assert.throws(
    () =>
      validate(
        createFixture({
          worktreeIdentityDigest: `sha256:${"b".repeat(64)}`,
        }),
      ),
    /worktree identity is not bound/,
  );
  assert.throws(
    () => validate(createFixture({ worktreeAggregateBytes: 1 })),
    /frozen judge evidence is invalid/,
  );
});

test("resultBody and terminal attempt boundaries are independently enforced", () => {
  assert.throws(
    () => validate(createFixture({ resultState: "disagreement" })),
    /result does not match its frozen evidence/,
  );
  assert.throws(
    () => validate(createFixture({ extraAttempt: true })),
    /continued after a terminal attempt|omits a later attempt/,
  );
});
