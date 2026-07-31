import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, fmtUsd, newestTokenDataDate, short, MIN_SAVINGS_USD, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import { estimateCost } from '../../parse-sessions';
import { topExpensiveSessions } from '../../cost-attribution';

const MARKERS_EXPENSIVE_SESSIONS: AppliedMarkers = {
  headings: [/^##\s+Session scope\b/i],
  bodyPhrases: ['start a fresh session when the task changes'],
};

/** Spend evidence older than this demotes to "as of <date>" (#3194). */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

/** The few sessions that dominate spend — worth reviewing for waste. */
export const detector: Detector = {
  id: 'cost.expensive-sessions',
  appliedMarkers: MARKERS_EXPENSIVE_SESSIONS,
  category: 'cost',
  dataDeps: ['tokenData', 'toolData', 'liveConfig'],
  rule(input, now) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_EXPENSIVE_SESSIONS)) return null;
    const top = topExpensiveSessions(input.tokenData, input.toolData, 5);
    const totalCost = input.tokenData.reduce((s, d) => s + estimateCost(d), 0);
    // #3516 review: estimateCost zero-prices unknown-model sessions, so the
    // share denominator covers PRICED spend only. Count the excluded sessions
    // and say so in provenance — a share over survivors must not read as a
    // share over everything (the EvidenceCoverage rule, #3514).
    const unpricedSessions = input.tokenData.filter((d) => d.hasUnknownModel).length;
    const top3 = top.slice(0, 3);
    const top3Cost = top3.reduce((s, r) => s + r.estimatedCost, 0);
    // Materiality gate on OBSERVED spend — not a savings threshold (#3196).
    if (totalCost <= 0 || top3Cost < MIN_SAVINGS_USD) return null;
    const share = (top3Cost / totalCost) * 100;
    // Only worth flagging when spend is concentrated in a handful of sessions.
    if (share < 25 || input.tokenData.length < 5) return null;
    // Dated from the newest OBSERVED entry across the corpus the share is
    // computed over (never `now`); no readable timestamps → no asOf (#3194).
    const asOf = newestTokenDataDate(input.tokenData);
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);
    const datePrefix = stale ? `As of ${asOf} (dated evidence): ` : '';
    return {
      id: 'cost.expensive-sessions',
      category: 'cost',
      severity: 'info',
      title: 'Spend is concentrated in a few sessions',
      detail: `${datePrefix}The top 3 sessions account for ${share.toFixed(0)}% of estimated priced spend (${fmtUsd(top3Cost)} of ${fmtUsd(totalCost)}${unpricedSessions > 0 ? `; ${unpricedSessions} unknown-model session(s) excluded as unpriced` : ''}).`,
      action:
        'Review these sessions for runaway context or repeated work that could be scoped down or split.',
      // No estSavingsUsd (#3196). `top3Cost` is the full OBSERVED cost of those
      // three sessions. Booking it as savings asserts that session-scoping
      // guidance eliminates 100% of their spend — but this detector measures
      // concentration, not waste, and most of that cost is work the user
      // wanted done. The concentration figure is an accounting claim and stays;
      // the recoverable fraction is a counterfactual nobody has measured.
      affected: top3.length,
      evidence: top3.map(
        (r) => `${short(r.sessionId)}, ${fmtUsd(r.estimatedCost)}, ${r.topTool ?? 'no tools'}`
      ),
      view: 'cost',
      // Auditability contract (#1049/#3194): observed costs are cited per
      // artifact/field; the concentration share is a named derivation; the
      // no-savings stance (#3196) is stated in the inference.
      provenance: {
        observations: [
          {
            claim: `the 3 most expensive sessions have a combined estimated cost of ~${fmtUsd(top3Cost)}`,
            source: 'cost-attribution (topExpensiveSessions)',
            field: 'tokenData[].entries (token counts x pricing-registry rates, estimateCost)',
            value: top3Cost,
          },
          {
            claim: `estimated priced spend across ${input.tokenData.length} parsed sessions is ~${fmtUsd(totalCost)}`,
            source: 'parse-sessions',
            field: 'tokenData[].entries (token counts x pricing-registry rates, estimateCost)',
            value: totalCost,
          },
          {
            claim: `${unpricedSessions} session(s) carry unrecognized-model spend that estimateCost zero-prices, so their real spend is excluded from every total and share here`,
            source: 'parse-sessions',
            field: 'count(tokenData[] where hasUnknownModel)',
            value: unpricedSessions,
          },
          {
            claim: `the single most expensive session cost ~${fmtUsd(top3[0].estimatedCost)}`,
            source: 'cost-attribution (topExpensiveSessions)',
            record: short(top3[0].sessionId),
            field: 'estimatedCost',
            value: top3[0].estimatedCost,
          },
        ],
        derivations: [
          {
            id: 'top3-share-of-spend',
            formula: 'top3CostUsd / pricedTotalCostUsd',
            operands: { top3CostUsd: top3Cost, pricedTotalCostUsd: totalCost },
            value: top3Cost / totalCost,
          },
        ],
        inference:
          'Concentration is the whole claim: a quarter or more of estimated spend in ' +
          'three sessions is worth a review for runaway context or repeated work. How ' +
          'much of that observed spend was recoverable waste is an unmeasured ' +
          'counterfactual, so no savings figure is booked (#3196).',
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Add session-scoping guidance',
        note: 'Paste into CLAUDE.md to curb the runaway-context pattern behind the top sessions.',
        snippet: `## Session scope\n- Keep one session to one task; start a fresh session when the task changes so stale context is not re-sent and re-billed each turn.\n- Compact or clear once a sub-task is done rather than letting context grow unbounded.\n- Avoid re-reading large files or directories repeatedly in a single session; reference them once.`,
        appliedMarkers: MARKERS_EXPENSIVE_SESSIONS,
      },
    };
  },
};
