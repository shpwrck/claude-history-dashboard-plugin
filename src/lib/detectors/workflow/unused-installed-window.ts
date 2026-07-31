/**
 * Shared honest-window wording for the `workflow.unused-installed-*` detectors
 * (#3249, epic #2133 data-integrity).
 *
 * `computeConfigHygiene` already hedges every finding whose retained session
 * history is SHORTER than the 30-day recency window
 * (`hedge: 'window-shorter-than-threshold'`), because such evidence proves only
 * the shorter observed interval — but the four dispatched detectors
 * (`unused-installed-commands` / `-plugins` / `-skills` / `-subagents`)
 * discarded that hedge and unconditionally claimed the resource was unused
 * "in the last 30 days". This helper is the ONE place the window claim is
 * phrased, so all four detectors (and any future sibling) demote identically:
 *
 *  - full coverage → the existing "in the last 30 days" wording, unchanged;
 *  - hedged coverage → an explicitly bounded "in the available history"
 *    claim carrying the observed duration and a data-derived as-of date.
 *
 * The as-of anchor is the newest retained session start — derived from the
 * DATA, never from `now` — because an "unused" observation only extends to the
 * last session actually retained. The observed duration comes from
 * `observedWindowDaysForScope`, evaluated on the SCOPE that decided each hedge
 * (PR #3530 review): a project-scoped finding is hedged on its project's OWN
 * coverage, so on a mixed corpus (a thin new project plus months of global
 * history) quoting the global span would produce an internally false
 * "~200 day(s) … shorter than the 30-day threshold" claim. The quoted figure
 * is therefore the MINIMUM contributing hedged span, floored so it can never
 * round up to the threshold it is asserted to be under.
 * `safety.config-hygiene-rollup` carries its own (earlier, #1164) hedge
 * wording; this helper standardizes the four workflow detectors named by the
 * audit finding.
 */
import type { HygieneFinding, HygieneInput } from '../../config-hygiene';
import { observedWindowDaysForScope } from '../../config-hygiene';
import { newestEpochDate } from '../shared';

export interface UnusedWindowWording {
  /** True when the retained history is shorter than the findings' window. */
  hedged: boolean;
  /** Window phrase for titles: "in the last 30 days" or "in the available history". */
  titleWindow: string;
  /**
   * Window phrase for the zero-invocation sentence in `detail`. Identical to
   * {@link titleWindow} for full coverage; for hedged coverage it appends the
   * observed duration of the least-observed hedged scope, the as-of date, and
   * the threshold that coverage fell short of, so the bounded claim is
   * reproducible from its own wording.
   */
  detailWindow: string;
}

/**
 * Phrase the window claim for a set of unused hygiene findings. `unused` must
 * be non-empty (the detectors gate on their MIN_UNUSED floors before asking);
 * `sessions` and `now` must be the same values handed to
 * `computeConfigHygiene`, so the wording describes the exact corpus the hedge
 * was decided on.
 */
export function unusedWindowWording(
  unused: readonly HygieneFinding[],
  sessions: HygieneInput['sessions'],
  now: number
): UnusedWindowWording {
  const windowDays = unused[0]?.windowDays ?? 30;
  const hedgedFindings = unused.filter(
    (f) => f.hedge === 'window-shorter-than-threshold'
  );
  if (hedgedFindings.length === 0) {
    const full = `in the last ${windowDays} days`;
    return { hedged: false, titleWindow: full, detailWindow: full };
  }
  // Minimum span across the DISTINCT scopes that carried a hedge — each hedge
  // was decided from its own scope's coverage, so that is the only span the
  // demoted claim may quote (PR #3530 review).
  let minSpan: number | null = null;
  const seenScopes = new Set<string>();
  for (const f of hedgedFindings) {
    const key =
      f.scope.kind === 'global' ? 'global' : `project:${f.scope.project}`;
    if (seenScopes.has(key)) continue;
    seenScopes.add(key);
    const span = observedWindowDaysForScope(f.scope, sessions, now);
    if (span === null) continue;
    if (minSpan === null || span < minSpan) minSpan = span;
  }
  // Floor (never round) so the quoted duration cannot land ON the threshold it
  // is asserted to be under; if the recomputed span contradicts the hedge
  // (>= windowDays) or nothing was measurable, quote no duration — the hedge
  // flag itself remains the authority for "shorter than the threshold".
  const days =
    minSpan !== null && minSpan < windowDays
      ? Math.max(1, Math.floor(minSpan))
      : null;
  const asOf = newestEpochDate(sessions.map((s) => s.startTime));
  const asOfClause = asOf ? ` as of ${asOf}` : '';
  const qualifier =
    days !== null
      ? `~${days} day(s) of retained coverage in the least-observed hedged scope${asOfClause}; shorter than the ${windowDays}-day threshold, so only the observed interval is claimed`
      : `retained coverage${asOfClause} shorter than the ${windowDays}-day threshold in at least one contributing scope`;
  return {
    hedged: true,
    titleWindow: 'in the available history',
    detailWindow: `in the available history (${qualifier})`,
  };
}
