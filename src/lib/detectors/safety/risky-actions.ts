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

/** True for the review-worthy (critical-severity) categories; false for the
 *  warning-level `other-high-impact` (routine publications). */
function isCritical(action: RiskyAction): boolean {
  return action.severity === 'critical';
}

function categorySummary(actions: RiskyAction[]): string {
  // Track count AND whether the category carried any critical action, so the
  // summary leads with the genuinely review-worthy categories rather than
  // whichever category merely has the largest (often routine) count (#2010).
  const counts = new Map<RiskyActionCategory, { count: number; critical: boolean }>();
  for (const action of actions) {
    const cur = counts.get(action.category) ?? { count: 0, critical: false };
    cur.count += 1;
    if (isCritical(action)) cur.critical = true;
    counts.set(action.category, cur);
  }
  return Array.from(counts.entries())
    .sort(
      (a, b) =>
        Number(b[1].critical) - Number(a[1].critical) || b[1].count - a[1].count
    )
    .map(([category, v]) => `${CATEGORY_LABEL[category]} ${v.count}`)
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

    // Rank critical-severity actions ahead of routine ones BEFORE slicing the
    // top-5 evidence (#2010). `detectRiskyActions` returns actions in
    // session/timestamp order, so without this the cited "review these calls"
    // evidence is dominated by routine publications (git push master / PR merge,
    // which are policy-sanctioned here) and hides the secret-sensitive/deploy
    // actions that actually drove the CRITICAL severity. Array#sort is stable, so
    // equal-severity actions keep their original order.
    const ranked = [...actions].sort(
      (a, b) => Number(isCritical(b)) - Number(isCritical(a))
    );
    // Derive evidence AND evidenceRefs from the SAME top-5 slice so evidence[i]
    // and evidenceRefs[i] always describe the same action. (An action with no
    // evidenceRef contributes no ref entry — the consumer matches on toolUseId —
    // but it never shifts a later action's ref onto an earlier evidence row.)
    const topActions = ranked.slice(0, 5);
    const evidenceRefs = topActions
      .map((action) => action.evidenceRef)
      .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));

    // Split the headline so a flood of routine publications can't bury the
    // review-worthy count (#2010).
    const reviewWorthy = actions.filter(isCritical);
    const routine = actions.filter((action) => !isCritical(action));
    const detail =
      reviewWorthy.length > 0 && routine.length > 0
        ? `${reviewWorthy.length} review-worthy action(s) (${categorySummary(reviewWorthy)}) + ${routine.length} routine publication(s) across ${sessions} session(s).`
        : `${actions.length} high-impact action(s) across ${sessions} session(s): ${categorySummary(actions)}.`;

    return {
      id: 'safety.risky-actions',
      category: 'safety',
      severity: severityFor(actions),
      title: 'High-impact actions need review',
      detail,
      action:
        'Review the cited tool calls before treating the session as low-risk; add ask/deny policy around recurring high-impact actions.',
      affected: actions.length,
      evidence: topActions.map(evidenceRow),
      ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
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
