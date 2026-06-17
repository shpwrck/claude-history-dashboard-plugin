import type { Detector } from '../types';
import { computeConfigHygiene } from '../../config-hygiene';
import { buildConfigRemovalSnippetBlock } from '../../config-hygiene-actions';

// Installed skills with zero invocations in the 30-day window add selection
// ambiguity when Claude picks which skill to invoke. (#421)
const MIN_UNUSED = 3;

/** Flag installed-but-unused skills with a copy-only prune command. (#421) */
export const detector: Detector = {
  id: 'workflow.unused-installed-skills',
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
        project: s.project,
      })),
      now,
    }).filter((f) => f.resourceType === 'skill' && f.windowCount === 0);
    if (unused.length < MIN_UNUSED) return null;
    const ids = unused.map((f) => f.resourceId);
    return {
      id: 'workflow.unused-installed-skills',
      category: 'workflow',
      severity: 'info',
      title: 'Installed skills unused in the last 30 days',
      detail: `${unused.length} installed skill(s) had zero invocations in the last 30 days; unused skills add selection ambiguity when Claude picks which to invoke.`,
      action: 'Remove unused skills from ~/.claude/skills/ to keep skill-selection clean.',
      affected: unused.length,
      evidence: ids.slice(0, 5),
      fix: {
        target: 'command',
        label: 'Prune unused skills',
        note: 'Copy and run after confirming each skill is no longer needed.',
        snippet: buildConfigRemovalSnippetBlock(unused),
      },
    };
  },
};
