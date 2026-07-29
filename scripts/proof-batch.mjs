#!/usr/bin/env node
/**
 * proof-batch.mjs — the v0.4 proof-batch orchestrator (#1077, epic #995).
 *
 * Runs the pre-registered matched-pairs causal-proof batch frozen in
 * `docs/v0.4-proof-preregistration.md`: for each fixture pair, the SAME task is
 * run under a control arm (the #890 repo-map recommendation WITHHELD) and an
 * injected arm (the recommendation PREPENDED to the worker prompt), k times per
 * arm, each in its own throwaway materialized mini-repo, each worker jailed via
 * the shadow-calls srt sandbox. Gate 0 (the pair's objective gate command, run
 * in the materialized tree) decides per-run success; the worker's reported
 * cost (total_cost_usd, with a token-pricing fallback) is the primary metric.
 * The batch aggregates per-pair medians, runs the §4/§5 statistics, builds a
 * ProofReceipt, and appends it (unless --dry-run, which writes to a temp file
 * and prints the object).
 *
 * Budget: a DEDICATED proof envelope, independent of the fail-closed live
 * shadow gate. It enforces a hard per-worker --max-budget-usd cap and a
 * --total-budget-usd batch cap, and honors the shadow-calls killswitch. It does
 * NOT call budget.decide('live'). The jail is mandatory (sandboxGate()).
 *
 * This file is a thin orchestrator: the fixture schema/loader, the jail, the
 * stats, the cost model, and the receipt schema are all reused verbatim from
 * src/lib and ~/.claude/shadow-calls/lib — nothing is reinvented here.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { isAbsolute, join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProofGate } from './proof-gate-sandbox.mjs';

// --- TS-source imports (this repo's src/lib is loaded via the register-ts hook).
import {
  parseProofPairBundle,
  validateProofPairBundle,
  chainSteps,
} from '../src/lib/proof-fixture-pairs.ts';
import { resolveModelPricing } from '../src/lib/pricing.ts';
import {
  median,
  pairedDeltas,
  pairedMedianDelta,
  pairedMedianPctDelta,
  wilcoxonSignedRank,
  bootstrapCI,
  decideVerdict,
  PRE_REGISTERED_ALPHA,
  PRE_REGISTERED_MDE_PCT,
  PRE_REGISTERED_MIN_DECIDED,
} from '../src/lib/proof-stats.ts';
import { appendAdoptionReceipt } from '../src/lib/adoption-receipts.ts';
import {
  createProofEvidenceArtifact,
  persistProofEvidenceArtifact,
  verifyProofReceiptAgainstEvidence,
} from '../src/lib/proof-evidence.ts';

// --- Shadow-calls jail + killswitch (absolute paths; user-global lib).
const SHADOW_LIB = join(homedir(), '.claude', 'shadow-calls', 'lib');
const {
  sandboxGate,
  buildWorkerLaunch,
  seedTempHome,
} = await import(
  pathToFileURL(join(SHADOW_LIB, 'sandbox.mjs')).href
);
const { isKilled, killReason } = await import(
  pathToFileURL(join(SHADOW_LIB, 'killswitch.mjs')).href
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BUNDLE_DIR = join(REPO_ROOT, 'fixtures', 'proof', 'repo-map-context-waste');
const MANIFEST = join(BUNDLE_DIR, 'manifest.json');
const PREREG_REF = 'docs/v0.4-proof-preregistration.md';
const DETECTOR_REF = 'src/lib/detectors/context/repo-map-context-waste.ts';
const WASTE_PATTERN = 'repo-map-context-waste';

// ---------------------------------------------------------------- flag parsing
function parseArgs(argv) {
  const a = {
    limit: 12,
    k: 3,
    model: 'claude-sonnet-4-6',
    maxBudgetUsd: 0.5,
    totalBudgetUsd: 30,
    concurrency: 4,
    out: null,
    evidenceDir: null,
    pairs: null, // optional allowlist of pairIds to run (repeatable --pair)
    dryRun: false,
    observedUsdPerMo: null,
    externalReviewRef: '',
    qualification: '',
    finalize: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--limit': a.limit = Number(next()); break;
      case '--k': a.k = Number(next()); break;
      case '--model': a.model = next(); break;
      case '--max-budget-usd': a.maxBudgetUsd = Number(next()); break;
      case '--total-budget-usd': a.totalBudgetUsd = Number(next()); break;
      case '--concurrency': a.concurrency = Number(next()); break;
      case '--out': a.out = next(); break;
      case '--evidence-dir': a.evidenceDir = next(); break;
      case '--pair': (a.pairs ??= []).push(next()); break;
      case '--dry-run': a.dryRun = true; break;
      case '--observed-usd-per-mo': a.observedUsdPerMo = Number(next()); break;
      case '--external-review-ref': a.externalReviewRef = next(); break;
      case '--qualification': a.qualification = next(); break;
      case '--finalize': a.finalize = next(); break;
      case '--help': case '-h': printUsage(); process.exit(0); break;
      default:
        console.error(`unknown flag: ${arg}`);
        printUsage();
        process.exit(2);
    }
  }
  return a;
}

function printUsage() {
  console.log(`Usage: node scripts/proof-batch.mjs [flags]
  --limit N               pairs to run (default 12 — the full pre-registered batch)
  --k N                   runs per arm (default 3)
  --model ID              worker model (default claude-sonnet-4-6)
  --max-budget-usd USD    hard per-worker cap (default 0.5)
  --total-budget-usd USD  batch spend cap; stops early if next pair would exceed (default 30)
  --concurrency N         max concurrent jailed workers (default 4)
  --out PATH              receipt JSONL path (default a /tmp path)
  --evidence-dir PATH     immutable run-level evidence directory (default beside --out)
  --observed-usd-per-mo N #890 observed $/mo for the receipt (default a labeled placeholder)
  --dry-run               write the receipt to a temp file + print it, never the real log`);
}

// ---------------------------------------------------------------- worker output
/**
 * Robustly read the cost (USD) from a `claude -p --output-format json` result.
 * Prefers the worker's own total_cost_usd / cost_usd; falls back to pricing the
 * reported usage tokens at the run model (matches estimateEntryCost's math).
 */
function costFromWorkerJson(cj, model) {
  if (typeof cj?.total_cost_usd === 'number') return { usd: cj.total_cost_usd, source: 'total_cost_usd' };
  if (typeof cj?.cost_usd === 'number') return { usd: cj.cost_usd, source: 'cost_usd' };
  const u = cj?.usage || {};
  const { pricing } = resolveModelPricing(model);
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const usd =
    (input / 1_000_000) * pricing.input +
    (output / 1_000_000) * pricing.output +
    (cacheWrite / 1_000_000) * pricing.cacheWrite5m +
    (cacheRead / 1_000_000) * pricing.cacheRead;
  return { usd, source: 'estimated-from-tokens' };
}

function tokensFromWorkerJson(cj) {
  const u = cj?.usage || {};
  return (
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0)
  );
}

// ---------------------------------------------------------------- jailed worker
function buildPrompt(instruction) {
  // One per-session prompt — the bare task. The treatment is NOT prepended here:
  // in the multi-session design (#2082) the #890 recommendation is persisted as a
  // CLAUDE.md in the tree (materialized once by runArmOnce for the injected arm),
  // so it is present in EVERY session's project context — exactly how the real
  // fix is deployed — instead of a one-shot prompt prepend. Control gets no such
  // file, so it re-reads the stable file from cold each session.
  return `You are working in a small standalone code repository. Complete this task:\n\n${instruction}\n\nMake the minimal change needed. Do not explain; just edit the files.\n`;
}

/**
 * Adherence proxy (#2083, threat #1): count the agent's tool_use blocks that
 * REFERENCE a stable file this session — Read(file_path), Bash(command), Grep,
 * etc. that mention a stable path. A treatment arm that actually honors the
 * injected reference should touch the stable file FEWER times than control,
 * which re-discovers it cold each session. Separates "mechanism doesn't help"
 * from "agent ignored the recommendation". Counts tool INVOCATIONS, not bytes.
 */
function countStableReads(stdout, stablePaths) {
  if (!stablePaths || stablePaths.length === 0) return 0;
  let count = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj?.message?.content ?? obj?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const s = JSON.stringify(b.input ?? {});
      if (stablePaths.some((p) => p && s.includes(p))) count++;
    }
  }
  return count;
}

/** Spawn one jailed worker; resolve with its parsed JSON result (or an error marker). */
function runWorker({ worktree, prompt, model, maxBudgetUsd, stablePaths }) {
  return new Promise((resolveRun) => {
    const tempHome = seedTempHome();
    const promptPath = join(tempHome, 'prompt.txt');
    writeFileSync(promptPath, prompt, 'utf8');
    const { argv, env } = buildWorkerLaunch({
      worktree,
      promptPath,
      tempHome,
      model,
      maxBudgetUsd,
      coldStart: true, // fixtures are self-contained; deny the real $HOME
    });
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      resolveRun({
        ok: false,
        unresolved: true,
        reason: `spawn error: ${err.message}`,
        wallMs: Date.now() - started,
        tempHome,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        resultDigest: null,
        resultType: null,
      });
    });
    child.on('close', (code) => {
      const wallMs = Date.now() - started;
      let cj = null;
      let selectedResultText = null;
      // The jailed worker runs with `--output-format stream-json --verbose`
      // (set by the shadow-calls buildWorkerLaunch), so stdout is NDJSON: many
      // JSON lines, the LAST of which is the `{"type":"result", total_cost_usd,
      // usage, ...}` summary the cost/token extractors read. Walk lines from the
      // end and take the last parseable object, preferring the result line.
      const lines = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj && typeof obj === 'object') {
            cj = obj;
            selectedResultText = lines[i];
            if (obj.type === 'result') break;
          }
        } catch {
          /* not a JSON line (verbose preamble, etc.) */
        }
      }
      // Fallback for a single-object `--output-format json` build.
      if (!cj) {
        try {
          selectedResultText = stdout.trim();
          cj = JSON.parse(selectedResultText);
        } catch { /* give up */ }
      }
      if (!cj) {
        resolveRun({
          ok: false,
          unresolved: true,
          reason: `worker produced no parseable JSON (exit ${code})`,
          stderr: stderr.slice(-400),
          wallMs,
          tempHome,
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: typeof code === 'number' ? code : null,
          resultDigest: null,
          resultType: null,
        });
        return;
      }
      const stableReads = countStableReads(stdout, stablePaths);
      resolveRun({
        ok: true,
        cj,
        wallMs,
        exitCode: typeof code === 'number' ? code : null,
        tempHome,
        stableReads,
        startedAt,
        finishedAt: new Date().toISOString(),
        resultDigest: `sha256:${createHash('sha256')
          .update(selectedResultText ?? '')
          .digest('hex')}`,
        resultType: typeof cj.type === 'string' ? cj.type : null,
      });
    });
  });
}

// ---------------------------------------------------------------- Gate 0
/**
 * Run the pair's objective gate command under the pinned sandbox-runtime.
 * DECIDED-success iff exit code === gate.expectExitCode (and the optional
 * expectMatch substring is present). Anything else is DECIDED-fail.
 *
 * The free-form command remains compatible with the frozen fixture schema, but
 * it executes through the pinned sandbox-runtime CLI: read access starts
 * closed, host writes are confined to the disposable tree, network access is
 * empty-by-default, PID state is namespaced, Unix sockets are seccomp-blocked,
 * and the environment is rebuilt from a fixed allowlist.
 */
export const runGate = runProofGate;

// ---------------------------------------------------------------- one arm-run
/**
 * Run ONE arm of a pair as a multi-session chain (#2082): materialize the tree
 * once, then run each chain step as its own COLD jailed session over the SAME
 * accumulating tree. The injected arm gets the #890 recommendation written as a
 * persistent `CLAUDE.md` (present every session → it can cite symbols instead of
 * re-reading); the control arm has no such file → it re-reads from cold each
 * session. Cost/tokens/wall are summed across the chain; `perStepCostUsd` records
 * the dose-response. Gate 0 runs once, on the FINAL accumulated tree. Any session
 * that errors or yields no parseable result makes the whole chain-run UNRESOLVED.
 * A legacy single-session pair (no `chain`) runs as a 1-step chain — identical to
 * the prior behavior, minus the prompt prepend (now via CLAUDE.md).
 */
async function runArmOnce({ pair, arm, runIndex, model, maxBudgetUsd }) {
  const startedAt = new Date().toISOString();
  // Materialize a throwaway copy of the fixture tree (a standalone mini-repo,
  // NOT a git worktree). The jailed workers edit it across sessions; Gate 0
  // verifies the final state.
  const treeSrc = join(BUNDLE_DIR, pair.tree);
  const scratch = mkdtempSync(join(tmpdir(), `proof-${pair.pairId}-${arm}-`));
  const tree = join(scratch, 'tree');
  cpSync(treeSrc, tree, { recursive: true });

  // Treatment mechanism: persist the recommendation as a project CLAUDE.md so it
  // is in EVERY session's context. APPEND to any pre-existing CLAUDE.md (some
  // fixtures ship a scenario convention file) so the ONLY difference between arms
  // is the appended recommendation (anti-gaming constraint 1) — never replace it.
  // Control gets the tree's CLAUDE.md (if any) unchanged.
  if (arm === 'injected') {
    const claudeMdPath = join(tree, 'CLAUDE.md');
    const existing = existsSync(claudeMdPath) ? `${readFileSync(claudeMdPath, 'utf8').replace(/\n*$/, '')}\n\n` : '';
    writeFileSync(claudeMdPath, `${existing}${pair.injectedRecommendation}\n`, 'utf8');
  }

  const steps = chainSteps(pair);
  const stablePaths = (pair.stableFiles ?? []).map((f) => f.path).filter(Boolean);
  const tempHomes = [];
  const perStepCostUsd = [];
  const perStepTokens = [];
  const perStepCostSources = [];
  const workerResults = [];
  let costUsd = 0;
  let tokens = 0;
  let wallMs = 0;
  let stableReads = 0; // #2083 adherence: total stable-file tool touches across the chain
  let costSource;
  const finishRun = (result) => ({
    ...result,
    pairId: pair.pairId,
    arm,
    runIndex,
    modelVersion: model,
    startedAt,
    finishedAt: new Date().toISOString(),
    sessions: steps.length,
    perStepCostUsd,
    perStepTokens,
    perStepCostSources,
    workerResults,
    scratch,
    tempHomes,
  });

  for (let i = 0; i < steps.length; i++) {
    const where = `session ${i + 1}/${steps.length}`;
    let worker;
    try {
      worker = await runWorker({ worktree: tree, prompt: buildPrompt(steps[i]), model, maxBudgetUsd, stablePaths });
    } catch (err) {
      const failedAt = new Date().toISOString();
      workerResults.push({
        session: i + 1,
        startedAt: failedAt,
        finishedAt: failedAt,
        exitCode: null,
        resultDigest: null,
        resultType: 'exception',
      });
      return finishRun({ unresolved: true, reason: `worker exception (${where}): ${err.message}`, costUsd, tokens, costSource, wallMs });
    }
    if (worker.tempHome) tempHomes.push(worker.tempHome);
    workerResults.push({
      session: i + 1,
      startedAt: worker.startedAt,
      finishedAt: worker.finishedAt,
      exitCode: worker.exitCode,
      resultDigest: worker.resultDigest,
      resultType: worker.resultType,
    });
    if (!worker.ok) {
      return finishRun({ unresolved: true, reason: `${worker.reason} (${where})`, costUsd, tokens, costSource, wallMs: wallMs + (worker.wallMs || 0) });
    }
    const { usd, source } = costFromWorkerJson(worker.cj, model);
    costSource = source;
    perStepCostSources.push(source);
    const stepTokens = tokensFromWorkerJson(worker.cj);
    costUsd += usd;
    tokens += stepTokens;
    wallMs += worker.wallMs;
    stableReads += worker.stableReads ?? 0;
    perStepCostUsd.push(usd);
    perStepTokens.push(stepTokens);
    const isError = worker.cj.is_error === true || worker.cj.subtype === 'error_max_turns' || worker.cj.subtype === 'error_during_execution';
    // A session that errored out (max-budget / crash) makes the chain UNRESOLVED.
    if (isError) {
      return finishRun({ unresolved: true, reason: `worker is_error/${worker.cj.subtype} (${where})`, costUsd, tokens, costSource, wallMs });
    }
  }

  // Gate 0 on the FINAL accumulated tree.
  const gateResult = await runGate(tree, pair.gate);
  const gate = {
    kind: pair.gate.kind,
    command: pair.gate.command,
    expectMatch: pair.gate.expectMatch ?? null,
    ...gateResult,
  };
  return finishRun({
    unresolved: false,
    decidedSuccess: gate.pass,
    gate,
    costUsd,
    tokens,
    costSource,
    wallMs,
    stableReads,
  });
}

function cleanupScratch(run) {
  const paths = [run?.scratch, run?.tempHome, ...(run?.tempHomes ?? [])];
  for (const p of paths) {
    if (p && existsSync(p)) { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

function runEvidence(run) {
  return {
    runId: `${run.pairId}/${run.arm}/${run.runIndex}`,
    pairId: run.pairId,
    arm: run.arm,
    runIndex: run.runIndex,
    modelVersion: run.modelVersion,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    unresolved: run.unresolved,
    unresolvedReason: run.unresolved ? run.reason ?? 'unresolved' : null,
    decidedSuccess: run.unresolved ? null : run.decidedSuccess === true,
    gate: run.gate
      ? {
          kind: run.gate.kind,
          command: run.gate.command,
          expectMatch: run.gate.expectMatch,
          pass: run.gate.pass,
          exitCode: run.gate.exitCode,
          expectedExitCode: run.gate.expected,
        }
      : null,
    costUsd: run.costUsd,
    costSources:
      run.perStepCostSources?.length > 0
        ? [...run.perStepCostSources]
        : run.costSource
          ? [run.costSource]
          : [],
    tokenCounts: {
      total: run.tokens,
      perStep: [...(run.perStepTokens ?? [])],
    },
    wallMs: run.wallMs,
    sessions: run.sessions,
    stableReads: run.stableReads ?? 0,
    perStepCostUsd: [...(run.perStepCostUsd ?? [])],
    workerResults: [...(run.workerResults ?? [])],
  };
}

function portableEvidenceRef(path) {
  const repoRelative = relative(REPO_ROOT, path);
  if (
    repoRelative &&
    repoRelative !== '..' &&
    !repoRelative.startsWith(`..${sep}`)
  ) {
    return repoRelative.split(sep).join('/');
  }
  return path;
}

function evidencePathFromRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new Error('proof receipt has no evidenceRef');
  }
  return isAbsolute(ref) ? ref : resolve(REPO_ROOT, ref);
}

// ---------------------------------------------------------------- concurrency
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv);

  // --- finalize mode: persist a previously-computed draft receipt with the
  // external-review reference (no batch re-run). The receipt sanitizer refuses
  // a PROOF receipt with an empty externalReviewRef, so this is the step that
  // actually writes the receipt once the #1078 review has happened.
  if (args.finalize) {
    if (!args.externalReviewRef) {
      console.error('--finalize requires --external-review-ref "<checkable reference>"');
      process.exit(2);
    }
    const draft = JSON.parse(readFileSync(args.finalize, 'utf8'));
    draft.externalReviewRef = args.externalReviewRef;
    if (args.qualification && !String(draft.rollout).includes(args.qualification)) {
      draft.rollout = `${draft.rollout}\n\nExternal-review qualification: ${args.qualification}`;
    }
    try {
      const evidencePath = evidencePathFromRef(draft.evidenceRef);
      const artifact = JSON.parse(readFileSync(evidencePath, 'utf8'));
      const verification = verifyProofReceiptAgainstEvidence(draft, artifact);
      if (!verification.ok) {
        console.error(
          `refusing to finalize receipt: ${verification.error}`
        );
        process.exit(5);
      }
    } catch (error) {
      console.error(
        `refusing to finalize receipt without verifiable evidence: ${error.message}`
      );
      process.exit(5);
    }
    const outPath = args.out || join(REPO_ROOT, 'data', 'proof-receipts.jsonl');
    const res = await appendAdoptionReceipt(outPath, draft);
    if (res.ok && res.written) console.log(`finalized receipt appended to ${outPath} (verdict=${draft.result?.verdict}, externalReviewRef set)`);
    else if (res.ok && !res.written) console.log('receipt writes disabled by env (ADOPTION_RECEIPTS off).');
    else { console.error(`failed to append finalized receipt: ${res.error}`); process.exit(5); }
    return;
  }

  // --- killswitch (honored even though this is not the live shadow gate).
  if (isKilled()) {
    console.error(`ABORT: shadow-calls killswitch engaged (${killReason() || 'no reason'}).`);
    console.error('Re-enable with: node ~/.claude/shadow-calls/lib/killswitch.mjs on');
    process.exit(3);
  }

  // --- mandatory jail.
  const gate = sandboxGate();
  if (!gate.ok) {
    console.error(`not yet provable: jail unavailable — ${gate.reason}`);
    process.exit(4);
  }
  console.log(`jail OK (srt enforced: ${gate.enforced}).`);

  // --- load + validate the frozen bundle.
  const raw = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const bundle = parseProofPairBundle(raw);
  if (!bundle) {
    console.error('not yet provable: manifest.json did not parse into a bundle.');
    process.exit(5);
  }
  const validation = validateProofPairBundle(bundle);
  if (!validation.ok) {
    // Full-batch integrity matters; a limited dry-run can proceed on a subset.
    console.warn(`bundle validation warnings: ${validation.errors.join('; ')}`);
  }

  // Optional --pair allowlist (repeatable) selects specific pairIds before the
  // --limit slice; used for cheap targeted re-calibration of specific fixtures.
  const selectable = args.pairs
    ? bundle.pairs.filter((p) => args.pairs.includes(p.pairId))
    : bundle.pairs;
  if (args.pairs) {
    const found = new Set(selectable.map((p) => p.pairId));
    for (const id of args.pairs) if (!found.has(id)) console.warn(`--pair ${id}: no such pairId in bundle`);
  }
  const pairs = selectable.slice(0, args.limit);
  const outPath =
    args.out ||
    (args.dryRun
      ? join(tmpdir(), `proof-receipt-dryrun-${Date.now()}.jsonl`)
      : join(REPO_ROOT, 'data', 'proof-receipts.jsonl'));
  const evidenceDirectory = resolve(
    args.evidenceDir || join(dirname(outPath), 'proof-evidence')
  );
  const observedUsdPerMo =
    typeof args.observedUsdPerMo === 'number' && Number.isFinite(args.observedUsdPerMo)
      ? args.observedUsdPerMo
      : 0; // labeled placeholder; pass --observed-usd-per-mo for the real #890 figure
  const observedAssumption =
    typeof args.observedUsdPerMo === 'number' && Number.isFinite(args.observedUsdPerMo)
      ? `observed $/mo supplied via --observed-usd-per-mo`
      : `observed $/mo placeholder (0) — pass --observed-usd-per-mo with the #890 figure from real history`;
  const sessionsPer = (p) => chainSteps(p).length;
  const totalSessions = pairs.reduce((s, p) => s + sessionsPer(p) * 2 * args.k, 0);
  const mDesc = bundle.sessionsPerChain ? ` x M=${bundle.sessionsPerChain} sessions` : '';
  console.log(
    `proof-batch: ${pairs.length} pair(s) x 2 arms x k=${args.k}${mDesc} = ${totalSessions} jailed ${args.model} sessions`
  );
  console.log(
    `budget: per-worker $${args.maxBudgetUsd}, batch cap $${args.totalBudgetUsd}, concurrency ${args.concurrency}, dry-run=${args.dryRun}`
  );

  let totalSpend = 0;
  let budgetStopped = false;
  const perPair = [];

  for (const pair of pairs) {
    // Worst-case spend of the next pair = both arms x k runs x M sessions/run at
    // the per-SESSION cap (each session is one capped jailed worker).
    const worstCaseNext = 2 * args.k * sessionsPer(pair) * args.maxBudgetUsd;
    if (totalSpend + worstCaseNext > args.totalBudgetUsd) {
      console.warn(
        `STOP: running ${pair.pairId} could exceed --total-budget-usd ($${args.totalBudgetUsd}); spent $${totalSpend.toFixed(4)} so far.`
      );
      budgetStopped = true;
      break;
    }

    const arms = ['control', 'injected'];
    const armRuns = {};
    for (const arm of arms) {
      const jobs = Array.from({ length: args.k }, (_, index) => ({
        pair,
        arm,
        runIndex: index + 1,
        model: args.model,
        maxBudgetUsd: args.maxBudgetUsd,
      }));
      const runs = await mapLimit(jobs, args.concurrency, (job) => runArmOnce(job));
      for (const r of runs) totalSpend += r.costUsd || 0;
      armRuns[arm] = runs;
    }

    // Per-arm summary: median cost over the k runs, success counts, UNRESOLVED.
    const summarize = (runs) => {
      const decided = runs.filter((r) => !r.unresolved);
      const successes = decided.filter((r) => r.decidedSuccess);
      const costs = decided.map((r) => r.costUsd);
      const wall = decided.map((r) => r.wallMs);
      // Dose-response (#2082): element-wise median per-session cost over the
      // DECIDED runs, so the cumulative onset curve can be built downstream.
      const stepArrays = decided.map((r) => r.perStepCostUsd).filter(Array.isArray);
      const nSteps = stepArrays.length ? Math.max(...stepArrays.map((a) => a.length)) : 0;
      const perStepMedianCostUsd = Array.from({ length: nSteps }, (_, i) => {
        const vals = stepArrays.map((a) => a[i]).filter((v) => typeof v === 'number');
        return vals.length ? median(vals) : NaN;
      });
      return {
        runs,
        nRuns: runs.length,
        nUnresolved: runs.filter((r) => r.unresolved).length,
        nDecided: decided.length,
        nSuccess: successes.length,
        medianCostUsd: costs.length ? median(costs) : NaN,
        medianWallMs: wall.length ? median(wall) : NaN,
        perStepMedianCostUsd,
        // #2083 adherence: median stable-file tool touches per chain over DECIDED runs.
        medianStableReads: decided.length
          ? median(decided.map((r) => r.stableReads ?? 0))
          : NaN,
        // The arm "passes" (contributes a usable cost summary) iff >=1 DECIDED run.
        armDecided: decided.length > 0,
        armSuccess: successes.length > 0,
      };
    };

    const control = summarize(armRuns.control);
    const injected = summarize(armRuns.injected);

    // A matched PAIR is DECIDED only if BOTH arms reached a DECIDED verdict on
    // >=1 run (§3: a pair where either arm fails all k runs is EXCLUDED).
    const pairDecided = control.armDecided && injected.armDecided;
    perPair.push({ pair, control, injected, pairDecided });

    console.log(
      `  ${pair.pairId.padEnd(34)} ctl[dec ${control.nDecided}/${control.nRuns} ok ${control.nSuccess} $${fmt(control.medianCostUsd)} rd ${fmt(control.medianStableReads)}] ` +
        `inj[dec ${injected.nDecided}/${injected.nRuns} ok ${injected.nSuccess} $${fmt(injected.medianCostUsd)} rd ${fmt(injected.medianStableReads)}] ` +
        `pair=${pairDecided ? 'DECIDED' : 'EXCLUDED'}`
    );
  }

  const evidenceArtifact = createProofEvidenceArtifact({
    schemaVersion: '1',
    experimentRef: `proof-batch/${WASTE_PATTERN}`,
    preRegistrationRef: PREREG_REF,
    fixtureSetRef: bundle.bundle,
    modelVersion: args.model,
    createdAt: new Date().toISOString(),
    pairOrder: perPair.map(({ pair }) => pair.pairId),
    analysisPlan: {
      bootstrapIters: 10_000,
      bootstrapAlpha: 0.05,
      bootstrapSeed: 1,
      qualityTolerance: 0.05,
      minDecidedPairs: PRE_REGISTERED_MIN_DECIDED,
      minimumDetectableEffectPct: PRE_REGISTERED_MDE_PCT,
      significanceAlpha: PRE_REGISTERED_ALPHA,
      sessionsPerChain: bundle.sessionsPerChain ?? 0,
      observedUsdPerMo,
    },
    runs: perPair.flatMap(({ control, injected }) => [
      ...control.runs.map(runEvidence),
      ...injected.runs.map(runEvidence),
    ]),
  });
  const persistedEvidence = persistProofEvidenceArtifact(
    evidenceArtifact,
    evidenceDirectory
  );
  const evidenceRef = portableEvidenceRef(persistedEvidence.path);
  console.log(
    `immutable run evidence saved to ${persistedEvidence.path} (${persistedEvidence.artifactDigest})`
  );

  // -------------------------------------------------------------- aggregation
  const decidedPairs = perPair.filter((p) => p.pairDecided);
  const excluded = perPair.filter((p) => !p.pairDecided);
  const nDecided = decidedPairs.length;

  const costPairs = decidedPairs.map((p) => ({
    control: p.control.medianCostUsd,
    treatment: p.injected.medianCostUsd,
  }));
  const latencyPairs = decidedPairs.map((p) => ({
    control: p.control.medianWallMs,
    treatment: p.injected.medianWallMs,
  }));

  const deltas = pairedDeltas(costPairs);
  const medDelta = costPairs.length ? pairedMedianDelta(costPairs) : NaN;
  const medPctDelta = costPairs.length ? pairedMedianPctDelta(costPairs) : NaN;
  const ci = costPairs.length ? bootstrapCI(deltas, { iters: 10000, alpha: 0.05, seed: 1 }) : { lo: NaN, hi: NaN };
  const wilcoxon = costPairs.length ? wilcoxonSignedRank(costPairs) : { statistic: 0, pOneSided: 1, n: 0 };
  const latMedDelta = latencyPairs.length ? pairedMedianDelta(latencyPairs) : NaN;

  // Dose-response (#2082, SUPPORTING — never sets the verdict). Cumulative
  // control/injected cost and their delta at each session boundary, median over
  // DECIDED pairs. Characterizes the ONSET of the cross-session re-read effect;
  // the §5 verdict is still the chain-total test at full M.
  const cumulative = (arr) => {
    const out = [];
    let s = 0;
    for (const v of arr) { s += Number.isFinite(v) ? v : 0; out.push(s); }
    return out;
  };
  const mSessions = bundle.sessionsPerChain ?? 0;
  const doseResponse = mSessions
    ? Array.from({ length: mSessions }, (_, i) => {
        const deltas2 = decidedPairs
          .map((p) => {
            const ctl = cumulative(p.control.perStepMedianCostUsd)[i];
            const inj = cumulative(p.injected.perStepMedianCostUsd)[i];
            return Number.isFinite(ctl) && Number.isFinite(inj) ? inj - ctl : null;
          })
          .filter((v) => v !== null);
        return {
          session: i + 1,
          medianCumulativeDeltaUsd: deltas2.length ? median(deltas2) : NaN,
          n: deltas2.length,
        };
      })
    : [];

  // Quality hold (§4): treatment DECIDED-success rate within 5pp of control's.
  const controlSuccessRate = rate(decidedPairs.map((p) => p.control.armSuccess));
  const injectedSuccessRate = rate(decidedPairs.map((p) => p.injected.armSuccess));
  const qualityHoldPass =
    nDecided === 0 ? false : injectedSuccessRate >= controlSuccessRate - 0.05;

  // #2083 adherence: median stable-file tool touches per chain, by arm, over
  // DECIDED pairs. If injected << control, the treatment is being honored (the
  // null is about the mechanism's payoff, not non-adoption). If injected ≈
  // control, agents ignored the injected reference (the null is confounded).
  const adhControl = nDecided ? median(decidedPairs.map((p) => p.control.medianStableReads)) : NaN;
  const adhInjected = nDecided ? median(decidedPairs.map((p) => p.injected.medianStableReads)) : NaN;

  const decision = decideVerdict({
    pairedMedianPctDelta: medPctDelta,
    ci,
    p: wilcoxon.pOneSided,
    qualityHoldPass,
    nDecided,
  });

  // -------------------------------------------------------------- print summary
  console.log('\n=== PROOF BATCH RESULT ===');
  console.log(`DECIDED pairs: ${nDecided} (need >= ${PRE_REGISTERED_MIN_DECIDED}); excluded: ${excluded.length}; total spend: $${totalSpend.toFixed(4)}`);
  if (excluded.length) {
    for (const e of excluded) {
      console.log(`  EXCLUDED ${e.pair.pairId}: control decided=${e.control.nDecided}/${e.control.nRuns}, injected decided=${e.injected.nDecided}/${e.injected.nRuns} (UNRESOLVED ctl ${e.control.nUnresolved} / inj ${e.injected.nUnresolved})`);
    }
  }
  console.log(`paired-median cost delta: $${fmt(medDelta)} (${fmt(medPctDelta)}%)`);
  console.log(`bootstrap 95% CI: [${fmt(ci.lo)}, ${fmt(ci.hi)}]  (seed=1, iters=10000)`);
  console.log(`Wilcoxon signed-rank: W-=${wilcoxon.statistic}, p(one-sided)=${wilcoxon.pOneSided.toExponential(3)}, n=${wilcoxon.n}`);
  console.log(`quality hold: control success ${(controlSuccessRate * 100).toFixed(0)}% vs injected ${(injectedSuccessRate * 100).toFixed(0)}% -> ${qualityHoldPass ? 'PASS' : 'FAIL'}`);
  console.log(`adherence (stable-file tool touches per chain, median): control ${fmt(adhControl)} vs injected ${fmt(adhInjected)} -> ${Number.isFinite(adhControl) && Number.isFinite(adhInjected) ? (adhInjected < adhControl ? 'treatment touches the file LESS (honored)' : 'treatment touches the file >= control (low adoption / confounded null)') : 'n/a'}`);
  console.log(`latency paired-median delta: ${fmtMs(latMedDelta)} (secondary, not gated)`);
  if (doseResponse.length) {
    console.log('dose-response (cumulative injected-control $ delta by session, SUPPORTING — does not set verdict):');
    for (const d of doseResponse) console.log(`   s${d.session}: $${fmt(d.medianCumulativeDeltaUsd)} (n=${d.n})`);
  }
  console.log(`VERDICT: ${decision.verdict.toUpperCase()}`);
  for (const r of decision.reasons) console.log(`   - ${r}`);

  // -------------------------------------------------------------- build receipt
  // The receipt schema's verdict enum is proven|null|refuted. "not-yet-provable"
  // is an engineering bust (§6), NOT a scientific null — so we do NOT mint a
  // proven/null/refuted receipt for it; we report it and (in a real run) skip
  // the append. For dry-runs we still build + print a representable object using
  // 'null' as the carrier and stating the honest framing in uncertainty/rollout.
  const notProvable = decision.verdict === 'not-yet-provable';
  const receiptVerdict = notProvable ? 'null' : decision.verdict;
  const uncertainty = notProvable
    ? `NOT YET PROVABLE (engineering bust, not a null): only ${nDecided} DECIDED pair(s) < ${PRE_REGISTERED_MIN_DECIDED}. bootstrap CI [${fmt(ci.lo)}, ${fmt(ci.hi)}], Wilcoxon p=${wilcoxon.pOneSided.toExponential(2)}, n=${wilcoxon.n}`
    : `bootstrap CI [${fmt(ci.lo)}, ${fmt(ci.hi)}], Wilcoxon p=${wilcoxon.pOneSided.toExponential(2)} one-sided, n=${wilcoxon.n}, ${nDecided} DECIDED pairs`;

  const rollout = notProvable
    ? `Not yet provable at N=${nDecided}. Run the full 12-pair batch before any prescription: ${decision.reasons.join('; ')}`
    : decision.verdict === 'proven'
      ? `Inject the #890 repo-map stable-reference recommendation into agent context for tasks touching stable/high-centrality files; the matched-pairs batch shows a >=15% per-task cost reduction with no quality loss.`
      : decision.verdict === 'refuted'
        ? `Do NOT inject the #890 recommendation as-is: ${decision.reasons.join('; ')}.`
        : `Effect indistinguishable from null at the powered MDE; do not claim a cost win. ${decision.reasons.join('; ')}`;

  const receipt = {
    schemaVersion: '1',
    kind: 'PROOF',
    experimentRef: `proof-batch/${WASTE_PATTERN}`,
    preRegistrationRef: PREREG_REF,
    observed: {
      wastePattern: WASTE_PATTERN,
      detectorRef: DETECTOR_REF,
      observedUsdPerMo,
    },
    experiment: {
      fixtureSetRef: bundle.bundle,
      design: 'matched-pairs',
      arm: 'injected',
      n: nDecided,
      objectiveGates: pairs.map((p) => `${p.pairId}:${p.gate.kind}:${p.gate.command}`),
    },
    result: {
      effectSize: Number.isFinite(medDelta) ? medDelta : 0,
      uncertainty,
      perDimensionDeltas: {
        costUsd: Number.isFinite(medDelta) ? medDelta : 0,
        costPct: Number.isFinite(medPctDelta) ? medPctDelta : 0,
        latencyMs: Number.isFinite(latMedDelta) ? latMedDelta : 0,
      },
      statistics: {
        nDecided,
        controlSuccessRate,
        injectedSuccessRate,
        qualityHoldPass,
        bootstrap: {
          lo: Number.isFinite(ci.lo) ? ci.lo : null,
          hi: Number.isFinite(ci.hi) ? ci.hi : null,
          iters: ci.iters ?? 10_000,
          alpha: 0.05,
          seed: 1,
        },
        wilcoxon,
      },
      // SUPPORTING readout (#2082): cumulative onset curve, never the verdict.
      ...(doseResponse.length ? { doseResponse } : {}),
      verdict: receiptVerdict,
    },
    projection: {
      reclaimUsdPerMo:
        decision.verdict === 'proven' && Number.isFinite(medPctDelta)
          ? Math.max(0, observedUsdPerMo * (-medPctDelta / 100))
          : 0,
      assumptions: `EXTRAPOLATION from fixtures to history. ${observedAssumption}. Projection = observed $/mo x median %reduction, only on a PROVEN verdict.`,
    },
    rollout: args.qualification ? `${rollout}\n\nExternal-review qualification: ${args.qualification}` : rollout,
    // Empty until the external-review step (#1078) supplies it; the receipt
    // sanitizer refuses to persist a PROOF receipt without a non-empty ref, so
    // the credibility bar is enforced in code.
    externalReviewRef: args.externalReviewRef || '',
    modelVersion: args.model,
    revalidationStatus: 'current',
    evidenceRef,
    evidenceDigest: persistedEvidence.artifactDigest,
  };

  const evidenceVerification = verifyProofReceiptAgainstEvidence(
    receipt,
    evidenceArtifact
  );
  if (!evidenceVerification.ok) {
    throw new Error(
      `proof receipt does not rederive from its evidence: ${evidenceVerification.error}`
    );
  }
  // The receipt now binds the immutable evidence, so disposable trees and
  // credential-only temp homes can be removed without destroying provenance.
  for (const pair of perPair) {
    pair.control.runs.forEach(cleanupScratch);
    pair.injected.runs.forEach(cleanupScratch);
  }

  // -------------------------------------------------------------- emit receipt
  console.log('\n=== PROOF RECEIPT ===');
  console.log(JSON.stringify(receipt, null, 2));

  // Always persist the computed receipt as a draft sidecar so a run's result is
  // never lost even before the external review fills externalReviewRef — the
  // draft is the input to `--finalize` (no re-run needed once reviewed).
  if (!args.dryRun) {
    const draftPath = join(REPO_ROOT, 'data', 'proof-receipt-draft.json');
    try {
      writeFileSync(draftPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      console.log(`\ndraft receipt saved to ${draftPath}`);
    } catch (e) {
      console.error(`could not write draft sidecar: ${e.message}`);
    }
  }

  if (notProvable && !args.dryRun) {
    console.log(`\nNOT writing a receipt: verdict is "not yet provable" (engineering bust, not a scientific null) — see §6. Re-run with >= ${PRE_REGISTERED_MIN_DECIDED} DECIDED pairs.`);
    return;
  }

  if (args.dryRun) {
    writeFileSync(outPath, `${JSON.stringify(receipt)}\n`, 'utf8');
    console.log(`\n[dry-run] receipt written to temp file: ${outPath} (NOT the real receipt log)`);
    if (budgetStopped) console.log('[dry-run] note: batch stopped early on the total-budget cap.');
    return;
  }

  const res = await appendAdoptionReceipt(outPath, receipt);
  if (res.ok && res.written) console.log(`\nreceipt appended to ${outPath}`);
  else if (res.ok && !res.written) console.log('\nreceipt writes disabled by env (ADOPTION_RECEIPTS off).');
  else console.error(`\nfailed to append receipt: ${res.error}`);
}

// ---------------------------------------------------------------- formatting
function fmt(n) {
  if (!Number.isFinite(n)) return 'n/a';
  return Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4);
}
function fmtMs(n) {
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n / 1000).toFixed(1)}s`;
}
function rate(boolArr) {
  if (boolArr.length === 0) return 0;
  return boolArr.filter(Boolean).length / boolArr.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('proof-batch fatal:', err);
    process.exit(1);
  });
}
