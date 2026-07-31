import type { Detector } from '../types';
import { computeConfigHygiene } from '../../config-hygiene';
import { buildConfigRemovalSnippetBlock } from '../../config-hygiene-actions';
import { unusedWindowWording } from './unused-installed-window';

// Installed subagent definitions with zero invocations in the 30-day window add
// agent-selection ambiguity when Claude picks which subagent to invoke. The
// unused slice is already computed by computeConfigHygiene (resourceType
// 'subagent') — this mirrors workflow.unused-installed-skills to surface it. (#633)
const MIN_UNUSED = 3;

/** Flag installed-but-unused subagents with a copy-only prune command. (#633) */
export const detector: Detector = {
  id: 'workflow.unused-installed-subagents',
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
    }).filter((f) => f.resourceType === 'subagent' && f.windowCount === 0);
    if (unused.length < MIN_UNUSED) return null;
    const ids = unused.map((f) => f.resourceId);
    // #3249: preserve the hygiene hedge — bound the claim to the observed
    // interval + as-of date when the retained history is shorter than 30 days.
    const window = unusedWindowWording(unused, sessions, now);
    return {
      id: 'workflow.unused-installed-subagents',
      category: 'workflow',
      severity: 'info',
      title: `Installed subagents unused ${window.titleWindow}`,
      detail: `${unused.length} installed subagent(s) had zero invocations ${window.detailWindow}; unused subagents add selection ambiguity when Claude picks which to invoke.`,
      action: 'Remove unused subagents from ~/.claude/agents/ to keep agent-selection clean.',
      affected: unused.length,
      evidence: ids.slice(0, 5),
      fix: {
        target: 'command',
        label: 'Prune unused subagents',
        note: 'Copy and run after confirming each subagent is no longer needed.',
        snippet: buildConfigRemovalSnippetBlock(unused),
      },
    };
  },
};
