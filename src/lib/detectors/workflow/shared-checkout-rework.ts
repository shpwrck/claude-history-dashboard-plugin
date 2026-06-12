/**
 * workflow/shared-checkout-rework — recommend worktree-first when a session shows
 * the shared-checkout / foreign-HEAD-swap rework signature (#956, epic #866).
 *
 * Concurrent Claude Code sessions sharing one working directory (the main
 * checkout + standing `chd-main`/`chd-spa` instances) collide: a `git checkout`
 * in one session moves the single shared HEAD out from under the others,
 * silently dragging a session onto the wrong branch mid-task. The recovery that
 * follows — stash a tree across a branch switch, or reflog + cherry-pick an
 * orphaned commit — is the rework this detector catches, recommending the
 * structural cure (a per-branch `git worktree`). For already-damaged work,
 * the honest recovery layer is git reflog; Claude Code Rewind only reaches
 * this session's own checkpoints, not a concurrent session's foreign checkout.
 *
 * DATA SCOPING (important, and why this is command-pattern, not output-text):
 * the dashboard's parsed `toolData` (parse-tools) retains each Bash call's
 * compact command preview/signals, plus git-related command segments for this
 * detector, an `isError` flag, and the result BYTE SIZE — but NOT the full
 * command body in bulk, NOT the result text, and NOT the call's cwd. So the
 * issue's output-string
 * signals — (a) git's "checkout: moving from X to Y" reflog line and (b) a
 * "CONFLICT"/"Aborting" stash error — and the cwd-based signal (c) have no data
 * source here. This detector therefore keys on the two command-sequence signals
 * that ARE reconstructable and are distinctive of the documented incident
 * (#646 / PR #954/#955), so it stays low-false-positive:
 *
 *   S1 — cross-branch stash transport: a `git stash [push]`, then later (by
 *        timestamp) a `git checkout`/`git switch` to a branch, then later a
 *        `git stash pop`/`apply`. Moving uncommitted work across a branch switch
 *        in a shared checkout — the exact "stash → switch → pop" dance.
 *   S2 — orphaned-commit / foreign-HEAD recovery: `git reflog` co-occurring with
 *        `git cherry-pick` or `git merge --ff-only` in one session — the reflog
 *        recovery used when a foreign checkout orphaned a commit.
 *
 * A session is flagged when it shows S1 or S2 (require >=1 strong signal).
 * Severity scales with the count of flagged sessions. A clean, worktree-isolated
 * session (worktree add + commit + push, no stash/reflog recovery) shows neither
 * signal and never fires. Flag-and-recommend only — no auto-apply. The fix is
 * a manual recovery checklist, not a validated config paste.
 */

import type { Detector, RecommendationInput } from '../types';
import type { ToolUsageData } from '../../parse-tools';
import { short } from '../shared';

/** Below this many flagged sessions we stay quiet (sparse-data restraint). */
const MIN_FLAGGED = 1;
/** At or above this many flagged sessions the finding is a warning, else info. */
const WARN_FLAGGED = 3;

const RECOVERY_ACTION =
  'Use worktree-first prevention for the next branch-scoped task: create a `git worktree` ' +
  'and work there instead of committing, branching, or stashing in the shared main checkout. ' +
  'For a current foreign-HEAD-swap incident, use git-reflog-guided recovery: find the ' +
  'orphaned SHA, recreate a recovery branch, then `merge --ff-only` or cherry-pick it back ' +
  'onto the intended branch before restoring any dirty tree. Claude Code Rewind only helps ' +
  "with self-inflicted checkpointed edits in this same session; it does not recover another " +
  "concurrent session's checkout.";

const RECOVERY_FIX_SNIPPET = `# Manual foreign-HEAD-swap recovery. Replace placeholders before running.
git reflog --date=iso
git branch recover/<issue-or-session> <orphaned-sha>
git switch <intended-branch>

# Choose one after inspecting history:
git merge --ff-only recover/<issue-or-session>
# or:
git cherry-pick <orphaned-sha>

# If dirty work was parked during recovery, inspect and re-apply the right stash:
git stash list
git stash show -p stash@{n}
git stash apply stash@{n}`;

// Command matchers. We test the FULL command string (a single Bash call can
// chain several git ops with `&&`), so `git stash && git checkout -` is caught.
// A stash *push* — `git stash`, `git stash push`, `git stash save`. The negative
// lookahead keeps `git stash pop/apply/list/show/drop/clear/branch` from being
// misread as a push (segments are split on shell separators before matching).
const RE_STASH_PUSH = /\bgit\s+stash\b(?!\s+(?:pop|apply|list|show|drop|clear|branch))/;
const RE_STASH_POP = /\bgit\s+stash\s+(?:pop|apply)\b/;
// A BRANCH switch — exclude `git checkout -- <path>` / `git checkout .` file
// restores, which are not branch moves.
const RE_BRANCH_SWITCH = /\bgit\s+(?:switch|checkout)\b(?!\s+(?:--\s|\.\s|--\s*$|\.\s*$))/;
const RE_REFLOG = /\bgit\s+reflog\b/;
const RE_CHERRY_PICK = /\bgit\s+cherry-pick\b/;
const RE_FF_MERGE = /\bgit\s+merge\s+--ff-only\b/;

interface FlaggedSession {
  sessionId: string;
  signals: string[]; // e.g. ['S1', 'S2']
  /** The first matching offending command(s), for the evidence row. */
  sample: string;
  /** Latest matching command timestamp (ISO), for as-of dating. */
  lastTs: string;
}

/**
 * Ordered git "segments" for one session, oldest first. Each Bash call is split
 * on shell separators (`&&`, `;`, `|`) so a single chained call like
 * `git stash && git checkout master && git stash pop` yields three ordered
 * segments — the S1 state machine then sees the sequence whether the agent
 * chained it in one call or spread it across several. Each segment carries its
 * parent call's timestamp for as-of dating.
 */
function bashSegments(sd: ToolUsageData): { command: string; ts: string }[] {
  const calls = sd.calls
    .filter(
      (c) =>
        c.toolName === 'Bash' &&
        (typeof c.input.command === 'string' ||
          Array.isArray(c.commandGitSegments) ||
          typeof c.commandPreview === 'string')
    )
    .flatMap((c) => {
      if (typeof c.input.command === 'string') {
        return [{ command: c.input.command, ts: c.timestamp }];
      }
      if (Array.isArray(c.commandGitSegments) && c.commandGitSegments.length > 0) {
        return c.commandGitSegments.map((command) => ({ command, ts: c.timestamp }));
      }
      return [{ command: c.commandPreview as string, ts: c.timestamp }];
    })
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const segments: { command: string; ts: string }[] = [];
  for (const { command, ts } of calls) {
    for (const part of command.split(/&&|\|\||;|\|/)) {
      const trimmed = part.trim();
      if (trimmed) segments.push({ command: trimmed, ts });
    }
  }
  return segments;
}

/**
 * S1 — a stash, then a branch switch, then a stash pop, in that timestamp order.
 * Returns the offending command (the pop) when present, else null.
 */
function detectStashTransport(
  calls: { command: string; ts: string }[]
): { sample: string; ts: string } | null {
  let sawStash = false;
  let sawSwitchAfterStash = false;
  for (const { command, ts } of calls) {
    if (!sawStash) {
      if (RE_STASH_PUSH.test(command)) sawStash = true;
      continue;
    }
    if (!sawSwitchAfterStash) {
      // A pop before any branch switch is a normal same-branch stash round-trip.
      if (RE_STASH_POP.test(command)) {
        sawStash = false; // reset; this stash was resolved in place
        continue;
      }
      if (RE_BRANCH_SWITCH.test(command)) sawSwitchAfterStash = true;
      continue;
    }
    if (RE_STASH_POP.test(command)) return { sample: command, ts };
  }
  return null;
}

/**
 * S2 — `git reflog` co-occurring with `git cherry-pick` or `git merge --ff-only`
 * anywhere in the session. Returns the recovery command + its timestamp.
 */
function detectReflogRecovery(
  calls: { command: string; ts: string }[]
): { sample: string; ts: string } | null {
  const hasReflog = calls.some((c) => RE_REFLOG.test(c.command));
  if (!hasReflog) return null;
  const recovery = calls.find((c) => RE_CHERRY_PICK.test(c.command) || RE_FF_MERGE.test(c.command));
  return recovery ? { sample: recovery.command, ts: recovery.ts } : null;
}

function flagSession(sd: ToolUsageData): FlaggedSession | null {
  const calls = bashSegments(sd);
  if (calls.length === 0) return null;
  const signals: string[] = [];
  let sample = '';
  let lastTs = '';
  const s1 = detectStashTransport(calls);
  if (s1) {
    signals.push('S1');
    sample = s1.sample;
    if (s1.ts > lastTs) lastTs = s1.ts;
  }
  const s2 = detectReflogRecovery(calls);
  if (s2) {
    signals.push('S2');
    if (!sample) sample = s2.sample;
    if (s2.ts > lastTs) lastTs = s2.ts;
  }
  if (signals.length === 0) return null;
  return { sessionId: sd.sessionId, signals, sample, lastTs };
}

export const detector: Detector = {
  id: 'workflow.shared-checkout-rework',
  category: 'workflow',
  dataDeps: ['toolData'],
  rule(input: RecommendationInput) {
    const flagged: FlaggedSession[] = [];
    for (const sd of input.toolData) {
      const f = flagSession(sd);
      if (f) flagged.push(f);
    }
    if (flagged.length < MIN_FLAGGED) return null;

    const severity = flagged.length >= WARN_FLAGGED ? 'warning' : 'info';
    const asOf = flagged.reduce((m, f) => (f.lastTs > m ? f.lastTs : m), '').slice(0, 10) || undefined;

    return {
      id: 'workflow.shared-checkout-rework',
      category: 'workflow',
      severity,
      title: 'Shared-checkout rework — switch to a worktree',
      detail:
        `${flagged.length} session(s) show the shared-checkout / foreign-HEAD-swap ` +
        `recovery signature: stashing a tree across a branch switch, or reflog + ` +
        `cherry-pick/ff-merge to recover an orphaned commit. In this repo the main ` +
        `checkout (and the standing chd-main/chd-spa instances) share one HEAD across ` +
        `concurrent sessions, so a foreign \`git checkout\` can move HEAD out from under ` +
        `you mid-task — the rework above is the symptom.`,
      action:
        RECOVERY_ACTION,
      affected: flagged.length,
      evidence: flagged
        .slice(0, 5)
        .map((f) => `${short(f.sessionId)}: [${f.signals.join('+')}] ${f.sample.slice(0, 80)}`),
      fix: {
        target: 'command',
        fixKind: 'manual',
        label: 'Recover via git reflog',
        note:
          'Manual recovery for a foreign HEAD swap. Replace placeholders after inspecting reflog/history; use Rewind only for this session\'s own checkpointed edits, not another session\'s checkout.',
        snippet: RECOVERY_FIX_SNIPPET,
      },
      provenance: {
        observations: [
          {
            claim: `${flagged.length} session(s) ran the shared-checkout rework command signature (stash-transport or reflog-recovery)`,
            source: 'parse-tools',
            field: 'toolData[].calls[].commandPreview',
            value: flagged.length,
          },
        ],
        inference:
          'These git command sequences are the documented recovery from a foreign ' +
          'HEAD swap in a shared working directory (#646, PR #954/#955); the ' +
          'structural cure is per-branch worktree isolation.',
        asOf,
      },
    };
  },
};
