/**
 * Detector: context.last-n-runs-audit
 *
 * A rolling "last N runs" maintenance audit. The *AI Agent Maintenance* essay
 * (Nate's Notebook, captured in `docs/competitive-analysis/agent-maintenance.md`)
 * proposes a dead-simple health check — look at the **last ten runs** — to catch
 * two slow-moving failure modes a single-session view misses: environmental
 * drift, and scaffolding a newer model no longer needs. Both show up as the
 * per-run working context creeping upward over the window relative to the
 * longer-history baseline the dashboard already parses.
 *
 * This detector implements the concrete, deterministic finding class the essay
 * names: **context grew X% over the window**. It orders sessions chronologically
 * by their last token entry, takes the most recent {@link LAST_N_RUNS} as the
 * rolling window, treats the prior runs as the baseline, and fires when the
 * window's mean peak context has risen materially above the baseline mean.
 *
 * It deliberately lives in the existing `context` category rather than the
 * in-flight `maintenance` category (#1965/#1987) so this slice ships independently
 * of that cross-cutting `RecCategory` surgery; it can be recategorised once that
 * lands. Reads only `tokenData` (already on RecommendationInput) — no plumbing.
 *
 * Auditability (#1049, epic #866): the finding is time-derived, so it carries
 * structured `provenance` (observations citing the parsed peak-context field, the
 * inference kept separate, an `asOf` anchored to the window's most recent run) and
 * demotes its present-tense wording to "as of <date>" once that run goes stale.
 *
 * Issue: #1882 (epic #1910 — new behaviour & cost detectors)
 */

import type { Detector, RecommendationInput, Recommendation } from '../types';
import { short } from '../shared';
import { computeContextGrowth } from '../../context-health';

/**
 * Rolling-window size: the audit looks at the most recent N runs (the essay's
 * "last ten runs"). Exported as the single named knob so the window is
 * configurable in one place, matching the repo convention for detector
 * thresholds.
 */
export const LAST_N_RUNS = 10;

/**
 * Minimum number of runs *before* the window needed to form a trustworthy
 * baseline. Below this we have no stable longer-history reference to compare the
 * window against, so the detector stays silent.
 */
export const MIN_BASELINE_RUNS = 5;

/** Window mean must exceed this absolute peak-context floor before we nag — a
 * 30% rise from 1k to 1.3k tokens is noise, not drift. */
export const MIN_WINDOW_CONTEXT = 50_000;

/** Window mean must be at least this much larger than the baseline mean. */
export const GROWTH_THRESHOLD_PCT = 25;

/** At/above this growth the finding reads one level hotter than info. */
export const WARN_GROWTH_PCT = 50;

/**
 * The window's most recent run anchors the claim's `asOf`. Older than this many
 * days before `now` and the trend is history, not current state: wording is
 * demoted to past tense and `provenance.stale` is set (#1102).
 */
export const STALE_AFTER_DAYS = 14;

const k = (n: number) => `${Math.round(n / 1000)}k`;
const isoDate = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export const detector: Detector = {
  id: 'context.last-n-runs-audit',
  category: 'context',
  dataDeps: ['tokenData'],
  rule(input: RecommendationInput, now: number): Recommendation | null {
    // Per-session peak context, reusing the canonical context-size helper.
    const growth = computeContextGrowth(input.tokenData);
    if (growth.length < LAST_N_RUNS + MIN_BASELINE_RUNS) return null;

    // Chronological end time per session, from its last token entry. Sessions
    // with no parseable timestamp can't be placed in the rolling window.
    const endTs = new Map<string, number>();
    for (const d of input.tokenData) {
      if (d.entries.length === 0) continue;
      const last = d.entries[d.entries.length - 1];
      const t = Date.parse(last.timestamp);
      if (isFinite(t)) endTs.set(d.sessionId, t);
    }

    const ordered = growth
      .filter((g) => endTs.has(g.sessionId))
      .map((g) => ({ ...g, endTs: endTs.get(g.sessionId) as number }))
      .sort((a, b) => a.endTs - b.endTs);

    if (ordered.length < LAST_N_RUNS + MIN_BASELINE_RUNS) return null;

    const windowRows = ordered.slice(-LAST_N_RUNS);
    const baselineRows = ordered.slice(0, -LAST_N_RUNS);

    const mean = (rows: { peakContext: number }[]) =>
      rows.reduce((s, r) => s + r.peakContext, 0) / rows.length;

    const windowMean = mean(windowRows);
    const baselineMean = mean(baselineRows);

    // Guard a useless comparison and the noise floor.
    if (baselineMean <= 0) return null;
    if (windowMean < MIN_WINDOW_CONTEXT) return null;

    const growthPct = Math.round(((windowMean - baselineMean) / baselineMean) * 100);
    if (growthPct < GROWTH_THRESHOLD_PCT) return null;

    // The most recent run in the window anchors the as-of date and staleness.
    const latestTs = windowRows[windowRows.length - 1].endTs;
    const asOf = isoDate(latestTs);
    const stale = now - latestTs > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

    // Heaviest window sessions lead the evidence.
    const evidence = [...windowRows]
      .sort((a, b) => b.peakContext - a.peakContext)
      .slice(0, 5)
      .map((r) => `${short(r.sessionId)}, peak ${k(r.peakContext)}`);

    // When the window's latest run is stale, demote every present-tense state
    // assertion (title, detail lead, AND the detail body verb) to "as of <date>"
    // / past tense — the auditability contract bars phrasing history as current
    // state (#1102). The forward-looking `action` directive stays imperative.
    const trend = stale ? `was trending up (as of ${asOf})` : 'is trending up';
    const detailLead = stale
      ? `As of ${asOf}, across the most recent ${LAST_N_RUNS} runs`
      : `Across your most recent ${LAST_N_RUNS} runs`;
    const wasIs = stale ? 'was' : 'is';

    return {
      id: 'context.last-n-runs-audit',
      category: 'context',
      severity: growthPct >= WARN_GROWTH_PCT ? 'warning' : 'info',
      title: `Per-run context ${trend} over your last ${LAST_N_RUNS} runs`,
      detail:
        `${detailLead}, average peak context ${wasIs} ${k(windowMean)} tokens — ` +
        `${growthPct}% above the ${k(baselineMean)} baseline from the prior ${baselineRows.length} runs. ` +
        `A rising rolling window often signals environmental drift or scaffolding a newer model no longer needs.`,
      action:
        `Audit the last ${LAST_N_RUNS} runs as a maintenance window: trim stale context (large files, unused ` +
        `tool/MCP surface, obsolete CLAUDE.md scaffolding), compact earlier, and start a fresh session for ` +
        `unrelated work so context doesn't accumulate run over run.`,
      affected: windowRows.length,
      evidence,
      view: 'context',
      provenance: {
        observations: [
          {
            claim: `The ${LAST_N_RUNS} most recent runs average ${k(windowMean)} peak context tokens`,
            source: 'parse-sessions',
            field: 'tokenData[].entries[] peak context (input + cacheCreation + cacheRead)',
            value: Math.round(windowMean),
          },
          {
            claim: `The prior ${baselineRows.length} runs average ${k(baselineMean)} peak context tokens`,
            source: 'parse-sessions',
            field: 'tokenData[].entries[] peak context (input + cacheCreation + cacheRead)',
            value: Math.round(baselineMean),
          },
          {
            claim: `The most recent of those ${LAST_N_RUNS} runs ended on ${asOf}`,
            source: 'parse-sessions',
            field: 'tokenData[].entries[].timestamp',
            value: asOf,
          },
        ],
        inference:
          `Mean peak context rose ${growthPct}% over the rolling last-${LAST_N_RUNS}-runs window versus the ` +
          `prior baseline — drift or staleness worth a maintenance audit.`,
        asOf,
        stale,
      },
    };
  },
};
