import type { Detector } from '../types';
import { parsePermRule, isDangerousDenyRule, permRuleMatchesCall } from '../shared';

/**
 * Permission `deny` rules that never matched a command attempt in retained
 * history — likely leftover clutter rather than active guards (#175). Known
 * dangerous-command guards (rm -rf, dd, curl, …) are excluded: a never-fired
 * destructive-command deny is the guard doing its job, not dead config, so we
 * never nudge toward removing one. Only Bash and bare-tool deny rules are
 * judged; rules with a non-Bash specifier (path globs) are skipped rather than
 * guessed. Inherently suppressible per the #166 model: the finding is derived
 * from current settings, so acting on the fix (deleting the entry) removes it
 * from `deny` and the rule stops surfacing it.
 */
export const detector: Detector = {
  id: 'safety.deny-rule-never-triggered',
  category: 'safety',
  dataDeps: ['toolData', 'liveConfig'],
  rule(input) {
    const deny = input.liveConfig?.settings?.permissions?.deny;
    if (!Array.isArray(deny) || deny.length === 0) return null;

    const unused: string[] = [];
    for (const rule of deny) {
      if (typeof rule !== 'string') continue;
      const { tool, specifier } = parsePermRule(rule);
      // Skip safety guards and rules we can't evaluate confidently.
      if (tool === 'Bash' && specifier !== null) {
        if (isDangerousDenyRule(rule)) continue;
      } else if (specifier !== null) {
        continue; // non-Bash specifier (path glob etc.) — not confidently judged
      }
      let matched = false;
      for (const sess of input.toolData) {
        for (const call of sess.calls) {
          if (permRuleMatchesCall(rule, call) === true) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) unused.push(rule);
    }
    if (unused.length === 0) return null;

    return {
      id: 'safety.deny-rule-never-triggered',
      category: 'safety',
      severity: 'info',
      title: 'Unused permission deny rules',
      detail: `${unused.length} permission deny rule(s) never matched a command attempt in your retained history — they may be leftover clutter rather than active guards.`,
      action:
        'Review whether these are still needed; pruning dead entries keeps settings.json honest. Known dangerous-command guards are deliberately excluded from this check, so anything listed is a non-destructive rule that simply never fired.',
      evidence: unused,
      affected: unused.length,
      view: 'permissions',
      fix: {
        target: 'settings.json',
        label: 'Prune unused deny rules',
        note: 'Remove these never-matched entries from the "permissions.deny" array in settings.json if they are no longer relevant. (Destructive-command guards are never listed here.)',
        snippet: JSON.stringify({ permissions: { deny: unused } }, null, 2),
      },
    };
  },
};
