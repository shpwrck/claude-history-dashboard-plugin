import type { Detector, Recommendation, RecObservation } from '../types';
import {
  BLOCK_FLOOR_MS,
  collectSessionBfcs,
  type Bfc,
} from '../../experiments/conversational-availability-metric';

/**
 * `workflow.conversational-availability` (#2230, part of #2227).
 *
 * The DURING-work complement to `reliability.passive-wait-stall`. Passive-wait
 * measures turn-END dead-air — an assistant turn that ENDS on "I'll wait" with no
 * background mechanism, stranding the session until a human re-engages. This
 * detector measures the OTHER half: foreground tool calls fired IN the middle of
 * a turn that were eligible to be backgrounded but weren't, so the human's
 * conversational thread blocked on a long synchronous call (a `npm run build`, a
 * `vitest` run, a `compose up`) that `run_in_background` / Agent / Workflow could
 * have detached. These are two distinct angles on the same lever — keep the human
 * unblocked — so they never double-count: passive-wait keys on `waitLanguage`
 * turn-ends, this one keys on in-turn `tool_use` block time.
 *
 * A Backgroundable-Foreground Call (BFC) is a `tool_use` entry that:
 *   (a) is of a backgroundable KIND (`entries[].backgroundableKind` true) — a
 *       long-running Bash toolchain invocation, OR an Agent/Task/Workflow/Monitor/
 *       ScheduleWakeup call. This is set by the parser (`isBackgroundableKind` in
 *       parse-timeline), so it survives `slimSessionTimeline` and is computed
 *       WITHOUT the command `summary`; AND
 *   (b) was NOT actually backgrounded (`entries[].backgrounded` falsy) — a
 *       `run_in_background` Bash or a self-resuming Agent/Workflow already detached,
 *       so it cost no foreground wait. The two flags are orthogonal: a
 *       foreground/blocking Agent or Workflow has `backgroundableKind:true` AND
 *       `backgrounded:false`, and IS counted here; AND
 *   (c) imposed real BLOCK time — the wall-clock gap from this `tool_use`
 *       timestamp to the NEXT assistant entry exceeds {@link BLOCK_FLOOR_MS}.
 *
 * The block floor is the false-positive guard the issue calls for: a sub-second
 * foreground Read/Grep/Glob or a quick `git status` never clears it, so only calls
 * that genuinely held the conversation hostage count. Because the kind test reads
 * the parser-set `backgroundableKind` boolean (not the command `summary`), the
 * detector fires on the SLIM bulk/server dataset (live ~/.claude) just as it does
 * on client-parsed timelines (uploads, the SPA sample corpus) — and it now counts
 * blocking Agent/Workflow calls that the old summary-text classifier could not see
 * (#2238).
 */

// Noise floor across the dataset: never fire on one or two blocking calls — a
// clean / all-backgrounded corpus stays silent.
const MIN_BFC = 3;
// Above this total blocked time the finding is egregious enough to warn, not info.
const EGREGIOUS_BLOCKED_MIN = 10;
const MAX_EVIDENCE = 5;

// The per-session BFC collector (`collectSessionBfcs`) and the BLOCK_FLOOR_MS
// constant live in the SHARED metric module so this detector and the experiment
// evaluator (#2242) run ONE implementation and never drift.

function fmtMin(ms: number): string {
  const min = ms / 60000;
  if (min < 1) return `${Math.round(ms / 1000)}s`;
  return `${min < 10 ? min.toFixed(1) : Math.round(min)}m`;
}

export const detector: Detector = {
  id: 'workflow.conversational-availability',
  category: 'workflow',
  dataDeps: ['timelines'],
  rule(input): Recommendation | null {
    const timelines = input.timelines;
    if (!timelines || timelines.length === 0) return null;

    const bfcs: Bfc[] = [];
    for (const tl of timelines) {
      if (!tl.entries || tl.entries.length === 0) continue;
      bfcs.push(...collectSessionBfcs(tl));
    }
    if (bfcs.length < MIN_BFC) return null;

    const sessions = new Set(bfcs.map((b) => b.sessionId)).size;
    const totalBlockedMs = bfcs.reduce((sum, b) => sum + b.blockedMs, 0);
    const totalBlockedMin = Math.round(totalBlockedMs / 60000);
    const severity = totalBlockedMin >= EGREGIOUS_BLOCKED_MIN ? 'warning' : 'info';

    const worst = [...bfcs].sort((a, b) => b.blockedMs - a.blockedMs);
    const evidence = worst.slice(0, MAX_EVIDENCE).map((b) => {
      const id = b.sessionId.slice(0, 8);
      return `${id}: ${b.toolName} blocked ${Math.round(b.blockedMs / 1000)}s in the foreground`;
    });

    const observations: RecObservation[] = [
      {
        claim: `${bfcs.length} foreground tool call(s) across ${sessions} session(s) were of a backgroundable kind (long-running Bash build/test/install/deploy, or a blocking Agent/Workflow) yet were not backgrounded`,
        source: 'parse-timeline',
        field: 'entries[].backgroundableKind / entries[].backgrounded / entries[].toolName',
        value: bfcs.length,
      },
      {
        claim: `each blocked the conversation for more than ${Math.round(
          BLOCK_FLOOR_MS / 1000
        )}s before the assistant turn resumed; ${totalBlockedMin} minute(s) of foreground block time total`,
        source: 'parse-timeline',
        field: 'entries[].timestamp',
        value: totalBlockedMin,
      },
    ];

    return {
      id: 'workflow.conversational-availability',
      category: 'workflow',
      severity,
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: 'Long foreground calls block the conversation instead of backgrounding',
      detail: `${bfcs.length} backgroundable tool call(s) across ${sessions} session(s) ran in the foreground and each held the conversation for more than ${Math.round(
        BLOCK_FLOOR_MS / 1000
      )}s while the assistant waited for them to finish — ${totalBlockedMin} minute(s) of in-turn block time total (worst ${fmtMin(
        worst[0].blockedMs
      )}). These are long/slow calls (build/test/install/deploy or an un-detached Agent/Workflow) that run_in_background would have detached so the human's thread stayed free. This is the during-work complement to reliability.passive-wait-stall (which measures turn-END dead-air).`,
      action:
        'Default long or slow calls — builds, test runs, installs, deploys, watchers, and sub-agent fan-outs — to run_in_background (or an Agent / Workflow), so the call detaches and the session keeps moving instead of blocking on a synchronous foreground wait. Reserve foreground for fast, sub-second tool calls (Read/Grep/Glob, quick status).',
      affected: bfcs.length,
      estTimeReclaimedMin: totalBlockedMin,
      view: 'timeline',
      evidence,
      provenance: {
        observations,
        inference:
          'A non-backgrounded tool call of a backgroundable kind that held the turn for over the block floor is recoverable wait: the same call dispatched via run_in_background / Agent / Workflow self-resumes the session, so the foreground block time is avoidable rather than intrinsic to the work.',
      },
    };
  },
};
