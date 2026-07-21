import type {
  Detector,
  Recommendation,
  RecommendationInput,
  RecommendationSavingsAttribution,
  RecProvenance,
} from '../types';
import { fmtUsd } from '../shared';
import { demoteStaleAttribution, isAsOfStale } from '../provenance';
import {
  LOCAL_CALIBRATION_FRESHNESS_DAYS,
  type LocalCalibrationClass,
  type LocalCalibrationReport,
} from '../../parse-local-calibration';

/**
 * `cost.local-downroute` (#2318, epic #2177) — turn the Tier B per-task-class
 * calibration report into an auditable, RECEIPT-GATED down-route recommendation.
 *
 * The report (`shadow-calls/lib/calibration-report.mjs`, #2317, read at ingest via
 * `readLocalCalibration`) rolls the blind-judge shadow/replay ledger into one row per
 * task class with a `verdict` in `pass | fail | insufficient`. This detector maps
 * those verdicts to claims under the publish-only-if-proven gate (v0.6.0
 * cut-gate; AGENTS.md "recommendations are auditable claims"):
 *
 *   - `pass` (fresh)  → a PROVEN down-route rec: states the proven per-task cost
 *                       saving vs Claude, cites the calibration artifact/fields as
 *                       `provenance`, and declares `claimClass: 'causal'` /
 *                       `proofTier: 'observational'` (T2 from shadow/replay agreement).
 *   - `pass` (stale)  → DEMOTED "as of <date>": the measured attribution is run
 *                       through `demoteStaleAttribution` (reusing the #1102/#2142
 *                       provenance path), `proofTier` drops to `'auditable'`, and no
 *                       live cost win is asserted.
 *   - `fail`          → an HONEST-NULL: "tested N samples, local model did not hold
 *                       quality for <class> as of <date>" — never silenced, never a
 *                       present-tense win, no cost saving claimed.
 *   - `insufficient`  → SUPPRESSED: thin evidence is "we do not know yet", never a
 *                       failure and never a pass.
 *
 * CORROBORATE, NEVER TRUST THE VERDICT STRING ALONE. The report is an untrusted
 * `~/.claude` artifact and the parser tolerates cross-field inconsistency, so a
 * version-drifted or hand-edited `verdict:"pass"` row could otherwise publish a
 * present-tense "proved…" claim whose provenance asserts observations the row does
 * not support. Every published claim is therefore re-derived from the ACTUAL row
 * fields: a `pass` publishes only when the sample floor, the measured
 * blind-judge-agreement floor, and the quality parity gate all independently hold
 * (and the proof carries a real `asOf`); a `fail` publishes only when the evidence
 * floors held AND the parity gate genuinely broke. Anything short of that is
 * suppressed as `insufficient`.
 *
 * Publishes NOTHING on mechanism-shipped alone: with no report (or a report with no
 * corroborated pass/fail rows) the detector emits nothing. It emits one rec per
 * reportable class (`emitAll`); `rule` returns the single highest-priority rec
 * (proven > demoted > honest-null) for the registry self-test and direct callers.
 */

const DETECTOR_ID = 'cost.local-downroute';

type Disposition = 'proven' | 'demoted' | 'honest-null';

/**
 * The evidence floors the report itself declares, re-checked against the ACTUAL
 * measured fields. A trustworthy verdict cleared BOTH the sample floor and the
 * measured blind-judge-agreement floor; a row that does not is thin evidence —
 * "we do not know yet" — regardless of what its `verdict` string says.
 */
function sufficientEvidence(
  row: LocalCalibrationClass,
  thresholds: LocalCalibrationReport['thresholds']
): boolean {
  return (
    row.nSamples >= thresholds.minSamples &&
    row.blindJudgeAgreement !== null &&
    row.blindJudgeAgreement >= thresholds.minAgreement
  );
}

/**
 * The user already pins the proven local model globally, so there is nothing to
 * recommend routing THERE (peer `cost.automation-share` self-suppresses the same
 * way when its target model is already pinned). Best-effort: reads only the
 * top-level settings model pin.
 */
function alreadyRoutedToLocal(
  input: RecommendationInput,
  localModel: string | null
): boolean {
  const pinned = input.liveConfig?.settings?.model;
  return typeof pinned === 'string' && localModel !== null && pinned === localModel;
}

/**
 * Which auditable claim (if any) a class row supports, re-derived from the actual
 * fields (never the verdict string alone). A corroborated `pass` with a real
 * positive per-task saving and a real `asOf` publishes a proven rec unless it is
 * stale (then demoted) or already routed (then suppressed); a corroborated `fail`
 * is an honest null; everything else supports nothing.
 */
function dispositionOf(
  row: LocalCalibrationClass,
  report: LocalCalibrationReport,
  input: RecommendationInput,
  now: number
): Disposition | null {
  const { thresholds } = report;
  if (row.verdict === 'fail') {
    // A trustworthy fail cleared the evidence floors AND the parity gate broke —
    // the producer's own invariant. An inconsistent row is suppressed rather than
    // published as a fabricated negative.
    return sufficientEvidence(row, thresholds) && row.parity.held === false
      ? 'honest-null'
      : null;
  }
  if (row.verdict !== 'pass') return null; // insufficient → suppressed
  const savings = row.savingsUsdPerTask;
  if (
    !sufficientEvidence(row, thresholds) ||
    row.parity.held !== true ||
    savings === null ||
    savings <= 0
  ) {
    return null; // uncorroborated pass, or no cost lever → suppress
  }
  // An undatable proof cannot be presented "as of <date>" nor asserted as current
  // confidence, so it is suppressed rather than published as a fresh win.
  if (row.asOf === null) return null;
  // Already routed to the proven local model → nothing to recommend.
  if (alreadyRoutedToLocal(input, row.localModel)) return null;
  return isAsOfStale(row.asOf, now, LOCAL_CALIBRATION_FRESHNESS_DAYS)
    ? 'demoted'
    : 'proven';
}

function agreementPct(v: number | null): string {
  return v === null ? 'unmeasured' : `${Math.round(v * 100)}%`;
}

function costVsClaude(row: LocalCalibrationClass): string {
  return row.costLocal !== null && row.costClaude !== null
    ? ` (${fmtUsd(row.costLocal)} local vs ${fmtUsd(row.costClaude)} Claude)`
    : '';
}

const SOURCE = 'shadow-calls/calibration-report';

// Observations below take their `value` from the ACTUAL row fields (never a
// hard-coded string), so an auditor recomputes each fact straight off the report.
function sampleObservation(row: LocalCalibrationClass) {
  return {
    claim: `${row.nSamples} fully-measured paired run(s) for ${row.taskClass}`,
    source: SOURCE,
    field: 'classes[].nSamples',
    value: row.nSamples,
  };
}

function agreementObservation(
  row: LocalCalibrationClass,
  thresholds: LocalCalibrationReport['thresholds']
) {
  return {
    claim: `blind position-swapped judge agreement was ${agreementPct(
      row.blindJudgeAgreement
    )} (threshold ${agreementPct(thresholds.minAgreement)})`,
    source: SOURCE,
    field: 'classes[].blindJudgeAgreement',
    value: row.blindJudgeAgreement ?? 'unmeasured',
  };
}

function parityObservation(row: LocalCalibrationClass) {
  return {
    claim: `the shared quality parity gate resolved held=${String(
      row.parity.held
    )} (delta ${row.parity.delta ?? 'n/a'}, source ${row.parity.source})`,
    source: SOURCE,
    field: 'classes[].parity.held',
    value: String(row.parity.held),
  };
}

function provenProvenance(
  row: LocalCalibrationClass,
  report: LocalCalibrationReport,
  stale: boolean
): RecProvenance {
  return {
    observations: [
      sampleObservation(row),
      agreementObservation(row, report.thresholds),
      parityObservation(row),
      {
        claim: `mean cost per task was ${fmtUsd(row.savingsUsdPerTask ?? 0)} less on ${
          row.localModel ?? 'the local model'
        }${costVsClaude(row)}`,
        source: SOURCE,
        field: 'classes[].savingsUsdPerTask',
        value: row.savingsUsdPerTask ?? 0,
      },
    ],
    inference: stale
      ? `A Tier B pass for ${row.taskClass} was recorded, but its evidence is older than ${LOCAL_CALIBRATION_FRESHNESS_DAYS} days, so it can no longer be asserted as current confidence — model capabilities and pricing move. It is demoted to a dated estimate and must be re-validated before routing.`
      : `The measured sample floor, the blind-judge-agreement floor, and the shared quality parity gate all independently held for ${row.taskClass}, so routing that class to ${
          row.localModel ?? 'the local model'
        } is an observationally-proven (T2) cost saving vs Claude — not a mechanism-shipped estimate. It is a directional shadow/replay signal, not a T3 causal proof, so re-validate before a standing policy.`,
    ...(row.asOf ? { asOf: row.asOf, stale } : {}),
  };
}

function honestNullProvenance(row: LocalCalibrationClass, stale: boolean): RecProvenance {
  return {
    observations: [
      sampleObservation(row),
      {
        claim: `blind position-swapped judge agreement was ${agreementPct(
          row.blindJudgeAgreement
        )}`,
        source: SOURCE,
        field: 'classes[].blindJudgeAgreement',
        value: row.blindJudgeAgreement ?? 'unmeasured',
      },
      parityObservation(row),
    ],
    inference: `The evidence floors held (sample count and measured blind-judge agreement) AND the quality parity gate broke (parity.held=${String(
      row.parity.held
    )}), so the local model did not hold quality for ${row.taskClass}. This is a real negative finding, reported as an honest null — never silenced, never a present-tense win, and no cost saving is claimed.`,
    ...(row.asOf ? { asOf: row.asOf, stale } : {}),
  };
}

function provenRec(
  row: LocalCalibrationClass,
  report: LocalCalibrationReport,
  now: number,
  id: string,
  demoted: boolean
): Recommendation {
  const savings = row.savingsUsdPerTask ?? 0;
  const model = row.localModel ?? 'the proven local model';
  const asOf = row.asOf ?? 'an unknown date';
  const attribution: RecommendationSavingsAttribution = demoteStaleAttribution(
    {
      interventionKey: DETECTOR_ID,
      signatureId: `local-downroute.${row.taskClass}`,
      tier: 'tier-2-ablation',
      predictedSavingsUsd: savings,
      realizedSavingsUsd: savings,
      confidence: 'medium',
      sampleSize: row.nSamples,
      ...(row.blindJudgeAgreement !== null
        ? { judgeAgreement: row.blindJudgeAgreement }
        : {}),
      ...(row.asOf ? { asOf: row.asOf } : {}),
    },
    now,
    LOCAL_CALIBRATION_FRESHNESS_DAYS
  );

  if (demoted) {
    return {
      id,
      category: 'cost',
      severity: 'info',
      claimClass: 'causal',
      // Demoted: a stale proof is no longer current confidence, so it drops to the
      // auditable floor and asserts no live cost win.
      proofTier: 'auditable',
      title: `As of ${asOf}, ${row.taskClass} cleared local-model calibration (revalidate)`,
      detail: `A Tier B calibration pass for routing ${row.taskClass} to ${model} was recorded as of ${asOf}, but it is older than ${LOCAL_CALIBRATION_FRESHNESS_DAYS} days, so it is no longer counted as current confidence. Model capabilities and pricing move, so the ${fmtUsd(
        savings
      )}/task saving cannot be asserted as a live win.`,
      action: `Re-run the Tier B calibration for ${row.taskClass} before routing it to ${model}; do not rely on the dated proof.`,
      affected: row.nSamples,
      view: 'cost',
      savingsAttribution: attribution,
      provenance: provenProvenance(row, report, true),
    };
  }

  return {
    id,
    category: 'cost',
    severity: 'info',
    // A counterfactual ("routing this class to the local model WILL save while
    // holding quality"), proven at T2 by blind-judge shadow/replay agreement.
    claimClass: 'causal',
    proofTier: 'observational',
    title: `Route ${row.taskClass} to the proven local model (${model})`,
    detail: `Tier B calibration proved ${model} holds quality for ${row.taskClass}: ${agreementPct(
      row.blindJudgeAgreement
    )} blind-judge agreement over ${row.nSamples} paired run(s) (threshold ${agreementPct(
      report.thresholds.minAgreement
    )}), the shared quality parity gate held, at ${fmtUsd(
      savings
    )}/task less than Claude${costVsClaude(row)}. As of ${asOf}.`,
    action: `Route the ${row.taskClass} task class to ${model} and keep uncleared classes on Claude. This is an observational (T2) proof from blind-judge shadow/replay agreement, not a T3 causal proof — re-validate before a standing policy.`,
    // Per-task proven delta; the class's full production volume is not part of this
    // receipt, so the ranking dollar is stated per task, not fabricated as a total.
    estSavingsUsd: savings,
    affected: row.nSamples,
    view: 'cost',
    savingsAttribution: attribution,
    provenance: provenProvenance(row, report, false),
    fix: {
      target: 'settings.json',
      label: 'Example: route this class to the proven local model',
      // A top-level "model" is a BLANKET pin — it down-routes every task class,
      // including code-authoring, which the per-task-class safety boundary keeps on
      // the strong model. So this is an ADAPT-ME example, never a copy-paste-safe
      // validated fix (#2548 / fix-validity.ts isBlanketModelPinSnippet).
      fixKind: 'illustrative',
      note: `Example only — not a blanket global pin. A top-level "model" applies to every task class, including code-authoring. Scope ${model} to the ${row.taskClass} class in your router/agent config, keep uncleared classes on Claude, and re-validate the calibration before a standing policy.`,
      // JSON.stringify escapes the model id so a quote/newline still yields valid JSON.
      snippet: `{\n  "model": ${JSON.stringify(row.localModel ?? 'local/<model>')}\n}`,
    },
  };
}

function honestNullRec(
  row: LocalCalibrationClass,
  now: number,
  id: string
): Recommendation {
  const model = row.localModel ? ` (${row.localModel})` : '';
  const asOf = row.asOf ?? 'an unknown date';
  const stale = isAsOfStale(row.asOf ?? undefined, now, LOCAL_CALIBRATION_FRESHNESS_DAYS);
  return {
    id,
    category: 'cost',
    severity: 'info',
    claimClass: 'causal',
    proofTier: 'observational',
    title: `Local model did not hold quality for ${row.taskClass}`,
    detail: `Tier B calibration tested ${row.nSamples} samples for ${row.taskClass}; the local model${model} did not hold quality for ${row.taskClass}${
      row.parity.delta !== null ? ` (parity floor broke, delta ${row.parity.delta})` : ''
    } as of ${asOf}. This is not a cost saving — it is reported as an honest null, not a down-route recommendation.`,
    action: `Keep ${row.taskClass} on Claude. Re-run the calibration if the local model or its serving changes.`,
    affected: row.nSamples,
    view: 'cost',
    provenance: honestNullProvenance(row, stale),
  };
}

/** Build the rec for a reportable class row from its already-computed disposition. */
function buildClassRec(
  row: LocalCalibrationClass,
  report: LocalCalibrationReport,
  now: number,
  id: string,
  disposition: Disposition
): Recommendation {
  if (disposition === 'honest-null') return honestNullRec(row, now, id);
  return provenRec(row, report, now, id, disposition === 'demoted');
}

/** Reportable classes in surfaced priority: proven, then demoted, then honest-null. */
const DISPOSITION_ORDER: Record<Disposition, number> = {
  proven: 0,
  demoted: 1,
  'honest-null': 2,
};

interface ReportableRow {
  row: LocalCalibrationClass;
  disposition: Disposition;
}

function reportableRows(
  report: LocalCalibrationReport,
  input: RecommendationInput,
  now: number
): ReportableRow[] {
  const rows: ReportableRow[] = [];
  for (const row of report.classes) {
    const disposition = dispositionOf(row, report, input, now);
    if (disposition !== null) rows.push({ row, disposition });
  }
  return rows.sort(
    (a, b) =>
      DISPOSITION_ORDER[a.disposition] - DISPOSITION_ORDER[b.disposition] ||
      a.row.taskClass.localeCompare(b.row.taskClass)
  );
}

export const detector: Detector = {
  id: DETECTOR_ID,
  category: 'cost',
  dataDeps: ['localCalibration', 'liveConfig'],
  rule(input, now) {
    const report = input.localCalibration;
    if (!report) return null;
    const first = reportableRows(report, input, now)[0];
    return first
      ? buildClassRec(first.row, report, now, DETECTOR_ID, first.disposition)
      : null;
  },
  emitAll(input, now) {
    const report = input.localCalibration;
    if (!report) return [];
    return reportableRows(report, input, now).map(({ row, disposition }) =>
      buildClassRec(row, report, now, `${DETECTOR_ID}:${row.taskClass}`, disposition)
    );
  },
};
