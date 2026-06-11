/**
 * runaway-workflow-cost — flags a Workflow-tool run whose total token spend is a
 * statistical outlier versus the user's other runs: a fan-out that burned far
 * more than its peers (often an unbounded loop or an over-wide parallel stage).
 * (#635, part of #632)
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

    return {
      id: 'workflow.runaway-workflow-cost',
      category: 'workflow',
      severity: 'warning',
      title: 'Workflow run with runaway fan-out cost',
      detail: `${outliers.length} Workflow-tool run(s) burned more than ${OUTLIER_FACTOR}x the median run's token spend (median ${Math.round(med).toLocaleString()} tokens) — a sign of an unbounded loop or an over-wide parallel stage.`,
      action:
        'Cap the fan-out (concurrency / max agents) or add a budget guard so a single run cannot dominate spend; review the outlier runs in the Workflows view.',
      ...(reclaim ? { reclaim } : {}),
      affected: outliers.length,
      view: 'workflows',
      evidence,
    };
  },
};
