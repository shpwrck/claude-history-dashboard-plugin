import type { Detector } from '../types';
import { permissionsContain } from '../shared';
import { rankPromptProneTools } from '../../parse-permissions';

/** Surface the tool driving the most permission prompts for manual review. */
export const detector: Detector = {
  id: 'safety.prompt-friction',
  category: 'safety',
  dataDeps: ['toolData', 'permissionRows', 'liveConfig'],
  rule(input) {
    const friction = rankPromptProneTools(input.toolData, input.permissionRows);
    const top = friction[0];
    // Only meaningful when one tool clearly dominates prompt-eligible calls.
    if (!top || top.promptableCalls < 20 || top.share < 25) return null;
    const totalPromptableCalls = friction.reduce(
      (total, row) => total + row.promptableCalls,
      0
    );
    if (
      permissionsContain(input.liveConfig?.settings, 'allow', [top.toolName])
    ) {
      return null;
    }

    // The aggregate signal establishes frequency only. It does not retain the
    // operation-level arguments, shell effects, or path confinement needed to
    // prove that any allow rule is safe, including a command-prefixed Bash
    // wildcard. Keep every tool manual until that evidence is available.
    const action = `Decide case by case which ${top.toolName} operations are safe before allowlisting anything. This finding measures prompt FREQUENCY, not safety, so no allow snippet is offered. If you do allowlist it, scope the rule to the specific operations you have reviewed rather than the bare tool name.`;

    return {
      id: 'safety.prompt-friction',
      category: 'safety',
      severity: 'info',
      title: 'Reduce permission-prompt friction',
      detail: `${top.toolName} accounts for ${top.share.toFixed(0)}% of prompt-eligible tool calls (${top.promptableCalls} across ${top.sessionCount} sessions).`,
      action,
      affected: top.promptableCalls,
      evidence: friction
        .slice(0, 4)
        .map((f) => `${f.toolName}: ${f.promptableCalls} (${f.share.toFixed(0)}%)`),
      view: 'permissions',
      provenance: {
        observations: [
          {
            claim: `${top.promptableCalls} prompt-eligible call(s) used ${top.toolName}`,
            source:
              'parse-permissions (rankPromptProneTools over toolData + permissionRows)',
            field: 'rankPromptProneTools().promptableCalls',
            value: top.promptableCalls,
          },
          {
            claim: `${totalPromptableCalls} prompt-eligible call(s) formed the share denominator`,
            source:
              'parse-permissions (rankPromptProneTools over toolData + permissionRows)',
            field: 'rankPromptProneTools()[].promptableCalls',
            value: totalPromptableCalls,
          },
          {
            claim: `${top.sessionCount} session(s) contributed ${top.toolName} calls`,
            source:
              'parse-permissions (rankPromptProneTools over toolData + permissionRows)',
            field: 'rankPromptProneTools().sessionCount',
            value: top.sessionCount,
          },
        ],
        derivations: [
          {
            id: 'promptable-share-percent',
            formula: '(promptableCalls / totalPromptableCalls) * 100',
            operands: {
              promptableCalls: top.promptableCalls,
              totalPromptableCalls,
            },
            value: top.share,
          },
        ],
        inference:
          'Prompt frequency is not operation-level safety evidence. The signal ranks friction only, so every tool gets manual review guidance and no fix snippet.',
      },
    };
  },
};
