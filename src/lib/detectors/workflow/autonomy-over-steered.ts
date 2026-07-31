import type { TaskSteering } from '../../parse-steering';
import type { TaskSuccessProxy } from '../../parse-task-success';
import type { Detector, RecommendationInput } from '../types';
import { short } from '../shared';

const MIN_STEERING_LOAD = 1;
const PASSING_SUCCESS_SCORE = 0.9;

const WEIGHTS = {
  corrective: 2,
  clarifyingAnswer: 1.25,
  approving: 1,
  interruptions: 2,
} as const;

interface Candidate {
  steering: TaskSteering;
  success: TaskSuccessProxy;
  steeringLoad: number;
  effectiveAutonomy: number;
  reclaimableTurns: number;
}

// Minimum corpus size before the monotone-inverse cross-check is meaningful; a
// handful of spans cannot establish a trend, so we surface on the precision-gated
// signal alone below this and only run the suppression check once there is enough
// signal to falsify it (#1751).
const MIN_MONOTONE_SPANS = 3;

function keyOf(row: { sessionId: string; taskIndex: number }): string {
  return `${row.sessionId}\0${row.taskIndex}`;
}

function weightedSteering(row: TaskSteering): number {
  return (
    row.corrective * WEIGHTS.corrective +
    row.clarifyingAnswer * WEIGHTS.clarifyingAnswer +
    row.approving * WEIGHTS.approving +
    row.interruptions * WEIGHTS.interruptions
  );
}

function agentTurnDenominator(success: TaskSuccessProxy): number {
  return Math.max(1, success.toolCallCount);
}

function steeringLoad(
  steering: TaskSteering,
  success: TaskSuccessProxy
): number {
  return weightedSteering(steering) / agentTurnDenominator(success);
}

function reclaimableTurns(row: TaskSteering): number {
  return row.corrective + row.clarifyingAnswer + row.approving;
}

function passesQualityGate(success: TaskSuccessProxy): boolean {
  return (
    success.confidence === 'high' &&
    success.successScore >= PASSING_SUCCESS_SCORE
  );
}

function findCandidates(input: RecommendationInput): Candidate[] {
  const steeringRows = input.taskSteering ?? [];
  const successByTask = new Map(
    (input.taskSuccess ?? []).map((row) => [keyOf(row), row])
  );
  const candidates: Candidate[] = [];

  for (const steering of steeringRows) {
    const success = successByTask.get(keyOf(steering));
    if (!success || !passesQualityGate(success)) continue;
    const turns = reclaimableTurns(steering);
    if (turns <= 0) continue;
    const load = steeringLoad(steering, success);
    if (load < MIN_STEERING_LOAD) continue;
    candidates.push({
      steering,
      success,
      steeringLoad: load,
      effectiveAutonomy: 1 / (1 + load),
      reclaimableTurns: turns,
    });
  }

  return candidates.sort((a, b) => {
    if (b.reclaimableTurns !== a.reclaimableTurns) {
      return b.reclaimableTurns - a.reclaimableTurns;
    }
    if (b.steeringLoad !== a.steeringLoad) {
      return b.steeringLoad - a.steeringLoad;
    }
    if (a.steering.sessionId !== b.steering.sessionId) {
      return a.steering.sessionId.localeCompare(b.steering.sessionId);
    }
    return a.steering.taskIndex - b.steering.taskIndex;
  });
}

function fmtPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Monotone-inverse cross-check (#1751 suppression path).
 *
 * The surfaced corrective signal is only trustworthy if it behaves the way the
 * autonomy thesis predicts: spans with a *higher* steering-divergence rate
 * should show *lower* autonomy-proxy success. We test this on every steering row
 * that has a matched success proxy (not just the over-steered candidates) by the
 * sign of the concordant-minus-discordant pair count between `divergenceRate`
 * and `successScore`. If the relationship is not inverse on the real corpus, the
 * detector logs-don't-surface (returns suppression) rather than asserting a
 * claim the data does not support.
 *
 * Returns the directional fraction in [-1, 1]: negative ⇒ inverse (good),
 * positive ⇒ same-direction (suppress), with `null` when there is too little
 * paired data to judge.
 */
/**
 * Count unordered pairs tied on a key (Σ t(t−1)/2 over equal-value groups).
 * Numeric keys use SameValueZero (so −0 groups with 0), matching the original
 * `d === 0` skip; the composite (both-tied) key is a `\0`-joined string.
 */
function tiedPairCount(values: Array<number | string>): number {
  const counts = new Map<number | string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let sum = 0;
  for (const c of counts.values()) sum += (c * (c - 1)) / 2;
  return sum;
}

/**
 * Merge-sort inversion count: unordered pairs i&lt;j with `arr[i] > arr[j]`
 * (STRICT). Equal values are never counted as inversions, so score ties drop out.
 */
function countStrictInversions(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  const buf = arr.slice();
  const tmp = new Array<number>(n);
  let inv = 0;
  const sort = (lo: number, hi: number): void => {
    if (hi - lo < 2) return;
    const mid = (lo + hi) >> 1;
    sort(lo, mid);
    sort(mid, hi);
    let i = lo;
    let j = mid;
    let k = lo;
    while (i < mid && j < hi) {
      if (buf[i] <= buf[j]) {
        tmp[k++] = buf[i++];
      } else {
        // buf[i] > buf[j]: buf[j] is strictly smaller than every remaining
        // left-half element, so each contributes one inversion.
        inv += mid - i;
        tmp[k++] = buf[j++];
      }
    }
    while (i < mid) tmp[k++] = buf[i++];
    while (j < hi) tmp[k++] = buf[j++];
    for (let t = lo; t < hi; t += 1) buf[t] = tmp[t];
  };
  sort(0, n);
  return inv;
}

export function divergenceAutonomyConcordance(
  steeringRows: TaskSteering[],
  successByTask: Map<string, TaskSuccessProxy>
): number | null {
  const pairs = steeringRows
    .map((row) => {
      const success = successByTask.get(keyOf(row));
      return success
        ? { divergence: row.divergenceRate, score: success.successScore }
        : null;
    })
    .filter((p): p is { divergence: number; score: number } => p != null);

  if (pairs.length < MIN_MONOTONE_SPANS) return null;

  // Goodman–Kruskal gamma in O(n log n) (#3233). The old n(n−1)/2 pairwise scan
  // is exactly: (# concordant − # discordant) / (# comparable), where a pair is
  // COMPARABLE only when it ties in NEITHER dimension (the `dDiv === 0 ||
  // dScore === 0` skips). Sorting by divergence (ties broken by score ascending
  // so no equal-divergence pair is miscounted) turns "# discordant" into the
  // score-inversion count, and the comparable total follows by inclusion–
  // exclusion on the tie counts. The returned fraction is unchanged for finite
  // inputs; only the cost drops from quadratic to n log n.
  const n = pairs.length;
  const totalPairs = (n * (n - 1)) / 2;
  const tiedDivergence = tiedPairCount(pairs.map((p) => p.divergence));
  const tiedScore = tiedPairCount(pairs.map((p) => p.score));
  const tiedBoth = tiedPairCount(pairs.map((p) => `${p.divergence}\0${p.score}`));
  const comparable = totalPairs - tiedDivergence - tiedScore + tiedBoth;
  if (comparable === 0) return null;

  const sorted = [...pairs].sort(
    (a, b) => a.divergence - b.divergence || a.score - b.score
  );
  const discordant = countStrictInversions(sorted.map((p) => p.score));
  const concordant = comparable - discordant;
  // Positive ⇒ same-direction dominates (bad); negative ⇒ inverse dominates.
  return (concordant - discordant) / comparable;
}

export const detector: Detector = {
  id: 'workflow.autonomy-over-steered',
  category: 'workflow',
  dataDeps: ['taskSteering', 'taskSuccess'],
  rule(input) {
    const candidates = findCandidates(input);
    if (candidates.length === 0) return null;

    // Monotone-inverse suppression (#1751): if divergenceRate does NOT track
    // inversely with the autonomy-proxy success across the corpus, the corrective
    // signal is not behaving as the autonomy thesis predicts — log-don't-surface.
    const steeringRows = input.taskSteering ?? [];
    const successByTask = new Map(
      (input.taskSuccess ?? []).map((row) => [keyOf(row), row])
    );
    const concordance = divergenceAutonomyConcordance(
      steeringRows,
      successByTask
    );
    // `null` ⇒ too little paired data to falsify; surface on the precision-gated
    // signal alone. A non-negative value ⇒ divergence rises with (or is flat
    // against) success — the wrong direction — so suppress.
    if (concordance !== null && concordance >= 0) return null;

    const totalTurns = candidates.reduce(
      (sum, candidate) => sum + candidate.reclaimableTurns,
      0
    );
    const avgDivergence =
      candidates.reduce(
        (sum, candidate) => sum + candidate.steering.divergenceRate,
        0
      ) / candidates.length;
    const avgAutonomy =
      candidates.reduce(
        (sum, candidate) => sum + candidate.effectiveAutonomy,
        0
      ) / candidates.length;
    const avgLoad =
      candidates.reduce((sum, candidate) => sum + candidate.steeringLoad, 0) /
      candidates.length;

    return {
      id: 'workflow.autonomy-over-steered',
      category: 'workflow',
      severity: candidates.length >= 3 || totalTurns >= 6 ? 'warning' : 'info',
      title: 'Over-steered successful tasks - reclaim human time',
      detail:
        `${candidates.length} high-confidence successful task span(s) still needed ` +
        `${totalTurns} corrective, clarifying, or approval turn(s). Average ` +
        `effective autonomy was ${fmtPct(avgAutonomy)} with normalized steering ` +
        `load ${avgLoad.toFixed(2)} and steering-divergence rate ` +
        `${fmtPct(avgDivergence)}, so the human steering was likely babysitting ` +
        `rather than load-bearing.`,
      action:
        'For recurring tasks like these, let the agent complete a full pass before ' +
        'steering it. Pre-answer repeated clarifications in CLAUDE.md, pre-grant ' +
        'safe approvals, or use acceptEdits/scoped allow rules where the task class ' +
        'already has high-confidence success evidence.',
      affected: candidates.length,
      estTimeReclaimedMin: totalTurns,
      view: 'recommendations',
      evidence: candidates.slice(0, 5).map((candidate) => {
        const { steering, success } = candidate;
        return (
          `${short(steering.sessionId)} task ${steering.taskIndex}: ` +
          `${candidate.reclaimableTurns} steering turn(s), load ` +
          `${candidate.steeringLoad.toFixed(2)}, divergence ` +
          `${fmtPct(steering.divergenceRate)}, success ` +
          `${success.successScore.toFixed(2)}`
        );
      }),
      provenance: {
        observations: [
          {
            claim:
              `${candidates.length} task span(s) passed the high-confidence ` +
              `success gate and had normalized steering load >= ${MIN_STEERING_LOAD}`,
            source: 'taskSteering + taskSuccess',
            field: 'taskSteering/taskSuccess',
            value: candidates.length,
          },
          {
            claim:
              `${totalTurns} corrective, clarifying-answer, or approval turn(s) ` +
              'were observed on those successful spans',
            source: 'parse-steering',
            field: 'TaskSteering.corrective/clarifyingAnswer/approving',
            value: totalTurns,
          },
          {
            claim:
              `average steering-divergence rate ${fmtPct(avgDivergence)} on the ` +
              'over-steered spans, and divergenceRate tracks inversely with the ' +
              'autonomy-proxy success across the corpus',
            source: 'parse-steering + parse-task-success',
            field: 'TaskSteering.divergenceRate vs TaskSuccessProxy.successScore',
            value: Number(avgDivergence.toFixed(3)),
          },
        ],
        inference:
          'The quality gate is high-confidence task success and does not use cost. ' +
          'Because those spans passed while steering load and divergence stayed ' +
          'high, the steering is treated as reclaimable human time rather than ' +
          'necessary supervision. The signal is only surfaced when divergenceRate ' +
          'is monotone-inverse with the autonomy proxy on the real corpus; ' +
          'otherwise it is logged, not surfaced.',
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Document autonomy defaults',
        note:
          'Add standing guidance for task classes that already clear the quality gate. ' +
          'Use scoped settings/permissions separately when a safe approval is the repeat bottleneck.',
        snippet:
          '## Autonomy defaults for proven tasks\n\n' +
          '- When a recurring task class already has high-confidence success evidence, let the agent complete a full pass before correcting course.\n' +
          '- Pre-answer recurring clarifications in the task prompt or project guidance before the run starts.\n' +
          '- For safe repeat edits, prefer acceptEdits or a scoped allow rule over repeated interactive approvals.',
      },
    };
  },
};
