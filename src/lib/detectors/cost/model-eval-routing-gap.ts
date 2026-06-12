/**
 * Detector: cost.model-eval-routing-gap (#1086, epic #975)
 *
 * Surfaces an "act now" routing gap when the committed model-eval evidence
 * (`modelEvalSummary`, the #1085 rollup of `~/.claude/model-evals/results`
 * artifacts threaded into the dataset by #1242) carries at least one scoped
 * routing recommendation that is:
 *   - backed by sufficiently strong evidence (`strongestEvidence` at or above
 *     `objective-task-history`; proxy-detector and token-cost evidence is
 *     discovery-only per the epic's standing rule 4 and never act-now), and
 *   - sufficiently scored (`weightedScore` >= {@link ACT_NOW_MIN_WEIGHTED_SCORE},
 *     recomputed by the schema sanitizer from the canonical 50/25/15/10
 *     weights), and
 *   - non-vetoed: the recommended model's rollup carries NO hard veto. A model
 *     with any veto on record is excluded conservatively — a veto zeroes trust,
 *     not just one run's score.
 *
 * Standing rule 6 (epic #975): the output is a scoped routing RECOMMENDATION
 * requiring explicit user approval — never an automatic registry/default/
 * routing change. The fix is therefore declared `fixKind: 'manual'` (adopting
 * the routing guidance IS the approval step), and the action points at the
 * Model Evals workbench for evidence inspection.
 *
 * Suppressed entirely when the summary is null/empty — the SPA/upload dataset
 * and any `~/.claude` without eval artifacts (#1242 ships `null` there).
 */
import type { Detector, RecommendationInput } from '../types';
import { claudeMdMarksApplied } from '../shared';
import {
  EVIDENCE_STRENGTH_RANK,
  type EvalRoutingRecommendation,
} from '../../model-eval-result';
import type { ModelEvalSummary } from '../../model-eval-ingest';

/** Minimum weighted score for a routing recommendation to be "act now". */
export const ACT_NOW_MIN_WEIGHTED_SCORE = 0.6;

/**
 * Weakest evidence strength (by rank; lower = stronger) that still qualifies
 * as act-now. `objective-task-history` and stronger qualify;
 * `proxy-detector-signal` / `token-cost-discovery` stay discovery-only (rule 4).
 */
export const ACT_NOW_MAX_EVIDENCE_RANK =
  EVIDENCE_STRENGTH_RANK['objective-task-history'];

/** Summary age beyond which the finding is demoted to "as of <date>" (#1102). */
export const STALE_AFTER_DAYS = 14;

/**
 * Whether one routing recommendation qualifies as an act-now gap against its
 * summary: strong-enough evidence, high-enough recomputed score, and a
 * recommended model whose rollup carries no hard veto. Exported so the Model
 * Evals workbench labels rows with the exact same gate the finding fires on.
 */
export function isActNowRoutingGap(
  rec: EvalRoutingRecommendation,
  summary: ModelEvalSummary
): boolean {
  if (rec.weightedScore < ACT_NOW_MIN_WEIGHTED_SCORE) return false;
  if (EVIDENCE_STRENGTH_RANK[rec.strongestEvidence] > ACT_NOW_MAX_EVIDENCE_RANK) {
    return false;
  }
  const rollup = summary.models.find((m) => m.modelId === rec.modelId);
  if (rollup && rollup.vetoes.length > 0) return false;
  return true;
}

/**
 * The act-now routing gaps in a summary, in the summary's deterministic
 * (weightedScore desc) order. Empty for a null/empty summary — the SPA /
 * no-artifacts case.
 */
export function actNowRoutingGaps(
  summary: ModelEvalSummary | null | undefined
): EvalRoutingRecommendation[] {
  if (!summary || summary.artifactCount === 0 || summary.runCount === 0) {
    return [];
  }
  return summary.recommendations.filter((rec) => isActNowRoutingGap(rec, summary));
}

// CLAUDE.md suppression markers (#173): the fix below pastes a "Scoped model
// routing" section whose body carries this distinctive phrase; once the user
// has adopted it, the finding stops nagging.
const MARKERS = {
  headings: [/^##\s+Scoped model routing\b/i],
  bodyPhrases: ['scoped model-routing decision adopted from eval evidence'],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE = '~/.claude/model-evals/results (dataset key modelEvalSummary)';

function gapLine(rec: EvalRoutingRecommendation): string {
  return `${rec.modelId} @ ${rec.scope}: score ${rec.weightedScore.toFixed(2)}, ${rec.strongestEvidence}`;
}

export const detector: Detector = {
  id: 'cost.model-eval-routing-gap',
  category: 'cost',
  dataDeps: ['modelEvalSummary', 'liveConfig'],
  rule(input: RecommendationInput, now: number) {
    // Self-suppress once the scoped routing guidance is written down (#173).
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;

    const summary = input.modelEvalSummary;
    const gaps = actNowRoutingGaps(summary);
    if (!summary || gaps.length === 0) return null;

    const top = gaps[0];
    const generatedMs = Date.parse(summary.generatedAt);
    const asOf = Number.isFinite(generatedMs)
      ? new Date(generatedMs).toISOString().slice(0, 10)
      : summary.generatedAt.slice(0, 10);
    const stale =
      Number.isFinite(generatedMs) && now - generatedMs > STALE_AFTER_DAYS * DAY_MS;

    const plural = gaps.length === 1 ? '' : 's';
    // Stale-input demotion (#1102): an old summary may no longer reflect the
    // current model lineup, so present-tense wording demotes to "as of <date>".
    const title = stale
      ? `Eval evidence supported ${gaps.length} act-now routing gap${plural} (as of ${asOf})`
      : `Eval evidence supports ${gaps.length} act-now routing gap${plural}`;
    const detail = stale
      ? `As of ${asOf} (latest eval summary — results may be stale; re-run the eval batch to refresh): ` +
        `${summary.artifactCount} eval-result artifacts (${summary.runCount} runs) backed a non-vetoed scoped ` +
        `recommendation for ${top.modelId} on ${top.scope} (weighted score ${top.weightedScore.toFixed(2)}, ` +
        `${top.strongestEvidence}). ${top.rationale}`
      : `${summary.artifactCount} eval-result artifacts (${summary.runCount} runs) back a non-vetoed scoped ` +
        `recommendation for ${top.modelId} on ${top.scope} (weighted score ${top.weightedScore.toFixed(2)}, ` +
        `${top.strongestEvidence}). ${top.rationale}`;
    const action =
      `Review the ranked runs and evidence in the Model Evals workbench, then decide whether to adopt the scoped ` +
      `routing guidance. Promotion requires your explicit approval — nothing changes the model registry, ` +
      `defaults, or routing automatically.`;

    const snippetLines = gaps
      .slice(0, 5)
      .map((g) => `- For \`${g.scope}\` tasks, prefer \`${g.modelId}\` (eval weighted score ${g.weightedScore.toFixed(2)}, ${g.strongestEvidence}).`);
    const snippet =
      `## Scoped model routing\n\n` +
      `<!-- scoped model-routing decision adopted from eval evidence (as of ${asOf}) -->\n` +
      `${snippetLines.join('\n')}\n`;

    return {
      id: 'cost.model-eval-routing-gap',
      category: 'cost',
      severity: 'info',
      title,
      detail,
      action,
      affected: gaps.length,
      view: 'model-evals',
      evidence: [
        ...gaps.slice(0, 4).map(gapLine),
        `source: ${SOURCE} (generatedAt: ${summary.generatedAt})`,
      ],
      // Rule 6: a routing change is NOT a copy-paste-safe validated config
      // fragment — adopting it is a deliberate, scoped decision the user makes.
      // `manual` keeps the UI from offering it as a one-click validated fix.
      fix: {
        target: 'CLAUDE.md',
        label: 'Adopt scoped routing guidance',
        note: 'Applying this IS the explicit approval step — adapt the scope/model lines to your routing setup before pasting.',
        snippet,
        fixKind: 'manual',
        appliedMarkers: MARKERS,
      },
      // Auditability contract (#1049): observed facts each cite the artifact
      // dir + summary field; the act-now inference is kept separate; asOf/stale
      // carry the summary's generatedAt for the #1102 wording demotion.
      provenance: {
        observations: [
          {
            claim: `${summary.artifactCount} eval-result artifacts summarize ${summary.runCount} runs`,
            source: SOURCE,
            field: 'artifactCount / runCount',
            value: summary.runCount,
          },
          {
            claim: `top non-vetoed scoped recommendation: ${top.modelId} on ${top.scope} with weighted score ${top.weightedScore.toFixed(2)} (${top.strongestEvidence})`,
            source: SOURCE,
            field: 'recommendations[] (modelId, scope, weightedScore, strongestEvidence)',
            value: top.weightedScore,
          },
          {
            claim: `${gaps.length} recommendation${plural} pass the act-now gate (weightedScore >= ${ACT_NOW_MIN_WEIGHTED_SCORE}, evidence >= objective-task-history, no model veto)`,
            source: SOURCE,
            field: 'recommendations[] x models[].vetoes',
            value: gaps.length,
          },
        ],
        inference:
          `A non-vetoed scoped routing recommendation backed by ` +
          `objective-or-stronger evidence and a weighted score >= ${ACT_NOW_MIN_WEIGHTED_SCORE} is an act-now ` +
          `routing gap. Promotion still requires explicit user approval (epic #975 rule 6); ` +
          `nothing is changed automatically.`,
        asOf,
        stale,
      },
    };
  },
};
