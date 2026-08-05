/**
 * reliability.post-shipment-rework (#3393) — did the work come back after it
 * shipped?
 *
 * ## Why this detector exists, and why it can be silent
 *
 * #3110 found the old boomerang-rework audit asserting post-shipment bounce-back
 * from in-session checkpoint churn alone: no shipment, no revert, no file, no
 * timestamps existed anywhere in its inputs. PR #3392 retired that claim rather
 * than dress it up, which was right — and left the original question
 * unanswered. This detector answers it from the ONE source that can: the
 * flag-gated git delivery-outcome signal (#1757, `CHD_GIT_OUTCOMES`).
 *
 * The hard rule that follows: **no git source, no claim.** `input.gitOutcomes`
 * is empty on every default deployment (the flag is off, the SPA/upload dataset
 * has no PRs at all), and this rule returns `null` there — it never falls back
 * to a locally-derivable proxy. The locally-derivable metric that DOES exist is
 * the separate in-session retry-storm rate from #3392; a retry storm is churn
 * inside one session, which is a different thing from a change coming back
 * after it landed, and conflating them is exactly the error #3110 caught.
 *
 * ## What each emitted finding is allowed to say
 *
 * Only rows carrying `GitOutcome.rework` are counted, and that field exists only
 * when `buildPostShipmentRework` could ground all four facts — the shipped
 * event, the later mutation, an artifact BOTH touched, and both timestamps. A
 * row can be labeled `merged-then-reverted` and still be excluded here: the
 * label needs only the PR link, the sentence needs the receipts.
 *
 * Staleness follows the signal's own rule (#2510, the #2142 convention): every
 * row is run through `demoteStaleGitOutcome` first, and when every contributing
 * row is a stale snapshot the finding is demoted to "as of <date>" wording and
 * `info`, never asserted as the repo's current state.
 */
import type { Detector, Recommendation } from '../types';
import { claudeMdMarksApplied, newestIsoDate } from '../shared';
import { MARKERS_POST_SHIPMENT_REWORK } from '../applied-markers';
import type {
  GitOutcome,
  GitPostShipmentRework,
} from '../../parse-git-outcome';
import { demoteStaleGitOutcome } from '../../parse-git-outcome';

/**
 * Every `bodyPhrases` entry in {@link MARKERS_POST_SHIPMENT_REWORK} must sit on
 * a SINGLE line of this snippet: the phrases are plain substring matches against
 * the merged CLAUDE.md text, so one that wraps across a newline here can never
 * match its own pasted fix. The suppression test pastes this exact snippet and
 * asserts the rule falls silent, which is what keeps the two in step.
 */
const FIX_SNIPPET = [
  '## Post-shipment verification',
  '',
  'Before merging, re-run the test that covers every file the PR touches, not just the one',
  'for the change you meant to make.',
  'A revert or follow-up fix on a file you just shipped is a verification gap, not bad luck:',
  'name the check that would have caught it, and add that check in the same PR as the fix.',
].join('\n');

/**
 * One fully-evidenced rework event is enough to fire. This is not a rate over a
 * noisy population that needs a sample-size floor — it is a named revert of a
 * named file at a named time, so a single occurrence is a real finding rather
 * than a threshold artifact.
 */
const MIN_REWORK_EVENTS = 1;

/**
 * ONE rework event, however many sessions produced the shipment.
 *
 * `gitOutcomes` is per-SESSION by construction (#1757): `buildGitOutcomes`
 * emits a row per session, and every session on a branch attributes to the same
 * PR. So three sessions that worked on one reverted PR yield three identical
 * `rework` payloads for a single real event, and counting rows would report
 * "3 merged changes ... 3 reverted" for one revert. The shipped PR number is
 * the identity of the event; the sessions are a separate, still-useful figure.
 */
interface ReworkEvent {
  prNumber: number;
  rework: GitPostShipmentRework;
  sessionIds: string[];
  /** True only when EVERY row for this shipment saw a stale PR snapshot. */
  stale: boolean;
}

/**
 * How many contributing session ids one evidence line names before it
 * truncates to `+N more` — the event is the claim, the sessions are context.
 */
const MAX_EVIDENCE_SESSIONS = 3;

/** Epoch ms of a mutation, for ordering. Zero when unreadable. */
function mutationMs(rework: GitPostShipmentRework): number {
  const ms = Date.parse(rework.mutationAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** Distinct rework events, newest mutation first. */
function reworkEvents(rows: readonly GitOutcome[], now: number): ReworkEvent[] {
  // perf-index-contract: post-shipment-rework-by-pr always-consumed: every row past the rework guard is folded into this map, and the map is always drained into the returned events
  const byPullRequest = new Map<string, ReworkEvent>();
  for (const raw of rows) {
    const row = demoteStaleGitOutcome(raw, now);
    if (!row.rework) continue;
    const prNumber = row.provenance.prNumber;
    // PR numbers are repo-scoped (#3655): in a multi-repo CHD_GIT_OUTCOMES
    // config, two same-numbered shipments from different repos are two events,
    // so the identity is (repo, prNumber). Rows with no repo (single-repo
    // pools, pre-#3655 data) share one implicit scope, as before.
    const eventKey = `${row.provenance.repo ?? ''}#${prNumber}`;
    const stale = row.provenance.stale === true;
    const existing = byPullRequest.get(eventKey);
    if (existing) {
      if (!existing.sessionIds.includes(row.sessionId)) {
        existing.sessionIds.push(row.sessionId);
      }
      existing.stale = existing.stale && stale;
      continue;
    }
    byPullRequest.set(eventKey, {
      prNumber,
      rework: row.rework,
      sessionIds: [row.sessionId],
      stale,
    });
  }
  // perf-index-contract: post-shipment-rework-order always-consumed: the caller reads the head of this ordering for its newest-event claim on every firing path
  return [...byPullRequest.values()].sort(
    (a, b) => mutationMs(b.rework) - mutationMs(a.rework)
  );
}

export const detector: Detector = {
  id: 'reliability.post-shipment-rework',
  category: 'reliability',
  dataDeps: ['gitOutcomes', 'liveConfig'],
  appliedMarkers: MARKERS_POST_SHIPMENT_REWORK,
  rule(input, now): Recommendation | null {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_POST_SHIPMENT_REWORK)) return null;

    // NO GIT SOURCE, NO CLAIM. This is the whole flag-off contract: with
    // CHD_GIT_OUTCOMES unset the ingest step ships an empty array and the
    // finding does not exist. There is deliberately no local fallback.
    const rows = input.gitOutcomes;
    if (!rows || rows.length === 0) return null;

    const events = reworkEvents(rows, now);
    if (events.length < MIN_REWORK_EVENTS) return null;

    const reverts = events.filter((e) => e.rework.kind === 'revert');
    const fixUps = events.filter((e) => e.rework.kind === 'fix-up');
    // Every contributing row is a stale PR snapshot ⇒ the finding describes the
    // past, not the repo now. One fresh row is enough to keep it present-tense.
    const allStale = events.every((e) => e.stale);

    // asOf comes from the newest thing actually OBSERVED — the latest mutation
    // instant in the cited events — never from `now`. A claim about shipped code
    // is only current as of the last mutation the snapshot could see.
    const asOf = newestIsoDate(events.map((e) => e.rework.mutationAt));
    // perf-index-contract: post-shipment-rework-sessions always-consumed: built only past the empty-events early return, and its size is stated in the emitted detail
    const sessions = new Set(events.flatMap((e) => e.sessionIds));
    // perf-index-contract: post-shipment-rework-artifacts always-consumed: built only past the empty-events early return, and its size is cited in both the detail and provenance
    const artifacts = new Set(events.flatMap((e) => e.rework.artifacts));

    const evidence = events.slice(0, 6).map(({ rework: e, sessionIds }) => {
      const when =
        e.daysAfterShipment === 0
          ? 'the same day'
          : `${e.daysAfterShipment}d later`;
      const citedSessions = sessionIds.slice(0, MAX_EVIDENCE_SESSIONS);
      const moreSessions = sessionIds.length - citedSessions.length;
      return (
        `${e.shippedRef} shipped ${e.shippedAt} -> ${e.mutationRef} ${e.kind === 'revert' ? 'reverted' : 'fixed'} it ${e.mutationAt}` +
        ` (${when}), both touching ${e.artifacts.join(', ')}` +
        ` [${sessionIds.length === 1 ? 'session' : 'sessions'} ${citedSessions.join(', ')}${moreSessions > 0 ? ` +${moreSessions} more` : ''}]`
      );
    });

    const tense = allStale ? `As of ${asOf ?? 'the last PR snapshot'}, ` : '';
    return {
      id: 'reliability.post-shipment-rework',
      category: 'reliability',
      severity: allStale || reverts.length === 0 ? 'info' : 'warning',
      title: 'Shipped work is coming back after it merges',
      detail:
        `${tense}${events.length} merged change(s) across ${sessions.size} session(s) were re-touched after they shipped: ` +
        `${reverts.length} reverted, ${fixUps.length} patched by a follow-up fix. ` +
        'The linking heuristics deliberately under-link, so the shipment count is a lower bound on detected rework, not a census. ' +
        `Each one is a merged PR whose files a later merged PR re-touched, over ${artifacts.size} distinct file(s) cited here — ` +
        'each event lists only the shared paths it could cite, so that is a floor, not the full blast radius. ' +
        'Joined from the git delivery-outcome signal (CHD_GIT_OUTCOMES); sessions with no PR of their own are not counted.',
      action:
        'Open the cited PRs in order. For each revert, find what the merge gate missed on that file and add the check that would have caught it before the merge, rather than after.',
      affected: events.length,
      view: 'sessions',
      evidence,
      claimClass: 'accounting',
      proofTier: 'accounting',
      provenance: {
        observations: [
          {
            claim: `${events.length} merged change(s) were re-touched after shipping`,
            source: 'gitOutcomes (parse-git-outcome buildPostShipmentRework)',
            field: 'rework',
            value: events.length,
          },
          {
            claim: `${reverts.length} of them were reverted and ${fixUps.length} patched by a follow-up fix`,
            source: 'gitOutcomes (parse-git-outcome linkReworkMutations)',
            field: 'rework.kind',
            value: `revert=${reverts.length},fix-up=${fixUps.length}`,
          },
          {
            claim: `the ${events.length} change(s) are counted once per shipped PR, across ${sessions.size} contributing session row(s)`,
            source: 'gitOutcomes (per-session rows keyed by provenance.repo + provenance.prNumber)',
            field: 'provenance.repo + provenance.prNumber',
            value: `shipments=${events.length},sessionRows=${sessions.size}`,
          },
          {
            claim: `the most recent one is ${events[0].rework.shippedRef} shipped ${events[0].rework.shippedAt}, re-touched by ${events[0].rework.mutationRef} at ${events[0].rework.mutationAt}`,
            source: 'gitOutcomes (gh pr list --json mergedAt,mergeCommit,files)',
            record: events[0].sessionIds[0],
            field: 'rework.mutationAt',
            value: events[0].rework.mutationAt,
          },
          {
            claim: `${artifacts.size} distinct file(s) are cited as touched by both a shipment and its later mutation`,
            source: 'gitOutcomes (parse-git-outcome sharedArtifacts)',
            field: 'rework.artifacts',
            value: artifacts.size,
          },
        ],
        inference:
          'A merged PR whose files a later merged PR reverted or patched is work that did not hold on the first pass. This counts only PR-grounded shipments; it is not a rate over all work, and it says nothing about sessions that never opened a PR.',
        ...(asOf !== undefined ? { asOf } : {}),
        ...(allStale ? { stale: true } : {}),
      },
      fix: {
        target: 'CLAUDE.md',
        label: 'Add a post-shipment verification rule',
        note: `Files that came back after shipping: ${[...artifacts].slice(0, 5).join(', ')}.`,
        fixKind: 'validated',
        snippet: FIX_SNIPPET,
        appliedMarkers: MARKERS_POST_SHIPMENT_REWORK,
      },
    };
  },
};
