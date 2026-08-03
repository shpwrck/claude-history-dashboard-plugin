// Host-independent fail-closed contract for the C5 worker jail (#3085).
//
// The hostile-canary probe in run.test.mjs is the real proof that the enforcer
// denies a `~/.claude` read, but it can only run where bubblewrap can actually
// unshare namespaces. These tests assert the half of the contract that holds
// on ANY host and must never regress: the sandbox is mandatory outside test
// mode, preparation fails closed when the enforcer or a host tool is missing,
// and the sealer rejects a receipt that carries no valid enforcer attestation.
//
// Without the fix these functions do not exist at all, so every case here
// fails against the pre-#3085 tree.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { captureGate2702BehaviorContext } from "./behavior-context.mjs";
import {
  assertGate2702SandboxPreDispatch,
  assertGate2702SandboxReady,
  gate2702IsolatedHome,
  gate2702SandboxEnabled,
  gate2702SandboxProbeAction,
  GATE_2702_SANDBOX_ENV_KEYS,
} from "./sandbox-dispatch.mjs";

test("the hosted sandbox probe skips normally but fails when CI requires proof", () => {
  assert.equal(gate2702SandboxProbeAction(true, {}), "run");
  assert.equal(gate2702SandboxProbeAction(false, {}), "skip");
  assert.throws(
    () =>
      gate2702SandboxProbeAction(false, {
        CHD_REQUIRE_GATE_2702_SANDBOX_PROBE: "1",
      }),
    /required.*namespace-capable/i,
  );
});

test("the C5 sandbox is mandatory outside the test harness", () => {
  // Production (no test-mode flag) must always be jailed.
  assert.equal(gate2702SandboxEnabled({}), true);
  assert.equal(gate2702SandboxEnabled({ CHD_EXPERIMENT_2702_TEST_MODE: "0" }), true);
  // Only the fixture harness may opt out, and only explicitly.
  assert.equal(
    gate2702SandboxEnabled({ CHD_EXPERIMENT_2702_TEST_MODE: "1" }),
    false,
  );
  assert.equal(
    gate2702SandboxEnabled({
      CHD_EXPERIMENT_2702_TEST_MODE: "1",
      CHD_EXPERIMENT_2702_TEST_SANDBOX: "1",
    }),
    true,
  );
});

test("sandbox preparation fails closed when a required host tool is absent", () => {
  const empty = mkdtempSync(join(tmpdir(), "gate-2702-no-tools-"));
  try {
    // An empty PATH cannot resolve bwrap/socat/rg. The contract is that this
    // THROWS rather than returning a null runtime that the dispatcher would
    // quietly treat as "run unjailed".
    assert.throws(
      () => assertGate2702SandboxReady({ PATH: empty }),
      /C5 sandbox requires (bwrap|socat|rg)/,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the documented child-environment allowlist carries no host credential keys", () => {
  // The defect was `{...process.env}`. Assert the allowlist is a closed set and
  // that the obvious credential/secret carriers are not in it.
  for (const key of [
    "AWS_SECRET_ACCESS_KEY",
    "ANTHROPIC_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "SSH_AUTH_SOCK",
  ]) {
    assert.equal(
      GATE_2702_SANDBOX_ENV_KEYS.includes(key),
      false,
      `${key} must not be in the sandbox environment allowlist`,
    );
  }
  assert.equal(GATE_2702_SANDBOX_ENV_KEYS.includes("HOME"), true);
  // HOME is present but must be re-pointed at the isolated home, never inherited.
  assert.equal(
    new Set(GATE_2702_SANDBOX_ENV_KEYS).size,
    GATE_2702_SANDBOX_ENV_KEYS.length,
  );
});

test("pre-dispatch validation rejects a receipt with no enforcer attestation", () => {
  const registration = {
    runDir: "/tmp/gate-2702/run",
    worktreePath: "/tmp/gate-2702/worktree",
    subject: 2760,
    treatmentId: "haiku-solo",
  };
  const worktreeIdentity = { gitDirectory: "/tmp/gate-2702/.git" };

  // No sandbox block at all -- the pre-#3085 receipt shape.
  assert.throws(
    () =>
      assertGate2702SandboxPreDispatch({
        preDispatch: { argv: ["claude", "-p"] },
        registration,
        worktreeIdentity,
      }),
    /no valid sandbox enforcer attestation/,
  );

  // A sandbox block that claims containment but does not deny the host home.
  assert.throws(
    () =>
      assertGate2702SandboxPreDispatch({
        preDispatch: {
          argv: ["node", "cli.js", "-s", "settings.json", "-c", "true"],
          sandbox: {
            enforcer: "srt",
            package: {
              name: "@anthropic-ai/sandbox-runtime",
              version: "0.0.52",
              root: "/x/node_modules/@anthropic-ai/sandbox-runtime",
              cliPath: "/x/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js",
              manifestDigest: `sha256:${"0".repeat(64)}`,
              cliDigest: `sha256:${"0".repeat(64)}`,
            },
            credentialMode: "isolated-home-credential-only",
            hostHomeDenied: false,
            hostHome: "/home/someone",
            isolatedHome: "/tmp/gate-2702/run/sandbox/home",
            gitDirectory: "/tmp/gate-2702/.git",
            gitCommonDirectory: "/tmp/gate-2702/.git",
          },
        },
        registration,
        worktreeIdentity,
      }),
    /no valid sandbox enforcer attestation/,
  );
});

// --- #3085 follow-up: the behavior context must track the WORKER's HOME ------
//
// gate2702InstructionContext states its own invariant: "C5 requires an absolute
// HOME matching Sidekick resolution". Under the jail, Sidekick resolves
// user-scope instructions against the isolated home. Before this fix both the
// capture and its live re-check read the LAUNCHER's process.env.HOME, so they
// agreed with each other by construction and the drift check could never fire
// no matter what the worker actually saw.
//
// The point of these tests is that the check is now genuinely capable of
// failing. A check that cannot fail is not a check.

const TREATMENT = Object.freeze({
  id: "haiku-solo",
  configuration: Object.freeze({
    sidekick: Object.freeze({ enabled: false, gate: "off", sessionBudgetUsd: 0 }),
  }),
});

function captureAgainstHome(home, cwd) {
  return captureGate2702BehaviorContext({
    cwd,
    treatment: TREATMENT,
    observedAt: "2026-07-29T00:00:00.000Z",
    env: { ...process.env, HOME: home },
  });
}

test("the drift check CAN fail: the behavior context tracks the HOME it is captured against", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-2702-home-"));
  try {
    const launcherHome = join(root, "launcher");
    const isolatedHome = join(root, "isolated");
    const cwd = join(root, "worktree");
    for (const path of [join(launcherHome, ".sidekick"), isolatedHome, cwd]) {
      mkdirSync(path, { recursive: true });
    }
    // The operator has user-scope Sidekick instructions; the jail's home does not.
    writeFileSync(
      join(launcherHome, ".sidekick", "SIDEKICK.md"),
      "Always prefer the smallest diff.\n",
      "utf8",
    );

    const recordedAgainstLauncher = captureAgainstHome(launcherHome, cwd);
    const liveAgainstIsolated = captureAgainstHome(isolatedHome, cwd);

    // The launcher's view sees the user-scope file; the worker's view does not.
    assert.equal(
      recordedAgainstLauncher.instructionSources.some((s) => s.scope === "user"),
      true,
    );
    assert.equal(
      liveAgainstIsolated.instructionSources.some((s) => s.scope === "user"),
      false,
    );

    // Therefore the two contexts differ, and the sealer's `sameValue(live,
    // recorded)` drift check fires. This is the assertion that would have been
    // impossible to satisfy before the fix.
    assert.notEqual(
      liveAgainstIsolated.instructionsDigest,
      recordedAgainstLauncher.instructionsDigest,
    );
    assert.notDeepEqual(liveAgainstIsolated, recordedAgainstLauncher);

    // Same home on both sides still agrees, so the check is not simply broken.
    assert.deepEqual(
      captureAgainstHome(isolatedHome, cwd),
      liveAgainstIsolated,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the isolated home is one derivation: preflight and the attested receipt agree", () => {
  const runDir = "/tmp/gate-2702/runs/issue-1/haiku-solo/attempt-1";
  const expected = resolve(runDir, "sandbox", "home");

  // Before any receipt exists (preflight) the path is derived from the run dir.
  assert.equal(
    gate2702IsolatedHome({
      runDir,
      env: { CHD_EXPERIMENT_2702_TEST_MODE: "0" },
      unattested: "derive",
    }),
    expected,
  );
  // Accounting runs after dispatch: no receipt means the arm was never jailed,
  // so it must NOT be told to use an isolated home that does not exist.
  assert.equal(
    gate2702IsolatedHome({ runDir, env: { CHD_EXPERIMENT_2702_TEST_MODE: "0" } }),
    null,
  );
  // After dispatch the attested value must equal that same derivation.
  assert.equal(
    gate2702IsolatedHome({
      runDir,
      preDispatch: { sandbox: { isolatedHome: expected } },
    }),
    expected,
  );
  // An arm dispatched unjailed reports no isolated home rather than guessing one.
  assert.equal(
    gate2702IsolatedHome({ runDir, preDispatch: { argv: ["claude"] } }),
    null,
  );
  assert.equal(
    gate2702IsolatedHome({
      runDir,
      env: { CHD_EXPERIMENT_2702_TEST_MODE: "1" },
      unattested: "derive",
    }),
    null,
  );
});

test("an attested isolated home outside the registered run fails closed", () => {
  const runDir = "/tmp/gate-2702/runs/issue-1/haiku-solo/attempt-1";
  for (const isolatedHome of [
    "/tmp/gate-2702/runs/issue-2/haiku-solo/attempt-1/sandbox/home",
    "/tmp/elsewhere/home",
    "/tmp/gate-2702/runs/issue-1/haiku-solo/attempt-1/sandbox",
    42,
  ]) {
    assert.throws(
      () => gate2702IsolatedHome({ runDir, preDispatch: { sandbox: { isolatedHome } } }),
      /sandbox home is not bound to the registered run/,
      `expected rejection for ${String(isolatedHome)}`,
    );
  }
});
