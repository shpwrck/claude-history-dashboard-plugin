import type { Detector } from '../types';
import { newestTokenDataDate, short, STALE_WEEKS } from '../shared';
import { isAsOfStale } from '../provenance';
import type { ReclaimClaim } from '../../reclaim';

// service_tier='priority' is a rate premium over standard. The dashboard has no
// standard-vs-priority rate table (service_tier is an API field, not infra), so
// this is a count-only awareness nudge with no costed claim and no fix — there
// is no settings key that controls the tier; the caller/SDK sets it. (#426)
const MIN_PRIORITY_SESSIONS = 3;

/** Priority-tier evidence older than this demotes to "as of <date>" (#3201). */
const STALE_AFTER_DAYS = STALE_WEEKS * 7;

/** Flag sessions that ran on the priority service tier, as an intent check. (#426) */
export const detector: Detector = {
  id: 'cost.priority-tier-spend',
  category: 'cost',
  dataDeps: ['tokenData'],
  rule(input, now) {
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
    // Dated from the newest OBSERVED entry among the priority sessions (never
    // `now`); a corpus with no readable timestamps honestly omits asOf (#3201).
    const asOf = newestTokenDataDate(priority);
    const stale = isAsOfStale(asOf, now, STALE_AFTER_DAYS);
    const datePrefix = stale ? `As of ${asOf} (dated evidence): ` : '';
    return {
      id: 'cost.priority-tier-spend',
      category: 'cost',
      severity: 'info',
      title: 'Sessions ran on the priority service tier — confirm intent',
      detail: `${datePrefix}${priority.length} session(s) used service_tier='priority' (a rate premium over standard); for routine automation the standard tier usually suffices.`,
      action:
        'Review which sessions/automation used the priority tier; ensure no SDK client or env var forces priority for non-latency-sensitive work.',
      reclaim,
      affected: priority.length,
      evidence: priority.slice(0, 5).map((d) => short(d.sessionId)),
      view: 'cost',
      // Auditability contract (#1049/#3201): the count is the whole quantitative
      // claim, and it is read directly off the parsed session records.
      provenance: {
        observations: [
          {
            claim: `${priority.length} of ${input.tokenData.length} parsed sessions carry serviceTier='priority'`,
            source: 'parse-sessions',
            field: 'tokenData[].serviceTier',
            value: priority.length,
          },
        ],
        inference:
          `service_tier is set by the caller/SDK, and the dashboard has no ` +
          `standard-vs-priority rate table, so the premium cannot be priced — the ` +
          `session count is the only claim made, as an intent check (>= ${MIN_PRIORITY_SESSIONS} ` +
          `priority sessions suggests something is forcing the tier rather than a one-off).`,
        ...(asOf !== undefined ? { asOf, stale } : {}),
      },
    };
  },
};
