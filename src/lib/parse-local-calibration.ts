/**
 * Tier B per-task-class LOCAL-MODEL CALIBRATION report (#2318, epic #2177).
 *
 * This is the dashboard-side READER for the shadow-calls calibration report that
 * `~/.claude/shadow-calls/lib/calibration-report.mjs` (#2317, mirrored on
 * `shpwrck/claude`) produces. That module is a DERIVED, non-persisted rollup over
 * the shadow-calls ledger: it groups `mode:replay, axis:model, shadow.model=local/*`
 * records by task class and, per class, records `nSamples`, `blindJudgeAgreement`,
 * `costLocal`/`costClaude`, latency, a quality-`parity` gate, an `asOf`, and a
 * `verdict` in `pass | fail | insufficient`. The verdict discipline is the point:
 *   - `insufficient` is the DEFAULT — thin evidence, "we do not know yet", never a
 *     claim in either direction;
 *   - `pass` additionally requires the quality parity floor to HOLD (cheapness never
 *     buys a pass);
 *   - `fail` means the evidence was sufficient AND the floor broke — a real finding.
 *
 * ── Network / IO discipline ─────────────────────────────────────────────────
 * This file is PURE: it takes the report JSON text as an argument and never touches
 * the network, the filesystem, or `child_process`. The report is read from disk in
 * the ingest step (`scripts/ingest.mjs` `readLocalCalibration`), which runs host-side
 * and folds the file into the dataset-cache content hash — there is NO query-time
 * shell-out and this module never runs the producer. Keeping it dependency-light
 * (leaf types only) means it is safe to live under `src/lib/**`, which the
 * zero-deps server runtime boot graph imports, and unit-testable with injected
 * fixtures.
 *
 * ── As-of / staleness ───────────────────────────────────────────────────────
 * Each class row carries `asOf` — the ISO `YYYY-MM-DD` of the newest CONTRIBUTING
 * ledger record (never the clock). Model capabilities and pricing move, so a proof
 * older than {@link LOCAL_CALIBRATION_FRESHNESS_DAYS} can no longer be asserted as
 * current confidence and must be presented "as of <date>" — the same #1102/#2142
 * stale-demotion convention the `cost.local-downroute` detector applies via
 * `detectors/provenance.ts` (`isAsOfStale`/`demoteStaleAttribution`).
 */

/** The producer's per-class verdict (calibration-report.mjs). */
export type LocalCalibrationVerdict = 'pass' | 'fail' | 'insufficient';

/** The literal `kind` the producer stamps on the report envelope. */
export const LOCAL_CALIBRATION_KIND = 'tier-b-calibration';

/**
 * Freshness horizon (days) for a per-class local-model proof. Matches the
 * hosted down-model proof horizon (`cost.automation-share`
 * `DOWN_MODEL_PROOF_FRESHNESS_DAYS`): a calibration older than a quarter may no
 * longer describe the current cost/quality direction, so a consumer demotes it
 * to a dated estimate rather than a live claim.
 */
export const LOCAL_CALIBRATION_FRESHNESS_DAYS = 90;

/** Quality parity gate result for a class (mirrors verdict.resolveParityGate). */
export interface LocalCalibrationParity {
  /** `true` held, `false` broke, `null` unknown (no usable per-dimension scores). */
  held: boolean | null;
  /** How the gate resolved, e.g. `no-judge-scores`. */
  source: string;
  baselineMeanScore: number | null;
  candidateMeanScore: number | null;
  delta: number | null;
  rationale?: string | null;
}

export interface LocalCalibrationLatency {
  localMeanMs: number | null;
  claudeMeanMs: number | null;
}

/** One task class's calibration row. */
export interface LocalCalibrationClass {
  /** `authoring | mechanical | review` (the canonical task taxonomy). */
  taskClass: string;
  /** The `local/*` candidate model, when the corpus recorded one. */
  localModel: string | null;
  /** The Claude control/baseline model, when the corpus recorded one. */
  baselineModel: string | null;
  /** Total ledger records seen for this class (usable + half-measured). */
  nRecords: number;
  /** Fully-measured paired runs — the evidence sample size. */
  nSamples: number;
  /** Blind, position-swapped judge agreement in `[0,1]`, or null when unjudged. */
  blindJudgeAgreement: number | null;
  /** Mean local-model cost per task (USD), or null when unmeasured. */
  costLocal: number | null;
  /** Mean Claude cost per task (USD), or null when unmeasured. */
  costClaude: number | null;
  /** `costClaude - costLocal` per task (USD), or null when either is unmeasured. */
  savingsUsdPerTask: number | null;
  latency: LocalCalibrationLatency;
  parity: LocalCalibrationParity;
  /** ISO `YYYY-MM-DD` of the newest contributing record, or null. */
  asOf: string | null;
  verdict: LocalCalibrationVerdict;
  /** Human-readable verdict rationale rows from the producer. */
  reasons: string[];
}

export interface LocalCalibrationThresholds {
  minSamples: number;
  minAgreement: number;
}

/** The full report envelope (calibration-report.mjs `buildCalibrationReport`). */
export interface LocalCalibrationReport {
  version: number;
  kind: typeof LOCAL_CALIBRATION_KIND;
  thresholds: LocalCalibrationThresholds;
  /** Newest evidence date anywhere in the report, or null. */
  asOf: string | null;
  classes: LocalCalibrationClass[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERDICTS: ReadonlySet<string> = new Set(['pass', 'fail', 'insufficient']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Finite number or null — everything the producer rounds, defensively coerced. */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && ISO_DATE.test(v) ? v : null;
}

function parseParity(v: unknown): LocalCalibrationParity {
  const p = isRecord(v) ? v : {};
  return {
    held: typeof p.held === 'boolean' ? p.held : null,
    source: typeof p.source === 'string' ? p.source : 'unknown',
    baselineMeanScore: finiteOrNull(p.baselineMeanScore),
    candidateMeanScore: finiteOrNull(p.candidateMeanScore),
    delta: finiteOrNull(p.delta),
    rationale: typeof p.rationale === 'string' ? p.rationale : null,
  };
}

/**
 * Validate + normalize a single class row. Returns null when the row is
 * structurally unusable (no task class, or a verdict outside the producer's
 * enum) — a malformed row is dropped, never guessed, so the report never carries
 * an ungrounded class the detector could publish a claim against.
 */
export function parseCalibrationClass(v: unknown): LocalCalibrationClass | null {
  if (!isRecord(v)) return null;
  const taskClass = typeof v.taskClass === 'string' ? v.taskClass.trim() : '';
  if (!taskClass) return null;
  const verdict = typeof v.verdict === 'string' ? v.verdict : '';
  if (!VERDICTS.has(verdict)) return null;
  const latency = isRecord(v.latency) ? v.latency : {};
  return {
    taskClass,
    localModel: typeof v.localModel === 'string' ? v.localModel : null,
    baselineModel: typeof v.baselineModel === 'string' ? v.baselineModel : null,
    nRecords: finiteOrNull(v.nRecords) ?? 0,
    nSamples: finiteOrNull(v.nSamples) ?? 0,
    blindJudgeAgreement: finiteOrNull(v.blindJudgeAgreement),
    costLocal: finiteOrNull(v.costLocal),
    costClaude: finiteOrNull(v.costClaude),
    savingsUsdPerTask: finiteOrNull(v.savingsUsdPerTask),
    latency: {
      localMeanMs: finiteOrNull(latency.localMeanMs),
      claudeMeanMs: finiteOrNull(latency.claudeMeanMs),
    },
    parity: parseParity(v.parity),
    asOf: isoOrNull(v.asOf),
    verdict: verdict as LocalCalibrationVerdict,
    reasons: Array.isArray(v.reasons)
      ? v.reasons.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

/**
 * Parse the shadow-calls calibration report JSON into a validated
 * {@link LocalCalibrationReport}, or `null` when the text is missing, not JSON,
 * or not a `tier-b-calibration` envelope. Malformed individual class rows are
 * dropped (not fatal); the whole report is rejected only when the envelope
 * itself is wrong, so a partially-corrupt report never fabricates a class.
 *
 * @param text raw file contents (the ingest step reads the file; this is pure).
 */
export function parseLocalCalibration(
  text: string | null | undefined
): LocalCalibrationReport | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.kind !== LOCAL_CALIBRATION_KIND) return null;
  const version = finiteOrNull(raw.version);
  if (version === null) return null;
  // FAIL-CLOSED on the thresholds envelope: the evidence floors are what the
  // detector cites and gates a `pass` on, so a report that does not STATE them
  // (or states garbage) cannot be trusted to have applied them. A missing,
  // non-object, or out-of-range `thresholds` rejects the whole report rather than
  // silently defaulting to a permissive `{0, 0}` that would publish proven recs
  // citing "(threshold 0%)".
  if (!isRecord(raw.thresholds)) return null;
  const minSamples = finiteOrNull(raw.thresholds.minSamples);
  const minAgreement = finiteOrNull(raw.thresholds.minAgreement);
  if (minSamples === null || minSamples < 1) return null;
  if (minAgreement === null || minAgreement < 0 || minAgreement > 1) return null;
  const classesRaw = Array.isArray(raw.classes) ? raw.classes : [];
  const classes = classesRaw
    .map(parseCalibrationClass)
    .filter((c): c is LocalCalibrationClass => c !== null);
  return {
    version,
    kind: LOCAL_CALIBRATION_KIND,
    thresholds: { minSamples, minAgreement },
    asOf: isoOrNull(raw.asOf),
    classes,
  };
}
