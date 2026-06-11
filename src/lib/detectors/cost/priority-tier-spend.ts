import type { Detector } from '../types';
import { short } from '../shared';
import type { ReclaimClaim } from '../../reclaim';

// service_tier='priority' is a rate premium over standard. The dashboard has no
// standard-vs-priority rate table (service_tier is an API field, not infra), so
// this is a count-only awareness nudge with no costed claim and no fix — there
// is no settings key that controls the tier; the caller/SDK sets it. (#426)
const MIN_PRIORITY_SESSIONS = 3;

/** Flag sessions that ran on the priority service tier, as an intent check. (#426) */
export const detector: Detector = {
  id: 'cost.priority-tier-spend',
  category: 'cost',
  dataDeps: ['tokenData'],
  rule(input) {
    const priority = input.tokenData.filter((d) => d.serviceTier === 'priority');
    if (priority.length < MIN_PRIORITY_SESSIONS) return null;
    // Flag-only: there is no standard-vs-priority rate table (service_tier is an
    // API field, not infra), so the closed cascade cannot price the premium. Books
    // $0; the priority-session count rides as evidence for per-category coverage.
    const reclaim: ReclaimClaim = {
      leverId: 'cost.priority-tier-spend',
      category: 'cost',
      orderKey: 85,
      ownedPools: [],
      scopeKeys: [],
      counterfactual: { kind: 'flag-only' },
      evidenceTokens: 0,
    };
    return {
      id: 'cost.priority-tier-spend',
      category: 'cost',
      severity: 'info',
      title: 'Sessions ran on the priority service tier — confirm intent',
      detail: `${priority.length} session(s) used service_tier='priority' (a rate premium over standard); for routine automation the standard tier usually suffices.`,
      action:
        'Review which sessions/automation used the priority tier; ensure no SDK client or env var forces priority for non-latency-sensitive work.',
      reclaim,
      affected: priority.length,
      evidence: priority.slice(0, 5).map((d) => short(d.sessionId)),
      view: 'cost',
    };
  },
};
