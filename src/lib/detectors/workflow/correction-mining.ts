/**
 * workflow.correction-mining (#1040, epic #866) — the deterministic counterpart
 * to headroom's `learn`.
 *
 * Our other detectors flag the SYMPTOM of a wrong guess (tool errors, retry
 * storms, redundant reads) but never extract the corrective FACT. This one mines
 * failed→fixed tool sequences within a session — an errored call followed by the
 * same-tool call that succeeded at the same intent — and diffs the argument to a
 * ready-to-pin fact: a file Read that failed at one path then succeeded at
 * another (the file is at B, not A), or a command that failed then worked as a
 * variant (`uv run python …`, not `python3 …`).
 *
 * Pinning these in CLAUDE.md stops the agent re-guessing across sessions. The
 * `fix` is marker-bearing so the adoption scorecard (#577) tracks whether the
 * user actually wrote the fact down — this is where we go beyond headroom, which
 * writes corrections but never measures adoption.
 *
 * Deterministic, transcript-free (reads only distilled `toolData`) — free/local
 * path per ADR 0005.
 */
import type { Detector, AppliedMarkers } from '../types';
import { claudeMdMarksApplied, truncate } from '../shared';
import { mineCorrections, aggregateCorrections } from '../../parse-tools';

const MARKERS_CORRECTIONS: AppliedMarkers = {
  headings: [/^##\s+(?:Known paths|File locations|Project map|Corrections|Gotchas)\b/i],
  bodyPhrases: ['not the first place the agent looked'],
};

/** Cap evidence/fact rows so the card and CLAUDE.md block stay scannable. */
const MAX_ROWS = 5;

/** A short, CLAUDE.md-ready sentence for one corrective fact. */
function factLine(c: { failed: string; succeeded: string }): string {
  return `\`${truncate(c.succeeded, 80)}\` is the real path (the agent first tried \`${truncate(c.failed, 80)}\`).`;
}

export const detector: Detector = {
  id: 'workflow.correction-mining',
  category: 'workflow',
  dataDeps: ['toolData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_CORRECTIONS)) return null;

    const facts = aggregateCorrections(mineCorrections(input.toolData));
    if (facts.length === 0) return null;

    const top = facts.slice(0, MAX_ROWS);

    return {
      id: 'workflow.correction-mining',
      category: 'workflow',
      severity: 'info',
      title: 'Pin recurring wrong-path corrections in CLAUDE.md',
      detail:
        `Mined ${facts.length} wrong-path guess(es) from failed→fixed tool sequences — a file read/edit that errored, ` +
        `then succeeded at a different path with the same filename. Recording the real path stops future sessions re-guessing.`,
      action:
        'Add the corrected paths to your project CLAUDE.md so the agent uses the working location first.',
      affected: facts.length,
      evidence: top.map(
        (c) =>
          `${c.toolName}: ${truncate(c.failed, 48)} → ${truncate(c.succeeded, 48)}` +
          (c.occurrences > 1 ? ` (×${c.occurrences})` : '')
      ),
      view: 'tools',
      fix: {
        target: 'CLAUDE.md',
        label: 'Pin the corrections',
        note: 'Append to your project CLAUDE.md. These are facts the agent had to discover by failing first — pinning them avoids the failed attempt next time.',
        snippet:
          `## Known paths & gotchas\n\n` +
          `These were learned the hard way — the agent guessed wrong, then found the right value. ` +
          `They are not the first place the agent looked, so pin them:\n\n` +
          top.map((c) => `- ${factLine(c)}`).join('\n'),
        appliedMarkers: MARKERS_CORRECTIONS,
      },
    };
  },
};
