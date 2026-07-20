import type { Detector, RecCategory } from '../types';
import { avgCostDelta, avgTokenDelta } from '../../parse-shadow-calls';
import type { AxisAggregate } from '../../parse-shadow-calls';

/**
 * Discovery: cross-reference shadow-calls wins against the existing rule catalog and
 * flag a **new class of recommendation** the catalog doesn't yet cover (epic #513, #530;
 * realizes ADR 0002's discovery pipeline with shadow-calls as the source).
 *
 * `workflow.shadow-axis-wins` says "adopt axis X". This detector asks the next question:
 * does the engine already have a *dedicated rule* for that win pattern? If an axis wins
 * consistently AND no existing detector encodes that concern, that's a gap worth a new
 * rule — surfaced here as a recommendation whose fix is the `gh issue` command. It then
 * rides the standing "file a backlog issue for engine gaps" loop (#511) to become a
 * proposal. The richer LLM-driven discovery (free-form patterns, draft PRs, scheduled
 * passes) stays out-of-band per ADR 0002; this is the deterministic MVP.
 */
const MIN_SAMPLES = 5;
const MIN_DECIDED = 3; // ≥3 non-tie comparisons, not just samples (#545)
const MIN_SHADOW_WIN_RATE = 0.6;

/**
 * Which existing detectors already recommend adopting the approach an axis represents.
 * A non-empty list = the concern is COVERED (enhance that rule instead of inventing one).
 * Empty = UNCOVERED → a new-rule candidate. Heuristic + hand-maintained; revisit when the
 * catalog changes (it cross-references rule *intent*, which can't be derived mechanically).
 */
const AXIS_COVERAGE: Record<string, string[]> = {
  model: ['cost.legacy-model-overpay', 'cost.unknown-model'], // already nudge model choice
  tools: ['workflow.native-bypass'], // already nudge tool strategy
  context: ['context.over-window', 'context.repeated-compactions'], // already nudge context mgmt
  'config-scoping': ['context.over-scoped-config-section'], // #1270 graduation gate consumes this axis
  prompt: ['workflow.shadow-prompt'], // #2555 — dedicated auditable per-variation prompt card
  // Uncovered — no rule recommends adopting these per task class:
  reasoning: [],
  skills: [],
  plugins: [],
  mcp: [],
  subagents: [],
  mode: [],
};

// Only UNCOVERED axes need a suggested category. `prompt` is intentionally
// absent: it is covered by `workflow.shadow-prompt` (AXIS_COVERAGE above), so it
// never reaches the new-rule suggestion path — same as the other covered axes.
const SUGGESTED_CATEGORY: Record<string, RecCategory> = {
  reasoning: 'context', skills: 'workflow', plugins: 'workflow',
  mcp: 'workflow', subagents: 'workflow', mode: 'workflow',
};

function decided(a: AxisAggregate): number {
  return a.shadowWins + a.mainWins;
}

export const detector: Detector = {
  id: 'workflow.uncovered-shadow-axis',
  category: 'workflow',
  dataDeps: ['shadowCalls'],
  rule(input) {
    const agg = input.shadowCalls;
    // `counted` (real rows) is the old `total` semantics; `total` now includes
    // synthetic/skipped lines and must NOT gate real-evidence detectors (#2149).
    if (!agg || agg.counted === 0) return null;

    const uncovered = agg.byAxis
      .filter((a) => {
        if (a.samples < MIN_SAMPLES) return false;
        const d = decided(a);
        if (d < MIN_DECIDED || a.shadowWins / d < MIN_SHADOW_WIN_RATE) return false;
        const cov = AXIS_COVERAGE[a.axis];
        return cov !== undefined && cov.length === 0; // strong win + no existing rule
      })
      .sort((x, y) => y.shadowWins - x.shadowWins);

    if (uncovered.length === 0) return null;

    const top = uncovered[0];
    const d = decided(top);
    const pct = Math.round((top.shadowWins / d) * 100);
    const cat = SUGGESTED_CATEGORY[top.axis] ?? 'workflow';
    const suggestedId = `${cat}.shadow-${top.axis}`;
    const costDelta = avgCostDelta(top); // price-aware (#536)
    const tokenDelta = avgTokenDelta(top);

    const axesList = uncovered.map((a) => a.axis).join(', ');
    const title = `New recommendation class to add: "${top.axis}" wins in shadow tests but no rule covers it`;
    const issueBody =
      `Shadow-calls (#513) show the "${top.axis}" variation winning ${top.shadowWins}/${d} (${pct}%) over ${top.samples} experiments, ` +
      `but no detector encodes that pattern. Propose a dedicated detector \\\`${suggestedId}\\\`.`;

    return {
      id: 'workflow.uncovered-shadow-axis',
      category: 'workflow',
      severity: 'info',
      title,
      detail:
        `Shadow experiments favour the "${top.axis}" axis (${top.shadowWins}/${d} = ${pct}% over ${top.samples}), ` +
        `but the recommendation catalog has no rule for it` +
        (costDelta !== null && costDelta < 0
          ? `, and it cost ~$${Math.abs(costDelta).toFixed(2)} less on average`
          : tokenDelta !== null && tokenDelta < 0 ? `, and it ran cheaper (~${Math.abs(Math.round(tokenDelta))} fewer tokens avg)` : '') +
        `. That's a candidate for a new recommendation class. Uncovered axes with wins: ${axesList}.`,
      action:
        `Propose a dedicated detector (e.g. \`${suggestedId}\`) so this pattern becomes a permanent, ` +
        `verifiable recommendation rather than living only in the ledger. File it as a backlog issue (per the engine-gap feedback loop).`,
      affected: uncovered.length,
      view: 'recommendations',
      evidence: uncovered.map(
        (a) => `${a.axis}: shadow ${a.shadowWins}/${decided(a)} (${a.live}L+${a.replay}R), no covering rule → suggest ${SUGGESTED_CATEGORY[a.axis] ?? 'workflow'}.shadow-${a.axis}`
      ),
      fix: {
        target: 'command',
        label: 'File a new-rule proposal',
        note: 'Discovery proposal (epic #513 / ADR 0002). Dedup against open issues titled "[shadow-discovery]" before filing.',
        snippet:
          `gh issue create --repo shpwrck/claude-history-dashboard --label backlog --label enhancement \\\n` +
          `  --title "[shadow-discovery] New detector for winning axis: ${top.axis}" \\\n` +
          `  --body "${issueBody}"`,
      },
    };
  },
};
