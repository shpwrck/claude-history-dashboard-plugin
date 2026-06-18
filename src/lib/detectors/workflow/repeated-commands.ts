import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, truncate } from '../shared';
import { repeatedCommands, type RepeatedCommandStat } from '../../parse-tools';

const MARKERS_REPEATED_COMMANDS: AppliedMarkers = {
  headings: [/^##\s+Common commands\b/i],
  bodyPhrases: ['wrap them in a script'],
};

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
    return {
      id: 'workflow.repeated-commands',
      category: 'workflow',
      severity: 'info',
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
          .map((r) => `- \`${truncate(r.command, 70)}\``)
          .join('\n');
        return {
          target: 'CLAUDE.md' as const,
          label: 'Document a wrapper',
          note: 'Append to your project CLAUDE.md. Wrap these in a script or Make target and point the entry here, so future sessions run one command instead of repeating the steps.',
          snippet:
            `## Common commands\n\n` +
            `These were run repeatedly — wrap them in a script (e.g. \`scripts/dev.sh\`) ` +
            `or a Makefile target and invoke that instead of re-typing the steps:\n\n` +
            bullets,
          appliedMarkers: MARKERS_REPEATED_COMMANDS,
        };
      })(),
    };
  },
};
