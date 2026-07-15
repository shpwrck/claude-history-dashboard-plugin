import type { Detector } from '../types';
import { fmtUsd, isHaikuPinned } from '../shared';
import { computeAgentEffectiveness } from '../../parse-agent-effectiveness';
import type { ReclaimClaim } from '../../reclaim';

// A subagent type whose mean cost per run is high — right-sizing its model
// recovers most of that. (#418)
const MIN_MEAN_COST_USD = 0.1;
const MIN_RUNS = 5;

/**
 * Flag subagent types averaging >$0.10/run over >=5 runs. Self-suppresses once
 * Haiku is pinned globally (the cheapest tier is already the default). (#418)
 */
export const detector: Detector = {
  id: 'cost.expensive-agent-type',
  category: 'cost',
  dataDeps: ['agentSettings', 'attribution', 'runtimeEvents', 'toolData', 'tokenData', 'liveConfig'],
  rule(input) {
    if (isHaikuPinned(input.liveConfig?.settings)) return null;
    const rows = computeAgentEffectiveness(
      input.agentSettings ?? [],
      input.attribution ?? [],
      input.runtimeEvents ?? [],
      input.toolData,
      input.tokenData
    ).filter((r) => r.meanCostUsd > MIN_MEAN_COST_USD && r.runs >= MIN_RUNS);
    if (rows.length === 0) return null;
    rows.sort((a, b) => b.meanCostUsd - a.meanCostUsd);
    const top = rows[0];
    // Flag-only in the closed PR1 cascade: this detector has aggregate run-count
    // evidence but no scoped, quality-backed model-right-sizing claim. It carries
    // evidence for per-category coverage, books $0, and mutates no residual.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.expensive-agent-type',
      category: 'cost',
      orderKey: 85,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 0,
    };
    return {
      id: 'cost.expensive-agent-type',
      category: 'cost',
      severity: 'info',
      title: 'High mean cost per agent run',
      detail: `Agent type "${top.agentType}" averages ${fmtUsd(top.meanCostUsd)}/run over ${top.runs} runs${rows.length > 1 ? ` (and ${rows.length - 1} other type(s) over $0.10/run)` : ''}; right-sizing its model recovers most of that.`,
      action:
        'Pin a cheaper model (e.g. claude-haiku-4-5) for that agent type, narrow its task scope, or cap the context passed to it.',
      reclaim,
      affected: rows.length,
      evidence: rows.slice(0, 5).map((r) => `${r.agentType}: ${fmtUsd(r.meanCostUsd)}/run × ${r.runs}`),
      view: 'agents',
      fix: {
        target: 'settings.json',
        label: 'Pin a cheaper model for the agent',
        note: 'Set a cheaper model in the SDK config / settings.json that launches the flagged agent type.',
        snippet: `{\n  "model": "claude-haiku-4-5"\n}`,
      },
    };
  },
};
