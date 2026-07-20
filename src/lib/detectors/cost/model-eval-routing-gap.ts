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
import {
  UNKNOWN_INTENT_CLASS,
  canonicalScopeKey,
  type SemanticIntentClassifier,
  type SemanticIntentSummary,
} from '../../semantic-intent';

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

// ------------------------------------------------------------------ #2647
// Semantic scoping: NARROW an existing claim, never make a new one.
//
// The offline intent rows (#2574) say what a call was ABOUT. They say nothing
// about whether a cheaper model handles it well — that is what the eval receipt
// already established. So the enrichment below is deliberately powerless in one
// direction: it can only refine the SCOPE of a recommendation that has already
// passed `isActNowRoutingGap` on its own evidence. It can never make a card
// fire, never raise a severity, and never widen a scope. If every semantic input
// is missing, stale, hedged, or contradictory, the detector emits exactly the
// card it emitted before #2647 — which is what makes the enrichment safe to run
// on partial evidence.

/** Minimum joined rows before a semantic class may scope a recommendation. */
export const SEMANTIC_MIN_ROWS = 5;
/**
 * Share of joined rows one class must hold to scope the card. Below it the
 * corpus is genuinely mixed, and picking the plurality would present a coin-flip
 * as a scope. Suppressing the enrichment (not the card) is the honest outcome.
 */
export const SEMANTIC_MIN_DOMINANCE = 0.6;
/** Semantic evidence older than this stops scoping (the classifier corpus drifts). */
export const SEMANTIC_STALE_AFTER_DAYS = 14;
/** Clock-skew tolerance before semantic evidence counts as impossibly future-dated. */
export const SEMANTIC_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** A semantic class that has earned the right to narrow one routing card. */
export interface SemanticRoutingScope {
  /** The intent class the joined rows agree on. */
  intentClass: string;
  /** The canonical task class it refines — the recommendation's own scope. */
  canonicalTaskClass: string;
  /**
   * Joined rows carrying the DOMINANT class. Distinct from `classifiedRows`:
   * conflating them made the card say "6/8 classified calls" when all 8 were
   * classified (6 one way, 2 another) — a false coverage claim on a card whose
   * whole purpose is to be auditable.
   */
  dominantClassRows: number;
  /** Rows joining this scope whose class is trusted (ANY class, not just the dominant one). */
  classifiedRows: number;
  /** Rows joining this scope at all, including those degraded to `unknown`. */
  joinedRows: number;
  /** dominantClassRows / joinedRows. */
  dominance: number;
  /** Mean classifier confidence over the contributing rows. */
  meanConfidence: number;
  classifier: SemanticIntentClassifier;
  asOf: string;
}

/**
 * The semantic class that may scope `rec`, or null.
 *
 * Null — meaning "emit the unenriched card" — for every one of: no summary (flag
 * off / SPA / no artifacts), no rows joining this exact canonical class, too few
 * joined rows, an ambiguous split, an all-`unknown` corpus, stale evidence, or
 * more than one classifier identity in play.
 *
 * The last is worth naming: two classifiers may well agree, but provenance has
 * to cite ONE identity+revision for the claim to be reproducible, and a card
 * that cannot say which model produced its scope is not auditable. Suppressing
 * is cheaper than a provenance line nobody can act on.
 */
export function semanticRoutingScope(
  rec: EvalRoutingRecommendation,
  semanticIntent: SemanticIntentSummary | null | undefined,
  now: number
): SemanticRoutingScope | null {
  if (!semanticIntent || semanticIntent.rowCount === 0) return null;
  // One identity, or no scoping (see above).
  if (semanticIntent.classifiers.length !== 1) return null;
  const classifier = semanticIntent.classifiers[0];

  // Exact class pair: only rows the classifier itself projected onto THIS
  // canonical task class may scope a recommendation about that class. Both
  // sides are normalized through the SAME scope-key function, so the join
  // cannot drift from what the sanitizer accepted (#2647 review: real cluster
  // IDs like `gap:haiku-sonnet:failure:small` were being rejected by a
  // taxonomy-label validator, which silently killed the join in production).
  const scopeKey = canonicalScopeKey(rec.scope);
  if (!scopeKey) return null;
  const joined = semanticIntent.rows.filter(
    (row) => row.canonicalTaskClass === scopeKey
  );
  if (joined.length < SEMANTIC_MIN_ROWS) return null;

  const byClass = new Map<string, { count: number; confidenceSum: number }>();
  for (const row of joined) {
    if (row.intentClass === UNKNOWN_INTENT_CLASS) continue;
    const acc = byClass.get(row.intentClass) ?? { count: 0, confidenceSum: 0 };
    acc.count += 1;
    acc.confidenceSum += row.confidence;
    byClass.set(row.intentClass, acc);
  }
  if (byClass.size === 0) return null;

  // Dominance is measured against ALL joined rows, not just the classified ones:
  // a corpus that is 80% `unknown` has not identified a dominant intent, and
  // dividing by the classified subset would hide exactly that.
  const ranked = [...byClass.entries()].sort(
    (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1)
  );
  const [intentClass, top] = ranked[0];
  const dominance = top.count / joined.length;
  if (dominance < SEMANTIC_MIN_DOMINANCE) return null;
  // A tie at the top is ambiguous even when the pair clears the threshold.
  if (ranked.length > 1 && ranked[1][1].count === top.count) return null;

  // Freshness is gated on the DOMINANT-CLASS rows — the ones that actually
  // support the class this card will assert. Two weaker scopings were rejected
  // on the way here, and this is the third and narrowest:
  //   - the summary's aggregate `asOf` lets a recent row for an UNRELATED scope
  //     launder stale rows for this one;
  //   - the joined-row max lets a fresh MINORITY class inside this scope launder
  //     the dominant class (5 stale `bug-triage` + 3 today `refactor` still
  //     scopes to `bug-triage`, and would have printed today's date);
  //   - only the dominant class's own rows can honestly date the claim.
  // The GATE compares full timestamps; only the DISPLAY value is truncated to a
  // date. Truncating first silently widens both bounds by up to a day — a row
  // timestamped 23:59 tomorrow reduces to midnight tomorrow and slips through a
  // 24h future tolerance despite being nearly 48h ahead.
  let asOfMs: number | null = null;
  for (const row of joined) {
    if (row.intentClass !== intentClass) continue;
    const ms = Date.parse(row.classifiedAt);
    if (!Number.isFinite(ms)) continue;
    if (asOfMs === null || ms > asOfMs) asOfMs = ms;
  }
  if (asOfMs === null) return null;
  if (now - asOfMs > SEMANTIC_STALE_AFTER_DAYS * DAY_MS) return null;
  // Future-dated evidence is unusable, and a plain `now - asOfMs > window` check
  // never catches it: the difference goes negative and the row stays "fresh"
  // forever. A skewed classifier host or a malformed receipt would then narrow a
  // current card with evidence dated in the future, and the card would print
  // that impossible date as its provenance. One day of tolerance absorbs
  // ordinary clock skew between the classifier host and this one.
  if (asOfMs > now + SEMANTIC_FUTURE_TOLERANCE_MS) return null;

  return {
    intentClass,
    canonicalTaskClass: scopeKey,
    dominantClassRows: top.count,
    classifiedRows: [...byClass.values()].reduce((n, e) => n + e.count, 0),
    joinedRows: joined.length,
    dominance,
    meanConfidence: top.confidenceSum / top.count,
    classifier,
    // Display only: the newest row that actually contributed to THIS scope, so
    // the date the card cites is the date of the evidence behind it. The gates
    // above compared full timestamps, not this truncated value.
    asOf: new Date(asOfMs).toISOString().slice(0, 10),
  };
}

/**
 * Dedup key for one class/model routing card.
 *
 * #2318 will publish a per-class local-downroute card. When it lands, both it
 * and this detector could describe the SAME (model, class) pair, and a user
 * seeing two cards for one decision would reasonably read them as two
 * independent findings. Whoever lands #2318 should fold the semantic scoping
 * into that single card rather than emitting both — this key is the join point,
 * and `model-eval-routing-gap.test.ts` pins that this detector emits at most one
 * card per pair so the fold has a stable invariant to build on.
 */
export function routingCardKey(modelId: string, scope: string): string {
  return `${modelId} ${scope}`;
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
const SEMANTIC_SOURCE =
  '~/.claude/model-evals/semantic-intent (dataset key semanticIntent, opt-in via CHD_SEMANTIC_INTENT=1)';

function gapLine(rec: EvalRoutingRecommendation): string {
  return `${rec.modelId} @ ${rec.scope}: score ${rec.weightedScore.toFixed(2)}, ${rec.strongestEvidence}`;
}

export const detector: Detector = {
  id: 'cost.model-eval-routing-gap',
  appliedMarkers: MARKERS,
  category: 'cost',
  dataDeps: ['modelEvalSummary', 'liveConfig', 'semanticIntent'],
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

    // #2647: may narrow the TOP gap's scope; never affects whether we got here.
    const semantic = semanticRoutingScope(top, input.semanticIntent, now);
    // The phrase used wherever the card names what the recommendation covers.
    // Unenriched, that is the eval receipt's own coarse scope — byte-identical
    // to the pre-#2647 wording.
    const scopeLabel = semantic
      ? `${top.scope} / ${semantic.intentClass}`
      : top.scope;

    const plural = gaps.length === 1 ? '' : 's';
    // Stale-input demotion (#1102): an old summary may no longer reflect the
    // current model lineup, so present-tense wording demotes to "as of <date>".
    const title = stale
      ? `Eval evidence supported ${gaps.length} act-now routing gap${plural} (as of ${asOf})`
      : `Eval evidence supports ${gaps.length} act-now routing gap${plural}`;
    const detail = stale
      ? `As of ${asOf} (latest eval summary — results may be stale; re-run the eval batch to refresh): ` +
        `${summary.artifactCount} eval-result artifacts (${summary.runCount} runs) backed a non-vetoed scoped ` +
        `recommendation for ${top.modelId} on ${scopeLabel} (weighted score ${top.weightedScore.toFixed(2)}, ` +
        `${top.strongestEvidence}). ${top.rationale}`
      : `${summary.artifactCount} eval-result artifacts (${summary.runCount} runs) back a non-vetoed scoped ` +
        `recommendation for ${top.modelId} on ${scopeLabel} (weighted score ${top.weightedScore.toFixed(2)}, ` +
        `${top.strongestEvidence}). ${top.rationale}`;
    // Said out loud on the card: the narrowing came from the classifier, the
    // QUALITY claim did not. A reader must be able to tell which half of this
    // recommendation the eval receipt is answering for.
    const semanticNote = semantic
      ? ` Offline intent classification narrows this to \`${semantic.intentClass}\` work ` +
        `(${semantic.dominantClassRows} of ${semantic.joinedRows} joined calls, ` +
        `${semantic.classifiedRows} of which were classified at all; mean confidence ` +
        `${semantic.meanConfidence.toFixed(2)}, ${semantic.classifier.id}@${semantic.classifier.revision}, ` +
        `as of ${semantic.asOf}) — that scopes the guidance; the quality evidence above is what supports it.`
      : '';
    const action =
      `Review the ranked runs and evidence in the Model Evals workbench, then decide whether to adopt the scoped ` +
      `routing guidance. Promotion requires your explicit approval — nothing changes the model registry, ` +
      `defaults, or routing automatically.`;

    // Only the TOP gap is semantically scoped — it is the only one whose class
    // pair was joined. Writing the narrowed class onto the other lines would
    // claim a scope their own evidence never established.
    const snippetLines = gaps
      .slice(0, 5)
      .map((g) =>
        g === top && semantic
          ? `- For \`${g.scope}\` tasks classified as \`${semantic.intentClass}\`, prefer \`${g.modelId}\` (eval weighted score ${g.weightedScore.toFixed(2)}, ${g.strongestEvidence}; intent scope from ${semantic.classifier.id}@${semantic.classifier.revision}).`
          : `- For \`${g.scope}\` tasks, prefer \`${g.modelId}\` (eval weighted score ${g.weightedScore.toFixed(2)}, ${g.strongestEvidence}).`
      );
    const snippet =
      `## Scoped model routing\n\n` +
      `<!-- scoped model-routing decision adopted from eval evidence (as of ${asOf}) -->\n` +
      `${snippetLines.join('\n')}\n`;

    return {
      id: 'cost.model-eval-routing-gap',
      category: 'cost',
      severity: 'info',
      title,
      detail: detail + semanticNote,
      action,
      affected: gaps.length,
      view: 'model-evals',
      evidence: [
        ...gaps.slice(0, 4).map(gapLine),
        `source: ${SOURCE} (generatedAt: ${summary.generatedAt})`,
        ...(semantic
          ? [
            `intent scope: ${semantic.intentClass} for ${routingCardKey(top.modelId, top.scope)} ` +
              `(${semantic.dominantClassRows}/${semantic.joinedRows} joined rows, ` +
              `${semantic.classifiedRows} classified, dominance ${semantic.dominance.toFixed(2)}, ` +
              `mean confidence ${semantic.meanConfidence.toFixed(2)})`,
            `source: ${SEMANTIC_SOURCE} (classifier ${semantic.classifier.id}@${semantic.classifier.revision}, as of ${semantic.asOf})`,
          ]
          : []),
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
          // #2647: the semantic half of the claim, cited separately from the
          // eval half so an auditor can see exactly which artifact set supports
          // WHICH part — scope vs quality.
          ...(semantic
            ? [
              {
                claim:
                  `${semantic.dominantClassRows} of ${semantic.joinedRows} calls joined to scope ` +
                  `${top.scope} carry intent class "${semantic.intentClass}" ` +
                  `(${semantic.classifiedRows} of those ${semantic.joinedRows} were classified at all; ` +
                  `dominance ${semantic.dominance.toFixed(2)}, mean confidence ${semantic.meanConfidence.toFixed(2)})`,
                source: SEMANTIC_SOURCE,
                field: 'rows[] (canonicalTaskClass, intentClass, confidence)',
                value: semantic.dominantClassRows,
              },
              {
                claim:
                  `intent classes produced by ${semantic.classifier.id}@${semantic.classifier.revision}, ` +
                  `newest classified call ${semantic.asOf}`,
                source: SEMANTIC_SOURCE,
                field: 'classifiers[] (id, revision) / asOf',
                value: semantic.asOf,
              },
              {
                claim:
                  `the scoped model/class pair is ${routingCardKey(top.modelId, top.scope)}, backed by ` +
                  `${summary.runCount} eval runs at ${top.strongestEvidence}`,
                source: `${SOURCE} + ${SEMANTIC_SOURCE}`,
                field: 'recommendations[].modelId/scope x rows[].canonicalTaskClass',
                value: routingCardKey(top.modelId, top.scope),
              },
            ]
            : []),
        ],
        inference:
          `A non-vetoed scoped routing recommendation backed by ` +
          `objective-or-stronger evidence and a weighted score >= ${ACT_NOW_MIN_WEIGHTED_SCORE} is an act-now ` +
          `routing gap. Promotion still requires explicit user approval (epic #975 rule 6); ` +
          `nothing is changed automatically.` +
          (semantic
            ? ` The offline intent class NARROWS that existing recommendation and supplies no part of its ` +
              `quality evidence: it says what the work was, not that a cheaper model does it well. Had the ` +
              `semantic evidence been absent, hedged, stale, or split, this card would have fired unchanged ` +
              `at its original ${top.scope} scope.`
            : ''),
        asOf,
        stale,
      },
    };
  },
};
