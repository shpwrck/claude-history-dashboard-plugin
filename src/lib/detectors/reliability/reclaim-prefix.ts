/**
 * Shared reliability→token join for the cause-side "re-paid prefix" levers
 * (`retry-prefix-rewaste`, `overload-reretry`) — epic #944, PR4.
 *
 * **The hard constraint (doc §6).** `TokenEntry` (`types.ts`) carries no
 * `toolUseId`, so there is *no* deterministic edge from a failed `ToolCall` (or a
 * 529/429 `api_error` line) to the exact token entry whose cache-read prefix the
 * retry re-paid. The only join we have is **timestamp-approximate**: a reliability
 * event at time `t` in session `s` overlaps whatever `(s, model)` token rows are
 * billed near `t`. Because that join is fuzzy, both PR4 levers:
 *
 *  - book a **`scaleTokens` on `cacheRead` ONLY** — the prefix the retried turn
 *    re-fed is cache-read; the turn's `output`/`input` are the *legitimate
 *    co-located work* the doc warns is "mostly legitimate … only the re-paid
 *    residual is waste" ($2,065 gross, §3). Touching them would book the whole
 *    turn;
 *  - use a **small, fixed conservative `poolDeltaFrac`** ({@link PREFIX_REWASTE_FRAC})
 *    and **never delete a whole turn** — `frac` is hard-capped well below 1, so a
 *    cell's residual is only ever nicked, never zeroed. The cascade's `scaleTokens`
 *    keeps `frac` of the cell (`keep = 1 - frac`), and the `residual ≥ 0` guard in
 *    `runReclaimCascade` rejects any over-draw, so the identity holds regardless.
 *
 * The scope resolution returns canonical `${sessionId}|${model}` keys plus the
 * cache-read tokens behind them (for the per-category coverage `evidenceTokens`),
 * so each detector only has to decide *which sessions/time-windows* are affected.
 */
import type { SessionTokenData } from '../../../types';
import { scopeKeyOf } from '../../reclaim';
import { getModelPricing } from '../../pricing';

/**
 * The conservative cache-read fraction a single re-paid prefix lever books.
 *
 * Deliberately small and FIXED (not derived from the retry count) because the
 * token→tool join is timestamp-approximate (no `toolUseId` edge): we know a
 * retried turn re-fed *some* of its cache-read prefix, but not how much maps to
 * this exact entry. 5% is a floor-estimate of the re-paid residual that cannot,
 * by construction, escalate into whole-turn deletion. The cascade clamps it
 * against the live residual, so stacking two reliability levers on the same cell
 * still cannot over-book (`residual ≥ 0`).
 */
export const PREFIX_REWASTE_FRAC = 0.05;

/** Parsed-once millisecond timestamp, or `NaN` when unparseable. */
function ms(ts: string): number {
  return Date.parse(ts);
}

/**
 * Resolve the `(sessionId, model)` scope rows whose token entries fall inside one
 * or more `[start, end]` reliability windows, returning the canonical scope keys
 * and the cache-read tokens behind them.
 *
 * A row counts when at least one of its entries timestamps within any window
 * (inclusive). Windows with an unparseable bound, and entries with an
 * unparseable timestamp, are skipped — never widened to "the whole session" — so
 * a malformed timestamp shrinks the claim rather than over-booking it.
 *
 * `cacheReadTokens` is the per-scope sum of in-window cache-read tokens, used as
 * the claim's `evidenceTokens` (coverage only — it never enters the dollar
 * identity). `estSavingsUsd` is the DERIVED back-fill of the booked marginal —
 * each scope's in-window cache-read priced at its own model's cache-read rate ×
 * {@link PREFIX_REWASTE_FRAC} — so the card has a figure for ranking/labelling
 * while the cascade stays the source of truth. Returns disjoint, de-duplicated
 * scope keys.
 */
export function resolveReliabilityScopes(
  tokenData: SessionTokenData[],
  windowsBySession: Map<string, Array<{ start: number; end: number }>>
): { scopeKeys: string[]; cacheReadTokens: number; estSavingsUsd: number } {
  const byScope = new Map<string, number>();
  let estSavingsUsd = 0;

  for (const d of tokenData) {
    const windows = windowsBySession.get(d.sessionId);
    if (!windows || windows.length === 0) continue;
    for (const entry of d.entries) {
      const t = ms(entry.timestamp);
      if (Number.isNaN(t)) continue;
      const inWindow = windows.some((w) => t >= w.start && t <= w.end);
      if (!inWindow) continue;
      if (entry.cacheReadTokens <= 0) continue;
      const model = entry.model || 'unknown';
      byScope.set(
        scopeKeyOf(d.sessionId, model),
        (byScope.get(scopeKeyOf(d.sessionId, model)) ?? 0) + entry.cacheReadTokens
      );
      const rate = getModelPricing(model).cacheRead;
      estSavingsUsd += (entry.cacheReadTokens / 1_000_000) * rate * PREFIX_REWASTE_FRAC;
    }
  }

  let cacheReadTokens = 0;
  for (const v of byScope.values()) cacheReadTokens += v;
  return { scopeKeys: [...byScope.keys()], cacheReadTokens, estSavingsUsd };
}

/** A parsed reliability window, dropping bounds that don't parse. */
export function makeWindow(
  startTs: string,
  endTs: string
): { start: number; end: number } | null {
  const start = ms(startTs);
  const end = ms(endTs);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}
