/**
 * proof-fixture-pairs.ts — typed schema + sanitizing loader for the v0.4
 * causal-proof fixture bundle (#1076, epic #995). "History prices, fixtures
 * prove": real history prices the #890 repo-map context-waste pattern; this
 * bundle is the *fixtures-prove* half — a frozen, controlled corpus of matched
 * task pairs (same task, control vs recommendation-injected) with deterministic
 * objective gates, pre-registered in `docs/v0.4-proof-preregistration.md`.
 *
 * On-disk source of truth: `fixtures/proof/repo-map-context-waste/manifest.json`
 * plus the committed substrate trees under
 * `fixtures/proof/repo-map-context-waste/pairs/<pairId>/tree/`. This module is
 * pure and deterministic — schema, parser, and the bridge that derives #1080
 * {@link CorpusTask}s (one per arm) so the #975 batch machinery can address the
 * pairs as curated-fixtures corpus tasks without any schema break.
 *
 * Pair-arm pointer convention (additive, taskId-encoded): each pair yields two
 * corpus tasks whose ids are `<pairId>--control` and `<pairId>--injected`. The
 * instruction and gate are IDENTICAL across arms — the only difference is
 * whether the runner injects {@link ProofFixturePair.injectedRecommendation}
 * into the worker's additional context (the binary recs shadow axis, #582).
 * The runner lives in the shadow-calls apparatus, never in this repo.
 */

import {
  parseObjectiveGate,
  type CorpusTask,
  type ObjectiveGate,
} from './model-eval-corpus';

/** The two arms of a matched pair. Control withholds the recommendation;
 *  injected primes it into the worker's additional context. */
export const PROOF_PAIR_ARMS = ['control', 'injected'] as const;
export type ProofPairArm = (typeof PROOF_PAIR_ARMS)[number];

/** Separator between pairId and arm in a derived corpus-task id. PairIds are
 *  single-hyphen kebab-case, so `--` is unambiguous (the parser enforces it). */
export const PAIR_ARM_SEPARATOR = '--';

/**
 * Pre-registered minimum DECIDED-pair N
 * (`docs/v0.4-proof-preregistration.md` § 3). The bundle must carry at least
 * this many pairs or the batch cannot reach the pre-registered N at all.
 */
export const PRE_REGISTERED_MIN_PAIRS = 12;

/** The #890 detector's structural candidate reasons — each pair reproduces
 *  exactly one (`src/lib/detectors/context/repo-map-context-waste.ts`). */
export const WASTE_REASONS = ['stable-api', 'config-backed', 'high-centrality'] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

/** Markers the injected recommendation must carry — the same applied-markers
 *  the #890 detector stamps on its fix snippet, so the #583 eligibility screen
 *  recognizes the injected text as THAT finding (not a paraphrase). */
export const RECOMMENDATION_HEADING = '## Stable reference files';
export const RECOMMENDATION_BODY_PHRASE =
  'Reference these stable files instead of re-reading them';

/** A stable / high-centrality file the pair's recommendation names, with the
 *  exported symbols it cites (detector caps at 3 symbols per file). */
export interface StableFileRef {
  /** Path relative to the pair's substrate tree root. */
  path: string;
  symbols: string[];
}

/**
 * One step of a multi-session chain (#2082). Each step is run as its OWN cold
 * jailed session over the same accumulating tree, so the control arm re-reads
 * the stable file from cold each session while the treatment arm (which carries
 * the recommendation as a persistent `CLAUDE.md`) can cite the symbols instead.
 * This is what exhibits the CROSS-SESSION re-read waste the #890 detector prices
 * — the single-session v0.4 fixtures structurally could not (see the v0.4 NULL,
 * #1078). The step `instruction` obeys the same anti-gaming constraints as a
 * single-session instruction: it must genuinely need the stable file and be
 * solvable given its symbols, and must NOT quote the file's contents.
 */
export interface ChainStep {
  instruction: string;
}

/** One matched task pair: a single task definition runnable two ways. */
export interface ProofFixturePair {
  /** Stable, unique, single-hyphen kebab-case id (never contains `--`). */
  pairId: string;
  title: string;
  /** Task-shape family (bugfix, implement-feature, codemod-rename, ...) —
   *  pairs vary by shape so the effect is not an artifact of one template. */
  taskShape: string;
  /** Which #890 structural candidate reason this pair reproduces. */
  wasteReason: WasteReason;
  /** The prompt the runner issues — identical across both arms. For a
   *  multi-session pair this is the human-facing summary of the chain; the
   *  per-session prompts come from {@link chain}. */
  instruction: string;
  /**
   * Multi-session chain (#2082): an ordered list of per-session tasks, each run
   * as its own cold jailed session over the accumulating tree. When present, the
   * runner executes one session per step (instead of one session for
   * `instruction`); cost is summed across the chain and Gate 0 runs on the final
   * tree. Absent for legacy single-session pairs. Both arms run the IDENTICAL
   * chain — the only difference is the treatment `CLAUDE.md` (anti-gaming
   * constraint 1).
   */
  chain?: ChainStep[];
  /** Substrate tree dir, relative to the bundle root. Gate commands run with
   *  this directory as cwd. */
  tree: string;
  /** The stable files the recommendation names (must exist in the tree). */
  stableFiles: StableFileRef[];
  /** The #890-style recommendation text the injected arm receives. */
  injectedRecommendation: string;
  /** Deterministic objective gate — Gate 0 of the pre-registration. */
  gate: ObjectiveGate;
  tags: string[];
}

/** The whole frozen bundle as committed in `manifest.json`. */
export interface ProofPairBundle {
  bundle: string;
  /** Repo-relative path of the pre-registration this bundle satisfies. */
  preRegistrationRef: string;
  /** Repo-relative path of the treatment detector (#890). */
  detectorRef: string;
  /** Pre-registered minimum DECIDED-pair N this bundle is sized for. */
  minDecidedPairs: number;
  /**
   * Pre-registered sessions per chain (#2082). When set, the bundle is a
   * multi-session bundle and every pair must carry a {@link ProofFixturePair.chain}
   * of exactly this length. Absent for a legacy single-session bundle.
   */
  sessionsPerChain?: number;
  pairs: ProofFixturePair[];
}

const MAX_ID_LEN = 60;
const MAX_TEXT_LEN = 600;
/** Multi-session chain bounds (#2082). A chain must be genuinely multi-session
 *  (>= 2) to exhibit cross-session re-read; the upper bound is a sanity cap. */
const MIN_CHAIN_STEPS = 2;
const MAX_CHAIN_STEPS = 12;
/** Pre-registered sessions-per-chain for the v2 multi-session bundle (#2082,
 *  amendment to `docs/v0.4-proof-preregistration.md`). */
export const PRE_REGISTERED_SESSIONS_PER_CHAIN = 8;
const MAX_RECOMMENDATION_LEN = 2000;
const MAX_STABLE_FILES = 5;
const MAX_SYMBOLS_PER_FILE = 3;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 40;

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function parseStableFileRef(raw: unknown): StableFileRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const path = cleanString(r.path, MAX_TEXT_LEN);
  if (!path || path.startsWith('/') || path.includes('..')) return null;
  const symbols: string[] = [];
  if (Array.isArray(r.symbols)) {
    for (const s of r.symbols) {
      const sym = cleanString(s, MAX_TAG_LEN);
      if (sym && !symbols.includes(sym)) symbols.push(sym);
      if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    }
  }
  return { path, symbols };
}

/**
 * Parse a multi-session chain. Returns `undefined` when no chain key is present
 * (a legacy single-session pair), or `null` when a chain key IS present but
 * malformed — so the caller rejects the pair rather than silently degrading a
 * multi-session fixture to single-session (which would reproduce the v0.4 NULL).
 */
function parseChain(raw: unknown): ChainStep[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  if (raw.length < MIN_CHAIN_STEPS || raw.length > MAX_CHAIN_STEPS) return null;
  const steps: ChainStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const instruction = cleanString((item as Record<string, unknown>).instruction, MAX_TEXT_LEN);
    if (!instruction) return null;
    steps.push({ instruction });
  }
  return steps;
}

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = cleanString(t, MAX_TAG_LEN);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Parse one raw object into a {@link ProofFixturePair}, or null if it fails
 * validation. Pure and total — never throws on malformed input. The pairId is
 * rejected if it contains the arm separator, so derived corpus-task ids stay
 * unambiguous.
 */
export function parseProofPair(raw: unknown): ProofFixturePair | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pairId = cleanString(r.pairId, MAX_ID_LEN);
  if (!pairId || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pairId)) return null;
  if (pairId.includes(PAIR_ARM_SEPARATOR)) return null;
  const title = cleanString(r.title, MAX_TEXT_LEN);
  const taskShape = cleanString(r.taskShape, MAX_TAG_LEN);
  const wasteReason = r.wasteReason;
  if (
    typeof wasteReason !== 'string' ||
    !WASTE_REASONS.includes(wasteReason as WasteReason)
  ) {
    return null;
  }
  const instruction = cleanString(r.instruction, MAX_TEXT_LEN);
  const tree = cleanString(r.tree, MAX_TEXT_LEN);
  if (!title || !taskShape || !instruction || !tree) return null;
  if (tree.startsWith('/') || tree.includes('..')) return null;
  const injectedRecommendation = cleanString(
    r.injectedRecommendation,
    MAX_RECOMMENDATION_LEN
  );
  if (
    !injectedRecommendation ||
    !injectedRecommendation.startsWith(RECOMMENDATION_HEADING) ||
    !injectedRecommendation.includes(RECOMMENDATION_BODY_PHRASE)
  ) {
    return null;
  }
  const gate = parseObjectiveGate(r.gate);
  if (!gate) return null;
  const chain = parseChain(r.chain);
  if (chain === null) return null; // chain key present but malformed -> reject
  const stableFiles: StableFileRef[] = [];
  if (Array.isArray(r.stableFiles)) {
    for (const f of r.stableFiles) {
      const ref = parseStableFileRef(f);
      if (ref && !stableFiles.some((s) => s.path === ref.path)) stableFiles.push(ref);
      if (stableFiles.length >= MAX_STABLE_FILES) break;
    }
  }
  if (stableFiles.length === 0) return null;
  // Every stable file the pair claims must be cited by the injected text,
  // in the detector's own `- @<path>` snippet form.
  for (const f of stableFiles) {
    if (!injectedRecommendation.includes(`@${f.path}`)) return null;
  }
  return {
    pairId,
    title,
    taskShape,
    wasteReason: wasteReason as WasteReason,
    instruction,
    ...(chain ? { chain } : {}),
    tree,
    stableFiles,
    injectedRecommendation,
    gate,
    tags: parseTags(r.tags),
  };
}

/**
 * Parse + validate a raw bundle (the `manifest.json` shape), dropping
 * malformed pairs and de-duplicating by pairId (first wins). Deterministic:
 * same input → same output, in input order. Returns null only when the
 * top-level envelope itself is malformed.
 */
export function parseProofPairBundle(raw: unknown): ProofPairBundle | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const bundle = cleanString(r.bundle, MAX_ID_LEN);
  const preRegistrationRef = cleanString(r.preRegistrationRef, MAX_TEXT_LEN);
  const detectorRef = cleanString(r.detectorRef, MAX_TEXT_LEN);
  if (!bundle || !preRegistrationRef || !detectorRef) return null;
  const minDecidedPairs =
    typeof r.minDecidedPairs === 'number' &&
    Number.isInteger(r.minDecidedPairs) &&
    r.minDecidedPairs > 0
      ? r.minDecidedPairs
      : PRE_REGISTERED_MIN_PAIRS;
  const sessionsPerChain =
    typeof r.sessionsPerChain === 'number' &&
    Number.isInteger(r.sessionsPerChain) &&
    r.sessionsPerChain >= MIN_CHAIN_STEPS &&
    r.sessionsPerChain <= MAX_CHAIN_STEPS
      ? r.sessionsPerChain
      : undefined;
  const pairs: ProofFixturePair[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.pairs)) {
    for (const item of r.pairs) {
      const pair = parseProofPair(item);
      if (!pair || seen.has(pair.pairId)) continue;
      seen.add(pair.pairId);
      pairs.push(pair);
    }
  }
  return {
    bundle,
    preRegistrationRef,
    detectorRef,
    minDecidedPairs,
    ...(sessionsPerChain ? { sessionsPerChain } : {}),
    pairs,
  };
}

/**
 * The ordered per-session instructions the runner executes for a pair: the
 * chain steps for a multi-session pair, or the single `instruction` for a
 * legacy single-session pair. Always non-empty.
 */
export function chainSteps(pair: ProofFixturePair): string[] {
  return pair.chain && pair.chain.length > 0
    ? pair.chain.map((s) => s.instruction)
    : [pair.instruction];
}

/** Derived corpus-task id for one arm of a pair. */
export function armTaskId(pairId: string, arm: ProofPairArm): string {
  return `${pairId}${PAIR_ARM_SEPARATOR}${arm}`;
}

/** Invert {@link armTaskId}: split a derived corpus-task id back into
 *  (pairId, arm), or null when the id does not follow the convention. */
export function parseArmTaskId(
  taskId: string
): { pairId: string; arm: ProofPairArm } | null {
  for (const arm of PROOF_PAIR_ARMS) {
    const suffix = `${PAIR_ARM_SEPARATOR}${arm}`;
    if (taskId.endsWith(suffix)) {
      const pairId = taskId.slice(0, -suffix.length);
      if (pairId && !pairId.includes(PAIR_ARM_SEPARATOR)) return { pairId, arm };
    }
  }
  return null;
}

/**
 * Bridge one pair into the #1080 corpus schema: two {@link CorpusTask}s, one
 * per arm, identical instruction + gate, arm encoded in the taskId and tags.
 * Purely additive — the existing corpus schema is consumed, never changed.
 */
export function pairToCorpusTasks(pair: ProofFixturePair): CorpusTask[] {
  return PROOF_PAIR_ARMS.map((arm) => ({
    id: armTaskId(pair.pairId, arm),
    title: `${pair.title} [${arm}]`,
    instruction: pair.instruction,
    gate: { ...pair.gate },
    tags: [
      'proof-pair',
      `arm:${arm}`,
      pair.wasteReason,
      pair.taskShape,
      ...pair.tags.filter((t) => t !== pair.wasteReason && t !== pair.taskShape),
    ],
  }));
}

/** Flatten a bundle into the corpus-task view the #975 batch machinery
 *  addresses (2 tasks per pair, deterministic order). */
export function bundleToCorpusTasks(bundle: ProofPairBundle): CorpusTask[] {
  return bundle.pairs.flatMap(pairToCorpusTasks);
}

/**
 * Validate a parsed bundle against the pre-registration's fixture-set
 * requirements. Returns every violation, never throws.
 */
export function validateProofPairBundle(bundle: ProofPairBundle): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const minPairs = Math.max(bundle.minDecidedPairs, PRE_REGISTERED_MIN_PAIRS);
  if (bundle.pairs.length < minPairs) {
    errors.push(
      `bundle carries ${bundle.pairs.length} pair(s); the pre-registration requires >= ${minPairs}`
    );
  }
  // Deep round-trip: re-parsing the bundle must reproduce it byte-for-byte.
  // A length-only comparison would let silent re-trimming or per-field
  // normalization pass undetected.
  const reparsed = parseProofPairBundle(bundle);
  if (!reparsed || JSON.stringify(reparsed) !== JSON.stringify(bundle)) {
    errors.push('bundle does not round-trip through the parser unchanged');
  }
  const ids = new Set<string>();
  for (const pair of bundle.pairs) {
    if (ids.has(pair.pairId)) errors.push(`duplicate pairId: ${pair.pairId}`);
    ids.add(pair.pairId);
  }
  const reasons = new Set(bundle.pairs.map((p) => p.wasteReason));
  for (const reason of WASTE_REASONS) {
    if (!reasons.has(reason)) {
      errors.push(`no pair reproduces the '${reason}' waste reason`);
    }
  }
  // Multi-session bundle (#2082): every pair must carry a chain of exactly the
  // pre-registered length, so the cross-session re-read effect is uniform and a
  // single-session pair cannot silently dilute the batch back toward the v0.4 NULL.
  if (bundle.sessionsPerChain !== undefined) {
    for (const pair of bundle.pairs) {
      const len = pair.chain?.length ?? 0;
      if (len !== bundle.sessionsPerChain) {
        errors.push(
          `pair ${pair.pairId} has a ${len}-step chain; the multi-session bundle requires exactly ${bundle.sessionsPerChain}`
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
