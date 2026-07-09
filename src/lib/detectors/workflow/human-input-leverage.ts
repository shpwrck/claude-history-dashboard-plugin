/**
 * workflow.human-input-leverage — the cheapest tool is the human (zero tokens),
 * yet the engine never quantifies where a *small upfront* human input would have
 * averted a *large* agent excursion. This detector mines that value-of-human-input
 * signal (#2200, keystone of epic #1934).
 *
 * The join now includes:
 *  - `workflow.autonomy-over-steered` corrective steering (`TaskSteering.corrective`)
 *    — the human redirected the assistant after seeing an earlier turn.
 *  - `workflow.autonomy-over-steered` deliberation steering
 *    (`TaskSteering.clarifyingAnswer`) — token-burning human clarification points
 *    where intent was still resolving mid-task.
 *  - `workflow.correction-mining`'s failed→fixed file-path correction signal —
 *    repeated wrong-path fixups are one place where a human could disambiguate
 *    up front.
 *  - `workflow.mid-turn-interrupt-steering`'s in-flight interruption signal — the
 *    literal "[Request interrupted by user]" cue when the user had to cut the
 *    assistant mid-response.
 *
 * An **excursion** is the intersection: a span that ran far (token-spend outlier)
 * against its task-class baseline AND carried at least one human-input signal.
 * Per *task class* (span project) we sum the avoided agent tokens — the
 * excursion's excess over a typical span of that class — and surface ONE auditable
 * recommendation: "task class X is cheaper if you ask the human upfront; ~N tokens
 * saved."
 *
 * Epistemics (ADR 0017 + the auditable-claims contract):
 *  - The MEASUREMENT (these excursions ran far and carried a steering signal) is
 *    auditable: every figure cites `taskSteering` / `tokenData` / `taskSuccess`
 *    and each human-input contribution has its own `provenance` observation.
 *  - The SAVINGS is a CAUSAL counterfactual ("asking upfront WOULD have saved
 *    those tokens"), uncalibrated this release. So `claimClass: 'causal'`,
 *    `proofTier: 'auditable'` (T0) and NO `estSavingsUsd`.
 *  - The interruption-cost threshold (how much asking the human upfront itself
 *    costs) is surfaced as an EXPLICIT named assumption, NOT a silent gate.
 *
 * dataDeps: `taskSteering` (correction/deliberation), `taskSuccess` (accept guard),
 * `tokenData` (span token sizing), `toolData` (correction-mining), `timelines`
 * (mid-turn interrupts), `liveConfig` (CLAUDE.md suppression). Absent / below
 * baseline ⇒ silent.
 */
import type { SessionTokenData, TokenEntry } from '../../../types';
import type { RecommendationInput } from '../types';
import type { AppliedMarkers, Detector, RecObservation } from '../types';
import type { SessionTimeline, TimelineEntry } from '../../parse-timeline';
import type { TaskSteering } from '../../parse-steering';
import type { ToolUsageData } from '../../parse-tools';
import { mineCorrections } from '../../parse-tools';
import { short } from '../shared';
import { claudeMdMarksApplied } from '../shared';

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
  spanTokens: number;
  avoidedTokens: number;
  ratioToMedian: number;
  /** The baseline this span was judged against (its own class median where the
   *  class has enough spans, else the global median). */
  baseline: number;
  signals: HumanSignal[];
}

interface SpanWindow {
  span: TaskSteering;
  spanTokens: number;
  startMs: number;
  endMs: number;
  key: string;
}

type HumanSignal =
  | 'corrective'
  | 'deliberation'
  | 'correction-mining'
  | 'mid-turn-interrupt';

interface ClassRollup {
  taskClass: string;
  excursions: Excursion[];
  avoidedTokens: number;
}

interface MidTurnInterrupt {
  interruptMs: number;
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

function humanSignalLabel(signal: HumanSignal): string {
  if (signal === 'correction-mining') return 'correction-mining';
  if (signal === 'mid-turn-interrupt') return 'mid-turn interruption';
  return signal;
}

function formatSignalPhrase(signals: HumanSignal[]): string {
  return signals.map((s) => humanSignalLabel(s)).join(', ');
}

/** Sort tokens per session so span-window joins are deterministic and bounded. */
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

// Correction-mining join: reuse the upstream `mineCorrections` miner (single
// source of truth — no local stem/window/generic-stem mirror to drift) and keep
// each fact's fix timestamp so it can be located inside a span's time window.
function correctionMiningBySpan(
  spans: SpanWindow[],
  toolData: ToolUsageData[]
): Set<string> {
  const hits = new Set<string>();
  if (spans.length === 0 || toolData.length === 0) return hits;

  const fixMsBySession = new Map<string, number[]>();
  for (const fact of mineCorrections(toolData)) {
    const fixedMs = parseMs(fact.succeededTimestamp);
    if (fixedMs == null) continue;
    const arr = fixMsBySession.get(fact.sessionId);
    if (arr) arr.push(fixedMs);
    else fixMsBySession.set(fact.sessionId, [fixedMs]);
  }
  if (fixMsBySession.size === 0) return hits;

  for (const span of spans) {
    const fixes = fixMsBySession.get(span.span.sessionId);
    if (!fixes || fixes.length === 0) continue;
    if (fixes.some((fixedMs) => fixedMs >= span.startMs && fixedMs <= span.endMs)) {
      hits.add(span.key);
    }
  }
  return hits;
}

function collectSessionInterrupts(entries: TimelineEntry[]): MidTurnInterrupt[] {
  const interrupts: MidTurnInterrupt[] = [];
  if (entries.length === 0) return interrupts;

  let inFlight = false;
  for (const e of entries) {
    const ms = parseMs(e.timestamp);
    if (e.kind === 'user' && !e.interrupted) {
      inFlight = false;
      continue;
    }
    if (e.kind === 'assistant' || e.kind === 'tool_use' || e.kind === 'thinking') {
      inFlight = true;
      continue;
    }
    if (e.kind === 'user' && e.interrupted && ms != null) {
      // The `interrupted` flag is set from the literal "[Request interrupted by
      // user]" sentinel by the parser; detectors read only the flag (as the
      // upstream mid-turn-interrupt-steering detector does), because the bulk
      // timelines the recs engine consumes strip `summary` (parse-timeline
      // slimSessionTimeline). Re-checking the sentinel text here would make the
      // signal never fire in production.
      if (inFlight) interrupts.push({ interruptMs: ms });
      inFlight = false;
    }
  }

  return interrupts;
}

/** Session-level join of mid-turn interrupts into task-steering spans. */
function midTurnBySpan(
  spans: SpanWindow[],
  timelines: SessionTimeline[] | null
): Set<string> {
  const hits = new Set<string>();
  if (spans.length === 0 || !timelines || timelines.length === 0) return hits;

  const spansBySession = new Map<string, SpanWindow[]>();
  for (const span of spans) {
    const arr = spansBySession.get(span.span.sessionId);
    if (arr) arr.push(span);
    else spansBySession.set(span.span.sessionId, [span]);
  }

  for (const timeline of timelines) {
    const sessionSpans = spansBySession.get(timeline.sessionId);
    if (!sessionSpans || sessionSpans.length === 0) continue;

    const interrupts = collectSessionInterrupts(timeline.entries);
    for (const interrupt of interrupts) {
      for (const span of sessionSpans) {
        if (interrupt.interruptMs >= span.startMs && interrupt.interruptMs <= span.endMs) {
          hits.add(span.key);
          break;
        }
      }
    }
  }
  return hits;
}

function collectSpanSignals(
  span: SpanWindow,
  correctionMiningSignals: Set<string>,
  midTurnSignals: Set<string>
): HumanSignal[] {
  const signals: HumanSignal[] = [];
  if (span.span.corrective > 0) signals.push('corrective');
  if (span.span.clarifyingAnswer > 0) signals.push('deliberation');
  if (correctionMiningSignals.has(span.key)) signals.push('correction-mining');
  if (midTurnSignals.has(span.key)) signals.push('mid-turn-interrupt');
  return signals;
}

export const detector: Detector = {
  id: 'workflow.human-input-leverage',
  category: 'workflow',
  dataDeps: ['taskSteering', 'taskSuccess', 'tokenData', 'toolData', 'timelines', 'liveConfig'],
  appliedMarkers: MARKERS_HUMAN_INPUT,
  rule(input: RecommendationInput, now: number) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_HUMAN_INPUT)) return null;

    const steeringRows = input.taskSteering ?? [];
    if (steeringRows.length === 0) return null;

    const successByTask = new Map(
      (input.taskSuccess ?? []).map((row) => [keyOf(row), row])
    );
    const bySession = tokenEntriesBySession(input.tokenData ?? []);

    // Size every span with usable timing and token windows.
    const sized: SpanWindow[] = steeringRows
      .map((span) => {
        const spanTokens = spanTokensFor(span, bySession);
        const startMs = parseMs(span.startTime);
        const endMs = parseMs(span.endTime);
        if (spanTokens <= 0 || startMs == null || endMs == null) return null;
        return { span, spanTokens, startMs, endMs, key: keyOf(span) };
      })
      .filter((s): s is SpanWindow => s != null);
    if (sized.length < MIN_BASELINE_SPANS) return null;

    const globalMed = median(sized.map((s) => s.spanTokens));
    if (globalMed <= 0) return null;

    // Per-class baselines: an excursion's avoidable cost is attributed to its
    // task class, so it must be judged against *that class's own* typical span.
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

    const correctionMiningSignals = correctionMiningBySpan(sized, input.toolData ?? []);
    const midTurnSignals = midTurnBySpan(sized, input.timelines ?? null);

    // Excursion = run far beyond baseline and carried at least one steering signal.
    const excursions: Excursion[] = [];
    for (const span of sized) {
      const signals = collectSpanSignals(span, correctionMiningSignals, midTurnSignals);
      if (signals.length === 0) continue;

      const cls = span.span.project || 'unknown';
      const baseline = baselineFor(cls);
      if (span.spanTokens <= OUTLIER_FACTOR * baseline) continue;
      if (span.spanTokens <= ABS_FLOOR_TOKENS) continue;

      const success = successByTask.get(span.key);
      if (success?.verdict === 'accept') continue;

      excursions.push({
        taskClass: cls,
        sessionId: span.span.sessionId,
        taskIndex: span.span.taskIndex,
        endMs: span.endMs,
        spanTokens: span.spanTokens,
        avoidedTokens: Math.max(0, span.spanTokens - baseline),
        ratioToMedian: span.spanTokens / baseline,
        baseline,
        signals,
      });
    }
    if (excursions.length === 0) return null;

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

    const latestMs = Math.max(...excursions.map((e) => e.endMs));
    const asOf = latestMs ? isoDate(latestMs) : undefined;
    const stale = asOf != null && now - latestMs > FRESHNESS_DAYS * DAY_MS;
    const asOfPrefix = stale && asOf ? `As of ${asOf}, ` : '';

    const classPhrase =
      classes.length === 1
        ? `task class "${top.taskClass}"`
        : `${classes.length} task classes (top: "${top.taskClass}")`;

    const excursionsBySignal = {
      corrective: excursions.filter((e) => e.signals.includes('corrective')).length,
      deliberation: excursions.filter((e) => e.signals.includes('deliberation')).length,
      correctionMining: excursions.filter((e) => e.signals.includes('correction-mining')).length,
      midTurnInterrupt: excursions.filter((e) => e.signals.includes('mid-turn-interrupt')).length,
    };

    const evidence = classes.slice(0, 5).map((roll) => {
      const lead = roll.excursions
        .slice()
        .sort((a, b) => b.avoidedTokens - a.avoidedTokens)[0];
      return (
        `${roll.taskClass}: ${roll.excursions.length} excursion(s), ` +
        `~${fmtTokens(roll.avoidedTokens)} tokens avoidable upfront ` +
        `(e.g. ${short(lead.sessionId)} task ${lead.taskIndex}: ` +
        `${fmtTokens(lead.spanTokens)} tokens, ${lead.ratioToMedian.toFixed(1)}x its ` +
        `class baseline of ${fmtTokens(lead.baseline)}, signals: ${formatSignalPhrase(lead.signals)})`
      );
    });

    const observations: RecObservation[] = [
      {
        claim:
          `${excursions.length} task span(s) across ${classes.length} task class(es) ` +
          `each ran past ${OUTLIER_FACTOR}x its OWN task class's median span spend ` +
          `(class baseline, falling back to the global median of ${fmtTokens(globalMed)} ` +
          `tokens for thin classes) and carried at least one of the four join signals: ` +
          `a human corrective turn, a human clarification turn, a mid-turn user interrupt, ` +
          `or the agent's own failed→fixed correction-mining pair (the last is an agent ` +
          `retry, not a human signal, but a place a human could have disambiguated up front)`,
        source: 'parse-steering + parse-tools + parse-timeline + tokenData',
        field:
          'TaskSteering.corrective / TaskSteering.clarifyingAnswer / toolData[].calls[].isError / ' +
          'TimelineEntry.interrupted, joined to tokenData entries within [startTime,endTime]',
        value: excursions.length,
      },
      {
        claim:
          `the outlier portion (span tokens over that span's class baseline) sums to ` +
          `~${fmtTokens(totalAvoided)} agent tokens, led by "${top.taskClass}" ` +
          `(~${fmtTokens(top.avoidedTokens)} tokens)`,
        source: 'parse-sessions',
        field: 'TokenEntry.inputTokens+outputTokens+cacheCreationTokens+cacheReadTokens',
        value: Math.round(totalAvoided),
      },
      {
        claim:
          `each candidate excursion was not explicitly accepted by the human, ` +
          `so "accept"-flagged steering was excluded`,
        source: 'parse-task-success',
        field: 'TaskSuccessProxy.verdict',
        value: excursions.length,
      },
    ];

    if (excursionsBySignal.corrective > 0) {
      observations.push({
        claim:
          `${excursionsBySignal.corrective} excursion(s) had late corrective turns ` +
          `(${excursionsBySignal.corrective}/${excursions.length} total)`,
        source: 'parse-steering',
        field: 'TaskSteering.corrective',
        value: excursionsBySignal.corrective,
      });
    }
    if (excursionsBySignal.deliberation > 0) {
      observations.push({
        claim:
          `${excursionsBySignal.deliberation} excursion(s) had deliberate token-burning ` +
          `clarification turns (` +
          'TaskSteering.clarifyingAnswer)',
        source: 'parse-steering',
        field: 'TaskSteering.clarifyingAnswer',
        value: excursionsBySignal.deliberation,
      });
    }
    if (excursionsBySignal.correctionMining > 0) {
      observations.push({
        claim:
          `${excursionsBySignal.correctionMining} excursion(s) aligned with ` +
          'failed→fixed file-path correction signals',
        source: 'parse-tools',
        field: 'toolData[].calls[].isError',
        value: excursionsBySignal.correctionMining,
      });
    }
    if (excursionsBySignal.midTurnInterrupt > 0) {
      observations.push({
        claim:
          `${excursionsBySignal.midTurnInterrupt} excursion(s) aligned with ` +
          'mid-turn user interrupts',
        source: 'parse-timeline',
        field: 'TimelineEntry.interrupted',
        value: excursionsBySignal.midTurnInterrupt,
      });
    }

    return {
      id: 'workflow.human-input-leverage',
      category: 'workflow',
      severity: excursions.length >= 3 ? 'warning' : 'info',
      title: 'Ask the human upfront on costly, correction-prone task classes',
      detail:
        `${asOfPrefix}${excursions.length} agent excursion(s) in ${classPhrase} ran more than ` +
        `${OUTLIER_FACTOR}x their own task class's median span spend and carried at least one ` +
        `human-input-leverage signal — a human corrective turn, a human clarification turn, or a ` +
        `mid-turn user interrupt, or else the agent's OWN failed→fixed correction-mining pair (an ` +
        `agent retry, not a human signal, but a spot an upfront human answer could have averted). ` +
        `Roughly ${fmtTokens(totalAvoided)} agent tokens sit in the ` +
        `outlier excess that a cheap upfront human input could have averted. This is an ` +
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
          `An excursion that ran far and carried downstream human steering is a likely ` +
          `point where a small upfront input has leverage: what was corrected, clarified, ` +
          `repaired, or interrupted after-the-fact could have been asked up front.` +
          ` The token figure is the measured outlier excess (auditable); that asking ` +
          `upfront WOULD have saved it is a causal hypothesis, uncalibrated until the ` +
          `interruption-cost threshold is measured against real firings.`,
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
