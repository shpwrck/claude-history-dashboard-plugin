import type { Detector, RecSeverity } from '../types';
import { newestIsoDate, short, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import { parseIsoInstantMs } from '../../iso-instant';
import {
  detectRiskyActions,
  type RiskyAction,
  type RiskyActionCategory,
} from '../../parse-permissions';

/**
 * Risky-action history whose newest contributing call is older than this
 * demotes to "As of <date>" wording + a re-check instruction (#3225, the
 * generic #1102 stale-input rule; same 4-week window as #3194). The date is
 * derived only when EVERY matched call carries a readable timestamp — partial
 * coverage must not fabricate an aggregate freshness claim (#3197/#3200).
 */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

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
  rule(input, now) {
    const actions = detectRiskyActions(input.toolData, input.timelines);
    if (actions.length === 0) return null;

    const sessions = new Set(actions.map((action) => action.sessionId)).size;

    // #3225: derive the newest plausible action date only under FULL timestamp
    // coverage; otherwise the finding stays explicitly undated rather than
    // presenting a date computed from a subset as covering everything.
    const fullyDated = actions.every(
      (action) => parseIsoInstantMs(action.timestamp) !== undefined
    );
    const asOf = fullyDated
      ? newestIsoDate(actions.map((action) => action.timestamp))
      : undefined;
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);

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
    const baseDetail =
      reviewWorthy.length > 0 && routine.length > 0
        ? `${reviewWorthy.length} review-worthy action(s) (${categorySummary(reviewWorthy)}) + ${routine.length} routine publication(s) across ${sessions} session(s).`
        : `${actions.length} high-impact action(s) across ${sessions} session(s): ${categorySummary(actions)}.`;
    const detail = stale ? `As of ${asOf}, ${baseDetail}` : baseDetail;

    return {
      id: 'safety.risky-actions',
      category: 'safety',
      severity: severityFor(actions),
      title: 'High-impact actions need review',
      detail,
      action: stale
        ? `Re-check whether these high-impact actions still recur before acting — the newest cited call is dated ${asOf}. Then review the cited tool calls before treating the session as low-risk, and add ask/deny policy around recurring high-impact actions.`
        : 'Review the cited tool calls before treating the session as low-risk; add ask/deny policy around recurring high-impact actions.',
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
          'Deploys, production config changes, database mutations, and secret-sensitive commands are review-worthy even when they are not destructive shell patterns.' +
          (fullyDated
            ? ''
            : ' Timestamp coverage across the matched calls is incomplete, so this finding is intentionally undated rather than dated from a subset.'),
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
    };
  },
};
