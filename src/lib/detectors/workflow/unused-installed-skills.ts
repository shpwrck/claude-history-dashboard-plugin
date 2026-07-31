import type { Detector } from '../types';
import { computeConfigHygiene } from '../../config-hygiene';
import { buildConfigRemovalSnippetBlock } from '../../config-hygiene-actions';
import { unusedWindowWording } from './unused-installed-window';

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
    const sessions = input.sessions.map((s) => ({
      sessionId: s.sessionId,
      startTime: s.startTime,
      project: s.project,
    }));
    const unused = computeConfigHygiene({
      liveConfig: input.liveConfig,
      attribution: input.attribution ?? [],
      sessions,
      now,
    }).filter((f) => f.resourceType === 'skill' && f.windowCount === 0);
    if (unused.length < MIN_UNUSED) return null;
    const ids = unused.map((f) => f.resourceId);
    // #3249: preserve the hygiene hedge — bound the claim to the observed
    // interval + as-of date when the retained history is shorter than 30 days.
    const window = unusedWindowWording(unused, sessions, now);
    return {
      id: 'workflow.unused-installed-skills',
      category: 'workflow',
      severity: 'info',
      title: `Installed skills unused ${window.titleWindow}`,
      detail: `${unused.length} installed skill(s) had zero invocations ${window.detailWindow}; unused skills add selection ambiguity when Claude picks which to invoke.`,
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
