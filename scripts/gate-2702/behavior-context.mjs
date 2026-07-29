import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const GATE_2702_WORKER_MODEL_ID = "claude-haiku-4-5-20251001";
export const GATE_2702_SIDEKICK_MODEL_ID = "claude-sonnet-5";
export const GATE_2702_SIDEKICK_VERSION = "0.3.3";

/**
 * The behavior context's OWN schema version. Deliberately a separate constant
 * from any receipt's `SCHEMA_VERSION`: classify.mjs and seal-classification.mjs
 * validated this nested object against THEIR receipt version, which silently
 * pinned the two together -- so the behavior context could not be versioned at
 * all without breaking receipt validation everywhere.
 *
 * v2 (#3085): the context is captured against the HOME the WORKER runs under
 * -- the jail's isolated home -- not the launcher's. For an operator with
 * ~/.sidekick/SIDEKICK.md the recorded instructionSources change meaning, so
 * the version moves rather than letting a v1 digest silently stand for a
 * different capture basis.
 */
export const GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION = 2;

export function gate2702ExecutionMode(env = process.env) {
  return env.CHD_EXPERIMENT_2702_TEST_MODE === "1" ? "test" : "production";
}

export const GATE_2702_SIDEKICK_ENV_KEYS = [
  "SIDEKICK_ENABLE",
  "SIDEKICK_MODEL",
  "SIDEKICK_GATE",
  "SIDEKICK_WARMUP_TOKENS",
  "SIDEKICK_BACKOFF_AFTER",
  "SIDEKICK_BACKOFF_MAX",
  "SIDEKICK_SESSION_BUDGET_USD",
  "SIDEKICK_TRIGGER_RESERVE_USD",
  "SIDEKICK_CALL_BUDGET_USD",
  "SIDEKICK_SIGHTED",
  "SIDEKICK_VERIFY_LENS",
  "SIDEKICK_SYNC",
  "SIDEKICK_TRIGGERS",
  "SIDEKICK_TRIAGE_MODEL",
  "SIDEKICK_AUDITS",
  "SIDEKICK_SHIP_COOLDOWN",
  "SIDEKICK_NEARDUP",
  "SIDEKICK_NEARDUP_MIN_SHARED",
  "SIDEKICK_CONCURRENCY",
  "SIDEKICK_MIN_DELTA",
  "SIDEKICK_NOTIFY",
  "SIDEKICK_NESTED",
];

const INSTRUCTION_CHARS_PER_FILE = 6_000;
const INSTRUCTION_FILE_BYTES = 1024 * 1024;

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

function configuredModel(env, name, fallback, tier) {
  const value = String(env[name] || fallback).trim();
  if (!new RegExp(`^claude-${tier}-[a-z0-9-]+$`).test(value)) {
    throw new Error(`${name} must be a fully qualified Claude ${tier} model`);
  }
  return value;
}

export function gate2702ModelIds(env = process.env) {
  return {
    worker: configuredModel(
      env,
      "CHD_EXPERIMENT_2702_WORKER_MODEL_ID",
      GATE_2702_WORKER_MODEL_ID,
      "haiku",
    ),
    sidekick: configuredModel(
      env,
      "CHD_EXPERIMENT_2702_SIDEKICK_MODEL_ID",
      GATE_2702_SIDEKICK_MODEL_ID,
      "sonnet",
    ),
  };
}

export function gate2702ResolvedSidekickConfig(treatment, env = process.env) {
  const models = gate2702ModelIds(env);
  const enabled = treatment.configuration.sidekick.enabled;
  return {
    enabled,
    model: models.sidekick,
    gate: enabled ? treatment.configuration.sidekick.gate : "off",
    warmupTokens: 150_000,
    backoffAfter: 3,
    backoffMax: 8,
    sessionBudgetUsd: enabled
      ? treatment.configuration.sidekick.sessionBudgetUsd
      : 0,
    triggerReserveUsd: enabled ? 1 : 0,
    callBudgetUsd: enabled
      ? treatment.configuration.sidekick.perCallBudgetUsd
      : 0,
    sighted: true,
    verifyLens: true,
    sync: false,
    triggers: [
      "push-or-pr",
      "merge-conflict",
      "sensitive-file-edit",
      "destructive",
    ],
    triageModel: "claude-haiku-4-5",
    audits: ["file"],
    shipCooldown: 2,
    nearDup: 0.5,
    nearDupMinShared: 4,
    concurrency: 1,
    minDelta: 120,
  };
}

export function gate2702SidekickEnvironment(treatment, env = process.env) {
  const config = gate2702ResolvedSidekickConfig(treatment, env);
  return {
    SIDEKICK_ENABLE: config.enabled ? "1" : "0",
    SIDEKICK_MODEL: config.model,
    SIDEKICK_GATE: config.gate,
    SIDEKICK_WARMUP_TOKENS: String(config.warmupTokens),
    SIDEKICK_BACKOFF_AFTER: String(config.backoffAfter),
    SIDEKICK_BACKOFF_MAX: String(config.backoffMax),
    SIDEKICK_SESSION_BUDGET_USD: String(config.sessionBudgetUsd),
    SIDEKICK_TRIGGER_RESERVE_USD: String(config.triggerReserveUsd),
    SIDEKICK_CALL_BUDGET_USD: String(config.callBudgetUsd),
    SIDEKICK_SIGHTED: config.sighted ? "1" : "0",
    SIDEKICK_VERIFY_LENS: config.verifyLens ? "1" : "0",
    SIDEKICK_SYNC: config.sync ? "1" : "0",
    SIDEKICK_TRIGGERS: config.triggers.join(","),
    SIDEKICK_TRIAGE_MODEL: config.triageModel,
    SIDEKICK_AUDITS: config.audits.join(","),
    SIDEKICK_SHIP_COOLDOWN: String(config.shipCooldown),
    SIDEKICK_NEARDUP: String(config.nearDup),
    SIDEKICK_NEARDUP_MIN_SHARED: String(config.nearDupMinShared),
    SIDEKICK_CONCURRENCY: String(config.concurrency),
    SIDEKICK_MIN_DELTA: String(config.minDelta),
    SIDEKICK_NESTED: "0",
  };
}

function findUp(cwd, name) {
  let directory = cwd;
  for (let depth = 0; depth < 30 && directory; depth += 1) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function instructionPart(scope, path) {
  if (!path || !existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > INSTRUCTION_FILE_BYTES
  ) {
    throw new Error(
      `Sidekick ${scope} instructions are not a bounded regular file`,
    );
  }
  const original = readFileSync(path, "utf8").trim();
  if (!original) return null;
  const text = original.slice(0, INSTRUCTION_CHARS_PER_FILE);
  return {
    text,
    evidence: {
      scope,
      contentDigest: sha256(Buffer.from(text, "utf8")),
      characterLength: text.length,
      truncated: original.length > text.length,
    },
  };
}

export function gate2702InstructionContext(cwd, env = process.env) {
  const home = env.HOME;
  if (typeof home !== "string" || !isAbsolute(home)) {
    throw new Error(
      "C5 requires an absolute HOME matching Sidekick resolution",
    );
  }
  const parts = [
    instructionPart("user", join(home, ".sidekick", "SIDEKICK.md")),
    instructionPart("project", findUp(cwd, "SIDEKICK.md")),
  ].filter(Boolean);
  const instructionSources = parts.map((part) => part.evidence);
  return {
    instructionsDigest: sha256(
      Buffer.from(canonicalJson(instructionSources), "utf8"),
    ),
    instructionSources,
  };
}

export function captureGate2702BehaviorContext({
  cwd,
  treatment,
  sidekickVersion,
  sidekickImplementationDigest,
  sidekickActivation,
  observedAt = new Date().toISOString(),
  env = process.env,
}) {
  const models = gate2702ModelIds(env);
  const resolvedSidekickConfig = gate2702ResolvedSidekickConfig(treatment, env);
  const instructions = gate2702InstructionContext(cwd, env);
  const enabled = treatment.configuration.sidekick.enabled;
  if (
    enabled &&
    (sidekickVersion !== GATE_2702_SIDEKICK_VERSION ||
      !/^sha256:[0-9a-f]{64}$/.test(sidekickImplementationDigest ?? "") ||
      sidekickActivation?.pluginEnabled !== true ||
      sidekickActivation?.globalPauseAbsent !== true)
  ) {
    throw new Error(
      `C5 requires claude-sidekick ${GATE_2702_SIDEKICK_VERSION} with a verified implementation`,
    );
  }
  return {
    schemaVersion: GATE_2702_BEHAVIOR_CONTEXT_SCHEMA_VERSION,
    observedAt,
    workerModelQualifiedId: models.worker,
    sidekickModelQualifiedId: enabled ? models.sidekick : null,
    sidekickVersion: enabled ? sidekickVersion : null,
    sidekickImplementationDigest: enabled ? sidekickImplementationDigest : null,
    sidekickActivation: enabled ? sidekickActivation : null,
    resolvedSidekickConfig,
    resolvedSidekickConfigDigest: sha256(
      Buffer.from(canonicalJson(resolvedSidekickConfig), "utf8"),
    ),
    ...instructions,
  };
}
