import type { Detector } from '../types';
import { computeConfigHygiene } from '../../config-hygiene';

// Installed slash-command definitions (~/.claude/commands/*.md) with zero
// invocations in the 30-day window add menu clutter and selection ambiguity.
// Usage now comes from the parsed `<command-name>` markers in transcripts
// (parse-agents commands map), lifting the v1 "no transcript parser" deferral.
// Mirrors unused-installed-skills / -subagents. (#634)
const MIN_UNUSED = 3;

/** Flag installed-but-unused slash commands. No fix snippet — removal is `rm`
 *  under ~/.claude/commands/; no settings key controls installed commands. (#634) */
export const detector: Detector = {
  id: 'workflow.unused-installed-commands',
  category: 'workflow',
  dataDeps: ['liveConfig', 'attribution', 'sessions'],
  rule(input, now) {
    if (!input.liveConfig) return null;
    const unused = computeConfigHygiene({
      liveConfig: input.liveConfig,
      attribution: input.attribution ?? [],
      sessions: input.sessions.map((s) => ({
        sessionId: s.sessionId,
        startTime: s.startTime,
      })),
      now,
    }).filter((f) => f.resourceType === 'command' && f.windowCount === 0);
    if (unused.length < MIN_UNUSED) return null;
    return {
      id: 'workflow.unused-installed-commands',
      category: 'workflow',
      severity: 'info',
      title: 'Installed slash-commands unused in the last 30 days',
      detail: `${unused.length} installed slash-command(s) had zero invocations in the last 30 days; unused commands clutter the slash menu and add selection ambiguity.`,
      action: 'Remove unused commands from ~/.claude/commands/ to keep the slash menu clean.',
      affected: unused.length,
      evidence: unused.slice(0, 5).map((f) => f.resourceId),
    };
  },
};
