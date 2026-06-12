import type { Detector, RecSeverity, Recommendation, RecProvenance } from '../types';
import { avgTokenDelta, avgCostDelta, shadowCheaper, decidedForFinding } from '../../parse-shadow-calls';
import type { AxisAggregate, RecsFindingAggregate } from '../../parse-shadow-calls';

/**
 * Shadow-calls experiments (epic #513) run the same task two ways — your default (Main)
 * vs one rotated-axis variation (Shadow) — and log the verdict to the ledger. When an
 * axis's Shadow variation consistently matches or beats Main, this detector recommends
 * adopting it. Evidence is **weighted**: live shadows (real, in-the-loop) drive a warning;
 * replay-only evidence (cold-start + staleness caveats) caps at info. (#518/#523)
 *
 * The `recs` axis is special and handled apart from the adopt-this-axis loop (#579,
 * ADR 0005 Tier 2). There Main = the recommendation **injected** and Shadow = it
 * **withheld**, so "adopt the shadow variation" would mean "stop surfacing the
 * recommendation" — nonsense as a generic lead. Instead we emit a PER-FINDING efficacy
 * verdict: a main-win rate quantifies "this finding helped", gated by the #545
 * minimum-DECIDED threshold (below it we report adoption only and withhold any causal
 * claim).
 */
export const MIN_SAMPLES = 5; // per axis, before we trust a win rate
export const MIN_DECIDED = 3; // need ≥3 NON-tie comparisons, not just 5 samples (#545)
export const MIN_SHADOW_WIN_RATE = 0.6; // shadow wins ≥60% of decided experiments
const MIN_LIVE_WINS_FOR_WARNING = 3; // live confirmation lifts info → warning

interface AxisMeta {
  label: string;
  /** What adopting this axis concretely means. */
  adopt: string;
}

const AXIS_META: Record<string, AxisMeta> = {
  model: { label: 'cheaper model', adopt: 'default to the cheaper model tier for this class of task' },
  reasoning: { label: 'different reasoning effort', adopt: 'adjust extended-thinking depth to match what the experiments favoured' },
  prompt: { label: 'structured prompt', adopt: 'frame these tasks with explicit steps / acceptance criteria up front' },
  skills: { label: 'a dedicated skill', adopt: 'route this kind of task through the matching skill (e.g. /diagnose, /tdd)' },
  plugins: { label: 'a plugin workflow', adopt: 'run these through the plugin workflow instead of ad-hoc steps' },
  mcp: { label: 'an MCP server', adopt: 'prefer the MCP path over the native one for these tasks' },
  subagents: { label: 'subagent fan-out', adopt: 'parallelise discovery with subagents / Explore for these tasks' },
  tools: { label: 'a different tool strategy', adopt: 'switch the default tool strategy for these tasks' },
  mode: { label: 'plan-first mode', adopt: 'plan before acting on these tasks' },
  context: { label: 'fresh context', adopt: 'attempt these from a clean context rather than carrying full session state' },
  'config-scoping': { label: 'path-scoped (atomized) config', adopt: 'split always-loaded root CLAUDE.md/AGENTS.md sections into path-scoped .claude/rules files so each rule loads only where it governs' },
};

function meta(axis: string): AxisMeta {
  return AXIS_META[axis] ?? { label: `the "${axis}" variation`, adopt: `adopt the "${axis}" variation as the default` };
}

function decided(a: AxisAggregate): number {
  return a.shadowWins + a.mainWins; // ties don't count toward a win rate
}

/**
 * The single evidence bar an axis must clear before its shadow variation counts as a
 * win: ≥{@link MIN_SAMPLES} samples, ≥{@link MIN_DECIDED} decided (non-tie) comparisons
 * (#545), and a ≥{@link MIN_SHADOW_WIN_RATE} win rate over those decided comparisons.
 * Shared with the #1270 graduation gate so the thresholds cannot drift apart.
 */
export function clearsShadowWinThresholds(a: AxisAggregate): boolean {
  if (a.samples < MIN_SAMPLES) return false;
  const d = decided(a);
  if (d < MIN_DECIDED) return false;
  return a.shadowWins / d >= MIN_SHADOW_WIN_RATE;
}

type Cand = { a: AxisAggregate; winRate: number; cheaper: boolean; costDelta: number | null; tokenDelta: number | null; score: number };

/** The existing adopt-this-axis recommendation, built from the best non-recs candidate. */
function adoptAxisRec(candidates: Cand[]): Recommendation {
  candidates.sort((x, y) => y.score - x.score);
  const best = candidates[0];
  const a = best.a;
  const m = meta(a.axis);

  const liveConfirmed = a.liveShadowWins >= MIN_LIVE_WINS_FOR_WARNING;
  const severity: RecSeverity = liveConfirmed ? 'warning' : 'info';

  const pct = Math.round(best.winRate * 100);
  const evidenceMix = `${a.live} live + ${a.replay} replay`;
  const cheaperStr = best.cheaper
    ? (best.costDelta !== null
        ? ` and cost ~$${Math.abs(best.costDelta).toFixed(2)} less on average`
        : ` and used ~${Math.abs(Math.round(best.tokenDelta as number))} fewer tokens on average`)
    : '';
  const trust = liveConfirmed
    ? `${a.liveShadowWins} of these were confirmed in live, in-the-loop runs`
    : `evidence is mostly from replay (cold-start caveat), so treat this as a lead to confirm live`;

  const other = candidates.slice(1, 3).map((c) => `${meta(c.a.axis).label} (${Math.round(c.winRate * 100)}% over ${c.a.samples})`);

  return {
    id: 'workflow.shadow-axis-wins',
    category: 'workflow',
    severity,
    title: `Adopt ${m.label} — it out-performed your default in shadow tests`,
    detail: `Across ${a.samples} shadow experiment(s) on the "${a.axis}" axis (${evidenceMix}), the variation won ${a.shadowWins}/${decided(a)} decided comparisons (${pct}%)${cheaperStr}. ${trust}.`,
    action: `For this class of task, ${m.adopt}. Re-run a few live shadows to confirm before making it your standing default.`,
    affected: a.samples,
    view: 'recommendations',
    evidence: [
      `${a.axis}: shadow ${a.shadowWins} / main ${a.mainWins} / tie ${a.ties} over ${a.samples} (${evidenceMix})`,
      best.costDelta !== null
        ? `avg $ delta (shadow−main): $${best.costDelta.toFixed(2)}`
        : best.tokenDelta !== null ? `avg token delta (shadow−main): ${Math.round(best.tokenDelta)}` : 'no paired cost/token data',
      ...(other.length ? [`other promising axes: ${other.join(', ')}`] : []),
    ],
    fix: {
      target: 'CLAUDE.md',
      label: 'Adopt the winning variation',
      note: `Shadow-calls evidence (epic #513). Add a standing note so this becomes the default for this kind of task; keep shadowing to catch regressions.`,
      snippet: `## Default approach (from shadow-calls #513)\n\nFor this class of task, ${m.adopt} — shadow experiments on the "${a.axis}" axis won ${pct}% of ${a.samples} comparisons${best.cheaper ? ' at lower token cost' : ''}. Revisit if live shadows stop favouring it.`,
      appliedMarkers: {
        headings: [/^##\s+default approach/i],
        bodyPhrases: ['Revisit if live shadows stop favouring it'],
      },
    },
  };
}

/** Rank findings by strongest evidence: most decided comparisons, then live-weighted, then samples. */
function strongestFinding(byFinding: Record<string, RecsFindingAggregate>): RecsFindingAggregate | null {
  const findings = Object.values(byFinding);
  if (findings.length === 0) return null;
  return findings.slice().sort((x, y) => {
    const dx = decidedForFinding(x);
    const dy = decidedForFinding(y);
    if (dy !== dx) return dy - dx; // more decided comparisons first
    if (y.live !== x.live) return y.live - x.live; // live weighted over replay
    if (y.samples !== x.samples) return y.samples - x.samples;
    return x.findingId.localeCompare(y.findingId); // stable tiebreak
  })[0];
}

/**
 * Per-finding recs efficacy verdict (#579, ADR 0005 Tier 2). `meaningful` is true only
 * once the strongest finding clears the #545 decided gate — the caller uses it to decide
 * whether this verdict headlines over a non-recs adoption lead (a below-threshold
 * adoption note must not bury a real lead).
 */
function recsFindingVerdict(a: AxisAggregate): { rec: Recommendation; meaningful: boolean } | null {
  if (!a.byFinding) return null;
  const f = strongestFinding(a.byFinding);
  if (!f) return null;

  const d = decidedForFinding(f); // f.shadowWins (withheld won) + f.mainWins (injected won)
  const evidenceMix = `${f.live} live + ${f.replay} replay`;
  const findingRow = `${f.findingId}: injected-won ${f.mainWins} / withheld-won ${f.shadowWins} / tie ${f.ties} over ${f.samples} (${evidenceMix})`;

  // Below the #545 minimum-DECIDED threshold: report ADOPTION only, withhold any verdict.
  if (d < MIN_DECIDED) {
    const provenance: RecProvenance = {
      observations: [
        {
          claim: `recommendation "${f.findingId}" was injected in ${f.samples} recs shadow experiment(s); ${d} of them were decided (non-tie)`,
          source: 'parse-shadow-calls (recs.byFinding)',
        },
      ],
      inference: `Below the #545 minimum of ${MIN_DECIDED} decided comparisons, any causal verdict would be noise, so efficacy is withheld and only adoption is reported.`,
    };
    return {
      meaningful: false,
      rec: {
        id: 'workflow.shadow-axis-wins',
        category: 'workflow',
        severity: 'info',
        title: `Gathering efficacy evidence for recommendation "${f.findingId}"`,
        detail: `The "${f.findingId}" recommendation has been injected ${f.samples} time(s) in recs shadow experiments (${evidenceMix}), but only ${d} comparison(s) were decided — below the #545 threshold of ${MIN_DECIDED}. Adoption is tracked; a causal verdict is withheld until enough decided replays accrue.`,
        action: `Keep running recs shadow experiments for this finding. A directional efficacy verdict appears once at least ${MIN_DECIDED} comparisons are decided (non-tie).`,
        affected: f.samples,
        view: 'recommendations',
        evidence: [findingRow],
        provenance,
      },
    };
  }

  // At/above threshold: a bounded DIRECTIONAL verdict, always with the matched-pair (decided) count.
  const mainWinRate = f.mainWins / d; // main = injected; a main win means the finding HELPED
  let severity: RecSeverity;
  let title: string;
  let detail: string;
  let action: string;
  let inference: string;
  if (mainWinRate >= MIN_SHADOW_WIN_RATE) {
    severity = 'info';
    title = `Recommendation "${f.findingId}" is improving outcomes`;
    detail = `Injecting "${f.findingId}" beat withholding it in ${f.mainWins}/${d} decided recs replays (${evidenceMix}). Main = injected, so injecting the recommendation measurably helped.`;
    action = `Keep surfacing this recommendation; the evidence says it earns its place. Re-check as more decided replays accrue.`;
    inference = `Main = injected and won ${f.mainWins}/${d} decided comparisons (≥${Math.round(MIN_SHADOW_WIN_RATE * 100)}%), so injecting the finding improved outcomes.`;
  } else if (mainWinRate <= 1 - MIN_SHADOW_WIN_RATE) {
    severity = 'warning';
    title = `Recommendation "${f.findingId}" is not improving outcomes`;
    detail = `Withholding "${f.findingId}" beat injecting it in ${f.shadowWins}/${d} decided recs replays (${evidenceMix}). Main = injected, so the recommendation did not help — and may be adding noise.`;
    action = `Revisit this recommendation: tighten it, narrow when it fires, or retire it. Withholding it won more decided replays than injecting it.`;
    inference = `Main = injected won only ${f.mainWins}/${d} decided comparisons (≤${Math.round((1 - MIN_SHADOW_WIN_RATE) * 100)}% main-win rate), so injecting the finding did not improve outcomes.`;
  } else {
    severity = 'info';
    title = `Recommendation "${f.findingId}" has no clear efficacy yet`;
    detail = `Injecting "${f.findingId}" won ${f.mainWins}/${d} decided recs replays (${evidenceMix}) — no clear direction either way. Main = injected, so the signal is mixed.`;
    action = `Gather more decided replays for this finding; the current ${d} are split too evenly to call.`;
    inference = `Main = injected won ${f.mainWins}/${d} decided comparisons (between the helped/not thresholds), so the efficacy direction is undecided.`;
  }

  const provenance: RecProvenance = {
    observations: [
      {
        claim: `recommendation "${f.findingId}" (main=injected) won ${f.mainWins} of ${d} decided recs comparisons; withholding won ${f.shadowWins}`,
        source: 'parse-shadow-calls (recs.byFinding)',
      },
    ],
    inference,
  };

  return {
    meaningful: true,
    rec: {
      id: 'workflow.shadow-axis-wins',
      category: 'workflow',
      severity,
      title,
      detail,
      action,
      affected: f.samples,
      view: 'recommendations',
      evidence: [findingRow],
      provenance,
    },
  };
}

export const detector: Detector = {
  id: 'workflow.shadow-axis-wins',
  category: 'workflow',
  dataDeps: ['shadowCalls'],
  rule(input) {
    const agg = input.shadowCalls;
    if (!agg || agg.total === 0 || agg.byAxis.length === 0) return null;

    // The recs axis measures whether INJECTING a recommendation helped (main=injected,
    // shadow=withheld), not whether to adopt a cheaper variation — so it gets a per-finding
    // efficacy verdict, never the generic adopt-this-axis lead (#579).
    const recsAxis = agg.byAxis.find((a) => a.axis === 'recs');
    const recsResult = recsAxis ? recsFindingVerdict(recsAxis) : null;

    const candidates: Cand[] = [];
    for (const a of agg.byAxis) {
      if (a.axis === 'recs') continue; // handled by the per-finding verdict above
      if (!clearsShadowWinThresholds(a)) continue; // samples + decided (#545) + win-rate bar
      const winRate = a.shadowWins / decided(a);
      // Price-aware "cheaper" ($ when available, else raw tokens) — #536.
      const cheaper = shadowCheaper(a) === true;
      const costDelta = avgCostDelta(a);
      const tokenDelta = avgTokenDelta(a);
      // Weight live wins heavily; a cheaper variation is a meaningful bonus.
      const score = a.shadowWins + a.liveShadowWins * 2 + (cheaper ? 2 : 0);
      candidates.push({ a, winRate, cheaper, costDelta, tokenDelta, score });
    }
    const axisRec = candidates.length > 0 ? adoptAxisRec(candidates) : null;

    // Precedence: a DECIDED recs efficacy verdict is the headline signal for epic #573;
    // otherwise surface a non-recs adoption lead; otherwise the below-threshold recs
    // adoption note (which must never bury a real adoption lead).
    if (recsResult?.meaningful) return recsResult.rec;
    if (axisRec) return axisRec;
    if (recsResult) return recsResult.rec;
    return null;
  },
};
