import type { Detector, RecCategory, RecProvenance } from '../types';
import { avgCostDelta, avgTokenDelta } from '../../parse-shadow-calls';
import type { AxisAggregate } from '../../parse-shadow-calls';
import {
  MIN_SAMPLES,
  MIN_DECIDED,
  MIN_SHADOW_WIN_RATE,
  SHADOW_STALE_DAYS,
  axisAsOf,
} from './shadow-axis-wins';
import { isAsOfStale } from '../provenance';

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
  rule(input, now) {
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

    // Freshness (#3248): date the winning axis from its own newest dated record.
    // Undated OR stale evidence is historical ledger data, not a current
    // discovery — so no copy-paste filing command is offered; the recommendation
    // degrades to an explicit dated lead.
    const asOf = axisAsOf(top);
    const stale = isAsOfStale(asOf, now, SHADOW_STALE_DAYS);
    const dated = asOf !== undefined && !stale;
    const dateNote = asOf
      ? stale
        ? ` As of ${asOf} — older than ${SHADOW_STALE_DAYS} days, so this is a historical lead to confirm live, not a current discovery.`
        : ` As of ${asOf}.`
      : ' This shadow evidence carries no readable date, so treat it as a historical lead, not a current discovery.';

    const title = dated
      ? `New recommendation class to add: "${top.axis}" wins in shadow tests but no rule covers it`
      : `Possible new recommendation class: "${top.axis}" won in shadow tests, but the evidence is ${asOf ? 'stale' : 'undated'}`;
    const issueBody =
      `Shadow-calls (#513) show the "${top.axis}" variation winning ${top.shadowWins}/${d} (${pct}%) over ${top.samples} experiments, ` +
      `but no detector encodes that pattern. Propose a dedicated detector \\\`${suggestedId}\\\`.`;

    // Cite the exact byAxis operands (win/sample/live/replay + paired
    // cost-or-token sum/count) so the percentage and the average are
    // reproducible, and record the AXIS_COVERAGE lookup behind the catalog-gap
    // claim (#3248).
    const deltaObs =
      top.costDeltaCount > 0
        ? [
            {
              claim: `paired cost delta (shadow−main) sums to $${top.costDeltaSum.toFixed(2)}`,
              source: 'parse-shadow-calls (byAxis[])',
              field: 'costDeltaSum',
              value: top.costDeltaSum,
            },
            {
              claim: `over ${top.costDeltaCount} run(s) with both costs known`,
              source: 'parse-shadow-calls (byAxis[])',
              field: 'costDeltaCount',
              value: top.costDeltaCount,
            },
          ]
        : top.tokenDeltaCount > 0
          ? [
              {
                claim: `paired token delta (shadow−main) sums to ${Math.round(top.tokenDeltaSum)}`,
                source: 'parse-shadow-calls (byAxis[])',
                field: 'tokenDeltaSum',
                value: top.tokenDeltaSum,
              },
              {
                claim: `over ${top.tokenDeltaCount} run(s) with both token totals known`,
                source: 'parse-shadow-calls (byAxis[])',
                field: 'tokenDeltaCount',
                value: top.tokenDeltaCount,
              },
            ]
          : [];
    const provenance: RecProvenance = {
      observations: [
        {
          claim: `axis "${top.axis}" recorded ${top.samples} shadow experiment(s)`,
          source: 'parse-shadow-calls (byAxis[])',
          field: 'samples',
          value: top.samples,
        },
        {
          claim: `the variation won ${top.shadowWins} of them`,
          source: 'parse-shadow-calls (byAxis[])',
          field: 'shadowWins',
          value: top.shadowWins,
        },
        {
          claim: `the default (main) won ${top.mainWins}`,
          source: 'parse-shadow-calls (byAxis[])',
          field: 'mainWins',
          value: top.mainWins,
        },
        {
          claim: `${d} comparison(s) were decided (shadow wins + main wins)`,
          source: 'parse-shadow-calls (byAxis[])',
          field: 'shadowWins + mainWins',
          value: d,
        },
        {
          claim: `evidence mix included ${top.live} live experiment(s)`,
          source: 'parse-shadow-calls (byAxis[])',
          field: 'live',
          value: top.live,
        },
        {
          claim: `evidence mix included ${top.replay} replay experiment(s)`,
          source: 'parse-shadow-calls (byAxis[])',
          field: 'replay',
          value: top.replay,
        },
        ...deltaObs,
        {
          claim: `the catalog lists 0 detector(s) covering the "${top.axis}" axis`,
          source: 'detectors/workflow/uncovered-shadow-axis (AXIS_COVERAGE)',
          field: `AXIS_COVERAGE["${top.axis}"]`,
          value: 0,
        },
      ],
      // The win rate is Main-vs-Shadow VERDICT counts, not a controlled
      // measurement of the axis's causal effect. AXIS_COVERAGE is a
      // hand-maintained map of rule INTENT (it cannot be derived mechanically),
      // so "no rule covers it" is only as accurate as that map. When the
      // evidence is undated or stale, it is historical ledger data, so a
      // copy-paste filing command is withheld and an explicit dated lead is
      // surfaced instead.
      inference:
        `The "${top.axis}" axis cleared the win bar (>=${MIN_SAMPLES} samples, >=${MIN_DECIDED} decided, ` +
        `>=${Math.round(MIN_SHADOW_WIN_RATE * 100)}% shadow-win rate) and AXIS_COVERAGE maps it to no covering detector, ` +
        `so it is a new-rule candidate` +
        (dated
          ? '.'
          : `, but on ${asOf ? 'stale' : 'undated'} evidence it is a lead to confirm live, not a current discovery.`),
      ...(asOf ? { asOf, stale } : {}),
    };

    return {
      id: 'workflow.uncovered-shadow-axis',
      category: 'workflow',
      severity: 'info',
      claimClass: 'causal',
      proofTier: 'observational',
      title,
      detail:
        `Shadow experiments favour the "${top.axis}" axis (${top.shadowWins}/${d} = ${pct}% over ${top.samples}), ` +
        `but the recommendation catalog has no rule for it` +
        (costDelta !== null && costDelta < 0
          ? `, and it cost ~$${Math.abs(costDelta).toFixed(2)} less on average`
          : tokenDelta !== null && tokenDelta < 0 ? `, and it ran cheaper (~${Math.abs(Math.round(tokenDelta))} fewer tokens avg)` : '') +
        `. That's a candidate for a new recommendation class. Uncovered axes with wins: ${axesList}.${dateNote}`,
      action: dated
        ? `Propose a dedicated detector (e.g. \`${suggestedId}\`) so this pattern becomes a permanent, ` +
          `verifiable recommendation rather than living only in the ledger. File it as a backlog issue (per the engine-gap feedback loop).`
        : `Before filing, re-run a few live shadows to confirm the "${top.axis}" axis still wins — this evidence is ` +
          `${asOf ? `dated ${asOf} and stale` : 'undated'}, so it is a historical lead, not a current discovery. ` +
          `If it still wins, propose a dedicated detector (e.g. \`${suggestedId}\`).`,
      affected: uncovered.length,
      view: 'recommendations',
      evidence: uncovered.map(
        (a) => `${a.axis}: shadow ${a.shadowWins}/${decided(a)} (${a.live}L+${a.replay}R), no covering rule → suggest ${SUGGESTED_CATEGORY[a.axis] ?? 'workflow'}.shadow-${a.axis}`
      ),
      // A copy-paste `gh issue create` filing command is offered ONLY on dated,
      // in-window evidence. Stale/undated evidence emits no validated filing
      // command (#3248) — the dated lead lives in `detail`/`action` above.
      ...(dated
        ? {
            fix: {
              target: 'command' as const,
              fixKind: 'illustrative' as const,
              label: 'File a new-rule proposal',
              note: 'Discovery proposal (epic #513 / ADR 0002). Dedup against open issues titled "[shadow-discovery]" before filing.',
              snippet:
                `gh issue create --repo shpwrck/claude-history-dashboard --label backlog --label enhancement \\\n` +
                `  --title "[shadow-discovery] New detector for winning axis: ${top.axis}" \\\n` +
                `  --body "${issueBody}"`,
            },
          }
        : {}),
      provenance,
    };
  },
};
