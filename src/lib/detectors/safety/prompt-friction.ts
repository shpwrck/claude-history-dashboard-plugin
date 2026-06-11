import type { Detector } from '../types';
import { permissionsContain, BASH_SAFE_ALLOW_RULES } from '../shared';
import { rankPromptProneTools } from '../../parse-permissions';

/** The tool driving the most permission prompts — seed an allowlist. */
export const detector: Detector = {
  id: 'safety.prompt-friction',
  category: 'safety',
  dataDeps: ['toolData', 'permissionRows', 'liveConfig'],
  rule(input) {
    const friction = rankPromptProneTools(input.toolData, input.permissionRows);
    const top = friction[0];
    // Only meaningful when one tool clearly dominates prompt-eligible calls.
    if (!top || top.promptableCalls < 20 || top.share < 25) return null;
    // The fix is an allowlist. Skip when the relevant allow rules are already in
    // permissions.allow — Bash uses the canonical safe-variant list, anything
    // else allowlists by tool name.
    const allowRules =
      top.toolName === 'Bash' ? BASH_SAFE_ALLOW_RULES : [top.toolName];
    if (permissionsContain(input.liveConfig?.settings, 'allow', allowRules)) return null;
    return {
      id: 'safety.prompt-friction',
      category: 'safety',
      severity: 'info',
      title: 'Reduce permission-prompt friction',
      detail: `${top.toolName} accounts for ${top.share.toFixed(0)}% of prompt-eligible tool calls (${top.promptableCalls} across ${top.sessionCount} sessions).`,
      action:
        'Seed a project allowlist for the safe variants of this tool by merging the snippet below into .claude/settings.json. (If installed, the /fewer-permission-prompts skill can generate one from your transcripts.)',
      affected: top.promptableCalls,
      evidence: friction
        .slice(0, 4)
        .map((f) => `${f.toolName}: ${f.promptableCalls} (${f.share.toFixed(0)}%)`),
      view: 'permissions',
      fix: {
        target: 'settings.json',
        label: `Allowlist safe ${top.toolName} calls`,
        note: 'Merge into .claude/settings.json — deep-merge the "permissions.allow" array. Allowed calls stop prompting; the Bash list below is limited to read-only/idempotent commands.',
        snippet:
          top.toolName === 'Bash'
            ? JSON.stringify(
                { permissions: { allow: BASH_SAFE_ALLOW_RULES } },
                null,
                2
              )
            : JSON.stringify(
                { permissions: { allow: [top.toolName] } },
                null,
                2
              ),
      },
    };
  },
};
