/**
 * model-gap-mining.ts — hindsight gap-mining over existing dashboard data
 * (#1081, epic #975, Unit 2). Surfaces the expensive, least-efficient, longest,
 * and failing runs as model-routing GAP CANDIDATES, expressed in the committed
 * eval-result schema's evidence vocabulary (`model-eval-result.ts`).
 *
 * This is DISCOVERY only — it answers "which past runs are worth eval-ing on a
 * different model", not "which model is better". Per the epic's standing rule 4,
 * cost/token data may RANK candidates but is never a quality label: every
 * cost/token/duration observation is emitted at the weakest evidence strength
 * (`token-cost-discovery`); only objective failure counts rise to
 * `proxy-detector-signal`. No `quality` score is ever derived here, and nothing
 * calls a live API.
 *
 * Two gap directions, framed by the observed model family:
 *   - haiku->sonnet: a small-model run that STRUGGLED (failures / inefficiency)
 *     — "where small models struggle".
 *   - sonnet->opus: an EXPENSIVE / long run on a mid/large model — "expensive
 *     uncertainty" worth testing a stronger model against.
 */

import type { SessionTokenData, TokenEntry } from '../types';
import type { SessionTimeline } from './parse-timeline';
import type { ToolUsageData } from './parse-tools';
import type { ApiErrorEvent } from './parse-errors';
import { resolveModelFamily, type ModelFamily } from './model-registry';
import { entryCostAtModel } from './pricing';
import type { EvalGapEvidence } from './model-eval-result';

export type GapDirection = 'haiku->sonnet' | 'sonnet->opus';

/** One run reduced to the hindsight signals the miner ranks on. */
export interface GapMiningRun {
  runId: string;
  modelId: string;
  family: ModelFamily;
  /** Token-derived cost proxy in USD (discovery only — never a quality label). */
  costProxyUsd: number;
  totalTokens: number;
  durationMs: number;
  /** User turns (the forward-progress denominator for the inefficiency proxy). */
  turns: number;
  toolCalls: number;
  toolErrors: number;
  apiErrors: number;
}

/** A ranked routing gap candidate, carrying strength-labeled evidence. */
export interface ModelGapCandidate {
  runId: string;
  modelId: string;
  direction: GapDirection;
  /**
   * Discovery rank in [0, 1], blended from cost / inefficiency / duration /
   * failure with family-appropriate emphasis. This is a DISCOVERY rank, NOT a
   * quality score — it only orders which runs are worth eval-ing (rule 4).
   */
  discoveryScore: number;
  evidence: EvalGapEvidence[];
}

export interface MineModelGapsOptions {
  /** Cap on returned candidates (ranked desc). Default 50. */
  maxCandidates?: number;
}

/** Direction implied by the observed model family. */
function directionFor(family: ModelFamily): GapDirection {
  return family === 'haiku' ? 'haiku->sonnet' : 'sonnet->opus';
}

/** Share-of-max normaliser: v/max in [0, 1], 0 when max is 0. Keeps a single
 *  run's own max signals at 1 (min-max would collapse a one-run set to 0). */
function shareOfMax(value: number, max: number): number {
  return max > 0 ? value / max : 0;
}

function tokensPerTurn(run: GapMiningRun): number {
  return run.totalTokens / Math.max(1, run.turns);
}

function failureCount(run: GapMiningRun): number {
  return run.toolErrors + run.apiErrors;
}

/**
 * Rank runs into gap candidates. Pure: depends only on its argument.
 *
 * A run is a candidate when it shows at least one non-zero hindsight signal
 * (cost, duration, inefficiency, or failure) — calm runs are dropped. The blend
 * weights differ by direction so the two gap types reflect their framing:
 *   haiku->sonnet leans on failure + inefficiency (small model struggling);
 *   sonnet->opus leans on cost + duration (expensive uncertainty).
 */
export function mineModelGaps(
  runs: GapMiningRun[],
  options: MineModelGapsOptions = {}
): ModelGapCandidate[] {
  const maxCandidates = options.maxCandidates ?? 50;
  if (runs.length === 0) return [];

  // Per-signal maxima for share-of-max normalisation across the run set.
  const maxCost = Math.max(...runs.map((r) => r.costProxyUsd), 0);
  const maxDuration = Math.max(...runs.map((r) => r.durationMs), 0);
  const maxIneff = Math.max(...runs.map((r) => tokensPerTurn(r)), 0);
  const maxFailure = Math.max(...runs.map((r) => failureCount(r)), 0);

  const candidates: ModelGapCandidate[] = [];
  for (const run of runs) {
    const cost = shareOfMax(run.costProxyUsd, maxCost);
    const duration = shareOfMax(run.durationMs, maxDuration);
    const ineff = shareOfMax(tokensPerTurn(run), maxIneff);
    const failure = shareOfMax(failureCount(run), maxFailure);

    // Drop calm runs with no signal at all.
    if (run.costProxyUsd <= 0 && run.durationMs <= 0 && failureCount(run) <= 0) {
      continue;
    }

    const direction = directionFor(run.family);
    const discoveryScore =
      direction === 'haiku->sonnet'
        ? 0.5 * failure + 0.3 * ineff + 0.2 * cost
        : 0.5 * cost + 0.3 * duration + 0.2 * ineff;

    const evidence: EvalGapEvidence[] = [];
    // Cost / duration / inefficiency are token-cost discovery (rule 4: weakest).
    if (run.costProxyUsd > 0) {
      evidence.push({
        strength: 'token-cost-discovery',
        detail: `run cost proxy ~$${run.costProxyUsd.toFixed(2)} over ${run.totalTokens} tokens`,
        delta: run.costProxyUsd,
      });
    }
    if (run.durationMs > 0) {
      evidence.push({
        strength: 'token-cost-discovery',
        detail: `wall-clock ${(run.durationMs / 1000).toFixed(0)}s across ${run.turns} turn(s)`,
        delta: run.durationMs / 1000,
      });
    }
    if (run.turns > 0 && run.totalTokens > 0) {
      evidence.push({
        strength: 'token-cost-discovery',
        detail: `~${Math.round(tokensPerTurn(run))} tokens/turn (inefficiency proxy)`,
        delta: tokensPerTurn(run),
      });
    }
    // Objective failure counts are a proxy-detector signal — stronger than
    // token/cost, but still not a controlled verdict.
    if (failureCount(run) > 0) {
      evidence.push({
        strength: 'proxy-detector-signal',
        detail: `${run.toolErrors} tool error(s) + ${run.apiErrors} API error(s) on this run`,
        delta: failureCount(run),
      });
    }

    candidates.push({
      runId: run.runId,
      modelId: run.modelId,
      direction,
      discoveryScore,
      evidence,
    });
  }

  return candidates
    .sort((a, b) => b.discoveryScore - a.discoveryScore)
    .slice(0, maxCandidates);
}

export interface GapMiningDatasetInput {
  tokenData: SessionTokenData[];
  timelines?: SessionTimeline[];
  toolData?: ToolUsageData[];
  apiErrors?: ApiErrorEvent[];
}

/** The model attributed to a session: the first entry with a resolvable family. */
function sessionFamily(entries: TokenEntry[]): { modelId: string; family: ModelFamily } | null {
  for (const e of entries) {
    const family = resolveModelFamily(e.model);
    if (family) return { modelId: e.model, family };
  }
  return null;
}

function durationMsOf(tl: SessionTimeline | undefined): number {
  if (!tl) return 0;
  const start = Date.parse(tl.startTime);
  const end = Date.parse(tl.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return end - start;
}

function turnsOf(tl: SessionTimeline | undefined): number {
  if (!tl) return 0;
  return tl.entries.filter((e) => e.kind === 'user').length;
}

/**
 * Build {@link GapMiningRun}s from the dashboard's existing parsed data. Reuses
 * the parse-* outputs — no new parsing. Sessions whose model family can't be
 * resolved (unknown/legacy-only) are skipped, since the gap direction is
 * undefined without it.
 */
export function buildGapMiningRuns(input: GapMiningDatasetInput): GapMiningRun[] {
  const timelineById = new Map((input.timelines ?? []).map((t) => [t.sessionId, t]));
  const toolById = new Map((input.toolData ?? []).map((t) => [t.sessionId, t]));
  const apiErrorsBySession = new Map<string, number>();
  for (const e of input.apiErrors ?? []) {
    apiErrorsBySession.set(e.sessionId, (apiErrorsBySession.get(e.sessionId) ?? 0) + 1);
  }

  const runs: GapMiningRun[] = [];
  for (const sd of input.tokenData) {
    const fam = sessionFamily(sd.entries);
    if (!fam) continue;

    let costProxyUsd = 0;
    let totalTokens = 0;
    for (const e of sd.entries) {
      costProxyUsd += entryCostAtModel(e, e.model);
      totalTokens +=
        e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
    }

    const tl = timelineById.get(sd.sessionId);
    const tool = toolById.get(sd.sessionId);
    const toolCalls = tool?.calls.length ?? 0;
    const toolErrors = tool?.calls.filter((c) => c.isError === true).length ?? 0;

    runs.push({
      runId: sd.sessionId,
      modelId: fam.modelId,
      family: fam.family,
      costProxyUsd,
      totalTokens,
      durationMs: durationMsOf(tl),
      turns: turnsOf(tl),
      toolCalls,
      toolErrors,
      apiErrors: apiErrorsBySession.get(sd.sessionId) ?? 0,
    });
  }
  return runs;
}

/** Convenience: mine gap candidates straight from parsed dashboard data. */
export function mineModelGapsFromDataset(
  input: GapMiningDatasetInput,
  options?: MineModelGapsOptions
): ModelGapCandidate[] {
  return mineModelGaps(buildGapMiningRuns(input), options);
}
