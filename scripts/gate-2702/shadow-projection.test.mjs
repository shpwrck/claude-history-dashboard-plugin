import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { readGate2702ShadowProjection } from "./shadow-projection.mjs";

const DEFINITION_DIGEST =
  "sha256:8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const DEFINITION_REF = {
  definitionId: "experiments/gate-2702-c5",
  definitionVersion: 1,
  contentDigest: DEFINITION_DIGEST,
};
const VERIFIED_TRIAL = "11111111-1111-5111-8111-111111111111";
const UNSEALED_TRIAL = "22222222-2222-5222-8222-222222222222";
const MALFORMED_TRIAL = "33333333-3333-5333-8333-333333333333";
const BUNDLE_DIGEST = `sha256:${"c".repeat(64)}`;

function trialRoot(stateRoot, trialId) {
  return join(stateRoot, DEFINITION_DIGEST.replace(":", "-"), trialId);
}

function touchPublishedTrial(stateRoot, trialId, { evaluation = true } = {}) {
  const root = trialRoot(stateRoot, trialId);
  mkdirSync(join(root, "seal"), { recursive: true });
  writeFileSync(join(root, "seal", "verified.json"), "{}\n");
  if (evaluation) {
    mkdirSync(join(root, "evaluation"), { recursive: true });
    writeFileSync(join(root, "evaluation", "current.json"), "{}\n");
  }
}

function verifiedZeroRunEvaluation() {
  return {
    definition: { rawPrompt: "must not enter the response" },
    registry: { rawArtifact: "must not enter the response" },
    marker: {
      verified: true,
      trialId: VERIFIED_TRIAL,
      definitionRef: DEFINITION_REF,
      bundleDigest: BUNDLE_DIGEST,
      sealedAt: "2026-07-20T18:59:00.000Z",
    },
    manifest: {
      trialId: VERIFIED_TRIAL,
      definitionRef: DEFINITION_REF,
      contentDigest: BUNDLE_DIGEST,
      runCandidates: [
        {
          subject: 2760,
          treatmentId: "haiku-solo",
          attempt: 1,
          status: "failed",
          exclusion: "unknown-all-in-cost:worker-cost-unknown",
        },
      ],
      judgeResults: [],
    },
    runs: [],
    evaluation: {
      schemaVersion: 1,
      kind: "Gate2702InsufficientEvidence",
      trialId: VERIFIED_TRIAL,
      definitionRef: DEFINITION_REF,
      bundleDigest: BUNDLE_DIGEST,
      contentDigest: `sha256:${"d".repeat(64)}`,
      state: "insufficient-evidence",
      reason: "evidence/no-canonical-runs",
      sampleCounts: [
        { treatmentId: "haiku-solo", n: 0 },
        { treatmentId: "haiku-sonnet-sidekick", n: 0 },
      ],
      evaluatedAt: "2026-07-20T18:59:00.000Z",
    },
  };
}

test("C5 shadow projection is absent when its local state root is absent", async () => {
  const stateRoot = join(
    tmpdir(),
    `gate-2702-does-not-exist-${process.pid}-${Date.now()}`,
  );
  let called = false;
  const projection = await readGate2702ShadowProjection(
    { stateRoot },
    {
      loadCurrentEvaluation: async () => {
        called = true;
        throw new Error("should not run");
      },
    },
  );
  assert.equal(projection, null);
  assert.equal(called, false);
});

test("C5 shadow projection reports a dangling Definition-root symlink as malformed", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-shadow-root-link-"));
  try {
    const definitionRoot = join(stateRoot, DEFINITION_DIGEST.replace(":", "-"));
    symlinkSync(
      join(stateRoot, "missing-definition-root"),
      definitionRoot,
      "dir",
    );
    const projection = await readGate2702ShadowProjection({ stateRoot });

    assert.ok(projection);
    assert.deepEqual(projection.reconciliation, {
      scanned: 1,
      validated: 0,
      unsealed: 0,
      malformed: 1,
      discoveryOverflow: 0,
    });
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("C5 shadow projection reports a dangling verification-marker symlink as malformed", async () => {
  const stateRoot = mkdtempSync(
    join(tmpdir(), "gate-2702-shadow-marker-link-"),
  );
  try {
    const root = trialRoot(stateRoot, VERIFIED_TRIAL);
    mkdirSync(join(root, "seal"), { recursive: true });
    symlinkSync("missing-verified.json", join(root, "seal", "verified.json"));
    let called = false;
    const projection = await readGate2702ShadowProjection(
      { stateRoot },
      {
        loadCurrentEvaluation: async () => {
          called = true;
          return verifiedZeroRunEvaluation();
        },
      },
    );

    assert.ok(projection);
    assert.equal(called, false);
    assert.deepEqual(projection.reconciliation, {
      scanned: 1,
      validated: 0,
      unsealed: 0,
      malformed: 1,
      discoveryOverflow: 0,
    });
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("C5 shadow projection verifies eligible trials and reconciles unsealed/malformed ones", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-shadow-projection-"));
  try {
    mkdirSync(trialRoot(stateRoot, UNSEALED_TRIAL), { recursive: true });
    touchPublishedTrial(stateRoot, MALFORMED_TRIAL);
    touchPublishedTrial(stateRoot, VERIFIED_TRIAL);
    const calls = [];
    const projection = await readGate2702ShadowProjection(
      { stateRoot, maxRows: 10 },
      {
        loadCurrentEvaluation: async (options) => {
          calls.push(options);
          if (options.trial === MALFORMED_TRIAL)
            throw new Error("raw verification failure");
          return verifiedZeroRunEvaluation();
        },
      },
    );

    assert.ok(projection);
    assert.deepEqual(projection.reconciliation, {
      scanned: 3,
      validated: 1,
      unsealed: 1,
      malformed: 1,
      discoveryOverflow: 0,
    });
    assert.equal(projection.total, 1);
    assert.equal(projection.rows[0].terminalClassification, "cost-unknown");
    assert.equal(
      projection.evaluations[0].outcome.kind,
      "insufficient-evidence",
    );
    assert.deepEqual(
      calls.map(({ trial, stateRoot: root }) => [trial, root]).sort(),
      [
        [MALFORMED_TRIAL, stateRoot],
        [VERIFIED_TRIAL, stateRoot],
      ].sort(),
    );
    const wire = JSON.stringify(projection);
    assert.doesNotMatch(
      wire,
      /raw verification failure|must not enter the response/,
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("C5 shadow projection uses the configured self-contained runtime verifier", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-shadow-runtime-"));
  const priorBundle = process.env.CHD_GATE_2702_RUNTIME_VERIFIER;
  const priorNodeEnv = process.env.NODE_ENV;
  try {
    touchPublishedTrial(stateRoot, VERIFIED_TRIAL);
    const bundlePath = join(stateRoot, "runtime-verifier.bundle.mjs");
    writeFileSync(
      bundlePath,
      `export async function loadCurrentEvaluation() { return ${JSON.stringify(
        verifiedZeroRunEvaluation(),
      )}; }\n`,
    );
    process.env.CHD_GATE_2702_RUNTIME_VERIFIER = bundlePath;
    process.env.NODE_ENV = "production";

    const projection = await readGate2702ShadowProjection({ stateRoot });
    assert.ok(projection);
    assert.equal(projection.reconciliation.validated, 1);
    assert.equal(projection.reconciliation.malformed, 0);
  } finally {
    if (priorBundle === undefined)
      delete process.env.CHD_GATE_2702_RUNTIME_VERIFIER;
    else process.env.CHD_GATE_2702_RUNTIME_VERIFIER = priorBundle;
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("C5 discovery fails closed without loading a partial trial-directory prefix", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-shadow-overflow-"));
  try {
    for (let index = 0; index < 256; index += 1) {
      const prefix = index.toString(16).padStart(8, "0");
      mkdirSync(trialRoot(stateRoot, `${prefix}-0000-5000-8000-000000000000`), {
        recursive: true,
      });
    }
    const lexicographicallyLastPublishedTrial =
      "ffffffff-ffff-5fff-bfff-ffffffffffff";
    touchPublishedTrial(stateRoot, lexicographicallyLastPublishedTrial);
    let called = false;

    const projection = await readGate2702ShadowProjection(
      { stateRoot },
      {
        loadCurrentEvaluation: async () => {
          called = true;
          return verifiedZeroRunEvaluation();
        },
      },
    );

    assert.ok(projection);
    assert.deepEqual(projection.reconciliation, {
      scanned: 1,
      validated: 0,
      unsealed: 0,
      malformed: 0,
      discoveryOverflow: 1,
    });
    assert.deepEqual(projection.rows, []);
    assert.deepEqual(projection.evaluations, []);
    assert.equal(called, false);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("C5 shadow projection re-verifies underlying sealed objects on the next read", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-shadow-reverify-"));
  try {
    touchPublishedTrial(stateRoot, VERIFIED_TRIAL);
    const objectPath = join(
      trialRoot(stateRoot, VERIFIED_TRIAL),
      "seal",
      "bundles",
      `sha256-${"e".repeat(64)}`,
      "objects",
      `sha256-${"f".repeat(64)}`,
    );
    mkdirSync(dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, "trusted");
    let calls = 0;
    const dependencies = {
      loadCurrentEvaluation: async () => {
        calls += 1;
        if (readFileSync(objectPath, "utf8") !== "trusted") {
          throw new Error("sealed object failed digest verification");
        }
        return verifiedZeroRunEvaluation();
      },
    };

    const before = await readGate2702ShadowProjection(
      { stateRoot },
      dependencies,
    );
    assert.equal(before.reconciliation.validated, 1);

    // Marker and evaluation/current stay untouched: only a retained object is
    // changed in place, which the next full loader pass must detect.
    writeFileSync(objectPath, "altered");
    const after = await readGate2702ShadowProjection(
      { stateRoot },
      dependencies,
    );
    assert.equal(calls, 2);
    assert.deepEqual(after.reconciliation, {
      scanned: 1,
      validated: 0,
      unsealed: 0,
      malformed: 1,
      discoveryOverflow: 0,
    });
    assert.deepEqual(after.rows, []);
    assert.deepEqual(after.evaluations, []);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("C5 shadow projection rejects non-directory and symlink trial entries without following them", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "gate-2702-shadow-shape-"));
  try {
    const definitionRoot = join(stateRoot, DEFINITION_DIGEST.replace(":", "-"));
    mkdirSync(definitionRoot, { recursive: true });
    writeFileSync(join(definitionRoot, VERIFIED_TRIAL), "not a directory");
    const symlinkTarget = join(stateRoot, "symlink-target");
    mkdirSync(symlinkTarget);
    symlinkSync(symlinkTarget, join(definitionRoot, MALFORMED_TRIAL), "dir");
    let called = false;
    const projection = await readGate2702ShadowProjection(
      { stateRoot },
      {
        loadCurrentEvaluation: async () => {
          called = true;
          throw new Error("should not run");
        },
      },
    );
    assert.ok(projection);
    assert.equal(projection.reconciliation.malformed, 2);
    assert.equal(projection.reconciliation.validated, 0);
    assert.equal(called, false);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
