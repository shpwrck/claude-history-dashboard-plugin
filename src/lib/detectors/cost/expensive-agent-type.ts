import type { Detector } from '../types';
import { fmtUsd, isHaikuPinned, newestIsoDate, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import { computeAgentEffectiveness } from '../../parse-agent-effectiveness';
import { AGENT_SPAWN_TOOLS, UNSPECIFIED_BUCKET } from '../../parse-agents';
import type { ReclaimClaim } from '../../reclaim';

// A subagent type whose mean cost per run is high. (#418) What right-sizing
// would recover is NOT claimed here — see the detail/fix notes (#3195).
const MIN_MEAN_COST_USD = 0.1;
const MIN_RUNS = 5;

/** Run evidence older than this demotes to "as of <date>" (#3194). */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

/**
 * Flag subagent types averaging >$0.10/run over >=5 runs. Self-suppresses once
 * Haiku is pinned globally (the cheapest tier is already the default). (#418)
 */
export const detector: Detector = {
  id: 'cost.expensive-agent-type',
  category: 'cost',
  dataDeps: ['agentSettings', 'attribution', 'runtimeEvents', 'toolData', 'tokenData', 'liveConfig'],
  rule(input, now) {
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
    // Dated from the newest OBSERVED spawn of a flagged agent type (the runs
    // being averaged), never `now`. Mirrors `taskAgentType` in
    // parse-agent-effectiveness (private there); unreadable timestamps are
    // skipped, and no readable spawn → no asOf (#3194).
    const flaggedTypes = new Set(rows.map((r) => r.agentType));
    const spawnTimestamps: string[] = [];
    for (const session of input.toolData ?? []) {
      for (const call of session.calls) {
        if (!AGENT_SPAWN_TOOLS.has(call.toolName)) continue;
        const raw = call.input?.subagent_type;
        const agentType =
          typeof raw === 'string' && raw.length > 0 ? raw : UNSPECIFIED_BUCKET;
        if (flaggedTypes.has(agentType)) spawnTimestamps.push(call.timestamp);
      }
    }
    const asOf = newestIsoDate(spawnTimestamps);
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);
    const datePrefix = stale ? `As of ${asOf} (dated evidence): ` : '';
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
      detail: `${datePrefix}Agent type "${top.agentType}" averages ${fmtUsd(top.meanCostUsd)}/run over ${top.runs} runs${rows.length > 1 ? ` (and ${rows.length - 1} other type(s) over $0.10/run)` : ''}.`,
      action:
        'Pin a cheaper model (e.g. claude-haiku-4-5) for that agent type, narrow its task scope, or cap the context passed to it.',
      reclaim,
      affected: rows.length,
      evidence: rows.slice(0, 5).map((r) => `${r.agentType}: ${fmtUsd(r.meanCostUsd)}/run × ${r.runs}`),
      view: 'agents',
      // Auditability contract (#1049/#3194): run counts come from Task/Agent
      // spawn calls; the mean cost is the attribution-share calculation named
      // below. What right-sizing would recover stays unclaimed (#3195).
      provenance: {
        observations: [
          {
            claim: `agent type "${top.agentType}" was spawned ${top.runs} times`,
            source: 'parse-tools',
            field: 'toolData[].calls[] (Task/Agent spawns, input.subagent_type)',
            value: top.runs,
          },
          {
            claim: `"${top.agentType}" averages ${fmtUsd(top.meanCostUsd)} per run — each session's estimated cost is attributed to its agents in proportion to their outputTokens share, then divided by that agent's run count`,
            source: 'parse-agents x parse-sessions (computeAgentEffectiveness)',
            field: 'attribution[].agents[].outputTokens x tokenData[].entries (estimateCost) / runs',
            value: top.meanCostUsd,
          },
          {
            claim: `${rows.length} agent type(s) average more than $${MIN_MEAN_COST_USD.toFixed(2)}/run over at least ${MIN_RUNS} runs`,
            source: 'parse-agent-effectiveness',
            field: 'rows[] (meanCostUsd, runs)',
            value: rows.length,
          },
        ],
        inference:
          'Mean cost per run is the whole measurement. What a cheaper model would ' +
          'recover — and at what quality — is unmeasured here (#3195), so nothing is ' +
          'booked and the model-pin fix is illustrative only; the thresholds are ' +
          'awareness gates, not a right-sizing claim.',
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
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
