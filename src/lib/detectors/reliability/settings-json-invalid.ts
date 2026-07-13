import type { Detector, RecFix } from '../types';
import type { SettingsHealthFinding } from '../../../types';

// An invalid settings.json is silently ignored by Claude Code, so the user's
// model / permissions / hooks may have no effect. (#417)
const KIND_PRIORITY: Record<SettingsHealthFinding['kind'], number> = {
  'missing-env': 0,
  type: 1,
  'unknown-key': 2,
  'rule-format': 3,
  syntax: 4,
};
const MAX_DETAILED_FINDINGS = 10;

function remediationForFinding(
  finding: SettingsHealthFinding,
  settingsPath: string
): RecFix {
  const path = finding.path || 'the document root';
  const sourcePath = finding.sourcePath ?? settingsPath;
  if (finding.kind === 'missing-env' && finding.environmentVariable) {
    return {
      target: 'command',
      label: `Set ${finding.environmentVariable}`,
      note: `The dashboard launch snapshot cannot prove a separately launched Claude process is missing this variable; verify there first.`,
      snippet: `Verify ${finding.environmentVariable} in Claude Code's launch environment, then set it there if absent (referenced at ${path} in ${sourcePath}).`,
      fixKind: 'manual',
    };
  }
  if (finding.kind === 'syntax') {
    return {
      target: 'settings.json',
      label: 'Repair JSON syntax',
      note: 'Use the reported line and column to repair the document before changing individual settings.',
      snippet: `Repair the JSON syntax in ${sourcePath}: ${finding.message}`,
      fixKind: 'manual',
    };
  }
  return {
    target: 'settings.json',
    label: `Fix ${path}`,
    note: 'Review the exact setting and choose the value that matches your intended Claude Code configuration.',
    snippet: `Update ${path} in ${sourcePath}: ${finding.message}`,
    fixKind: 'manual',
  };
}

export const detector: Detector = {
  id: 'reliability.settings-json-invalid',
  category: 'reliability',
  dataDeps: ['liveConfig'],
  rule(input) {
    const health = input.liveConfig?.settingsHealth;
    if (!health || !health.present || health.findings.length === 0) return null;
    const environmentNames = new Set(health.environment?.definedNames ?? []);
    const actionable = health.findings.map((finding, sourceIndex) => ({ finding, sourceIndex })).filter(({ finding }) => {
      if (finding.kind !== 'missing-env') return true;
      return Boolean(
        health.environment
        && finding.environmentVariable
        && !environmentNames.has(finding.environmentVariable)
      );
    });
    if (actionable.length === 0) return null;
    const ranked = actionable.sort(
      (a, b) => (a.finding.severity === b.finding.severity ? 0 : a.finding.severity === 'error' ? -1 : 1)
        || KIND_PRIORITY[a.finding.kind] - KIND_PRIORITY[b.finding.kind]
        || a.finding.path.localeCompare(b.finding.path)
    );
    const findings = ranked.map(({ finding }) => finding);
    const detailed = ranked.slice(0, MAX_DETAILED_FINDINGS);
    const settingsPath = health.filePath || '~/.claude/settings.json';
    const errors = findings.filter((finding) => finding.severity === 'error').length;
    const hasStructuralFindings = findings.some(
      (finding) => finding.kind !== 'missing-env'
    );
    const hasMissingEnvironmentFindings = findings.some(
      (finding) => finding.kind === 'missing-env'
    );
    const fixes = detailed.map(({ finding }) => remediationForFinding(finding, settingsPath));
    return {
      id: 'reliability.settings-json-invalid',
      category: 'reliability',
      severity: 'warning',
      title: 'settings.json has validation findings',
      detail: `Your settings.json has ${findings.length} validation finding(s) (${errors} error(s)); invalid settings may be ignored, while environment findings mean a referenced name was absent from the dashboard's host launch snapshot and should be verified where Claude Code starts.`,
      action: `Open Config Hygiene to review every exact path, then apply the suggested fixes${findings.length > MAX_DETAILED_FINDINGS ? ` (the first ${MAX_DETAILED_FINDINGS} are shown here)` : ''}.`,
      affected: findings.length,
      evidence: findings.slice(0, 5).map((f) => `${f.path || '<root>'}: ${f.message}`),
      provenance: {
        observations: [
          {
            claim: `${findings.length} actionable settings validation finding(s)`,
            source: 'liveConfig.settingsHealth',
            field: 'settingsHealth.findings',
            value: findings.length,
          },
          ...detailed.flatMap(({ finding, sourceIndex }) => {
            const settingObservation = {
              claim: `${finding.kind} finding at ${finding.path || '<root>'}`,
              source: finding.sourcePath ?? settingsPath,
              field: `settingsHealth.findings[${sourceIndex}]`,
              value: finding.message,
            };
            if (finding.kind !== 'missing-env' || !finding.environmentVariable) {
              return [settingObservation];
            }
            return [
              settingObservation,
              {
                claim: `${finding.environmentVariable} was absent from the dashboard host launch snapshot`,
                source: 'host-launch environment name snapshot',
                field: 'liveConfig.settingsHealth.environment.definedNames',
                value: finding.environmentVariable,
              },
            ];
          }),
        ],
        inference: [
          hasStructuralFindings
            ? 'Structural findings identify current settings-file problems.'
            : null,
          hasMissingEnvironmentFindings
            ? "Missing-environment findings establish only that names were absent from the dashboard host launch snapshot; verify Claude Code's launch environment."
            : null,
          `Path-specific manual remediations are included for up to ${MAX_DETAILED_FINDINGS} findings while Config Hygiene retains the full list.`,
        ].filter((part): part is string => part !== null).join(' '),
      },
      claimClass: 'accounting',
      proofTier: 'accounting',
      fix: fixes[0],
      fixes,
    };
  },
};
