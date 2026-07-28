import type { Detector } from '../types';
import { fmtUsd, isHaikuPinned } from '../shared';
import { computeAgentEffectiveness } from '../../parse-agent-effectiveness';
import type { ReclaimClaim } from '../../reclaim';

// A subagent type whose mean cost per run is high. (#418) What right-sizing
// would recover is NOT claimed here — see the detail/fix notes (#3195).
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
      // No recovery assertion (#3195). The comment above already states this
      // detector has aggregate run-count evidence and no scoped, quality-backed
      // right-sizing claim; the detail used to contradict that by promising it
      // "recovers most of that". Mean cost per run is the measurement; what a
      // cheaper model would recover, at what quality, is unmeasured here.
      detail: `Agent type "${top.agentType}" averages ${fmtUsd(top.meanCostUsd)}/run over ${top.runs} runs${rows.length > 1 ? ` (and ${rows.length - 1} other type(s) over $0.10/run)` : ''}.`,
      action:
        'Pin a cheaper model (e.g. claude-haiku-4-5) for that agent type, narrow its task scope, or cap the context passed to it.',
      reclaim,
      affected: rows.length,
      evidence: rows.slice(0, 5).map((r) => `${r.agentType}: ${fmtUsd(r.meanCostUsd)}/run × ${r.runs}`),
      view: 'agents',
      fix: {
        target: 'settings.json',
        label: 'Pin a cheaper model for the agent',
        // ILLUSTRATIVE, not copy-paste (#3195). A top-level `model` key is a
        // BLANKET pin: it re-routes every task class, including code
        // authoring, not just the flagged agent type. `isBlanketModelPinSnippet`
        // (detectors/fix-validity.ts) exists for exactly this shape, and epic
        // #2138 keeps code authoring on the strong model until a class-scoped
        // replay clears it. Without fixKind this was published as validated.
        fixKind: 'illustrative',
        note:
          'Example only — do NOT paste as-is. A top-level "model" key pins EVERY task class, not just the flagged agent type; apply the cheaper model in the SDK config or agent definition that launches this agent instead.',
        snippet: `{\n  "model": "claude-haiku-4-5"\n}`,
      },
    };
  },
};
