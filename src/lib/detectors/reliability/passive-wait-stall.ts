import type { Detector, Recommendation, RecObservation } from '../types';
import type { SessionTimeline, TimelineEntry, WaitClass } from '../../parse-timeline';

/**
 * `reliability.passive-wait-stall` (#1873).
 *
 * Signature: an assistant turn ENDS on wait/monitor language ("I'll wait", "I'll
 * report when it finishes", "I'll surface the rollup when the watcher fires") with
 * **no** harness-backed background mechanism, so the session cannot resume on its
 * own and the next actor is forced to be the human. Measured over the local
 * corpus the separation is clean: explicitly backgrounded work and deliberate
 * Monitor/ScheduleWakeup polls forced 0 human turns — they self-resumed — while passive
 * waits forced a human re-engagement, often after minutes of silence.
 *
 * The per-turn classification lives in `parse-timeline.ts` (which alone sees the
 * assistant text + tool blocks — `parse-runtime-events.ts` only parses
 * `type:"system"` telemetry lines): `entries[].waitLanguage` flags an assistant
 * text that ends on a passive wait, and `entries[].backgrounded` flags a tool_use
 * that self-resumes. This detector walks those flags per session, attributes each
 * passive-wait turn-end to the silence gap before the forced human prompt, and
 * weights the finding by that gap (longer gap ⇒ higher-confidence stall).
 *
 * "Forced human turn" counts only a real human prompt (`kind === 'user'`); a
 * `tool_result` `user` record keeps the turn going and never counts.
 */

const MIN_STALLS = 3; // noise floor — never fire on one or two
// A turn-end only counts as a stall when the human re-engaged after real silence.
// A sub-minute gap means the human was already in the loop (a live "I'll wait for
// your input" back-and-forth), which the issue calls out as a natural conversation
// continuation, not a literal stall — exclude it so `affected` is honest. The
// genuine-stall gap distribution (issue #1873) has a ~2.6-min median. (#1873)
const MIN_STALL_GAP_MS = 60 * 1000; // 1 minute
const HIGH_CONFIDENCE_GAP_MS = 5 * 60 * 1000; // the "likely genuine stall" floor (#1873)
const MAX_EVIDENCE = 5;

export interface Stall {
  sessionId: string;
  turnEndTs: string;
  silenceGapMs: number;
  snippet: string;
  /**
   * The kind of external wait this turn-end was on (#1880), read from the
   * parser-set `entries[].waitClass`. `'generic'` when the parser saw wait
   * language but no class-specific signal (or, defensively, when an older
   * dataset predates the field). The `workflow.reclaim-wait-windows` detector
   * groups stalls by this; `reliability.passive-wait-stall` itself ignores it.
   */
  waitClass: WaitClass;
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function fmtGap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Evaluate one assistant-side run `[start, end)` that a real human prompt at
 * index `end` interrupted. Returns a stall when the run ended on wait language,
 * carried no harness-backed background mechanism, and therefore forced the human
 * to re-engage. `null` otherwise.
 */
function evaluateRun(
  entries: TimelineEntry[],
  start: number,
  end: number,
  sessionId: string
): Stall | null {
  if (end <= start) return null; // no assistant activity before this prompt
  let harnessBacked = false;
  let lastAssistantText: TimelineEntry | null = null;
  let lastActivityTs = '';
  for (let j = start; j < end; j++) {
    const e = entries[j];
    if (e.kind === 'tool_use' && e.backgrounded) harnessBacked = true;
    if (e.kind === 'assistant') lastAssistantText = e;
    if (e.timestamp) lastActivityTs = e.timestamp; // entries are chronologically sorted
  }
  if (harnessBacked) return null; // self-resuming control — never a stall
  if (!lastAssistantText?.waitLanguage) return null; // turn did not end on a wait

  const turnEndTs = lastActivityTs || lastAssistantText.timestamp;
  const gap = Date.parse(entries[end].timestamp) - Date.parse(turnEndTs);
  // Below the floor the human was already engaged — a live back-and-forth, not a
  // stall. (Also drops NaN gaps from any undatable entry.)
  if (!Number.isFinite(gap) || gap < MIN_STALL_GAP_MS) return null;
  return {
    sessionId,
    turnEndTs,
    silenceGapMs: gap,
    snippet: (lastAssistantText.summary ?? '').trim(),
    waitClass: lastAssistantText.waitClass ?? 'generic',
  };
}

/**
 * Collect passive-wait stalls in one session: assistant turn-ends that end on
 * wait language, carry no harness-backed background mechanism, and are followed
 * by a real human prompt (NOT a tool_result — tool results keep the turn going).
 */
export function collectSessionStalls(tl: SessionTimeline): Stall[] {
  const stalls: Stall[] = [];
  const entries = tl.entries;
  let runStart = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].kind !== 'user') continue; // only a real human prompt closes a turn
    const stall = evaluateRun(entries, runStart, i, tl.sessionId);
    if (stall) stalls.push(stall);
    runStart = i + 1;
  }
  // A trailing run with no following human prompt did not force a human turn — skip.
  return stalls;
}

export const detector: Detector = {
  id: 'reliability.passive-wait-stall',
  category: 'reliability',
  dataDeps: ['timelines'],
  rule(input): Recommendation | null {
    const timelines = input.timelines;
    if (!timelines || timelines.length === 0) return null;

    const stalls: Stall[] = [];
    for (const tl of timelines) {
      if (!tl.entries || tl.entries.length === 0) continue;
      stalls.push(...collectSessionStalls(tl));
    }
    if (stalls.length < MIN_STALLS) return null;

    const gaps = stalls.map((s) => s.silenceGapMs).sort((a, b) => a - b);
    const median = quantile(gaps, 0.5);
    const p90 = quantile(gaps, 0.9);
    const highConf = stalls.filter((s) => s.silenceGapMs >= HIGH_CONFIDENCE_GAP_MS);
    const sessions = new Set(stalls.map((s) => s.sessionId)).size;
    const totalGapMin = Math.round(
      stalls.reduce((sum, s) => sum + s.silenceGapMs, 0) / 60000
    );

    const severity = highConf.length > 0 ? 'warning' : 'info';

    const evidence = [...stalls]
      .sort((a, b) => b.silenceGapMs - a.silenceGapMs)
      .slice(0, MAX_EVIDENCE)
      .map((s) => {
        const id = s.sessionId.slice(0, 8);
        const snip = s.snippet ? ` "${s.snippet.slice(0, 80)}"` : '';
        return `${id}:${snip} → human re-engaged after ${fmtGap(s.silenceGapMs)}`;
      });

    const observations: RecObservation[] = [
      {
        claim: `${stalls.length} assistant turn-end(s) across ${sessions} session(s) ended on passive wait/monitor language with no harness-backed background mechanism, and a real human prompt (not a tool_result) followed`,
        source: 'parse-timeline',
        field: 'entries[].waitLanguage / entries[].backgrounded',
        value: stalls.length,
      },
      {
        claim: `median silence ${fmtGap(median)}, p90 ${fmtGap(p90)} before the human re-engaged; ${highConf.length} stalled over 5 minutes`,
        source: 'parse-timeline',
        field: 'entries[].timestamp',
        value: Math.round(median / 1000),
      },
    ];

    return {
      id: 'reliability.passive-wait-stall',
      category: 'reliability',
      severity,
      title: 'Turns end on passive waits that stall the session',
      detail: `${stalls.length} assistant turn-end(s) across ${sessions} session(s) ended on wait/monitor language ("I'll wait", "I'll report when it finishes") with no harness-backed background mechanism, so the session could not resume on its own and a human was forced to re-engage (median silence ${fmtGap(median)}, p90 ${fmtGap(p90)}; ${highConf.length} over 5 min). Explicitly backgrounded work and Monitor/ScheduleWakeup polls never showed this — they self-resumed.`,
      action:
        'Background trackable work via run_in_background so completion auto-wakes the session; for untrackable external state (CI/deploy/remote queue) poll deliberately (Monitor until-loop / ScheduleWakeup) instead of ending the turn. Never "launch then stop."',
      affected: stalls.length,
      estTimeReclaimedMin: totalGapMin,
      view: 'timeline',
      evidence,
      provenance: {
        observations,
        inference:
          'Passive turn-ends that force a human re-engagement are recoverable: explicitly backgrounded work and deliberate Monitor/ScheduleWakeup polls self-resumed, so the forced human turns are avoidable wait, not unavoidable.',
      },
    };
  },
};
