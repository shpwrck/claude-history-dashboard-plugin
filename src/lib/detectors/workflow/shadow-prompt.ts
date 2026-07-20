import type { AppliedMarkers, Detector, RecFix, RecProvenance } from '../types';
import { claudeMdMarksApplied, mergedClaudeMdText, truncate } from '../shared';
import {
  MIN_SAMPLES,
  MIN_DECIDED,
  MIN_SHADOW_WIN_RATE,
  clearsVariationThresholds,
} from './shadow-axis-wins';
import type { VariationAggregate } from '../../parse-shadow-calls';

/**
 * Auditable prompt-axis shadow recommendation (#2555, epic #2561).
 *
 * The generic `workflow.shadow-axis-wins` card recommends adopting a whole AXIS
 * ("structured prompts win"). This detector goes one level finer for the
 * `prompt` axis alone: it consumes the per-VARIATION receipts #2643 preserved
 * (`shadowCalls.byVariation`) so it can name the exact winning treatment and
 * cite its live/replay mix, cost delta, timestamp, and the proof status the
 * source receipts recorded — WITHOUT pooling treatments together.
 *
 * Auditability posture (epic #866, `docs/adding-a-recommendation.md`, ADR 0017):
 *  - Only a qualifying prompt variation fires — the SAME sample / decided-count
 *    / win-rate bar `workflow.shadow-axis-wins` uses (shared
 *    {@link clearsVariationThresholds}), applied to ONE variation at a time.
 *  - The recommendation names the winning variation by its RECORDED LABEL and
 *    prescribes NO framing technique (the ledger stores only the label).
 *  - It stays `observational` (ADR 0017): a shadow A/B is a correlational causal
 *    signal. The receipts' proof-status counts are CITED but never upgrade the
 *    tier — the aggregate cannot tie a `current` proof to a *winning* comparison.
 *  - Stale, undated/undatable, and tail-truncated evidence each add a caveat, and
 *    a dated lead NEVER emits a standing-default `fix` — it points at re-running
 *    live shadows instead.
 *  - Cost wording always discloses its paired-data coverage, and the winning
 *    label is single-lined + backtick-stripped before it enters any prose/snippet
 *    (the exact label is preserved verbatim only in provenance).
 *  - Self-suppression is scoped to the ADOPTED variation: the card re-fires for a
 *    later, different winning treatment.
 */

/** Freshness threshold (#1102): a winning variation older than this is a dated lead. */
export const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * CLAUDE.md self-suppression markers for the illustrative treatment this fix
 * pastes. Structurally mirrored in the client-safe leaf `applied-markers.ts`;
 * `applied-markers.contract.test.ts` guards the two against drift. The markers
 * are axis-generic (a static marker cannot encode a dynamic variation label);
 * the rule narrows suppression to the adopted variation at runtime.
 */
const MARKERS_SHADOW_PROMPT: AppliedMarkers = {
  headings: [/^##\s+Winning prompt framing\b/i],
  bodyPhrases: ['the tasks these prompt shadow experiments sampled'],
};

/** Mean $ cost delta (shadow − main) over paired receipts, or null when none. */
function variationCostDelta(v: VariationAggregate): number | null {
  return v.costDeltaCount > 0 ? v.costDeltaSum / v.costDeltaCount : null;
}

/**
 * The label as any prose/snippet RENDERS it: single-line (`truncate` collapses
 * \s+ → space, so no newline can inject a Markdown heading) and backtick-stripped.
 * The EXACT ledger label is preserved only in provenance.
 */
function renderedLabel(v: VariationAggregate): string {
  return truncate(v.variation, 200).replace(/`/g, "'");
}

/**
 * The body of every CLAUDE.md section whose heading matches `headingRe`, up to
 * the next heading of any level. Adoption matching is scoped to the detector's
 * own "## Winning prompt framing" section so a label quoted in unrelated prose
 * (e.g. `Use the "concise" style for summaries`) is not mistaken for adoption
 * and does not hide a real unadopted winner (#2555).
 */
function markerSectionText(merged: string, headingRe: RegExp): string {
  const out: string[] = [];
  let capturing = false;
  for (const line of merged.split('\n')) {
    if (/^#{1,6}\s+/.test(line)) capturing = headingRe.test(line);
    if (capturing) out.push(line);
  }
  return out.join('\n');
}

/** Strongest first: most decided, then win rate, then samples, then stable name. */
function strongerVariation(a: VariationAggregate, b: VariationAggregate): number {
  if (b.decided !== a.decided) return b.decided - a.decided;
  const wa = a.shadowWins / a.decided;
  const wb = b.shadowWins / b.decided;
  if (wb !== wa) return wb - wa;
  if (b.samples !== a.samples) return b.samples - a.samples;
  return a.variation < b.variation ? -1 : a.variation > b.variation ? 1 : 0;
}

/** ISO `YYYY-MM-DD`. A four-digit year only — an extended-year ledger timestamp
 * (e.g. `+275760-09-13T…` from a huge numeric epoch) must NOT become an `asOf`
 * that violates the provenance contract's date format. */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}$/;

export const detector: Detector = {
  id: 'workflow.shadow-prompt',
  appliedMarkers: MARKERS_SHADOW_PROMPT,
  category: 'workflow',
  dataDeps: ['shadowCalls', 'liveConfig'],
  dependsOn: ['workflow.shadow-axis-wins'],
  rule(input, now) {
    const agg = input.shadowCalls;
    // `counted` (real rows) gates real-evidence detectors (#2149); byVariation is
    // the #2643 per-treatment receipt surface. Guard its presence defensively —
    // the real parser always emits it, but a partial/legacy aggregate may not.
    if (!agg || agg.counted === 0 || !agg.byVariation || agg.byVariation.length === 0) {
      return null;
    }

    const qualifying = agg.byVariation.filter(
      (v) => v.axis === 'prompt' && clearsVariationThresholds(v)
    );
    if (qualifying.length === 0) return null; // only a qualifying variation fires

    // Self-suppression is scoped to the ADOPTED treatment: drop treatments whose
    // RENDERED, quoted label already appears under the marker in CLAUDE.md, then
    // surface the strongest treatment that is NOT yet adopted. A still-winning
    // adopted treatment must never hide a different qualifying one, and matching
    // the RENDERED (sanitized) label — not the raw ledger string — is required or
    // a sanitized label would re-fire forever (#2555).
    // KNOWN LIMITATION (#2842): the Adoption Scorecard still keys lifecycle by
    // findingId, so a re-fired later treatment can read as already-adopted there;
    // that scorecard-side fix is tracked separately.
    const markersPresent = claudeMdMarksApplied(input.liveConfig, MARKERS_SHADOW_PROMPT);
    // Match the winning label ONLY inside our own marker section, not anywhere in
    // the merged doc, so unrelated quoted prose can't be read as adoption (#2555).
    const blockText = markersPresent
      ? markerSectionText(mergedClaudeMdText(input.liveConfig), MARKERS_SHADOW_PROMPT.headings![0]).toLowerCase()
      : '';
    const adopted = (candidate: VariationAggregate): boolean =>
      markersPresent && blockText.includes(`"${renderedLabel(candidate).toLowerCase()}"`);
    const unadopted = qualifying.filter((candidate) => !adopted(candidate));
    if (unadopted.length === 0) return null; // every qualifying treatment already adopted

    const v = unadopted.slice().sort(strongerVariation)[0];
    const label = renderedLabel(v);

    // Trust is source-gated (#2151): batch rows that stamp mode:'live' count in
    // `live` but not `trustedLive`, so the cold-start caveat and mix wording read
    // honestly. Defensive `?? 0` for a legacy aggregate that predates the counter.
    const trustedLive = v.trustedLive ?? 0;
    const winRate = v.shadowWins / v.decided;
    const pct = Math.round(winRate * 100);
    const evidenceMix = `${v.live} live (${trustedLive} trusted in-the-loop) + ${v.replay} replay`;

    const costDelta = variationCostDelta(v);
    const cheaper = costDelta !== null && costDelta < 0;
    // Always disclose the paired-cost COVERAGE — costDeltaCount can be < samples,
    // so "cheaper on average" over 1/6 experiments must not read as broad evidence.
    const cheaperStr = cheaper
      ? ` and cost ~$${Math.abs(costDelta).toFixed(2)} less on average (paired cost data on ${v.costDeltaCount}/${v.samples} experiment(s))`
      : '';

    // Freshness (#1102). `asOf` is derived ONLY from a clean four-digit ISO date;
    // a fully-undated OR unrepresentable-timestamp receipt cannot assert currency.
    const cleanDate =
      v.latestTs && ISO_DATE_PREFIX.test(v.latestTs.slice(0, 10)) ? v.latestTs.slice(0, 10) : null;
    const latestMs = v.latestTs ? Date.parse(v.latestTs) : null;
    const noTimestamp = v.latestTs === null;
    const unrepresentable = v.latestTs !== null && cleanDate === null;
    // A future-dated newest receipt is a clock skew, not currency: it must NOT let
    // stale evidence read as fresh (a negative `now - latestMs` would clear the
    // stale gate). Treat it as currency-unassertable (#2555).
    const future = latestMs !== null && Number.isFinite(latestMs) && latestMs > now;
    const datable = cleanDate !== null && !future; // can produce a trustworthy asOf
    const asOf = datable ? cleanDate : undefined;
    const stale = datable && latestMs !== null && now - latestMs > STALE_DAYS * DAY_MS;
    const undatedish = noTimestamp || unrepresentable || future; // can't assert currency
    // A dated lead (stale or currency-unassertable) never hardens into a standing
    // default — the action re-runs shadows and no CLAUDE.md fix is emitted (#2555).
    const datedLead = stale || undatedish;
    // A cardinality-truncated receipt set (> MAX_VARIATION_CELLS distinct
    // treatments) is not a complete inventory, so the retained subset is not a
    // trustworthy "strongest" — demote to a soft lead too (no standing default).
    const inventoryTruncated = agg.variationCellsTruncated === true;
    const softLead = datedLead || inventoryTruncated;

    const caveats: string[] = [];
    // No TRUSTED in-the-loop confirmation — all-replay OR only untrusted batch
    // rows that stamped mode:'live'. Treat as replay-only for cold-start purposes.
    if (trustedLive === 0) {
      caveats.push('no trusted in-the-loop confirmation, so treat the evidence as replay-only (cold-start caveat)');
    }
    if (agg.truncated) {
      caveats.push('the shadow ledger was tail-truncated, so these counts cover only its most recent history');
    }
    if (inventoryTruncated) {
      caveats.push('more prompt treatments existed than were retained, so this may not be the strongest overall');
    }
    if (noTimestamp) caveats.push(`${v.untimed} receipt(s) are undated, so currency cannot be asserted`);
    else if (unrepresentable) caveats.push('the freshest receipt timestamp is unrepresentable, so currency cannot be asserted');
    else if (future) caveats.push('the freshest receipt is future-dated (clock skew), so currency cannot be asserted');
    else if (stale) caveats.push(`the freshest receipt is from ${asOf} — older than ${STALE_DAYS} days, treat as "as of ${asOf}"`);
    else if (v.untimed > 0) caveats.push(`${v.untimed} of ${v.samples} receipts are undated`);
    const caveatStr = caveats.length ? ` Caveat: ${caveats.join('; ')}.` : '';

    const detail =
      `Across ${v.samples} prompt shadow experiment(s) (${evidenceMix}), the "${label}" variation won ` +
      `${v.shadowWins}/${v.decided} decided comparisons (${pct}%)${cheaperStr}. This is an observational ` +
      `A/B lead from shadow-calls — a directional signal, not a proven saving.${caveatStr}`;

    // Scope-honest + variation-neutral. A dated lead points at re-running shadows;
    // a fresh lead prefers the named treatment for the tasks it was tested on.
    const softReason = stale
      ? 'the evidence is stale'
      : undatedish
        ? 'the evidence is not datable'
        : 'the treatment inventory was truncated, so this may not be the overall strongest';
    const action = softLead
      ? `The "${label}" prompt framing led ${pct}% of ${v.decided} decided prompt shadow comparisons` +
        `${asOf ? `, as of ${asOf}` : ''}, but ${softReason} — ` +
        `re-run a few live shadows to confirm before adopting it.`
      : `Prefer the "${label}" prompt framing for the tasks these prompt shadow experiments sampled — ` +
        `an observational lead. Re-run a few live shadows to confirm the scope before adopting it as a standing default.`;

    const p = v.proofStatusCounts;
    const observations: RecProvenance['observations'] = [
      {
        claim: `prompt variation "${label}" won ${v.shadowWins} of ${v.decided} decided shadow comparisons (${pct}%)`,
        source: 'parse-shadow-calls',
        field: 'byVariation[].variation',
        value: v.variation, // EXACT recorded label, preserved for reproducibility
      },
      {
        claim: `evidence mix: ${evidenceMix} over ${v.samples} experiment(s)`,
        source: 'parse-shadow-calls',
        field: 'byVariation[].live/replay',
        value: v.samples,
      },
      {
        claim:
          costDelta !== null
            ? `mean cost delta (shadow − main): $${costDelta.toFixed(2)} over ${v.costDeltaCount}/${v.samples} paired experiment(s)`
            : 'no paired cost data on these receipts',
        source: 'parse-shadow-calls',
        field: 'byVariation[].costDeltaSum',
        ...(costDelta !== null ? { value: Number(costDelta.toFixed(4)) } : {}),
      },
      {
        claim: noTimestamp
          ? `no receipt carried a timestamp (${v.untimed} undated)`
          : `freshest receipt ${v.latestTs}${v.untimed > 0 ? `, ${v.untimed} undated` : ''}`,
        source: 'parse-shadow-calls',
        field: 'byVariation[].latestTs',
        ...(v.latestTs ? { value: v.latestTs } : {}),
      },
      {
        claim: `source proof status (cited, not linked to a winning comparison) — current ${p.current} / stale ${p.stale} / revoked ${p.revoked} / unknown ${p.unknown}`,
        source: 'parse-shadow-calls',
        field: 'byVariation[].proofStatusCounts',
      },
    ];
    if (agg.truncated) {
      observations.push({
        claim: 'the shadow ledger was tail-truncated at ingest; counts cover only the retained newest history',
        source: 'parse-shadow-calls',
        field: 'truncated',
        value: 'true',
      });
    }
    if (inventoryTruncated) {
      observations.push({
        claim: 'the per-treatment receipt set was cardinality-truncated; this is one qualifying treatment, not necessarily the strongest overall',
        source: 'parse-shadow-calls',
        field: 'variationCellsTruncated',
        value: 'true',
      });
    }

    const inference =
      `"${label}" cleared the shadow-win bar (≥${MIN_SAMPLES} samples, ≥${MIN_DECIDED} decided, ` +
      `≥${Math.round(MIN_SHADOW_WIN_RATE * 100)}% shadow wins), an observational A/B signal. The receipts' ` +
      `proof-status counts are cited but not linked to specific winning comparisons, so this stays a lead to ` +
      `confirm — not a proven causal saving. No live occurrence or mixed live/replay ledger upgrades it.`;

    const provenance: RecProvenance = {
      observations,
      inference,
      ...(asOf ? { asOf } : {}),
      ...(stale ? { stale: true } : {}),
    };

    // A fresh, complete lead may harden into a standing note; a dated or
    // truncated-inventory one may not (#2555).
    const fix: RecFix | undefined = softLead
      ? undefined
      : {
          target: 'CLAUDE.md',
          fixKind: 'illustrative',
          label: 'Note the winning prompt framing',
          note: 'Shadow-calls evidence (epic #513). Add a standing note so this framing becomes the default for the tasks it was tested on; keep shadowing to catch regressions.',
          snippet:
            `## Winning prompt framing (from shadow-calls #513)\n\n` +
            `For the tasks these prompt shadow experiments sampled, prefer the "${label}" prompt framing — ` +
            `it won ${pct}% of ${v.decided} decided shadow comparisons. This is an observational lead; re-run a ` +
            `few live shadows to confirm the scope. Revisit if live shadows stop favouring it.`,
          appliedMarkers: MARKERS_SHADOW_PROMPT,
        };

    return {
      id: 'workflow.shadow-prompt',
      category: 'workflow',
      severity: 'info', // an observational lead to confirm — proof status never lifts this
      title: `Consider the "${label}" prompt framing — it led your default in shadow tests`,
      detail,
      action,
      affected: v.samples,
      view: 'recommendations',
      claimClass: 'causal',
      proofTier: 'observational',
      evidence: [
        `prompt / ${label}: shadow ${v.shadowWins} / main ${v.mainWins} / tie ${v.ties} over ${v.samples} (${evidenceMix})`,
        costDelta !== null
          ? `mean $ delta (shadow − main): $${costDelta.toFixed(2)} over ${v.costDeltaCount}/${v.samples} paired`
          : 'no paired cost data',
        `source proof status: current ${p.current} / stale ${p.stale} / revoked ${p.revoked} / unknown ${p.unknown}${noTimestamp ? `; ${v.untimed} undated` : asOf ? `; freshest ${asOf}` : '; undatable timestamp'}${agg.truncated ? '; ledger tail-truncated' : ''}`,
      ],
      provenance,
      ...(fix ? { fix } : {}),
    };
  },
};
