// Shared token-spend aggregator for the Summary view (epic #730).
//
// One place that rolls up session token data into the shapes the Summary
// panels render — by project here (#737), and by day / by model / by token
// type / by project share / by session-type as later slices (#732-#736) extend
// this module. The point is COMPOSITION, not re-derivation: per-project cost
// comes straight from the canonical Cost-view aggregator (`attributeCostByProject`)
// so the Summary's numbers match the Cost view exactly, and this module only
// adds the token rollups that aggregator doesn't carry.
//
// SPA-safe: everything derives from `SessionTokenData` (parse-sessions.ts),
// which is in the upload bundle — no server call, no stats-cache.json.
import type {
  SessionTokenData,
  Session,
} from '../types';
import { estimateCost } from './parse-sessions';
import {
  attributeCostByProject,
  UNKNOWN_PROJECT_BUCKET,
} from './cost-attribution';
import { entryCost, dayKey } from './cost-trend';
import { SYNTHETIC_MODEL } from './pricing';
import { resolveModelFamily, type ModelFamily } from './model-registry';

/** Total billable tokens for a session — all four token types summed. */
export function sessionTotalTokens(t: SessionTokenData): number {
  return (
    t.totalInputTokens +
    t.totalOutputTokens +
    t.totalCacheCreationTokens +
    t.totalCacheReadTokens
  );
}

/** Grand totals across every session — the denominators the share/distribution
 *  panels (#734, #735) divide by, plus the headline figures. */
export interface SpendTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  sessionCount: number;
}

export function spendTotals(tokenData: SessionTokenData[]): SpendTotals {
  const t: SpendTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    cost: 0,
    sessionCount: tokenData.length,
  };
  for (const s of tokenData) {
    t.inputTokens += s.totalInputTokens;
    t.outputTokens += s.totalOutputTokens;
    t.cacheCreationTokens += s.totalCacheCreationTokens;
    t.cacheReadTokens += s.totalCacheReadTokens;
    t.cost += estimateCost(s);
  }
  t.totalTokens =
    t.inputTokens + t.outputTokens + t.cacheCreationTokens + t.cacheReadTokens;
  return t;
}

/** One token-type's total across all sessions, in fixed display order. */
export interface TokenTypeRow {
  /** Stable key — input | output | cacheCreation | cacheRead. */
  key: 'input' | 'output' | 'cacheCreation' | 'cacheRead';
  /** Display label matching the Tokens view convention. */
  label: string;
  tokens: number;
}

/**
 * The four token-type totals (input / output / cache-creation / cache-read) in a
 * fixed order, for the aggregate composition panel. Cache-creation and
 * cache-read are kept distinct so cache efficiency is readable. Tokens sum to
 * `spendTotals(...).totalTokens`.
 */
export function spendByTokenType(tokenData: SessionTokenData[]): TokenTypeRow[] {
  const t = spendTotals(tokenData);
  return [
    { key: 'input', label: 'Input', tokens: t.inputTokens },
    { key: 'output', label: 'Output', tokens: t.outputTokens },
    { key: 'cacheCreation', label: 'Cache Write', tokens: t.cacheCreationTokens },
    { key: 'cacheRead', label: 'Cache Read', tokens: t.cacheReadTokens },
  ];
}

/** A project's token + cost spend, ranked by total tokens. */
export interface ProjectSpendRow {
  /** Full project path (the bucketing key). */
  project: string;
  /** Shortened path for display (from the canonical aggregator). */
  projectShort: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /** Estimated USD cost — identical to the Cost view's per-project figure. */
  cost: number;
  sessionCount: number;
}

/**
 * Per-project token + cost spend, ranked by total tokens (descending).
 *
 * Cost, `projectShort`, and `sessionCount` come from `attributeCostByProject`
 * (the Cost view's aggregator) so the figures match exactly; this only adds the
 * per-project token-type rollups in a single pass over `tokenData`. Sessions
 * whose id isn't in `sessions` fall into the same `_unknown` bucket the cost
 * aggregator uses, so the two stay aligned.
 */
export function spendByProject(
  tokenData: SessionTokenData[],
  sessions: Session[]
): ProjectSpendRow[] {
  const projectBySession = new Map<string, string>();
  for (const s of sessions) projectBySession.set(s.sessionId, s.project);

  interface TokAcc {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  }
  const tok = new Map<string, TokAcc>();
  for (const t of tokenData) {
    const project =
      projectBySession.get(t.sessionId) ?? t.project ?? UNKNOWN_PROJECT_BUCKET;
    const acc = tok.get(project) ?? {
      input: 0,
      output: 0,
      cacheCreation: 0,
      cacheRead: 0,
    };
    acc.input += t.totalInputTokens;
    acc.output += t.totalOutputTokens;
    acc.cacheCreation += t.totalCacheCreationTokens;
    acc.cacheRead += t.totalCacheReadTokens;
    tok.set(project, acc);
  }

  return attributeCostByProject(tokenData, sessions)
    .map((r) => {
      const acc = tok.get(r.project) ?? {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      };
      const totalTokens =
        acc.input + acc.output + acc.cacheCreation + acc.cacheRead;
      return {
        project: r.project,
        projectShort: r.projectShort,
        inputTokens: acc.input,
        outputTokens: acc.output,
        cacheCreationTokens: acc.cacheCreation,
        cacheReadTokens: acc.cacheRead,
        totalTokens,
        cost: r.estimatedCost,
        sessionCount: r.sessionCount,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** A project's proportional share of total token spend. */
export interface ProjectShareRow {
  /** Project label (shortened path, the `_unknown` bucket, or the Other rollup). */
  label: string;
  tokens: number;
  cost: number;
}

/**
 * Per-project token + cost spend collapsed to a legible share distribution:
 * the top `topN` projects by tokens, with everything past that folded into a
 * single `Other (N projects)` row so the shares still sum to the whole. Pure
 * composition over {@link spendByProject} — no new aggregation source. Returns
 * `[]` only when there is no spend at all.
 */
export function spendByProjectShare(
  tokenData: SessionTokenData[],
  sessions: Session[],
  topN = 8
): ProjectShareRow[] {
  const rows = spendByProject(tokenData, sessions);
  if (rows.length === 0) return [];

  const head = rows.slice(0, topN).map((r) => ({
    label: r.project === UNKNOWN_PROJECT_BUCKET ? '(unknown project)' : r.projectShort,
    tokens: r.totalTokens,
    cost: r.cost,
  }));

  const tail = rows.slice(topN);
  if (tail.length > 0) {
    head.push({
      label: `Other (${tail.length} project${tail.length === 1 ? '' : 's'})`,
      tokens: tail.reduce((s, r) => s + r.totalTokens, 0),
      cost: tail.reduce((s, r) => s + r.cost, 0),
    });
  }
  return head;
}

/** One calendar day (UTC) of token + cost spend. */
export interface DaySpendRow {
  /** ISO `YYYY-MM-DD` (UTC) day key. */
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  /** Estimated USD cost for the day — same per-entry pricing as the Cost trend. */
  cost: number;
  /** Number of token entries (API calls) attributed to this day. */
  entries: number;
}

/**
 * Per-day token + cost spend, derived from each entry's timestamp, sorted
 * ascending by date. SPA-safe — reads `SessionTokenData.entries` (in the upload
 * bundle), NOT the server-only `stats-cache.json`.
 *
 * Buckets on the same UTC calendar-day boundary as the Cost trend (shared
 * `dayKey`) and prices each entry with the shared `entryCost`, so the per-day
 * cost equals `computeCostTrend`'s daily series by construction. Entries with an
 * unparseable timestamp are dropped from the dated series (same as the trend),
 * keeping the day axis clean. `spendTotals` remains the source for grand totals.
 */
export function spendByDay(tokenData: SessionTokenData[]): DaySpendRow[] {
  interface DayAcc {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
    cost: number;
    entries: number;
  }
  const byDay = new Map<string, DayAcc>();

  for (const session of tokenData) {
    for (const entry of session.entries) {
      const key = dayKey(entry.timestamp);
      if (key === null) continue;
      const acc = byDay.get(key) ?? {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
        cost: 0,
        entries: 0,
      };
      acc.input += entry.inputTokens;
      acc.output += entry.outputTokens;
      acc.cacheCreation += entry.cacheCreationTokens;
      acc.cacheRead += entry.cacheReadTokens;
      acc.cost += entryCost(entry);
      acc.entries += 1;
      byDay.set(key, acc);
    }
  }

  return Array.from(byDay.entries())
    .map(([date, a]) => ({
      date,
      inputTokens: a.input,
      outputTokens: a.output,
      cacheCreationTokens: a.cacheCreation,
      cacheReadTokens: a.cacheRead,
      totalTokens: a.input + a.output + a.cacheCreation + a.cacheRead,
      cost: a.cost,
      entries: a.entries,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Group a model string into its family for distribution display. Mirrors the
 * family-fallback logic in `resolveModelPricing` (opus/sonnet/haiku by
 * substring), with `<synthetic>` (non-billable local turns) and an explicit
 * `Unknown` bucket for the parser's `'unknown'` default and any unrecognized
 * string.
 */
export function modelFamily(model: string): string {
  const normalized = model.trim();
  if (normalized === SYNTHETIC_MODEL) return 'Synthetic';
  const family = resolveModelFamily(normalized);
  if (!family) return 'Unknown';
  return MODEL_FAMILY_LABELS[family];
}

const MODEL_FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: 'Fable',
  mythos: 'Mythos',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

/** One model family's token + cost spend. */
export interface ModelSpendRow {
  /** Fable | Mythos | Opus | Sonnet | Haiku | Synthetic | Unknown. */
  family: string;
  totalTokens: number;
  cost: number;
  entries: number;
}

/**
 * Per-model-family token + cost spend, ranked by total tokens. Token choice is
 * the single biggest cost lever (Opus ~15x Haiku), so this surfaces where spend
 * concentrates. Prices each entry with the shared `entryCost`; sums over all
 * four token types. SPA-safe — `model` is on every transcript usage record.
 */
export function spendByModel(tokenData: SessionTokenData[]): ModelSpendRow[] {
  interface ModelAcc {
    tokens: number;
    cost: number;
    entries: number;
  }
  const byFamily = new Map<string, ModelAcc>();

  for (const session of tokenData) {
    for (const entry of session.entries) {
      const family = modelFamily(entry.model);
      const acc = byFamily.get(family) ?? { tokens: 0, cost: 0, entries: 0 };
      acc.tokens +=
        entry.inputTokens +
        entry.outputTokens +
        entry.cacheCreationTokens +
        entry.cacheReadTokens;
      acc.cost += entryCost(entry);
      acc.entries += 1;
      byFamily.set(family, acc);
    }
  }

  return Array.from(byFamily.entries())
    .map(([family, a]) => ({
      family,
      totalTokens: a.tokens,
      cost: a.cost,
      entries: a.entries,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

/** A session-type's token + cost spend (from `/insights` facets). */
export interface SessionTypeRow {
  /** Raw facet value, or `'uncategorized'` for the explicit no-facet bucket. */
  type: string;
  /** Prettified label for display. */
  label: string;
  tokens: number;
  cost: number;
  sessions: number;
  /** True for the explicit bucket of sessions with no `sessionType` facet. */
  uncategorized: boolean;
}

const UNCATEGORIZED = 'uncategorized';

/** Prettify a snake_case facet value: `quick_question` -> `Quick question`. */
function prettySessionType(type: string): string {
  const spaced = type.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Per-session-type token + cost spend, joining each session's spend to its
 * `sessionType` from parsed `/insights` facets. Sessions with no facet (or no
 * `sessionType` on it) fall into an explicit `uncategorized` bucket — never
 * silently dropped. Best-effort by design: with no facets at all, the single
 * `uncategorized` row signals the view to show the run-`/insights` partial
 * state. Richer once #655's always-on classifier lands. SPA-safe — `/insights`
 * facets are uploadable.
 *
 * Ranked by tokens descending, with `uncategorized` always sorted last so the
 * classified types lead.
 */
export function spendBySessionType(
  tokenData: SessionTokenData[],
  classify?: (sessionId: string) => string | undefined
): SessionTypeRow[] {
  interface TypeAcc {
    tokens: number;
    cost: number;
    sessions: number;
  }
  const byType = new Map<string, TypeAcc>();
  for (const s of tokenData) {
    // Use the always-on local classifier (#655), falling back to the explicit
    // uncategorized bucket when no classifier is supplied / it has no opinion.
    // (Insights `session_type` facets were removed with the insights feature, #1056.)
    const type = classify?.(s.sessionId) ?? UNCATEGORIZED;
    const acc = byType.get(type) ?? { tokens: 0, cost: 0, sessions: 0 };
    acc.tokens += sessionTotalTokens(s);
    acc.cost += estimateCost(s);
    acc.sessions += 1;
    byType.set(type, acc);
  }

  return Array.from(byType.entries())
    .map(([type, a]) => ({
      type,
      label: type === UNCATEGORIZED ? 'Uncategorized' : prettySessionType(type),
      tokens: a.tokens,
      cost: a.cost,
      sessions: a.sessions,
      uncategorized: type === UNCATEGORIZED,
    }))
    .sort((a, b) => {
      // Uncategorized always last; otherwise by tokens descending.
      if (a.uncategorized !== b.uncategorized) return a.uncategorized ? 1 : -1;
      return b.tokens - a.tokens;
    });
}
