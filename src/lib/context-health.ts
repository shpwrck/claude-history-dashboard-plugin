import type { SessionTokenData, TokenEntry, CompactionEvent } from '../types';
import { estimateCost } from './parse-sessions';
import { getModelPricing } from './pricing';

// Heuristic thresholds for health scoring. Exposed so the UI can flag the
// same thresholds (e.g. "low health" badge) without re-deriving them.
export const LOW_HIT_RATE = 0.5;
export const PEAK_CONTEXT_WARN = 100_000;
// Effective context window ceiling. Sessions whose peak context sits above
// this have spilled past the usable window and should have compacted (or
// started fresh) earlier; they also burn cache-read $ re-sending the bloat.
export const OVER_WINDOW = 200_000;
export const HIGH_GROWTH_PER_HOUR = 50_000;
export const MAX_COMPACTION_PENALTY = 30;
export const LOW_HEALTH_SCORE = 50;

export interface ContextGrowthStat {
  sessionId: string;
  startContext: number;
  endContext: number;
  peakContext: number;
  /** (end - start) / hours-of-session, 0 if < 1 entry or duration is 0 */
  growthRate: number;
  compactionCount: number;
}

export interface CacheEfficiencyStat {
  sessionId: string;
  totalReads: number;
  totalWrites: number;
  /** reads / (reads + writes), 0 if both are zero */
  hitRate: number;
}

export interface SessionCostStat {
  sessionId: string;
  /** Full estimated session cost (all token types) in USD. */
  totalCost: number;
  /** Portion of cost attributable to cache-read (hit) tokens, in USD. */
  cacheReadCost: number;
  /** cacheReadCost / totalCost, 0 if total is zero. */
  cacheReadShare: number;
}

export interface CompactionRow {
  sessionId: string;
  timestamp: string;
  beforeContext: number;
  afterContext: number;
  reductionPercent: number;
}

export interface SessionHealthScore {
  sessionId: string;
  /** 0..100, higher is healthier */
  score: number;
  reasons: string[];
}

function contextSize(entry: TokenEntry): number {
  return entry.inputTokens + entry.cacheCreationTokens + entry.cacheReadTokens;
}

function peakContextSize(entries: TokenEntry[]): number {
  let peak = 0;
  for (const e of entries) {
    const c = contextSize(e);
    if (c > peak) peak = c;
  }
  return peak;
}

function hoursBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!isFinite(start) || !isFinite(end) || end <= start) return 0;
  return (end - start) / (1000 * 60 * 60);
}

export function computeContextGrowth(
  data: SessionTokenData[]
): ContextGrowthStat[] {
  const stats: ContextGrowthStat[] = [];
  for (const d of data) {
    if (d.entries.length === 0) continue;
    const first = d.entries[0];
    const last = d.entries[d.entries.length - 1];
    const startContext = contextSize(first);
    const endContext = contextSize(last);
    const peakContext = peakContextSize(d.entries);

    const hours = hoursBetween(first.timestamp, last.timestamp);
    const rawGrowth = hours > 0 ? (endContext - startContext) / hours : 0;
    // Clamp NaN/Infinity to 0; negative growth is possible but capped to 0
    // for the sort key (we surface raw value too if needed).
    const growthRate =
      isFinite(rawGrowth) && rawGrowth > 0 ? rawGrowth : 0;

    stats.push({
      sessionId: d.sessionId,
      startContext,
      endContext,
      peakContext,
      growthRate,
      compactionCount: d.compactionEvents.length,
    });
  }
  return stats.sort((a, b) => b.growthRate - a.growthRate);
}

export function computeCacheEfficiency(
  data: SessionTokenData[]
): CacheEfficiencyStat[] {
  const stats: CacheEfficiencyStat[] = [];
  for (const d of data) {
    if (d.entries.length === 0) continue;
    const totalReads = d.totalCacheReadTokens;
    const totalWrites = d.totalCacheCreationTokens;
    const denom = totalReads + totalWrites;
    const rawHitRate = denom > 0 ? totalReads / denom : 0;
    // Clamp to [0, 1] in case of bogus inputs.
    const hitRate = Math.min(1, Math.max(0, rawHitRate));
    stats.push({
      sessionId: d.sessionId,
      totalReads,
      totalWrites,
      hitRate,
    });
  }
  return stats.sort((a, b) => a.hitRate - b.hitRate);
}

/**
 * Reclaimable cache-write fraction for a session, **derived from its measured
 * cache hit-rate** — never a hardcoded constant (epic #944, PR3 / #949).
 *
 * A cache *write* that is never read back is pure waste: the prefix was churned
 * before the cache could be reused. `computeCacheEfficiency` already measures how
 * much of the cached context was reused (`hitRate = reads / (reads + writes)`);
 * the further a session sits below the {@link LOW_HIT_RATE} reuse floor, the
 * larger the share of its cache-write spend that bought nothing. So the deletable
 * fraction is the session's *shortfall* below the floor, expressed as a fraction
 * of the floor:
 *
 *     frac = clamp01((LOW_HIT_RATE − hitRate) / LOW_HIT_RATE)
 *
 * This is **fully grounded in the measured signal**: a session exactly at the
 * floor reclaims 0, one at hitRate 0 reclaims the whole shortfall (1.0), and a
 * **higher measured hit-rate always yields a smaller fraction** (strictly
 * monotonic decreasing) — the property #949 requires a test to assert. `LOW_HIT_RATE`
 * is the existing health threshold the detector already keys on, not a fabricated
 * reclaim constant.
 */
export function reclaimableCacheWriteFrac(hitRate: number): number {
  if (LOW_HIT_RATE <= 0) return 0;
  const frac = (LOW_HIT_RATE - hitRate) / LOW_HIT_RATE;
  return Math.min(1, Math.max(0, frac));
}

/**
 * Per-session cost breakdown.
 *
 * `totalCost` reuses {@link estimateCost} so it stays consistent with the
 * Cost view. `cacheReadCost` isolates the cache-read (hit) spend — in real
 * data this is the dominant share of total spend yet is otherwise invisible
 * here, so it gets surfaced as a first-class metric. Both use the same
 * per-entry model pricing, so cacheReadCost <= totalCost by construction.
 */
export function computeSessionCosts(
  data: SessionTokenData[]
): SessionCostStat[] {
  const stats: SessionCostStat[] = [];
  for (const d of data) {
    if (d.entries.length === 0) continue;
    const totalCost = estimateCost(d);
    let cacheReadCost = 0;
    for (const entry of d.entries) {
      const pricing = getModelPricing(entry.model);
      cacheReadCost += (entry.cacheReadTokens / 1_000_000) * pricing.cacheRead;
    }
    const cacheReadShare = totalCost > 0 ? cacheReadCost / totalCost : 0;
    stats.push({
      sessionId: d.sessionId,
      totalCost,
      cacheReadCost,
      cacheReadShare,
    });
  }
  return stats.sort((a, b) => b.totalCost - a.totalCost);
}

export function listCompactions(data: SessionTokenData[]): CompactionRow[] {
  const rows: CompactionRow[] = [];
  for (const d of data) {
    for (const e of d.compactionEvents as CompactionEvent[]) {
      rows.push({
        sessionId: d.sessionId,
        timestamp: e.timestamp,
        beforeContext: e.beforeContext,
        afterContext: e.afterContext,
        reductionPercent: e.reductionPercent,
      });
    }
  }
  return rows.sort((a, b) => b.reductionPercent - a.reductionPercent);
}

/**
 * Simple heuristic health score per session.
 *
 * Starts at 100 and applies the following penalties:
 *  - Cache hit rate below LOW_HIT_RATE: -20
 *  - Per compaction: -10, capped at MAX_COMPACTION_PENALTY
 *  - Peak context above PEAK_CONTEXT_WARN tokens: -20
 *  - Peak context above OVER_WINDOW (200K) tokens: additional -20
 *  - Growth rate above HIGH_GROWTH_PER_HOUR tokens/hour: -10
 * Floor at 0. Sessions with score < LOW_HEALTH_SCORE are flagged in the UI.
 */
export function scoreSessionHealth(
  data: SessionTokenData[]
): SessionHealthScore[] {
  const scores: SessionHealthScore[] = [];
  for (const d of data) {
    if (d.entries.length === 0) continue;

    const reasons: string[] = [];
    let score = 100;

    // Cache hit rate
    const reads = d.totalCacheReadTokens;
    const writes = d.totalCacheCreationTokens;
    const denom = reads + writes;
    const hitRate = denom > 0 ? reads / denom : 0;
    if (denom > 0 && hitRate < LOW_HIT_RATE) {
      score -= 20;
      reasons.push(`Low cache hit rate (${(hitRate * 100).toFixed(0)}%)`);
    }

    // Compaction count penalty (capped)
    const compactionCount = d.compactionEvents.length;
    if (compactionCount > 0) {
      const penalty = Math.min(compactionCount * 10, MAX_COMPACTION_PENALTY);
      score -= penalty;
      reasons.push(
        `${compactionCount} compaction${compactionCount === 1 ? '' : 's'}`
      );
    }

    // Peak context above warn threshold
    const peakContext = peakContextSize(d.entries);
    if (peakContext > PEAK_CONTEXT_WARN) {
      score -= 20;
      reasons.push(`Peak context: ${(peakContext / 1000).toFixed(0)}k`);
    }

    // Peak context past the usable window: compact earlier / start fresh.
    // Coexists with PEAK_CONTEXT_WARN above (which still fires); this adds an
    // extra penalty and an actionable reason for the egregious cases.
    if (peakContext > OVER_WINDOW) {
      score -= 20;
      reasons.push(
        `Over window (${(peakContext / 1000).toFixed(0)}k > 200k) — compact earlier or start fresh`
      );
    }

    // Growth rate above warn threshold (tokens/hour)
    const first = d.entries[0];
    const last = d.entries[d.entries.length - 1];
    const hours = hoursBetween(first.timestamp, last.timestamp);
    const growthRate =
      hours > 0 ? (contextSize(last) - contextSize(first)) / hours : 0;
    if (growthRate > HIGH_GROWTH_PER_HOUR) {
      score -= 10;
      reasons.push(`High growth: ${(growthRate / 1000).toFixed(0)}k tok/hr`);
    }

    if (score < 0) score = 0;

    scores.push({
      sessionId: d.sessionId,
      score,
      reasons,
    });
  }
  return scores.sort((a, b) => a.score - b.score);
}
