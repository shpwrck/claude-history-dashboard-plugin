import type { Detector } from '../types';
import type { RecSeverity } from '../types';
import {
  bumpSeverity,
  short,
  permissionsContain,
  DANGEROUS_DENY_RULES,
  DANGEROUS_ASK_RULES,
} from '../shared';
import { isUnattendedEntrypoint } from '../../parse-sessions';
import {
  detectDangerousCommands,
  computeSafetyScores,
} from '../../parse-permissions';
import type { DangerousCommand } from '../../parse-permissions';

function dangerousEvidence(d: DangerousCommand): string {
  return `${short(d.sessionId)}, ${d.pattern}: ${d.command}`;
}

/**
 * Dangerous commands that ran while permission prompts were bypassed.
 *
 * DUAL-EMIT: this detector's `id` is `safety.dangerous-bypass`, but its rule
 * body emits `safety.dangerous-commands` on its second branch (dangerous
 * commands present but not under bypass). Both branches share one detector; see
 * the shared DUAL_EMIT allowlist in ../dual-emit.
 */
export const detector: Detector = {
  id: 'safety.dangerous-bypass',
  category: 'safety',
  dataDeps: ['toolData', 'tokenData', 'permissionRows', 'liveConfig'],
  rule(input) {
    const dangerous = detectDangerousCommands(input.toolData);
    if (dangerous.length === 0) return null;
    // If the canonical deny block from the fix is already present in settings,
    // every recommendation variant this rule emits is satisfied (deny is
    // strictly stronger than ask). Skip wholesale.
    if (permissionsContain(input.liveConfig?.settings, 'deny', DANGEROUS_DENY_RULES)) {
      return null;
    }
    // Sessions whose entrypoint is unattended (`sdk-*`). Reuses the canonical
    // classifier shared with ruleAutomationCost — do NOT re-derive the set (#197).
    const unattendedSessions = new Set(
      input.tokenData
        .filter((d) => isUnattendedEntrypoint(d.entrypoint))
        .map((d) => d.sessionId)
    );
    // True when ANY of the given dangerous commands ran in an unattended session.
    const ranUnattended = (cmds: { sessionId: string }[]) =>
      cmds.some((c) => unattendedSessions.has(c.sessionId));

    const scores = computeSafetyScores(dangerous, input.permissionRows);
    const risky = scores.filter((s) => s.bypassMode && s.dangerousCount > 0);
    if (risky.length > 0) {
      const totalDangerous = risky.reduce((s, r) => s + r.dangerousCount, 0);
      // Contributing commands are those in a risky (bypass-mode) session.
      const riskySessions = new Set(risky.map((r) => r.sessionId));
      const bumped = ranUnattended(
        dangerous.filter((d) => riskySessions.has(d.sessionId))
      );
      const baseSeverity: RecSeverity = 'critical';
      return {
        id: 'safety.dangerous-bypass',
        category: 'safety',
        severity: bumped ? bumpSeverity(baseSeverity) : baseSeverity,
        unattended: bumped,
        title: 'Dangerous commands ran under bypassed permissions',
        detail: `${totalDangerous} risky command(s) (e.g. rm -rf, git reset --hard, curl|sh) ran in ${risky.length} session(s) that used bypassPermissions.`,
        action:
          'Reserve bypassPermissions for trusted, reversible work; add an explicit deny-list for destructive patterns.',
        affected: totalDangerous,
        evidence: dangerous.slice(0, 5).map(dangerousEvidence),
        view: 'permissions',
        fix: {
          target: 'settings.json',
          label: 'Add destructive-command deny rules',
          note: 'Merge into the "permissions" object in .claude/settings.json (deep-merge "deny"), and reserve bypassPermissions for trusted, reversible work. curl|sh cannot be prefix-matched, so curl/wget are denied wholesale — drop them if too broad.',
          snippet: `{
  "permissions": {
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(rm -fr:*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean -fd:*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(dd:*)",
      "Bash(mkfs:*)",
      "Bash(shred:*)",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  }
}`,
        },
      };
    }
    // Dangerous commands present but not under bypass — still worth a heads-up,
    // unless the user has already added the canonical ask block (deny was checked
    // at the top of the rule).
    if (permissionsContain(input.liveConfig?.settings, 'ask', DANGEROUS_ASK_RULES)) {
      return null;
    }
    // Every detected command contributes to this finding, so any one in an
    // unattended session bumps it warning → critical (#197).
    const commandsBumped = ranUnattended(dangerous);
    const commandsBaseSeverity: RecSeverity = 'warning';
    return {
      id: 'safety.dangerous-commands',
      category: 'safety',
      severity: commandsBumped
        ? bumpSeverity(commandsBaseSeverity)
        : commandsBaseSeverity,
      unattended: commandsBumped,
      title: 'Dangerous command patterns detected',
      detail: `${dangerous.length} command(s) matched a destructive pattern (rm -rf, git push --force, dd, …).`,
      action: 'Spot-check these were intentional; consider a hook that confirms before destructive ops.',
      affected: dangerous.length,
      evidence: dangerous.slice(0, 5).map(dangerousEvidence),
      view: 'permissions',
      fix: {
        target: 'settings.json',
        label: 'Confirm before destructive commands',
        note: 'Merge into the "permissions" object in .claude/settings.json (deep-merge "ask"). "ask" forces an interactive confirmation rather than blocking outright.',
        snippet: `{
  "permissions": {
    "ask": [
      "Bash(rm -rf:*)",
      "Bash(rm -fr:*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean -fd:*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(dd:*)",
      "Bash(mkfs:*)",
      "Bash(shred:*)"
    ]
  }
}`,
      },
    };
  },
};
