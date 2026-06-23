import type { Detector, Recommendation, RecObservation, AppliedMarkers } from '../types';
import { claudeMdMarksApplied, truncate } from '../shared';
import type { ToolCall, ToolUsageData } from '../../parse-tools';

/**
 * `reliability.stale-state-assertion` (#1871).
 *
 * Signature: a session reads an INTEGRATION/remote ref from the LOCAL git tree —
 * `git log origin/master`, `git show master`, `git diff origin/main`,
 * `git branch --contains <sha>`, `git rev-parse origin/master`, … — with **no**
 * `git fetch`/`git pull` earlier in the same session (within a freshness window).
 * A local tree can sit 100+ commits behind origin, so any "X is merged / landed /
 * exists" claim drawn from such a read can be stale. This is the recurring pain
 * behind the `fetch-before-checking-master` and `gh-api-edits-fetch-from-master`
 * memory notes, which the global repo-freshness hook now *prevents* (SessionStart
 * + throttled PreToolUse auto-fetch); this detector *measures* the underlying
 * agent behaviour so the guard's impact is visible in the engine (the dogfooding
 * loop, alongside the sibling cwd-drift detector #1870).
 *
 * Scoping is deliberate and auditable:
 *  - Only LOCAL `git` reads are flagged. `gh` (gh pr / gh issue …) is EXCLUDED
 *    because it queries the remote live, so it is never stale — flagging it would
 *    be a false positive.
 *  - A git read only counts when it references an integration/remote ref
 *    (`origin/…`, `upstream/…`, `master`, `main`, `@{u}`/`@{upstream}`,
 *    `--contains`). A ref-less `git log`/`git status` is not staleness-sensitive.
 *  - "Covered" = a `git fetch`/`git pull`/`git remote update` ran earlier in the
 *    same session within FRESH_WINDOW_MS before the read (a read that fetches in
 *    the same compound command, e.g. `git fetch && git log origin/master`, is
 *    covered by its own fetch). Only un-covered reads are counted.
 *
 * Reads only `toolData` (parse-tools): each Bash call's `input.command`. Dark on
 * a dataset with no Bash tool calls.
 */

const MIN_STALE_READS = 3; // noise floor — never fire on one or two
const HIGH_PER_SESSION = 4; // a session this repetitive escalates info → warning
const FRESH_WINDOW_MS = 30 * 60 * 1000; // a fetch older than 30m no longer covers a read
const MAX_EVIDENCE = 5;

// A command that FRESHENS the local tree against origin. The look-arounds keep
// `fetch`/`pull` to a real subcommand token — `git log -- scripts/fetch-data.ts`
// (the word inside a path/flag) must NOT count as a freshening fetch.
const FETCH_RE = /\bgit\b[^\n]*?(?<![\w./-])(?:fetch|pull|remote\s+update)(?![\w./-])/i;
// A local git READ subcommand whose answer depends on remote freshness.
const GIT_READ_RE =
  /\bgit\b[^\n]*?\b(?:log|show|diff|branch|merge-base|rev-list|rev-parse)\b/i;
// An integration/remote ref token — required for a read to be staleness-sensitive.
const REMOTE_REF_RE =
  /(?:\borigin\/|\bupstream\/|@\{u(?:pstream)?\}|\bmaster\b|\bmain\b)/i;
// `git branch --contains <sha>` asks whether an integration branch contains a
// commit — staleness-sensitive even without an explicit ref token. Scoped to the
// `branch` subcommand so ref-less `git log/tag --contains` don't false-match.
const BRANCH_CONTAINS_RE = /\bgit\b[^\n]*?\bbranch\b[^\n]*?--contains\b/i;

const MARKERS: AppliedMarkers = {
  headings: [/^##\s+Fetch before asserting repo state\b/i],
  bodyPhrases: ['local tree can sit many commits behind origin'],
};

interface SessionStale {
  sessionId: string;
  count: number;
  example: string;
}

/** Ascending-by-timestamp, stable on equal/undatable timestamps (original order). */
function chronological(calls: ToolCall[]): ToolCall[] {
  return calls
    .map((c, i) => ({ c, i, t: Date.parse(c.timestamp) }))
    .sort((a, b) => {
      const at = Number.isFinite(a.t) ? a.t : Number.POSITIVE_INFINITY;
      const bt = Number.isFinite(b.t) ? b.t : Number.POSITIVE_INFINITY;
      return at - bt || a.i - b.i;
    })
    .map((x) => x.c);
}

/** Count integration-branch reads issued with no recent in-session fetch. */
function collectSessionStale(session: ToolUsageData): SessionStale | null {
  const bash = session.calls.filter(
    (c) => c.toolName === 'Bash' && typeof c.input.command === 'string'
  );
  if (bash.length === 0) return null;

  let lastFetchMs: number | null = null;
  let sawFetch = false;
  let count = 0;
  let example = '';

  for (const call of chronological(bash)) {
    const cmd = call.input.command as string;
    const tMs = Date.parse(call.timestamp);

    // Process the fetch side FIRST so a self-fetching read (`git fetch && git log
    // origin/master`) is covered by its own fetch.
    if (FETCH_RE.test(cmd)) {
      sawFetch = true;
      if (Number.isFinite(tMs)) lastFetchMs = tMs;
    }

    const isRead =
      (GIT_READ_RE.test(cmd) && REMOTE_REF_RE.test(cmd)) || BRANCH_CONTAINS_RE.test(cmd);
    if (!isRead) continue;

    let covered: boolean;
    if (Number.isFinite(tMs) && lastFetchMs !== null) {
      covered = tMs - lastFetchMs <= FRESH_WINDOW_MS;
    } else {
      // Undatable read or fetch — fall back to order-only: covered iff any fetch
      // was seen earlier in this session.
      covered = sawFetch;
    }
    if (covered) continue;

    count += 1;
    if (!example) example = cmd;
  }

  return count > 0 ? { sessionId: session.sessionId, count, example } : null;
}

export const detector: Detector = {
  id: 'reliability.stale-state-assertion',
  category: 'reliability',
  dataDeps: ['toolData', 'liveConfig'],
  appliedMarkers: MARKERS,
  rule(input): Recommendation | null {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;

    const toolData = input.toolData;
    if (!toolData || toolData.length === 0) return null;

    const perSession: SessionStale[] = [];
    for (const session of toolData) {
      const s = collectSessionStale(session);
      if (s) perSession.push(s);
    }

    const totalStale = perSession.reduce((sum, s) => sum + s.count, 0);
    if (totalStale < MIN_STALE_READS) return null;

    const sessionsAffected = perSession.length;
    const maxPerSession = perSession.reduce((m, s) => Math.max(m, s.count), 0);
    const severity = maxPerSession >= HIGH_PER_SESSION ? 'warning' : 'info';

    const evidence = [...perSession]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_EVIDENCE)
      .map(
        (s) =>
          `${s.sessionId.slice(0, 8)}: ${s.count} integration-branch read(s) with no prior fetch — e.g. \`${truncate(
            s.example,
            70
          )}\``
      );

    const observations: RecObservation[] = [
      {
        claim: `${totalStale} local git read(s) of an integration/remote ref (origin/…, master, main, @{u}, --contains) across ${sessionsAffected} session(s) ran with no git fetch/pull in the prior ${FRESH_WINDOW_MS / 60000} minutes of the same session`,
        source: 'parse-tools',
        field: 'toolData[].calls[].input.command',
        value: totalStale,
      },
      {
        claim:
          'gh reads and ref-less git reads are excluded — gh queries the remote live (never stale), and a git read with no integration ref is not staleness-sensitive',
        source: 'parse-tools',
        field: 'toolData[].calls[].toolName / input.command',
      },
    ];

    return {
      id: 'reliability.stale-state-assertion',
      category: 'reliability',
      severity,
      title: 'Repo-state claims read from an un-fetched local tree',
      detail: `${totalStale} git read(s) of an integration branch (origin/…, master, main, @{u}) across ${sessionsAffected} session(s) ran with no \`git fetch\`/\`git pull\` in the prior 30 minutes of the session, so any "merged / landed / exists" claim drawn from them reflects a possibly-stale local tree (local can sit 100+ commits behind origin). gh reads and ref-less git reads are excluded — gh hits the remote live.`,
      action:
        'Run `git fetch` (or rely on the repo-freshness auto-fetch hook) before reading an integration branch or asserting a PR/branch is merged, landed, or exists, and read the remote-tracking ref (e.g. `git log origin/master`) for the claim — not the local branch.',
      affected: totalStale,
      view: 'tools',
      evidence,
      provenance: {
        observations,
        inference:
          'A git read of the integration branch with no preceding in-session fetch reflects local state that may be many commits behind origin, so merge/landing/existence claims drawn from it can be stale. Fetching origin (or the repo-freshness hook auto-fetch) before the read makes the claim current.',
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Add a fetch-before-claim rule',
        note: 'Append to your project or global CLAUDE.md so every session fetches before asserting repo state.',
        snippet:
          `## Fetch before asserting repo state\n\n` +
          `Before claiming a branch or PR is merged, landed, or exists, fetch origin first — a ` +
          `local tree can sit many commits behind origin. Run \`git fetch\` (or let the ` +
          `repo-freshness hook auto-fetch), then read the remote-tracking ref ` +
          `(e.g. \`git log origin/master\`) for the claim, not the local branch.`,
        fixKind: 'validated',
        appliedMarkers: MARKERS,
      },
    };
  },
};
