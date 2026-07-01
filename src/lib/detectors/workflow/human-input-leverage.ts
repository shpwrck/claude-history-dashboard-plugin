/**
 * workflow.human-input-leverage — the cheapest tool is the human (zero tokens),
 * yet the engine never quantifies where a *small upfront* human input would have
 * averted a *large* agent excursion. This detector mines that value-of-human-input
 * signal (#2200, keystone of epic #1934).
 *
 * The join (the "Where" two reused signals):
 *  - `workflow.autonomy-over-steered` contributes the *late human correction*
 *    signal — a task span whose human steering was corrective (the human had to
 *    point back at the agent's last action and redirect it; `TaskSteering.corrective`,
 *    the #1751 structural-anchor count), as opposed to mere approval.
 *  - `workflow.runaway-workflow-cost` contributes the *outlier-spend* methodology
 *    — a median baseline, an `OUTLIER_FACTOR` multiple, and an absolute floor so a
 *    set of uniformly-small spans never trips it. Because we attribute the excess
 *    to a specific task class, the baseline is that class's OWN median span (the
 *    global median is only a fallback for classes too thin to have their own),
 *    so a project whose spans are uniformly large is not flagged for its normal
 *    size (a mixed-workload confound).
 *
 * An **excursion** is the intersection: a span that ran far (token-spend outlier
 * vs its own class baseline) AND ended in a late human correction. Per *task
 * class* (the span's project) we sum the avoided agent tokens — the excursion's
 * excess over a typical span of that class — and surface ONE auditable
 * recommendation: "task class X is cheaper if you ask the human upfront; ~N
 * tokens saved".
 *
 * Epistemics (ADR 0017 + the auditable-claims contract):
 *  - The MEASUREMENT (these excursions ran far and were corrected) is auditable:
 *    every figure cites `taskSteering` / `tokenData` / `taskSuccess`.
 *  - The SAVINGS is a CAUSAL counterfactual ("asking upfront WOULD have saved
 *    those tokens"), uncalibrated this release. So `claimClass: 'causal'`,
 *    `proofTier: 'auditable'` (T0) and NO `estSavingsUsd` — we do not assert a
 *    cost win above the accounting tier without experimental backing.
 *  - The interruption-cost threshold (how much asking the human upfront itself
 *    costs) is surfaced as an EXPLICIT named assumption, NOT a silent gate — the
 *    dual of the over-steering knob (#1288). Calibrate once real firings reveal
 *    the distribution.
 *
 * dataDeps: `taskSteering` (correction signal), `taskSuccess` (accept guard),
 * `tokenData` (span token sizing), `liveConfig` (CLAUDE.md suppression). Absent /
 * below the baseline ⇒ silent.
 */
import type { TaskSteering } from '../../parse-steering';
import type { SessionTokenData, TokenEntry } from '../../../types';
import type { AppliedMarkers, Detector, RecObservation } from '../types';
import { claudeMdMarksApplied, short } from '../shared';

// Need at least this many token-sized spans before a median is a meaningful
// baseline (mirrors runaway-workflow-cost's MIN_RUNS).
const MIN_BASELINE_SPANS = 4;
// A span must exceed this multiple of the median span-spend to count as runaway.
const OUTLIER_FACTOR = 3;
// ...and clear this absolute floor, so uniformly-small spans never trip it. A
// task span is smaller-grained than a whole Workflow run, so the floor is below
// runaway-workflow-cost's 200k.
const ABS_FLOOR_TOKENS = 50_000;

// ── Named, uncalibrated assumption (the dual of over-steering #1288) ──────────
// Asking the human upfront is not free: it costs one interruption. We do NOT
// subtract this from the avoided tokens (that would be a silent gate on an
// uncalibrated number); we SURFACE it as the threshold below which the trade is
// worth it, and say plainly that it is uncalibrated. Calibrate from real firings.
const ASSUMED_INTERRUPTION_TOKENS = 2_000;

// Freshness: an excursion older than this (relative to `now`) makes the signal
// historical, so present-tense wording is demoted to "as of <date>".
const FRESHNESS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Suppression — the user has already documented an ask-upfront policy.
const MARKERS_HUMAN_INPUT: AppliedMarkers = {
  headings: [/^##\s+(?:Ask(?:ing)? upfront|Human input|Value of human input|Upfront questions)\b/i],
  bodyPhrases: ['ask the human upfront'],
};

interface Excursion {
  taskClass: string;
  sessionId: string;
  taskIndex: number;
  endMs: number;
  endDate: string;
  spanTokens: number;
  avoidedTokens: number;
  corrective: number;
  clarifying: number;
  ratioToMedian: number;
  /** The baseline this span was judged against (its own class median where the
   *  class has enough spans, else the global median). */
  baseline: number;
}

interface ClassRollup {
  taskClass: string;
  excursions: Excursion[];
  avoidedTokens: number;
}

function keyOf(row: { sessionId: string; taskIndex: number }): string {
  return `${row.sessionId}\0${row.taskIndex}`;
}

function parseMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function entryTokens(entry: TokenEntry): number {
  // cacheCreation1hTokens is a subset of cacheCreationTokens — don't double-count.
  return (
    entry.inputTokens +
    entry.outputTokens +
    entry.cacheCreationTokens +
    entry.cacheReadTokens
  );
}

/** Sorted (by ms) token entries per session, for the span-window join. */
function tokenEntriesBySession(
  tokenData: SessionTokenData[]
): Map<string, { ms: number; tokens: number }[]> {
  const bySession = new Map<string, { ms: number; tokens: number }[]>();
  for (const data of tokenData) {
    const rows: { ms: number; tokens: number }[] = [];
    for (const entry of data.entries) {
      const ms = parseMs(entry.timestamp);
      if (ms == null) continue;
      rows.push({ ms, tokens: entryTokens(entry) });
    }
    rows.sort((a, b) => a.ms - b.ms);
    bySession.set(data.sessionId, rows);
  }
  return bySession;
}

/** Agent tokens spent inside a steering span's [startTime, endTime] window. */
function spanTokensFor(
  span: TaskSteering,
  bySession: Map<string, { ms: number; tokens: number }[]>
): number {
  const rows = bySession.get(span.sessionId);
  if (!rows || rows.length === 0) return 0;
  const startMs = parseMs(span.startTime);
  const endMs = parseMs(span.endTime);
  if (startMs == null || endMs == null) return 0;
  let total = 0;
  for (const row of rows) {
    if (row.ms < startMs) continue;
    if (row.ms > endMs) break;
    total += row.tokens;
  }
  return total;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtTokens(n: number): string {
  return Math.round(n).toLocaleString();
}

export const detector: Detector = {
  id: 'workflow.human-input-leverage',
  category: 'workflow',
  dataDeps: ['taskSteering', 'taskSuccess', 'tokenData', 'liveConfig'],
  appliedMarkers: MARKERS_HUMAN_INPUT,
  rule(input, now) {
    // Adoption suppression: if the user already documented an ask-upfront policy
    // in CLAUDE.md, this finding is handled — stay silent.
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_HUMAN_INPUT)) return null;

    const steeringRows = input.taskSteering ?? [];
    if (steeringRows.length === 0) return null;
    const successByTask = new Map(
      (input.taskSuccess ?? []).map((row) => [keyOf(row), row])
    );
    const bySession = tokenEntriesBySession(input.tokenData ?? []);

    // Size every span; the token-sized spans form the outlier baseline.
    const sized = steeringRows
      .map((span) => ({ span, spanTokens: spanTokensFor(span, bySession) }))
      .filter((s) => s.spanTokens > 0);
    if (sized.length < MIN_BASELINE_SPANS) return null;

    const globalMed = median(sized.map((s) => s.spanTokens));
    if (globalMed <= 0) return null;

    // Per-class baselines: an excursion's avoidable cost is attributed to its
    // task class, so it must be judged against *that class's own* typical span,
    // not a global median. Otherwise a project whose spans are uniformly large
    // trips a global threshold and reports its normal size as avoidable (a
    // mixed-workload confound). Use the class median when the class has enough
    // spans to be meaningful; fall back to the global median for thin classes.
    const sizedByClass = new Map<string, number[]>();
    for (const { span, spanTokens } of sized) {
      const cls = span.project || 'unknown';
      const arr = sizedByClass.get(cls);
      if (arr) arr.push(spanTokens);
      else sizedByClass.set(cls, [spanTokens]);
    }
    const baselineFor = (cls: string): number => {
      const arr = sizedByClass.get(cls);
      if (arr && arr.length >= MIN_BASELINE_SPANS) {
        const m = median(arr);
        if (m > 0) return m;
      }
      return globalMed;
    };

    // Excursion = ran far past its own class baseline (token outlier) AND ended
    // in a late human correction.
    const excursions: Excursion[] = [];
    for (const { span, spanTokens } of sized) {
      if (span.corrective <= 0) continue; // no late corrective turn ⇒ not this signal
      const cls = span.project || 'unknown';
      const baseline = baselineFor(cls);
      if (spanTokens <= OUTLIER_FACTOR * baseline) continue;
      if (spanTokens <= ABS_FLOOR_TOKENS) continue;
      // Accept guard: if the human explicitly ACCEPTED the result, the steering
      // wasn't a costly misdirection — an upfront input would not have helped.
      const success = successByTask.get(keyOf(span));
      if (success?.verdict === 'accept') continue;
      const endMs = parseMs(span.endTime) ?? 0;
      excursions.push({
        taskClass: cls,
        sessionId: span.sessionId,
        taskIndex: span.taskIndex,
        endMs,
        endDate: endMs ? isoDate(endMs) : '',
        spanTokens,
        avoidedTokens: Math.max(0, spanTokens - baseline),
        corrective: span.corrective,
        clarifying: span.clarifyingAnswer,
        ratioToMedian: spanTokens / baseline,
        baseline,
      });
    }
    if (excursions.length === 0) return null;

    // Roll up per task class, ordered by avoided tokens.
    const byClass = new Map<string, ClassRollup>();
    for (const exc of excursions) {
      const roll = byClass.get(exc.taskClass) ?? {
        taskClass: exc.taskClass,
        excursions: [],
        avoidedTokens: 0,
      };
      roll.excursions.push(exc);
      roll.avoidedTokens += exc.avoidedTokens;
      byClass.set(exc.taskClass, roll);
    }
    const classes = [...byClass.values()].sort(
      (a, b) => b.avoidedTokens - a.avoidedTokens
    );
    const totalAvoided = excursions.reduce((s, e) => s + e.avoidedTokens, 0);
    const top = classes[0];

    // Staleness: demote present-tense wording when the most recent excursion is
    // older than the freshness window.
    const latestMs = Math.max(...excursions.map((e) => e.endMs));
    const asOf = latestMs ? isoDate(latestMs) : undefined;
    const stale = asOf != null && now - latestMs > FRESHNESS_DAYS * DAY_MS;
    const asOfPrefix = stale && asOf ? `As of ${asOf}, ` : '';

    const classPhrase =
      classes.length === 1
        ? `task class "${top.taskClass}"`
        : `${classes.length} task classes (top: "${top.taskClass}")`;

    const evidence = classes.slice(0, 5).map((roll) => {
      const lead = roll.excursions
        .slice()
        .sort((a, b) => b.avoidedTokens - a.avoidedTokens)[0];
      return (
        `${roll.taskClass}: ${roll.excursions.length} excursion(s), ` +
        `~${fmtTokens(roll.avoidedTokens)} tokens avoidable upfront ` +
        `(e.g. ${short(lead.sessionId)} task ${lead.taskIndex}: ` +
        `${fmtTokens(lead.spanTokens)} tokens, ${lead.ratioToMedian.toFixed(1)}x its ` +
        `class baseline of ${fmtTokens(lead.baseline)}, ${lead.corrective} corrective turn(s))`
      );
    });

    const observations: RecObservation[] = [
      {
        claim:
          `${excursions.length} task span(s) across ${classes.length} task class(es) ` +
          `each ran past ${OUTLIER_FACTOR}x its OWN task class's median span spend ` +
          `(class baseline, falling back to the global median of ` +
          `${fmtTokens(globalMed)} tokens for thin classes) AND ended in a late ` +
          `human correction`,
        source: 'parse-steering + tokenData',
        field: 'TaskSteering.corrective + tokenData entries within [startTime,endTime]',
        value: excursions.length,
      },
      {
        claim:
          `the outlier portion (span tokens over that span's class baseline) sums to ` +
          `~${fmtTokens(totalAvoided)} agent tokens, led by "${top.taskClass}" ` +
          `(~${fmtTokens(top.avoidedTokens)} tokens)`,
        source: 'tokenData',
        field: 'TokenEntry.inputTokens+outputTokens+cacheCreationTokens+cacheReadTokens',
        value: Math.round(totalAvoided),
      },
      {
        claim:
          `each excursion's span carried a corrective human turn, and none was an ` +
          `explicit "accept" verdict (accepted spans are excluded)`,
        source: 'parse-task-success',
        field: 'TaskSuccessProxy.verdict',
        value: excursions.length,
      },
    ];

    return {
      id: 'workflow.human-input-leverage',
      category: 'workflow',
      severity: excursions.length >= 3 ? 'warning' : 'info',
      title: 'Ask the human upfront on costly, correction-prone task classes',
      detail:
        `${asOfPrefix}${excursions.length} agent excursion(s) in ${classPhrase} ran more than ` +
        `${OUTLIER_FACTOR}x their own task class's median span spend AND ended in a late human ` +
        `correction. Roughly ${fmtTokens(totalAvoided)} agent tokens sit in the outlier ` +
        `excess that a cheap upfront human input could have averted. This is an ` +
        `ESTIMATE: it assumes asking the human upfront (~${fmtTokens(ASSUMED_INTERRUPTION_TOKENS)} ` +
        `tokens for one interruption) costs less than the excursion it averts — an ` +
        `uncalibrated interruption-cost threshold, surfaced here rather than silently ` +
        `gated, to be calibrated once real firings reveal the distribution.`,
      action:
        `For "${top.taskClass}"-style tasks, front-load the decision the human ` +
        `ended up making anyway: ask one scoping question (or pre-answer it in ` +
        `CLAUDE.md / the task prompt) before the agent starts, instead of letting ` +
        `it run far and correcting late. Weigh it against the interruption cost — ` +
        `worth it only when the averted excursion is larger.`,
      affected: excursions.length,
      view: 'recommendations',
      evidence,
      claimClass: 'causal',
      proofTier: 'auditable',
      provenance: {
        observations,
        inference:
          `An excursion that ran far AND was corrected late is exactly where a small ` +
          `upfront human input has leverage: the correction the human made at the end ` +
          `could have steered the task before the excess tokens were spent. The token ` +
          `figure is the measured outlier excess (auditable); that asking upfront WOULD ` +
          `have saved it is a causal hypothesis, uncalibrated until the interruption-cost ` +
          `threshold is measured against real firings.`,
        ...(asOf ? { asOf } : {}),
        ...(asOf ? { stale } : {}),
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Document ask-upfront task classes',
        note: 'Adapt the task-class name and the scoping question to your own correction-prone classes.',
        fixKind: 'illustrative',
        appliedMarkers: MARKERS_HUMAN_INPUT,
        snippet:
          '## Ask upfront on correction-prone task classes\n\n' +
          '- For task classes that historically run far and then get corrected late,\n' +
          '  ask the human upfront: pose one scoping question before starting, or\n' +
          '  pre-answer it in the task prompt.\n' +
          '- Prefer a cheap upfront human input over a long agent excursion that is redirected\n' +
          '  at the end — but only when the averted excursion is larger than the interruption.',
      },
    };
  },
};
