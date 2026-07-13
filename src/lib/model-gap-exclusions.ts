/**
 * model-gap-exclusions.ts — exclusion classifiers for human/process causes
 * (#1082, epic #975, Unit 5). Consumes the gap candidates surfaced by the
 * hindsight miner (`model-gap-mining.ts`) and decides, per run, whether its
 * expensive/slow/failing shape is a genuine MODEL-ROUTING gap or one of the
 * six human/process noise classes the epic names:
 *
 *   1. human-waiting              — wall-clock dominated by idle gaps between
 *                                   entries (a human stepped away), so the
 *                                   duration/cost signal is confounded.
 *   2. exploration-design-debate  — a discussion-shaped session (many user
 *                                   turns, nothing mutated), intentionally
 *                                   long, not a struggling model.
 *   3. external-blocker           — the failure signal is dominated by
 *                                   rate-limit / overload / connection API
 *                                   errors, i.e. the provider or network, not
 *                                   the model's competence.
 *   4. requirement-churn          — the user repeatedly redirected the task
 *                                   ("actually… instead…"), so rework cost is
 *                                   user-driven, not model-driven.
 *   5. harness-overhead           — spend is almost entirely cache re-reads
 *                                   with negligible model output: context /
 *                                   workflow overhead, not model work.
 *   6. baseline-build-test-failure — the tool errors match build/test commands
 *                                   the caller knows fail on the baseline
 *                                   anyway, so they indict the repo, not the
 *                                   model.
 *
 * Standing rule 5 (auditable survivors): EVERY run — kept or filtered — gets a
 * reason string sized to fit the committed eval-result schema's exclusion
 * sanitizer, so the kept/filtered explanation survives a round-trip through
 * `sanitizeModelEvalResult`. Classification is pure and deterministic over
 * already-parsed dashboard data; nothing here calls a live API (rule 7).
 */

import type { SessionTokenData } from '../types';
import type { SessionTimeline } from './parse-timeline';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';
import type { ModelGapCandidate } from './model-gap-mining';
import type { EvalExclusion, ExclusionDisposition } from './model-eval-result';

export const GAP_NOISE_CLASSES = [
  'human-waiting',
  'exploration-design-debate',
  'external-blocker',
  'requirement-churn',
  'harness-overhead',
  'baseline-build-test-failure',
] as const;
export type GapNoiseClass = (typeof GAP_NOISE_CLASSES)[number];

/** Per-run observable signals the six classifiers decide on. */
export interface GapExclusionSignals {
  runId: string;
  /**
   * Noise classes whose required source data was actually available. Omitted
   * means all classes are evaluable (keeps direct classifier callers simple);
   * the dataset adapter always supplies the precise subset.
   */
  evaluatedNoiseClasses?: GapNoiseClass[];
  durationMs: number;
  /** Sum of inter-entry gaps >= IDLE_GAP_MS (human absence proxy). */
  idleMs: number;
  userTurns: number;
  toolCalls: number;
  /** Calls to tools that mutate state (Edit/Write/Bash/…). */
  mutatingToolCalls: number;
  toolErrors: number;
  /** Tool errors whose command matches a known baseline build/test failure. */
  baselineFailureToolErrors: number;
  apiErrors: number;
  /** API errors attributable to rate limits / overload / connection causes. */
  externalApiErrors: number;
  /** User turns whose text matches the requirement-churn lexicon. */
  churnMarkers: number;
  totalTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface GapExclusionVerdict {
  runId: string;
  disposition: ExclusionDisposition;
  /** Noise classes that fired (empty when kept). */
  noiseClasses: GapNoiseClass[];
  /** Auditable explanation; fits the eval-result exclusion sanitizer. */
  reason: string;
}

// --- Thresholds (named so tests and audits can reference them) -------------

/** A gap between consecutive timeline entries counts as idle past this. */
export const IDLE_GAP_MS = 5 * 60 * 1000;
/** human-waiting: idle share of wall-clock at/above this fraction… */
export const HUMAN_WAITING_IDLE_SHARE = 0.5;
/** …on a run at least this long (short runs can't establish "waiting"). */
export const HUMAN_WAITING_MIN_DURATION_MS = 10 * 60 * 1000;
/** exploration: at least this many user turns with zero mutating calls. */
export const EXPLORATION_MIN_USER_TURNS = 5;
/** external-blocker: at least this many external API errors… */
export const EXTERNAL_BLOCKER_MIN_ERRORS = 2;
/** requirement-churn: at least this many direction-changing user turns. */
export const CHURN_MIN_MARKERS = 2;
/** harness-overhead: cache reads at/above this share of all tokens… */
export const HARNESS_OVERHEAD_CACHE_SHARE = 0.98;
/** …with output at/below this share, on a run of at least this many tokens. */
export const HARNESS_OVERHEAD_MAX_OUTPUT_SHARE = 0.005;
export const HARNESS_OVERHEAD_MIN_TOKENS = 100_000;

/** Matches the eval-result sanitizer's MAX_TEXT_LEN so reasons survive it. */
const MAX_REASON_LEN = 480;

/** User-turn phrasings that signal a requirement redirect, not model rework. */
const CHURN_LEXICON =
  /\b(actually,?\s|instead\b|scratch that|never\s?mind|forget (that|it)\b|change of plans|let's not\b|undo that|go back to\b|on second thought)\b/i;

/** Tools whose calls mutate state — their absence marks a discussion session. */
const MUTATING_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
]);

/** API-error shapes that indict the provider/network, not the model. */
function isExternalApiError(e: ApiErrorEvent): boolean {
  if (e.status === 429 || e.status === 529 || (e.status !== undefined && e.status >= 500)) {
    return true;
  }
  if (e.causeCode) return true; // connection-level cause (ECONNREFUSED, …)
  return /rate.?limit|overload|connection|timed?\s?out|ECONN|ETIMEDOUT/i.test(
    e.summary
  );
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

interface ClassFinding {
  noiseClass: GapNoiseClass;
  detail: string;
}

/** Run the six classifiers; returns the classes that fired with evidence. */
function detectNoise(s: GapExclusionSignals): ClassFinding[] {
  const findings: ClassFinding[] = [];
  const evaluated = new Set(s.evaluatedNoiseClasses ?? GAP_NOISE_CLASSES);

  const idleShare = s.durationMs > 0 ? s.idleMs / s.durationMs : 0;
  if (
    evaluated.has('human-waiting') &&
    s.durationMs >= HUMAN_WAITING_MIN_DURATION_MS &&
    idleShare >= HUMAN_WAITING_IDLE_SHARE
  ) {
    findings.push({
      noiseClass: 'human-waiting',
      detail: `idle ${pct(idleShare)} of ${Math.round(s.durationMs / 60000)}min wall-clock`,
    });
  }

  if (
    evaluated.has('exploration-design-debate') &&
    s.userTurns >= EXPLORATION_MIN_USER_TURNS &&
    s.mutatingToolCalls === 0 &&
    s.toolCalls <= s.userTurns
  ) {
    findings.push({
      noiseClass: 'exploration-design-debate',
      detail: `${s.userTurns} user turns, 0 mutating tool calls`,
    });
  }

  const failureSignals = s.apiErrors + s.toolErrors;
  if (
    evaluated.has('external-blocker') &&
    s.externalApiErrors >= EXTERNAL_BLOCKER_MIN_ERRORS &&
    s.externalApiErrors * 2 >= failureSignals
  ) {
    findings.push({
      noiseClass: 'external-blocker',
      detail: `${s.externalApiErrors}/${s.apiErrors} API errors are rate-limit/overload/connection`,
    });
  }

  if (
    evaluated.has('requirement-churn') &&
    s.churnMarkers >= CHURN_MIN_MARKERS
  ) {
    findings.push({
      noiseClass: 'requirement-churn',
      detail: `${s.churnMarkers} direction-changing user turns`,
    });
  }

  if (
    evaluated.has('harness-overhead') &&
    s.totalTokens >= HARNESS_OVERHEAD_MIN_TOKENS
  ) {
    const cacheShare = s.cacheReadTokens / s.totalTokens;
    const outputShare = s.outputTokens / s.totalTokens;
    if (
      cacheShare >= HARNESS_OVERHEAD_CACHE_SHARE &&
      outputShare <= HARNESS_OVERHEAD_MAX_OUTPUT_SHARE
    ) {
      findings.push({
        noiseClass: 'harness-overhead',
        detail: `cache reads ${pct(cacheShare)} of tokens, output ${pct(outputShare)}`,
      });
    }
  }

  if (
    evaluated.has('baseline-build-test-failure') &&
    s.baselineFailureToolErrors > 0 &&
    s.baselineFailureToolErrors * 2 >= s.toolErrors
  ) {
    findings.push({
      noiseClass: 'baseline-build-test-failure',
      detail: `${s.baselineFailureToolErrors}/${s.toolErrors} tool errors match known baseline build/test failures`,
    });
  }

  return findings;
}

/** Verdict used when no noise class has enough observable data to evaluate. */
const NO_SIGNALS_REASON =
  'kept: no exclusion signals available for this run — noise classes could not be evaluated; audit manually';

function evaluatedClasses(s: GapExclusionSignals): GapNoiseClass[] {
  const supplied = s.evaluatedNoiseClasses;
  return supplied === undefined
    ? [...GAP_NOISE_CLASSES]
    : GAP_NOISE_CLASSES.filter((noiseClass) => supplied.includes(noiseClass));
}

function coverageSuffix(evaluated: GapNoiseClass[]): string {
  if (evaluated.length === GAP_NOISE_CLASSES.length) return '';
  const unavailable = GAP_NOISE_CLASSES.filter(
    (noiseClass) => !evaluated.includes(noiseClass)
  );
  return (
    `; evaluated ${evaluated.length}/${GAP_NOISE_CLASSES.length} classes` +
    ` (${evaluated.join(', ') || 'none'})` +
    `; not evaluated: ${unavailable.join(', ') || 'none'}`
  );
}

/**
 * Classify one run. Filtered when any noise class fires; kept otherwise. The
 * reason is always populated and bounded so it survives the eval-result
 * exclusion sanitizer verbatim (rule 5).
 */
export function classifyGapExclusion(
  signals: GapExclusionSignals
): GapExclusionVerdict {
  const evaluated = evaluatedClasses(signals);
  if (evaluated.length === 0) {
    return {
      runId: signals.runId,
      disposition: 'kept',
      noiseClasses: [],
      reason: NO_SIGNALS_REASON,
    };
  }
  const findings = detectNoise(signals);
  if (findings.length > 0) {
    const reason =
      findings.map((f) => `${f.noiseClass}: ${f.detail}`).join('; ') +
      coverageSuffix(evaluated);
    return {
      runId: signals.runId,
      disposition: 'filtered',
      noiseClasses: findings.map((f) => f.noiseClass),
      reason: reason.slice(0, MAX_REASON_LEN),
    };
  }
  const keptReason =
    evaluated.length === GAP_NOISE_CLASSES.length
      ? `kept: no human/process noise detected across ${GAP_NOISE_CLASSES.length} classes ` +
        `(${signals.userTurns} user turns, ${signals.toolCalls} tool calls, ` +
        `${signals.apiErrors} API errors, idle ${Math.round(signals.idleMs / 1000)}s)`
      : `kept: no human/process noise detected in the available signals` +
        coverageSuffix(evaluated) +
        '; audit the unevaluated classes manually';
  return {
    runId: signals.runId,
    disposition: 'kept',
    noiseClasses: [],
    reason: keptReason.slice(0, MAX_REASON_LEN),
  };
}

/**
 * Classify every gap candidate against its run's signals. Every candidate gets
 * exactly one verdict; a candidate with no matching signals is KEPT (filtering
 * needs positive evidence) with a reason saying the checks could not run.
 */
export function classifyGapExclusions(
  candidates: ModelGapCandidate[],
  signals: GapExclusionSignals[]
): GapExclusionVerdict[] {
  const byRun = new Map(signals.map((s) => [s.runId, s]));
  return candidates.map((c) => {
    const s = byRun.get(c.runId);
    if (!s) {
      return {
        runId: c.runId,
        disposition: 'kept' as const,
        noiseClasses: [],
        reason: NO_SIGNALS_REASON,
      };
    }
    return classifyGapExclusion(s);
  });
}

export interface PartitionedGapCandidates {
  /** Candidates that survived filtering, in their incoming (ranked) order. */
  kept: ModelGapCandidate[];
  /** One schema-shaped exclusion record per candidate, kept AND filtered. */
  exclusions: EvalExclusion[];
}

/**
 * Convenience for the downstream units (clustering #1083, batch generation
 * #1084): split candidates into survivors + the full audit trail, already in
 * the committed eval-result schema's `exclusions` shape.
 */
export function partitionGapCandidates(
  candidates: ModelGapCandidate[],
  signals: GapExclusionSignals[]
): PartitionedGapCandidates {
  const verdicts = classifyGapExclusions(candidates, signals);
  const verdictByRun = new Map(verdicts.map((v) => [v.runId, v]));
  return {
    kept: candidates.filter(
      (c) => verdictByRun.get(c.runId)?.disposition === 'kept'
    ),
    exclusions: verdicts.map(({ runId, disposition, reason }) => ({
      runId,
      disposition,
      reason,
    })),
  };
}

// --- Signal building from parsed dashboard data -----------------------------

export interface GapExclusionDatasetInput {
  tokenData: SessionTokenData[];
  timelines?: SessionTimeline[];
  toolData?: ToolUsageData[];
  apiErrors?: ApiErrorEvent[];
  /**
   * Substring patterns (case-insensitive) of build/test commands known to fail
   * on the baseline (e.g. a `npm run build` broken on master). A tool error
   * whose Bash command matches one is attributed to the repo, not the model.
   */
  knownBaselineFailures?: string[];
}

function idleMsOf(tl: SessionTimeline | undefined): number {
  if (!tl || tl.entries.length < 2) return 0;
  let idle = 0;
  let prev = Date.parse(tl.entries[0].timestamp);
  for (let i = 1; i < tl.entries.length; i++) {
    const t = Date.parse(tl.entries[i].timestamp);
    if (Number.isFinite(prev) && Number.isFinite(t) && t - prev >= IDLE_GAP_MS) {
      idle += t - prev;
    }
    if (Number.isFinite(t)) prev = t;
  }
  return idle;
}

function durationMsOf(tl: SessionTimeline | undefined): number {
  if (!tl) return 0;
  const start = Date.parse(tl.startTime);
  const end = Date.parse(tl.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return end - start;
}

/**
 * Build per-run signals from the dashboard's existing parsed data — same
 * inputs as the miner's dataset builder, no new parsing. On slim timelines
 * (#1035: `summary` stripped from the bulk dataset) churn markers read 0; the
 * other five classes don't need entry text.
 */
export function buildGapExclusionSignals(
  input: GapExclusionDatasetInput
): GapExclusionSignals[] {
  const timelineById = new Map(
    (input.timelines ?? []).map((t) => [t.sessionId, t])
  );
  const toolById = new Map((input.toolData ?? []).map((t) => [t.sessionId, t]));
  const apiErrorsBySession = new Map<string, ApiErrorEvent[]>();
  for (const e of input.apiErrors ?? []) {
    const list = apiErrorsBySession.get(e.sessionId);
    if (list) list.push(e);
    else apiErrorsBySession.set(e.sessionId, [e]);
  }
  const baselinePatterns = (input.knownBaselineFailures ?? []).map((p) =>
    p.toLowerCase()
  );

  return input.tokenData.map((sd) => {
    let totalTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    for (const e of sd.entries) {
      totalTokens +=
        e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
      cacheReadTokens += e.cacheReadTokens;
      outputTokens += e.outputTokens;
    }

    const tl = timelineById.get(sd.sessionId);
    const userEntries = (tl?.entries ?? []).filter((e) => e.kind === 'user');
    const churnMarkers = userEntries.filter(
      (e) => e.summary !== undefined && CHURN_LEXICON.test(e.summary)
    ).length;

    const calls = toolById.get(sd.sessionId)?.calls ?? [];
    const errorCalls = calls.filter((c) => c.isError === true);
    const baselineFailureToolErrors =
      baselinePatterns.length === 0
        ? 0
        : errorCalls.filter((c) => {
            const cmd = c.input.command?.toLowerCase();
            return (
              cmd !== undefined &&
              baselinePatterns.some((p) => cmd.includes(p))
            );
          }).length;

    const sessionApiErrors = apiErrorsBySession.get(sd.sessionId) ?? [];
    const evaluatedSet = new Set<GapNoiseClass>(['harness-overhead']);
    if (tl) evaluatedSet.add('human-waiting');
    if (tl && input.toolData !== undefined) {
      evaluatedSet.add('exploration-design-debate');
    }
    if (input.apiErrors !== undefined) {
      evaluatedSet.add('external-blocker');
    }
    if (tl && !tl.slim) evaluatedSet.add('requirement-churn');
    if (baselinePatterns.length > 0 && input.toolData !== undefined) {
      evaluatedSet.add('baseline-build-test-failure');
    }
    const evaluatedNoiseClasses = GAP_NOISE_CLASSES.filter((noiseClass) =>
      evaluatedSet.has(noiseClass)
    );

    return {
      runId: sd.sessionId,
      evaluatedNoiseClasses,
      durationMs: durationMsOf(tl),
      idleMs: idleMsOf(tl),
      userTurns: userEntries.length,
      toolCalls: calls.length,
      mutatingToolCalls: calls.filter((c) => MUTATING_TOOLS.has(c.toolName))
        .length,
      toolErrors: errorCalls.length,
      baselineFailureToolErrors,
      apiErrors: sessionApiErrors.length,
      externalApiErrors: sessionApiErrors.filter(isExternalApiError).length,
      churnMarkers,
      totalTokens,
      cacheReadTokens,
      outputTokens,
    };
  });
}
