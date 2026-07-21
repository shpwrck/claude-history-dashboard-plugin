/**
 * Server-only filesystem adapter for the bounded #2702 C5 Shadow Calls view.
 *
 * Trial discovery is deliberately shallow. Eligible directories are handed to
 * #2823's `loadCurrentEvaluation`, which re-verifies the complete #2822 seal
 * before returning decoded Runs. This adapter then discards Definition,
 * registry, and every raw-artifact capability before calling the allowlisted
 * TypeScript projection. Verification errors become counts, never response
 * prose.
 */

import { lstatSync, opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFINITION_DIRECTORY =
  "sha256-8fffa2337498bb06ee5eeb0ce234ba9c0c4af2fdd908fb3d88371c23d001f8ba";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TRIAL_DIRECTORIES = 256;

function safeMetadata(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function regularFile(path) {
  const metadata = safeMetadata(path);
  return metadata !== null && metadata.isFile() && !metadata.isSymbolicLink();
}

/**
 * Read at most one entry beyond the producer contract. Overflow fails closed:
 * returning an arbitrary filesystem-order prefix would let junk entries starve
 * verified trials while still claiming the projected rows were complete/newest.
 */
function boundedTrialNames(path) {
  let directory = null;
  try {
    directory = opendirSync(path);
    const names = [];
    while (names.length <= MAX_TRIAL_DIRECTORIES) {
      const entry = directory.readSync();
      if (entry === null) {
        directory.closeSync();
        directory = null;
        return { state: "ok", names: names.sort() };
      }
      names.push(entry.name);
    }
    directory.closeSync();
    directory = null;
    return { state: "overflow", names: [] };
  } catch {
    try {
      directory?.closeSync();
    } catch {
      // The directory is already unusable; the caller reports malformed state.
    }
    return { state: "malformed", names: [] };
  }
}

async function projectionFunction(dependencies) {
  if (typeof dependencies?.projectGate2702C5 === "function") {
    return dependencies.projectGate2702C5;
  }
  await import("../register-ts.mjs");
  const module = await import("../../src/lib/shadow-experiments.ts");
  if (typeof module.projectGate2702C5 !== "function") {
    throw new Error("C5 Shadow Calls projection is unavailable");
  }
  return module.projectGate2702C5;
}

async function evaluationLoader(dependencies) {
  if (typeof dependencies?.loadCurrentEvaluation === "function") {
    return dependencies.loadCurrentEvaluation;
  }
  const configuredBundle = process.env.CHD_GATE_2702_RUNTIME_VERIFIER;
  const runtimeVerifierUrl = configuredBundle
    ? pathToFileURL(resolve(configuredBundle)).href
    : new URL("./runtime-verifier.bundle.mjs", import.meta.url).href;
  let module;
  try {
    module = await import(runtimeVerifierUrl);
  } catch (error) {
    // Source checkouts do not carry generated artifacts. Production and an
    // explicit test/deploy override must never fall back to the npm-dependent
    // source graph that the zero-node_modules image cannot load.
    if (process.env.NODE_ENV === "production" || configuredBundle) throw error;
    module = await import("./evaluate.mjs");
  }
  if (typeof module.loadCurrentEvaluation !== "function") {
    throw new Error("#2823 runtime loadCurrentEvaluation is unavailable");
  }
  return module.loadCurrentEvaluation;
}

/**
 * Return `null` when the C5 state tree does not exist, preserving the legacy
 * route shape. Once the exact Definition directory exists, return a bounded
 * projection with reconciliation even when every candidate is unsealed or
 * malformed.
 */
export async function readGate2702ShadowProjection(
  { stateRoot, maxRows, maxEvaluations } = {},
  dependencies = {},
) {
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    throw new Error("C5 Shadow Calls stateRoot is required");
  }
  const resolvedStateRoot = resolve(stateRoot);
  const definitionRoot = join(resolvedStateRoot, DEFINITION_DIRECTORY);
  const rootMetadata = safeMetadata(definitionRoot);
  if (rootMetadata === null) return null;
  const sources = [];
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    sources.push({ state: "malformed" });
  } else {
    const discovery = boundedTrialNames(definitionRoot);
    if (discovery.state === "malformed") {
      sources.push({ state: "malformed" });
    } else if (discovery.state === "overflow") {
      // Do not return a partial, filesystem-order-dependent view as complete.
      sources.push({ state: "discovery-overflow" });
    } else {
      let loadCurrentEvaluation = null;
      for (const name of discovery.names) {
        if (!UUID_PATTERN.test(name)) {
          sources.push({ state: "malformed" });
          continue;
        }
        const trialRoot = join(definitionRoot, name);
        const trialMetadata = safeMetadata(trialRoot);
        if (!trialMetadata?.isDirectory() || trialMetadata.isSymbolicLink()) {
          sources.push({ state: "malformed", trialId: name });
          continue;
        }
        const markerPath = join(trialRoot, "seal", "verified.json");
        const markerMetadata = safeMetadata(markerPath);
        if (markerMetadata === null) {
          sources.push({ state: "unsealed", trialId: name });
          continue;
        }
        if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
          sources.push({ state: "malformed", trialId: name });
          continue;
        }
        const currentPath = join(trialRoot, "evaluation", "current.json");
        if (!regularFile(currentPath)) {
          sources.push({ state: "malformed", trialId: name });
          continue;
        }
        try {
          loadCurrentEvaluation ??= await evaluationLoader(dependencies);
          const verified = await loadCurrentEvaluation({
            trial: name,
            stateRoot: resolvedStateRoot,
          });
          // Explicit allowlist: do not pass Definition, registry, an object
          // reader, paths, or any other upstream field toward the wire.
          sources.push({
            state: "verified",
            marker: verified.marker,
            manifest: verified.manifest,
            runs: verified.runs,
            evaluation: verified.evaluation,
          });
        } catch {
          sources.push({ state: "malformed", trialId: name });
        }
      }
    }
  }

  const projectGate2702C5 = await projectionFunction(dependencies);
  return projectGate2702C5(sources, { maxRows, maxEvaluations });
}
