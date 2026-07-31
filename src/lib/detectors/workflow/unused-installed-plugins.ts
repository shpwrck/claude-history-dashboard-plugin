import type { Detector } from '../types';
import { computeConfigHygiene } from '../../config-hygiene';
import { buildConfigRemovalSnippetBlock } from '../../config-hygiene-actions';
import { unusedWindowWording } from './unused-installed-window';

/** Flag installed-but-unused plugins and expose a copyable prune command. */
export const detector: Detector = {
  id: 'workflow.unused-installed-plugins',
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
    }).filter((f) => f.resourceType === 'plugin' && f.windowCount === 0);
    if (unused.length === 0) return null;
    const ids = unused.map((f) => f.resourceId);
    // #3249: preserve the hygiene hedge — bound the claim to the observed
    // interval + as-of date when the retained history is shorter than 30 days.
    const window = unusedWindowWording(unused, sessions, now);
    return {
      id: 'workflow.unused-installed-plugins',
      category: 'workflow',
      severity: 'info',
      title: `Installed plugins unused ${window.titleWindow}`,
      detail: `${unused.length} installed plugin(s) had zero bundled skill/subagent invocations ${window.detailWindow}; unused plugins add selection ambiguity and stale surface area.`,
      action: 'Remove unused plugins from ~/.claude/plugins/ to keep the plugin surface clean.',
      affected: unused.length,
      evidence: ids.slice(0, 5),
      fix: {
        target: 'command',
        label: 'Prune unused plugins',
        note: 'Copy and run after confirming each plugin is no longer needed.',
        snippet: buildConfigRemovalSnippetBlock(unused),
      },
    };
  },
};
