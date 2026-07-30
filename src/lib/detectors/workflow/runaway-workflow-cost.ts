/**
 * runaway-workflow-cost — flags a Workflow-tool run whose total token spend is a
 * statistical outlier versus the user's other runs. The token totals identify
 * the outlier, not its cause; a high-spend run may also have produced a useful
 * result. (#635, part of #632)
 *
 * Conservative by design: needs a baseline of runs to call an outlier, and an
 * absolute floor so a set of uniformly-tiny runs never trips it.
 *
 * dataDeps: reads the optional `workflows` field on RecommendationInput. Absent
 * or below the baseline ⇒ silent.
 */
import type { Detector } from '../types';
import type { WorkflowRun } from '../../parse-workflows';
import { scopeKeyOf, type ReclaimClaim } from '../../reclaim';
import { newestEpochDate } from '../shared';

// Need at least this many costed runs before a median is meaningful.
const MIN_RUNS = 4;
// A run must exceed this multiple of the median to count as runaway.
const OUTLIER_FACTOR = 3;
// ...and clear this absolute floor, so uniformly-small runs never trip it.
const ABS_FLOOR_TOKENS = 200_000;

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const detector: Detector = {
  id: 'workflow.runaway-workflow-cost',
  category: 'workflow',
  dataDeps: ['workflows', 'tokenData'],
  rule(input) {
    const costed = (input.workflows ?? []).filter(
      (r): r is WorkflowRun & { totalTokens: number } => typeof r.totalTokens === 'number'
    );
    if (costed.length < MIN_RUNS) return null;

    const med = median(costed.map((r) => r.totalTokens));
    if (med <= 0) return null;

    const outliers = costed
      .filter((r) => r.totalTokens > OUTLIER_FACTOR * med && r.totalTokens > ABS_FLOOR_TOKENS)
      .sort((a, b) => b.totalTokens - a.totalTokens);
    if (!outliers.length) return null;

    const evidence = outliers.slice(0, 5).map(
      (r) =>
        `${r.workflowName} (${r.runId}): ${r.totalTokens.toLocaleString()} tokens, ` +
        `${(r.totalTokens / med).toFixed(1)}x median${r.agentCount != null ? `, ${r.agentCount} agents` : ''}`
    );

    // Fan-out timing-tax dollar lever (#951, doc §3 lever 5): concurrent agents
    // all pay cache-*write* (1.25× the default 5-minute write) and none get the
    // 0.1× *read*, because the cache isn't readable until the first response
    // streams. The counterfactual is warm-one-then-fan: reprice the fanned write
    // pool at the read rate. We emit a `convertRate` claim (cacheWrite5m →
    // cacheRead) scoped to the outlier runs' parent sessions, gated on real
    // concurrency (`agentCount > 1`). It books only where those scopes resolve to
    // real priced 5-minute cache-write cells in tokenData; an unresolved scope is
    // rejected by the cascade precondition (books $0), so a run whose agent spend
    // isn't in the parent's tokenData never fabricates a dollar. The 1-hour write
    // portion is the separate `cost.cache-1h-waste` lever (1h→5m), so this one
    // owns only the default 5-minute write pool and stays a single per-rec claim.
    const fanoutScopes = new Set<string>();
    for (const r of outliers) {
      if ((r.agentCount ?? 0) <= 1) continue; // single-agent ⇒ no fan-out tax
      if (!r.sessionId) continue;
      const model = r.defaultModel || 'unknown';
      fanoutScopes.add(scopeKeyOf(r.sessionId, model));
    }
    let reclaim: ReclaimClaim | undefined;
    if (fanoutScopes.size > 0) {
      reclaim = {
        leverId: 'workflow.runaway-workflow-cost',
        category: 'workflow',
        cause: 'workflow-rework',
        // Behavioural band [10,40): reliability(10) → safety(20) → workflow(30).
        orderKey: 30,
        ownedPools: ['cacheWrite5m'],
        scopeKeys: [...fanoutScopes],
        counterfactual: { kind: 'convertRate', rateFrom: 'cacheWrite5m', rateTo: 'cacheRead' },
        evidenceTokens: 0,
      };
    }

    // Fold over totalTokens (the cited field) rather than reading outliers[0]:
    // the list is sorted by totalTokens today, so the two agree, but taking the
    // max explicitly means a later re-ranking cannot turn "largest outlier" into
    // a false superlative (defect class 5).
    const maxOutlierTokens = Math.max(...outliers.map((r) => r.totalTokens));
    // Anchored to the newest OBSERVED outlier run's start, never to `now`:
    // `WorkflowRun` records no end instant, so the start is the freshest datum;
    // runs with a null/absent start contribute nothing rather than a fabricated
    // date, and an all-undated corpus yields no `asOf`.
    const asOf = newestEpochDate(outliers.map((r) => r.startTime));

    return {
      id: 'workflow.runaway-workflow-cost',
      category: 'workflow',
      severity: 'warning',
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: 'Workflow run is a token-spend outlier',
      detail: `${outliers.length} Workflow-tool run(s) each spent more than ${OUTLIER_FACTOR}x the median run's token total (median ${Math.round(med).toLocaleString()} tokens).`,
      action:
        'Cap the fan-out (concurrency / max agents) or add a budget guard so a single run cannot dominate spend; review the outlier runs in the Workflows view.',
      ...(reclaim ? { reclaim } : {}),
      affected: outliers.length,
      view: 'workflows',
      evidence,
      provenance: {
        observations: [
          {
            claim: `${outliers.length} run(s) exceeded ${OUTLIER_FACTOR}x the median AND the ${ABS_FLOOR_TOKENS.toLocaleString()}-token floor`,
            source: 'parse-workflows (workflows[])',
            field: 'outliers.length',
            value: outliers.length,
          },
          {
            claim: `the median costed run spent ${Math.round(med)} token(s)`,
            source: 'parse-workflows (workflows[])',
            field: 'median(totalTokens)',
            value: Math.round(med),
          },
          {
            claim: `the largest outlier run spent ${maxOutlierTokens.toLocaleString()} token(s)`,
            source: 'parse-workflows (workflows[])',
            field: 'max(outliers[].totalTokens)',
            value: maxOutlierTokens,
          },
        ],
        // A run exceeding OUTLIER_FACTOR x median AND the absolute floor is a
        // statistical token-spend outlier. That is a token-count fact, NOT a
        // diagnosed cause: an unbounded loop or an over-wide parallel stage are
        // possible explanations the counts do not prove, so none is asserted.
        // No output usefulness is measured either — a high-spend run may have
        // produced a good result.
        inference:
          'The flagged runs are token-spend outliers versus the user\'s own median run; ' +
          'the cause of the excess spend is not measured and is not claimed.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
