/**
 * workflow/rework-signature — flags the highest-rework-signature project/session.
 *
 * Persona P5 (Riley, prompt-pattern researcher, issue #564). Reads the optional
 * `fileHistory` field on RecommendationInput (FileHistorySession[]). If no data
 * is present the detector emits nothing, keeping existing test fixtures
 * compiling unchanged.
 *
 * A high legacy-named "rework signature" means many pre-edit snapshots packed
 * into a tight time window (high burstRate). It is a checkpoint-density rank,
 * not a diagnosis: the aggregate identifies neither file paths nor edit intent.
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
        'Use the session IDs to inspect surrounding activity only if the checkpoint ' +
        'density is unexpected. File-history metadata identifies neither file paths ' +
        'nor edit intent, so it does not support a corrective action by itself.',
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
        // reworkScore = churn × (1 + burstRate) ranks tight, checkpoint-dense
        // sessions highest. The legacy field name does not establish recurrence
        // or intent: snapshot counts identify neither paths nor edit content.
        // burstRate >= 3 only raises DISPLAY severity.
        inference:
          'The legacy-named reworkScore combines checkpoint count and rate to rank ' +
          'dense file-history windows. This metadata identifies neither file paths ' +
          'nor edit intent, so it supports no diagnosis about the work.',
        ...(asOf ? { asOf } : {}),
      },
    };
  },
};
