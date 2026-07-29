import type { Detector, RecProvenance } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, RATE_LIMIT_STATUSES } from '../shared';
import { isAsOfStale } from '../provenance';
import type { ApiErrorEvent } from '../../parse-errors';

/** Beyond this, an error history describes the past rather than the present. */
const FRESHNESS_DAYS = 30;

/**
 * The newest error actually observed, as `YYYY-MM-DD` (#3205).
 *
 * Derived from the events themselves rather than from `now`, so the date
 * anchors the claim to when the errors happened — dating a historical finding
 * "today" is the stale-signal defect the contract exists to prevent.
 */
function newestErrorDay(errors: ApiErrorEvent[]): string | undefined {
  let newest = 0;
  for (const e of errors) {
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms) && ms > newest) newest = ms;
  }
  return newest > 0 ? new Date(newest).toISOString().slice(0, 10) : undefined;
}

/** Distinct status/cause codes observed, most frequent first. */
function statusBreakdown(errors: ApiErrorEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of errors) {
    const code = e.status != null ? String(e.status) : 'unknown';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${code}=${n}`)
    .join(',');
}

/** Shared envelope: observations + inference, dated by the newest event. */
function errorProvenance(
  errors: ApiErrorEvent[],
  observations: RecProvenance['observations'],
  inference: string,
  now: number
): RecProvenance {
  const asOf = newestErrorDay(errors);
  return {
    observations,
    inference,
    ...(asOf ? { asOf, stale: isAsOfStale(asOf, now, FRESHNESS_DAYS) } : {}),
  };
}

const MARKERS_RATE_LIMITS: AppliedMarkers = {
  headings: [/^##\s+Rate-limit hygiene\b/i],
  bodyPhrases: ['Avoid launching many parallel agent runs'],
};

/**
 * Rate-limit / overloaded API errors.
 *
 * DUAL-EMIT: this detector's `id` is `reliability.api-errors`, but its rule body
 * emits `reliability.rate-limits` on its rate-limited branch. Both branches
 * share one detector; see the shared DUAL_EMIT allowlist in ../dual-emit.
 */
export const detector: Detector = {
  id: 'reliability.api-errors',
  appliedMarkers: MARKERS_RATE_LIMITS,
  category: 'reliability',
  dataDeps: ['apiErrors', 'liveConfig'],
  rule(input, now) {
    if (input.apiErrors.length === 0) return null;
    const sessionCount = new Set(input.apiErrors.map((e) => e.sessionId)).size;
    // Derived once and cited by both the claim and its value, so the two can
    // never disagree about the same breakdown.
    const breakdown = statusBreakdown(input.apiErrors);
    const rateLimited = input.apiErrors.filter(
      (e) => e.status != null && RATE_LIMIT_STATUSES.has(String(e.status))
    );
    if (
      rateLimited.length > 0 &&
      claudeMdMarksApplied(input.liveConfig, MARKERS_RATE_LIMITS)
    ) {
      return null;
    }
    if (rateLimited.length > 0) {
      return {
        id: 'reliability.rate-limits',
        category: 'reliability',
        severity: 'warning',
        title: 'Hitting rate-limit / overloaded errors',
        detail: `${rateLimited.length} API error(s) returned 429/529 (rate limited or overloaded), which stall and retry turns.`,
        action:
          'Pace heavy automated runs, or move them to the priority service tier / off-peak hours.',
        affected: rateLimited.length,
        view: 'errors',
        fix: {
          target: 'CLAUDE.md',
          label: 'Add pacing guidance',
          note: 'Append to your project (or ~/.claude) CLAUDE.md so heavy runs self-throttle. 429/529 are server-side signals with no client retry/tier setting.',
          snippet: `## Rate-limit hygiene\n\nHit ${rateLimited.length} rate-limit/overload (429/529) error(s) recently.\n- Avoid launching many parallel agent runs at once; serialize heavy automated batches.\n- Schedule large unattended runs (migrations, bulk refactors) for off-peak hours.\n- Break big jobs into smaller chunks with breaks between them rather than one long burst.`,
          appliedMarkers: MARKERS_RATE_LIMITS,
        },
        provenance: errorProvenance(
          input.apiErrors,
          [
            {
              claim: `${rateLimited.length} of ${input.apiErrors.length} recorded API error event(s) carried a rate-limit/overload status`,
              source: 'parse-errors',
              field: 'apiErrors[].status',
              value: rateLimited.length,
            },
            {
              claim: `status codes observed across all recorded errors: ${breakdown}`,
              source: 'parse-errors',
              field: 'apiErrors[].status',
              value: breakdown,
            },
            {
              claim: `spread across ${sessionCount} session(s)`,
              source: 'parse-errors',
              field: 'apiErrors[].sessionId',
              value: sessionCount,
            },
          ],
          'A 429/529 is answered by a retry, so the turn is paid for more than once — ' +
            'the count is the number of stalls, not the number of failures.',
          now
        ),
      };
    }
    return {
      id: 'reliability.api-errors',
      category: 'reliability',
      severity: 'info',
      title: 'API errors recorded',
      detail: `${input.apiErrors.length} API error event(s) were logged across your sessions.`,
      action: 'Open Errors to see the status-code breakdown and whether any pattern is recurring.',
      affected: input.apiErrors.length,
      view: 'errors',
      provenance: errorProvenance(
        input.apiErrors,
        [
          {
            claim: `${input.apiErrors.length} API error event(s) were recorded`,
            source: 'parse-errors',
            field: 'apiErrors[]',
            value: input.apiErrors.length,
          },
          {
            claim: `status codes observed: ${breakdown}`,
            source: 'parse-errors',
            field: 'apiErrors[].status',
            value: breakdown,
          },
          {
            claim: `spread across ${sessionCount} session(s)`,
            source: 'parse-errors',
            field: 'apiErrors[].sessionId',
            value: sessionCount,
          },
          {
            claim: 'none of these carried a rate-limit or overload status',
            source: 'parse-errors',
            field: 'apiErrors[].status',
          },
        ],
        'This is an inventory of what was logged, not a diagnosis — the codes say ' +
          'where to look, not that anything is currently wrong.',
        now
      ),
    };
  },
};
