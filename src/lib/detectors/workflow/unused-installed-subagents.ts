import type { Detector } from '../types';
import { computeConfigHygiene } from '../../config-hygiene';

// Installed subagent definitions with zero invocations in the 30-day window add
// agent-selection ambiguity when Claude picks which subagent to invoke. The
// unused slice is already computed by computeConfigHygiene (resourceType
// 'subagent') — this mirrors workflow.unused-installed-skills to surface it. (#633)
const MIN_UNUSED = 3;

function pruneSnippet(ids: string[]): string {
  return ids.map((id) => `rm ~/.claude/agents/${id}`).join('\n');
}

/** Flag installed-but-unused subagents with a copy-only prune command. (#633) */
export const detector: Detector = {
  id: 'workflow.unused-installed-subagents',
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
    }).filter((f) => f.resourceType === 'subagent' && f.windowCount === 0);
    if (unused.length < MIN_UNUSED) return null;
    const ids = unused.map((f) => f.resourceId);
    return {
      id: 'workflow.unused-installed-subagents',
      category: 'workflow',
      severity: 'info',
      title: 'Installed subagents unused in the last 30 days',
      detail: `${unused.length} installed subagent(s) had zero invocations in the last 30 days; unused subagents add selection ambiguity when Claude picks which to invoke.`,
      action: 'Remove unused subagents from ~/.claude/agents/ to keep agent-selection clean.',
      affected: unused.length,
      evidence: ids.slice(0, 5),
      fix: {
        target: 'command',
        label: 'Prune unused subagents',
        note: 'Copy and run after confirming each subagent is no longer needed.',
        snippet: pruneSnippet(ids),
      },
    };
  },
};
