import type { Detector } from '../types';
import type { AppliedMarkers } from '../types';
import { claudeMdMarksApplied, RATE_LIMIT_STATUSES } from '../shared';

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
  rule(input) {
    if (input.apiErrors.length === 0) return null;
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
    };
  },
};
