import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, truncate } from '../shared';
import { repeatedCommands, type RepeatedCommandStat } from '../../parse-tools';

const MARKERS_REPEATED_COMMANDS: AppliedMarkers = {
  headings: [/^##\s+Common commands\b/i],
  bodyPhrases: ['wrap them in a script'],
};

/** Render parsed command text literally without letting embedded backticks close the span. */
function markdownCodeSpan(value: string): string {
  const flat = truncate(value, 70);
  const longestRun = Math.max(
    0,
    ...Array.from(flat.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = '`'.repeat(longestRun + 1);
  const padding = flat.length === 0 || flat.startsWith('`') || flat.endsWith('`')
    ? ' '
    : '';
  return `${fence}${padding}${flat}${padding}${fence}`;
}

/** Identical Bash commands run 3+ times in a session — automate them. */
export const detector: Detector = {
  id: 'workflow.repeated-commands',
  appliedMarkers: MARKERS_REPEATED_COMMANDS,
  category: 'workflow',
  dataDeps: ['toolData', 'liveConfig'],
  rule(input) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_REPEATED_COMMANDS)) return null;
    const repeats: RepeatedCommandStat[] = repeatedCommands(input.toolData);
    if (repeats.length === 0) return null;
    const totalRuns = repeats.reduce((n, r) => n + r.totalCount, 0);
    return {
      id: 'workflow.repeated-commands',
      category: 'workflow',
      severity: 'info',
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: 'Repeated commands are candidates for automation',
      detail: `${repeats.length} command(s) ran 3+ times within a session — repetitive manual steps that a hook, skill, or Makefile target could absorb.`,
      action: 'Wrap the most-repeated commands in a script or a SessionStart/PostToolUse hook.',
      affected: repeats.length,
      evidence: repeats
        .slice(0, 5)
        .map((r) => `${r.totalCount}×, ${truncate(r.command, 70)}`),
      view: 'tools',
      fix: (() => {
        const bullets = repeats
          .slice(0, 3)
          .map((r) => `- ${markdownCodeSpan(r.command)}`)
          .join('\n');
        return {
          target: 'CLAUDE.md' as const,
          label: 'Document a wrapper',
          fixKind: 'illustrative' as const,
          note: 'Append to your project CLAUDE.md. Wrap these in a script or Make target and point the entry here, so future sessions run one command instead of repeating the steps.',
          snippet:
            `## Common commands\n\n` +
            `These were run repeatedly — wrap them in a script (e.g. \`scripts/dev.sh\`) ` +
            `or a Makefile target and invoke that instead of re-typing the steps:\n\n` +
            bullets,
          appliedMarkers: MARKERS_REPEATED_COMMANDS,
        };
      })(),
      provenance: {
        observations: [
          {
            claim: `${repeats.length} distinct command(s) ran 3+ times within a single session`,
            source: 'parse-tools (repeatedCommands over toolData[].calls)',
            field: 'repeatedCommands.length',
            value: repeats.length,
          },
          {
            claim: `those command(s) ran ${totalRuns} time(s) in total across the sessions that repeated them`,
            source: 'parse-tools (repeatedCommands over toolData[].calls)',
            field: 'sum(totalCount)',
            value: totalRuns,
          },
        ],
        // `repeatedCommands` aggregates identical (fingerprinted) Bash command
        // strings and carries NO per-command timestamp, so there is no readable
        // datum to date this from — a borrowed date (e.g. the newest Bash call
        // anywhere) would assert a freshness the aggregate does not have, so
        // `asOf` is omitted. Repetition is a candidate for automation; whether a
        // given command SHOULD be wrapped (vs. legitimately re-run) is the
        // recommendation, not a measured fact.
        inference:
          'Identical Bash command strings repeated 3+ times in a session are automation ' +
          'candidates; no token or wall-clock cost is measured, and the aggregate is undated.',
      },
    };
  },
};
