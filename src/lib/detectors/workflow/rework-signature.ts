/**
 * workflow/rework-signature — flags the highest-rework-signature project/session.
 *
 * Persona P5 (Riley, prompt-pattern researcher, issue #564). Reads the optional
 * `fileHistory` field on RecommendationInput (FileHistorySession[]). If no data
 * is present the detector emits nothing, keeping existing test fixtures
 * compiling unchanged.
 *
 * A high "rework signature" means many pre-edit snapshots packed into a tight
 * time window (high burstRate), indicating retry storms: the agent made many
 * file edits in rapid succession, each triggering a checkpoint, suggesting
 * unclear prompts, breaking changes, or trial-and-error work patterns.
 *
 * Signal derivation (pure from parse-file-history; never reads snapshot bodies):
 *   reworkScore  = churn * (1 + burstRate)   per session
 *   highest-rework session = top of that list
 *
 * Fires only when at least MIN_SESSIONS sessions are present and the top session
 * exceeds MIN_REWORK_SCORE so the detector stays quiet on sparse or calm datasets.
 */

import type { Detector, RecommendationInput } from '../types';
import type { FileHistorySession } from '../../parse-file-history';
import { short } from '../shared';

const MIN_SESSIONS = 3;
const MIN_REWORK_SCORE = 10;

export const detector: Detector = {
  id: 'workflow.rework-signature',
  category: 'workflow',
  dataDeps: ['sessions'], // fileHistory is injected via the cast below; sessions for context
  rule(input) {
    // fileHistory is an optional extension field not yet on the base type.
    // Cast here so this detector compiles without touching the shared types file.
    const data = (input as RecommendationInput & { fileHistory?: FileHistorySession[] })
      .fileHistory ?? [];

    if (data.length < MIN_SESSIONS) return null;

    const top = [...data].sort((a, b) => b.reworkScore - a.reworkScore)[0];
    if (top.reworkScore < MIN_REWORK_SCORE) return null;

    // Find the worst session as evidence; collect the top-5 for the evidence list.
    const top5 = [...data]
      .sort((a, b) => b.reworkScore - a.reworkScore)
      .slice(0, 5);

    const severity = top.burstRate >= 3 ? 'warning' : 'info';

    return {
      id: 'workflow.rework-signature',
      category: 'workflow',
      severity,
      title: 'High file-snapshot churn signals retry storms',
      detail:
        `Session ${short(top.sessionId)} has reworkScore ${top.reworkScore} ` +
        `(${top.churn} pre-edit checkpoints, ${top.burstRate}/min burst rate). ` +
        `High burst rates indicate rapid successive file edits — a retry-storm ` +
        `pattern that wastes round-trips and signals unclear prompts or brittle edits.`,
      action:
        'Review high-rework sessions: add clearer up-front specs or pre-edit hooks ' +
        '(lint/typecheck) to catch errors before they cascade into repeated checkpoint cycles.',
      affected: top5.length,
      evidence: top5.map(
        (s) =>
          `${short(s.sessionId)}: score=${s.reworkScore}  churn=${s.churn}  burst=${s.burstRate}/min  span=${s.spanMin}m`
      ),
      view: 'files',
    };
  },
};
