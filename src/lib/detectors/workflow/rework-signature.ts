/**
 * workflow/rework-signature — flags the highest-rework-signature project/session.
 *
 * Persona P5 (Riley, prompt-pattern researcher, issue #564). Reads the optional
 * `fileHistory` field on RecommendationInput (FileHistorySession[]). If no data
 * is present the detector emits nothing, keeping existing test fixtures
 * compiling unchanged.
 *
 * A high "rework signature" means many pre-edit snapshots packed into a tight
 * time window (high burstRate). It is a churn proxy, not a diagnosis: the
 * aggregate does not identify whether the checkpoints came from trial-and-error
 * work, an unclear prompt, or ordinary iterative editing.
 *
 * Signal derivation (pure from parse-file-history; never reads snapshot bodies):
 *   reworkScore  = churn * (1 + burstRate)   per session
 *   highest-rework session = top of that list
 *
 * Fires only when at least MIN_SESSIONS sessions are present and the top session
 * exceeds MIN_REWORK_SCORE so the detector stays quiet on sparse or calm datasets.
 */

import type { Detector } from '../types';
import { short, newestEpochDate } from '../shared';

const MIN_SESSIONS = 3;
const MIN_REWORK_SCORE = 10;

export const detector: Detector = {
  id: 'workflow.rework-signature',
  category: 'workflow',
  dataDeps: ['fileHistory', 'sessions'], // fileHistory drives the signal; sessions for context
  rule(input) {
    const data = input.fileHistory ?? [];

    if (data.length < MIN_SESSIONS) return null;

    const top = [...data].sort((a, b) => b.reworkScore - a.reworkScore)[0];
    if (top.reworkScore < MIN_REWORK_SCORE) return null;

    // Find the worst session as evidence; collect the top-5 for the evidence list.
    const top5 = [...data]
      .sort((a, b) => b.reworkScore - a.reworkScore)
      .slice(0, 5);

    const severity = top.burstRate >= 3 ? 'warning' : 'info';

    // Anchored to the newest OBSERVED snapshot mtime across the shown sessions,
    // never to `now`: file-history is only known to be this churny as of the
    // last checkpoint recorded. An unreadable/absent mtime yields no `asOf`.
    const asOf = newestEpochDate(top5.map((s) => s.lastMs));

    return {
      id: 'workflow.rework-signature',
      category: 'workflow',
      severity,
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: 'File-snapshot churn concentrated in a short window',
      detail:
        `Session ${short(top.sessionId)} recorded reworkScore ${top.reworkScore} — ` +
        `${top.churn} pre-edit file-history checkpoint(s) over ${top.spanMin}m ` +
        `(${top.burstRate}/min). These are checkpoint counts from ~/.claude/file-history: ` +
        `a high rate means many edits packed into a tight window.`,
      action:
        'Review the highest-churn sessions. If the churn reflects trial-and-error, ' +
        'clearer up-front specs or pre-edit lint/typecheck hooks can cut repeated ' +
        'checkpoints; if it is ordinary iterative editing, no action is needed.',
      affected: top5.length,
      evidence: top5.map(
        (s) =>
          `${short(s.sessionId)}: score=${s.reworkScore}  churn=${s.churn}  burst=${s.burstRate}/min  span=${s.spanMin}m`
      ),
      view: 'files',
      provenance: {
        observations: [
          {
            claim: `${data.length} session(s) carried scored file-history aggregates`,
            source: 'parse-file-history (fileHistory[])',
            field: 'fileHistory.length',
            value: data.length,
          },
          {
            claim: `the highest observed reworkScore is ${top.reworkScore}`,
            source: 'parse-file-history (fileHistory[])',
            field: 'reworkScore',
            value: top.reworkScore,
          },
          {
            claim: `that session recorded ${top.churn} pre-edit snapshot checkpoint(s)`,
            source: 'parse-file-history (fileHistory[])',
            field: 'churn',
            value: top.churn,
          },
          {
            claim: `its snapshots were packed at ${top.burstRate} per minute`,
            source: 'parse-file-history (fileHistory[])',
            field: 'burstRate',
            value: top.burstRate,
          },
          {
            claim: `the same session's file-history window spans ${top.spanMin} minute(s)`,
            source: 'parse-file-history (fileHistory[])',
            field: 'spanMin',
            value: top.spanMin,
          },
        ],
        // reworkScore = churn × (1 + burstRate) ranks tight, churny sessions
        // highest. It is a PROXY for retry-storm-style rework: the snapshot
        // counts do NOT identify WHY the edits happened (an unclear prompt, a
        // brittle edit, or normal iterative work all produce checkpoints), so no
        // cause is claimed. burstRate >= 3 only raises the DISPLAY severity; it
        // is not evidence of a specific cause.
        inference:
          'A high reworkScore concentrates many pre-edit checkpoints into a short window; ' +
          'this proxies rework but does not identify its cause, which is not measured here.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
