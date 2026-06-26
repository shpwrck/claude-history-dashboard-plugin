import type { SessionTimeline } from '../parse-timeline';

/**
 * SHARED Backgroundable-Foreground-Call (BFC) metric (#2238/#2242).
 *
 * The single implementation of the conversational-availability BFC computation,
 * imported by BOTH the `workflow.conversational-availability` detector and the
 * experiment evaluator (#2242), so the per-session metric never drifts between
 * the recommendation surface and the experiment-axis verdict.
 *
 * A Backgroundable-Foreground Call (BFC) is a `tool_use` entry that:
 *   (a) is of a backgroundable KIND (`entries[].backgroundableKind` true) — a
 *       long-running Bash toolchain invocation, OR an Agent/Task/Workflow/Monitor/
 *       ScheduleWakeup call. Set by the parser (`isBackgroundableKind` in
 *       parse-timeline) so it survives `slimSessionTimeline`; AND
 *   (b) was NOT actually backgrounded (`entries[].backgrounded` falsy); AND
 *   (c) imposed real BLOCK time — the wall-clock gap from this `tool_use`
 *       timestamp to the NEXT assistant entry exceeds {@link BLOCK_FLOOR_MS}.
 */

// Block-time floor: the wall-clock gap from a foreground tool_use to the next
// assistant entry must exceed this for the call to count. 10s excludes sub-second
// reads and quick status checks — only genuinely blocking calls clear it (#2230).
export const BLOCK_FLOOR_MS = 10_000;

export interface Bfc {
  sessionId: string;
  toolName: string;
  blockedMs: number;
}

/**
 * Collect Backgroundable-Foreground Calls in one session: non-backgrounded
 * tool_use entries of a backgroundable kind whose block time (gap to the next
 * assistant entry) exceeds the floor.
 *
 * Parallel-batch dedup: one assistant message can emit several tool_use blocks in
 * parallel; the parser gives every block in that message the SAME timestamp, and
 * the scan-forward from each lands on the SAME continuation assistant entry. Those
 * N blocks are ONE block window — the human waited once, for whichever call
 * finished last — not N independent waits. Keying the window by its continuation
 * entry index collapses the batch to a single BFC (the worst-blocking member is
 * its representative) so `affected` and total blocked time are not over-counted.
 */
export function collectSessionBfcs(tl: SessionTimeline): Bfc[] {
  const entries = tl.entries;
  // continuation entry index -> the single block window that resumes there.
  const windowByContinuation = new Map<number, Bfc>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind !== 'tool_use' || e.backgrounded) continue;
    // Parser-set flag (isBackgroundableKind in parse-timeline): a long-running
    // Bash toolchain invocation OR a non-backgrounded Agent/Workflow/etc. Reading
    // the boolean (not the command summary) is what lights this up on the slim
    // bulk/server dataset and lets blocking Agent/Workflow calls count (#2238).
    if (!e.backgroundableKind) continue;
    // Block time = gap until the next assistant entry (the turn resumes there).
    let continuation = -1;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].kind === 'assistant') {
        continuation = j;
        break;
      }
    }
    if (continuation < 0) continue; // turn never resumed in-band — not a block we can size
    const blockedMs = Date.parse(entries[continuation].timestamp) - Date.parse(e.timestamp);
    if (!Number.isFinite(blockedMs) || blockedMs <= BLOCK_FLOOR_MS) continue;
    const candidate: Bfc = { sessionId: tl.sessionId, toolName: e.toolName ?? 'unknown', blockedMs };
    // Collapse all backgroundable calls that resume at the same continuation into
    // ONE window, keeping the longest-blocked call as its representative.
    const existing = windowByContinuation.get(continuation);
    if (!existing || candidate.blockedMs > existing.blockedMs) {
      windowByContinuation.set(continuation, candidate);
    }
  }
  return [...windowByContinuation.values()];
}

export interface SessionBfcMetric {
  /** Number of BFC windows in the session (parallel-batch-deduped). */
  bfcCount: number;
  /** Total foreground block time across those windows, in whole minutes. */
  blockedMin: number;
  /** Total `tool_use` entries in the session — the per-session work volume. */
  toolCallCount: number;
}

/**
 * Per-session conversational-availability metric: the deduped BFC count, the
 * total foreground block time (minutes), and the session's total tool-call
 * volume. The experiment evaluator normalizes `bfcCount` by `toolCallCount`
 * (BFC per 100 tool calls) so arms with different work volumes compare fairly.
 */
export function sessionBfcMetric(tl: SessionTimeline): SessionBfcMetric {
  const bfcs = collectSessionBfcs(tl);
  const blockedMs = bfcs.reduce((sum, b) => sum + b.blockedMs, 0);
  let toolCallCount = 0;
  for (const e of tl.entries) {
    if (e.kind === 'tool_use') toolCallCount++;
  }
  return {
    bfcCount: bfcs.length,
    blockedMin: Math.round(blockedMs / 60000),
    toolCallCount,
  };
}
