/**
 * Experiment-axis evaluator (#2242, the loop-closer for #2227).
 *
 * `run -> ingest -> measure -> qualify`. Run (the `/experiment-enroll` skill +
 * ledger + hook) and measure (the shared conversational-availability BFC metric,
 * #2238) already exist. This module is INGEST (arm per session) + MEASURE
 * (per-arm aggregate) + QUALIFY (a per-axis success/failure verdict).
 *
 * Honesty contract (AGENTS.md "recommendations are auditable claims"): a verdict
 * is an auditable, non-overclaimed result. So every verdict carries
 *  - `confidence: 'observational'` unless EVERY contributing session on the axis
 *    was assigned `blind` (the human self-selected the arm under `menu`, so any
 *    self-selected session bars a causal claim) — a single non-blind session,
 *    regardless of ingest/map-insertion order, keeps the axis observational and
 *    retains the self-selection caveat (#3126);
 *  - a `counterMetric` whose v1 status is `not-auto-measured`, making any
 *    `success` explicitly PROVISIONAL: conversational availability alone can be
 *    gamed by making the underlying work worse, so a real win needs the
 *    counter-metric (a human/qualitative sign-off, or a future rework/correction
 *    proxy) before it is more than provisional;
 *  - a `caveats` array that always names the known Agent/Workflow under-count
 *    (control-arm bias) carried over from the #2238 follow-up.
 */

import type { SessionTimeline } from '../parse-timeline';
import {
  sessionBfcMetric,
  type SessionBfcMetric,
} from './conversational-availability-metric';
import type { SessionEnrollment } from './enrollment-ledger';

// --- Qualification defaults (issue #2242 DEFAULTS — do not tune away from these
//     without an explicit decision). ---

/** Both arms must have at least this many enrolled sessions to qualify. */
export const MIN_SESSIONS_PER_ARM = 5;

/**
 * Relative effect threshold: ON must beat (or trail) OFF by at least this
 * fraction of the OFF mean for a `success` (or `failure`) verdict. 0.15 = a
 * modest 15% relative improvement, below which the result is `inconclusive`.
 */
export const EFFECT_THRESHOLD = 0.15;

/** The arm id treated as the experimental (ON) arm in every registry axis. */
export const ON_ARM = 'on';
/** The arm id treated as the control (OFF) arm. */
export const OFF_ARM = 'off';

/** BFC count is normalized per this many tool calls so arms compare fairly. */
const NORMALIZE_PER_TOOL_CALLS = 100;

export type Verdict = 'success' | 'failure' | 'inconclusive';
export type Confidence = 'observational' | 'causal';

export interface ArmAggregate {
  /** Number of enrolled sessions in this arm that had a usable metric. */
  n: number;
  /**
   * Mean of the per-session normalized metric (BFC per 100 tool calls). LOWER is
   * better — fewer blocking foreground calls per unit of work means the human's
   * thread stayed freer. `null` when the arm has no sessions.
   */
  meanMetric: number | null;
}

export interface CounterMetric {
  status: 'not-auto-measured';
  note: string;
}

export interface AxisVerdict {
  key: string;
  label: string;
  assignment: SessionEnrollment['assignment'];
  arms: { on: ArmAggregate; off: ArmAggregate };
  /**
   * Relative improvement of ON over OFF, signed so positive = ON is BETTER
   * (fewer blocking calls). `null` when either arm lacks a mean. Because lower
   * meanMetric is better, delta = (off.mean - on.mean) / off.mean.
   */
  delta: number | null;
  verdict: Verdict;
  confidence: Confidence;
  counterMetric: CounterMetric;
  caveats: string[];
  /** Total enrolled sessions for this axis across both arms (with a metric). */
  n_total: number;
}

/** Minimal axis metadata the evaluator needs; sourced from the registry. */
export interface AxisMeta {
  key: string;
  label: string;
}

/**
 * Per-session normalized metric for the conversational-availability axis: BFC
 * count per {@link NORMALIZE_PER_TOOL_CALLS} tool calls. Sessions with zero tool
 * calls have no work to background, so they contribute no metric (excluded),
 * keeping the per-arm mean honest rather than diluting it with structural zeros.
 */
function normalizedMetric(m: SessionBfcMetric): number | null {
  if (m.toolCallCount <= 0) return null;
  return (m.bfcCount / m.toolCallCount) * NORMALIZE_PER_TOOL_CALLS;
}

function aggregate(values: number[]): ArmAggregate {
  if (values.length === 0) return { n: 0, meanMetric: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return { n: values.length, meanMetric: sum / values.length };
}

const COUNTER_METRIC_NOTE =
  'Conversational availability is a single-sided proxy: it can be gamed by making ' +
  'the underlying work worse (e.g. backgrounding everything indiscriminately). A ' +
  'success is PROVISIONAL until a counter-metric (human/qualitative sign-off, or a ' +
  'future rework/correction proxy) confirms quality was not traded away.';

const CONTROL_ARM_BIAS_CAVEAT =
  'Agent/Workflow block windows can be under-counted on the slim server dataset ' +
  '(#2238 follow-up); the under-count biases AGAINST the ON arm, so a real ON ' +
  'improvement is if anything understated.';

const MENU_ASSIGNMENT_CAVEAT =
  'Assignment is `menu` (the human self-selected the arm), so this is observational, ' +
  'not causal — the comparison can be contaminated by who chose which arm. A `blind` ' +
  'assignment regime is required before the delta supports a causal claim.';

const MIXED_ASSIGNMENT_CAVEAT =
  'This axis mixes assignment regimes: at least one contributing session was `blind` ' +
  'but at least one was `menu` (self-selected). A causal claim requires EVERY ' +
  'contributing session to be blind, so the axis is reported observational and the ' +
  'self-selection contamination caveat is retained — one self-selected session cannot ' +
  'be laundered into a causal result by the blind sessions around it (#3126).';

/**
 * Compute the verdict for one axis from its per-arm session metrics.
 *
 * Lower meanMetric is better. `success` = ON's mean is at least EFFECT_THRESHOLD
 * (relative to OFF's mean) LOWER than OFF's AND both arms meet MIN_SESSIONS_PER_ARM;
 * `failure` = ON's mean is at least that much HIGHER; otherwise `inconclusive`
 * (below min-n, or the delta is within the noise band).
 */
function qualify(
  on: ArmAggregate,
  off: ArmAggregate
): { verdict: Verdict; delta: number | null } {
  const minMet = on.n >= MIN_SESSIONS_PER_ARM && off.n >= MIN_SESSIONS_PER_ARM;
  if (
    on.meanMetric === null ||
    off.meanMetric === null ||
    off.meanMetric === 0
  ) {
    // No usable baseline to compute a relative delta against.
    return { verdict: 'inconclusive', delta: null };
  }
  // Signed so positive = ON better (fewer blocking calls per unit work).
  const delta = (off.meanMetric - on.meanMetric) / off.meanMetric;
  if (!minMet) return { verdict: 'inconclusive', delta };
  if (delta >= EFFECT_THRESHOLD) return { verdict: 'success', delta };
  if (delta <= -EFFECT_THRESHOLD) return { verdict: 'failure', delta };
  return { verdict: 'inconclusive', delta };
}

/**
 * Evaluate every axis that has at least one enrolled session.
 *
 * @param timelines     all session timelines (the measured corpus).
 * @param enrollments   sessionId -> enrollment (latest-wins; see enrollment-ledger).
 * @param axisMeta      optional registry metadata for human-readable labels; when
 *                      an axis is absent the label falls back to its key, so the
 *                      evaluator works even if the registry is unavailable.
 */
export function evaluateExperiments(
  timelines: SessionTimeline[],
  enrollments: Map<string, SessionEnrollment>,
  axisMeta: AxisMeta[] = []
): AxisVerdict[] {
  const labelByKey = new Map(axisMeta.map((a) => [a.key, a.label]));
  const timelineById = new Map(timelines.map((tl) => [tl.sessionId, tl]));

  // Group enrolled sessions by axis, then by arm, accumulating the normalized
  // per-session metric. Only enrolled sessions that we actually have a timeline
  // for (and that have measurable work) contribute.
  interface AxisAccum {
    // Every contributing session's regime, not just the first (#3126): an axis is
    // only causal when this set is exactly {'blind'}. Tracking the whole set makes
    // the confidence claim order-independent — map-insertion order can no longer
    // flip a self-selected axis into `causal`.
    assignments: Set<SessionEnrollment['assignment']>;
    armValues: Map<string, number[]>;
  }
  const byAxis = new Map<string, AxisAccum>();
  for (const enr of enrollments.values()) {
    const tl = timelineById.get(enr.sessionId);
    if (!tl) continue; // enrolled but not (yet) ingested — no metric to attribute
    const metric = normalizedMetric(sessionBfcMetric(tl));
    if (metric === null) continue; // no measurable work in this session
    let acc = byAxis.get(enr.axis);
    if (!acc) {
      // perf-index-contract: axis-assignment-regime-set always-consumed: every axis that reaches the verdict loop reads this set to derive allBlind/mixedRegimes, so no non-querying path builds it for nothing
      acc = { assignments: new Set(), armValues: new Map() };
      byAxis.set(enr.axis, acc);
    }
    // Only sessions that actually contribute a metric count toward the regime.
    acc.assignments.add(enr.assignment);
    const list = acc.armValues.get(enr.arm);
    if (list) list.push(metric);
    else acc.armValues.set(enr.arm, [metric]);
  }

  const verdicts: AxisVerdict[] = [];
  for (const [key, acc] of byAxis) {
    const on = aggregate(acc.armValues.get(ON_ARM) ?? []);
    const off = aggregate(acc.armValues.get(OFF_ARM) ?? []);
    const { verdict, delta } = qualify(on, off);
    // Causal ONLY when every contributing session was blind; a single `menu`
    // (self-selected) session — in any position — keeps the axis observational
    // (#3126). `assignments` holds only regimes that actually contributed a
    // metric, so the claim is order-independent.
    const allBlind = acc.assignments.size > 0 && !acc.assignments.has('menu');
    const mixedRegimes =
      acc.assignments.has('blind') && acc.assignments.has('menu');
    const confidence: Confidence = allBlind ? 'causal' : 'observational';
    // Report the regime honestly: `blind` only when uniformly blind, else `menu`
    // (the conservative, observational label) so `assignment` never disagrees
    // with `confidence`.
    const assignment: SessionEnrollment['assignment'] = allBlind
      ? 'blind'
      : 'menu';
    const caveats = [CONTROL_ARM_BIAS_CAVEAT];
    if (mixedRegimes) caveats.push(MIXED_ASSIGNMENT_CAVEAT);
    else if (!allBlind) caveats.push(MENU_ASSIGNMENT_CAVEAT);
    verdicts.push({
      key,
      label: labelByKey.get(key) ?? key,
      assignment,
      arms: { on, off },
      delta,
      verdict,
      confidence,
      counterMetric: { status: 'not-auto-measured', note: COUNTER_METRIC_NOTE },
      caveats,
      n_total: on.n + off.n,
    });
  }
  // Stable order for a deterministic response/ETag.
  verdicts.sort((a, b) => a.key.localeCompare(b.key));
  return verdicts;
}
