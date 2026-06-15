import type { Detector } from '../types';

// An invalid settings.json is silently ignored by Claude Code, so the user's
// model / permissions / hooks may have no effect. (#417)
function validationSnippet(path: string): string {
  return `python3 -m json.tool ${path}`;
}

export const detector: Detector = {
  id: 'reliability.settings-json-invalid',
  category: 'reliability',
  dataDeps: ['liveConfig'],
  rule(input) {
    const health = input.liveConfig?.settingsHealth;
    if (!health || !health.present || health.ok) return null;
    const errors = health.findings.filter((f) => f.severity === 'error');
    if (errors.length === 0) return null;
    const settingsPath = health.filePath || '~/.claude/settings.json';
    return {
      id: 'reliability.settings-json-invalid',
      category: 'reliability',
      severity: 'warning',
      title: 'settings.json has validation errors',
      detail: `Your settings.json has ${errors.length} error-severity finding(s) (syntax, type mismatch, or unknown key); Claude Code silently ignores an invalid file, so your model/permissions/hooks may have no effect.`,
      action:
        'Open Config Hygiene to see the exact bad path and expected type, then fix settings.json.',
      affected: errors.length,
      evidence: errors.slice(0, 5).map((f) => `${f.path}: ${f.message}`),
      fix: {
        target: 'command',
        label: 'Validate settings.json',
        note: 'Copy and run to confirm JSON syntax before editing the exact Config Hygiene error path.',
        snippet: validationSnippet(settingsPath),
      },
    };
  },
};
