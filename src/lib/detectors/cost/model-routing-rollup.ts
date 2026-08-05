/**
 * cost/model-routing-rollup — project per-turn cheaper-model routing into one
 * summary cost Recommendation (#1165, epic #866; wrapper slice of the #851 audit).
 *
 * `computeModelRecommendations()` (parse-model-recommendation.ts) buckets each
 * turn by complexity and computes a cheaper model it could have run on. The
 * Recommendations page renders that as a dedicated panel, but it was NEVER a
 * normal detector output — so it didn't flow through `buildRecommendations()`
 * and was invisible to `/api/recommendations.json`, the digest, and the recs
 * skill. This detector closes that gap with a single rolled-up `cost`
 * Recommendation ("route N turns to a cheaper model -> ~$X/mo"), keeping the
 * per-turn panel as the evidence/drill-down surface (not one card per turn).
 *
 * Dedup with cost/legacy-model-overpay (acceptance: no double-count): that
 * detector carries a structured `reclaim` claim, so its dollars are booked into
 * the guarded-marginal cascade (`rollupReclaimCascade`) and the deduped
 * `rollupReclaim`/`totalEstimatedSavings`. Routing savings are an EXTRAPOLATED
 * monthly projection over a different basis (per-turn capability-tier downgrade),
 * and a trivial turn that ran on legacy Opus would otherwise be claimed by BOTH
 * levers. To stay provably non-double-counting we deliberately DO NOT set
 * `estSavingsUsd` and carry NO `reclaim` claim here, so this recommendation never
 * enters either reclaim total — the `$X/mo` figure lives in the detail/evidence
 * as a descriptive projection. (Wiring routing in as a real ReclaimClaim with a
 * downgrade counterfactual + turn-level legacy exclusion is a clean follow-up if
 * the cascade should own these dollars.)
 *
 * Requires `timelines` (turn bucketing needs them), mirroring the panel, so it
 * stays dark on the transcript-free SPA dataset.
 */

import type { Detector, RecommendationInput } from '../types';
import {
  computeModelRecommendations,
  summarizeModelRecommendations,
  estimateMonthlySavings,
} from '../../parse-model-recommendation';
import { fmtUsd, short } from '../shared';
import { promptRegimeLabel, summarizePromptRegimes } from '../../prompt-regime';

/** Stay quiet on sparse data: need a meaningful downgradable set AND dollars. */
const MIN_DOWNGRADABLE_TURNS = 20;
const MIN_MONTHLY_USD = 1;
/** At or above this monthly projection the finding is a warning, else info. */
const WARN_MONTHLY_USD = 10;

/**
 * The provenance inference for a routing recommendation (#3199).
 *
 * A footprint match (prompt/tool/edit/output size fits a cheaper capability
 * tier) is NECESSARY but NOT SUFFICIENT for a safe route: it shows a turn COULD
 * fit a cheaper model, never that the cheaper model would have produced
 * equal-quality output. So without structured quality-result evidence — a
 * replay/evaluation receipt, the kind `cost.model-eval-routing-gap` reads from
 * `~/.claude/model-evals/results` — this stays a LOW-CONFIDENCE candidate and the
 * `$X/mo` figure is a CEILING, not a guaranteed saving.
 *
 * Stronger, act-now wording is permitted ONLY when that structured
 * quality-result provenance is present (`hasQualityProvenance`). This detector
 * is the pure footprint heuristic, so it always passes `false`; the boolean is a
 * seam for a future caller that genuinely carries quality receipts.
 */
export function routingInference(hasQualityProvenance: boolean): string {
  if (hasQualityProvenance) {
    return (
      'Turns whose footprint fits a cheaper capability tier AND whose model/task ' +
      'class carries structured quality-result evidence (a replay/evaluation ' +
      'receipt) can be routed there; the summed per-turn delta, extrapolated over ' +
      'the observed span, is the recoverable monthly spend.'
    );
  }
  return (
    'Turns whose prompt/tool/edit/output footprint fits a cheaper capability tier ' +
    'are LOW-CONFIDENCE routing CANDIDATES only: the footprint match shows a turn ' +
    'could fit a cheaper model, not that the cheaper model would hold output ' +
    'quality. Routing is not proven safe here — it requires a replay/evaluation ' +
    'that measures output quality on the cheaper model. The summed per-turn delta, ' +
    'extrapolated over the observed span, is a CEILING on recoverable monthly ' +
    'spend, not a guaranteed saving.'
  );
}

export const detector: Detector = {
  id: 'cost.model-routing-rollup',
  category: 'cost',
  dataDeps: ['tokenData', 'toolData', 'timelines', 'attribution'],
  rule(input: RecommendationInput) {
    const timelines = input.timelines ?? [];
    if (timelines.length === 0) return null;

    const rows = computeModelRecommendations(
      input.tokenData,
      input.toolData,
      timelines,
      input.attribution ?? []
    );
    if (rows.length === 0) return null;

    const summary = summarizeModelRecommendations(rows);
    const monthly = estimateMonthlySavings(rows);
    const downgradable = summary.haikuTurns + summary.sonnetTurns;
    if (downgradable < MIN_DOWNGRADABLE_TURNS || monthly < MIN_MONTHLY_USD) return null;

    const pct = summary.downgradablePct.toFixed(0);

    // Prompt-regime confounding (#3405, same treatment as activity-trend): the
    // monthly figure extrapolates over the observed span, so when the
    // contributing sessions straddle the Claude Code system-prompt cut the
    // aggregate mixes two harness regimes — turn complexity and footprint under
    // the short prompt are not comparable to the long-prompt baseline, so part
    // of the projection is the harness change, not routable spend. Segment the
    // contributing sessions by CLI version; on a confounded window, demote
    // severity and say so instead of silently aggregating across the boundary.
    // perf-index-contract: routing-regime-contributors always-consumed: built only after the non-empty rows guard, and drained by the summarize call two statements later
    const contributingSessions = new Set(rows.map((r) => r.session.sessionId));
    // perf-index-contract: routing-regime-session-version always-consumed: built only after the non-empty rows guard above, and immediately drained by the summarize call on the next statement
    const versionBySession = new Map(input.tokenData.map((t) => [t.sessionId, t.version]));
    const span = summarizePromptRegimes(
      [...contributingSessions].map((id) => versionBySession.get(id))
    );
    const confounded = span.confounded;
    const regimeNote = span.spansBoundary
      ? `spans a Claude Code prompt-regime change (${span.regimes.map(promptRegimeLabel).join(' -> ')})`
      : 'includes sessions on a Claude Code version too close to a prompt-regime change to place';
    // Name every regime the window touched, including the unplaceable ones — a
    // mixed window resolves one regime AND carries indeterminate sessions, so
    // reporting only the resolved id would contradict the claim beside it.
    const regimeValue =
      [...span.regimes, ...(span.hasIndeterminate ? ['indeterminate'] : [])].join(',') ||
      'indeterminate';

    // Regime-spanning demotion (#3405): a confounded projection never escalates
    // to `warning`, and the copy says why.
    const severity = monthly >= WARN_MONTHLY_USD && !confounded ? 'warning' : 'info';

    return {
      id: 'cost.model-routing-rollup',
      category: 'cost',
      severity,
      title: 'Route trivial turns to a cheaper model',
      detail:
        `${downgradable} of ${summary.totalTurns} turns (${pct}%) ran a heavier model ` +
        `than their complexity needed — ${summary.haikuTurns} fit Haiku, ` +
        `${summary.sonnetTurns} fit Sonnet. Routing them is worth ~${fmtUsd(monthly)}/mo ` +
        `at the observed rate.` +
        (confounded
          ? ` Treat the projection as indicative only: the contributing sessions' window ${regimeNote}, ` +
            `so a change in the harness prompt cannot be separated from routable spend.`
          : ''),
      action:
        'Run lightweight turns on a cheaper model — pin a smaller model for the simple ' +
        'phases, or split work so trivial turns do not run on Opus. The Model Routing ' +
        'panel on the Recommendations page has the per-turn breakdown.',
      // estSavingsUsd intentionally OMITTED — see the dedup note in the file header.
      affected: downgradable,
      evidence: [
        `${summary.haikuTurns} turn(s) fit Haiku, ${summary.sonnetTurns} fit Sonnet (${pct}% downgradable)`,
        ...summary.recentTrivialExamples
          .slice(0, 4)
          .map(
            (t) =>
              `${short(t.sessionId)} turn ${t.turnIndex}: ${t.bucket} on ${t.currentModel} -> ${t.recommendedModel}`
          ),
      ],
      view: 'recommendations',
      provenance: {
        observations: [
          {
            claim: `${downgradable} of ${summary.totalTurns} turns were classified downgradable to a cheaper model`,
            source: 'parse-model-recommendation',
            field: 'computeModelRecommendations() -> summarizeModelRecommendations().haikuTurns/sonnetTurns',
            value: downgradable,
          },
          {
            claim: `extrapolated monthly routing savings ~${fmtUsd(monthly)}`,
            source: 'parse-model-recommendation',
            field: 'estimateMonthlySavings()',
            value: Math.round(monthly * 100) / 100,
          },
          ...(confounded
            ? [
                {
                  claim: `The contributing sessions' window ${regimeNote}`,
                  source: 'session transcripts',
                  field: 'version (SessionTokenData) -> promptRegimeForVersion',
                  value: regimeValue,
                },
              ]
            : []),
        ],
        // Footprint-only heuristic: no structured quality-result provenance is
        // available here, so the wording is always the low-confidence candidate
        // form — never a "without quality loss" guarantee (#3199).
        inference:
          routingInference(false) +
          (confounded
            ? ` Additionally, the contributing sessions' window ${regimeNote} ` +
              `(${span.knownCount} versioned sessions, ${span.unknownCount} without a version), ` +
              `so the sessions did not all run under the same Claude Code system prompt, a harness ` +
              `contribution cannot be separated from routable spend, and the finding is reported ` +
              `without escalation.`
            : ''),
      },
    };
  },
};
