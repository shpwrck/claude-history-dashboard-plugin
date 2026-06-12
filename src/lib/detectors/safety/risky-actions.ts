import type { Detector, RecSeverity } from '../types';
import { short } from '../shared';
import {
  detectRiskyActions,
  type RiskyAction,
  type RiskyActionCategory,
} from '../../parse-permissions';

const CATEGORY_LABEL: Record<RiskyActionCategory, string> = {
  deploy: 'deploy',
  'production-config': 'production/config',
  database: 'database',
  'secret-sensitive': 'secret-sensitive',
  'other-high-impact': 'other high-impact',
};

function severityFor(actions: RiskyAction[]): RecSeverity {
  return actions.some((action) => action.severity === 'critical')
    ? 'critical'
    : 'warning';
}

function categorySummary(actions: RiskyAction[]): string {
  const counts = new Map<RiskyActionCategory, number>();
  for (const action of actions) {
    counts.set(action.category, (counts.get(action.category) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `${CATEGORY_LABEL[category]} ${count}`)
    .join(', ');
}

function evidenceRow(action: RiskyAction): string {
  return `${short(action.sessionId)}, ${CATEGORY_LABEL[action.category]}: ${action.pattern}`;
}

export const detector: Detector = {
  id: 'safety.risky-actions',
  category: 'safety',
  dataDeps: ['toolData', 'timelines'],
  rule(input) {
    const actions = detectRiskyActions(input.toolData, input.timelines);
    if (actions.length === 0) return null;

    const sessions = new Set(actions.map((action) => action.sessionId)).size;
    const evidenceRefs = actions
      .map((action) => action.evidenceRef)
      .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));

    return {
      id: 'safety.risky-actions',
      category: 'safety',
      severity: severityFor(actions),
      title: 'High-impact actions need review',
      detail: `${actions.length} high-impact action(s) across ${sessions} session(s): ${categorySummary(actions)}.`,
      action:
        'Review the cited tool calls before treating the session as low-risk; add ask/deny policy around recurring high-impact actions.',
      affected: actions.length,
      evidence: actions.slice(0, 5).map(evidenceRow),
      ...(evidenceRefs.length > 0 ? { evidenceRefs: evidenceRefs.slice(0, 5) } : {}),
      view: 'permissions',
      provenance: {
        observations: [
          {
            claim: `${actions.length} Bash tool call(s) matched deterministic high-impact action patterns`,
            source: 'parse-permissions',
            field: 'detectRiskyActions',
            value: actions.length,
          },
        ],
        inference:
          'Deploys, production config changes, database mutations, and secret-sensitive commands are review-worthy even when they are not destructive shell patterns.',
      },
    };
  },
};
